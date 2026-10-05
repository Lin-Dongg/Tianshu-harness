import { BrowserOperationError } from './operation-error.js'
/** One operation queue and explicit user ownership per browser conversation. */
const queues = new Map<string, Promise<unknown>>(),
  owners = new Map<string, 'user' | 'agent'>(),
  transitions = new Map<string, Promise<void>>()
export function browserOwner(key: string) {
  return owners.get(key) ?? 'agent'
}
export function setBrowserOwner(key: string, owner: 'user' | 'agent') {
  owners.set(key, owner)
}
export async function browserOperation<T>(
  key: string,
  actor: 'user' | 'agent',
  operation: () => Promise<T>,
): Promise<T> {
  if (transitions.has(key) || actor !== browserOwner(key))
    throw new BrowserOperationError('control_conflict', 'Browser control belongs to ' + browserOwner(key))
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(() => {
      if (transitions.has(key) || actor !== browserOwner(key))
        throw new BrowserOperationError('control_conflict', 'Browser control changed')
      return operation()
    })
  queues.set(key, next)
  try {
    return await next
  } finally {
    if (queues.get(key) === next) queues.delete(key)
  }
}
export async function takeBrowserControl(key: string, owner: 'user' | 'agent', hooks: {
  beforeChange?: () => Promise<void>; afterChange?: () => Promise<void>
} = {}) {
  const previous = transitions.get(key)
  const transfer = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
    await queues.get(key)?.catch(() => {})
    if (browserOwner(key) === owner) return
    await hooks.beforeChange?.()
    setBrowserOwner(key, owner)
    await hooks.afterChange?.()
  })
  transitions.set(key, transfer)
  try { await transfer }
  finally { if (transitions.get(key) === transfer) transitions.delete(key) }
}
