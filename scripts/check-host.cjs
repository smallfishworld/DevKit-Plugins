'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { buildSync } = require('esbuild')
const { discover, verifyCatalog, packPlugin } = require('./lib/repository.cjs')
const { readCompatibility } = require('./lib/compatibility.cjs')

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: npm run check:host -- <path-to-DevKit>')
  const root = path.resolve(__dirname, '..')
  const host = path.resolve(process.argv[2])
  const sdkEntry = path.join(host, 'packages/plugin-sdk/src/index.ts')
  if (!fs.existsSync(sdkEntry)) {
    throw new Error('目标 DevKit checkout 缺少 packages/plugin-sdk 契约包；请检查 compatibility.json 的 API v2 宿主提交')
  }
  const plugins = discover(root)
  verifyCatalog(root, plugins)
  readCompatibility(root, plugins)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-plugins-sdk-'))
  try {
    const sdkCopy = path.join(temp, 'sdk')
    fs.cpSync(path.join(host, 'packages/plugin-sdk'), sdkCopy, { recursive: true })
    const output = path.join(temp, 'plugin-sdk.cjs')
    buildSync({
      entryPoints: [path.join(sdkCopy, 'src/index.ts')], outfile: output,
      absWorkingDir: sdkCopy, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error'
    })
    const { parseManifest, applyDefaults, validateConfig, createMockPluginContext } = require(output)
    const installerOutput = path.join(temp, 'installer.cjs')
    buildSync({
      stdin: {
        contents: 'export { PluginStore } from ' + JSON.stringify(path.join(host, 'src/main/services/plugins/store.ts')) + ';',
        resolveDir: host, loader: 'ts'
      },
      outfile: installerOutput, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error'
    })
    const { PluginStore } = require(installerOutput)

    for (const plugin of plugins) {
      const manifest = parseManifest(plugin.manifest)
      const bundlePath = packPlugin(root, plugin)
      const directoryPath = path.join(root, plugin.relativeDir, 'package')
      let jsonInstall
      for (const [kind, source] of [['directory', directoryPath], ['json', bundlePath]]) {
        const store = new PluginStore(path.join(temp, plugin.slug + '-' + kind))
        const installed = await store.install(source, new Set())
        assert.equal(installed.id, manifest.id)
        assert.equal(installed.version, manifest.version)
        assert.equal(installed.entry, manifest.entry)
        assert.deepEqual((await store.listInstalled()).map((item) => item.id), [manifest.id])
        for (const [name, content] of Object.entries(plugin.files)) {
          assert.equal(fs.readFileSync(path.join(installed.path, ...name.split('/')), 'utf8'), content)
        }
        assert.deepEqual(parseManifest(JSON.parse(fs.readFileSync(path.join(installed.path, 'manifest.json'), 'utf8'))), manifest)
        if (kind === 'json') jsonInstall = installed
      }

      // Required enterprise settings come from a local test fixture, never from user data or a real OA server.
      const contractPath = path.join(plugin.source, 'test/host-contract.cjs')
      const contract = fs.existsSync(contractPath) ? require(contractPath) : {}
      const config = applyDefaults(contract.config ?? {}, manifest.configSchema)
      validateConfig(config, manifest.configSchema)
      const mod = await import(pathToFileURL(path.join(jsonInstall.path, manifest.entry)).href)
      const activate = mod.activate ?? mod.default?.activate
      assert.equal(typeof activate, 'function')

      // Every declared transport still uses the official SDK, in addition to both real installation paths.
      for (const transport of manifest.transports) {
        let harness
        const hooks = Object.fromEntries(['onWrite', 'onAuthLogin', 'onAuthRequest']
          .filter((name) => typeof contract[name] === 'function')
          .map((name) => [name, (...args) => contract[name](harness, ...args)]))
        harness = createMockPluginContext({
          ...hooks, config,
          session: { transport, target: transport + '-mock' },
          autoEnabled: contract.autoEnabled ?? manifest.autoRespond
        })
        const instance = await activate(harness.ctx)
        assert.equal(typeof instance, 'object')
        try {
          if (typeof contract.verify === 'function') {
            await contract.verify(instance, harness, { activate, createMockPluginContext })
          }
        } finally {
          if (typeof instance.dispose === 'function') await instance.dispose()
          harness.controller.abort()
        }
      }
      console.log('PASS real DevKit installer + @devkit/plugin-sdk contract: ' + plugin.slug + ' (' + manifest.transports.join(', ') + ')')
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
