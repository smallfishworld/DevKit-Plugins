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

async function fixture(t, extra = {}, writeError) {
  const writes = []
  const states = []
  const logs = []
  // Deliberately no OA/authentication API, native port, session or DevKit imports.
  const context = {
    config: { ...defaults, ...extra },
    serial: { async write(data) { if (writeError) throw writeError; writes.push(data) } },
    log(level, message) { logs.push({ level, message }) },
    state(value) { states.push(value) }
  }
  const instance = await activate(context)
  t.after(() => instance.dispose())
  return { instance, context, writes, states, logs }
}

function activateWith(config) {
  return activate({ config, serial: { async write() {} }, log() {}, state() {} })
}

test('manifest keeps the published identity and points at the standalone entry', () => {
  assert.equal(manifest.id, 'devkit.text-hex-responder')
  assert.equal(manifest.version, '1.0.0')
  assert.equal(manifest.apiVersion, 1)
  assert.equal(manifest.entry, 'src/index.cjs')
  assert.deepEqual(manifest.actions.map(({ id }) => id), ['send', 'reset'])
  assert.deepEqual(manifest.capabilities, ['serial.read', 'serial.write'])
})

test('activation needs only the small serial SDK and performs no automatic write', async (t) => {
  const { instance, writes, context } = await fixture(t)
  assert.equal(Object.hasOwn(context, 'auth'), false)
  assert.equal(Object.hasOwn(context, 'session'), false)
  assert.deepEqual(writes, [])
  assert.deepEqual(await instance.run('send'), { ok: true })
  assert.deepEqual(writes, ['PONG\r\n'])
})

test('text matches a split line and every complete line in a coalesced callback', async (t) => {
  const { instance, writes, states } = await fixture(t)
  await instance.onData(textEvent('PI'))
  assert.deepEqual(writes, [])
  await instance.onData(textEvent('NG\r\nnoise\nPING\nPING\r'))
  assert.deepEqual(writes, ['PONG\r\n', 'PONG\r\n', 'PONG\r\n'])
  assert.deepEqual(states, [{ replies: 1 }, { replies: 2 }, { replies: 3 }])
})

test('a CRLF line split at every boundary produces exactly one reply', async (t) => {
  const input = 'PING\r\n'
  for (let split = 0; split <= input.length; split++) {
    const { instance, writes } = await fixture(t)
    await instance.onData(textEvent(input.slice(0, split)))
    await instance.onData(textEvent(input.slice(split)))
    assert.deepEqual(writes, ['PONG\r\n'], 'split at ' + split)
    await instance.dispose()
  }
})

test('text requires an exact complete line and respects whitespace and case', async (t) => {
  const { instance, writes } = await fixture(t)
  await instance.onData(textEvent('ping\n PING\nPING \nXPING\nPINGX\n'))
  assert.deepEqual(writes, [])
  await instance.onData(textEvent('PING'))
  assert.deepEqual(writes, [])
  await instance.onData(textEvent('\n'))
  assert.deepEqual(writes, ['PONG\r\n'])
})

test('ignoreCase changes only text comparison', async (t) => {
  const { instance, writes } = await fixture(t, { ignoreCase: true })
  await instance.onData(textEvent('ping\rPiNg\npING\r\n'))
  assert.deepEqual(writes, ['PONG\r\n', 'PONG\r\n', 'PONG\r\n'])
})

test('decoded Unicode text can arrive in separate callbacks', async (t) => {
  const { instance, writes } = await fixture(t, { match: '设备就绪', response: '确认', newline: 'lf' })
  await instance.onData(textEvent('设备'))
  await instance.onData(textEvent('就绪\n'))
  assert.deepEqual(writes, ['确认\n'])
})

for (const [newline, suffix] of Object.entries({ none: '', cr: '\r', lf: '\n', crlf: '\r\n' })) {
  test('manual text response uses the configured ' + newline + ' ending', async (t) => {
    const { instance, writes } = await fixture(t, { newline })
    await instance.run('send')
    assert.deepEqual(writes, ['PONG' + suffix])
  })
}

test('an empty text body can still send a configured line ending', async (t) => {
  const { instance, writes } = await fixture(t, { response: '', newline: 'lf' })
  await instance.run('send')
  assert.deepEqual(writes, ['\n'])
})

test('HEX preserves binary bytes and handles every split of a pattern', async (t) => {
  const input = [0x00, 0xff, 0x7e]
  for (let split = 0; split <= input.length; split++) {
    const { instance, writes } = await fixture(t, { mode: 'hex', match: '00 FF 7e', response: '80 00' })
    await instance.onData(hexEvent(input.slice(0, split)))
    await instance.onData(hexEvent(input.slice(split)))
    assert.deepEqual(writes, [[0x80, 0x00]], 'split at ' + split)
    await instance.dispose()
  }
})

