'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { buildSync } = require('esbuild')
const { discover, verifyCatalog, packPlugin } = require('./lib/repository.cjs')
async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: npm run check:host -- <path-to-DevKit>')
  const root = path.resolve(__dirname, '..')
  const host = path.resolve(process.argv[2])
  const storeSource = path.join(host, 'src/main/services/plugins/store.ts')
  const schemaSource = path.join(host, 'src/main/services/plugins/schema.ts')
  if (!fs.existsSync(storeSource) || !fs.existsSync(schemaSource)) throw new Error('目标 DevKit checkout 不包含 API v1 插件宿主')
  const plugins = discover(root)
  verifyCatalog(root, plugins)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-plugins-host-'))
  try {
    const output = path.join(temp, 'host-contract.cjs')
    buildSync({
      stdin: { contents: 'export { PluginStore, parseManifest } from ' + JSON.stringify(storeSource) +
        '; export { applyDefaults, validateConfig } from ' + JSON.stringify(schemaSource) + ';',
        resolveDir: host, loader: 'ts' },
      outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error'
    })
    const { PluginStore, parseManifest, applyDefaults, validateConfig } = require(output)
    for (const plugin of plugins) {
      const manifest = parseManifest(plugin.manifest)
      const bundlePath = packPlugin(root, plugin)
      const directoryPath = path.join(root, plugin.relativeDir, 'package')
      let jsonInstall
      for (const [kind, source] of [['directory', directoryPath], ['json', bundlePath]]) {
        const store = new PluginStore(path.join(temp, plugin.slug + '-' + kind))
        const installed = await store.install(source, new Set(['devkit.oa-debug']))
        assert.equal(installed.id, manifest.id)
        assert.equal(installed.version, manifest.version)
        assert.equal(installed.entry, manifest.entry)
        assert.deepEqual((await store.listInstalled()).map((p) => p.id), [manifest.id])
        for (const [name, content] of Object.entries(plugin.files)) {
          assert.equal(fs.readFileSync(path.join(installed.path, ...name.split('/')), 'utf8'), content)
        }
        const installedManifest = JSON.parse(fs.readFileSync(path.join(installed.path, 'manifest.json'), 'utf8'))
        assert.deepEqual(parseManifest(installedManifest), manifest)
        if (kind === 'json') jsonInstall = installed
      }
      // The first plugin has complete defaults and fixed, hardware-free vectors.
      // Other plugins supply their protocol vectors in their own test/ directory.
      if (manifest.id === 'devkit.text-hex-responder') {
        const config = applyDefaults({}, manifest.configSchema)
        validateConfig(config, manifest.configSchema)
        const module = await import(pathToFileURL(path.join(jsonInstall.path, manifest.entry)).href)
        const activate = module.activate ?? module.default?.activate
        assert.equal(typeof activate, 'function')
        const writes = []
        const context = (values) => ({
          config: values, autoEnabled: true, signal: new AbortController().signal,
          session: { panelId: 'compat', connectionId: 'fixture', path: 'MOCK', encoding: 'utf8' },
          log() {}, state() {},
          serial: { async write(data) { writes.push(data); return { ok: true } } }
        })
        const textPlugin = await activate(context(config))
        await textPlugin.onData({ bytes: [80,73], text: 'PI' })
        assert.equal(writes.length, 0)
        await textPlugin.onData({ bytes: [78,71,13,10,80,73,78,71,10], text: 'NG\r\nPING\n' })
        assert.deepEqual(writes, ['PONG\r\n','PONG\r\n'])
        assert.equal((await textPlugin.run('send')).ok, true)
        await textPlugin.dispose()
        const before = writes.length
        await textPlugin.onData({ bytes: [80,73,78,71,10], text: 'PING\n' })
        assert.equal(writes.length, before)
        const hex = await activate(context({ ...config, mode: 'hex', match: 'AA 55', response: '00 FF' }))
        await hex.onData({ bytes: [170], text: '' })
        await hex.onData({ bytes: [85], text: '' })
        assert.deepEqual(writes.at(-1), [0,255])
        await hex.dispose()
      }
      console.log('PASS real DevKit host: ' + plugin.slug + ' (manifest/schema, directory + JSON installation, entry and file identity)')
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
