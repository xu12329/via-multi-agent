import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openHistory } from './history.mjs'
import { mailSummaries } from './mail-summaries.mjs'
import { summarizeMailWithEvidence } from './mail-summary-provider.mjs'

test('mail summary provider fails clearly when configuration env vars are missing', async () => {
  await assert.rejects(
    summarizeMailWithEvidence({ text: 'hello' }, { env: {} }),
    /Summary provider configuration is unavailable/,
  )
})

test('mail summaries stay scoped and never restart an ambiguous or unclaimed older job', async t => {
  const path = await mkdtemp(join(tmpdir(),'via-mail-'))
  t.after(() => rm(path,{recursive:true,force:true}))
  const group = { cwd:'/fixture', group:'one', id:'codex-1' }
  const other = { ...group, group:'other' }
  const event = id => ({ id:String(id), from:'codex-1', to:'codex-2', text:'fixture', sentAt:Number(id), delivery:'queued' })
  const start = await openHistory(path,'one',Date.now,{sessionScoped:true,mail:true})
  start.worker(group,'dispatch_accepted')
  for (let i=1; i<=22; i++) start.evidence(group,'message_sent',event(i),undefined,true)
  start.evidence(other,'message_sent',event(23),undefined,true)
  assert.equal(start.evidence(group,'message_sent',event(1),undefined,true),false)
  assert.equal(start.claimSummary(group,'21'),true)
  assert.equal(start.claimSummary(group,'21'),false)
  assert.equal(start.claimSummary(group,'22'),true)
  start.settleSummary(group,'22','ready','Verified fixture summary',{})
  start.evidence(group,'message_read',{...event(22),delivery:'read'},Date.now())
  start.close()

  const opened = await openHistory(path,'two',Date.now,{sessionScoped:true,mail:true})
  t.after(() => opened.close())
  const recent = opened.recentMail('/fixture','one',20)
  assert.deepEqual(recent.map(row=>row.id),Array.from({length:20},(_,index)=>String(index+3)))
  assert.deepEqual(recent.slice(-3).map(row=>row.summaryStatus),['not_started','uncertain','ready'])
  assert.equal(recent.at(-1).status,'read')
  assert.equal(opened.recentMail('/fixture','other',20).length,1)

  let requests=0
  const jobs=mailSummaries(opened,async () => {
    requests++
    throw Error('Summary completion request failed')
  })
  jobs.enqueue(group,event(20),{text:'ignored',attachments:[]})
  opened.evidence(group,'message_sent',event(24),undefined,true)
  jobs.enqueue(group,event(24),{text:'fixture',attachments:[]})
  jobs.enqueue(group,event(24),{text:'duplicate',attachments:[]})
  for (let i=0; i<20 && !requests; i++) await delay(5)
  await delay(15)
  assert.equal(requests,1)
  assert.equal(opened.recentMail('/fixture','one',1)[0].summaryStatus,'uncertain')
  jobs.close()
})