test('HEX handles noise, coalesced matches and a trailing split prefix', async (t) => {
  const { instance, writes } = await fixture(t, { mode: 'hex', match: 'AA 01', response: '55 FE' })
  await instance.onData(hexEvent([0, 170]))
  await instance.onData(hexEvent([1, 170, 1, 170]))
  assert.deepEqual(writes, [[85, 254], [85, 254]])
  await instance.onData(hexEvent([1]))
  assert.deepEqual(writes, [[85, 254], [85, 254], [85, 254]])
})

test('HEX one-byte matches do not leave a stale protocol buffer', async (t) => {
  const { instance, writes } = await fixture(t, { mode: 'hex', match: 'AA', response: '01' })
  await instance.onData(hexEvent([0xaa, 0xbb, 0xaa]))
  await instance.onData(hexEvent([0xbb]))
  assert.deepEqual(writes, [[1], [1]])
})

test('HEX consumes non-overlapping occurrences and preserves the remaining prefix', async (t) => {
  const { instance, writes } = await fixture(t, { mode: 'hex', match: 'AA AA', response: '01' })
  await instance.onData(hexEvent([0xaa, 0xaa, 0xaa]))
  assert.deepEqual(writes, [[1]])
  await instance.onData(hexEvent([0xaa]))
  assert.deepEqual(writes, [[1], [1]])
})

test('HEX accepts whitespace and case variations but does not append text newlines', async (t) => {
  const { instance, writes } = await fixture(t, { mode: 'hex', match: 'aa\t01', response: '55\nfe', newline: 'crlf' })
  await instance.run('send')
  await instance.onData(hexEvent([170, 1]))
  assert.deepEqual(writes, [[85, 254], [85, 254]])
})

test('HEX overflow keeps recent bytes and can still complete a later match', async (t) => {
  const { instance, writes, logs } = await fixture(t, { mode: 'hex', match: 'AA 01', response: '55', maxBufferBytes: 256 })
  await instance.onData(hexEvent([170, 1, ...Array(300).fill(0)]))
  assert.deepEqual(writes, [])
  assert.equal(logs[0].level, 'warn')
  await instance.onData(hexEvent([170]))
  await instance.onData(hexEvent([1]))
  assert.deepEqual(writes, [[85]])
})

test('an oversized unfinished text line cannot turn its suffix into a new command', async (t) => {
  const { instance, writes, logs } = await fixture(t, { maxBufferBytes: 256 })
  await instance.onData(textEvent('x'.repeat(257)))
  await instance.onData(textEvent('still-the-same-line'))
  await instance.onData(textEvent('PING\nPING\n'))
  assert.deepEqual(writes, ['PONG\r\n'])
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'warn')
})

test('text buffer limit counts UTF-8 bytes and recovers at the next line ending', async (t) => {
  const { instance, writes, logs } = await fixture(t, { maxBufferBytes: 256 })
  await instance.onData(textEvent('中'.repeat(86)))
  await instance.onData(textEvent('PING\r'))
  assert.deepEqual(writes, [])
  await instance.onData(textEvent('\nPING\n'))
  assert.deepEqual(writes, ['PONG\r\n'])
  assert.equal(logs.length, 1)
})

test('reset clears a text prefix without sending data', async (t) => {
  const { instance, writes } = await fixture(t)
  await instance.onData(textEvent('PI'))
  assert.deepEqual(await instance.run('reset'), { ok: true })
  await instance.onData(textEvent('NG\n'))
  assert.deepEqual(writes, [])
  await instance.onData(textEvent('PING\n'))
  assert.deepEqual(writes, ['PONG\r\n'])
})

test('reset clears a binary prefix', async (t) => {
  const { instance, writes } = await fixture(t, { mode: 'hex', match: 'AA 01', response: '55' })
  await instance.onData(hexEvent([170]))
  await instance.run('reset')
  await instance.onData(hexEvent([1]))
  assert.deepEqual(writes, [])
  await instance.onData(hexEvent([170, 1]))
  assert.deepEqual(writes, [[85]])
})

test('explicit reset also ends the oversized-line discard state', async (t) => {
  const { instance, writes } = await fixture(t, { maxBufferBytes: 256 })
  await instance.onData(textEvent('x'.repeat(257)))
  await instance.run('reset')
  await instance.onData(textEvent('PING\n'))
  assert.deepEqual(writes, ['PONG\r\n'])
})

