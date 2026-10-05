import type { FrontendPreferences } from '../frontend-preferences.js'
import type { RivetTheme } from '../theme.js'
import type { KeyPress } from './input-handler.js'
import { color } from './ansi.js'
import { frameLine, frameHintRows } from '../format/overlay-frame.js'
import { panelHeader, numberedChoice } from '../format/panel-layout.js'
import { wrapReadingText } from '../format/reading-layout.js'

const modes: Array<{ id: FrontendPreferences['renderer']; label: string; text: string }> = [
  { id: 'auto', label: '自动 · 原生回滚', text: 'Windows、macOS、Linux 默认使用终端原生回滚，底部局部重绘任务状态与输入。全屏需手动选择；读屏、非交互输出与 dumb 终端保持经典。' },
  { id: 'classic', label: '经典 · 使用终端滚动与复制', text: '正文进入宿主滚动历史；下方保留当前任务、审批和输入。使用宿主的文本选择与复制。' },
  { id: 'fullscreen', label: '全屏 · 固定输入与历史阅读', text: '使用备用屏；输入固定在底部。阅读历史、搜索、选择与复制沿用当前前端键位。退出后恢复宿主终端。' },
]
export class ModePanel {
  private selected = 0
  private offset = 0
  constructor(private status: () => { actual: string; preference: FrontendPreferences['renderer'] }, private theme: () => RivetTheme, private close: () => void, private apply: (mode: FrontendPreferences['renderer']) => void) {}
  onActivate(): void { this.selected = Math.max(0, modes.findIndex(mode => mode.id === this.status().preference)); this.offset = 0 }
  handleKey(key: KeyPress): boolean {
    if (key.name === 'escape' || key.name === 'ctrl_c') this.close()
    else if (key.name === 'up' || key.name === 'down') { this.selected = (this.selected + (key.name === 'up' ? 2 : 1)) % 3; this.offset = 0 }
    else if (key.name === 'pagedown') this.offset += 3
    else if (key.name === 'pageup') this.offset = Math.max(0, this.offset - 3)
    else if (key.name === 'return') { const mode = modes[this.selected]!.id; this.close(); this.apply(mode) }
    return true
  }
  render(width: number, height: number): string[] {
    const theme = this.theme(), status = this.status()
    const footer = frameHintRows([['↑↓', '选择'], ['Enter', '应用并保存默认'], ['PgUp/PgDn', '说明'], ['Esc', '返回']], width, theme)
    const top = panelHeader('终端显示', [], 0, width, theme)
    if (height >= 18) top.push(frameLine('', width, theme), frameLine(color('选择正文与输入的显示方式。', theme.secondary), width, theme))
    top.push(frameLine(color(`实际：${status.actual} · 偏好：${status.preference}`, theme.muted), width, theme))
    if (height >= 18) top.push(frameLine('', width, theme))
    const visibleModes = height - top.length - footer.length < modes.length ? [modes[this.selected]!] : modes
    top.push(...visibleModes.map(mode => { const i = modes.indexOf(mode); return frameLine(numberedChoice(mode.label, i, i === this.selected, theme, mode.id === status.preference), width, theme) }))
    if (height >= 18) top.push(frameLine('', width, theme))
    const budget = Math.max(0, height - top.length - footer.length)
    const detail = wrapReadingText(`${modes[this.selected]!.text}\n仅空闲且无待审批、问答或编辑器时可切换。会话与草稿保留；切换失败不保存新默认。`, Math.max(1, width - 4))
    this.offset = Math.min(this.offset, Math.max(0, detail.length - budget))
    return [...top, ...detail.slice(this.offset, this.offset + budget).map(row => frameLine(color(row, theme.muted), width, theme)), ...footer].slice(0, height)
  }
}
