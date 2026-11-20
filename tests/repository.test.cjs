'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const api = require('../scripts/lib/repository.cjs')
const { createPlugin } = require('../scripts/new.cjs')
const sourceRoot = path.resolve(__dirname, '..')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-plugins-repository-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT fixture license\n')
  fs.mkdirSync(path.join(root, 'plugins'))
  add(root, 'sample-device', 'example.sample-device')
  return root
}

function add(root, slug, id) {
  const dir = path.join(root, 'plugins', slug)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'test'))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: slug, version: '1.2.3', apiVersion: 2, minHostVersion: '0.1.10',
    transports: ['serial', 'ssh'], entry: 'src/index.cjs',
    configSchema: { type: 'object', properties: {} }, actions: [{ id: 'query', label: '查询' }],
    autoRespond: false, capabilities: ['stream.read', 'stream.write']
  }))
  fs.writeFileSync(path.join(dir, 'src/index.cjs'), 'exports.activate = async () => ({ run: async () => ({ok:true}) })\n')
  fs.writeFileSync(path.join(dir, 'README.md'), 'Usage\n')
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '1.2.3\n')
  fs.writeFileSync(path.join(dir, 'test/plugin.test.cjs'), 'require("node:test")("fixture", () => {})\n')
  return dir
}

function changeManifest(root, change) {
  const file = path.join(root, 'plugins/sample-device/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file))
  change(manifest)
  fs.writeFileSync(file, JSON.stringify(manifest))
}

test('discovery, stable identity and generated v2 catalog cover multiple independent plugins', (t) => {
  const root = fixture(t)
  add(root, 'another-device', 'example.another-device')
  fs.mkdirSync(path.join(root, 'templates'))
  const list = api.discover(root)
  assert.deepEqual(list.map((p) => p.slug), ['another-device', 'sample-device'])
  api.writeCatalog(root)
  api.verifyCatalog(root, list)
  const cat = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json')))
  assert.equal(cat.schemaVersion, 2)
  assert.equal(cat.apiVersion, 2)
  assert.equal(cat.plugins.length, 2)
  assert.deepEqual(cat.plugins[0].transports, ['serial', 'ssh'])
  changeManifest(root, (m) => { m.version = '1.2.4' })
  assert.throws(() => api.verifyCatalog(root, api.discover(root)), /过期/)
})

test('duplicate IDs fail before packaging', (t) => {
  const root = fixture(t)
  add(root, 'second-device', 'example.sample-device')
  assert.throws(() => api.discover(root), /ID 重复/)
})

test('package contains runtime files and license, excluding tests and documentation', (t) => {
  const root = fixture(t)
  const plugin = api.discover(root)[0]
  assert.deepEqual(Object.keys(plugin.files), ['LICENSE', 'src/index.cjs'])
  const first = api.packPlugin(root, plugin)
  const bytes = fs.readFileSync(first)
  const bundle = JSON.parse(bytes)
  assert.equal(bundle.manifest.entry, 'src/index.cjs')
  assert.equal(bundle.manifest.apiVersion, 2)
  assert.equal(bundle.files.LICENSE, 'MIT fixture license\n')
  assert.equal(Object.hasOwn(bundle.files, 'manifest.json'), false)
  const install = path.join(path.dirname(first), 'package')
  assert.equal(fs.readFileSync(path.join(install, 'src/index.cjs'), 'utf8'), bundle.files['src/index.cjs'])
  assert.equal(fs.existsSync(path.join(install, 'test')), false)
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(fs.readFileSync(path.join(path.dirname(first), 'SHA256SUMS'), 'utf8'), digest + '  ' + path.basename(first) + '\n')
})

test('optional esbuild pipeline bundles src/index.ts into self-contained src/index.cjs', (t) => {
  const root = fixture(t)
  const dir = path.join(root, 'plugins/ts-device')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'test'))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'example.ts-device', name: 'TS Device', version: '1.0.0', apiVersion: 2,
    transports: ['serial', 'net'], entry: 'src/index.cjs',
    configSchema: { type: 'object', properties: {} }, actions: [{ id: 'ping', label: 'Ping' }],
    autoRespond: false, capabilities: ['stream.write']
  }))
  fs.writeFileSync(path.join(dir, 'src/helper.ts'), 'export const tag: string = "TS-OK"\n')
  fs.writeFileSync(path.join(dir, 'src/index.ts'), 'import { tag } from "./helper"\nexport async function activate() { return { run: async () => ({ ok: true, tag }) } }\n')
  fs.writeFileSync(path.join(dir, 'README.md'), 'TS Plugin\n')
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '1.0.0\n')
  fs.writeFileSync(path.join(dir, 'test/plugin.test.cjs'), 'require("node:test")("ts", () => {})\n')
  const loaded = api.loadPlugin(root, 'ts-device')
  assert.equal(Object.hasOwn(loaded.files, 'src/index.cjs'), true)
  assert.equal(Object.hasOwn(loaded.files, 'src/index.ts'), false)
  assert.match(loaded.files['src/index.cjs'], /TS-OK/)
})

