'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const MAX_BYTES = 4 * 1024 * 1024
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/
const ALLOWED_TRANSPORTS = ['serial', 'ssh', 'net', 'pty']
const ALLOWED_CAPABILITIES = ['stream.read', 'stream.write']
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
function fail(message) { throw new Error(message) }
function parseJson(text, label) {
  try {
    return JSON.parse(text, (key, value) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('保留字段名: ' + key)
      return value
    })
  } catch (error) { fail(label + ': ' + error.message) }
}
function plainFile(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('须为普通文件，不能是符号链接: ' + file)
  if (stat.size > MAX_BYTES) fail('单文件超过 4 MiB: ' + file)
  return stat
}
function readText(file) {
  plainFile(file)
  const bytes = fs.readFileSync(file)
  const text = bytes.toString('utf8')
  if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) fail('只接受无 NUL 的 UTF-8 文本: ' + file)
  return text
}
function directory(dir) {
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('须为真实目录，不能是符号链接: ' + dir)
}
function short(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f]/.test(value)) fail(label + ' 无效')
}
function portablePath(name) {
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\')) fail('路径不便于跨平台安装: ' + name)
  const parts = name.split('/')
  for (const part of parts) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part) || part.endsWith('.') ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
        ['node_modules', '__proto__', 'prototype', 'constructor'].includes(part)) fail('不支持的包路径: ' + name)
  }
  if (parts.length > 13) fail('包目录嵌套过深: ' + name)
  return name
}
function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length > 64 || !SLUG.test(slug)) fail('目录名须为小写 kebab-case')
  portablePath(slug)
  return slug
}

/** Optional esbuild pre-bundling for TypeScript or pure-JS local dependencies. */
function maybeBundleTsEntry(source, manifest) {
  const entryFs = path.join(source, ...manifest.entry.split('/'))
  const tsCandidate = path.join(source, 'src', 'index.ts')
  if (fs.existsSync(entryFs) || !fs.existsSync(tsCandidate)) return undefined
  plainFile(tsCandidate)
  const { buildSync } = require('esbuild')
  const result = buildSync({
    entryPoints: [tsCandidate],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'error'
  })
  const output = result.outputFiles && result.outputFiles[0]
  if (!output) fail('esbuild 预打包未生成输出: ' + tsCandidate)
  return output.text
}

// Repository constraints aligned with @devkit/plugin-sdk (API v2).
function validateManifest(m) {
  if (!record(m)) fail('manifest 须为对象')
  const allowed = new Set([
    'id', 'name', 'version', 'apiVersion', 'entry', 'description',
    'minHostVersion', 'transports', 'configSchema', 'actions', 'autoRespond', 'capabilities'
  ])
  for (const key of Object.keys(m)) if (!allowed.has(key)) fail('未知 manifest 字段: ' + key)
  short(m.id, 'id', 96)
  if (!ID.test(m.id)) fail('id 须有稳定命名空间，例如 devkit.device-tools')
  portablePath(m.id)
  short(m.name, 'name', 128)
  short(m.version, 'version', 64)
  if (!VERSION.test(m.version)) fail('version 须为宿主支持的 X.Y.Z 或预发布版本，不接受 +build')
  portablePath(m.version)
  if (m.apiVersion !== 2) fail('当前要求 apiVersion: 2')
  if (m.minHostVersion !== undefined) {
    short(m.minHostVersion, 'minHostVersion', 64)
    if (!VERSION.test(m.minHostVersion)) fail('minHostVersion 须为语义版本号')
  }
  if (!Array.isArray(m.transports) || !m.transports.length || m.transports.some((x) => !ALLOWED_TRANSPORTS.includes(x))) {
    fail('transports 须为非空数组，支持 serial/ssh/net/pty')
  }
  if (new Set(m.transports).size !== m.transports.length) fail('transports 不得重复')
  short(m.entry, 'entry', 200)
  portablePath(m.entry)
  if (!m.entry.startsWith('src/') || !['.cjs', '.js', '.mjs'].includes(path.posix.extname(m.entry))) {
    fail('entry 须为 src/ 下的已构建 JavaScript')
  }
  if (m.description !== undefined) short(m.description, 'description', 2048)
  if (!record(m.configSchema) || m.configSchema.type !== 'object') fail('configSchema 顶层须为 object')
  if (!Array.isArray(m.actions) || m.actions.length > 32) fail('actions 须为至多 32 项的数组')
  const ids = new Set()
  for (const action of m.actions) {
    if (!record(action)) fail('action 须为对象')
    short(action.id, 'action.id', 64)
    short(action.label, 'action.label', 128)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(action.id) || ids.has(action.id)) fail('action.id 无效或重复')
    if (action.description !== undefined) short(action.description, 'action.description', 1024)
    ids.add(action.id)
  }
  if (typeof m.autoRespond !== 'boolean') fail('autoRespond 须为 boolean')
  if (!Array.isArray(m.capabilities) || m.capabilities.some((x) => !ALLOWED_CAPABILITIES.includes(x))) {
    fail('capabilities 仅支持 stream.read/stream.write')
  }
  if (new Set(m.capabilities).size !== m.capabilities.length) fail('capabilities 不得重复')
  if (m.autoRespond && !m.capabilities.includes('stream.read')) fail('自动监听须声明 stream.read')
  return m
}

