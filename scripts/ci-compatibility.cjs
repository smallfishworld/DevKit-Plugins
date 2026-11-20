'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { discover } = require('./lib/repository.cjs')
const { readCompatibility } = require('./lib/compatibility.cjs')
try {
  const root = path.resolve(__dirname, '..')
  const config = readCompatibility(root, discover(root))
  const output = 'repository=' + config.hostRepository + '\ncommit=' + config.hostCommit + '\n'
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output)
  else process.stdout.write(output)
} catch (error) { console.error(error.message); process.exitCode = 1 }
