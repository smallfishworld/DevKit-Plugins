'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const plugin = require('../src/index.cjs')
const {
  parseConfiguration, LineSplitter, matchLine, isTriggerWord, foldLine, isReplyValue, renderTemplate
} = plugin.__test

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
  let fetchCalls = 0
  let holdError
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
    config: { ...config, ...(options.instance || {}) },
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
      async hold(value) { order.push('hold'); holds.push(value); if (holdError) throw holdError },
      async releaseHold(replay) { order.push('releaseHold'); holdReleases.push(replay) }
    },
    log(level, message) { logs.push({ level, message }) },
    state(value) {
      states.push(value)
      // The real host serializes state; assert no secret can hide in it.
      if (options.assertState) options.assertState(value)
    }
  }
  if (options.noAuth !== true) {
    ctx.auth = {
      async login() { order.push('login'); logins++; if (options.loginError) throw options.loginError; if (options.onLogin) await options.onLogin() },
      async request(input) {
        order.push('request')
        fetchCalls++
        if (options.onRequest) return options.onRequest(input, fetchCalls)
        if (options.request) return options.request(fetchCalls)
        return { status: 200, text: JSON.stringify({ data: { reply: options.reply || 'REPLY_PLUGIN_1' } }) }
      }
    }
  }
  function emit(text) {
    for (const listener of [...listeners]) {
      listener({ type: 'data', connectionId: 'conn-1', bytes: [...Buffer.from(text)], text, receivedAt: Date.now(), sequence: ++sequence })
    }
  }
  return {
    ctx, sent, states, logs, holds, holdReleases, order, emit, controller,
    setHoldError(error) { holdError = error },
    get logins() { return logins },
    get fetchCalls() { return fetchCalls }
  }
}

async function until(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error('timed out: ' + label)
    await delay(10)
  }
}

// ---------------------------------------------------------------------------
// 配置校验与协议边界
// ---------------------------------------------------------------------------

