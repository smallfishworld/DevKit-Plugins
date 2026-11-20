'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const plugin = require('../src/index.cjs')
const { parseConfiguration, LineSplitter, matchChallengeLine, isTriggerWord } = plugin.__test

const { baseConfig } = require('./fixture.cjs')

function harness(options = {}) {
  const config = options.config || baseConfig()
  const listeners = new Set()
  const sent = []
  const states = []
  const logs = []
  const holds = []
  const holdReleases = []
  const order = []
  let sequence = 0
  let logins = 0
  let issueCalls = 0
  const controller = new AbortController()
  const lease = {
    connectionId: 'conn-1',
    async write(data, writeOptions) {
      const text = Buffer.from(data).toString('utf8')
      sent.push({ text, secret: writeOptions?.secret === true })
      if (options.onWrite) await options.onWrite(text, emit)
    },
    async release() { order.push('release') }
  }
  const ctx = {
    config: { deviceActions: config, auto: true, ...(options.instance || {}) },
    session: { panelId: 'serial#test', connectionId: 'conn-1', transport: 'serial', target: 'COM1', encoding: 'utf8' },
    autoEnabled: options.autoEnabled === true,
    signal: controller.signal,
    stream: {
      async write() { throw new Error('manual write not expected') },
      async exchange() { throw new Error('exchange not expected') },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async acquire() { order.push('acquire'); if (options.onAcquire) await options.onAcquire(); return lease },
      async hold(value) { order.push('hold'); holds.push(value) },
      async releaseHold(replay) { order.push('releaseHold'); holdReleases.push(replay) }
    },
    auth: {
      async login() { order.push('login'); logins++; if (options.loginError) throw options.loginError; if (options.onLogin) await options.onLogin() },
      async request() {
        order.push('request')
        issueCalls++
        if (options.request) return options.request(issueCalls)
        return { status: 200, text: JSON.stringify({ response: options.token || 'TOKEN_PLUGIN_1' }) }
      }
    },
    log(level, message) { logs.push({ level, message }) },
    state(value) {
      states.push(value)
      // The real host serializes state; assert no secret can hide in it.
      if (options.assertState) options.assertState(value)
    }
  }
  function emit(text) {
    for (const listener of [...listeners]) {
      listener({ type: 'data', connectionId: 'conn-1', bytes: [...Buffer.from(text)], text, receivedAt: Date.now(), sequence: ++sequence })
    }
  }
  return { ctx, sent, states, logs, holds, holdReleases, order, emit, controller, get logins() { return logins }, get issueCalls() { return issueCalls } }
}

async function until(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error('timed out: ' + label)
    await delay(10)
  }
}

