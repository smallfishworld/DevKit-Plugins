'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { discover, verifyCatalog, packPlugin } = require('./lib/repository.cjs')

const root = path.resolve(__dirname, '..')
const host = path.resolve(process.argv[2] || '.devkit-host')
if (!fs.existsSync(path.join(host, 'out/main/plugin-host.js'))) {
  throw new Error('Build the pinned DevKit host before running Electron E2E')
}
const plugins = discover(root)
verifyCatalog(root, plugins)
const isWindows = process.platform === 'win32'
const npm = isWindows ? 'npm.cmd' : 'npm'

for (const plugin of plugins) {
  const packagePath = packPlugin(root, plugin)
  const payload = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  assert.equal(payload.manifest.id, plugin.manifest.id)
  assert.equal(payload.manifest.version, plugin.manifest.version)
  assert.equal(payload.manifest.apiVersion, 2)
  const result = spawnSync(npm, ['run', 'test:plugins-smoke'], {
    cwd: host,
    stdio: 'inherit',
    timeout: 180000,
    shell: isWindows,
    env: { ...process.env, DEVKIT_PLUGIN_PACKAGE: packagePath }
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error('Electron E2E terminated: ' + result.signal)
  if (result.status !== 0) throw new Error(`Electron E2E failed for ${plugin.slug}: ${result.status}`)
  console.log(`PASS Electron utilityProcess E2E: ${plugin.slug}@${plugin.manifest.version}`)
}
