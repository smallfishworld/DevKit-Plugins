'use strict'
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { baseConfig } = require('./fixture.cjs')

// The real SDK contract check exercises the installed package with synthetic
// protocol/HTTP replies: the schema-driven form with a static reply (no auth
// session) and the same form driven by an HTTP fetch.
exports.config = baseConfig({
  replySource: 'static',
  staticReply: 'CONTRACT_REPLY_1',
  ruleId: 'manual'
})

exports.autoEnabled = false

exports.onWrite = (_harness, data) => {
  if (data === 'request\r') _harness.emitData('Challenge: CHAL_CONTRACT1\r\n')
  else if (data === 'CONTRACT_REPLY_1\r') _harness.emitData('Accepted\r\n')
  else throw new Error('Unexpected contract write: ' + JSON.stringify(data))
}

exports.verify = async (instance, harness, { activate, createMockPluginContext }) => {
  // 1) Schema-driven form, static reply: no auth session is touched.
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.deepEqual(harness.writes.map(({ data, options }) => [data, options?.secret === true]), [
    ['request\r', false], ['CONTRACT_REPLY_1\r', true]
  ])
  assert.doesNotMatch(JSON.stringify([harness.logs, harness.states]), /CONTRACT_REPLY_1/)
  assert.deepEqual(harness.leases, { active: false, acquired: 1, released: 1 })

  // 2) Schema-driven form, automatic hold/replay. The device never receives the
  //    trigger command, and the reply stays out of logs/state.
  let automatic
  automatic = createMockPluginContext({
    config: baseConfig({ replySource: 'static', staticReply: 'CONTRACT_REPLY_2', ruleId: 'auto' }),
    session: harness.ctx.session,
    autoEnabled: true,
    onWrite: (data, options) => {
      if (data !== 'CONTRACT_REPLY_2\r') throw new Error('automatic flow must only write the reply')
      assert.equal(options.secret, true)
      automatic.emitData('unlock ok\r\n')
    }
  })
  const autoInstance = await activate(automatic.ctx)
  try {
    automatic.emitData('fetch\r\n')
    assert.equal(automatic.holds.active, true, 'trigger word holds input before the device output')
    automatic.emitData('Q0hBTExFTkdFX0FCQ0Q=\r\n')
    const deadline = Date.now() + 2000
    while (!automatic.states.some((state) => state.running === false)) {
      if (Date.now() > deadline) throw new Error('automatic transaction did not finish')
      await delay(5)
    }
    assert.equal(automatic.states.at(-1).ok, true)
    assert.deepEqual(automatic.holds.releases, [true])
    assert.equal(automatic.holds.active, false)
    assert.deepEqual(automatic.leases, { active: false, acquired: 1, released: 1 })
    assert.equal(automatic.writes.length, 1, 'auto flow never sends the trigger command')
    assert.doesNotMatch(JSON.stringify([automatic.logs, automatic.states]), /CONTRACT_REPLY_2/)
  } finally {
    await autoInstance.dispose()
    automatic.controller.abort()
  }

  // 3) HTTP fetch with login: the reply comes from a same-origin endpoint and
  //    the request body carries the device output under $value.
  let remote
  remote = createMockPluginContext({
    config: baseConfig({ ruleId: 'manual' }),
    session: harness.ctx.session,
    autoEnabled: false,
    onAuthLogin: (options) => {
      assert.equal(options.loginUrl, 'https://relay.example.invalid/login')
      assert.equal(options.check.field, 'authenticated')
    },
    onAuthRequest: (options) => {
      assert.equal(options.url, 'https://relay.example.invalid/api/reply')
      assert.deepEqual(JSON.parse(options.body), { input: 'CHAL_REMOTE1' })
      return { status: 200, text: JSON.stringify({ data: { reply: 'REMOTE_REPLY_1' } }) }
    },
    onWrite: (data, options) => {
      if (data === 'request\r') remote.emitData('Challenge: CHAL_REMOTE1\r\n')
      else if (data === 'REMOTE_REPLY_1\r') {
        assert.equal(options.secret, true)
        remote.emitData('Accepted\r\n')
      } else throw new Error('Unexpected remote write: ' + JSON.stringify(data))
    }
  })
  const remoteInstance = await activate(remote.ctx)
  try {
    assert.deepEqual(await remoteInstance.run('run'), { ok: true })
    assert.deepEqual(await remoteInstance.run('reset'), { ok: true })
    assert.doesNotMatch(JSON.stringify([remote.logs, remote.states]), /REMOTE_REPLY_1/)
    assert.deepEqual(remote.leases, { active: false, acquired: 1, released: 1 })
  } finally {
    await remoteInstance.dispose()
    remote.controller.abort()
  }
}
