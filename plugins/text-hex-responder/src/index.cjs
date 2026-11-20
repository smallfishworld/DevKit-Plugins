'use strict'

// Standalone CommonJS plugin (DevKit API v2). Works across serial, ssh and net transports.
function validateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config 必须是配置对象')
  }
  const cfg = { newline: 'crlf', ignoreCase: false, rules: [], ...value }
  const fields = ['mode', 'match', 'response', 'rules', 'newline', 'ignoreCase', 'replyDelayMs', 'maxBufferBytes']
  for (const key of Object.keys(cfg)) {
    if (!fields.includes(key)) throw new Error('未知配置字段：' + key)
  }
  if (!['text', 'hex'].includes(cfg.mode)) throw new Error('mode 必须是 text 或 hex')
  if (typeof cfg.match !== 'string' || cfg.match.length < 1 || cfg.match.length > 4096) {
    throw new Error('match 必须是 1 至 4096 字符的字符串')
  }
  if (typeof cfg.response !== 'string' || cfg.response.length > 4096) {
    throw new Error('response 必须是不超过 4096 字符的字符串')
  }
  if (!Array.isArray(cfg.rules) || cfg.rules.length > 32) {
    throw new Error('rules 必须是至多 32 项的数组')
  }
  const normalizedRules = cfg.rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('rules 每项必须是对象')
    if (typeof rule.match !== 'string' || rule.match.length < 1 || rule.match.length > 4096) {
      throw new Error('rules.match 必须是 1 至 4096 字符的字符串')
    }
    if (typeof rule.response !== 'string' || rule.response.length > 4096) {
      throw new Error('rules.response 必须是不超过 4096 字符的字符串')
    }
    return Object.freeze({ match: rule.match, response: rule.response })
  })
  if (cfg.mode === 'text') {
    if (!['none', 'cr', 'lf', 'crlf'].includes(cfg.newline)) throw new Error('newline 必须是 none、cr、lf 或 crlf')
    if (typeof cfg.ignoreCase !== 'boolean') throw new Error('ignoreCase 必须是布尔值')
  }
  if (!Number.isInteger(cfg.replyDelayMs) || cfg.replyDelayMs < 0 || cfg.replyDelayMs > 5000) {
    throw new Error('replyDelayMs 必须是 0 至 5000 的整数')
  }
  if (!Number.isInteger(cfg.maxBufferBytes) || cfg.maxBufferBytes < 256 || cfg.maxBufferBytes > 65536) {
    throw new Error('maxBufferBytes 必须是 256 至 65536 的整数')
  }
  return Object.freeze({ ...cfg, rules: Object.freeze(normalizedRules) })
}

