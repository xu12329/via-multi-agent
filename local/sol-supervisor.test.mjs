import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSolSupervisor } from './sol-supervisor.mjs'

const scope = { cwd:'/isolated/project',sessionId:'one',group:'same-name',runId:'one' }
const sibling = { ...scope, sessionId:'two' }
const event = (kind, extra = {}) => ({kind,workerId:'codex-1',turnId:'turn-1',...extra})

test('disconnect does not rewrite known backend state or restart work', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'via-supervisor-'))
  t.after(()=>rm(stateDir,{recursive:true,force:true}))
  const notices=[],wakes=[]
  const make=()=>createSolSupervisor({stateDir,now:()=>1000,wake:item=>{wakes.push(item);return {accepted:true}},notify:n=>notices.push(n)})
  let v=make()
  v.observe(scope,event('started',{at:100}))
  v.observe(scope,event('backend_state',{state:'running',at:200}))
  v.observe(scope,event('stream_lost',{at:300}))
  v.observe(scope,event('worker_error',{at:400}))
  assert.equal(v.snapshot(scope,'codex-1').background,'running')
  assert.equal(v.snapshot(scope,'codex-1').turn,'worker_error')
  assert.equal(v.snapshot(scope,'codex-1').process,'unknown')
  assert.equal(v.snapshot(sibling,'codex-1').background,'unknown')
  assert.equal(v.observe(scope,event('worker_error',{at:500})).recorded,false)
  await v.close()
  v=make()
  assert.equal(v.observe(scope,event('worker_error',{at:600})).recorded,false)
  assert.deepEqual(notices.map(x=>x.event.kind),['stream_lost','worker_error'])
  assert.deepEqual(wakes,[])
  v.observe(sibling,event('worker_error',{at:700}))
  await v.close()
  assert.equal(wakes.length,1)
  assert.equal(wakes[0].scope.sessionId,'two')
})

test('approved stall deadline is persisted and claimed once, even after uncertain dispatch', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'via-supervisor-'))
  t.after(()=>rm(stateDir,{recursive:true,force:true}))
  let attempted=0
  const make=()=>createSolSupervisor({stateDir,now:()=>1000,wake(){attempted++;throw Error('lost acknowledgement')}})
  let v=make()
  v.observe(scope,event('started',{at:100}))
  v.observe(scope,event('heartbeat',{at:650}))
  const deadline = {workerId:'codex-1',turnId:'turn-1',leaseId:'approved-deadline',deadline:500}
  assert.equal(v.checkStalled(scope,deadline).wake,'claimed')
  await v.close()
  v=make()
  assert.equal(v.checkStalled(scope,deadline).wake,'duplicate')
  assert.equal(v.snapshot(scope,'codex-1').wakes[0].phase,'uncertain')
  await v.close()
  assert.equal(attempted,1)
})

test('durable completion is a notice; a fresh failure contains only safe evidence', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'via-supervisor-'))
  t.after(()=>rm(stateDir,{recursive:true,force:true}))
  const notifications=[], wake=[]
  const v=createSolSupervisor({ stateDir, notify:entry=>notifications.push(entry),
    wake:entry=>{wake.push(entry);return {accepted:true}} })
  v.observe(scope,event('started',{at:100}))
  v.observe(scope,event('completed',{at:200}))
  v.observe(scope,event('worker_error',{at:150,diagnostic:'late event with untrusted body'}))
  v.observe(scope,event('backend_state',{at:210,state:'completed'}))
  v.observe(scope,event('backend_state',{at:220,state:'completed'}))
  v.observe(scope,event('started',{turnId:'turn-2',at:230}))
  v.observe(scope,event('worker_error',{turnId:'turn-2',at:250,diagnostic:'response_stream_lost'}))
  await v.close()
  assert.equal(wake.length,1)
  assert.equal(wake[0].event.turnId,'turn-2')
  assert.equal(wake[0].event.diagnostic,'response_stream_lost')
  assert.equal(notifications.find(x=>x.event.at===150).event.diagnostic,null)
  assert.equal(notifications.filter(x=>x.event.kind==='backend_state').length,1)
})

test('group review starts once across distinct workers and a restart', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'via-supervisor-'))
  t.after(()=>rm(stateDir,{recursive:true,force:true}))
  const wakes=[]
  const make=()=>createSolSupervisor({stateDir,wake:item=>{wakes.push(item);return {accepted:true}}})
  let v=make()
  const final = event('review_ready',{eventId:'group-final'})
  assert.equal(v.observe(scope,final).wake,'claimed')
  assert.equal(v.observe(scope,{...final,workerId:'agy-2',turnId:'different'}).wake,'duplicate')
  await v.close()
  v=make()
  assert.equal(v.observe(scope,{...final,workerId:'agy-3'}).wake,'duplicate')
  assert.equal(v.snapshot(scope,'@group').wakes[0].phase,'accepted')
  await v.close()
  assert.equal(wakes.length,1)
})

test('late worker_error arriving with wall-clock at after completed turn is recorded for audit but does not wake', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'via-supervisor-'))
  t.after(()=>rm(stateDir,{recursive:true,force:true}))
  const notifications=[], wakes=[]
  const v=createSolSupervisor({ stateDir, notify:entry=>notifications.push(entry),
    wake:entry=>{wakes.push(entry);return {accepted:true}} })
  v.observe(scope,event('started',{at:100}))
  v.observe(scope,event('completed',{at:200}))
  const late = v.observe(scope,event('worker_error',{at:250,diagnostic:'late_error_after_completion'}))
  await v.close()
  assert.deepEqual(late,{recorded:true,wake:'none'})
  assert.deepEqual(wakes,[])
  assert.equal(notifications.filter(x=>x.event.kind==='worker_error').length,1)
})
