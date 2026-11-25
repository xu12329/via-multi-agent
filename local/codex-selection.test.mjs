import assert from 'node:assert/strict'
import test from 'node:test'
import { codexModelOptions, requestedCodexModel, validateCodexSelection } from './codex-selection.mjs'

const listed = (model, hidden = false, efforts = ['xhigh']) =>
  ({ id: model, model, hidden, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) })

test('Codex keeps the configured Sol when later in the native list', async () => {
  const selection = requestedCodexModel()
  const calls = []
  const rpc = { async request(method, params) {
    calls.push([method, params])
    if (method === 'config/read') return { config: { model: 'gpt-future-sol' } }
    return params.cursor ? { data: [listed('gpt-future-sol')] } :
      { data: [listed('gpt-6.1-sol')], nextCursor: 'page-2' }
  } }
  assert.equal(await validateCodexSelection(rpc, selection, '/workspace'), null)
  assert.deepEqual(selection.selected, { model: 'gpt-future-sol', effort: 'xhigh' })
  assert.equal(calls.filter(([method]) => method === 'model/list').length, 2)
})

test('Codex uses configured model by default and still supports Sol/Astra aliases and hidden models', async () => {
  const rpc = { async request(method) {
    if (method === 'config/read') return { config: { model: 'gpt-configured' } }
    return { data: [
      listed('gpt-new-astra'), listed('gpt-configured', false, ['medium', 'xhigh']), listed('gpt-current-sol'), listed('other-account-model', true, ['high']),
    ] }
  } }
  for (const [preferences, model] of [
    [{}, 'gpt-configured'],
    [{ model: 'sol' }, 'gpt-current-sol'],
    [{ model: 'astra' }, 'gpt-new-astra'],
    [{ model: 'other-account-model', effort: 'high' }, 'other-account-model'],
  ]) {
    const selection = requestedCodexModel(preferences)
    assert.equal(await validateCodexSelection(rpc, selection), null)
    assert.equal(selection.selected.model, model)
  }
})

test('model inventory exposes native hidden entries, all efforts and the Via preset', async () => {
  const rpc = { async request(method, params) {
    return method === 'config/read' ? { config: { model: 'gpt-6.1-sol' } } :
      params.cursor ? { data: [listed('all-efforts-astra', true, ['xhigh', 'max', 'ultra'])] } :
      { data: [listed('gpt-6.1-sol')], nextCursor: 'page-2' }
  } }
  const inventory = await codexModelOptions(rpc, '/workspace')
  assert.deepEqual(inventory.defaults, { model: 'gpt-6.1-sol', effort: 'xhigh' })
  assert.deepEqual(inventory.models[1], {
    id: 'all-efforts-astra', nativeId: 'all-efforts-astra', hidden: true,
    efforts: ['xhigh', 'max', 'ultra'], defaultEffort: null,
  })
})