function validation() {
  assert.throws(() => parseConfiguration(baseConfig({ loginUrl: 'http://relay.example.invalid/login' })), /HTTPS/)
  assert.throws(() => parseConfiguration(baseConfig({
    fetchUrl: 'https://other.example.invalid/reply'
  })), /同源/)
  assert.throws(() => parseConfiguration(baseConfig({
    fetchBody: { input: 'fixed' }
  })), /\$value/)
  assert.throws(() => parseConfiguration(baseConfig({
    authOrigins: ['https://sso.example.invalid/path']
  })), /主机和端口/)
  assert.throws(() => parseConfiguration(baseConfig({ replySource: 'unknown' })), /replySource/)
  assert.throws(() => parseConfiguration(baseConfig({ replySource: 'static' })), /固定回传内容/)
  assert.throws(() => parseConfiguration(baseConfig({ replySource: 'map' })), /replyMap/)
  assert.throws(() => parseConfiguration(baseConfig({ loginUrl: '', authCheckUrl: '', fetchUrl: '' })),
    /请先在插件配置中填写：登录入口 loginUrl、登录检查接口 authCheckUrl、取数接口 fetchUrl/)
  assert.throws(() => parseConfiguration(baseConfig({ fetchMethod: 'GET' })), /\$value/)
  assert.throws(() => parseConfiguration(baseConfig({ replyMap: [], replySource: 'map' })), /replyMap/)
  assert.throws(() => parseConfiguration(baseConfig({
    replySource: 'map', replyMap: [{ input: 'A', reply: 'REPLY_A' }, { input: 'A', reply: 'REPLY_B' }]
  })), /重复/)
  assert.throws(() => parseConfiguration(baseConfig({
    replySource: 'map', replyMap: [{ input: 'A', reply: 'has space' }]
  })), /replyCharset|字符集/)
  assert.throws(() => parseConfiguration(baseConfig({ replyMinLength: 200, replyMaxLength: 10 })), /整数/)
  assert.throws(() => parseConfiguration(baseConfig({ rules: [] })), /rules/)
  assert.throws(() => parseConfiguration(baseConfig({
    rules: [{ id: 'a', trigger: 'manual', match: 'prefix', prefix: 'P:', result: 'line' }]
  })), /successLine/)
  assert.throws(() => parseConfiguration(baseConfig({
    rules: [
      { id: 'dup', trigger: 'manual', match: 'prefix', prefix: 'P:', result: 'line', successLine: 'ok', failureLine: 'no' },
      { id: 'dup', trigger: 'manual', match: 'prefix', prefix: 'P:', result: 'line', successLine: 'ok', failureLine: 'no' }
    ]
  })), /重复/)
  assert.throws(() => parseConfiguration(baseConfig({ ruleId: 'missing' })), /ruleId/)
  assert.throws(() => parseConfiguration(baseConfig({
    rules: [{ id: 'a', trigger: 'manual', match: 'prefix', prefix: 'P:', result: 'none', replyTemplate: 'no placeholder' }]
  })), /\$value/)

  const parsed = parseConfiguration(baseConfig())
  assert.equal(parsed.rules.length, 2)
  assert.equal(parsed.rules[1].holdInput.maxMs, 15_000)
  assert.equal(parsed.reply.source, 'http')
  assert.deepEqual(parsed.reply.http.fetch.body, { input: '$value' })
  assert.equal(renderTemplate(parsed.rules[0].template, 'X'), 'X')

  // 规则缺省 id 按序号补齐，表单允许先填内容后补 id。
  const generated = parseConfiguration(baseConfig({
    rules: [{ trigger: 'manual', match: 'prefix', prefix: 'P:', result: 'none' }]
  }))
  assert.equal(generated.rules[0].id, 'rule-1')

  assert.equal(matchLine({ type: 'prefix', prefix: 'Challenge:' }, 'Challenge: TOKEN_1'), 'TOKEN_1')
  assert.throws(() => matchLine({ type: 'prefix', prefix: 'Challenge:' }, 'Challenge: bad token'), /格式不匹配/)
  assert.equal(matchLine({ type: 'line' }, '  hello world  '), 'hello world')
  assert.equal(matchLine({ type: 'line' }, 'fetch', ['fetch']), undefined, '触发词行不作为内容')
  assert.equal(isTriggerWord(' # fetch ', ['fetch']), true)
  assert.equal(isTriggerWord('fetcher', ['fetch']), false)
  const lines = new LineSplitter()
  const seen = []
  lines.push('Cha', 1, (line, at) => { seen.push([line, at]); return false })
  lines.push('llenge: TOKEN_1\r', 2, (line, at) => { seen.push([line, at]); return true })
  assert.deepEqual(seen, [['Challenge: TOKEN_1', 2]])

  // 回传内容字符集与长度是统一规则。
  assert.equal(isReplyValue('two words', { charset: 'printable', minLength: 4, maxLength: 4096 }), true)
  assert.equal(isReplyValue('two words', { charset: 'base64', minLength: 4, maxLength: 4096 }), false)
  assert.equal(isReplyValue('abc', { charset: 'base64', minLength: 4, maxLength: 4096 }), false)
  assert.equal(isReplyValue('AbC_-.=', { charset: 'base64', minLength: 4, maxLength: 4096 }), true)
  console.log('  PASS configuration: strict HTTPS, same origin, $value, sources, rules, charset and id rules')
}

// ---------------------------------------------------------------------------
// 手动 / 自动流程
// ---------------------------------------------------------------------------

