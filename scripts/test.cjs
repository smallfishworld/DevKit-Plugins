'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { discover } = require('./lib/repository.cjs')
try {
  const root = path.resolve(__dirname, '..')
  const plugins = discover(root)
  const directories = [path.join(root, 'tests'), ...plugins.map((p) => path.join(p.source, 'test'))]
  const files = directories.flatMap((dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.test.cjs')).sort().map((name) => path.join(dir, name)))
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.signal) throw new Error('Tests terminated: ' + result.signal)
  process.exitCode = result.status ?? 1
} catch (error) { console.error(error.message); process.exitCode = 1 }
