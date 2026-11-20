'use strict'
const path = require('node:path')
const { parseJson, readText } = require('./repository.cjs')

function readCompatibility(root, plugins = []) {
  const config = parseJson(readText(path.join(root, 'compatibility.json')), 'compatibility.json')
  if (!config || config.schemaVersion !== 1 || config.apiVersion !== 2 ||
      typeof config.hostCommit !== 'string' || config.hostCommit.length !== 40 || !/^[0-9a-f]{40}$/.test(config.hostCommit) ||
      typeof config.hostRepository !== 'string' || config.hostRepository.trim() !== config.hostRepository || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(config.hostRepository)) {
    throw new Error('宿主兼容基线无效：须声明 API v2、完整提交 SHA 和 owner/repository')
  }
  if (plugins.some((plugin) => plugin.manifest.apiVersion !== config.apiVersion)) {
    throw new Error('插件 API 与 compatibility.json 的宿主基线不一致')
  }
  return config
}

module.exports = { readCompatibility }