async function manualRelay() {
  const h = harness({
    onWrite: async (text) => {
      if (text.startsWith('request')) h.emit('\r\nChallenge: CHAL_ABC123\r\n')
      else if (text.startsWith('REPLY_PLUGIN_1')) h.emit('\r\nAccepted\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  const result = await instance.run('run')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(h.sent, [{ text: 'request\r', secret: false }, { text: 'REPLY_PLUGIN_1\r', secret: true }])
  assert.ok(h.order.indexOf('login') < h.order.indexOf('acquire'), 'manual action authenticates before taking the lease')
  assert.deepEqual(h.holdReleases, [])
  assert.equal(h.logs.length, 0)
  assert.doesNotMatch(JSON.stringify([h.logs, h.states]), /REPLY_PLUGIN_1/, '回传内容不得进入日志或状态')
  await instance.dispose()
  console.log('  PASS manual relay: authenticate → device output → fetch → verify, reply kept secret')
}

async function automaticRelay() {
  let h
  h = harness({
    autoEnabled: true,
    onWrite: async (text) => {
      if (text.startsWith('REPLY_PLUGIN_1')) h.emit('\r\nunlock ok\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  // Trigger word starts the hold even before the device output arrives.
  h.emit('fetch\r\n')
  await until(() => h.holds.length === 1, 'trigger word holds input')
  // A 20-char padded base64 value is the automatic match shape.
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  await until(() => h.states.some((state) => state.running === false), 'automatic action finishes')
  assert.deepEqual(h.sent, [{ text: 'REPLY_PLUGIN_1\r', secret: true }], 'automatic flow never sends the trigger command')
  assert.deepEqual(h.holdReleases, [true], 'held input is replayed after a successful relay')
  assert.ok(h.order.indexOf('hold') < h.order.indexOf('acquire'), 'input is held before waiting for the lease')
  assert.ok(h.order.indexOf('acquire') < h.order.indexOf('login'), 'automatic flow locks the port before login')
  assert.equal(h.states.at(-1).ok, true)
  assert.doesNotMatch(JSON.stringify([h.logs, h.states]), /REPLY_PLUGIN_1/)
  await instance.dispose()
  console.log('  PASS automatic relay: trigger hold, base64 match, lease-before-login, replay on success')
}

async function rejectedVerdict() {
  let h
  h = harness({
    autoEnabled: true,
    onWrite: async (text) => {
      if (text.startsWith('REPLY_PLUGIN_1')) h.emit('\r\nPassword: \r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  await until(() => h.states.some((state) => state.running === false), 'rejected automatic action finishes')
  assert.equal(h.states.at(-1).ok, false)
  assert.match(h.states.at(-1).error, /重新索要输入/)
  assert.deepEqual(h.holdReleases, [false], 'rejected input is discarded instead of replayed')
  assert.match(h.logs[0].message, /自动取数回传失败/)
  await instance.dispose()
  console.log('  PASS automatic rejection: prompt repeat verdict discards held input')
}

async function rejectedLine() {
  const h = harness({
    onWrite: async (text) => {
      if (text.startsWith('request')) h.emit('Challenge: CHAL_DENY1\r\n')
      else if (text.startsWith('REPLY_PLUGIN_1')) h.emit('Rejected\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  await assert.rejects(() => instance.run('run'), /拒绝/)
  await instance.dispose()
  console.log('  PASS explicit failure line rejects the relay')
}

async function loginRetry() {
  let h
  h = harness({
    onWrite: async (text) => {
      if (text.startsWith('request')) h.emit('Challenge: CHAL_RETRY1\r\n')
      else if (text.startsWith('REPLY_PLUGIN_2')) h.emit('Accepted\r\n')
    },
    request: (calls) => calls === 1
      ? { status: 401, text: '{}' }
      : { status: 200, text: JSON.stringify({ data: { reply: 'REPLY_PLUGIN_2' } }) }
  })
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.equal(h.logins, 2, 'an expired login is retried exactly once')
  assert.deepEqual(h.sent, [{ text: 'request\r', secret: false }, { text: 'REPLY_PLUGIN_2\r', secret: true }])
  await instance.dispose()
  console.log('  PASS login expiry: one re-login and retry before writing the reply')
}

async function staticReply() {
  // 固定内容不需要任何登录能力：ctx.auth 完全缺失也能运行。
  let h
  h = harness({
    noAuth: true,
    config: baseConfig({ replySource: 'static', staticReply: 'FIXED_REPLY' }),
    onWrite: async (text) => {
      if (text === 'request\r') h.emit('Challenge: CHAL_STATIC\r\n')
      if (text === 'FIXED_REPLY\r') h.emit('Accepted\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.deepEqual(h.sent, [{ text: 'request\r', secret: false }, { text: 'FIXED_REPLY\r', secret: true }])
  assert.equal(h.order.includes('login'), false, '固定内容不得触发登录')
  assert.doesNotMatch(JSON.stringify([h.logs, h.states]), /FIXED_REPLY/)
  await instance.dispose()
  console.log('  PASS static reply: no auth session, secret injection, manual command only')
}

async function mapReply() {
  let h
  h = harness({
    noAuth: true,
    autoEnabled: true,
    config: baseConfig({
      replySource: 'map',
      replyMap: [
        { input: 'Q0hBTExFTkdFX0FCQ0Q=', reply: 'MAPPED_REPLY_1' },
        { input: 'CHAL_OTHER', reply: 'MAPPED_REPLY_2' }
      ]
    }),
    onWrite: async (text) => {
      if (text === 'MAPPED_REPLY_1\r') h.emit('\r\nPastword: still waiting\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  await until(() => h.states.some((state) => state.running === false), 'mapped automatic action finishes')
  assert.deepEqual(h.sent, [{ text: 'MAPPED_REPLY_1\r', secret: true }])
  assert.equal(h.states.at(-1).ok, true)
  assert.deepEqual(h.holdReleases, [true])

  // 映射表未命中的设备输出必须明确失败，而不是写入任意内容。
  h.emit('Q0hBTExFTkdFX0FCQ0U=\r\n')
  await until(() => h.states.some((state) => state.running === false && state.ok === false), 'unknown input fails')
  assert.match(h.states.at(-1).error, /映射表/)
  assert.deepEqual(h.holdReleases.at(-1), false)
  await instance.dispose()
  console.log('  PASS reply map: exact lookup, unknown output rejects, held input discarded')
}

async function httpGetFetch() {
  let h
  const requests = []
  h = harness({
    autoEnabled: true,
    config: baseConfig({
      authCheckType: 'http-ok',
      authCheckField: '',
      fetchMethod: 'GET',
      fetchUrl: 'https://relay.example.invalid/api/reply?input=$value&kind=shell',
      fetchResponsePath: 'data.data',
      rules: [
        {
          id: 'auto', label: '自动取数回传', trigger: 'auto', triggerWords: ['fetch'], match: 'base64-line',
          result: 'line', successLine: 'Accepted', failureLine: 'Rejected',
          inputTimeoutMs: 2000, valueTtlMs: 30_000, resultTimeoutMs: 2000,
          holdInput: true, holdMaxBytes: 1024, holdMaxMs: 5000
        }
      ]
    }),
    onRequest: (input) => {
      requests.push(input)
      return { status: 200, text: JSON.stringify({ code: '000000', data: { data: 'GET_REPLY_1' } }) }
    },
    onWrite: async (text) => {
      if (text === 'GET_REPLY_1\r') h.emit('Accepted\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  h.emit('fetch\r\nQ0hBTExFTkdFX0FCQ0Q=\r\n')
  await until(() => h.states.some((state) => state.running === false), 'GET automatic action finishes')
  assert.equal(h.states.at(-1).ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].body, undefined)
  assert.equal(requests[0].url, 'https://relay.example.invalid/api/reply?input=Q0hBTExFTkdFX0FCQ0Q%3D&kind=shell')
  assert.equal(h.holds.length >= 1, true)
  assert.deepEqual(h.holds.at(-1), { maxBytes: 1024, maxMs: 5000 }, 'hold limits come from the rule')
  assert.deepEqual(h.sent, [{ text: 'GET_REPLY_1\r', secret: true }])
  await instance.dispose()
  console.log('  PASS HTTP GET source: $value in URL, dot-path fallback, per-rule hold limits')
}

async function plainTextResponse() {
  let h
  h = harness({
    config: baseConfig({ fetchResponsePath: '', replyMinLength: 1 }),
    onRequest: () => ({ status: 200, text: '  PLAIN_REPLY_9  ' }),
    onWrite: async (text) => {
      if (text.startsWith('request')) h.emit('Challenge: CHAL_PLAIN\r\n')
      if (text === 'PLAIN_REPLY_9\r') h.emit('Accepted\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.equal(h.sent.at(-1).text, 'PLAIN_REPLY_9\r')
  await instance.dispose()
  console.log('  PASS empty response path relays the trimmed response text as-is')
}

async function templateAndNoResult() {
  let h
  h = harness({
    noAuth: true,
    config: baseConfig({
      replySource: 'static',
      staticReply: 'VALUE_1',
      replyMinLength: 4,
      rules: [
        {
          id: 'manual', label: '手动', trigger: 'manual', match: 'line', result: 'none',
          command: 'get', newline: 'lf', replyTemplate: 'auth $value', inputTimeoutMs: 2000
        }
      ]
    }),
    onWrite: async (text) => {
      if (text === 'get\n') h.emit('any device line\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.deepEqual(h.sent, [{ text: 'get\n', secret: false }, { text: 'auth VALUE_1\n', secret: true }])
  await instance.dispose()
  console.log('  PASS line matching, reply template and result none write without waiting for a verdict')
}

async function triggerAndNewline() {
  let h
  h = harness({
    noAuth: true,
    autoEnabled: true,
    config: baseConfig({
      replySource: 'static',
      staticReply: 'PASS=1',
      rules: [
        {
          id: 'auto', label: '自动', trigger: 'auto', triggerWords: ['Fetch'], match: 'prefix', prefix: 'Code:',
          result: 'line', successLine: 'OK OK', failureLine: 'NO', newline: 'lf',
          inputTimeoutMs: 2000, valueTtlMs: 30_000, resultTimeoutMs: 2000,
          holdInput: true, holdMaxBytes: 2048, holdMaxMs: 4000
        }
      ]
    }),
    onWrite: async (text) => {
      if (text === 'PASS=1\n') h.emit('OK OK\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  // 触发词区分大小写且按整行匹配；退格先按设备语义折叠。
  h.emit('fetch\r\n')
  h.emit('fetci\x08h\r\n')
  await delay(80)
  assert.equal(h.holds.length, 0, '未匹配的触发词不得扣键')
  h.emit('Fetch\r\n')
  await until(() => h.holds.length === 1, 'exact trigger word holds input')
  assert.deepEqual(h.holds, [{ maxBytes: 2048, maxMs: 4000 }], 'hold limits come from the rule')
  // 前缀识别与 lf 行尾在自动流程中同样生效。
  h.emit('Code: CHAL_LF\r\n')
  await until(() => h.states.some((state) => state.running === false), 'lf automatic action finishes')
  assert.deepEqual(h.sent, [{ text: 'PASS=1\n', secret: true }])
  assert.equal(h.states.at(-1).ok, true)
  assert.deepEqual(h.holdReleases, [true], 'held input is replayed on success')
  await instance.dispose()
  console.log('  PASS trigger/newline: case-sensitive whole-line trigger, backspace fold, prefix matching and lf endings')
}

async function resetAction() {
  const h = harness({ noAuth: true, config: baseConfig({ replySource: 'static', staticReply: 'RESET_REPLY' }) })
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(await instance.run('reset'), { ok: true })
  assert.deepEqual(h.holdReleases, [false])
  await assert.rejects(() => instance.run('unknown'), /未知/)
  await assert.rejects(() => instance.run('run', { ruleId: 'missing' }), /手动取数回传规则/)
  await assert.rejects(() => instance.run('run', { ruleId: 'auto' }), /手动取数回传规则/)
  await instance.dispose()
  console.log('  PASS reset action: clears held input, rejects unknown actions and automatic rules')
}

async function ruleIdArgument() {
  const h = harness({
    noAuth: true,
    config: baseConfig({
      replySource: 'static',
      staticReply: 'SECOND_REPLY',
      rules: [
        { id: 'first', label: '一', trigger: 'manual', match: 'prefix', prefix: 'A:', command: 'a', result: 'line', successLine: 'OK', failureLine: 'NO' },
        { id: 'second', label: '二', trigger: 'manual', match: 'prefix', prefix: 'B:', command: 'b', result: 'line', successLine: 'OK', failureLine: 'NO' }
      ]
    }),
    onWrite: async (text) => {
      if (text === 'b\r') h.emit('B: CHAL_B\r\n')
      if (text === 'SECOND_REPLY\r') h.emit('OK\r\n')
    }
  })
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(await instance.run('run', { ruleId: 'second' }), { ok: true })
  assert.equal(h.sent[0].text, 'b\r')
  await instance.dispose()
  console.log('  PASS the run action accepts an explicit rule id')
}

test('manifest declares a generic serial relay identity with the required capabilities', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'))
  assert.equal(manifest.id, 'devkit.serial-url-relay')
  assert.equal(manifest.apiVersion, 2)
  assert.deepEqual(manifest.transports, ['serial'])
  assert.deepEqual(manifest.actions.map((action) => action.id), ['run', 'reset'])
  assert.deepEqual(manifest.capabilities, ['stream.read', 'stream.write', 'stream.exclusive', 'auth.session'])
  assert.deepEqual(manifest.configSchema.required ?? [], [])
  assert.equal(manifest.configSchema.properties.rules.maxItems, 32)
  assert.equal(manifest.configSchema.properties.deviceActions, undefined, '旧版整份配置入口已移除')
})
test('configuration validates sources, rules and character sets', validation)
test('manual relay authenticates before the lease and sends a secret reply', manualRelay)
test('automatic relay holds input before the lease and replays only after acceptance', automaticRelay)
test('a repeated prompt rejects the automatic relay and drops the held input', rejectedVerdict)
test('an explicit failure line rejects the manual relay', rejectedLine)
test('an expired session retries login exactly once', loginRetry)
test('a static reply relays without any auth session', staticReply)
test('a reply map resolves exact matches and rejects unknown outputs', mapReply)
test('an HTTP GET source substitutes $value in the URL', httpGetFetch)
test('an empty response path relays the plain response text', plainTextResponse)
test('line matching, reply templates and result none are configurable', templateAndNoResult)
test('trigger words, backspace folding and lf endings are configurable', triggerAndNewline)
test('the reset action discards held input and unknown actions fail', resetAction)
test('the run action accepts an explicit rule id', ruleIdArgument)

test('abort while waiting for the device output immediately rejects and releases the lease', async () => {
  const h = harness()
  const instance = await plugin.activate(h.ctx)
  const running = instance.run('run')
  const rejected = assert.rejects(running, /取消|已停止/)
  await until(() => h.sent.length === 1, 'output wait started')
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
  await until(() => h.sent.length === 1, 'output wait started')
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

test('disposal releases a trigger-word hold before any output and unsubscribes', async () => {
  const h = harness({ autoEnabled: true })
  const instance = await plugin.activate(h.ctx)
  h.emit('fetch\r\n')
  await until(() => h.holds.length === 1, 'early input hold')
  await instance.dispose()
  assert.deepEqual(h.holdReleases, [false])
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  assert.equal(h.order.includes('acquire'), false)
  assert.deepEqual(h.sent, [])
})

test('a hold failure aborts the automatic round before the lease is taken', async () => {
  const h = harness({ autoEnabled: true })
  h.setHoldError(new Error('宿主拒绝'))
  const instance = await plugin.activate(h.ctx)
  try {
    h.emit('fetch\r\nQ0hBTExFTkdFX0FCQ0Q=\r\n')
    await until(() => h.states.some((state) => state.running === false), 'hold failure settles')
    assert.equal(h.states.at(-1).ok, false)
    assert.match(h.states.at(-1).error, /扣住串口输入/)
    assert.equal(h.order.includes('acquire'), false, '锁定失败时不得占用串口事务')
    assert.deepEqual(h.sent, [])
  } finally { await instance.dispose() }
})

test('snapshot configuration survives external edits while output and verdict span chunks', async () => {
  let h
  h = harness({ onWrite: async (text) => {
    if (text === 'request\r') { h.emit('Chall'); h.emit('enge: CHAL_SPLIT_123\r\n') }
    else { h.emit('Accept'); h.emit('ed\r\n') }
  } })
  const instance = await plugin.activate(h.ctx)
  h.ctx.config.rules[0].command = 'changed'
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.equal(h.sent[0].text, 'request\r')
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

test('auto=false keeps the instance manual while activation still succeeds', async () => {
  const h = harness({
    noAuth: true,
    autoEnabled: true,
    config: baseConfig({ auto: false, replySource: 'static', staticReply: 'MANUAL_ONLY' })
  })
  const instance = await plugin.activate(h.ctx)
  h.emit('fetch\r\n')
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  await delay(80)
  assert.deepEqual(h.holds, [])
  assert.deepEqual(h.sent, [])
  await instance.dispose()
})

test('a manual-only configuration activates with autoEnabled and warns instead of failing', async () => {
  const h = harness({
    noAuth: true,
    autoEnabled: true,
    config: baseConfig({ replySource: 'static', staticReply: 'MANUAL_ONLY' }),
    onWrite: async (text) => {
      if (text === 'request\r') h.emit('Challenge: CHAL_MANUAL1\r\n')
      if (text === 'MANUAL_ONLY\r') h.emit('Accepted\r\n')
    }
  })
  h.ctx.config.rules = [h.ctx.config.rules[0]]
  const instance = await plugin.activate(h.ctx)
  assert.deepEqual(h.logs, [{ level: 'warn', message: '配置没有自动规则，自动监听不会生效' }])
  h.emit('Q0hBTExFTkdFX0FCQ0Q=\r\n')
  await delay(50)
  assert.deepEqual(h.sent, [], '没有自动规则时不响应设备输出')
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.deepEqual(h.sent, [{ text: 'request\r', secret: false }, { text: 'MANUAL_ONLY\r', secret: true }])
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

test('the line editor fold matches the device semantics', () => {
  assert.equal(foldLine('fetci\x08h'), 'fetch')
  assert.equal(foldLine('fetchh\x08'), 'fetch')
  assert.equal(foldLine('\x08'), '')
})
