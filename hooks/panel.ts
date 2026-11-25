import type { EngineInterface, Register } from 'claude-code'

const PANE = 'via-panel'
type Worker = 'codex' | 'agy'
type Method = 'board' | 'models' | 'start' | 'status' | 'steer' | 'followup' | 'review_approval'
type Choice = { value: string; label: string; nativeModel?: string }
type Model = { value: string; label: string; efforts: Choice[]; defaultEffort?: string }
type Selection = { model?: string | null; effort?: string | null }
type Permission = {
  requestId: string; worker: Worker; action: string; scope: string; status: string; expiresAt: number
  allowOnce?: boolean; interaction?: 'native_prompt' | 'unavailable'; actionName?: string
}
type Task = {
  id: string; group: string; worker: Worker; state: string; turn?: string | null; prompt?: string; output?: string; diagnostic?: string
  role?: string; depth?: number; parentId?: string | null; supervisor?: boolean
  peer?: { enrolled?: boolean; backendReady?: boolean; authenticatedAt?: number }
  permissionSummary?: { kind?: string }
  approvals?: Permission[]
  permissionMode?: { requested?: string; effective?: string | null }
  selection?: { effective?: Selection | null; requested?: Selection | null; nativeConfirmed?: boolean }
}
type Message = {
  id: string; group: string; from: string; to: string; text: string; source: string; sentAt: number; delivery: string; readAt?: number; providerPhase?: string; replyTo?: string
  summary?: string | null; summaryStatus?: string; forCoordinator?: boolean
}
type Board = { controllerId?: string; observedAt?: number; unreadCoordinatorCount?: number; groups: string[]; tasks: Task[]; peerEvents: Message[] }
type Catalog = {
  defaults?: Selection
  models: { id: string; name?: string; efforts?: string[]; defaultEffort?: string }[]
}

const workerLabel = { codex: 'Codex', agy: 'Antigravity' }
const effortLabel: Record<string, string> = {
  low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高', native: '原生默认',
}
const taskLabel: Record<string, string> = {
  starting: '启动中', running: '运行中', waiting_inbox: '等待组内消息', peer_action: '正在收发消息', completed: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断', permission_required: '审批未通过',
}
const deliveryLabel: Record<string, string> = {
  queued_registration: '等待 AGY 注册', queued: '等待投递', accepted_live: '已送入运行', completed_native: '原生交付完成', sent: '已入库，等待投递', delivered: '已投递至会话',
  read: '已取信', replied: '收到关联回信', failed: '投递失败', expired: '消息已过期',
}
const diagnosticLabel: Record<string, string> = {
  approval_not_granted: '有操作未获批准。可调整任务后续聊。',
  no_assistant_output_or_tool_result: '本轮结束，未收到正文或已完成的工具结果。',
  tool_completed_without_assistant_text: '工具已完成，模型未返回正文。',
  tool_failed_without_assistant_text: '工具失败，模型未返回正文。',
  peer_delivery_incomplete: '消息尚未确认送达。请查看消息板。',
}

const permissionState: Record<string, string> = {
  pending: '等待审批', allowed_once: '已允许一次', rejected: '已拒绝', cancelled: '已取消', expired: '审批已超时',
}
const permissionAction: Record<string, string> = {
  read: '读取', edit: '编辑文件', delete: '删除', move: '移动', search: '搜索', execute: '执行终端命令',
  concord_inbox: 'Concord 取信', concord_messaging: 'Concord 发信或回复',
  concord_send: 'Concord 发信', concord_reply: 'Concord 回复',
  think: '推理', fetch: '获取资源', switch_mode: '切换模式', permissions: '请求额外权限', unknown: '动作未识别',
}
const permissionScope: Record<string, string> = {
  project_cwd: '工作目录是当前项目，操作范围待核实', group_concord: '仅限当前组的 Concord 工具',
  unknown: '操作范围未核实',
}
export function messageStatus(message: Message) {
  const phase = message.providerPhase ?? message.delivery
  const text = deliveryLabel[phase] ?? '状态未确认'
  const reply = message.replyTo ? '关联回信 · ' : ''
  if (phase === 'read') return reply + text
  if (phase === 'replied') return [message.readAt ? '已取信' : '', text].filter(Boolean).join(' · ')
  if (message.replyTo && ['sent', 'queued', 'delivered'].includes(phase) && !message.readAt) return `${reply}${text} · 接收会话尚未取信`
  return message.readAt ? `${reply}${text} · 已取信` : reply + text
}

