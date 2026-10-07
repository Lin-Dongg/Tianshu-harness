import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUpdateRestartRoutes } from '../update-restart-routes.js'
const headers = {authorization:'Bearer test-update-token'}
function fixture() { let busy=true, cancelled=0;const routes=buildUpdateRestartRoutes({updateRestartActivity:()=>({sessions:busy?1:0,tasks:1}),prepareUpdateRestart:async(force,signal)=>{signal.throwIfAborted();if(busy&&!force)throw new Error('UPDATE_BUSY')},cancelUpdateRestart:()=>{cancelled++}},'test-update-token');return {routes,getCancelled:()=>cancelled} }
test('update preparation endpoints require authentication',async()=>{const {routes}=fixture();const r=await routes['POST /runtime/update-prepare']!({}, {}, {} as any);assert.equal(r.status,401)})
test('busy preparation rejects without force, force succeeds and cancellation unlocks',async()=>{const {routes,getCancelled}=fixture();assert.equal((await routes['POST /runtime/update-prepare']!({}, {}, headers)).status,409);assert.equal((await routes['POST /runtime/update-prepare']!({force:true}, {}, headers)).status,200);assert.equal((await routes['POST /runtime/update-prepare']!({force:true}, {}, headers)).status,409);assert.equal((await routes['POST /runtime/update-cancel']!({}, {}, headers)).status,200);assert.ok(getCancelled()>0)})
