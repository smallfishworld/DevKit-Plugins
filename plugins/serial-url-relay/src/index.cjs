'use strict'

// 串口取数回传（DevKit 外部插件）
// 设备输出命中规则后，从 HTTPS 接口取回数据（或使用固定值、映射表），再回传到串口。
// 串口由 DevKit 宿主持有：本插件只通过 ctx.stream / ctx.auth 声明能力，
// 不导入 DevKit、serialport 或 Electron。Cookie 留在宿主 Chromium 分区，
// 回传内容只经 secret 写入，绝不进入日志、状态或错误文本。
//
// 配置只有一种形态：顶层字段描述回传内容来源，rules 数组描述每种设备动作，
// 由 manifest Schema 驱动。

const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/
const FIELD_PATH = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,3}$/
const BASE64_TOKEN = /^[A-Za-z0-9._~+/=-]+$/
const MAX_RULES = 32
const MAX_LINE = 4096

function record(value, label = '配置') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '应为 JSON 对象')
  return value
}
function field(value, label, max = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(label + ' 缺失或格式无效')
  }
  return value.trim()
}
function optionalField(value, label, max = 128) {
  return value === undefined ? undefined : field(value, label, max)
}
function urlField(value, label) {
  let url
  try { url = new URL(field(value, label, 2048)) } catch { throw new Error(label + ' 不是有效地址') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(label + ' 必须是有效的 HTTPS 地址')
  }
  return url
}
function originField(value, label) {
  let url
  try { url = new URL(field(value, label, 2048)) } catch { throw new Error(label + ' 不是有效地址') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username || url.password || url.hash || url.pathname !== '/' || url.search) {
    throw new Error(label + ' 只能包含 http(s) 协议、主机和端口')
  }
  return url.origin
}
function integer(value, label, min, max, fallback) {
  if (value === undefined) {
    if (fallback === undefined) throw new Error(label + ' 缺失')
    return fallback
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(label + ' 须为 ' + min + ' 至 ' + max + ' 的整数')
  }
  return value
}
function boolean(value, label, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(label + ' 须为布尔值')
  return value
}
function key(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_$-]{1,64}$/.test(value)) throw new Error(label + ' 无效')
  return value
}
function fieldPath(value, label) {
  if (typeof value !== 'string' || !FIELD_PATH.test(value)) throw new Error(label + ' 无效')
  return value
}
function listOf(value, label, max = 16) {
  if (value === undefined) return []
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(',') : null
  if (!entries) throw new Error(label + ' 须为数组或逗号分隔字符串')
  if (entries.length > max) throw new Error(label + ' 最多 ' + max + ' 项')
  return entries.map((entry) => String(entry).trim()).filter(Boolean)
}

/** 回传内容字符集约束；HTTP 响应、固定值与映射表共用同一规则。 */
function parseReplyRule(raw) {
  const charset = raw.replyCharset === undefined ? 'base64' : raw.replyCharset
  if (charset !== 'base64' && charset !== 'printable') throw new Error('replyCharset 须为 base64 或 printable')
  const minLength = integer(raw.replyMinLength, 'replyMinLength', 1, 4096, 4)
  const maxLength = integer(raw.replyMaxLength, 'replyMaxLength', minLength, 65_536, 4096)
  return { charset, minLength, maxLength }
}
function isReplyValue(value, rule) {
  if (typeof value !== 'string' || value.length < rule.minLength || value.length > rule.maxLength) return false
  if (/[\x00-\x1f\x7f]/.test(value)) return false
  return rule.charset === 'printable' || BASE64_TOKEN.test(value)
}

/** 回传内容模板：留空即 $value，非空时必须包含 $value。 */
function parseTemplate(value) {
  if (value === undefined || value === '') return '$value'
  const template = field(value, 'replyTemplate', 512)
  if (!template.includes('$value')) throw new Error('replyTemplate 必须包含 $value 占位符')
  return template
}
function renderTemplate(template, value) {
  return template.split('$value').join(value)
}

