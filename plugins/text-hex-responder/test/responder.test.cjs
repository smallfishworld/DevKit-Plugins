'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { activate } = require('../src/index.cjs')
const manifest = require('../manifest.json')
const defaults = Object.fromEntries(
  Object.entries(manifest.configSchema.properties).map(([name, schema]) => [name, schema.default])
)

function textEvent(text) { return { text, bytes: [...Buffer.from(text, 'utf8')] } }
function hexEvent(bytes) { return { text: 'not used in HEX mode', bytes } }

async function fixture(t, extra = {}, writeImpl) {
  const controller = new AbortController()
  const writes = []
  const states = []
  const logs = []
  const context = {
    config: { ...defaults, ...extra },
    signal: controller.signal,
    stream: {
      async write(data) {
        if (typeof writeImpl === 'function') return await writeImpl(data, writes)
        if (writeImpl instanceof Error) throw writeImpl
        writes.push(data)
        return { bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length }
      }
    },
    log(level, message) { logs.push({ level, message }) },
    state(value) { states.push(value) }
  }
  const instance = await activate(context)
  t.after(() => instance.dispose())
  return { instance, context, controller, writes, states, logs }
}

function activateWith(config) {
  return activate({
    config,
    signal: new AbortController().signal,
    stream: { async write() { return { bytes: 0 } } },
    log() {},
    state() {}
  })
}

test('manifest declares API v2, multi-transport support, conditional schema and rules', () => {
  assert.equal(manifest.id, 'devkit.text-hex-responder')
  assert.equal(manifest.version, '2.0.0')
  assert.equal(manifest.apiVersion, 2)
  assert.equal(manifest.minHostVersion, '0.1.10')
  assert.deepEqual(manifest.transports, ['serial', 'ssh', 'net'])
  assert.equal(manifest.entry, 'src/index.cjs')
  assert.deepEqual(manifest.actions.map(({ id }) => id), ['send', 'reset'])
  assert.deepEqual(manifest.capabilities, ['stream.read', 'stream.write'])
  assert.deepEqual(manifest.configSchema.properties.newline['x-visibleWhen'], { field: 'mode', equals: 'text' })
  assert.equal(manifest.configSchema.properties.rules.type, 'array')
})

test('activation needs only the small stream SDK and performs no automatic write', async (t) => {
  const { instance, writes } = await fixture(t)
  assert.deepEqual(writes, [])
  assert.deepEqual(await instance.run('send'), { ok: true })
  assert.deepEqual(writes, ['PONG\r\n'])
})

test('text matches split lines, coalesced lines and multi-rule array entries', async (t) => {
  const { instance, writes, states } = await fixture(t, {
    rules: [
      { match: 'HELLO', response: 'WORLD' },
      { match: 'STATUS', response: 'OK' }
    ]
  })
  await instance.onData(textEvent('PI'))
  assert.deepEqual(writes, [])
  await instance.onData(textEvent('NG\r\nHELLO\nnoise\nSTATUS\r'))
  assert.deepEqual(writes, ['PONG\r\n', 'WORLD\r\n', 'OK\r\n'])
  assert.deepEqual(states, [{ replies: 1 }, { replies: 2 }, { replies: 3 }])
})

test('HEX supports multi-rule matching and preserves split prefixes', async (t) => {
  const { instance, writes } = await fixture(t, {
    mode: 'hex',
    match: 'AA 01',
    response: '55 FE',
    rules: [{ match: 'BB 02', response: 'CC 03' }]
  })
  await instance.onData(hexEvent([0, 0xaa]))
  await instance.onData(hexEvent([0x01, 0xbb, 0x02]))
  assert.deepEqual(writes, [[0x55, 0xfe], [0xcc, 0x03]])
})

test('ignoreCase changes only text comparison', async (t) => {
  const { instance, writes } = await fixture(t, { ignoreCase: true })
  await instance.onData(textEvent('ping\rPiNg\npING\r\n'))
  assert.deepEqual(writes, ['PONG\r\n', 'PONG\r\n', 'PONG\r\n'])
})

test('reset clears buffers AND cancels pending delayed replies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { instance, writes } = await fixture(t, { replyDelayMs: 200 })
  const delayed = instance.run('send')
  t.mock.timers.tick(50)
  assert.deepEqual(await instance.run('reset'), { ok: true })
  await delayed
  t.mock.timers.tick(500)
  assert.deepEqual(writes, [])
})

test('replyDelayMs serializes concurrent writes so stream.write never overlaps', async (t) => {
  let inFlight = 0
  let maxConcurrent = 0
  const { instance, writes } = await fixture(t, { replyDelayMs: 15 }, async (data, list) => {
    inFlight++
    maxConcurrent = Math.max(maxConcurrent, inFlight)
    await new Promise((r) => setTimeout(r, 10))
    list.push(data)
    inFlight--
    return { bytes: data.length }
  })
  await Promise.all([instance.run('send'), instance.run('send')])
  assert.equal(maxConcurrent, 1)
  assert.deepEqual(writes, ['PONG\r\n', 'PONG\r\n'])
})

test('AbortSignal stops pending delays and causes run() to throw Error for macro abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { instance, controller, writes } = await fixture(t, { replyDelayMs: 500 })
  const pending = instance.run('send')
  controller.abort(new Error('宿主取消'))
  await pending
  t.mock.timers.tick(1000)
  assert.deepEqual(writes, [])
  await assert.rejects(instance.run('send'), /已停止|取消/)
})

test('unknown actions and stopped instances throw Error instead of returning ok:false', async (t) => {
  const { instance, writes } = await fixture(t)
  await assert.rejects(instance.run('missing-action'), /未知动作/)
  await instance.dispose()
  await assert.rejects(instance.run('send'), /插件已停止/)
  assert.deepEqual(writes, [])
})

test('flood limit stops after 32 replies in one callback', async (t) => {
  const { instance, writes } = await fixture(t)
  await assert.rejects(instance.onData(textEvent('PING\n'.repeat(33))), /32/)
  assert.equal(writes.length, 32)
})

test('a failed host write is propagated without reporting a successful reply', async (t) => {
  const { instance, writes, states } = await fixture(t, {}, new Error('stream disconnected'))
  await assert.rejects(instance.run('send'), /stream disconnected/)
  assert.deepEqual(writes, [])
  assert.deepEqual(states, [])
})

test('standalone activation rejects invalid parameters before any stream operation', async (t) => {
  await assert.rejects(activateWith({ ...defaults, mode: 'binary' }), /mode/)
  await assert.rejects(activateWith({ ...defaults, match: '' }), /match/)
  await assert.rejects(activateWith({ ...defaults, rules: 'invalid' }), /rules/)
  await assert.rejects(activateWith({ ...defaults, replyDelayMs: -1 }), /replyDelayMs/)
  await assert.rejects(activateWith({ ...defaults, extraField: true }), /未知配置字段/)
  await assert.rejects(activateWith({ ...defaults, mode: 'hex', match: 'GG', response: '01' }), /十六进制/)
})
