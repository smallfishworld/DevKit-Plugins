'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const manifest = require('../manifest.json')
const { activate } = require('../src/index.cjs')

function fixture(exchange, config = {}) {
  const controller = new AbortController()
  const calls = []
  const logs = []
  const ctx = {
    config: {
      command: 'AT+VERSION?\\r\\n',
      expected: 'OK',
      timeoutMs: 3000,
      ...config
    },
    session: { panelId: 'test-panel', connectionId: 'test-connection', transport: 'serial', target: 'MOCK', encoding: 'utf8' },
    autoEnabled: false,
    signal: controller.signal,
    stream: {
      async exchange(data, options) {
        calls.push({ data, options })
        return exchange(data, options)
      },
      async write() { throw new Error('This template uses exchange only') }
    },
    log(level, message) { logs.push({ level, message }) },
    state() {}
  }
  return { ctx, controller, calls, logs }
}

function response(text = 'VERSION 1.0\r\nOK\r\n') {
  return { text, bytes: [...Buffer.from(text)], receivedAt: 1000 }
}

test('manifest declares the query action and its required stream capabilities', () => {
  assert.equal(manifest.entry, 'src/index.cjs')
  assert.equal(manifest.apiVersion, 2)
  assert.equal(manifest.autoRespond, false)
  assert.deepEqual(manifest.transports, ['serial', 'ssh', 'net'])
  assert.deepEqual(manifest.actions.map(action => action.id), ['query'])
  assert.deepEqual(manifest.capabilities, ['stream.read', 'stream.write'])
})

test('activation does not send a command', async () => {
  const f = fixture(() => response())
  const plugin = await activate(f.ctx)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.logs, [])
  await plugin.dispose()
})

test('query awaits the response and expands CR/LF escapes', async () => {
  let resolveExchange
  const reply = response()
  const waiting = new Promise(resolve => { resolveExchange = resolve })
  const f = fixture(() => waiting)
  const plugin = await activate(f.ctx)

  const running = plugin.run('query')
  assert.deepEqual(f.calls, [{
    data: 'AT+VERSION?\r\n',
    options: { match: 'OK', timeoutMs: 3000 }
  }])
  assert.deepEqual(f.logs, [])

  resolveExchange(reply)
  assert.deepEqual(await running, { ok: true, response: reply.text })
  assert.deepEqual(f.logs, [{ level: 'info', message: '收到响应，共 ' + reply.bytes.length + ' 字节' }])
  await plugin.dispose()
})

test('unknown actions fail before any stream write', async () => {
  const f = fixture(() => response())
  const plugin = await activate(f.ctx)
  await assert.rejects(plugin.run('missing'), /未知动作/)
  assert.deepEqual(f.calls, [])
  await plugin.dispose()
})

test('a failed exchange propagates instead of reporting a successful action', async () => {
  const failure = new Error('等待设备响应超时')
  const f = fixture(() => { throw failure })
  const plugin = await activate(f.ctx)
  await assert.rejects(plugin.run('query'), error => error === failure)
  assert.deepEqual(f.logs, [])
  await plugin.dispose()
})

test('abort prevents starting a new action', async () => {
  const f = fixture(() => response())
  const plugin = await activate(f.ctx)
  f.controller.abort(new Error('测试取消'))
  await assert.rejects(plugin.run('query'), /测试取消/)
  assert.deepEqual(f.calls, [])
  await plugin.dispose()
})

test('a late response after dispose does not publish success', async () => {
  let resolveExchange
  const f = fixture(() => new Promise(resolve => { resolveExchange = resolve }))
  const plugin = await activate(f.ctx)
  const running = plugin.run('query')
  await plugin.dispose()
  resolveExchange(response())
  await assert.rejects(running, /插件实例已停止/)
  assert.deepEqual(f.logs, [])
  await assert.rejects(plugin.run('query'), /插件实例已停止/)
  assert.equal(f.calls.length, 1)
})

test('separate instances retain their own configuration and lifecycle', async () => {
  const a = fixture(() => response('A OK'), { command: 'A\\n', timeoutMs: 500 })
  const b = fixture(() => response('B OK'), { command: 'B\\r', timeoutMs: 1000 })
  const first = await activate(a.ctx)
  const second = await activate(b.ctx)
  await first.dispose()
  assert.deepEqual(await second.run('query'), { ok: true, response: 'B OK' })
  assert.deepEqual(a.calls, [])
  assert.equal(b.calls[0].data, 'B\r')
  assert.equal(b.calls[0].options.timeoutMs, 1000)
  await second.dispose()
})
