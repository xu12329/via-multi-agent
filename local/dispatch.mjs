export function uniqueDispatch(start) {
  const pending = new Map()
  return ({ requestId, ...args }) => {
    if (!requestId) return start(args)
    if (!/^[\w-]{1,100}$/.test(requestId)) throw Error('Invalid dispatch request ID')
    const key = JSON.stringify(Object.keys(args).sort().map(name => [name, args[name]]))
    const previous = pending.get(requestId)
    if (previous) {
      if (previous.key !== key) throw Error('Dispatch request ID was already used with different input')
      return previous.result
    }
    if (pending.size >= 500) throw Error('This Via session has reached its dispatch limit')
    const result = Promise.resolve().then(() => start(args)).catch(error => {
      pending.delete(requestId)
      throw error
    })
    pending.set(requestId, { key, result })
    return result
  }
}
