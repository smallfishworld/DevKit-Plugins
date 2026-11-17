'use strict'
const path = require('node:path')
const { writeCatalog } = require('./lib/repository.cjs')
try { writeCatalog(path.resolve(__dirname, '..')); console.log('Updated catalog.json') }
catch (error) { console.error(error.message); process.exitCode = 1 }
