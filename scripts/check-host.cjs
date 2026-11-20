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
  const sdkEntry = path.join(host, 'packages/plugin-sdk/src/index.ts')
  if (!fs.existsSync(sdkEntry)) {
    throw new Error('目标 DevKit checkout 缺少 packages/plugin-sdk 契约包')
  }
  const plugins = discover(root)
  verifyCatalog(root, plugins)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-plugins-sdk-'))
  try {
    const sdkCopy = path.join(temp, 'sdk')
    fs.cpSync(path.join(host, 'packages/plugin-sdk'), sdkCopy, { recursive: true })
    const output = path.join(temp, 'plugin-sdk.cjs')
    buildSync({
      entryPoints: [path.join(sdkCopy, 'src/index.ts')],
      outfile: output,
      absWorkingDir: sdkCopy,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'error'
    })
    const {
      parseManifest,
      applyDefaults,
      validateConfig,
      createMockPluginContext
    } = require(output)

    for (const plugin of plugins) {
      const manifest = parseManifest(plugin.manifest)
      const bundlePath = packPlugin(root, plugin)
      const directoryPath = path.join(root, plugin.relativeDir, 'package')
      assert.equal(fs.existsSync(bundlePath), true)
      assert.equal(fs.existsSync(path.join(directoryPath, 'manifest.json')), true)

      const config = applyDefaults({}, manifest.configSchema)
      validateConfig(config, manifest.configSchema)

      const entryUrl = pathToFileURL(path.join(directoryPath, manifest.entry)).href
      const mod = await import(entryUrl)
      const activate = mod.activate ?? mod.default?.activate
      assert.equal(typeof activate, 'function')

      // Verify every plugin activates cleanly against the official SDK mock harness across all declared transports
      for (const transport of manifest.transports) {
        const harness = createMockPluginContext({
          config,
          session: { transport, target: `${transport}-mock` },
          autoEnabled: manifest.autoRespond
        })
        const instance = await activate(harness.ctx)
        assert.equal(typeof instance, 'object')
        if (manifest.id === 'devkit.text-hex-responder') {
          await instance.onData(harness.makeDataEvent('PI'))
          assert.equal(harness.writes.length, 0)
          await instance.onData(harness.makeDataEvent('NG\r\nPING\n'))
          assert.deepEqual(harness.writes.map((w) => w.data), ['PONG\r\n', 'PONG\r\n'])
          assert.equal((await instance.run('send')).ok, true)
        }
        if (typeof instance.dispose === 'function') await instance.dispose()
      }
      console.log(`PASS @devkit/plugin-sdk contract: ${plugin.slug} (${manifest.transports.join(', ')})`)
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
