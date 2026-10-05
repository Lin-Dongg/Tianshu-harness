import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEventsTailRaw, TailAccumulator } from '../events-tail.js'
import { parseEventsTailRaw, type RawSessionEvent } from '../cpu-tasks.js'

async function compareTail(events: RawSessionEvent[], capacities: number[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-stream-tail-'))
  try {
    const file = join(dir, 'events.jsonl')
    const text = '\ufeffbad\n' + events.map(e => JSON.stringify(e)).join('\r\n') + '\n{"type":"marker"}\n{"seq":'
    writeFileSync(file, text)
    for (const capacity of capacities) {
      assert.deepEqual(await readEventsTailRaw(file, capacity), parseEventsTailRaw(text, capacity))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('stream tail matches existing sort/trim for unordered seqs, ties, artifacts and delegation', async () => {
  const events: RawSessionEvent[] = []
  for (let i = 0; i < 120; i++) {
    const type = i % 7 === 0 ? 'delegation' : i % 9 === 0 ? 'artifact' : 'text_delta'
    events.push({ seq: (i * 37) % 113, ts: i, type, data: { id: 'art-' + (i % 3), text: '行🌌' + i } })
  }
  await compareTail(events, [0, 1, 10, 17, 18, 50, 120, 5000])
})

test('stream tail preserves UTF-8 split across chunks, long lines and a valid unterminated final line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-stream-tail-'))
  try {
    const file = join(dir, 'events.jsonl')
    const events: RawSessionEvent[] = [
      { seq: 1, ts: 1, type: 'artifact', data: { id: '早期🌌' } },
      { seq: 2, ts: 2, type: 'text_delta', data: { text: '🌌汉字'.repeat(20000) } },
      { seq: 3, ts: 3, type: 'delegation', data: { text: '结束🌌' } },
    ]
    const text = '\ufeff' + events.map(e => JSON.stringify(e)).join('\n')
    writeFileSync(file, text)
    assert.deepEqual(await readEventsTailRaw(file, 2), parseEventsTailRaw(text, 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stream tail returns zero metadata for missing, empty and wholly corrupt files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-stream-tail-'))
  try {
    const empty = { events: [], diskFirstSeq: 0, lastSeq: 0, artifactIds: [], total: 0 }
    const file = join(dir, 'events.jsonl')
    assert.deepEqual(await readEventsTailRaw(file, 5), empty)
    for (const text of ['', 'garbage\n{"type":"marker"}\n{"seq":']) {
      writeFileSync(file, text)
      assert.deepEqual(await readEventsTailRaw(file, 5), empty)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('activity flood retains bounded UTF-8 payloads and a separate minimal lifecycle', () => {
  const tail = new TailAccumulator(3, 900)
  tail.addEvent({ seq: 1, ts: 1, type: 'delegation', data: { workerId: 'w', attemptId: 'a', status: 'running', objective: 'check', text: 'secret transcript' } })
  for (let seq=2;seq<200;seq++) tail.addEvent({seq,ts:seq,type:'delegation',data:{workerId:'w',attemptId:'a',status:'running',text:'汉字🌌'.repeat(50)}})
  const result=tail.finish()
  assert.ok(result.events.length<=3)
  assert.ok(result.events.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e)),0)<=900)
  assert.equal(result.delegationState?.events.length,1)
  assert.equal(result.delegationState?.events[0]?.data.text,undefined)
  assert.equal(result.delegationState?.events[0]?.data.objective,'check')
  const oversized=new TailAccumulator(5,250)
  oversized.addEvent({seq:10,ts:0,type:'user',data:{text:'🌌'.repeat(500)}})
  oversized.addEvent({seq:9,ts:0,type:'user',data:{text:'older'}})
  assert.deepEqual(oversized.finish().events,[], 'older events cannot reappear behind a discarded newer event')
})

test('native Node development worker modules load without a TypeScript transpiler', async () => {
  const {execFileSync}=await import('node:child_process')
  const url=new URL('../cpu-tasks.ts',import.meta.url).href
  const output=execFileSync(process.execPath,['--input-type=module','-e',`const {parseEventsTailRaw}=await import(${JSON.stringify(url)}); console.log(parseEventsTailRaw('',3).total)`],{encoding:'utf8'})
  assert.equal(output.trim(),'0')
})


test('zero byte budget preserves existing opt-out while count eviction remains active', () => {
  const tail=new TailAccumulator(2,0)
  for(let seq=1;seq<4;seq++) tail.addEvent({seq,ts:0,type:'user',data:{text:'汉字'.repeat(1000)}})
  assert.deepEqual(tail.finish().events.map(e=>e.seq),[2,3])
})


test('legacy malformed lifecycle rows remain readable without claiming a complete control snapshot', () => {
  const tail=parseEventsTailRaw(JSON.stringify({seq:1,ts:1,type:'delegation'})+'\n'+JSON.stringify({seq:2,ts:2,type:'user',data:{text:'preserved'}}),1)
  assert.equal(tail.events[0]?.data.text,'preserved')
  assert.equal(tail.delegationState?.complete,false)
})
