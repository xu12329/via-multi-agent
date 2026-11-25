import { uniqueDispatch } from './dispatch.mjs'

const string = { type: 'string', minLength: 1 }
export const workerTools = [
  { name:'spawn_worker', description:'Delegate to a Via leaf worker in this same project and group. Specify a stable requestId, then use child_status to check peerReady before sending mail and to retrieve the result.',
    inputSchema:{ type:'object', required:['worker','prompt','requestId'], additionalProperties:false,
      properties:{ worker:{ enum:['codex','agy'] }, prompt:string, requestId:string, model:string, effort:string } } },
  { name:'child_status', description:'Read the state and result of one leaf started by you.',
    inputSchema:{ type:'object', required:['id'], additionalProperties:false, properties:{id:string} } },
]
export function createDelegation(start, tasks) {
  const dispatch = new WeakMap()
  const reserved = new WeakMap()
  return async function delegate(parent, name, args) {
    if (parent.depth !== 1 || parent.supervisor || !parent.turn || parent.state !== 'running' || parent.stopRequested || parent.stopReceipt?.state === 'submitted') {
      throw Error('Only an active non-supervisor first-level worker can delegate')
    }
    if (name === 'child_status') {
      if (Object.keys(args).length !== 1 || typeof args.id !== 'string') throw Error('Provide only the child ID')
      const task = tasks.get(args.id)
      if (!task || task.parentId !== parent.id || task.cwd !== parent.cwd || task.group !== parent.group) {
        throw Error('Unknown child of this worker')
      }
      return { id:task.id, state:task.state, output:task.output, peerReady:Boolean(task.peer?.enrolled), diagnostic:task.diagnostic }
    }
    if (name !== 'spawn_worker') throw Error('Unknown delegation tool')
    const fields = workerTools[0].inputSchema
    if (!fields.required.every(key=>Object.hasOwn(args,key)) ||
        Object.entries(args).some(([key,value])=>!Object.hasOwn(fields.properties,key) || typeof value!=='string' || !value.trim()) ||
        !['codex','agy'].includes(args.worker) || args.prompt.length > 6000) throw Error('Invalid delegation arguments')
    if (!dispatch.has(parent)) dispatch.set(parent, uniqueDispatch(async input => {
      const queued = reserved.get(parent) ?? 0
      const count = [...tasks.values()].filter(task=>task.parentId===parent.id).length
      if (count + queued >= 6) throw Error('This worker has reached its child limit')
      reserved.set(parent,queued + 1)
      try {
        return await start({ ...input, cwd:parent.cwd, group:parent.group, permissions:parent.permissions ?? 'full' }, parent)
      } finally {
        reserved.set(parent,reserved.get(parent)-1)
      }
    }))
    return dispatch.get(parent)(args)
  }
}
