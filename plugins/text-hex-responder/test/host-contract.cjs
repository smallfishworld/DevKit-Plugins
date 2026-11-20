'use strict'
const assert = require('node:assert/strict')

exports.config = { rules: [{ match: 'STATUS', response: 'READY' }] }
exports.verify = async (instance, harness, { activate, createMockPluginContext }) => {
  await instance.onData(harness.makeDataEvent('PI'))
  assert.equal(harness.writes.length, 0)
  await instance.onData(harness.makeDataEvent('NG\r\nSTATUS\nPING\n'))
  assert.deepEqual(harness.writes.map((write) => write.data), ['PONG\r\n', 'READY\r\n', 'PONG\r\n'])
  assert.deepEqual(await instance.run('send'), { ok: true })
  assert.equal(harness.writes.at(-1).data, 'PONG\r\n')

  const hex = createMockPluginContext({
    config: {
      ...harness.ctx.config, mode: 'hex', match: 'AA 55', response: '00 FF',
      rules: [{ match: '01 02', response: 'FE 00' }]
    },
    session: harness.ctx.session, autoEnabled: true
  })
  const hexInstance = await activate(hex.ctx)
  try {
    await hexInstance.onData(hex.makeDataEvent([0xaa]))
    assert.equal(hex.writes.length, 0)
    await hexInstance.onData(hex.makeDataEvent([0x55, 0x01, 0x02]))
    assert.deepEqual(hex.writes.map((write) => write.data), [[0x00, 0xff], [0xfe, 0x00]])
  } finally {
    await hexInstance.dispose()
    hex.controller.abort()
  }
}
