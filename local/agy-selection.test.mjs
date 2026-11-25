import assert from 'node:assert/strict'
import test from 'node:test'
import { selectAgy } from './agy-selection.mjs'

function fixture() {
  let model = 'gemini-4-neon'
  let effort = 'high'
  const config = () => ({ configOptions: [
    { id: 'model', currentValue: model, options: ['gemini-4-neon', 'gemini-4-carbon', 'gemini-3.8-flash'].map(value => ({ value })) },
    { id: 'thought_level', currentValue: effort, options: (model === 'gemini-4-neon' ? ['low', 'high', 'xhigh', 'native-new-level'] : ['low', 'high']).map(value => ({ value })) },
  ] })
  const calls = []
  const rpc = { async request(method, params) {
    assert.equal(method, 'session/set_config_option')
    assert.equal(params.sessionId, 'native-session')
    calls.push([params.configId, params.value])
    if (params.configId === 'model') model = params.value
    else effort = params.value
    return config()
  } }
  return { config, calls, rpc }
}

test('reads actual AGY variant back and splits effort suffixes cleanly', async () => {
  const { config, calls, rpc } = fixture()
  const carbon = await selectAgy(rpc, 'native-session', config(), { model: 'gemini-4-carbon-high' })
  assert.deepEqual(carbon.effective, { model: 'gemini-4-carbon-high', effort: 'high' })
  assert.equal(carbon.nativeConfirmed, true)
  assert.equal(carbon.providerConfirmed, null)
  const flash = await selectAgy(rpc, 'native-session', config(), { model: 'gemini-3.8-flash-low' })
  assert.deepEqual(flash.effective, { model: 'gemini-3.8-flash-low', effort: 'low' })
  assert.deepEqual(calls, [['model', 'gemini-4-carbon'], ['model', 'gemini-3.8-flash'], ['thought_level', 'low']])
})

test('fails explicit invalid or conflicting settings without an AGY default fallback', async () => {
  const { config, calls, rpc } = fixture()
  await assert.rejects(selectAgy(rpc, 'native-session', config(), { model: 'gemini-4-carbon-high', effort: 'low' }), /conflicts/)
  await assert.rejects(selectAgy(rpc, 'native-session', config(), { model: 'no-such-model' }), /did not list/)
  assert.equal(calls.length, 0)
  await assert.rejects(selectAgy(rpc, 'native-session', config(), { model: 'gemini-4-carbon-xhigh' }), /did not list the requested effort/)
  assert.deepEqual(calls, [['model', 'gemini-4-carbon']])
  await assert.rejects(selectAgy({ request: async () => ({}) }, 'native-session', config(), { effort: 'low' }), /different configuration/)
})


test('uses the longest native base and accepts a new effort present in its real options', async () => {
  const { config, calls, rpc } = fixture()
  const result = await selectAgy(rpc, 'native-session', config(), { model: 'gemini-4-neon-native-new-level' })
  assert.equal(result.effective.model, 'gemini-4-neon-native-new-level')
  assert.deepEqual(calls, [['thought_level', 'native-new-level']])
})
