import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function runner(script: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', '--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('tail runner timed out')) }, 60_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`tail runner exited ${code}/${signal}: ${stderr}`))
    })
  })
}

test('loadEventsTailAsync fallback reads a 96 MiB log under a 64 MiB heap without retaining its head', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-tail-memory-'))
  try {
    mkdirSync(join(dir, 's1'))
    const file = join(dir, 's1', 'events.jsonl')
    const text = 'x'.repeat(16 * 1024)
    for (let seq = 1; seq <= 6144; seq++) {
      appendFileSync(file, JSON.stringify({ seq, ts: seq, type: 'text_delta', data: { text } }) + '\n')
    }
    const script = `
import { FileSessionPersistence } from './src/server/session-persistence.ts'
const p = new FileSessionPersistence(${JSON.stringify(dir)})
const tail = await p.loadEventsTailAsync('s1', 8)
console.log(JSON.stringify({ total: tail.total, first: tail.diskFirstSeq, last: tail.lastSeq, seqs: tail.events.map(e => e.seq) }))
`
    const out = await runner(script, { RIVET_CPU_POOL: '0' })
    assert.deepEqual(JSON.parse(out), { total: 6144, first: 1, last: 6144, seqs: [6137, 6138, 6139, 6140, 6141, 6142, 6143, 6144] })
    assert.ok(existsSync(join(dir, 's1', 'events.summary.json')), 'actual fallback consumer must build the summary')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadEventsTailAsync passes a path to the real worker and preserves head metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-tail-worker-'))
  try {
    mkdirSync(join(dir, 's1'))
    const file = join(dir, 's1', 'events.jsonl')
    appendFileSync(file, JSON.stringify({ seq: 1, ts: 1, type: 'artifact', data: { id: 'old-art' } }) + '\n')
    appendFileSync(file, JSON.stringify({ seq: 2, ts: 2, type: 'delegation', data: { status: 'completed' } }) + '\n')
    for (let seq = 3; seq <= 20; seq++) {
      appendFileSync(file, JSON.stringify({ seq, ts: seq, type: 'text_delta', data: { text: '行🌌'.repeat(4000) } }) + '\n')
    }
    const script = `
import { cpuPool } from './src/workers/cpu-pool.ts'
import { FileSessionPersistence } from './src/server/session-persistence.ts'
const run = cpuPool.run.bind(cpuPool)
let request
let workerResolved = false
const modes = []
cpuPool.run = async (task, args, timeout) => {
  request = { task, args }
  const result = await run(task, args, timeout)
  modes.push(result.metrics.mode)
  workerResolved = true
  return result
}
const p = new FileSessionPersistence(${JSON.stringify(dir)})
await p.loadEventsTailAsync('s1', 3)
const tail = await p.loadEventsTailAsync('s1', 3)
console.log(JSON.stringify({ request, tail: { total: tail.total, artifactIds: tail.artifactIds, seqs: tail.events.map(e => e.seq) }, workerResolved, modes }))
cpuPool.dispose()
`
    const out = await runner(script, { RIVET_CPU_POOL: '1', RIVET_CPU_POOL_IDLE_MS: '100' })
    const { request, tail, workerResolved, modes } = JSON.parse(out)
    assert.equal(workerResolved, true, 'real worker must resolve; fallback alone cannot satisfy this check')
    // The worker call carries an options object (byte budget) as its third argument
    // since PR #353. `request` is round-tripped through JSON.stringify below, so the
    // undefined maxEventBytes vanishes and the options object arrives here as {}.
    assert.deepEqual(request, { task: 'readEventsTailIndexed', args: [file, 3, {}] })
    assert.equal(tail.total, 20)
    assert.deepEqual(tail.artifactIds, ['old-art'])
    // PR #353 revoked the delegation payload exemption: the replay window is now a
    // pure count/byte trailing slice of the log, so the seq-2 delegation row falls
    // outside it. Head metadata still survives — 'old-art' (seq 1) via artifactIds
    // and delegation transitions via delegationState, not by pinning ring rows.
    assert.deepEqual(tail.seqs, [18, 19, 20])
    assert.deepEqual(modes, ['scan', 'warm'], 'the actual worker must build then consume its verified summary')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
