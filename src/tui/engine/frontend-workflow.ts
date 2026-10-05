import { DraftSlot } from '../draft-state.js'
import type { InputLine } from './input-line.js'
import type { KeyPress } from './input-handler.js'
import type { SlashCommand } from '../slash-command-registry.js'
import { hasExistingFrontendConfig, loadFrontendPreferences, saveFrontendPreferences, type FrontendPreferences } from '../frontend-preferences.js'
import { getKeybindingRows, resolveFrontendAction, validateBindings, type FrontendAction } from '../keybindings.js'

export interface FrontendWorkflowHost {
  action: (action: FrontendAction) => void
  renderer: (mode: FrontendPreferences['renderer']) => boolean
  message: (text: string) => void
  detail: (title: string, text: string) => void
  register: (command: SlashCommand) => void
  rendererStatus?: () => string
  mode?: () => void
}

export const FRONTEND_COMMAND_NAMES = ['/tui', '/keybindings', '/stash', '/editor', '/thinking', '/paste'] as const

/** Chat actions and their command equivalents use the same implementation. */
export class FrontendWorkflow {
  readonly stash = new DraftSlot()
  preferences: FrontendPreferences
  constructor(private line: InputLine, private host: FrontendWorkflowHost) {
    this.preferences = loadFrontendPreferences({ existingConfig: hasExistingFrontendConfig() })
    this.line.setNewlineMode(this.preferences.inputMode === 'multiline')
    for (const name of FRONTEND_COMMAND_NAMES) {
      host.register({ name, immediate: true, handler: ({ trimmed }) => { this.command(name, trimmed.slice(name.length).trim()); return true } })
    }
  }
  apply(preferences: FrontendPreferences): boolean {
    if (preferences.renderer !== this.preferences.renderer && !this.host.renderer(preferences.renderer)) return false
    this.preferences = preferences
    this.line.setNewlineMode(preferences.inputMode === 'multiline')
    return true
  }
  handleKey(key: KeyPress): boolean {
    const action = resolveFrontendAction(key.meta && /^[a-z]$/i.test(key.char) ? `alt_${key.char.toLowerCase()}` : key.name, this.preferences)
    if (!action) return false
    this.perform(action)
    return true
  }
  perform(action: FrontendAction): void {
    if (action === 'stash') {
      const outcome = this.stash.exchange(this.line)
      this.host.message({ saved: '已暂存草稿（含附件）；Ctrl+S恢复或交换', restored: '已恢复草稿，尚未发送', swapped: '已交换当前与暂存草稿，尚未发送', empty: '没有可暂存的草稿' }[outcome])
    } else this.host.action(action)
  }
  private save(preferences: FrontendPreferences): void {
    const previous = this.preferences
    if (!this.apply(preferences)) return
    try { saveFrontendPreferences(preferences); this.host.message('已保存前端偏好，作用于本用户；当前会话已应用') }
    catch (error) { this.apply(previous); this.host.message(`前端偏好保存失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  selectRenderer(mode: FrontendPreferences['renderer']): void { this.save({ ...this.preferences, renderer: mode }) }
  private command(name: string, args: string): void {
    if (name === '/stash') { this.perform('stash'); return }
    if (name === '/editor') { this.perform('editor'); return }
    if (name === '/thinking') { this.perform('thinking'); return }
    if (name === '/paste') {
      if (/^delete \d+$/.test(args)) {
        this.line.removePaste(Number(args.split(' ')[1])); this.host.message('已删除该粘贴块，未提交其他内容')
      } else this.host.detail('草稿与粘贴全文 · 只读', this.line.expandPastes(this.line.value) || '没有文本；/paste delete N 删除指定粘贴块')
      return
    }
    if (name === '/tui') {
      if (args === 'auto' || args === 'classic' || args === 'fullscreen') this.save({ ...this.preferences, renderer: args })
      else if (!args && this.host.mode) this.host.mode()
      else this.host.detail('终端显示', `当前：${this.host.rendererStatus?.() ?? '由宿主选择'} · 偏好：${this.preferences.renderer}\n/tui auto · Windows、macOS、Linux 默认原生回滚与底部局部重绘\n/tui fullscreen · 在兼容终端手动开启全屏\n/tui classic · 经典输出与宿主复制\n读屏、非交互输出与 dumb 终端保持经典。\n仅空闲、没有待审批/问答/编辑器时可切换；会话与草稿保留。`)
      return
    }
    if (args === 'standard' || args === 'legacy') this.save({ ...this.preferences, keymap: args, bindings: {} })
    else if (args.startsWith('bind ')) {
      const [, action, key] = args.split(/\s+/)
      const next = { ...this.preferences, bindings: { ...this.preferences.bindings, [action ?? '']: key ?? '' } }
      const errors = validateBindings(next.bindings, next.keymap)
      if (errors.length) this.host.message(errors.join('\n'))
      else this.save(next)
    } else if (args === 'reset') this.save({ ...this.preferences, bindings: {} })
    else {
      const rows = getKeybindingRows(this.preferences)
      const labelKey = (key: string) => key.replace(/^ctrl_/, 'Ctrl+').replace(/^alt_/, 'Alt+').replace(/[a-z]$/, letter => letter.toUpperCase())
      this.host.detail('快捷键 · 当前焦点：对话', rows.map(row => `${row.key ? labelKey(row.key) : '—'}  ${row.label}  ${row.command}${row.aliases.length ? `（兼容 ${row.aliases.map(labelKey).join('、')}）` : ''}${row.custom ? ' · 自定义' : ''}`).join('\n') + '\n\n/keybindings standard|legacy\n/keybindings bind <action> <key> · /keybindings reset\n设置焦点 Ctrl+S 保存；对话焦点标准 Ctrl+S 暂存。')
    }
  }
}
