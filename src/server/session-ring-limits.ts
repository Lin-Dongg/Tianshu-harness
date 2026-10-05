import type { SessionEvent } from './protocol.js'

const sizes = new WeakMap<SessionEvent, number>()
export function eventByteSize(event: SessionEvent): number {
  const cached = sizes.get(event)
  if (cached !== undefined) return cached
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(event), 'utf8') } catch { bytes = Infinity }
  sizes.set(event, bytes)
  return bytes
}

/** UI replay cache only. Evict a contiguous prefix; never rewrite an event or model history. */
export function applyRingLimits(events: SessionEvent[], maxEvents: number, maxEventBytes: number): SessionEvent[] | null {
  let start = Math.max(0, events.length - Math.max(0, maxEvents))
  if (maxEventBytes > 0) {
    let bytes = 0
    let byteStart = events.length
    for (let i = events.length - 1; i >= start; i--) {
      bytes += eventByteSize(events[i]!)
      if (bytes > maxEventBytes) break
      byteStart = i
    }
    start = Math.max(start, byteStart)
  }
  return start > 0 ? events.slice(start) : null
}
