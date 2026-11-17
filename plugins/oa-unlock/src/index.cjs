'use strict'

// OA 设备解锁（DevKit 外部插件）
// 串口由 DevKit 宿主持有：本插件只通过 ctx.serial / ctx.auth 声明能力，
// 不导入 DevKit、serialport 或 Electron。Cookie 留在宿主 Chromium 分区，
// 口令只经 secret 写入，绝不进入日志、状态或错误文本。
//
// 兼容旧内置实例：插件 ID 保持 devkit.oa-debug，配置仍为
// { deviceActions, profileId, auto }；DevKit 只在安装本插件后迁移旧配置。

const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/
const FIELD_PATH = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,3}$/
const DEVICE_TOKEN = /^[A-Za-z0-9._~+/=\-]{4,4096}$/
const MAX_RESPONSE_BYTES = 65_536

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应为 JSON 对象')
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
function isDeviceToken(value) {
  return typeof value === 'string' && DEVICE_TOKEN.test(value)
}

function parseDetect(value) {
  const d = record(value)
  if (d.type === 'prefix') return { type: 'prefix', prefix: field(d.prefix, 'detect.prefix') }
  if (d.type === 'base64-line') {
    const shortMin = integer(d.shortMin, 'detect.shortMin', 8, 256, 20)
    const shortMax = integer(d.shortMax, 'detect.shortMax', shortMin, 512, 21)
    const longMin = integer(d.longMin, 'detect.longMin', shortMax, 8192, 300)
    return {
      type: 'base64-line', shortMin, shortMax, longMin,
      longMinDecoded: integer(d.longMinDecoded, 'detect.longMinDecoded', 16, 8192, 260)
    }
  }
  throw new Error('detect.type 须为 prefix 或 base64-line')
}

function parseResult(value) {
  const r = record(value)
  if (r.type === 'line') {
    const successLine = field(r.successLine, 'result.successLine')
    const failureLine = field(r.failureLine, 'result.failureLine')
    if (successLine === failureLine) throw new Error('成功与失败提示不能相同')
    return { type: 'line', successLine, failureLine }
  }
  if (r.type === 'prompt-repeat') {
    return {
      type: 'prompt-repeat',
      promptText: field(r.promptText === undefined ? 'Password:' : r.promptText, 'result.promptText'),
      decisionDelayMs: integer(r.decisionDelayMs, 'result.decisionDelayMs', 0, 2000, 150),
      silenceMs: integer(r.silenceMs, 'result.silenceMs', 100, 30_000, 3000)
    }
  }
  throw new Error('result.type 须为 line 或 prompt-repeat')
}

function parseHold(value, trigger) {
  if (value === undefined) return trigger === 'auto' ? { maxBytes: 4096, maxMs: 15_000 } : false
  if (value === false) return false
  if (value === true) return { maxBytes: 4096, maxMs: 15_000 }
  const h = record(value)
  return {
    maxBytes: integer(h.maxBytes, 'holdInput.maxBytes', 256, 1_048_576, 4096),
    maxMs: integer(h.maxMs, 'holdInput.maxMs', 1000, 300_000, 15_000)
  }
}

function parseAuthCheck(value) {
  const a = record(value)
  if (a.type === 'json') {
    return { type: 'json', url: urlField(a.url, 'authCheck.url').href, field: fieldPath(a.field === undefined ? 'authenticated' : a.field, 'authCheck.field') }
  }
  if (a.type === 'http-ok') return { type: 'http-ok', url: urlField(a.url, 'authCheck.url').href }
  throw new Error('authCheck.type 须为 json 或 http-ok')
}