function parseMatch(p) {
  const type = p.match === undefined ? 'prefix' : p.match
  if (type === 'prefix') return { type: 'prefix', prefix: field(p.prefix === undefined ? 'Challenge:' : p.prefix, 'prefix') }
  if (type === 'line') return { type: 'line' }
  if (type === 'base64-line') {
    const shortMin = integer(p.shortMin, 'shortMin', 8, 256, 20)
    const shortMax = integer(p.shortMax, 'shortMax', shortMin, 512, 21)
    const longMin = integer(p.longMin, 'longMin', shortMax, 8192, 300)
    return {
      type: 'base64-line', shortMin, shortMax, longMin,
      longMinDecoded: integer(p.longMinDecoded, 'longMinDecoded', 16, 8192, 260)
    }
  }
  throw new Error('match 须为 prefix、base64-line 或 line')
}

function parseResult(p) {
  const type = p.result === undefined ? 'line' : p.result
  if (type === 'none') return { type: 'none' }
  if (type === 'line') {
    const successLine = field(p.successLine, 'successLine')
    const failureLine = field(p.failureLine, 'failureLine')
    if (successLine === failureLine) throw new Error('成功与失败提示不能相同')
    return { type: 'line', successLine, failureLine }
  }
  if (type === 'prompt-repeat') {
    return {
      type: 'prompt-repeat',
      promptText: field(p.promptText === undefined ? 'Password:' : p.promptText, 'promptText'),
      decisionDelayMs: integer(p.decisionDelayMs, 'decisionDelayMs', 0, 2000, 150),
      silenceMs: integer(p.silenceMs, 'silenceMs', 100, 30_000, 3000)
    }
  }
  throw new Error('result 须为 line、prompt-repeat 或 none')
}

function parseNewline(value, label, fallback = 'cr') {
  const newline = value === undefined ? fallback : value
  if (!['cr', 'lf', 'crlf', 'none'].includes(newline)) throw new Error(label + ' 须为 cr、lf、crlf 或 none')
  return newline
}

function parseHold(p, trigger) {
  if (trigger !== 'auto') return false
  if (!boolean(p.holdInput, 'holdInput', true)) return false
  return {
    maxBytes: integer(p.holdMaxBytes, 'holdMaxBytes', 256, 1_048_576, 4096),
    maxMs: integer(p.holdMaxMs, 'holdMaxMs', 1000, 300_000, 15_000)
  }
}

function expiringHttp(value) {
  if (value === undefined || value === '') return [401, 403]
  const entries = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(entries) || entries.length > 8) throw new Error('fetchLoginExpiredHttp 须为最多 8 个 HTTP 状态码')
  const codes = entries.map((entry) => {
    const code = typeof entry === 'number' ? entry : Number(String(entry).trim())
    if (!Number.isInteger(code) || code < 100 || code > 599) throw new Error('fetchLoginExpiredHttp 须为有效 HTTP 状态码')
    return code
  })
  return [...new Set(codes)].sort((a, b) => a - b)
}

function expiringCodes(value) {
  if (value === undefined || value === '') return []
  const entries = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(entries) || entries.length > 16) throw new Error('fetchLoginExpiredCodes 须为最多 16 个短字符串')
  const codes = entries.map((entry) => String(entry).trim()).filter(Boolean)
  if (codes.some((code) => code.length > 64 || /[\x00-\x1f\x7f]/.test(code))) {
    throw new Error('fetchLoginExpiredCodes 须为最多 16 个短字符串')
  }
  return [...new Set(codes)]
}

function parseTriggerWords(value) {
  const words = listOf(value, 'triggerWords', 16).map((entry) => field(entry, 'triggerWords', 64))
  return [...new Set(words)]
}

