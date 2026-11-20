'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { plan, mergeIndex, readIndex, yankInIndex } = require('../scripts/publish.cjs')

const repo = 'smallfishworld/DevKit-Plugins'
const fixture = (id, version, digest = 'a'.repeat(64), extra = {}) => ({
  id, name: id, version, apiVersion: 2, transports: ['serial', 'ssh'], minHostVersion: '0.1.10',
  sha256: digest,
  url: `https://github.com/${repo}/releases/download/device/v${version}/${id}-${version}.devkit-plugin.json`,
  ...extra
})

test('the batch publish request is pinned to the requested plugin manifest', () => {
  const planned = plan(path.resolve(__dirname, '..'))
  assert.equal(planned.items.length, 1)
  const { tag, plugin } = planned.items[0]
  assert.equal(tag, `${plugin.slug}/v${plugin.manifest.version}`)
})

test('publishing v2 plugins preserves other releases, supports yank and rejects downgrades', () => {
  const a = fixture('vendor.alpha', '1.1.0')
  const b = fixture('vendor.beta', '2.0.0', 'c'.repeat(64), { deprecated: '请升级至 v3' })
  const contents = mergeIndex([b], a, repo)
  const rows = readIndex(contents, repo)
  assert.deepEqual(rows, [a, b])
  assert.equal(mergeIndex(rows, a, repo), contents)
  assert.throws(() => mergeIndex(rows, fixture(a.id, '1.0.9'), repo), /更新版本/)
  assert.throws(() => mergeIndex(rows, fixture(a.id, a.version, 'b'.repeat(64)), repo), /同版本/)
  assert.throws(() => mergeIndex([], { ...a, url: 'https://other.test/asset.json' }, repo), /无效/)

  const yanked = readIndex(yankInIndex(rows, a.id, repo), repo)
  assert.equal(yanked.find((row) => row.id === a.id).yanked, true)
})
