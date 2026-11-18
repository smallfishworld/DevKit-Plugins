'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { plan, mergeIndex, readIndex } = require('../scripts/publish.cjs')

const repo = 'smallfishworld/DevKit-Plugins'
const fixture = (id, version, digest = 'a'.repeat(64)) => ({
  id, name: id, version, sha256: digest,
  url: `https://github.com/${repo}/releases/download/device/v${version}/${id}-${version}.devkit-plugin.json`
})

test('the publish request is pinned to the requested plugin manifest', () => {
  const { tag, plugin } = plan(path.resolve(__dirname, '..'))
  assert.equal(tag, `${plugin.slug}/v${plugin.manifest.version}`)
})

test('publishing a single plugin preserves other releases and leaves a stable index', () => {
  const a = fixture('vendor.alpha', '1.1.0')
  const b = fixture('vendor.beta', '2.0.0')
  const contents = mergeIndex([b], a, repo)
  const rows = readIndex(contents, repo)
  assert.deepEqual(rows, [a, b])
  assert.equal(mergeIndex(rows, a, repo), contents)
  assert.throws(() => mergeIndex(rows, fixture(a.id, '1.0.9'), repo), /更新版本/)
  assert.throws(() => mergeIndex(rows, fixture(a.id, a.version, 'b'.repeat(64)), repo), /同版本/)
  assert.throws(() => mergeIndex([], { ...a, url: 'https://other.test/asset.json' }, repo), /无效/)
})
