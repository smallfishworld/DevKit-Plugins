'use strict'
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { discover, verifyCatalog, packPlugin, readText, parseJson } = require('./lib/repository.cjs')

const INDEX_TAG = 'install-index-v2'
const INDEX_FILE = 'index.json'
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
const OWNER_REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/
const ALLOWED_TRANSPORTS = ['serial', 'ssh', 'net', 'pty']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function parseTag(tag) {
  const match = typeof tag === 'string' && /^([a-z0-9][a-z0-9-]*)\/v(.+)$/.exec(tag)
  if (!match || !STABLE_VERSION.test(match[2])) throw new Error('发布请求须为 <slug>/vX.Y.Z')
  return { tag, slug: match[1], version: match[2] }
}

/** Supports batch tags[] as well as optional yank[] / deprecations{} governance entries. */
function plan(root) {
  const request = parseJson(readText(path.join(root, 'releases', 'request.json')), 'releases/request.json')
  const rawTags = Array.isArray(request.tags) ? request.tags : (typeof request.tag === 'string' ? [request.tag] : [])
  const rawYanks = Array.isArray(request.yank) ? request.yank : []
  if (!rawTags.length && !rawYanks.length) throw new Error('发布请求须包含至少一个 tags 或 yank 条目')
  const plugins = discover(root)
  verifyCatalog(root, plugins)
  const items = rawTags.map((raw) => {
    const parsed = parseTag(raw)
    const plugin = plugins.find((item) => item.slug === parsed.slug)
    if (!plugin || plugin.manifest.version !== parsed.version) throw new Error('发布标签与插件清单版本不符: ' + raw)
    return { tag: parsed.tag, plugin }
  })
  const deprecations = request.deprecations && typeof request.deprecations === 'object' ? request.deprecations : {}
  return { items, yank: rawYanks, deprecations }
}

