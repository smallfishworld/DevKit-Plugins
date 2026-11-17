'use strict'
const path = require('node:path')
const { discover, verifyCatalog, validateSlug, packPlugin } = require('./lib/repository.cjs')
try {
  const root = path.resolve(__dirname, '..')
  const args = process.argv.slice(2)
  if (args.length !== 1) throw new Error('Usage: npm run pack -- <slug> | npm run pack:all')
  const plugins = discover(root)
  verifyCatalog(root, plugins)
  if (args[0] !== '--all') validateSlug(args[0])
  const selected = args[0] === '--all' ? plugins : plugins.filter((p) => p.slug === args[0])
  if (!selected.length) throw new Error('插件不存在: ' + args[0])
  for (const plugin of selected) console.log(packPlugin(root, plugin))
} catch (error) { console.error(error.message); process.exitCode = 1 }