export function modelOptions(worker: Worker, catalog: Catalog): Model[] {
  if (worker === 'codex') {
    return catalog.models.map(({ id, name, efforts, defaultEffort }) => ({
      value: id, label: name ?? id, defaultEffort,
      efforts: efforts?.map(value => ({ value, label: effortLabel[value] ?? value })) ?? [],
    }))
  }
  const models = new Map<string, Model>()
  for (const { id, name } of catalog.models) {
    const match = id.match(/^(.+)-(low|medium|high|xhigh|max|ultra)$/)
    const value = match?.[1] ?? id
    const effort = match?.[2] ?? 'native'
    const label = name?.replace(/ \((Low|Medium|High|Extra High|XHigh|Max|Ultra)\)$/i, '') ?? value
    const model = models.get(value) ?? { value, label, efforts: [] }
    if (!model.efforts.some(choice => choice.value === effort)) {
      model.efforts.push({ value: effort, label: effortLabel[effort] ?? effort, nativeModel: id })
    }
    models.set(value, model)
  }
  return [...models.values()]
}

export function modelRequest(worker: Worker, model: Model, effort: string) {
  const selected = model.efforts.find(choice => choice.value === effort)
  // An AGY variant may be the whole native model ID, even when its name ends in an effort.
  if (worker === 'agy') return selected?.nativeModel ? { model: selected.nativeModel } : null
  if (model.efforts.length && !selected) return null
  return { model: model.value, ...(selected ? { effort: selected.value } : {}) }
}

function shortName(task: Task) {
  const first = task.prompt?.trim().split('\n')[0] || task.id
  const chars = Array.from(first)
  return chars.length > 26 ? chars.slice(0, 26).join('') + '…' : first
}

function roleTag(task: Task) {
  if (task.supervisor || task.role === 'supervisor') return ' · [监管]'
  if (task.depth === 2 || task.role === 'leaf') return ` · [叶代理 ← ${task.parentId ?? '父代理'}]`
  return ''
}

function chooseEffort(model?: Model, preferred?: string | null) {
  return model?.efforts.find(({ value }) => value === preferred)?.value
    ?? model?.efforts.find(({ value }) => value === model.defaultEffort)?.value
    ?? model?.efforts[0]?.value ?? ''
}

type WireResult = { deny?: string; result?: unknown }

export function unwrapPanelReply(reply: WireResult): unknown {
  if (reply.deny || reply.result == null) throw Error('Via 控制器未能响应。')
  const payload = reply.result as { isError?: boolean; content?: { type: string; text?: string }[] }
  const blocks = Array.isArray(payload) ? payload : payload.content
  const wire = blocks?.find(part => part.type === 'text')?.text
  if (payload.isError) throw Error(wire || 'Via 操作失败。')
  return wire === undefined ? payload : JSON.parse(wire)
}

export function panelApi($: EngineInterface) {
  return {
    sessionId: () => $.session.id(),
    cwd: () => $.session.cwd(),
    redraw: () => $.ui.invalidate('ui.render'),
    panes: () => $.ui.panes(),
    register: () => $.command.register({ name: PANE, description: '打开 Via 任务面板', immediate: true }),
    watch: (fn: () => Promise<void>) => $.clock.every(2000, fn),
    call: (tool: string, toolUseId: string, args: Record<string, unknown>) =>
      $.tool.call({ tool, tool_use_id: toolUseId, ...args } as never),
  }
}

type PanelApi = ReturnType<typeof panelApi>
let initPanel: ((api: PanelApi) => Promise<void>) | undefined

