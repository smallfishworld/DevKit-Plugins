'use strict'

// Synthetic data only; no real OA endpoint or credential.
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

module.exports = { baseConfig }