async function manualUnlock() {
  const h = harness({
    onWrite: async (text) => {
      if (text.startsWith('debug')) h.emit('\r\nChallenge: CHAL_ABC123\r\n')
      else if (text.startsWith('TOKEN_PLUGIN_1')) h.emit('\r\nDebug unlocked\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  const result = await instance.run('run')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(h.sent, [{ text: 'debug\r', secret: false }, { text: 'TOKEN_PLUGIN_1\r', secret: true }])
  assert.ok(h.order.indexOf('login') < h.order.indexOf('acquire'), 'manual action authenticates before taking the lease')
  assert.deepEqual(h.holdReleases, [])
  assert.equal(h.logs.length, 0)
  const serialized = JSON.stringify([h.logs, h.states])
  assert.doesNotMatch(serialized, /TOKEN_PLUGIN_1/, '口令不得进入日志或状态')
  await instance.dispose()
  console.log('  PASS manual unlock: authenticate → challenge → token → verify, token kept secret')
}

async function automaticUnlock() {
  let h
  h = harness({
    autoEnabled: true,
    onWrite: async (text) => {
      if (text.startsWith('TOKEN_PLUGIN_1')) h.emit('\r\nunlock ok\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  // Trigger word starts the hold even before the challenge arrives.
  h.emit('debug\r\n')
  await until(() => h.holds.length === 1, 'trigger word holds input')
  // A 20-char padded base64 token is the automatic challenge shape.
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  await until(() => h.states.some((state) => state.running === false), 'automatic action finishes')
  assert.deepEqual(h.sent, [{ text: 'TOKEN_PLUGIN_1\r', secret: true }], 'automatic flow never sends the trigger command')
  assert.deepEqual(h.holdReleases, [true], 'held input is replayed after a successful unlock')
  assert.ok(h.order.indexOf('hold') < h.order.indexOf('acquire'), 'input is held before waiting for the lease')
  assert.ok(h.order.indexOf('acquire') < h.order.indexOf('login'), 'automatic flow locks the port before login')
  assert.equal(h.states.at(-1).ok, true)
  assert.doesNotMatch(JSON.stringify([h.logs, h.states]), /TOKEN_PLUGIN_1/)
  await instance.dispose()
  console.log('  PASS automatic unlock: trigger hold, base64 challenge, lease-before-login, replay on success')
}

async function rejectedVerdict() {
  let h
  h = harness({
    autoEnabled: true,
    onWrite: async (text) => {
      if (text.startsWith('TOKEN_PLUGIN_1')) h.emit('\r\nPassword: \r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  await until(() => h.states.some((state) => state.running === false), 'rejected automatic action finishes')
  assert.equal(h.states.at(-1).ok, false)
  assert.match(h.states.at(-1).error, /重新索要口令/)
  assert.deepEqual(h.holdReleases, [false], 'rejected input is discarded instead of replayed')
  assert.match(h.logs[0].message, /自动解锁失败/)
  await instance.dispose()
  console.log('  PASS automatic rejection: prompt repeat verdict discards held input')
}

async function loginRetry() {
  let h
  h = harness({
    onWrite: async (text) => {
      if (text.startsWith('debug')) h.emit('Challenge: CHAL_RETRY1\r\n')
      else if (text.startsWith('TOKEN_PLUGIN_2')) h.emit('Debug unlocked\r\n')
    },
    request: (calls) => calls === 1
      ? { status: 401, text: '{}' }
      : { status: 200, text: JSON.stringify({ response: 'TOKEN_PLUGIN_2' }) }
  })
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.equal(h.logins, 2, 'an expired login is retried exactly once')
  assert.deepEqual(h.sent, [{ text: 'debug\r', secret: false }, { text: 'TOKEN_PLUGIN_2\r', secret: true }])
  await instance.dispose()
  console.log('  PASS login expiry: one re-login and retry before injecting the token')
}

function validation() {
  assert.throws(() => parseConfiguration(baseConfig({ loginUrl: 'http://oa.example.invalid/login' })), /HTTPS/)
  assert.throws(() => parseConfiguration(baseConfig({
    issue: { ...baseConfig().issue, url: 'https://other.example.invalid/token' }
  })), /同源/)
  assert.throws(() => parseConfiguration(baseConfig({
    issue: { ...baseConfig().issue, body: { challenge: 'fixed' } }
  })), /\$challenge/)
  assert.throws(() => parseConfiguration(baseConfig({
    authOrigins: ['https://sso.example.invalid/path']
  })), /主机和端口/)
  const parsed = parseConfiguration(baseConfig())
  assert.equal(parsed.profiles.length, 2)
  assert.equal(parsed.profiles[1].holdInput.maxMs, 15_000)
  assert.equal(matchChallengeLine({ type: 'prefix', prefix: 'Challenge:' }, 'Challenge: TOKEN_1'), 'TOKEN_1')
  assert.throws(() => matchChallengeLine({ type: 'prefix', prefix: 'Challenge:' }, 'Challenge: bad token'), /格式不匹配/)
  assert.equal(isTriggerWord(' # debug ', ['debug']), true)
  assert.equal(isTriggerWord('debugger', ['debug']), false)
  const lines = new LineSplitter()
  const seen = []
  lines.push('Cha', 1, (line, at) => { seen.push([line, at]); return false })
  lines.push('llenge: TOKEN_1\r', 2, (line, at) => { seen.push([line, at]); return true })
  assert.deepEqual(seen, [['Challenge: TOKEN_1', 2]])
  console.log('  PASS configuration and protocol matching: strict HTTPS, same origin, $challenge, line assembly')
}

test('manifest keeps the OA identity and action while declaring API v2 stream capabilities', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'))
  assert.equal(manifest.id, 'devkit.oa-debug')
  assert.equal(manifest.apiVersion, 2)
  assert.deepEqual(manifest.transports, ['serial'])
  assert.deepEqual(manifest.actions.map((action) => action.id), ['run'])
  assert.deepEqual(manifest.capabilities, ['stream.read', 'stream.write', 'stream.exclusive', 'auth.session'])
})
test('configuration and protocol boundaries stay strict', validation)
test('manual OA transaction authenticates before the lease and sends a secret token', manualUnlock)
test('automatic unlock holds input before the lease and replays only after acceptance', automaticUnlock)
test('rejected automatic unlock drops the held input', rejectedVerdict)
test('an expired OA session retries login exactly once', loginRetry)

test('abort while waiting for the challenge immediately rejects and releases the lease', async () => {
  const h = harness()
  const instance = await plugin.activate(h.ctx)
  const running = instance.run('run')
  const rejected = assert.rejects(running, /取消|已停止/)
  await until(() => h.sent.length === 1, 'challenge wait started')
  h.controller.abort()
  await rejected
  assert.equal(h.order.filter((item) => item === 'release').length, 1)
  h.emit('Challenge: TOO_LATE_123\r\n')
  assert.equal(h.sent.length, 1)
  await instance.dispose()
})

test('dispose cancels the active wait even when the caller has not aborted the SDK signal', async () => {
  const h = harness()
  const instance = await plugin.activate(h.ctx)
  const running = instance.run('run')
  const rejected = assert.rejects(running, /取消|已停止/)
  await until(() => h.sent.length === 1, 'challenge wait started')
  await instance.dispose()
  await rejected
  assert.equal(h.order.filter((item) => item === 'release').length, 1)
  await assert.rejects(() => instance.run('run'), /已停止/)
  h.emit('Challenge: TOO_LATE_123\r\n')
  assert.equal(h.sent.length, 1)
})

test('a lease acquired after disposal is released without sending a stale command', async () => {
  let resolveLease
  const h = harness({ onAcquire: () => new Promise((resolve) => { resolveLease = resolve }) })
  const instance = await plugin.activate(h.ctx)
  const running = instance.run('run')
  const rejected = assert.rejects(running, /已停止/)
  await until(() => typeof resolveLease === 'function', 'lease is queued')
  await instance.dispose()
  resolveLease()
  await rejected
  assert.deepEqual(h.sent, [])
  assert.equal(h.order.filter((item) => item === 'release').length, 1)
})

test('abort during authentication cannot acquire a lease or send after login resolves', async () => {
  let resolveLogin
  const h = harness({ onLogin: () => new Promise((resolve) => { resolveLogin = resolve }) })
  const instance = await plugin.activate(h.ctx)
  const running = instance.run('run')
  const rejected = assert.rejects(running, /已停止/)
  await until(() => typeof resolveLogin === 'function', 'login is pending')
  h.controller.abort()
  resolveLogin()
  await rejected
  assert.equal(h.order.includes('acquire'), false)
  assert.deepEqual(h.sent, [])
  await instance.dispose()
})

test('disposal releases a trigger-word hold before any challenge and unsubscribes', async () => {
  const h = harness({ autoEnabled: true })
  const instance = await plugin.activate(h.ctx)
  h.emit('debug\r\n')
  await until(() => h.holds.length === 1, 'early input hold')
  await instance.dispose()
  assert.deepEqual(h.holdReleases, [false])
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  assert.equal(h.order.includes('acquire'), false)
  assert.deepEqual(h.sent, [])
})

test('snapshot configuration survives external edits while challenge and verdict span chunks', async () => {
  let h
  h = harness({ onWrite: async (text) => {
    if (text === 'debug\r') { h.emit('Chall'); h.emit('enge: CHAL_SPLIT_123\r\n') }
    else { h.emit('Debug un'); h.emit('locked\r\n') }
  } })
  const instance = await plugin.activate(h.ctx)
  h.ctx.config.deviceActions.profiles[0].command = 'changed'
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.equal(h.sent[0].text, 'debug\r')
  await instance.dispose()
})

test('write failure rejects the action without copying private driver data to diagnostics', async () => {
  const h = harness({ onWrite: () => { throw new Error('PRIVATE_DRIVER_PAYLOAD') } })
  const instance = await plugin.activate(h.ctx)
  await assert.rejects(() => instance.run('run'), (error) => {
    assert.match(error.message, /发送设备动作命令失败/)
    assert.doesNotMatch(error.message, /PRIVATE_DRIVER_PAYLOAD/)
    return true
  })
  assert.equal(h.order.filter((item) => item === 'release').length, 1)
  await instance.dispose()
})

test('oversized lines are dropped through the next delimiter instead of accepting their suffix', () => {
  const lines = new LineSplitter()
  const seen = []
  const visit = (line) => { seen.push(line); return false }
  lines.push('x'.repeat(4097), 1, visit)
  lines.push('Challenge: FALSE_123\r\nChallenge: VALID_123\n', 2, visit)
  assert.deepEqual(seen, ['Challenge: VALID_123'])
})