function parseIssue(value) {
  const i = record(value)
  const bodyValue = i.body === undefined ? { challenge: '$challenge' } : record(i.body)
  const body = {}
  for (const [rawKey, rawValue] of Object.entries(bodyValue)) {
    const name = key(rawKey, 'issue.body 键名')
    if (typeof rawValue !== 'string' || rawValue.length > 512 || /[\x00-\x1f\x7f]/.test(rawValue)) {
      throw new Error('issue.body 值须为不含控制字符的字符串')
    }
    body[name] = rawValue
  }
  if (!Object.keys(body).length) throw new Error('issue.body 不能为空')
  if (!Object.values(body).some((text) => text.includes('$challenge'))) {
    throw new Error('issue.body 必须包含 $challenge 占位符')
  }
  const responsePath = i.responsePath === undefined ? 'response' : fieldPath(i.responsePath, 'issue.responsePath')
  const expiredHttp = i.loginExpiredHttp === undefined ? [401, 403] : i.loginExpiredHttp
  if (!Array.isArray(expiredHttp) || expiredHttp.length > 8 ||
    expiredHttp.some((code) => typeof code !== 'number' || !Number.isInteger(code) || code < 100 || code > 599)) {
    throw new Error('issue.loginExpiredHttp 须为最多 8 个 HTTP 状态码')
  }
  const expiredCodes = i.loginExpiredCodes === undefined ? [] : i.loginExpiredCodes
  if (!Array.isArray(expiredCodes) || expiredCodes.length > 16 ||
    expiredCodes.some((code) => typeof code !== 'string' || !code || code.length > 64 || /[\x00-\x1f\x7f]/.test(code))) {
    throw new Error('issue.loginExpiredCodes 须为最多 16 个短字符串')
  }
  return {
    url: urlField(i.url, 'issue.url').href,
    body,
    responsePath,
    loginExpiredHttp: [...new Set(expiredHttp)].sort((a, b) => a - b),
    loginExpiredCodes: [...new Set(expiredCodes)],
    retryLoginOnce: boolean(i.retryLoginOnce, 'issue.retryLoginOnce', true),
    userAgent: optionalField(i.userAgent, 'issue.userAgent', 512)
  }
}

function parseTriggerWords(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw new Error('triggerWords 须为最多 16 个字符串')
  return [...new Set(value.map((entry) => field(entry, 'triggerWords', 64)))]
}

function parseConfiguration(value) {
  const cfg = record(value)
  const login = urlField(cfg.loginUrl, 'loginUrl')
  const authCheck = parseAuthCheck(cfg.authCheck)
  const issue = parseIssue(cfg.issue)
  if (new URL(authCheck.url).origin !== login.origin || new URL(issue.url).origin !== login.origin) {
    throw new Error('业务接口必须与登录入口同源')
  }
  if (cfg.authOrigins !== undefined && (!Array.isArray(cfg.authOrigins) || cfg.authOrigins.length > 16)) {
    throw new Error('authOrigins 须为最多 16 个来源的数组')
  }
  const authOrigins = (cfg.authOrigins === undefined ? [] : cfg.authOrigins).map((entry) => originField(entry, 'authOrigins'))
  if (!Array.isArray(cfg.profiles) || !cfg.profiles.length || cfg.profiles.length > 32) {
    throw new Error('profiles 须包含 1 至 32 个设备动作配置')
  }
  const ids = new Set()
  const profiles = cfg.profiles.map((entry) => {
    const p = record(entry)
    const id = field(p.id, '设备动作 ID', 64)
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || ids.has(id)) throw new Error('设备动作 ID 无效或重复')
    ids.add(id)
    const kind = p.kind === undefined ? 'challenge-response' : p.kind
    if (kind !== 'challenge-response') throw new Error('不支持的设备动作类型：' + String(kind))
    const trigger = p.trigger === undefined ? 'manual' : p.trigger
    if (trigger !== 'manual' && trigger !== 'auto') throw new Error('trigger 须为 manual 或 auto')
    const newline = p.newline === undefined ? 'cr' : p.newline
    if (newline !== 'cr' && newline !== 'lf' && newline !== 'crlf') throw new Error('newline 须为 cr、lf 或 crlf')
    const command = optionalField(p.command, 'command')
    if (trigger === 'manual' && !command) throw new Error('manual 设备动作必须配置 command')
    if (p.detect === undefined) throw new Error('设备动作缺少 detect')
    if (p.result === undefined) throw new Error('设备动作缺少 result')
    return {
      id,
      label: field(p.label === undefined ? id : p.label, '设备动作名称'),
      actionLabel: field(p.actionLabel === undefined ? '设备动作' : p.actionLabel, 'actionLabel'),
      kind,
      trigger,
      triggerWords: parseTriggerWords(p.triggerWords),
      detect: parseDetect(p.detect),
      result: parseResult(p.result),
      command,
      newline,
      challengeTimeoutMs: integer(p.challengeTimeoutMs, 'challengeTimeoutMs', 100, 300_000, 5000),
      challengeTtlMs: integer(p.challengeTtlMs, 'challengeTtlMs', 100, 300_000, 30_000),
      resultTimeoutMs: integer(p.resultTimeoutMs, 'resultTimeoutMs', 100, 300_000, 5000),
      holdInput: parseHold(p.holdInput, trigger)
    }
  })
  return {
    loginUrl: login.href,
    authOrigins: [...new Set(authOrigins)].sort(),
    authCheck,
    issue,
    profiles
  }
}