function readIndex(text, repo) {
  const index = parseJson(text, 'install-index')
  if (index.version !== 2 || !Array.isArray(index.plugins) || index.plugins.length > 128) throw new Error('安装索引格式无效（需要 version 2）')
  const ids = new Set()
  const prefix = `https://github.com/${repo}/releases/download/`
  for (const row of index.plugins) {
    if (!row || typeof row.id !== 'string' || !PLUGIN_ID.test(row.id) || row.id.length > 96 ||
      ids.has(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 128 ||
      typeof row.version !== 'string' || row.version.length > 64 || !STABLE_VERSION.test(row.version) ||
      row.apiVersion !== 2 ||
      typeof row.url !== 'string' || !row.url.startsWith(prefix) || typeof row.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('安装索引含无效或重复条目')
    if (row.minHostVersion !== undefined && !STABLE_VERSION.test(row.minHostVersion)) throw new Error('minHostVersion 无效')
    if (row.transports !== undefined && (!Array.isArray(row.transports) || row.transports.some((t) => !ALLOWED_TRANSPORTS.includes(t)))) {
      throw new Error('transports 无效')
    }
    ids.add(row.id)
  }
  return index.plugins
}

function compareVersion(a, b) {
  const left = a.split('.').map(BigInt)
  const right = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1
    if (left[i] < right[i]) return -1
  }
  return 0
}

function mergeIndex(previous, current, repo) {
  const entry = previous.find((row) => row.id === current.id)
  if (entry) {
    const diff = compareVersion(current.version, entry.version)
    if (diff < 0) throw new Error('安装索引已指向更新版本')
    if (diff === 0 && (entry.sha256 !== current.sha256 || entry.url !== current.url)) {
      throw new Error('同版本插件包已发布，须提高清单版本')
    }
  }
  const plugins = [...previous.filter((row) => row.id !== current.id), current]
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const contents = JSON.stringify({ version: 2, plugins }, null, 2) + '\n'
  readIndex(contents, repo)
  return contents
}

function yankInIndex(previous, pluginId, repo) {
  const target = previous.find((row) => row.id === pluginId)
  if (!target) throw new Error('索引中不存在待撤回插件: ' + pluginId)
  return mergeIndex(previous, { ...target, yanked: true }, repo)
}

function github(repo) {
  const gh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  return {
    release(tag) {
      try { return JSON.parse(gh(['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`])) }
      catch (error) {
        if (String(error.stderr).includes('HTTP 404')) return undefined
        throw error
      }
    },
    create(tag, files, title, notes, commit) {
      return gh(['release', 'create', tag, ...files, '--repo', repo, '--title', title,
        '--notes', notes, '--target', commit, '--latest=false'])
    },
    download(tag, name, directory) {
      gh(['release', 'download', tag, '--pattern', name, '--dir', directory, '--repo', repo])
      return fs.readFileSync(path.join(directory, name))
    },
    upload(tag, filename) {
      return gh(['release', 'upload', tag, filename, '--repo', repo, '--clobber'])
    }
  }
}

function publish(root, repo, commit) {
  assert.match(repo ?? '', OWNER_REPO)
  assert.match(commit ?? '', /^[a-f0-9]{40}$/)
  const { items, yank, deprecations } = plan(root)
  const api = github(repo)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-install-index-'))
  try {
    const registry = api.release(INDEX_TAG)
    const previousText = registry ? api.download(INDEX_TAG, INDEX_FILE, temporary).toString('utf8') : ''
    let rows = previousText ? readIndex(previousText, repo) : []
    let contents = previousText

    for (const { tag, plugin } of items) {
      const bundle = packPlugin(root, plugin)
      const digest = sha256(fs.readFileSync(bundle))
      const recorded = rows.find((entry) => entry.id === plugin.manifest.id)
      if (recorded && compareVersion(recorded.version, plugin.manifest.version) > 0) {
        throw new Error('安装索引已指向更新版本: ' + plugin.manifest.id)
      }
      let release = api.release(tag)
      if (!release) {
        api.create(tag, [bundle, path.join(path.dirname(bundle), 'SHA256SUMS')], plugin.manifest.name + ' ' + tag,
          'DevKit API v2 自包含 JSON 安装包及 SHA-256。', commit)
        release = api.release(tag)
      }
      if (!release || release.draft || release.prerelease) throw new Error('插件 Release 未正式发布')
      const asset = release.assets.find((item) => item.name === plugin.filename && item.state === 'uploaded')
      if (!asset) throw new Error('该 Release 缺少正式安装包')
      const publishedDigest = asset.digest ?? 'sha256:' + sha256(api.download(tag, plugin.filename, temporary))
      if (publishedDigest !== 'sha256:' + digest) throw new Error('已发布包与本次构建不同，须提高插件版本')

      const { id, name, version, transports, minHostVersion } = plugin.manifest
      const deprecated = typeof deprecations[id] === 'string' ? deprecations[id] : undefined
      contents = mergeIndex(rows, {
        id, name, version, apiVersion: 2, transports,
        ...(minHostVersion ? { minHostVersion } : {}),
        ...(deprecated ? { deprecated } : {}),
        url: asset.browser_download_url, sha256: digest
      }, repo)
      rows = readIndex(contents, repo)
    }

    for (const pluginId of yank) {
      contents = yankInIndex(rows, pluginId, repo)
      rows = readIndex(contents, repo)
    }

    if (contents && contents !== previousText) {
      const file = path.join(temporary, INDEX_FILE)
      fs.writeFileSync(file, contents)
      if (registry) api.upload(INDEX_TAG, file)
      else api.create(INDEX_TAG, [file], 'DevKit 官方安装索引 v2', 'DevKit 扩展中心使用的正式安装索引 v2。', commit)
    }
    console.log(`https://github.com/${repo}/releases/download/${INDEX_TAG}/${INDEX_FILE}`)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

if (require.main === module) {
  try { publish(path.resolve(__dirname, '..'), process.env.GITHUB_REPOSITORY, process.env.GITHUB_SHA) }
  catch (error) { console.error(String(error.stderr || error.message).trim()); process.exitCode = 1 }
}
module.exports = { plan, readIndex, mergeIndex, yankInIndex }