test('mail summaries accept short and long summaries without 20-50 word truncation, invoke onSettled, and retry transient failures', async t => {
  const path = await mkdtemp(join(tmpdir(),'via-mail-'))
  t.after(() => rm(path,{recursive:true,force:true}))
  const group = { cwd:'/fixture', group:'one', id:'codex-1' }
  const event = id => ({ id:String(id), from:'codex-1', to:'codex-2', text:'fixture', sentAt:Number(id), delivery:'queued' })
  const history = await openHistory(path,'run-1',Date.now,{sessionScoped:true,mail:true})
  t.after(() => history.close())
  history.worker(group,'dispatch_accepted')

  const settled = []
  const shortSummary = 'Approved implementation plan.'
  const longSummary = Array.from({ length: 65 }, (_, i) => `word${i}`).join(' ')
  const responses = [
    async () => ({ httpStatus: 200, diagnostic: null, summary: `  ${shortSummary}  ` }),
    async () => ({ httpStatus: 200, diagnostic: null, summary: longSummary }),
  ]
  let idx = 0
  const jobs = mailSummaries(history, async () => responses[idx++](), {
    concurrency: 2,
    onSettled(task, id, state, summaryText, evidence) {
      settled.push({ taskId: task.id, id, state, summaryText, evidence })
    },
  })

  history.evidence(group,'message_sent',event(1),undefined,true)
  jobs.enqueue(group,event(1),{text:'short',attachments:[]})
  history.evidence(group,'message_sent',event(2),undefined,true)
  jobs.enqueue(group,event(2),{text:'long',attachments:[]})

  for (let i=0; i<50 && settled.length < 2; i++) await delay(10)
  jobs.close()

  assert.equal(settled.length, 2)
  const byId = Object.fromEntries(settled.map(item => [item.id, item]))
  assert.equal(byId['1'].state, 'ready')
  assert.equal(byId['1'].summaryText, shortSummary)
  assert.equal(byId['1'].evidence.wordCount, 3)
  assert.equal(byId['2'].state, 'ready')
  assert.equal(byId['2'].summaryText, longSummary)
  assert.equal(byId['2'].evidence.wordCount, 65)

  const recent = history.recentMail('/fixture','one',10)
  assert.deepEqual(recent.map(r => [r.id, r.summaryStatus, r.summary]), [
    ['1', 'ready', shortSummary],
    ['2', 'ready', longSummary],
  ])

  let attempts = 0
  const retrySettled = []
  const retryJobs = mailSummaries(history, async () => {
    attempts++
    if (attempts === 1) throw Error('Summary completion request failed: ECONNRESET')
    return { httpStatus: 200, diagnostic: null, summary: 'Recovered on retry.' }
  }, {
    maxRetries: 1,
    retryDelayMs: 5,
    onSettled(task, id, state, summaryText, evidence) {
      retrySettled.push({ id, state, summaryText, evidence })
    },
  })
  history.evidence(group,'message_sent',event(3),undefined,true)
  retryJobs.enqueue(group,event(3),{text:'retry',attachments:[]})

  for (let i=0; i<50 && retrySettled.length < 1; i++) await delay(10)
  retryJobs.close()

  assert.equal(attempts, 2)
  assert.equal(retrySettled.length, 1)
  assert.equal(retrySettled[0].state, 'ready')
  assert.equal(retrySettled[0].summaryText, 'Recovered on retry.')
  assert.equal(retrySettled[0].evidence.wordCount, 3)
})

test('mail summaries validate concurrency, record errorDetail, execute concurrently, and abort pending retry on close', async t => {
  const path = await mkdtemp(join(tmpdir(),'via-mail-'))
  t.after(() => rm(path,{recursive:true,force:true}))
  const group = { cwd:'/fixture', group:'one', id:'codex-1' }
  const event = id => ({ id:String(id), from:'codex-1', to:'codex-2', text:'fixture', sentAt:Number(id), delivery:'queued' })
  const history = await openHistory(path,'run-2',Date.now,{sessionScoped:true,mail:true})
  t.after(() => history.close())
  history.worker(group,'dispatch_accepted')

  assert.throws(() => mailSummaries(history, async () => ({}), { concurrency: 0 }), /concurrency/i)

  const settled = []
  let activeCount = 0
  let maxActiveCount = 0
  const concJobs = mailSummaries(history, async ({ text }) => {
    activeCount++
    maxActiveCount = Math.max(maxActiveCount, activeCount)
    await delay(20)
    activeCount--
    if (text === 'err') throw Error('Summary completion request failed: upstream timeout')
    return { httpStatus: 200, diagnostic: null, summary: `done ${text}` }
  }, {
    concurrency: 2,
    onSettled(task, id, state, summaryText, evidence) {
      settled.push({ id, state, summaryText, evidence })
    },
  })
  history.evidence(group,'message_sent',event(1),undefined,true)
  history.evidence(group,'message_sent',event(2),undefined,true)
  concJobs.enqueue(group,event(1),{text:'ok',attachments:[]})
  concJobs.enqueue(group,event(2),{text:'err',attachments:[]})

  for (let i=0; i<50 && settled.length < 2; i++) await delay(10)
  concJobs.close()
  assert.equal(maxActiveCount, 2)
  const errItem = settled.find(x => x.id === '2')
  assert.equal(errItem.state, 'uncertain')
  assert.equal(errItem.summaryText, null)
  assert.match(errItem.evidence.errorDetail, /upstream timeout/)

  let retryCalls = 0
  const abortJobs = mailSummaries(history, async () => {
    retryCalls++
    throw Error('Summary completion request failed: temporary')
  }, { maxRetries: 2, retryDelayMs: 5000 })
  history.evidence(group,'message_sent',event(3),undefined,true)
  abortJobs.enqueue(group,event(3),{text:'abort',attachments:[]})
  for (let i=0; i<30 && retryCalls === 0; i++) await delay(5)
  await delay(5)
  abortJobs.close()
  await delay(20)
  assert.equal(retryCalls, 1)
})
