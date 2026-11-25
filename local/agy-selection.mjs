import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agyLaunch } from './agy-environment.mjs'

const capture = promisify(execFile)

export async function listAgyModels(binary, cwd) {
  const launch = agyLaunch(binary, ['models'])
  let stdout
  try {
    ({ stdout } = await capture(launch.command, launch.args, {
      cwd, env: launch.env, timeout: 20_000, maxBuffer: 128 * 1024,
    }))
  } catch {
    throw Error('Antigravity did not return a native model list.')
  }
  const models = stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\t([^\t\r]{1,120})$/)
    return match ? [{ id: match[1], name: match[2] }] : []
  })
  if (!models.length) throw Error('Antigravity did not return a native model list.')
  return models
}

const modelAliases = new Map()


function option(state, id) {
  return state?.configOptions?.find(candidate => candidate.id === id)
}

function offers(config, value) {
  return config?.options?.some(candidate => candidate.value === value) === true
}

export async function selectAgy(rpc, sessionId, config, selection = {}) {
  const model = selection.model ?? null
  const effort = selection.effort ?? null
  const requested = { model, effort }
  const modelOption = option(config, 'model')
  if (!modelOption?.currentValue) {
    if (model || effort) throw Error('Antigravity did not report session model configuration. No task was started.')
    return { requested, effective: null, nativeConfirmed: false, providerConfirmed: null }
  }

  const normalized = modelAliases.get(model) ?? model ?? modelOption.currentValue
  const base = offers(modelOption, normalized) ? null : modelOption.options
    ?.map(entry => entry.value)
    .filter(value => typeof value === 'string' && normalized.startsWith(`${value}-`))
    .sort((a, b) => b.length - a.length)[0]
  const targetModel = base ?? normalized
  const suffix = base ? normalized.slice(base.length + 1) : null
  const targetEffort = suffix ?? effort
  if (suffix && effort && effort !== targetEffort) {
    throw Error('Antigravity effort conflicts with the model suffix. Omit effort or use the same value.')
  }
  if (model && !offers(modelOption, targetModel)) {
    throw Error('Antigravity did not list the requested model for this session.')
  }

  async function set(configId, value) {
    const updated = await rpc.request('session/set_config_option', { sessionId, configId, value })
    if (option(updated, configId)?.currentValue !== value) {
      throw Error('Antigravity selected a different configuration than requested. No task was started.')
    }
    return updated
  }

  if (targetModel !== modelOption.currentValue) config = await set('model', targetModel)
  const effortOption = option(config, 'thought_level')
  if (targetEffort && !offers(effortOption, targetEffort)) {
    throw Error('Antigravity did not list the requested effort for this model.')
  }
  if (targetEffort && targetEffort !== effortOption?.currentValue) config = await set('thought_level', targetEffort)

  const confirmedModel = option(config, 'model')?.currentValue
  const confirmedEffort = option(config, 'thought_level')?.currentValue ?? null
  if (confirmedModel !== targetModel || (targetEffort && confirmedEffort !== targetEffort)) {
    throw Error('Antigravity did not confirm the requested model and effort. No task was started.')
  }
  return {
    requested,
    effective: {
      model: confirmedEffort && !confirmedModel.endsWith(`-${confirmedEffort}`) ? `${confirmedModel}-${confirmedEffort}` : confirmedModel,
      effort: confirmedEffort,
    },
    nativeConfirmed: true,
    providerConfirmed: null,
  }
}
