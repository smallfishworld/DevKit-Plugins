'use strict'

/**
 * Device query plugin template (DevKit API v2).
 * The host owns the transport. Await every stream operation through ctx.stream.
 */
exports.activate = async function activate(ctx) {
  let disposed = false

  function ensureActive() {
    if (disposed) throw new Error('插件实例已停止')
    ctx.signal.throwIfAborted()
  }

  ensureActive()
  return {
    async run(actionId) {
      ensureActive()
      if (actionId !== 'query') throw new Error('未知动作：' + actionId)

      const command = String(ctx.config.command)
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
      const result = await ctx.stream.exchange(command, {
        match: String(ctx.config.expected),
        timeoutMs: Number(ctx.config.timeoutMs)
      })
      ensureActive()
      ctx.log('info', '收到响应，共 ' + result.bytes.length + ' 字节')
      return { ok: true, response: result.text }
    },

    async dispose() {
      disposed = true
    }
  }
}