export async function initializePanel(api: PanelApi) {
  await initPanel?.(api)
}

export function registerPanel(on: Parameters<Register>[0]) {
  let board: Board | undefined
  let group = ''
  let selected = ''
  let selectedOutput: { id: string; text: string } | undefined
  let worker: Worker = 'codex'
  let models: Model[] = []
  let model = ''
  let effort = ''
  let draft = ''
  let instruction = ''
  let dispatch = false
  let starting = false
  let sending = false
  let reviewInFlight = ''
  let loading = false
  let refreshing = false
  let loadingRevision = 0
  let refreshRevision = 0
  let serial = 0
  let startKey = ''
  let boardError = ''
  let modelError = ''
  let actionMessage = ''
  let opened = false
  let panelSession = ''
  const catalogCache = new Map<string, { recordedAt: number; catalog: Catalog }>()

  async function request<T>(api: PanelApi, method: Method, args: Record<string, unknown>) {
    const session = panelSession
    if (!session || await api.sessionId() !== session) throw Error('会话已切换。')
    const reply = await api.call(`mcp__plugin_via_workers__${method}`, `via-panel-${Date.now()}-${++serial}`, args)
    if (session !== panelSession || await api.sessionId() !== session) throw Error('会话已切换。')
    return unwrapPanelReply(reply as WireResult) as T
  }

  async function readOutput(api: PanelApi, task: Task, background = false) {
    try {
      const detail = await request<Task>(api, 'status', { id: task.id, group: task.group })
      if ((!background || !dispatch) && selected === task.id && group === task.group) {
        selectedOutput = { id: task.id, text: detail.output ?? '' }
        api.redraw()
      }
    } catch {
      // The board still contains the worker's latest output preview.
    }
  }

  async function refresh(api: PanelApi, explicitGroup = group, background = false) {
    const revision = ++refreshRevision
    refreshing = true
    try {
      const result = await request<Board>(api, 'board', explicitGroup ? { group: explicitGroup } : {})
      if (revision !== refreshRevision || (background && dispatch)) return
      if (board?.controllerId && result.controllerId && board.controllerId !== result.controllerId) {
        selected = instruction = startKey = ''
        selectedOutput = undefined
      }
      group = explicitGroup && result.groups.includes(explicitGroup) ? explicitGroup : result.groups.at(-1) || ''
      if (explicitGroup && group && group !== explicitGroup) {
        await refresh(api, group, background)
        return
      }
      board = group ? {
        ...result,
        tasks: result.tasks.filter(task => task.group === group),
        peerEvents: result.peerEvents.filter(message => message.group === group),
      } : result
      const active = board.tasks.find(task => task.id === selected)
      if (active) void readOutput(api, active, background)
      else selected = ''
      boardError = ''
    } catch {
      if (revision === refreshRevision && (!background || !dispatch)) boardError = '无法读取 Via 任务。可重试。'
    } finally {
      if (revision === refreshRevision) {
        refreshing = false
        if (!background || !dispatch) api.redraw()
      }
    }
  }

  async function loadModels(api: PanelApi, nextWorker: Worker) {
    const revision = ++loadingRevision
    worker = nextWorker
    startKey = ''
    models = []
    model = ''
    effort = ''
    loading = true
    modelError = ''
    api.redraw()

    try {
      const cwd = await api.cwd()
      const key = nextWorker + ':' + cwd
      const cached = catalogCache.get(key)
      const catalog = cached && Date.now() - cached.recordedAt < 15_000
        ? cached.catalog : await request<Catalog>(api, 'models', { worker: nextWorker, cwd })
      catalogCache.set(key, { recordedAt: cached?.catalog === catalog ? cached.recordedAt : Date.now(), catalog })
      if (revision !== loadingRevision) return
      models = modelOptions(nextWorker, catalog)
      const selected = models.find(entry => entry.value === catalog.defaults?.model) ?? models[0]
      model = selected?.value ?? ''
      effort = chooseEffort(selected, catalog.defaults?.effort)
    } catch {
      if (revision === loadingRevision) modelError = '无法读取原生模型清单。'
    } finally {
      if (revision === loadingRevision) {
        loading = false
        api.redraw()
      }
    }
  }

  async function start(api: PanelApi) {
    if (!board || starting || loading || !model || !draft.trim()) return
    const current = models.find(entry => entry.value === model)
    const selection = current && modelRequest(worker, current, effort)
    if (!selection) return
    starting = true
    actionMessage = ''
    api.redraw()
    try {
      const targetGroup = group || 'Via'
      startKey ||= `via-panel-start-${Date.now()}-${++serial}`
      const task = await request<Task>(api, 'start', {
        worker, ...selection, requestId: startKey,
        group: targetGroup, cwd: await api.cwd(), prompt: draft.trim(),
      })
      draft = startKey = ''
      group = targetGroup
      selected = task.id
      dispatch = false
      actionMessage = '已派任务。'
      await refresh(api, targetGroup)
    } catch {
      actionMessage = '任务未确认启动。请刷新任务列表后重试。'
    } finally {
      starting = false
      api.redraw()
    }
  }

  async function send(api: PanelApi, task: Task, live: boolean) {
    if (sending || !instruction.trim()) return
    sending = true
    actionMessage = ''
    api.redraw()
    try {
      const result = await request<{ accepted?: boolean; submitted?: boolean }>(api, live ? 'steer' : 'followup',
        { id: task.id, group: task.group, text: instruction.trim() })
      if (live && result.accepted !== true && result.submitted !== true) {
        actionMessage = '当前回合未接收指令。已保留输入。'
      } else {
        instruction = ''
        actionMessage = live ? (result.submitted ? '插话已提交，等待执行。' : '插话已送入当前回合。') : '已发起续聊。'
      }
      await refresh(api)
    } catch {
      actionMessage = '发送未确认。已保留输入。'
    } finally {
      sending = false
      api.redraw()
    }
  }

  async function reviewApproval(api: PanelApi, task: Task, approval: Permission) {
    if (reviewInFlight || approval.status !== 'pending' || approval.interaction !== 'native_prompt') return
    const requestId = approval.requestId
    const session = panelSession
    reviewInFlight = requestId
    actionMessage = ''
    api.redraw()
    try {
      const result = await request<{ status?: string }>(api, 'review_approval', { id: task.id, group: task.group, requestId })
      if (session === panelSession && group === task.group) actionMessage = permissionState[result.status ?? ''] ?? '已收到审批窗口反馈。'
    } catch {
      if (session === panelSession && group === task.group) actionMessage = '审批窗口未完成。请刷新成员状态。'
    } finally {
      if (reviewInFlight === requestId) reviewInFlight = ''
      if (session === panelSession && group === task.group && opened) await refresh(api, group)
    }
  }

  on('session.end', async ($, e, next) => {
    opened = false
    panelSession = ''
    reviewInFlight = ''
    refreshRevision++
    loadingRevision++
    return next(e)
  })

  on('command.run', { command: PANE }, async ($) => {
    const api = panelApi($)
    const id = await api.sessionId()
    if (panelSession !== id) {
      board = undefined
      group = selected = draft = instruction = actionMessage = boardError = startKey = ''
      refreshRevision++
      loadingRevision++
      loading = refreshing = false
      dispatch = false
      selectedOutput = undefined
      panelSession = id
    }
    await $.ui.open({ id: PANE, title: 'Via 任务组', focus: true, closeOnEscape: true, columns: 56, rows: 24 })
    opened = true
    void refresh(api)
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const api = panelApi($)
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const text = (line: string, bold = false) => Text({ bold, wrap: 'wrap', children: [line] })
    const current = models.find(entry => entry.value === model)
    const editDraft = (value: string) => { if (!starting) { draft = value; startKey = ''; api.redraw() } }
    const editInstruction = (value: string) => { if (!sending) { instruction = value; api.redraw() } }
    const active = board?.tasks.find(task => task.id === selected)
    const live = active?.state === 'running' && !!active.turn
    const canSend = active && !active.approvals?.some(approval => approval.status === 'pending') && (live || ['completed', 'interrupted', 'cancelled', 'permission_required'].includes(active.state))
    const taskRows = board?.tasks.map(task => {
      const effective = task.selection?.effective
      const requested = task.selection?.requested
      const selection = effective ?? requested
      const modelInfo = selection?.model ? (effective ? selection.model : `待确认 ${selection.model}`) : '模型待回报'
      const effortInfo = selection?.effort ?? '原生默认'
      const state = taskLabel[task.state] ?? task.state
      const peer = !task.peer?.enrolled ? '注册未确认' : task.peer.backendReady ? '已接入' : '已注册，待接入' 
      return Button({
        key: task.id,
        label: `${shortName(task)} · ${task.id}${roleTag(task)}\n${workerLabel[task.worker]} · ${modelInfo} · ${effortInfo}\n${state} · ${peer}`,
        onPress: () => {
          if (sending || starting) return
          selected = task.id
          instruction = actionMessage = ''
          selectedOutput = undefined
          api.redraw()
          void readOutput(api, task)
        },
      })
    }) ?? []
    const messages = [...(board?.peerEvents ?? [])]
      .sort((a, b) => a.sentAt - b.sentAt)
      .map(message => {
        const time = new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour12: false })
        const source = message.source === 'controller' ? ' · 控制器转发' : ''
        const status = messageStatus(message)
        const forCoordinator = message.forCoordinator === true || message.to.startsWith('coordinator-')
        const coordTag = forCoordinator ? (message.readAt ? ' · [给Claude]' : ' · [待Claude查看]') : ''
        const summary = message.summary?.trim()
        const summaryLine = summary && summary !== message.text.trim() ? `摘要：${summary}\n` : ''
        return text(`${time}  ${message.from} → ${message.to} · ${status}${source}${coordTag}\n${summaryLine}${message.text}`)
      })
    const unreadCoordinatorCount = board?.unreadCoordinatorCount ?? 0

    return Box({
      flexDirection: 'column', rowGap: 1,
      children: [
        text(group || '当前任务组', true),
        ...(board?.observedAt && !dispatch ? [text(`更新 ${new Date(board.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}`)] : []),
        ...(unreadCoordinatorCount > 0 ? [text(`待 Claude 查看汇报：${unreadCoordinatorCount} 条（使用 coordinator_inbox 或 list 读取）`, true)] : []),
        ...(board?.groups.length && board.groups.length > 1 ? [Select({
          key: 'group', label: '任务组', value: group, options: board.groups.map(value => ({ value, label: value })),
          onSelect: (value: string) => {
            if (starting || sending) return
            group = value
            selected = instruction = startKey = ''
            board = undefined
            api.redraw()
            void refresh(api, value)
          },
        })] : []),
        Button({ key: 'dispatch', label: dispatch ? '收起派任务' : '派任务',
          onPress: () => {
            if (starting) return
            dispatch = !dispatch
            if (dispatch) void loadModels(api, worker)
            else {
              api.redraw()
              void refresh(api)
            }
          } }),
        ...(dispatch ? [
          Select({ key: 'worker', label: 'CLI', value: worker,
            options: Object.entries(workerLabel).map(([value, label]) => ({ value, label })),
            onSelect: (value: string) => { if (!starting && (value === 'codex' || value === 'agy')) void loadModels(api, value) } }),
          ...(loading ? [text('正在读取原生模型…')] : models.length ? [
            Select({ key: 'model', label: '模型', value: model,
              options: models.map(({ value, label }) => ({ value, label })),
              onSelect: (value: string) => {
                if (starting) return
                const entry = models.find(item => item.value === value)
                if (!entry) return
                model = value
                startKey = ''
                effort = chooseEffort(entry, effort)
                api.redraw()
              } }),
            ...(current?.efforts.length ? [Select({ key: 'effort', label: '思考强度', value: effort,
              options: current.efforts.map(({ value, label }) => ({ value, label })),
              onSelect: (value: string) => {
                if (!starting && current.efforts.some(option => option.value === value)) { effort = value; startKey = ''; api.redraw() }
              } })] : [text('思考强度 · 原生默认')]),
          ] : [text(modelError || '这个后端没有返回可用模型。'),
            Button({ key: 'retry-models', label: '重试模型清单', onPress: () => loadModels(api, worker) })]),
          Input({ key: 'task', label: '任务说明', rows: 3, value: draft,
            onInput: editDraft, onSubmit: editDraft }),
          ...(starting ? [text('正在派任务…')] : [Button({ key: 'start', label: '开始', disabled: !board || loading || !model || !draft.trim(), onPress: () => start(api) })]),
        ] : []),
        ...(actionMessage ? [text(actionMessage)] : []),
        ...(boardError ? [text(boardError), Button({ key: 'retry-board', label: '重试', onPress: () => refresh(api) })] : []),
        ...(!dispatch ? [Box({
          flexDirection: (e.props?.bodyColumns ?? 0) >= 52 ? 'row' : 'column',
          columnGap: 2, rowGap: 1,
          children: [
            Box({ flexDirection: 'column', flexGrow: 1, rowGap: 1,
              children: [text('成员', true), ...(taskRows.length ? taskRows : [text(board ? '还没有任务。' : '正在读取任务…')])] }),
            Box({ flexDirection: 'column', flexGrow: 2, rowGap: 1,
              children: [text('消息板', true), ...(messages.length ? messages : [text('还没有组内消息。')])] }),
          ],
        }),
        ...(active ? [
          text(`${shortName(active)} · ${active.id}`, true),
          ...(active.diagnostic ? [text(diagnosticLabel[active.diagnostic] ?? `诊断 · ${active.diagnostic}`)] : []),
          ...(active.approvals ?? []).flatMap(approval => [
            text(`${permissionAction[approval.action] ?? '工具操作'}${approval.actionName ? ' · ' + approval.actionName : ''} · ${permissionState[approval.status] ?? '状态未确认'}`),
            text(permissionScope[approval.scope] ?? permissionScope.unknown),
            ...(approval.status === 'pending' ? approval.interaction === 'native_prompt' ? [
              Button({ key: `review-${approval.requestId}`, label: reviewInFlight === approval.requestId ? '等待审批窗口…' : '打开审批窗口',
                disabled: Boolean(reviewInFlight), onPress: () => reviewApproval(api, active, approval) }),
            ] : [text('当前会话没有可用审批入口。到期后可调整任务再续聊。')] : []),
          ]),
          ...(!active.approvals?.length && active.permissionSummary?.kind ? [text(
            `最近的审批请求 · ${permissionAction[active.permissionSummary.kind] ?? '工具操作'}`
          )] : []),
          ...(active.permissionMode?.effective ? [text(`原生权限模式 · ${active.permissionMode.effective}`)] : []),
          text((selectedOutput?.id === active.id ? selectedOutput.text : active.output) || '尚无输出。'),
          ...(selectedOutput?.id !== active.id && active.output?.length === 6000 ? [text('正在读取完整输出。')] : []),
          ...(canSend ? [
            Input({ key: 'instruction', label: live ? '插话指令' : '续聊内容', rows: 2, value: instruction,
              onInput: editInstruction, onSubmit: editInstruction }),
            ...(sending ? [text('发送中…')] : [Button({ key: 'send', label: live ? '发送插话' : '开始续聊',
              onPress: () => send(api, active, Boolean(live)) })]),
          ] : []),
        ] : []),
        ] : []),
      ],
    })
  })

  initPanel = async (api: PanelApi) => {
    await api.register()
    api.watch(async () => {
      if (!opened || refreshing || await api.sessionId() !== panelSession) return
      let panes
      try { panes = await api.panes() } catch { return }
      if (Array.isArray(panes) && !panes.some(pane => pane.id === PANE)) {
        opened = false
        return
      }
      if (!dispatch) await refresh(api, group, true)
    })
  }
}
