'use strict'
const path = require('node:path')
const { discover, verifyCatalog } = require('./lib/repository.cjs')
const { readCompatibility } = require('./lib/compatibility.cjs')
try {
  const root = path.resolve(__dirname, '..')
  const plugins = discover(root)
  verifyCatalog(root, plugins)
  readCompatibility(root, plugins)
  console.log('Repository validation passed: ' + plugins.length + ' plugin(s). Full API validation: npm run check:host -- <DevKit>')
} catch (error) { console.error(error.message); process.exitCode = 1 }
