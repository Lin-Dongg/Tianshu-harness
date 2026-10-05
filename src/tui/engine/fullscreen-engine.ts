import type { WriteStream } from 'node:tty'
import { ANSI, cursorTo } from './ansi.js'
import { wrapViewportText } from './conversation-viewport.js'

export interface MousePress {
  button: number
  x: number
  y: number
  type: 'press' | 'release' | 'move' | 'wheel'
  ctrl: boolean
  shift: boolean
  meta: boolean
}
export interface TerminalSize { cols: number; rows: number }
export const MOUSE_ON = '\x1b[?1002h\x1b[?1006h'
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'

/** The main frontend's sole alternate-buffer owner; overlays borrow its drawing surface. */
export class FullscreenEngine {
  private entered = false
  private mouse = false
  private lines: string[] = []
  private previousSize = ''
  constructor(private readonly stdout: WriteStream, private readonly getSize: () => TerminalSize) {}
  get active(): boolean { return this.entered }
  invalidate(): void { this.lines = []; this.previousSize = '' }

  enter(mouse: boolean): void {
    if (this.entered) { this.setMouse(mouse); return }
    this.entered = true
    this.lines = []
    this.previousSize = ''
    this.stdout.write(ANSI.ALT_SCREEN_ON + ANSI.HIDE_CURSOR + ANSI.CURSOR_STEADY_BAR)
    this.setMouse(mouse)
  }
  leave(): void {
    if (!this.entered) return
    this.entered = false
    this.mouse = false
    this.lines = []
    this.stdout.write(ANSI.END_SYNC + ANSI.RESET + MOUSE_OFF + ANSI.CURSOR_SHAPE_DEFAULT + ANSI.SHOW_CURSOR + ANSI.ALT_SCREEN_OFF)
  }
  setMouse(enabled: boolean): void {
    if (!this.entered || this.mouse === enabled) return
    this.stdout.write(enabled ? MOUSE_ON : MOUSE_OFF)
    this.mouse = enabled
  }
  render(lines: string[], caret?: { row: number; col: number }): void {
    if (!this.entered) return
    const size = this.getSize()
    const cols = Math.max(1, Math.min(1000, Math.floor(size.cols) || 1))
    const rows = Math.max(1, Math.min(1000, Math.floor(size.rows) || 1))
    const dimensions = `${cols}:${rows}`
    const resized = dimensions !== this.previousSize
    const frame = Array.from({ length: rows }, (_, i) => wrapViewportText((lines[i] ?? '').replace(/\n/g, ' '), cols)[0] ?? '')
    let output = ANSI.BEGIN_SYNC + ANSI.HIDE_CURSOR
    for (let i = 0; i < frame.length; i++) {
      if (resized || frame[i] !== this.lines[i]) output += cursorTo(i + 1, 1) + ANSI.RESET + frame[i] + ANSI.RESET + ANSI.ERASE_LINE_END
    }
    const row = Math.max(1, Math.min(rows, Math.floor(caret?.row ?? rows)))
    const col = Math.max(1, Math.min(cols, Math.floor(caret?.col ?? 1)))
    output += cursorTo(row, col) + (caret ? ANSI.SHOW_CURSOR : ANSI.HIDE_CURSOR) + ANSI.END_SYNC
    this.stdout.write(output)
    this.lines = frame
    this.previousSize = dimensions
  }
}
