'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { discover, validateSlug, loadPlugin, readText, directory, portablePath, writeCatalog } = require('./lib/repository.cjs')
function createPlugin(root, slug, id, name = slug) {
  validateSlug(slug)
  if (typeof id !== 'string' || !id) throw new Error('--id 必填，例如 devkit.my-device')
  const existing = discover(root)
  if (existing.some((p) => p.manifest.id === id)) throw new Error('插件 ID 已存在: ' + id)
  const target = path.join(root, 'plugins', slug)
  if (fs.existsSync(target)) throw new Error('插件目录已存在，拒绝覆盖: ' + slug)
  const template = path.join(root, 'templates', 'serial-plugin')
  directory(template)
  const stage = path.join(root, '.devkit-scaffold-' + randomUUID())
  const substitutions = { __PLUGIN_ID__: id, __PLUGIN_NAME__: name, __PLUGIN_SLUG__: slug }
  function copy(from, to) {
    directory(from)
    fs.mkdirSync(to)
    for (const item of fs.readdirSync(from, { withFileTypes: true })) {
      portablePath(item.name)
      const src = path.join(from, item.name)
      const dst = path.join(to, item.name)
      if (item.isSymbolicLink()) throw new Error('模板不允许符号链接')
      if (item.isDirectory()) copy(src, dst)
      else {
        let text = readText(src)
        for (const [key, value] of Object.entries(substitutions)) {
          // JSON string placeholders must stay valid even for quoted display names.
          const replacement = item.name === 'manifest.json' ? JSON.stringify(value).slice(1, -1) : value
          text = text.split(key).join(replacement)
        }
        fs.writeFileSync(dst, text)
      }
    }
  }
  try {
    copy(template, stage)
    loadPlugin(root, slug, stage)
    fs.renameSync(stage, target)
    writeCatalog(root)
    return target
  } finally { fs.rmSync(stage, { recursive: true, force: true }) }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    const slug = args.shift()
    const options = {}
    while (args.length) {
      const option = args.shift()
      if (!['--id','--name'].includes(option) || !args.length || options[option] !== undefined) throw new Error('Usage: npm run new -- <slug> --id <namespace.id> [--name <name>]')
      options[option] = args.shift()
    }
    console.log(createPlugin(path.resolve(__dirname, '..'), slug, options['--id'], options['--name'] ?? slug))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { createPlugin }