function loadPlugin(root, slug, source = path.join(root, 'plugins', slug)) {
  validateSlug(slug)
  directory(source)
  const manifest = validateManifest(parseJson(readText(path.join(source, 'manifest.json')), slug + '/manifest.json'))
  for (const name of ['README.md', 'CHANGELOG.md']) readText(path.join(source, name))
  directory(path.join(source, 'test'))
  if (!fs.readdirSync(path.join(source, 'test')).some((x) => x.endsWith('.test.cjs'))) fail(slug + ' 缺少 test/*.test.cjs')
  const files = Object.create(null)
  let directories = 0
  let total = Buffer.byteLength(JSON.stringify(manifest, null, 2))
  const bundled = maybeBundleTsEntry(source, manifest)
  if (bundled !== undefined) {
    total += Buffer.byteLength(bundled)
    if (total > MAX_BYTES) fail('包内容超过 4 MiB')
    files[manifest.entry] = bundled
  }
  function visit(dir, prefix) {
    directory(dir)
    if (++directories > 64) fail('包目录超过 64 个')
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = portablePath(prefix + '/' + item.name)
      const file = path.join(dir, item.name)
      if (item.isSymbolicLink()) fail('包不能包含符号链接: ' + name)
      if (item.isDirectory()) visit(file, name)
      else {
        if (bundled !== undefined && name.endsWith('.ts')) continue
        const text = readText(file)
        total += Buffer.byteLength(text)
        if (total > MAX_BYTES) fail('包内容超过 4 MiB')
        files[name] = text
      }
    }
  }
  visit(path.join(source, 'src'), 'src')
  if (fs.existsSync(path.join(source, 'assets'))) visit(path.join(source, 'assets'), 'assets')
  const license = fs.existsSync(path.join(source, 'LICENSE')) ? path.join(source, 'LICENSE') : path.join(root, 'LICENSE')
  files.LICENSE = readText(license)
  total += Buffer.byteLength(files.LICENSE)
  if (total > MAX_BYTES || Object.keys(files).length > 127) fail('包超过 4 MiB 或 127 个附带文件')
  if (!own(files, manifest.entry)) fail('入口未包含在运行文件中: ' + manifest.entry)
  const sorted = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]))
  const bundle = JSON.stringify({ manifest, files: sorted }, null, 2) + '\n'
  if (Buffer.byteLength(bundle) > MAX_BYTES) fail('转义后的 JSON 包超过 4 MiB')
  const relativeDir = ['dist', slug, manifest.version].join('/')
  return {
    slug, source, manifest, files: sorted, bundle,
    relativeDir, filename: manifest.id + '-' + manifest.version + '.devkit-plugin.json'
  }
}

