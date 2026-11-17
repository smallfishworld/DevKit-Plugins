'use strict'

// This is an independent CommonJS plugin. It never imports DevKit or serialport.
// The host supplies manifest defaults; validate the same contract for standalone callers too.
function validateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('config 必须是配置对象')
  const cfg = { ...value }
  const fields = ['mode', 'match', 'response', 'newline', 'ignoreCase', 'replyDelayMs', 'maxBufferBytes']
  for (const key of Object.keys(cfg)) {
    if (!fields.includes(key)) throw new Error('未知配置字段：' + key)
  }
  if (!['text', 'hex'].includes(cfg.mode)) throw new Error('mode 必须是 text 或 hex')
  if (typeof cfg.match !== 'string' || cfg.match.length < 1 || cfg.match.length > 4096)
    throw new Error('match 必须是 1 至 4096 字符的字符串')
  if (typeof cfg.response !== 'string' || cfg.response.length > 4096)
    throw new Error('response 必须是不超过 4096 字符的字符串')
  if (!['none', 'cr', 'lf', 'crlf'].includes(cfg.newline))
    throw new Error('newline 必须是 none、cr、lf 或 crlf')
  if (typeof cfg.ignoreCase !== 'boolean') throw new Error('ignoreCase 必须是布尔值')
  if (!Number.isInteger(cfg.replyDelayMs) || cfg.replyDelayMs < 0 || cfg.replyDelayMs > 5000)
    throw new Error('replyDelayMs 必须是 0 至 5000 的整数')
  if (!Number.isInteger(cfg.maxBufferBytes) || cfg.maxBufferBytes < 256 || cfg.maxBufferBytes > 65536)
    throw new Error('maxBufferBytes 必须是 256 至 65536 的整数')
  return Object.freeze(cfg)
}

exports.activate = async function activate(ctx) {
  const cfg = validateConfiguration(ctx.config)
  let closed = false
  let textBuffer = ''
  let discardTextLine = false
  let bytesBuffer = Buffer.alloc(0)
  let replies = 0
  const sleepers = new Set()
  const maxBytes = cfg.maxBufferBytes || 8192
  const endings = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' }

  function hex(value, name) {
    const compact = String(value).replace(/\s+/g, '')
    if (!compact || compact.length % 2 || /[^0-9a-f]/i.test(compact))
      throw new Error(name + ' 必须是非空、完整字节的十六进制文本')
    return Buffer.from(compact, 'hex')
  }
  const needle = cfg.mode === 'hex' ? hex(cfg.match, '匹配内容') : null
  const reply = cfg.mode === 'hex'
    ? [...hex(cfg.response, '回复内容')]
    : String(cfg.response) + (endings[cfg.newline] || '')

  async function sleep(ms) {
    if (!ms || closed) return
    await new Promise(resolve => {
      const entry = { timer: null, resolve }
      entry.timer = setTimeout(() => { sleepers.delete(entry); resolve() }, ms)
      sleepers.add(entry)
    })
  }
  async function sendReply() {
    if (closed) return
    await sleep(cfg.replyDelayMs || 0)
    if (closed) return
    await ctx.serial.write(reply)
    replies++
    ctx.state({ replies })
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
      if (closed) return { ok: false, error: '插件已停止' }
      if (actionId === 'reset') {
        textBuffer = ''
        discardTextLine = false
        bytesBuffer = Buffer.alloc(0)
        return { ok: true }
      }
      if (actionId !== 'send') return { ok: false, error: '未知动作：' + actionId }
      await sendReply()
      return { ok: true }
    },
    async onData(event) {
      if (closed) return
      let count = 0
      if (cfg.mode === 'hex') {
        bytesBuffer = Buffer.concat([bytesBuffer, Buffer.from(event.bytes)])
        if (bytesBuffer.length > maxBytes) {
          bytesBuffer = bytesBuffer.subarray(-maxBytes)
          ctx.log('warn', '接收缓存超限，保留最新字节')
        }
        let at
        while (!closed && (at = bytesBuffer.indexOf(needle)) !== -1) {
          bytesBuffer = bytesBuffer.subarray(at + needle.length)
          if (++count > 32) {
            bytesBuffer = Buffer.alloc(0)
            throw new Error('单次接收命中超过 32 次，停止自动应答以避免回复洪泛')
          }
          await sendReply()
        }
        // Keep the suffix which could be the beginning of a split match.
        bytesBuffer = bytesBuffer.subarray(-Math.max(needle.length - 1, 0))
        if (needle.length === 1) bytesBuffer = Buffer.alloc(0)
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
      const wanted = cfg.ignoreCase ? String(cfg.match).toLowerCase() : String(cfg.match)
      for (const line of lines) {
        if (closed) return
        const actual = cfg.ignoreCase ? line.toLowerCase() : line
        if (actual !== wanted) continue
        if (++count > 32) throw new Error('单次接收命中超过 32 次，停止自动应答以避免回复洪泛')
        await sendReply()
      }
    },
    async dispose() {
      closed = true
      textBuffer = ''
      discardTextLine = false
      bytesBuffer = Buffer.alloc(0)
      for (const entry of sleepers) { clearTimeout(entry.timer); entry.resolve() }
      sleepers.clear()
    }
  }
}
