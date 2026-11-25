const families = {
  sol: /(?:^|-)sol(?:-|$)/i,
  astra: /(?:^|-)astra(?:-|$)/i,
}

export function requestedCodexModel({ model, effort } = {}) {
  return {
    requested: { model: model ?? null, effort: effort ?? null },
    selected: { model: model ?? null, effort: effort ?? process.env.VIA_CODEX_DEFAULT_EFFORT ?? null },
    effective: null,
    providerConfirmed: null,
  }
}

async function* codexCatalog(rpc) {
  let cursor
  do {
    const response = await rpc.request('model/list', { limit: 100, includeHidden: true, cursor })
    yield* response.data
    cursor = response.nextCursor
  } while (cursor)
}

async function configuredModel(rpc, cwd) {
  const { config } = await rpc.request('config/read', { cwd, includeLayers: false })
  return config?.model
}

export async function validateCodexSelection(rpc, selection, cwd) {
  const requestedModel = selection.requested.model ?? process.env.VIA_CODEX_DEFAULT_MODEL ?? null
  const family = requestedModel && Object.hasOwn(families, requestedModel) ? families[requestedModel] : null
  const { effort } = selection.selected
  const configModel = (!requestedModel || family) ? await configuredModel(rpc, cwd) : null
  const target = family ? (family.test(configModel ?? '') ? configModel : null) : (requestedModel ?? configModel ?? null)
  let candidate
  let match
  for await (const entry of codexCatalog(rpc)) {
    if (target && (entry.id === target || entry.model === target)) {
      match = entry
      break
    }
    if (family ? (!entry.hidden && family.test(entry.model)) : (!target && !entry.hidden)) candidate ??= entry
  }
  match ??= candidate
  if (!match) return 'unsupported_model'
  const resolvedEffort = effort ?? (match.supportedReasoningEfforts?.some(option => option.reasoningEffort === match.defaultReasoningEffort) ? match.defaultReasoningEffort : null)
    ?? (match.supportedReasoningEfforts?.some(option => option.reasoningEffort === 'xhigh') ? 'xhigh' : null)
    ?? match.supportedReasoningEfforts?.[0]?.reasoningEffort
    ?? null
  if (!resolvedEffort || !match.supportedReasoningEfforts?.some(option => option.reasoningEffort === resolvedEffort)) return 'unsupported_effort'
  selection.selected = { model: match.model, effort: resolvedEffort }
  return null
}

export async function codexModelOptions(rpc, cwd) {
  const configModel = await configuredModel(rpc, cwd)
  const models = []
  for await (const entry of codexCatalog(rpc)) models.push({
    id: entry.model,
    nativeId: entry.id,
    hidden: entry.hidden === true,
    efforts: entry.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? [],
    defaultEffort: entry.defaultReasoningEffort ?? null,
  })
  const aliases = Object.fromEntries(Object.entries(families).map(([name, pattern]) => {
    const configured = models.find(entry => pattern.test(entry.id) && (entry.id === configModel || entry.nativeId === configModel))
    const first = configured ?? models.find(entry => !entry.hidden && pattern.test(entry.id))
    return [name, first?.id ?? null]
  }))
  const configuredEntry = models.find(entry => entry.id === configModel || entry.nativeId === configModel)
  const defaultEntry = configuredEntry ?? models.find(entry => !entry.hidden) ?? models[0] ?? null
  const defaultEffort = defaultEntry
    ? (defaultEntry.efforts.includes(defaultEntry.defaultEffort) ? defaultEntry.defaultEffort
      : defaultEntry.efforts.includes('xhigh') ? 'xhigh'
      : defaultEntry.efforts[0] ?? null)
    : null
  return { worker: 'codex', source: 'native_catalog', configuredModel: configModel ?? null, defaults: { model: defaultEntry?.id ?? null, effort: defaultEffort }, aliases, models }
}
