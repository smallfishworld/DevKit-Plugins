'use strict'
const path = require('node:path')
const { discover, verifyCatalog } = require('./lib/repository.cjs')
try {
  const root = path.resolve(__dirname, '..')
  const plugins = discover(root)
  verifyCatalog(root, plugins)
  console.log('Repository validation passed: ' + plugins.length + ' plugin(s). Full API validation: npm run check:host -- <DevKit>')
} catch (error) { console.error(error.message); process.exitCode = 1 }
