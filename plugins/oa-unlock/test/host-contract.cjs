'use strict'
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { baseConfig } = require('./fixture.cjs')

// The real SDK contract check exercises the installed package with synthetic protocol/OA replies.
exports.config = { deviceActions: baseConfig(), profileId: 'manual', auto: true }
exports.autoEnabled = false
exports.onWrite = (harness, data) => {
  if (data === 'debug\r') harness.emitData('Challenge: CHAL_CONTRACT1\r\n')
  else if (data === 'TOKEN_CONTRACT_1\r') harness.emitData('Debug unlocked\r\n')
  else throw new Error('Unexpected OA contract write')
}
exports.onAuthLogin = (_harness, options) => {
  assert.equal(options.loginUrl, 'https://oa.example.invalid/login')
  assert.equal(options.check.field, 'authenticated')
}
exports.onAuthRequest = (_harness, options) => {
  assert.equal(options.url, 'https://oa.example.invalid/api/device/token')
  assert.deepEqual(JSON.parse(options.body), { challenge: 'CHAL_CONTRACT1' })
  return { status: 200, text: JSON.stringify({ response: 'TOKEN_CONTRACT_1' }) }
}
exports.verify = async (instance, harness, { activate, createMockPluginContext }) => {
  assert.deepEqual(await instance.run('run'), { ok: true })
  assert.deepEqual(harness.writes.map(({ data, options }) => [data, options?.secret === true]), [
    ['debug\r', false], ['TOKEN_CONTRACT_1\r', true]
  ])
  assert.doesNotMatch(JSON.stringify([harness.logs, harness.states]), /TOKEN_CONTRACT_1/)
  assert.deepEqual(harness.leases, { active: false, acquired: 1, released: 1 })

  let automatic
  automatic = createMockPluginContext({
    config: { deviceActions: baseConfig(), profileId: 'auto', auto: true },
    session: harness.ctx.session,
    autoEnabled: true,
    onAuthLogin: (options) => exports.onAuthLogin(automatic, options),
    onAuthRequest: (options) => {
      assert.deepEqual(JSON.parse(options.body), { challenge: 'Q0hBTExFTkdFX0FCQ0Q=' })
      return { status: 200, text: JSON.stringify({ response: 'TOKEN_AUTO_1' }) }
    },
    onWrite: (data, options) => {
      assert.equal(data, 'TOKEN_AUTO_1\r')
      assert.equal(options.secret, true)
      automatic.emitData('unlock ok\r\n')
    }
  })
  const autoInstance = await activate(automatic.ctx)
  try {
    automatic.emitData('debug\r\n')
    assert.equal(automatic.holds.active, true, 'trigger word holds input before the challenge')
    automatic.emitData('Q0hBTExFTkdFX0FCQ0Q=\r\n')
    const deadline = Date.now() + 2000
    while (!automatic.states.some((state) => state.running === false)) {
      if (Date.now() > deadline) throw new Error('OA SDK automatic transaction did not finish')
      await delay(5)
    }
    assert.equal(automatic.states.at(-1).ok, true)
    assert.deepEqual(automatic.holds.releases, [true])
    assert.equal(automatic.holds.active, false)
    assert.deepEqual(automatic.leases, { active: false, acquired: 1, released: 1 })
    assert.equal(automatic.writes.length, 1, 'auto flow never sends the trigger command')
    assert.doesNotMatch(JSON.stringify([automatic.logs, automatic.states]), /TOKEN_AUTO_1/)
  } finally {
    await autoInstance.dispose()
    automatic.controller.abort()
  }

}