function discover(root) {
  const dir = path.join(root, 'plugins')
  directory(dir)
  const plugins = []
  const ids = new Set()
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('plugins/ 下只能有插件目录: ' + entry.name)
    const plugin = loadPlugin(root, entry.name)
    if (ids.has(plugin.manifest.id)) fail('插件 ID 重复: ' + plugin.manifest.id)
    ids.add(plugin.manifest.id)
    plugins.push(plugin)
  }
  if (!plugins.length) fail('plugins/ 下至少需要一个插件')
  return plugins
}

function makeCatalog(plugins) {
  return JSON.stringify({
    schemaVersion: 2,
    apiVersion: 2,
    plugins: plugins.map((p) => ({
      slug: p.slug,
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      apiVersion: p.manifest.apiVersion,
      ...(p.manifest.minHostVersion ? { minHostVersion: p.manifest.minHostVersion } : {}),
      transports: p.manifest.transports,
      description: p.manifest.description ?? '',
      path: 'plugins/' + p.slug,
      readme: 'plugins/' + p.slug + '/README.md',
      packagePath: p.relativeDir + '/' + p.filename,
      installDirectory: p.relativeDir + '/package'
    }))
  }, null, 2) + '\n'
}

function writeCatalog(root) {
  const text = makeCatalog(discover(root))
  const target = path.join(root, 'catalog.json')
  try { plainFile(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temp = path.join(root, '.catalog-' + randomUUID() + '.tmp')
  try { fs.writeFileSync(temp, text, { flag: 'wx' }); fs.renameSync(temp, target) }
  finally { fs.rmSync(temp, { force: true }) }
  return text
}

function verifyCatalog(root, plugins) {
  if (readText(path.join(root, 'catalog.json')) !== makeCatalog(plugins)) fail('catalog.json 已过期；运行 npm run catalog')
}

function safeOutput(root, ...parts) {
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    if (fs.existsSync(current)) directory(current)
    else fs.mkdirSync(current)
  }
  return current
}

function packPlugin(root, plugin) {
  const parent = safeOutput(root, 'dist', plugin.slug)
  const destination = path.join(parent, plugin.manifest.version)
  if (fs.existsSync(destination)) directory(destination)
  const stage = path.join(parent, '.stage-' + randomUUID())
  const backup = path.join(parent, '.backup-' + randomUUID())
  fs.mkdirSync(stage)
  let backedUp = false
  try {
    const install = path.join(stage, 'package')
    fs.mkdirSync(install)
    fs.writeFileSync(path.join(install, 'manifest.json'), JSON.stringify(plugin.manifest, null, 2) + '\n')
    for (const [name, text] of Object.entries(plugin.files)) {
      const file = path.join(install, ...name.split('/'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
    fs.writeFileSync(path.join(stage, plugin.filename), plugin.bundle)
    const digest = createHash('sha256').update(plugin.bundle).digest('hex')
    fs.writeFileSync(path.join(stage, 'SHA256SUMS'), digest + '  ' + plugin.filename + '\n')
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); backedUp = true }
    fs.renameSync(stage, destination)
    if (backedUp) fs.rmSync(backup, { recursive: true })
    return path.join(destination, plugin.filename)
  } catch (error) {
    if (backedUp && !fs.existsSync(destination)) fs.renameSync(backup, destination)
    throw error
  } finally { fs.rmSync(stage, { recursive: true, force: true }) }
}

module.exports = {
  MAX_BYTES, parseJson, readText, directory, portablePath, validateSlug, validateManifest,
  loadPlugin, discover, makeCatalog, writeCatalog, verifyCatalog, packPlugin
}
