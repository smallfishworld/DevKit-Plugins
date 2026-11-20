'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { readCompatibility } = require('../scripts/lib/compatibility.cjs')

function fixture(t, override = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-compatibility-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const config = {
    schemaVersion: 1, apiVersion: 2, hostRepository: 'smallfishworld/DevKit',
    hostCommit: 'a'.repeat(40), ...override
  }
  fs.writeFileSync(path.join(root, 'compatibility.json'), JSON.stringify(config))
  return root
}

test('API v2 compatibility metadata rejects an API v1 pin instead of silently targeting the old host', (t) => {
  assert.throws(() => readCompatibility(fixture(t, { apiVersion: 1 })), /API v2/)
  const root = fixture(t)
  assert.equal(readCompatibility(root, [{ manifest: { apiVersion: 2 } }]).apiVersion, 2)
  assert.throws(() => readCompatibility(root, [{ manifest: { apiVersion: 1 } }]), /不一致/)
})

test('compatibility requires an immutable commit and a safe repository name', (t) => {
  for (const hostCommit of ['main', '1234567', 'a'.repeat(40) + '\n', null]) {
    assert.throws(() => readCompatibility(fixture(t, { hostCommit })), /兼容基线/)
  }
  for (const hostRepository of ['smallfishworld/DevKit\ncommit=main', '../DevKit', null]) {
    assert.throws(() => readCompatibility(fixture(t, { hostRepository })), /兼容基线/)
  }
})

test('CI pin output and repository validation both use the checked API v2 metadata', () => {
  const root = path.resolve(__dirname, '..')
  const config = readCompatibility(root)
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/ci-compatibility.cjs')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' }
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stdout, 'repository=' + config.hostRepository + '\ncommit=' + config.hostCommit + '\n')
})
