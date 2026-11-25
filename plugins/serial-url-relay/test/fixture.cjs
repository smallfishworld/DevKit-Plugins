'use strict'

// Synthetic data only; no real endpoint or credential.
function baseConfig(overrides = {}) {
  return {
    ruleId: '',
    auto: true,
    replySource: 'http',
    loginUrl: 'https://relay.example.invalid/login',
    authOrigins: '',
    authCheckType: 'json',
    authCheckUrl: 'https://relay.example.invalid/api/session',
    authCheckField: 'authenticated',
    fetchMethod: 'POST',
    fetchUrl: 'https://relay.example.invalid/api/reply',
    fetchBody: { input: '$value' },
    fetchResponsePath: 'data.reply',
    fetchLoginExpiredHttp: '401,403',
    fetchLoginExpiredCodes: '003,403003',
    fetchRetryLoginOnce: true,
    fetchUserAgent: '',
    staticReply: '',
    replyMap: [],
    replyCharset: 'base64',
    replyMinLength: 4,
    replyMaxLength: 4096,
    rules: [
      {
        id: 'manual',
        label: '手动取数回传',
        actionLabel: '执行取数回传',
        trigger: 'manual',
        triggerWords: '',
        match: 'prefix',
        prefix: 'Challenge:',
        result: 'line',
        successLine: 'Accepted',
        failureLine: 'Rejected',
        command: 'request',
        newline: 'cr',
        replyTemplate: '',
        inputTimeoutMs: 2000,
        valueTtlMs: 30_000,
        resultTimeoutMs: 2000,
        holdInput: true,
        holdMaxBytes: 4096,
        holdMaxMs: 15_000
      },
      {
        id: 'auto',
        label: '自动取数回传',
        actionLabel: '自动取数回传',
        trigger: 'auto',
        triggerWords: 'fetch, Fetch',
        match: 'base64-line',
        shortMin: 20,
        shortMax: 21,
        longMin: 300,
        longMinDecoded: 260,
        result: 'prompt-repeat',
        promptText: 'Password:',
        decisionDelayMs: 20,
        silenceMs: 300,
        newline: 'cr',
        replyTemplate: '',
        inputTimeoutMs: 2000,
        valueTtlMs: 30_000,
        resultTimeoutMs: 2000,
        holdInput: true,
        holdMaxBytes: 4096,
        holdMaxMs: 15_000
      }
    ],
    ...overrides
  }
}

module.exports = { baseConfig }
