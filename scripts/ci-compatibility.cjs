'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { parseJson, readText } = require('./lib/repository.cjs')
try {
  const config = parseJson(readText(path.join(__dirname, '../compatibility.json')), 'compatibility.json')
  if (config.schemaVersion !== 1 || config.apiVersion !== 1 ||
      !/^[0-9a-f]{40}$/.test(config.hostCommit) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.hostRepository)) throw new Error('宿主兼容基线无效')
  const output = 'repository=' + config.hostRepository + '\ncommit=' + config.hostCommit + '\n'
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output)
  else process.stdout.write(output)
} catch (error) { console.error(error.message); process.exitCode = 1 }