function parseReplySource(cfg, rule) {
  const source = cfg.replySource === undefined ? 'http' : cfg.replySource
  if (source === 'http') {
    // 新建实例的默认来源是 http；先明确列出还缺哪些地址，避免只报“不是有效地址”。
    const missing = [
      ['登录入口 loginUrl', cfg.loginUrl],
      ['登录检查接口 authCheckUrl', cfg.authCheckUrl],
      ['取数接口 fetchUrl', cfg.fetchUrl]
    ].filter(([, value]) => typeof value !== 'string' || !value.trim()).map(([label]) => label)
    if (missing.length) throw new Error('请先在插件配置中填写：' + missing.join('、'))
    const login = urlField(cfg.loginUrl, 'loginUrl')
    const checkType = cfg.authCheckType === undefined ? 'json' : cfg.authCheckType
    if (checkType !== 'json' && checkType !== 'http-ok') throw new Error('authCheckType 须为 json 或 http-ok')
    const authCheck = {
      type: checkType,
      url: urlField(cfg.authCheckUrl, 'authCheckUrl').href,
      ...(checkType === 'json' ? { field: fieldPath(cfg.authCheckField === undefined ? 'authenticated' : cfg.authCheckField, 'authCheckField') } : {})
    }
    const fetchUrl = urlField(cfg.fetchUrl, 'fetchUrl')
    const method = cfg.fetchMethod === undefined ? 'POST' : cfg.fetchMethod
    if (method !== 'POST' && method !== 'GET') throw new Error('fetchMethod 须为 POST 或 GET')
    if (new URL(authCheck.url).origin !== login.origin || fetchUrl.origin !== login.origin) {
      throw new Error('登录检查与取数接口必须与登录入口同源')
    }
    const authOrigins = listOf(cfg.authOrigins, 'authOrigins', 16).map((entry) => originField(entry, 'authOrigins'))
    let body
    let url = fetchUrl.href
    if (method === 'GET') {
      if (!url.includes('$value')) throw new Error('GET 取数地址必须包含 $value 占位符')
    } else {
      const template = cfg.fetchBody === undefined ? { value: '$value' } : record(cfg.fetchBody, 'fetchBody')
      body = {}
      for (const [rawKey, rawValue] of Object.entries(template)) {
        const name = key(rawKey, 'fetchBody 键名')
        if (typeof rawValue !== 'string' || rawValue.length > 512 || /[\x00-\x1f\x7f]/.test(rawValue)) {
          throw new Error('fetchBody 值须为不含控制字符的字符串')
        }
        body[name] = rawValue
      }
      if (!Object.keys(body).length) throw new Error('fetchBody 不能为空')
      if (!Object.values(body).some((text) => text.includes('$value'))) throw new Error('fetchBody 必须包含 $value 占位符')
    }
    const responsePath = cfg.fetchResponsePath === undefined || cfg.fetchResponsePath === ''
      ? ''
      : fieldPath(cfg.fetchResponsePath, 'fetchResponsePath')
    return {
      source: 'http',
      http: {
        loginUrl: login.href,
        authOrigins,
        authCheck,
        fetch: {
          url,
          ...(body ? { body } : {}),
          method,
          responsePath,
          loginExpiredHttp: expiringHttp(cfg.fetchLoginExpiredHttp),
          loginExpiredCodes: expiringCodes(cfg.fetchLoginExpiredCodes),
          retryLoginOnce: boolean(cfg.fetchRetryLoginOnce, 'fetchRetryLoginOnce', true),
          userAgent: cfg.fetchUserAgent ? optionalField(cfg.fetchUserAgent, 'fetchUserAgent', 512) : undefined
        }
      },
      rule
    }
  }
  if (source === 'static') {
    if (typeof cfg.staticReply !== 'string' || !cfg.staticReply.trim() || /[\x00-\x1f\x7f]/.test(cfg.staticReply)) {
      throw new Error('固定回传内容 staticReply 缺失或格式无效')
    }
    const value = cfg.staticReply
    if (!isReplyValue(value, rule)) throw new Error('固定回传内容不符合 replyCharset / replyMinLength / replyMaxLength')
    return { source: 'static', staticReply: value, rule }
  }
  if (source === 'map') {
    if (!Array.isArray(cfg.replyMap) || !cfg.replyMap.length || cfg.replyMap.length > 64) {
      throw new Error('replyMap 须包含 1 至 64 项设备输出映射')
    }
    const map = new Map()
    for (const entry of cfg.replyMap) {
      const item = record(entry, 'replyMap 项')
      const input = field(item.input, 'replyMap.input', MAX_LINE)
      const reply = field(item.reply, 'replyMap.reply', 65_536)
      if (map.has(input)) throw new Error('replyMap 中的设备输出重复')
      if (!isReplyValue(reply, rule)) throw new Error('replyMap 中的回传内容不符合 replyCharset / replyMinLength / replyMaxLength')
      map.set(input, reply)
    }
    return { source: 'map', map, rule }
  }
  throw new Error('replySource 须为 http、static 或 map')
}

