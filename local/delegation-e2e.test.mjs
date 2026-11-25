import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

test('real Concord carries plan, direct review wake, leaf result, and coordinator evidence', async t => {
  const home = await mkdtemp(join(tmpdir(), 'via-board-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const work = join(home, 'workspace')
  const runtime = join(home, 'runtime')
  await mkdir(work)
  await cp(dirname(fileURLToPath(import.meta.url)), runtime, { recursive: true })
  for (const name of ['.local/bin/codex', '.local/bin/agy']) {
    const binary = join(home, name)
    await mkdir(dirname(binary), { recursive: true })
    await writeFile(binary, '')
    await chmod(binary, 0o700)
  }
  await writeFile(join(runtime, 'backend.mjs'), `
    import { connect } from './rpc.mjs'
    export async function readCodexModels() { return { models: [] } }
    export async function openWorker(task, command, session, transport, peer, receive, preferences) {
      Object.assign(task, {
        session: 'fixture-' + task.id,
        selection: { effective: { model: preferences.model, effort: preferences.effort }, nativeConfirmed: true },
      })
      const mcp = connect(peer.command, peer.args, { env: peer.env }, { notify() {}, handle() {}, exit() {} })
      const raw=(name,args)=>mcp.request('tools/call',{name,arguments:args})
      const call=async(name,args)=>{
        const r=await raw(name,args)
        if(r.isError)throw Error(r.content[0].text)
        return r.structuredContent
      }
      return {
        async prompt(text) {
          Object.assign(task,{state:'running',turn:'turn-1'}); try {
          const inbox=async()=> (await call('inspect_work',{agent_id:task.id})).inbox
          if (task.depth===2) {
            const names=(await mcp.request('tools/list',{})).tools.map(x=>x.name)
            if(names.includes('spawn_worker'))throw Error('leaf can discover spawn')
            if(!(await raw('spawn_worker',{worker:'agy',prompt:'denied',requestId:'bad'})).isError)throw Error('leaf escaped')
            task.output='verified leaf result'
          } else if (task.worker==='agy') {
            await new Promise(r=>setTimeout(r,60))
            const received=(await inbox())[0]
            if(text.includes(received.content)) throw Error('wake leaked plan')
            await call('update_work',{operation:'reply',to_agent_id:received.senderAgentId,
              reply_to_message_id:received.messageId,content:'review approved'})
          } else if (text.includes('A requested reply arrived')) {
            const review=(await inbox()).find(m=>m.content==='review approved')
            if(!review?.replyToMessageId || text.includes(review.content))throw Error('review was not scoped')
            const child=task.testChild
            let result
            for(let x=0;x<40;x++) {
              result=await call('child_status',{id:child})
              if(result.state==='completed')break
              await new Promise(r=>setTimeout(r,20))
            }
            if(result.output!=='verified leaf result')throw Error('child result missing')
            await call('update_work',{operation:'prompt',to_agent_id:'coordinator',
              content:'final '+result.output,expects_reply:false,idempotency_key:'final'})
          } else {
            const names=(await mcp.request('tools/list',{})).tools.map(x=>x.name)
            if(!names.includes('spawn_worker'))throw Error('parent cannot discover spawn')
            const args={worker:'agy',prompt:'leaf task',requestId:'same'}
            if(!(await raw('spawn_worker',{...args,depth:0})).isError)throw Error('depth forged')
            const [first,second]=await Promise.all([call('spawn_worker',args),call('spawn_worker',args)])
            if(first.id!==second.id||first.depth!==2||first.parentId!==task.id)throw Error('spawn was not scoped')
            task.testChild=first.id
            await call('update_work',{operation:'prompt',to_agent_id:'agy-1',content:'review request',
              wake_on_reply:true,idempotency_key:'review'})
          }
          task.state='completed'
          task.turn=null
          preferences.onState?.(task,'turn_finished')
          if(task.worker==='agy')receive({}); } catch (error) { task.output=error.message; throw error }
        },
        async steer() { return {accepted:false} },
        close: mcp.close,
      }
    }
  `)
  function controller() {
    const child = spawn(process.execPath, [join(runtime, 'server.mjs')], {
      env: { ...process.env, HOME: home, VIA_WORKSPACE: work, VIA_CONCORD_ENTRY: process.env.VIA_CONCORD_ENTRY ??
        fileURLToPath(new URL('../node_modules/@concord-ai/concord-mcp/dist/index.js', import.meta.url)) },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const closed = once(child, 'close')
    t.after(async () => { child.stdin.end(); await closed })
    let seq = 0
    const pending = new Map()
    createInterface({ input: child.stdout }).on('line', line => {
      const event = JSON.parse(line)
      pending.get(event.id)?.(event.result)
      pending.delete(event.id)
    })
    return (name, args) => new Promise(resolve => {
      const id = ++seq
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    })
  }
  const call = controller()
  const value = packet => JSON.parse(packet.content[0].text)
  const reviewer = value(await call('start',{worker:'agy',group:'alpha',cwd:work,prompt:'review',activation:'concord'}))
  async function until(predicate) {
    for(let i=0;i<150;i++) {
      const snap=value(await call('board',{group:'alpha'}))
      if(predicate(snap))return snap
      await delay(20)
    }
    assert.fail(JSON.stringify(value(await call('board',{group:'alpha'}))))
  }
  await until(x=>x.tasks[0]?.state==='waiting_inbox')
  const main=value(await call('start',{worker:'codex',group:'alpha',cwd:work,prompt:'main'}))
  const done=await until(x=>x.peerEvents.some(m=>m.text==='final verified leaf result'))
  assert.equal(done.tasks.length,3)
  assert.equal(done.tasks.find(t=>t.id===main.id).autoWake.mode,'same_session_next_turn')
  assert.equal(done.peerEvents.find(m=>m.text==='review approved').from,reviewer.id)
  assert.equal((await call('coordinator_inbox',{cwd:work,group:'other'})).isError,true)
  const findings=value(await call('coordinator_inbox',{cwd:work,group:'alpha'}))
  assert.deepEqual(findings.inbox.map(m=>m.content),['final verified leaf result'])
  const board=value(await call('board',{group:'alpha'}))
  assert.ok(board.peerEvents.find(m=>m.text==='final verified leaf result').readAt)
})
