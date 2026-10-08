import { test, after } from 'node:test'
import { cpuPool } from '../../workers/cpu-pool.js'
after(() => cpuPool.dispose())
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { RuntimeSessionManager } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { FileSessionPersistence } from '../session-persistence.js'
import { resolveBareSkillPrompt } from '../../tui/prompt-input-resolver.js'
import { draftSkills } from '../session-skills-helper.js'
import { skillRegistry } from '../../skills/skill-loader.js'
import { resolveChildEntry } from '../../agent/worker-process/parent.js'
import { OpenAIClient } from '../../api/openai-client.js'
import { eventByteSize } from '../session-ring-limits.js'

class FakeAgent {
  callbacks: any; prompts: string[] = []; messages: any[] = [{ role: 'system', content: 'frozen' }, { role: 'user', content: 'original' }]; replacements = 0
  resolve?: () => void
  run(prompt: string, callbacks: any) { this.prompts.push(prompt); this.callbacks = callbacks; return new Promise<void>(r => { this.resolve = r }) }
  abort() { this.callbacks?.onAbort(); this.resolve?.() }
  listArtifacts() { return [] } readArtifact() { return Promise.resolve(null) }
  getMessages() { return this.messages } replaceMessages(m: any[]) { this.replacements++; this.messages = m } rewindToMessages(m: any[]) { this.messages = m }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pr353-dev-'))
  const prior = { home: process.env.RIVET_HOME, config: process.env.RIVET_CONFIG_PATH, trust: process.env.RIVET_TRUST_PROJECT }
  process.env.RIVET_HOME = join(root, 'data'); process.env.RIVET_CONFIG_PATH = join(root, 'config.json')
  // 项目技能装载自 2667803f6 起受信任门约束；fixture 的项目目录未授信，显式放行。
  process.env.RIVET_TRUST_PROJECT = '1'
  writeFileSync(process.env.RIVET_CONFIG_PATH, '{}')
  const a = join(root, 'A'), b = join(root, 'B'); mkdirSync(a); mkdirSync(b)
  const addSkill = (dir: string, name: string) => { mkdirSync(join(dir, '.rivet', 'skills'), { recursive: true }); writeFileSync(join(dir, '.rivet', 'skills', `${name}.md`), `---\nname: ${name}\ndescription: Local\n---\nBODY_${name}`) }
  const agent = new FakeAgent(); const manager = new RuntimeSessionManager({ defaultCwd: a, createAgent: () => agent as any, maxEvents: 12, maxEventBytes: 2000 })
  const router = createRouter(buildSessionRoutes(manager, 'review-auth'))
  return { root, a, b, agent, manager, router, addSkill, cleanup() { agent.abort(); for (const [key, value] of [['RIVET_HOME',prior.home],['RIVET_CONFIG_PATH',prior.config],['RIVET_TRUST_PROJECT',prior.trust]]) { if(value===undefined)delete process.env[key!];else process.env[key!]=value } rmSync(root,{recursive:true,force:true}) } }
}
const auth = { authorization: 'Bearer review-auth' }

test('draft discovery and slash invocation isolate projects without mutating live registry or seeding', async () => {
  const f = fixture(); const before = skillRegistry.list()
  try {
    f.addSkill(f.a, 'only-A'); f.addSkill(f.b, 'only-B')
    assert.ok(draftSkills(f.manager, f.a).skills.some(s => s.name === 'only-A'))
    assert.ok(!draftSkills(f.manager, f.b).skills.some(s => s.name === 'only-A'))
    assert.match(resolveBareSkillPrompt('/only-B task', f.b)!, /BODY_only-B/)
    assert.equal(resolveBareSkillPrompt('/only-A task', f.b), null)
    assert.deepEqual(skillRegistry.list(), before)
    const empty = join(f.root, 'empty'); mkdirSync(empty); draftSkills(f.manager, empty)
    assert.equal(existsSync(join(empty, '.rivet')), false)
    assert.equal((await f.router('GET', '/sessions/draft/skills?cwd='+encodeURIComponent(f.b), {}, auth)).status, 200)
    assert.equal((await f.router('GET', '/skills', {}, {})).status, 401)
  } finally { f.cleanup() }
})

