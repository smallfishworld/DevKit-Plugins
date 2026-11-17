'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const plugin = require('../src/index.cjs')
const { parseConfiguration, LineSplitter, matchChallengeLine, isTriggerWord } = plugin.__test

function baseConfig(overrides = {}) {
  return {
    loginUrl: 'https://oa.example.invalid/login',
    authOrigins: [],
    authCheck: { type: 'json', url: 'https://oa.example.invalid/api/session', field: 'authenticated' },
    issue: {
      url: 'https://oa.example.invalid/api/device/token',
      body: { challenge: '$challenge' },
      responsePath: 'response',
      loginExpiredHttp: [401, 403],
      loginExpiredCodes: [],
      retryLoginOnce: true
    },
    profiles: [
      {
        id: 'manual',
        label: '手动解锁',
        actionLabel: '解锁 Debug',
        kind: 'challenge-response',
        trigger: 'manual',
        detect: { type: 'prefix', prefix: 'Challenge:' },
        result: { type: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied' },
        command: 'debug',
        newline: 'cr',
        challengeTimeoutMs: 2000,
        challengeTtlMs: 30_000,
        resultTimeoutMs: 2000,
        holdInput: false
      },
      {
        id: 'auto',
        label: '自动解锁',
        actionLabel: '自动解锁 Debug',
        kind: 'challenge-response',
        trigger: 'auto',
        triggerWords: ['debug'],
        detect: { type: 'base64-line', shortMin: 20, shortMax: 21, longMin: 300, longMinDecoded: 260 },
        result: { type: 'prompt-repeat', promptText: 'Password:', decisionDelayMs: 20, silenceMs: 300 },
        newline: 'cr',
        challengeTimeoutMs: 2000,
        challengeTtlMs: 30_000,
        resultTimeoutMs: 2000,
        holdInput: { maxBytes: 4096, maxMs: 15_000 }
      }
    ],
    ...overrides
  }
}

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
    session: { panelId: 'serial#test', connectionId: 'conn-1', path: 'COM1', encoding: 'utf8' },
    autoEnabled: options.autoEnabled === true,
    signal: controller.signal,
    serial: {
      async write() { throw new Error('manual write not expected') },
      async exchange() { throw new Error('exchange not expected') },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async acquire() { order.push('acquire'); return lease },
      async hold(value) { order.push('hold'); holds.push(value) },
      async releaseHold(replay) { order.push('releaseHold'); holdReleases.push(replay) }
    },
    auth: {
      async login() { order.push('login'); logins++; if (options.loginError) throw options.loginError },
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

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'))
  assert.equal(manifest.id, 'devkit.oa-debug')
  assert.deepEqual(manifest.capabilities, ['serial.read', 'serial.write', 'serial.exclusive', 'auth.session'])
  validation()
  await manualUnlock()
  await automaticUnlock()
  await rejectedVerdict()
  await loginRetry()
  console.log('oa-unlock: all tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
