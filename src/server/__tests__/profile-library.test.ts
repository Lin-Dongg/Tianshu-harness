import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProfileLibraryRoutes, parseRepositories, presenceCredit } from '../profile-library-routes.js'
import { createRouter } from '../index.js'

const sample = { url: 'https://github.com/traveler/star-map.git', title: '星图', description: '我的作品' }
const headers = { authorization: 'Bearer fixture-profile' }
test('GitHub selections normalize repository URLs and reject duplicates, unsafe URLs and invalid fields', () => {
  assert.equal(parseRepositories([sample])?.[0]?.url, 'https://github.com/traveler/star-map')
  for (const url of ['http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com.evil.example/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a/b/issues', 'https://github.com/a/b?key=hidden', 'https://github.com/a/.git']) assert.equal(parseRepositories([{ ...sample, url }]), null)
  assert.equal(parseRepositories([sample, { ...sample, url: 'https://github.com/TRAVELER/star-map' }]), null)
  assert.equal(parseRepositories(Array(7).fill(sample)), null)
  assert.equal(parseRepositories([{...sample,title:'a'.repeat(81)}]),null)
})
test('presence counts contiguous visible signed-in time, never sleep, backward clocks or another owner', () => {
  assert.equal(presenceCredit({owner:'a',at:100},'a',30100),30000)
  assert.equal(presenceCredit({owner:'a',at:100},'a',100000),0)
  assert.equal(presenceCredit({owner:'a',at:100},'a',0),0)
  assert.equal(presenceCredit({owner:'a',at:100},'b',30100),0)
  assert.equal(presenceCredit({owner:'a',at:100},null,30100),0)
})
test('authenticated profile persists online time and projects across restart, isolates accounts and rejects stale edits', async () => {
  const home = mkdtempSync(join(tmpdir(),'profile-library-')); let time=1000, owner:string|null='account-a', scans=0
  const options = {rivetHome:home,apiToken:'fixture-profile',now:()=>time,owner:()=>owner,usage:async()=>{scans++;return {total:105,peak:105,activeDays:1,scannedFiles:1}}}
  try {
    let router=createRouter(buildProfileLibraryRoutes(options))
    assert.equal((await router('GET','/profile/overview',undefined)).status,401)
    assert.equal((await router('POST','/profile/presence',{},headers)).status,400)
    await router('POST','/profile/presence',{active:true},headers);time+=30000;await router('POST','/profile/presence',{active:true},headers)
    time+=10000;await router('POST','/profile/presence',{active:false},headers);time+=100000
    let result:any=(await router('GET','/profile/overview',undefined,headers)).body
    assert.equal(result.login.totalMs,40000)
    await router('PUT','/profile/repositories',{profileKey:result.profileKey,repositories:[sample]},headers)
    await Promise.all([router('GET','/profile/overview',undefined,headers),router('GET','/profile/overview',undefined,headers)]);assert.equal(scans,1)
    const aKey=result.profileKey
    owner='account-b';assert.equal((await router('PUT','/profile/repositories',{profileKey:aKey,repositories:[]},headers)).status,409)
    result=(await router('GET','/profile/overview',undefined,headers)).body;assert.deepEqual(result.repositories,[]);assert.equal(result.login.totalMs,0)
    await router('POST','/profile/presence',{active:true},headers);owner='account-a';time+=30000;await router('POST','/profile/presence',{active:true},headers)
    router=createRouter(buildProfileLibraryRoutes(options));result=(await router('GET','/profile/overview',undefined,headers)).body
    assert.equal(result.login.totalMs,40000);assert.equal(result.repositories[0].title,'星图')
    time+=30000;await router('POST','/profile/presence',{active:true},headers)
    result=(await router('GET','/profile/overview',undefined,headers)).body;assert.equal(result.login.totalMs,40000,'restart earns no unobserved time')
    owner=null;result=(await router('GET','/profile/overview',undefined,headers)).body;assert.equal(result.profileKey,'local');assert.deepEqual(result.repositories,[])
  }finally{rmSync(home,{recursive:true,force:true})}
})
test('lifetime Token totals include old logs, workers and cache-inclusive input exactly once',async()=>{
  const home=mkdtempSync(join(tmpdir(),'profile-all-logs-'))
  try{
    const root=join(home,'sessions','project')
    for(const [id,input,output,t] of [['main',100,5,Date.now()],['worker-one',200,10,new Date(2020,0,1).getTime()]] as const){const dir=join(root,id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'cache-log.jsonl'),JSON.stringify({t,input,output,cacheRead:input,cacheCreate:input,model:'fixture'})+'\n')}
    const router=createRouter(buildProfileLibraryRoutes({rivetHome:home,apiToken:'fixture-profile',owner:()=>null}))
    const result:any=(await router('GET','/profile/overview',undefined,headers)).body
    assert.equal(result.tokens.total,315);assert.equal(result.tokens.peak,210);assert.equal(result.tokens.activeDays,2)
  }finally{rmSync(home,{recursive:true,force:true})}
})
test('statistics failures preserve stored works and can retry; delayed reads cannot leak the previous account',async()=>{
  const home=mkdtempSync(join(tmpdir(),'profile-failure-'));let owner='a',fail=true
  try{
    const router=createRouter(buildProfileLibraryRoutes({rivetHome:home,apiToken:'fixture-profile',owner:()=>owner,usage:async()=>{if(fail)throw new Error('disk');return {total:0,peak:0,activeDays:0,scannedFiles:0}}}))
    const first:any=(await router('GET','/profile/overview',undefined,headers)).body
    assert.equal(first.tokens,null)
    await router('PUT','/profile/repositories',{profileKey:first.profileKey,repositories:[sample]},headers)
    assert.equal(((await router('GET','/profile/overview',undefined,headers)).body as any).repositories.length,1)
    fail=false;assert.equal(((await router('GET','/profile/overview',undefined,headers)).body as any).tokens.total,0)
    let resolve!:()=>void
    const delayed=createRouter(buildProfileLibraryRoutes({rivetHome:home,apiToken:'fixture-profile',owner:()=>owner,usage:async()=>{await new Promise<void>(r=>{resolve=r});return {total:1,peak:1,activeDays:1,scannedFiles:1}}}))
    const waiting=delayed('GET','/profile/overview',undefined,headers);owner='b';resolve();assert.equal((await waiting).status,409)
  }finally{rmSync(home,{recursive:true,force:true})}
})
