import { spawn } from 'node:child_process'
import type { MousePress } from './fullscreen-engine.js'
import type { FrontendSession } from './frontend-session.js'
import type { InputLine } from './input-line.js'
import type { OverlayEngine, OverlayMenuHit } from './overlay-engine.js'
import type { OverlayController } from './overlay-controller.js'
import { getEditorCommand } from '../external-editor.js'
import { boxInnerWidth } from '../box-chars.js'

export function frontendOpenCommand(target: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (!/^https?:\/\//i.test(target)) {
    if (platform === 'win32') return ['notepad.exe', [target]]
    if (platform === 'darwin') return ['open', ['-t', target]]
    const editor = (getEditorCommand().match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(part => part.replace(/^(["'])(.*)\1$/, '$2'))
    if (env.TERM_PROGRAM === 'WezTerm') return ['wezterm', ['start', '--', ...editor, target]]
    if (env.TERM === 'xterm-kitty') return ['kitty', [...editor, target]]
    if (/^foot(-|$)/.test(env.TERM ?? '')) return ['foot', [...editor, target]]
    if (env.TERM === 'alacritty') return ['alacritty', ['-e', ...editor, target]]
    return ['x-terminal-emulator', ['-e', ...editor, target]]
  }
  const encoded = Buffer.from(target).toString('base64')
  const script = `$p=New-Object System.Diagnostics.ProcessStartInfo;$p.FileName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$p.UseShellExecute=$true;[Diagnostics.Process]::Start($p)|Out-Null`
  return platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]
    : [platform === 'darwin' ? 'open' : 'xdg-open', [target]]
}

/** Local files always go to a text editor; file associations never execute them. */
export async function openFrontendTarget(target: string): Promise<void> {
  const commands = [frontendOpenCommand(target)]
  if (process.platform === 'linux' && !/^https?:\/\//i.test(target)) {
    const editor = frontendOpenCommand(target, 'linux', {})[1].slice(1)
    commands.push(['gnome-terminal', ['--', ...editor]], ['konsole', ['-e', ...editor]], ['xterm', ['-e', ...editor]])
  }
  let missing: unknown
  for (const [command, args] of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`打开程序退出 ${code}`)))
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing = error
    }
  }
  throw missing
}

export class FrontendMouse {
  private pressed?: { overlay: string; hit: OverlayMenuHit; field: string; x: number; y: number }
  private composerPress?: { x: number; y: number }
  private copyPress?: { x: number; y: number; moved: boolean }
  handle(event: MousePress, host: {
    session: FrontendSession; line: InputLine; overlay: OverlayEngine; controller: OverlayController; columns: number
    render: () => void; key: (name: string) => void; copy: () => void; copyOnSelect: boolean; message: (text: string) => void
  }): void {
    const id = host.overlay.activeId()
    if (id && id !== 'ui-history') {
      if (event.type === 'wheel') { this.pressed = undefined; host.key(event.button & 1 ? 'down' : 'up'); return }
      const field = id === 'model-picker' ? 'modelPickerIndex' : id === 'theme-picker' ? 'themePickerIndex'
        : id === 'domain-picker' ? 'domainPickerIndex' : id === 'chronicle' ? 'chronicleIndex' : id === 'tasks' ? 'tasksIndex' : undefined
      const hit = host.overlay.menuHit(event.x, event.y)
      if (event.type === 'press') this.pressed = (event.button & 3) === 0 && field && hit ? { overlay: id, hit, field, x: event.x, y: event.y } : undefined
      if (event.type === 'move') this.pressed = undefined
      if (event.type === 'release') {
        if ((event.button & 3) === 0 && this.pressed?.overlay === id && this.pressed.x === event.x && this.pressed.y === event.y && hit?.index === this.pressed.hit.index && hit?.workerId === this.pressed.hit.workerId) {
          Object.assign(host.controller.nav(), { [this.pressed.field]: hit.index })
          if (id === 'tasks') host.controller.nav().tasksSelectedId = hit.workerId
          host.overlay.rerender()
        }
        this.pressed = undefined
      }
      return
    }
    if (event.type === 'press' && (event.button & 3) === 0 && host.session.copyButtonHit(event.x, event.y)) {
      this.copyPress = { x: event.x, y: event.y, moved: false }
      return
    }
    if (this.copyPress && (event.type === 'move' || event.type === 'release')) {
      if (event.type === 'move') { this.copyPress.moved = true; return }
      if (event.type === 'release') {
        if (!this.copyPress.moved && (event.button & 3) === 0 && event.x === this.copyPress.x && event.y === this.copyPress.y && host.session.copyButtonHit(event.x, event.y)) host.copy()
        this.copyPress = undefined
      }
      return
    }
    const target = host.session.linkTargetAt(event)
    if (target) { void openFrontendTarget(target).catch(error => host.message(`打开失败：${error.message}`)); return }
    const hit = !id ? host.session.composerHit(event.x, event.y) : null
    if (event.type === 'press') this.composerPress = hit ? { x: event.x, y: event.y } : undefined
    if (event.type === 'move') this.composerPress = undefined
    if (hit && event.type === 'release' && this.composerPress?.x === event.x && this.composerPress.y === event.y) {
      host.session.closeHistory()
      host.line.placeVisibleCaret(hit.line, hit.column, Math.max(1, boxInnerWidth(host.columns)), 12)
      host.render()
    } else {
      host.session.handleMouse(event)
      if (event.type === 'release' && host.copyOnSelect) host.copy()
      if (id) host.overlay.rerender()
    }
    if (event.type === 'release') this.composerPress = undefined
  }
}
