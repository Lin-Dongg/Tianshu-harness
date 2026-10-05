import type { RawSessionEvent } from './cpu-tasks.js'

export interface DelegationSnapshot { events: RawSessionEvent[]; complete: boolean }
/** Bounded control-plane state, independent of the payload replay window. */
export class DelegationStateIndex {
  private running = new Map<string, RawSessionEvent>()
  private complete = true
  private lastSeq = -Infinity
  private readonly capacity: number
  constructor(capacity = 1024) { this.capacity = capacity }
  add(event: RawSessionEvent): void {
    if (event.seq < this.lastSeq) this.complete = false
    this.lastSeq = Math.max(this.lastSeq, event.seq)
    if (event.type !== 'delegation') return
    const data = event.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) { this.complete = false; return }
    const workerId = typeof data.workerId === 'string' ? data.workerId : ''
    if (!workerId) return
    const attemptId = typeof data.attemptId === 'string' ? data.attemptId : undefined
    const dispatchId = typeof data.dispatchId === 'string' ? data.dispatchId : undefined
    if ([workerId, attemptId, dispatchId].some(v => v && v.length > 512)) { this.complete = false; return }
    const key = attemptId || (dispatchId ? `${dispatchId}:${workerId}` : workerId)
    if (['completed', 'failed', 'blocked', 'cancelled', 'aborted'].includes(String(data.status))) {
      this.running.delete(key)
      const legacy = this.running.get(workerId)
      if (legacy && (!legacy.data.parentId || legacy.data.parentId === data.parentId)) this.running.delete(workerId)
      return
    }
    if (data.status !== 'running') return
    const legacy = (attemptId || dispatchId) ? this.running.get(workerId) : undefined
    if (legacy && (!legacy.data.parentId || legacy.data.parentId === data.parentId)) this.running.delete(workerId)
    const prev = this.running.get(key) ?? legacy
    if (!prev && this.running.size >= this.capacity) { this.complete = false; return }
    const safe: Record<string, unknown> = { ...prev?.data, workerId, status: 'running' }
    for (const name of ['attemptId', 'dispatchId', 'parentAttemptId', 'parentId', 'parentWorkerId', 'profile', 'model', 'provider', 'objective', 'origin', 'phase']) {
      if (typeof data[name] === 'string') safe[name] = String(data[name]).slice(0, 512)
    }
    for (const name of ['elapsedMs', 'toolUseCount', 'tokenCount']) {
      if (typeof data[name] === 'number' && Number.isFinite(data[name])) safe[name] = data[name]
    }
    this.running.set(key, { seq: event.seq, ts: prev?.ts ?? event.ts, type: 'delegation', data: safe })
  }
  restore(snapshot: DelegationSnapshot): void {
    this.running.clear(); this.complete = snapshot.complete; this.lastSeq = -Infinity
    for (const event of [...snapshot.events].sort((a,b)=>a.seq-b.seq)) this.add(event)
  }
  snapshot(): DelegationSnapshot { return { events: [...this.running.values()], complete: this.complete } }
}