test('POST sessions expands the configured actual workspace and preserves raw slash text with documents', async () => {
  const f = fixture()
  try {
    f.addSkill(f.b, 'configured-project')
    writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify({ workspace: { defaultDir: f.b } }))
    const res = await f.router('POST', '/sessions', { workspaceMode: 'default', prompt: '/configured-project task', documents: [{ name: 'task.md', dataUrl: 'data:text/plain;base64,'+Buffer.from('ATTACHED_FACT').toString('base64') }] }, auth)
    assert.equal(res.status, 201); assert.equal((res.body as any).cwd, f.b)
    assert.match(f.agent.prompts[0]!, /BODY_configured-project/); assert.match(f.agent.prompts[0]!, /ATTACHED_FACT/)
    assert.equal(f.manager.getEvents((res.body as any).id)!.events.find(e=>e.type==='user')?.data.promptText, '/configured-project task')
    f.agent.abort()
    const bad = await f.router('POST', '/sessions', { cwd: f.b, prompt: '/fork bad' }, auth)
    assert.equal(bad.status, 400)
    assert.equal(f.manager.listSessions().length, 1, 'invalid slash cannot register a ghost session')
  } finally { f.cleanup() }
})

test('packaged worker entry resolves root bundles, chunks and normal mirrored layouts', () => {
  const root = mkdtempSync(join(tmpdir(),'pr353-entry-'))
  try {
    const child = join(root,'agent','worker-process','child.js'); mkdirSync(join(root,'agent','worker-process'),{recursive:true});writeFileSync(child,'')
    assert.equal(resolveChildEntry(pathToFileURL(join(root,'main.js')).href)?.script,child)
    assert.equal(resolveChildEntry(pathToFileURL(join(root,'chunks','main.js')).href)?.script,child)
    assert.equal(resolveChildEntry(pathToFileURL(join(root,'agent','worker-process','parent.js')).href)?.script,child)
    assert.equal(resolveChildEntry(pathToFileURL(join(root,'missing','nested','main.js')).href),null)
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('memory eviction advertises a contiguous disk gap, restores full text and still settles evicted workers', async () => {
  const f=fixture(); const persistence = new FileSessionPersistence(join(f.root,'ui-sessions'))
  const manager = new RuntimeSessionManager({defaultCwd:f.a,createAgent:()=>f.agent as any,persistence,maxEvents:12,maxEventBytes:2000})
  try {
    const rec=manager.createSession({prompt:'original persisted request'})
    f.agent.callbacks.onDelegationActivity({workOrderId:'long-lived',status:'running',parentToolId:'tool'})
    for(let i=0;i<20;i++)f.agent.callbacks.onDelegationActivity({workOrderId:'activity-'+i,status:'completed',parentToolId:'tool',progressLine:'中文'.repeat(600)})
    const events=manager.getEvents(rec.id)!.events,win=manager.getReplayWindow(rec.id)!
    assert.ok(win.floorSeq>win.diskFirstSeq)
    assert.ok(events.every(e=>Object.keys(e.data).length>0))
    assert.ok(events.reduce((n,e)=>n+eventByteSize(e),0)<=2000)
    assert.ok(manager.getDelegationSnapshot(rec.id)!.events.some(e=>e.data.workerId==='long-lived'))
    persistence.flushSync()
    const page=await manager.getHistoryPage(rec.id,win.floorSeq,100)
    assert.ok(page!.events.some(e=>e.type==='user'&&e.data.text==='original persisted request'))
    manager.abort(rec.id); await manager.waitForRunSettled(rec.id)
    for (let n=0;n<100 && manager.getDelegationSnapshot(rec.id)!.events.length;n++) await new Promise(r=>setTimeout(r,10))
    await persistence.flushThrough(rec.id, manager.getReplayWindow(rec.id)!.diskLastSeq)
    assert.ok(persistence.loadEvents(rec.id).some(e=>e.type==='delegation'&&e.data.workerId==='long-lived'&&e.data.status==='failed'))
    assert.equal(manager.getDelegationSnapshot(rec.id)!.events.length,0)
  } finally { persistence.flushSync(); f.cleanup() }
})

test('UI pressure leaves the actual final-wire model prefix, tools and thinking byte-identical', async () => {
  const f=fixture(),savedFetch=globalThis.fetch,bodies:any[]=[]
  globalThis.fetch=async (_u,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})}
  try {
    const rec=f.manager.createSession({prompt:'go'}), client=new OpenAIClient({baseUrl:'https://example.invalid',providerName:'deepseek',apiKey:'mock',model:'deepseek-v4-flash',maxTokens:16384,thinking:'enabled',thinkingBlockType:'enabled'})
    const request:any={model:'deepseek-v4-flash',messages:f.agent.getMessages(),prefixProbe:true,tools:[{type:'function',function:{name:'read_file',description:'stable',parameters:{type:'object'}}}]}
    const cb={onTextDelta(){},onThinkingDelta(){},onContentBlock(){},onStopReason(){},onError(e:Error){throw e}}
    await client.stream(request,cb)
    for(let i=0;i<30;i++)f.agent.callbacks.onDelegationActivity({workOrderId:'pressure-'+i,status:'completed',progressLine:'x'.repeat(4000)})
    f.manager.getEvents(rec.id);assert.ok(f.manager.getReplayWindow(rec.id)!.floorSeq>1)
    await client.stream({...request,messages:[...f.agent.getMessages(),{role:'assistant',content:'next',reasoning_content:'preserved'},{role:'user',content:'continue'}]},cb)
    assert.equal(JSON.stringify(bodies[1].messages.slice(0,2)),JSON.stringify(bodies[0].messages));assert.deepEqual(bodies[1].tools,bodies[0].tools);assert.deepEqual(bodies[1].thinking,bodies[0].thinking)
    assert.equal(f.agent.replacements,0)
  } finally { globalThis.fetch=savedFetch;f.cleanup() }
})


test('real manager restart propagates the byte budget to cold loading and settles historical workers', async () => {
  const f=fixture(),persistence=new FileSessionPersistence(join(f.root,'cold-ui'))
  try {
    const first=new RuntimeSessionManager({defaultCwd:f.a,createAgent:()=>f.agent as any,persistence,maxEventBytes:2000})
    const rec=first.createSession({})
    persistence.appendEvent(rec.id,{seq:1,ts:1,type:'delegation',data:{workerId:'old-worker',attemptId:'old-attempt',status:'running',objective:'cold task'}})
    for(let seq=2;seq<=500;seq++) persistence.appendEvent(rec.id,{seq,ts:seq,type:'text_delta',data:{text:'汉字🌌'.repeat(100)}})
    persistence.saveRecord({...rec,lastSeq:500}); await persistence.flushThrough(rec.id,500)
    const restored=new RuntimeSessionManager({defaultCwd:f.a,createAgent:()=>f.agent as any,persistence,maxEvents:5000,maxEventBytes:2000})
    const result=await restored.getEventsAsync(rec.id)
    assert.ok(result!.events.reduce((sum,e)=>sum+eventByteSize(e),0)<=2000)
    assert.ok(restored.getReplayWindow(rec.id)!.floorSeq>1)
    assert.deepEqual(restored.getDelegationSnapshot(rec.id)!.events,[])
    await persistence.flushThrough(rec.id,restored.getReplayWindow(rec.id)!.diskLastSeq)
    assert.ok(persistence.loadEvents(rec.id).some(e=>e.type==='delegation'&&e.data.workerId==='old-worker'&&e.data.status==='failed'))
  } finally {persistence.flushSync();f.cleanup()}
})


test('external disk synchronization retains control state even when every new payload exceeds the window', async () => {
  const f=fixture(),persistence=new FileSessionPersistence(join(f.root,'external-ui'))
  try {
    const manager=new RuntimeSessionManager({defaultCwd:f.a,createAgent:()=>f.agent as any,persistence,maxEventBytes:1000})
    const rec=manager.createSession({}),start=rec.lastSeq+1,delivered:any[]=[]
    manager.subscribe(rec.id,e=>delivered.push(e))
    persistence.appendEvent(rec.id,{seq:start,ts:1,type:'delegation',data:{workerId:'external-worker',attemptId:'external-attempt',status:'running'}})
    persistence.appendEvent(rec.id,{seq:start+1,ts:2,type:'text_delta',data:{text:'汉字🌌'.repeat(300)}})
    persistence.saveRecord({...rec,lastSeq:start+1,updatedAt:Date.now()+1000})
    await persistence.flushThrough(rec.id,start+1)
    const merges=(manager as any).adoptExternalSessions() as Promise<void>[];await Promise.all(merges)
    assert.equal(manager.getReplayWindow(rec.id)!.floorSeq,start+2)
    assert.equal(manager.getDelegationSnapshot(rec.id)!.events[0]?.data.workerId,'external-worker')
    assert.ok(delivered.some(e=>e.type==='delegation_snapshot'&&e.seq===0&&e.data.events[0]?.data.workerId==='external-worker'))
  } finally {persistence.flushSync();f.cleanup()}
})