/** 顶层字段描述回传内容来源，rules 数组描述每种设备动作。 */
function parseConfiguration(cfg) {
  const rule = parseReplyRule(cfg)
  const reply = parseReplySource(cfg, rule)
  if (!Array.isArray(cfg.rules) || !cfg.rules.length || cfg.rules.length > MAX_RULES) {
    throw new Error('rules 须包含 1 至 ' + MAX_RULES + ' 条取数回传规则')
  }
  const ids = new Set()
  const rules = cfg.rules.map((entry, index) => {
    const p = record(entry, '取数回传规则')
    const id = p.id === undefined || p.id === '' ? 'rule-' + (index + 1) : field(p.id, '规则 ID', 64)
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || ids.has(id)) throw new Error('规则 ID 无效或重复')
    ids.add(id)
    const trigger = p.trigger === undefined ? 'manual' : p.trigger
    if (trigger !== 'manual' && trigger !== 'auto') throw new Error('trigger 须为 manual 或 auto')
    return {
      id,
      label: field(p.label === undefined ? id : p.label, '规则名称'),
      actionLabel: field(p.actionLabel === undefined ? '取数回传' : p.actionLabel, 'actionLabel'),
      trigger,
      triggerWords: parseTriggerWords(p.triggerWords),
      match: parseMatch(p),
      result: parseResult(p),
      command: optionalField(p.command, 'command', 512),
      newline: parseNewline(p.newline, 'newline'),
      template: parseTemplate(p.replyTemplate),
      inputTimeoutMs: integer(p.inputTimeoutMs, 'inputTimeoutMs', 100, 300_000, 5000),
      valueTtlMs: integer(p.valueTtlMs, 'valueTtlMs', 100, 300_000, 30_000),
      resultTimeoutMs: integer(p.resultTimeoutMs, 'resultTimeoutMs', 100, 300_000, 5000),
      holdInput: parseHold(p, trigger)
    }
  })
  const defaultRuleId = typeof cfg.ruleId === 'string' && cfg.ruleId ? cfg.ruleId : undefined
  if (defaultRuleId !== undefined && !rules.some((item) => item.id === defaultRuleId)) {
    throw new Error('ruleId 未匹配任何取数回传规则')
  }
  return { reply, rules, defaultRuleId, autoAllowed: boolean(cfg.auto, 'auto', true) }
}

/** 行首前缀、base64 形状或整行内容的设备输出。prefix 命中但内容非法时明确报错。 */
function matchLine(match, line, triggerWords) {
  if (match.type === 'prefix') {
    if (!line.startsWith(match.prefix)) return undefined
    const value = line.slice(match.prefix.length).trim()
    if (!/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(value)) throw new Error('设备输出的内容格式不匹配')
    return value
  }
  if (match.type === 'line') {
    const value = line.trim()
    if (!value || value.length > MAX_LINE) return undefined
    // 触发词那一行只是提示设备即将输出内容，不应被当成内容本身。
    if (triggerWords && triggerWords.length && isTriggerWord(value, triggerWords)) return undefined
    return value
  }
  const value = line.trim()
  if (!BASE64_LINE.test(value)) return undefined
  if (value.length >= match.shortMin && value.length <= match.shortMax && value.endsWith('=')) return value
  if (value.length >= match.longMin && value.length <= MAX_LINE &&
    Buffer.from(value, 'base64').length >= match.longMinDecoded) return value
  return undefined
}

