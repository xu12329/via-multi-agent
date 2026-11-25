import { setTimeout as delay } from 'node:timers/promises'
import { summarizeMailWithEvidence } from './mail-summary-provider.mjs'

const segmenter = new Intl.Segmenter(undefined, { granularity:'word' })

export function mailSummaries(history, summarize = summarizeMailWithEvidence, options = {}) {
  const {
    enabled = true,
    concurrency = 3,
    maxRetries = summarize === summarizeMailWithEvidence ? 1 : 0,
    retryDelayMs = 1500,
    onSettled,
  } = options
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw RangeError('Mail summaries concurrency must be >= 1')
  }
  let closed = false
  let active = 0
  const queue = []
  const inFlight = new Map()

  async function runJob({ task, event, input }, controller) {
    await new Promise(resolve => setImmediate(resolve))
    if (closed || controller.signal.aborted || !history.claimSummary(task, event.id)) return
    let state = 'uncertain'
    let summaryText = null
    let evidence = {}
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (closed || controller.signal.aborted) return
      state = 'uncertain'
      summaryText = null
      evidence = {}
      try {
        const receipt = summarize === summarizeMailWithEvidence
          ? await summarize(input, { signal: controller.signal })
          : await summarize(input)
        const rawSummary = typeof receipt?.summary === 'string' ? receipt.summary.trim() : ''
        const valid = receipt?.httpStatus === 200 && !receipt.diagnostic && rawSummary.length > 0
        const { summary: _ignored, ...rest } = receipt && typeof receipt === 'object' ? receipt : {}
        if (valid) {
          summaryText = rawSummary.length > 600 ? rawSummary.slice(0, 599).trimEnd() + '…' : rawSummary
          const wordCount = [...segmenter.segment(summaryText)].filter(item => item.isWordLike).length
          evidence = { ...rest, wordCount }
          state = 'ready'
          break
        }
        const wordCount = [...segmenter.segment(rawSummary)].filter(item => item.isWordLike).length
        evidence = { ...rest, wordCount }
        state = 'failed'
      } catch (error) {
        if (closed || controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error ?? 'unknown_error')
        if (!message.includes('request failed')) state = 'failed'
        evidence = { errorDetail: message.slice(0, 400) || 'unknown_error' }
      }
      if (attempt < maxRetries && !closed && !controller.signal.aborted) {
        try {
          await delay(retryDelayMs, null, { signal: controller.signal, ref: false })
        } catch {
          return
        }
      }
    }
    if (closed || controller.signal.aborted) return
    history.settleSummary(task, event.id, state, state === 'ready' ? summaryText : null, evidence)
    try {
      onSettled?.(task, event.id, state, state === 'ready' ? summaryText : null, evidence)
    } catch {}
  }

  function pump() {
    while (!closed && active < concurrency && queue.length > 0) {
      const job = queue.shift()
      active++
      const controller = new AbortController()
      const promise = runJob(job, controller)
        .catch(() => {})
        .finally(() => {
          active--
          inFlight.delete(controller)
          pump()
        })
      inFlight.set(controller, promise)
    }
  }

  return {
    enabled,
    enqueue(task, event, input) {
      if (!enabled || closed) return
      queue.push({ task, event, input })
      pump()
    },
    close() {
      closed = true
      queue.length = 0
      for (const controller of inFlight.keys()) controller.abort()
    },
  }
}