test('unknown actions report failure and do not write', async (t) => {
  const { instance, writes } = await fixture(t)
  const result = await instance.run('missing-action')
  assert.equal(result.ok, false)
  assert.match(result.error, /未知动作/)
  assert.deepEqual(writes, [])
})

test('an instance uses an independent configuration snapshot', async (t) => {
  const { instance, writes, context } = await fixture(t)
  context.config.match = 'CHANGED'
  context.config.response = 'CHANGED'
  await instance.onData(textEvent('PING\n'))
  assert.deepEqual(writes, ['PONG\r\n'])
})

test('reply delay waits for the configured time before sending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { instance, writes } = await fixture(t, { replyDelayMs: 20 })
  const pending = instance.run('send')
  t.mock.timers.tick(19)
  assert.deepEqual(writes, [])
  t.mock.timers.tick(1)
  await pending
  assert.deepEqual(writes, ['PONG\r\n'])
})

test('dispose cancels pending manual and automatic reply delays', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { instance, writes } = await fixture(t, { replyDelayMs: 500 })
  const automatic = instance.onData(textEvent('PING\nPING\n'))
  const manual = instance.run('send')
  await instance.dispose()
  await Promise.all([automatic, manual])
  t.mock.timers.tick(1000)
  assert.deepEqual(writes, [])
  assert.equal((await instance.run('send')).ok, false)
  await instance.onData(textEvent('PING\n'))
  await instance.dispose()
  assert.deepEqual(writes, [])
})

test('text flood limit stops after 32 replies in one callback', async (t) => {
  const { instance, writes } = await fixture(t)
  await assert.rejects(instance.onData(textEvent('PING\n'.repeat(33))), /32/)
  assert.equal(writes.length, 32)
})

test('HEX flood limit stops after 32 replies in one callback', async (t) => {
  const { instance, writes } = await fixture(t, { mode: 'hex', match: 'AA', response: '01' })
  await assert.rejects(instance.onData(hexEvent(Array(33).fill(170))), /32/)
  assert.equal(writes.length, 32)
})

test('a failed host write is propagated without reporting a successful reply', async (t) => {
  const { instance, writes, states } = await fixture(t, {}, new Error('serial disconnected'))
  await assert.rejects(instance.run('send'), /serial disconnected/)
  assert.deepEqual(writes, [])
  assert.deepEqual(states, [])
})

const invalidConfigurations = [
  ['mode', { mode: 'binary' }],
  ['match', { match: '' }],
  ['match', { match: 10 }],
  ['match', { match: 'x'.repeat(4097) }],
  ['response', { response: null }],
  ['response', { response: 'x'.repeat(4097) }],
  ['newline', { newline: 'unix' }],
  ['ignoreCase', { ignoreCase: 'false' }],
  ['replyDelayMs', { replyDelayMs: -1 }],
  ['replyDelayMs', { replyDelayMs: 5001 }],
  ['replyDelayMs', { replyDelayMs: 0.5 }],
  ['replyDelayMs', { replyDelayMs: NaN }],
  ['replyDelayMs', { replyDelayMs: Infinity }],
  ['replyDelayMs', { replyDelayMs: '20' }],
  ['maxBufferBytes', { maxBufferBytes: 255 }],
  ['maxBufferBytes', { maxBufferBytes: 65537 }],
  ['maxBufferBytes', { maxBufferBytes: 256.5 }],
  ['未知配置字段', { extraField: true }]
]

test('standalone activation rejects invalid parameters before any serial operation', async (t) => {
  for (const [label, change] of invalidConfigurations) {
    await t.test(label + ' ' + Object.keys(change)[0] + '=' + String(Object.values(change)[0]).slice(0, 32), async () => {
      await assert.rejects(activateWith({ ...defaults, ...change }), new RegExp(label))
    })
  }
  for (const config of [undefined, null, [], 'invalid']) {
    await assert.rejects(activateWith(config), /config/)
  }
  const missing = { ...defaults }
  delete missing.response
  await assert.rejects(activateWith(missing), /response/)
})

test('HEX matching and reply values must contain complete non-empty bytes', async (t) => {
  for (const value of [' ', 'A', 'GG', '0xAA']) {
    await t.test('match ' + JSON.stringify(value), async () => {
      await assert.rejects(activateWith({ ...defaults, mode: 'hex', match: value, response: '01' }), /十六进制/)
    })
  }
  for (const value of ['', ' ', 'A', 'GG', '0xAA']) {
    await t.test('response ' + JSON.stringify(value), async () => {
      await assert.rejects(activateWith({ ...defaults, mode: 'hex', match: 'AA', response: value }), /十六进制/)
    })
  }
})