function matchResultLine(result, line) {
  if (line === result.successLine) return 'accepted'
  if (line === result.failureLine) return 'rejected'
  return undefined
}

function isPromptLine(line, promptText) {
  return line.trim().startsWith(promptText)
}

/** 按设备行编辑器的语义折叠退格，再把触发词按整行匹配（可带 # $ > % 提示符）。 */
function foldLine(line) {
  const erased = []
  for (const ch of line) {
    if (ch === '\x08') erased.pop()
    else erased.push(ch)
  }
  return erased.join('')
}
function isTriggerWord(line, words) {
  if (!words || !words.length) return false
  const raw = String(line).trim()
  const candidates = [raw, raw.replace(/^[#>$%]\s*/, ''), foldLine(raw).trim(), foldLine(raw).trim().replace(/^[#>$%]\s*/, '')]
  return candidates.some((candidate) => words.includes(candidate))
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
}

/** 跨 USB 回调/终端批次拼完整行，避免分包拆散匹配内容或结果行。 */
class LineSplitter {
  constructor() {
    this.partial = ''
    this.oversize = false
  }
  reset() {
    this.partial = ''
    this.oversize = false
  }
  push(text, receivedAt, visit) {
    const segments = text.split(/[\r\n]/)
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]
      if (this.partial.length + segment.length > MAX_LINE) {
        this.oversize = true
        this.partial = ''
      }
      if (!this.oversize) this.partial += segment
      if (index === segments.length - 1) return
      const line = this.oversize ? '' : stripAnsi(this.partial).trim()
      this.partial = ''
      this.oversize = false
      if (line && visit(line, receivedAt)) return
    }
  }
}

class LoginExpiredError extends Error {
  constructor(message = '取数时登录已失效，请确认设备状态后重新发起') {
    super(message)
    this.name = 'LoginExpiredError'
  }
}

function readPath(value, path) {
  let current = value
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

/** 取数失败只描述结构（字段名/长度），绝不把可能的内容写进诊断。 */
function describeFetchFailure(value) {
  const top = Object.keys(value).slice(0, 8).join(',') || '-'
  const data = value.data
  const shape = data === undefined ? '无'
    : data === null ? 'null'
      : typeof data === 'string' ? 'string(' + data.length + ')'
        : Array.isArray(data) ? 'array(' + data.length + ')'
          : typeof data === 'object' ? 'object{' + (Object.keys(data).slice(0, 8).join(',') || '-') + '}'
            : typeof data
  const code = String(value.code === undefined ? '' : value.code).slice(0, 64)
  return '取数接口未返回有效内容（code=' + (code || '-') + '，data=' + shape + '，顶层=' + top + '）'
}

function newlineOf(rule) {
  return rule.newline === 'crlf' ? '\r\n' : rule.newline === 'lf' ? '\n' : rule.newline === 'cr' ? '\r' : ''
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

exports.activate = async function activate(ctx) {
  const snapshot = parseConfiguration(ctx.config && typeof ctx.config === 'object' ? ctx.config : {})
  const usesHttp = snapshot.reply.source === 'http'
  if (usesHttp && (typeof ctx.auth?.login !== 'function' || typeof ctx.auth?.request !== 'function')) {
    throw new Error('宿主未提供 auth.session 能力')
  }

  let closed = false
  let busy = false
  let active = null
  let watchLines = null
  const autoRules = snapshot.rules.filter((rule) => rule.trigger === 'auto')
  const autoWatching = Boolean(ctx.autoEnabled) && snapshot.autoAllowed

  function assertLive() {
    if (closed || ctx.signal.aborted) throw new Error('插件已停止')
  }
  function setStage(stage, rule) {
    ctx.state({ running: true, stage, ruleId: rule.id })
  }
  async function authenticate(rule, stage) {
    let loginTimer
    const pending = ctx.auth.login({
      loginUrl: snapshot.reply.http.loginUrl,
      authOrigins: snapshot.reply.http.authOrigins,
      check: snapshot.reply.http.authCheck,
      title: 'DevKit · 取数回传登录',
      timeoutMs: 180_000
    })
    loginTimer = setTimeout(() => { if (!closed) setStage('login', rule) }, 300)
    try {
      await pending
    } finally {
      clearTimeout(loginTimer)
    }
    assertLive()
    stage()
  }
  async function fetchReply(input, remainingMs, rule) {
    const fetch = snapshot.reply.http.fetch
    const headers = { Accept: 'application/json' }
    if (fetch.userAgent) headers['User-Agent'] = fetch.userAgent
    let url = fetch.url
    let body
    if (fetch.method === 'GET') {
      url = url.split('$value').join(encodeURIComponent(input))
      headers.Accept = 'application/json, text/plain, */*'
    } else {
      body = JSON.stringify(Object.fromEntries(
        Object.entries(fetch.body).map(([name, template]) => [name, template.split('$value').join(input)])
      ))
    }
    let response
    try {
      response = await ctx.auth.request({
        loginUrl: snapshot.reply.http.loginUrl,
        authOrigins: snapshot.reply.http.authOrigins,
        url,
        method: fetch.method,
        headers,
        ...(body === undefined ? {} : { body }),
        timeoutMs: Math.max(1000, Math.min(8000, remainingMs))
      })
    } catch (error) {
      assertLive()
      throw new Error('内网接口请求失败或超时（' + errorText(error) + '），请检查公司网络')
    }
    if (fetch.loginExpiredHttp.includes(response.status)) throw new LoginExpiredError()
    if (response.status < 200 || response.status >= 300) {
      throw new Error('取数接口拒绝请求（HTTP ' + response.status + '）')
    }
    if (!fetch.responsePath) {
      const text = typeof response.text === 'string' ? response.text.trim() : ''
      if (!isReplyValue(text, snapshot.reply.rule)) throw new Error('取数接口返回内容不符合 replyCharset / replyMinLength / replyMaxLength')
      return text
    }
    let value
    try { value = JSON.parse(response.text) } catch { throw new Error('内网接口没有返回预期的 JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内网接口没有返回预期的 JSON')
    const object = value
    if (fetch.loginExpiredCodes.includes(String(object.code === undefined ? '' : object.code))) {
      throw new LoginExpiredError()
    }
    let reply = readPath(object, fetch.responsePath)
    // 内容可能包在 data.data，也可能直接是 data。
    // 仅当配置路径没命中、且其父级本身就是字符串时才回退，避免误取包装对象。
    const separator = fetch.responsePath.lastIndexOf('.')
    if (reply === undefined && separator > 0) {
      const parent = readPath(object, fetch.responsePath.slice(0, separator))
      if (typeof parent === 'string') reply = parent
    }
    if (object.ok === false || !isReplyValue(reply, snapshot.reply.rule)) throw new Error(describeFetchFailure(object))
    return reply
  }

  async function obtainReply(input, receivedAt, rule) {
    if (snapshot.reply.source === 'static') return snapshot.reply.staticReply
    if (snapshot.reply.source === 'map') {
      const reply = snapshot.reply.map.get(input)
      if (!reply) throw new Error('设备输出不在映射表中，无法回传内容')
      return reply
    }
    const ttl = rule.valueTtlMs
    let remaining = ttl - (Date.now() - receivedAt)
    if (remaining <= 0) throw new Error('设备输出已过期')
    setStage('fetch', rule)
    let reply
    try {
      reply = await fetchReply(input, remaining, rule)
    } catch (error) {
      assertLive()
      if (Date.now() - receivedAt >= ttl) throw new Error('设备输出已过期')
      if (!(error instanceof LoginExpiredError) || !snapshot.reply.http.fetch.retryLoginOnce) throw error
      await authenticate(rule, () => setStage('fetch', rule))
      assertLive()
      remaining = ttl - (Date.now() - receivedAt)
      if (remaining <= 0) throw new Error('设备输出已过期')
      reply = await fetchReply(input, remaining, rule)
    }
    assertLive()
    if (Date.now() - receivedAt >= ttl) throw new Error('设备输出已过期')
    return reply
  }

  function nextLine(lease, text, secret, timeoutMs, match) {
    return new Promise((resolve, reject) => {
      assertLive()
      const lines = new LineSplitter()
      let settled = false
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        if (active === session) active = null
        if (result) resolve(result)
        else reject(error)
      }
      const onAbort = () => finish(new Error('取数回传已取消'))
      const timer = setTimeout(() => finish(new Error(secret
        ? '内容已回传，未收到设备的明确结果'
        : '等待设备输出超时')), timeoutMs)
      const session = {
        lines,
        cancel: onAbort,
        visit(line, receivedAt) {
          try {
            const value = match(line)
            if (!value) return false
            finish(undefined, { value, receivedAt })
          } catch (error) { finish(error) }
          return true
        }
      }
      active = session
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      lease.write(text, { secret }).catch(() => finish(new Error(secret
        ? '回传内容写入异常，设备结果未确认'
        : '发送设备动作命令失败')))
    })
  }

  function waitVerdict(lease, input) {
    return new Promise((resolve, reject) => {
      assertLive()
      const lines = new LineSplitter()
      let settled = false
      let decision
      const finish = (verdict) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (decision) clearTimeout(decision)
        ctx.signal.removeEventListener('abort', onAbort)
        if (active === session) active = null
        if (verdict instanceof Error) reject(verdict)
        else resolve(verdict)
      }
      const onAbort = () => finish(new Error('取数回传已取消'))
      const timer = setTimeout(() => finish('accepted'), input.timeoutMs)
      const session = {
        lines,
        cancel: onAbort,
        visit(line) {
          if (input.isReject(line)) { finish('rejected'); return true }
          if (!decision) decision = setTimeout(() => finish('accepted'), input.decisionDelayMs)
          return false
        }
      }
      active = session
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      lease.write(input.reply, { secret: true }).catch(() => finish(new Error('回传内容写入异常，设备结果未确认')))
    })
  }

  async function runAction(rule, options) {
    if (busy) throw new Error('该串口有取数回传正在运行')
    busy = true
    let lease
    let held = false
    let responseSent = false
    let ok = false
    try {
      assertLive()
      setStage('checking', rule)
      if (options.source === 'auto' && rule.holdInput) {
        try {
          await ctx.stream.hold(rule.holdInput)
          held = true
        } catch (error) {
          throw new Error('无法扣住串口输入：' + errorText(error))
        }
      }
      if (options.source === 'auto') lease = await ctx.stream.acquire()
      if (usesHttp) await authenticate(rule, () => setStage('input', rule))
      if (!options.input) {
        assertLive()
        lease = await ctx.stream.acquire()
      }
      const currentLease = lease
      let input = options.input
      if (!input) {
        if (!rule.command) throw new Error('取数回传规则缺少起始命令')
        setStage('input', rule)
        input = await nextLine(currentLease, rule.command + newlineOf(rule), false,
          rule.inputTimeoutMs, (line) => matchLine(rule.match, line, rule.triggerWords))
      }
      assertLive()
      const value = await obtainReply(input.value, input.receivedAt, rule)
      assertLive()
      setStage('send', rule)
      const rendered = renderTemplate(rule.template, value)
      if (!rendered || rendered.length > 65_536 || /[\x00-\x1f\x7f]/.test(rendered)) {
        throw new Error('回传内容模板生成了无效内容')
      }
      const reply = rendered + newlineOf(rule)
      const result = rule.result
      if (result.type === 'none') {
        responseSent = true
        await currentLease.write(reply, { secret: true })
      } else if (result.type === 'line') {
        responseSent = true
        const received = await nextLine(currentLease, reply, true, rule.resultTimeoutMs,
          (line) => matchResultLine(result, line))
        if (received.value === 'rejected') throw new Error('设备明确拒绝了回传内容')
      } else {
        responseSent = true
        const verdict = await waitVerdict(currentLease, {
          reply,
          timeoutMs: result.silenceMs,
          decisionDelayMs: result.decisionDelayMs,
          isReject: (line) => isPromptLine(line, result.promptText)
        })
        if (verdict === 'rejected') throw new Error('设备重新索要输入，判定为拒绝')
      }
      assertLive()
      ok = true
      return { ok: true }
    } catch (error) {
      if (responseSent && ctx.signal.aborted) throw new Error('内容已回传，设备结果未确认')
      throw error
    } finally {
      if (held) {
        try { await ctx.stream.releaseHold(ok) } catch { /* stopping */ }
      }
      if (lease) {
        try { await lease.release() } catch { /* stopping */ }
      }
      busy = false
    }
  }

  function startAuto(rule, input, receivedAt) {
    if (closed || busy) return
    const running = runAction(rule, {
      source: 'auto',
      input: { value: input, receivedAt }
    })
    void running.then(() => {
      if (closed) return
      ctx.state({ running: false, ok: true })
      ctx.log('info', '自动取数回传成功：' + rule.label)
    }, (error) => {
      if (closed) return
      ctx.state({ running: false, ok: false, error: errorText(error) })
      ctx.log('warn', '自动取数回传失败：' + errorText(error))
    })
  }

  function onWatchLine(line) {
    if (closed || busy) return false
    for (const rule of autoRules) {
      if (rule.holdInput && isTriggerWord(line, rule.triggerWords)) {
        // 设备即将索要输入：先扣住用户输入，等内容到达后再发起自动回传。
        void ctx.stream.hold(rule.holdInput).catch(() => {})
      }
    }
    for (const rule of autoRules) {
      let input
      try { input = matchLine(rule.match, line, rule.triggerWords) } catch { continue }
      if (!input) continue
      startAuto(rule, input, Date.now())
      return true
    }
    return false
  }

  if (autoWatching) {
    // 只有手动规则时不要拒绝启动：手动动作仍可用，仅提示自动监听不会生效。
    if (!autoRules.length) ctx.log('warn', '配置没有自动规则，自动监听不会生效')
    else watchLines = new LineSplitter()
  }

  const unsubscribe = ctx.stream.subscribe((event) => {
    if (closed) return
    const text = typeof event.text === 'string' ? event.text : ''
    if (!text) return
    if (active) {
      active.lines.push(text, event.receivedAt, active.visit)
      return
    }
    if (watchLines) watchLines.push(text, event.receivedAt, onWatchLine)
  })

  const stop = () => {
    if (closed) return
    closed = true
    unsubscribe()
    if (active) active.cancel()
    try { void ctx.stream.releaseHold(false).catch(() => {}) } catch { /* stopping */ }
  }
  ctx.signal.addEventListener('abort', stop, { once: true })
  if (ctx.signal.aborted) stop()

  return {
    async run(actionId, args) {
      assertLive()
      if (actionId === 'reset') {
        if (active) active.cancel()
        if (watchLines) watchLines.reset()
        try { await ctx.stream.releaseHold(false) } catch { /* not holding */ }
        return { ok: true }
      }
      if (actionId !== 'run') throw new Error('未知取数回传插件动作')
      const requested = args && typeof args === 'object' ? args.ruleId : undefined
      if (requested !== undefined && (typeof requested !== 'string' || !requested)) throw new Error('ruleId 无效')
      const ruleId = requested === undefined
        ? (snapshot.defaultRuleId
          ?? (snapshot.rules.find((rule) => rule.trigger === 'manual') || {}).id)
        : requested
      const rule = snapshot.rules.find((candidate) => candidate.id === ruleId)
      if (!rule || rule.trigger === 'auto') throw new Error('请选择配置中的手动取数回传规则')
      return await runAction(rule, { source: 'manual' })
    },
    async dispose() {
      stop()
      ctx.signal.removeEventListener('abort', stop)
    }
  }
}

exports.__test = {
  parseConfiguration,
  matchLine,
  matchResultLine,
  isPromptLine,
  isTriggerWord,
  isReplyValue,
  renderTemplate,
  foldLine,
  LineSplitter
}
