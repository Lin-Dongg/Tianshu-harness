import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const mutations = [
  ['automatic OSS', 'catalog.mjs', "['atomgit', 'github'] : [mode]", "['atomgit', 'github', 'oss'] : [mode]"],
  ['unverified AtomGit', 'catalog.mjs', 'asset.sources[source]?.verified', 'asset.sources[source]'],
  ['conflicting signatures', 'catalog.mjs', ' || same.signature !== asset.signature', ''],
  ['unsigned anonymous bytes', 'publish-atomgit.mjs', 'size !== expected.size || digest !== expected.sha256', 'size !== expected.size'],
  ['local artifact mismatch', 'generate-catalog.mjs', 'if (remote && (remote.size !== size || remote.digest !== `sha256:${digest}`))', 'if (false)'],
]
for (const [name,file,before,after] of mutations) {
  const dir=mkdtempSync(join(tmpdir(),'tianshu-routing-mutation-'))
  try {
    cpSync(import.meta.dirname,dir,{recursive:true})
    const path=join(dir,file), source=readFileSync(path,'utf8');assert.ok(source.includes(before),`Mutation anchor: ${name}`)
    writeFileSync(path,source.replace(before,after))
    const result=spawnSync(process.execPath,['--test','--test-reporter=tap',join(dir,'catalog.test.mjs')],{encoding:'utf8',timeout:30000,windowsHide: true})
    assert.notEqual(result.status,0,`Restored defect remained green: ${name}`)
    assert.ok(result.stdout.includes('not ok'),`Must fail an assertion, not a syntax error: ${name}`)
    console.log(`RED confirmed: ${name}`)
  } finally {rmSync(dir,{recursive:true,force:true})}
}