exports.activate = async function activate(ctx) {
  if (ctx.signal && ctx.signal.aborted) ctx.signal.throwIfAborted()
  const cfg = validateConfiguration(ctx.config)
  let closed = false
  let generation = 0
  let textBuffer = ''
  let discardTextLine = false
  let bytesBuffer = Buffer.alloc(0)
  let replies = 0
  let writeChain = Promise.resolve()
  const sleepers = new Set()
  const maxBytes = cfg.maxBufferBytes || 8192
  const endings = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' }

  function hex(value, name) {
    const compact = String(value).replace(/\s+/g, '')
    if (!compact || compact.length % 2 || /[^0-9a-f]/i.test(compact)) {
      throw new Error(name + ' 必须是非空、完整字节的十六进制文本')
    }
    return Buffer.from(compact, 'hex')
  }

  function compileRule(matchValue, responseValue) {
    if (cfg.mode === 'hex') {
      return {
        needle: hex(matchValue, '匹配内容'),
        reply: [...hex(responseValue, '回复内容')]
      }
    }
    return {
      wanted: cfg.ignoreCase ? String(matchValue).toLowerCase() : String(matchValue),
      reply: String(responseValue) + (endings[cfg.newline] || '')
    }
  }

  const primaryRule = compileRule(cfg.match, cfg.response)
  const compiledRules = [primaryRule, ...cfg.rules.map((r) => compileRule(r.match, r.response))]
  const maxNeedleLength = cfg.mode === 'hex'
    ? Math.max(...compiledRules.map((r) => r.needle.length))
    : 0

  function cancelSleepers() {
    for (const entry of sleepers) {
      clearTimeout(entry.timer)
      entry.resolve(false)
    }
    sleepers.clear()
  }

  const onAbort = () => {
    closed = true
    generation++
    cancelSleepers()
  }
  if (ctx.signal && typeof ctx.signal.addEventListener === 'function') {
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  }

  function ensureActive() {
    if (closed) throw new Error('插件已停止')
    if (ctx.signal && typeof ctx.signal.throwIfAborted === 'function') ctx.signal.throwIfAborted()
  }

  function sleep(ms, token) {
    if (!ms || closed || token !== generation) return Promise.resolve(!closed && token === generation)
    return new Promise((resolve) => {
      const entry = { timer: null, resolve }
      entry.timer = setTimeout(() => {
        sleepers.delete(entry)
        resolve(!closed && token === generation)
      }, ms)
      sleepers.add(entry)
    })
  }

  // Serialize all stream writes so replyDelayMs > 0 never causes concurrent stream.write calls.
  function enqueueReply(replyPayload) {
    const token = generation
    const task = writeChain.then(async () => {
      if (closed || token !== generation) return
      const shouldSend = await sleep(cfg.replyDelayMs || 0, token)
      if (!shouldSend || closed || token !== generation) return
      if (ctx.signal && ctx.signal.aborted) return
      await ctx.stream.write(replyPayload)
      replies++
      ctx.state({ replies })
    })
    writeChain = task.catch(() => {})
    return task
  }

  function trimTextBuffer() {
    if (Buffer.byteLength(textBuffer, 'utf8') > maxBytes) {
      textBuffer = ''
      discardTextLine = true
      ctx.log('warn', '未形成完整行的数据超过缓存上限，丢弃到下一换行')
    }
  }

  return {
    async run(actionId) {
      ensureActive()
      if (actionId === 'reset') {
        generation++
        cancelSleepers()
        textBuffer = ''
        discardTextLine = false
        bytesBuffer = Buffer.alloc(0)
        return { ok: true }
      }
      if (actionId !== 'send') throw new Error('未知动作：' + actionId)
      await enqueueReply(primaryRule.reply)
      return { ok: true }
    },

    async onData(event) {
      if (closed || (ctx.signal && ctx.signal.aborted)) return
      let count = 0
      if (cfg.mode === 'hex') {
        bytesBuffer = Buffer.concat([bytesBuffer, Buffer.from(event.bytes)])
        if (bytesBuffer.length > maxBytes) {
          bytesBuffer = bytesBuffer.subarray(-maxBytes)
          ctx.log('warn', '接收缓存超限，保留最新字节')
        }
        while (!closed) {
          let bestIndex = -1
          let bestRule = null
          for (const rule of compiledRules) {
            const at = bytesBuffer.indexOf(rule.needle)
            if (at !== -1 && (bestIndex === -1 || at < bestIndex)) {
              bestIndex = at
              bestRule = rule
            }
          }
          if (bestIndex === -1 || !bestRule) break
          bytesBuffer = bytesBuffer.subarray(bestIndex + bestRule.needle.length)
          if (++count > 32) {
            bytesBuffer = Buffer.alloc(0)
            throw new Error('单次接收命中超过 32 次，停止自动应答以避免回复洪泛')
          }
          await enqueueReply(bestRule.reply)
        }
        if (maxNeedleLength <= 1) bytesBuffer = Buffer.alloc(0)
        else bytesBuffer = bytesBuffer.subarray(-(maxNeedleLength - 1))
        return
      }

      let incoming = event.text || ''
      if (discardTextLine) {
        const separator = incoming.search(/[\r\n]/)
        if (separator === -1) return
        incoming = incoming.slice(separator + 1)
        discardTextLine = false
      }
      textBuffer += incoming
      const lines = textBuffer.split(/\r\n|\r|\n/)
      textBuffer = lines.pop() || ''
      trimTextBuffer()
      for (const line of lines) {
        if (closed) return
        const actual = cfg.ignoreCase ? line.toLowerCase() : line
        const matched = compiledRules.find((rule) => rule.wanted === actual)
        if (!matched) continue
        if (++count > 32) throw new Error('单次接收命中超过 32 次，停止自动应答以避免回复洪泛')
        await enqueueReply(matched.reply)
      }
    },

    async dispose() {
      closed = true
      generation++
      textBuffer = ''
      discardTextLine = false
      bytesBuffer = Buffer.alloc(0)
      cancelSleepers()
      if (ctx.signal && typeof ctx.signal.removeEventListener === 'function') {
        ctx.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}