/** 行首前缀或 base64 形状的设备挑战码。prefix 命中但码非法时明确报错。 */
function matchChallengeLine(detect, line) {
  if (detect.type === 'prefix') {
    if (!line.startsWith(detect.prefix)) return undefined
    const value = line.slice(detect.prefix.length).trim()
    if (!isDeviceToken(value)) throw new Error('设备返回的挑战码格式不匹配')
    return value
  }
  const value = line.trim()
  if (!BASE64_LINE.test(value)) return undefined
  if (value.length >= detect.shortMin && value.length <= detect.shortMax && value.endsWith('=')) return value
  if (value.length >= detect.longMin && value.length <= 4096 &&
    Buffer.from(value, 'base64').length >= detect.longMinDecoded) return value
  return undefined
}

function matchResultLine(result, line) {
  if (line === result.successLine) return 'unlocked'
  if (line === result.failureLine) return 'rejected'
  return undefined
}

function isPromptLine(line, promptText) {
  return line.trim().startsWith(promptText)
}

function isTriggerWord(line, words) {
  if (!words.length) return false
  return words.includes(line.trim().replace(/^[#>$%]\s*/, ''))
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
}

/** 跨 USB 回调/终端批次拼完整行，避免分包拆散挑战码或结果行。 */
class LineSplitter {
  constructor() {
    this.partial = ''
    this.oversize = false
  }
  push(text, receivedAt, visit) {
    const segments = text.split(/[\r\n]/)
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]
      if (this.partial.length + segment.length > 4096) {
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
  constructor(message = '取码时登录已失效，请确认设备状态后重新发起') {
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

/** 取码失败只描述结构（字段名/长度），绝不把可能的口令写进诊断。 */
function describeIssueFailure(value) {
  const top = Object.keys(value).slice(0, 8).join(',') || '-'
  const data = value.data
  const shape = data === undefined ? '无'
    : data === null ? 'null'
      : typeof data === 'string' ? 'string(' + data.length + ')'
        : Array.isArray(data) ? 'array(' + data.length + ')'
          : typeof data === 'object' ? 'object{' + (Object.keys(data).slice(0, 8).join(',') || '-') + '}'
            : typeof data
  const code = String(value.code === undefined ? '' : value.code).slice(0, 64)
  return '取码接口未返回有效口令（code=' + (code || '-') + '，data=' + shape + '，顶层=' + top + '）'
}

function newlineOf(profile) {
  return profile.newline === 'crlf' ? '\r\n' : profile.newline === 'lf' ? '\n' : '\r'
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

exports.activate = async function activate(ctx) {
  const raw = ctx.config && typeof ctx.config === 'object' ? ctx.config : {}
  const snapshot = parseConfiguration(raw.deviceActions === undefined ? raw : raw.deviceActions)
  if (typeof raw.profileId === 'string' && raw.profileId) {
    snapshot.profiles = snapshot.profiles.filter((profile) => profile.id === raw.profileId)
    if (!snapshot.profiles.length) throw new Error('找不到实例选择的设备动作配置')
  }
  if (typeof ctx.auth?.login !== 'function' || typeof ctx.auth?.request !== 'function') {
    throw new Error('宿主未提供 auth.session 能力')
  }

  let closed = false
  let busy = false
  let active = null
  let watchLines = null
  const autoProfiles = snapshot.profiles.filter((profile) => profile.trigger === 'auto')
  const autoWatching = Boolean(ctx.autoEnabled) && raw.auto !== false

  function assertLive() {
    if (closed) throw new Error('插件已停止')
  }
  function setStage(stage, profile) {
    ctx.state({ running: true, stage, profileId: profile.id })
  }
  async function authenticate(profile, stage) {
    let loginTimer
    const pending = ctx.auth.login({
      loginUrl: snapshot.loginUrl,
      authOrigins: snapshot.authOrigins,
      check: snapshot.authCheck,
      title: 'DevKit · OA 登录',
      timeoutMs: 180_000
    })
    loginTimer = setTimeout(() => { if (!closed) setStage('login', profile) }, 300)
    try {
      await pending
    } finally {
      clearTimeout(loginTimer)
    }
    assertLive()
    stage()
  }
  async function issue(challenge, remainingMs) {
    const body = JSON.stringify(Object.fromEntries(
      Object.entries(snapshot.issue.body).map(([name, template]) => [name, template.split('$challenge').join(challenge)])
    ))
    const headers = { Accept: 'application/json' }
    if (snapshot.issue.userAgent) headers['User-Agent'] = snapshot.issue.userAgent
    let response
    try {
      response = await ctx.auth.request({
        loginUrl: snapshot.loginUrl,
        authOrigins: snapshot.authOrigins,
        url: snapshot.issue.url,
        method: 'POST',
        headers,
        body,
        timeoutMs: Math.max(1000, Math.min(8000, remainingMs))
      })
    } catch (error) {
      assertLive()
      throw new Error('内网接口请求失败或超时（' + errorText(error) + '），请检查公司网络')
    }
    if (snapshot.issue.loginExpiredHttp.includes(response.status)) throw new LoginExpiredError()
    if (response.status < 200 || response.status >= 300) {
      throw new Error('取码接口拒绝请求（HTTP ' + response.status + '）')
    }
    let value
    try { value = JSON.parse(response.text) } catch { throw new Error('内网接口没有返回预期的 JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内网接口没有返回预期的 JSON')
    const object = value
    if (snapshot.issue.loginExpiredCodes.includes(String(object.code === undefined ? '' : object.code))) {
      throw new LoginExpiredError()
    }
    let code = readPath(object, snapshot.issue.responsePath)
    // 与 AutoPSH 一致：口令可能包在 data.data，也可能直接是 data。
    // 仅当配置路径没命中、且其父级本身就是字符串时才回退，避免误取包装对象。
    const separator = snapshot.issue.responsePath.lastIndexOf('.')
    if (code === undefined && separator > 0) {
      const parent = readPath(object, snapshot.issue.responsePath.slice(0, separator))
      if (typeof parent === 'string') code = parent
    }
    if (object.ok === false || !isDeviceToken(code)) throw new Error(describeIssueFailure(object))
    return code
  }

  function nextLine(lease, text, secret, timeoutMs, match) {
    return new Promise((resolve, reject) => {
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
      const onAbort = () => finish(new Error('设备动作已取消'))
      const timer = setTimeout(() => finish(new Error(secret
        ? '口令已发送，未收到设备的明确结果'
        : '等待设备挑战码超时')), timeoutMs)
      const session = {
        lines,
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
        ? '口令写入异常，设备结果未确认'
        : '发送设备动作命令失败')))
    })
  }

  function waitVerdict(lease, input) {
    return new Promise((resolve, reject) => {
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
      const onAbort = () => finish(new Error('设备动作已取消'))
      const timer = setTimeout(() => finish('accepted'), input.timeoutMs)
      const session = {
        lines,
        visit(line) {
          if (input.isReject(line)) { finish('rejected'); return true }
          if (!decision) decision = setTimeout(() => finish('accepted'), input.decisionDelayMs)
          return false
        }
      }
      active = session
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      lease.write(input.reply, { secret: true }).catch(() => finish(new Error('口令写入异常，设备结果未确认')))
    })
  }

  async function runAction(profile, options) {
    if (busy) throw new Error('该串口有设备动作正在运行')
    busy = true
    let lease
    let held = false
    let responseSent = false
    let ok = false
    try {
      assertLive()
      setStage('checking', profile)
      if (options.source === 'auto' && profile.holdInput) {
        try {
          await ctx.serial.hold(profile.holdInput)
          held = true
        } catch (error) {
          throw new Error('无法扣住串口输入：' + errorText(error))
        }
      }
      if (options.source === 'auto') lease = await ctx.serial.acquire()
      await authenticate(profile, () => setStage('challenge', profile))
      if (!options.challenge) {
        assertLive()
        lease = await ctx.serial.acquire()
      }
      const leaserLease = lease
      let challenge = options.challenge
      if (!challenge) {
        if (!profile.command) throw new Error('设备动作缺少起始命令')
        setStage('challenge', profile)
        challenge = await nextLine(leaserLease, profile.command + newlineOf(profile), false,
          profile.challengeTimeoutMs, (line) => matchChallengeLine(profile.detect, line))
      }
      assertLive()
      const remaining = profile.challengeTtlMs - (Date.now() - challenge.receivedAt)
      if (remaining <= 0) throw new Error('设备挑战码已过期')
      setStage('issue', profile)
      let response
      try {
        response = await issue(challenge.value, remaining)
      } catch (error) {
        assertLive()
        if (Date.now() - challenge.receivedAt >= profile.challengeTtlMs) throw new Error('设备挑战码已过期')
        if (!(error instanceof LoginExpiredError) || !snapshot.issue.retryLoginOnce) throw error
        await authenticate(profile, () => setStage('issue', profile))
        assertLive()
        const retryRemaining = profile.challengeTtlMs - (Date.now() - challenge.receivedAt)
        if (retryRemaining <= 0) throw new Error('设备挑战码已过期')
        response = await issue(challenge.value, retryRemaining)
      }
      assertLive()
      if (Date.now() - challenge.receivedAt >= profile.challengeTtlMs) throw new Error('设备挑战码已过期')
      setStage('verify', profile)
      const reply = response + newlineOf(profile)
      const result = profile.result
      if (result.type === 'line') {
        responseSent = true
        const received = await nextLine(leaserLease, reply, true, profile.resultTimeoutMs,
          (line) => matchResultLine(result, line))
        if (received.value === 'rejected') throw new Error('设备明确拒绝了口令')
      } else {
        responseSent = true
        const verdict = await waitVerdict(leaserLease, {
          reply,
          timeoutMs: result.silenceMs,
          decisionDelayMs: result.decisionDelayMs,
          isReject: (line) => isPromptLine(line, result.promptText)
        })
        if (verdict === 'rejected') throw new Error('设备重新索要口令，判定为拒绝')
      }
      assertLive()
      ok = true
      return { ok: true }
    } catch (error) {
      if (responseSent && ctx.signal.aborted) throw new Error('口令已发送，设备结果未确认')
      throw error
    } finally {
      if (held) {
        try { await ctx.serial.releaseHold(ok) } catch { /* stopping */ }
      }
      if (lease) {
        try { await lease.release() } catch { /* stopping */ }
      }
      busy = false
    }
  }

  function startAuto(profile, challenge, receivedAt) {
    if (closed || busy) return
    const running = runAction(profile, {
      source: 'auto',
      challenge: { value: challenge, receivedAt }
    })
    void running.then(() => {
      if (!closed) ctx.state({ running: false, ok: true })
    }, (error) => {
      if (closed) return
      ctx.state({ running: false, ok: false, error: errorText(error) })
      ctx.log('warn', '自动解锁失败：' + errorText(error))
    })
  }

  function onWatchLine(line) {
    if (closed || busy) return false
    for (const profile of autoProfiles) {
      if (profile.holdInput && isTriggerWord(line, profile.triggerWords)) {
        // 设备即将索要口令：先扣住用户输入，等挑战码到达后再发起自动解锁。
        void ctx.serial.hold(profile.holdInput).catch(() => {})
      }
    }
    for (const profile of autoProfiles) {
      let challenge
      try { challenge = matchChallengeLine(profile.detect, line) } catch { continue }
      if (!challenge) continue
      startAuto(profile, challenge, Date.now())
      return true
    }
    return false
  }

  if (autoWatching) {
    if (!autoProfiles.length) throw new Error('配置没有 trigger 为 auto 的设备动作')
    watchLines = new LineSplitter()
  }

  const unsubscribe = ctx.serial.subscribe((event) => {
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
    try { void ctx.serial.releaseHold(false) } catch { /* stopping */ }
  }
  ctx.signal.addEventListener('abort', stop, { once: true })
  if (ctx.signal.aborted) stop()

  return {
    async run(actionId, args) {
      assertLive()
      if (actionId !== 'run') throw new Error('未知 OA 插件动作')
      const requested = args && typeof args === 'object' ? args.profileId : undefined
      const profileId = requested === undefined
        ? (typeof raw.profileId === 'string' && raw.profileId ? raw.profileId
          : (snapshot.profiles.find((profile) => profile.trigger === 'manual') || {}).id)
        : requested
      const profile = snapshot.profiles.find((candidate) => candidate.id === profileId)
      if (!profile || profile.trigger === 'auto') throw new Error('请选择配置中的手动设备动作')
      return await runAction(profile, { source: 'manual' })
    },
    async dispose() {
      stop()
      ctx.signal.removeEventListener('abort', stop)
    }
  }
}

exports.__test = {
  parseConfiguration,
  matchChallengeLine,
  matchResultLine,
  isPromptLine,
  isTriggerWord,
  LineSplitter
}
