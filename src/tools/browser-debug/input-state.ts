import type { BrowserInputEvent } from './driver.js'
import { BrowserOperationError } from './operation-error.js'

const types = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel', 'keyDown', 'keyUp', 'char'])
export function validateBrowserInput(value: unknown): BrowserInputEvent {
  const e = value as BrowserInputEvent | null
  const invalid = () => { throw new BrowserOperationError('invalid_input', 'Invalid browser input event') }
  if (!e || !types.has(e.type)) return invalid()
  for (const key of ['x', 'y', 'deltaX', 'deltaY'] as const) {
    if (e[key] !== undefined && (typeof e[key] !== 'number' || !Number.isFinite(e[key]))) return invalid()
  }
  for (const key of ['buttons', 'modifiers', 'clickCount'] as const) {
    if (e[key] !== undefined && (!Number.isInteger(e[key]) || e[key]! < 0 || e[key]! > (key === 'clickCount' ? 3 : key === 'buttons' ? 31 : 15))) return invalid()
  }
  if (e.button !== undefined && !['left', 'right', 'middle', 'none'].includes(e.button)) return invalid()
  for (const key of ['key', 'code', 'text'] as const) {
    if (e[key] !== undefined && (typeof e[key] !== 'string' || e[key]!.length > 100000)) return invalid()
  }
  if (e.type.startsWith('mouse') && (e.x === undefined || e.y === undefined)) return invalid()
  if (e.type === 'mouseWheel' && (e.deltaX === undefined || e.deltaY === undefined)) return invalid()
  if (e.type.startsWith('key') && !e.key) return invalid()
  return e
}

export class BrowserInputState {
  private buttons = new Map<string, BrowserInputEvent>()
  private keys = new Map<string, BrowserInputEvent>()
  record(event: BrowserInputEvent) {
    if (event.type === 'mousePressed' && event.button && event.button !== 'none') this.buttons.set(event.button, event)
    if (event.type === 'mouseReleased') this.buttons.delete(event.button ?? '')
    if (event.type === 'mouseMoved') for (const [button, press] of this.buttons) this.buttons.set(button, { ...press, x: event.x, y: event.y })
    if (event.type === 'keyDown') this.keys.set(event.code ?? event.key ?? '', event)
    if (event.type === 'keyUp') this.keys.delete(event.code ?? event.key ?? '')
  }
  async release(send: (event: BrowserInputEvent) => Promise<void>) {
    for (const [button, event] of this.buttons) {
      await send({ ...event, type: 'mouseReleased', buttons: 0, modifiers: 0, clickCount: 1 })
      this.buttons.delete(button)
    }
    for (const [key, event] of this.keys) {
      const { text: _text, ...rest } = event
      await send({ ...rest, type: 'keyUp', modifiers: 0 })
      this.keys.delete(key)
    }
  }
}