test('invalid API, empty transports, duplicate actions, absent entry and unsafe paths are rejected', (t) => {
  const root = fixture(t)
  changeManifest(root, (m) => { m.apiVersion = 1 })
  assert.throws(() => api.discover(root), /apiVersion/)
  changeManifest(root, (m) => { m.apiVersion = 2; m.transports = [] })
  assert.throws(() => api.discover(root), /transports/)
  changeManifest(root, (m) => { m.transports = ['serial']; m.actions.push(m.actions[0]) })
  assert.throws(() => api.discover(root), /action.id/)
  changeManifest(root, (m) => { m.actions.pop(); m.entry = 'src/missing.cjs' })
  assert.throws(() => api.discover(root), /入口/)
  changeManifest(root, (m) => { m.entry = '../outside.cjs' })
  assert.throws(() => api.discover(root), /路径/)
  for (const name of ['/absolute', 'a\\b', 'a//b', 'CON.txt', 'a/../b', 'a/file.']) {
    assert.throws(() => api.portablePath(name))
  }
  assert.throws(() => api.parseJson('{"__proto__":{}}', 'fixture'), /保留/)
})

test('runtime symbolic links and output directory links cannot escape the repository', (t) => {
  const root = fixture(t)
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-plugins-external-'))
  t.after(() => fs.rmSync(external, { recursive: true, force: true }))
  fs.writeFileSync(path.join(external, 'secret.cjs'), 'do not package')
  const link = path.join(root, 'plugins/sample-device/src/external')
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => api.discover(root), /符号链接/)
  fs.unlinkSync(link)
  const plugin = api.discover(root)[0]
  fs.symlinkSync(external, path.join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => api.packPlugin(root, plugin), /符号链接/)
  assert.deepEqual(fs.readdirSync(external), ['secret.cjs'])
})

test('binary runtime files are rejected rather than silently rewritten as UTF-8', (t) => {
  const root = fixture(t)
  const dir = path.join(root, 'plugins/sample-device/assets')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x41]))
  assert.throws(() => api.discover(root), /UTF-8/)
})

test('scaffold creates a second installable API v2 plugin without changing existing plugin versions', (t) => {
  const root = fixture(t)
  fs.cpSync(path.join(sourceRoot, 'templates'), path.join(root, 'templates'), { recursive: true })
  const created = createPlugin(root, 'new-query', 'example.new-query', '设备 "A"')
  const manifest = JSON.parse(fs.readFileSync(path.join(created, 'manifest.json')))
  assert.equal(manifest.id, 'example.new-query')
  assert.equal(manifest.apiVersion, 2)
  assert.deepEqual(manifest.transports, ['serial', 'ssh', 'net'])
  const all = api.discover(root)
  api.verifyCatalog(root, all)
  const result = spawnSync(process.execPath, ['--test', path.join(created, 'test/plugin.test.cjs')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
