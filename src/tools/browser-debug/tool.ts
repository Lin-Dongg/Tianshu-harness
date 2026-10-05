import { browserOperation } from './control.js'
/**
 * browser_debug — persistent browser for local frontend/backend联调 (CDP route).
 */

import { writeFile } from 'node:fs/promises'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import {
  isHostAllowed,
  BROWSER_NAVIGATED_PREFIX,
  BROWSER_SCREENSHOT_OF_PREFIX,
} from '../browser.js'
import {
  getSession,
  closeSession,
  resolveSessionKey,
  type BrowserDebugSession,
} from './session.js'
import {
  formatConsoleLine,
  formatNetworkLine,
  formatNetworkDetail,
  formatCookies,
  formatStorage,
  type ConsoleLevel,
  type NetworkQuery,
} from './log-capture.js'
import {
  DEFAULT_VIEWPORT,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  type BrowserDebugDriverFactory,
} from './driver.js'
import { act, extract, observe } from './ai-primitives.js'
import { createProfileDirResolver } from './profiles.js'
import { createSessionLifecycle, errorKindFor, isSessionDeathError, withLocatorHint } from './lifecycle.js'
import { parseDevPortsFromScripts, probeDevPorts } from './nav-probe.js'
import type { ActionKind } from './locator.js'

export interface BrowserDebugToolOptions {
  driverFactory?: BrowserDebugDriverFactory
  allowlist?: () => string[]
  userDataDir?: () => string
  enabled?: boolean
}

const NAV_ACTIONS = new Set(['open', 'navigate'])
const CONSOLE_TAIL = 100
const NETWORK_TAIL = 100
const SNAPSHOT_MAX = 20_000

/** Above this the screenshot is left as a file reference only. Base64 inflates
 *  by a third and the payload rides in the conversation for the rest of the
 *  session, so an oversized shot costs far more than the look is worth. */
const SCREENSHOT_VISION_MAX_BYTES = 3_500_000

/** Reads width/height off the input. Either may be omitted — a caller sweeping
 *  responsive breakpoints cares about width and should not have to restate the
 *  height, so the missing side comes from `fallback` (the page's current size
 *  for a resize, the launch default for a fresh session). Returns undefined
 *  when neither was given. */
export function parseViewport(
  input: Record<string, unknown>,
  fallback: { width: number; height: number } = DEFAULT_VIEWPORT,
): { width: number; height: number } | { error: string } | undefined {
  const raw = { width: input.width, height: input.height }
  if (raw.width === undefined && raw.height === undefined) return undefined
  const read = (v: unknown, fallback: number, label: string): number | string => {
    if (v === undefined) return fallback
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      return `${label} 必须是整数 px。`
    }
    if (v < MIN_VIEWPORT || v > MAX_VIEWPORT) {
      return `${label} 超出范围（${MIN_VIEWPORT}–${MAX_VIEWPORT} px）。`
    }
    return v
  }
  const width = read(raw.width, fallback.width, 'width')
  if (typeof width === 'string') return { error: width }
  const height = read(raw.height, fallback.height, 'height')
  if (typeof height === 'string') return { error: height }
  return { width, height }
}

function envAllowlist(): string[] {
  return (process.env.RIVET_BROWSER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost')
}

export function isDebugHostAllowed(host: string, allowlist: string[]): boolean {
  return isLoopbackHost(host) || isHostAllowed(host, allowlist)
}

export function isLoopbackCdpUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' && isLoopbackHost(u.hostname)
  } catch {
    return false
  }
}

export function isCdpUrlAllowed(raw: string, allowlist: string[]): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:') return false
    return isLoopbackHost(u.hostname) || isHostAllowed(u.hostname, allowlist)
  } catch {
    return false
  }
}

/** After an interactive action (click/type/…), check the session log for
 *  newly appeared console errors or failed network requests. Returns an empty
 *  string when nothing new — the action result stays clean. */
function actionImpactNote(
  session: BrowserDebugSession,
  beforeConsoleCount: number,
  beforeNetworkCount: number,
): string {
  const newConsoles = session.log.getConsole().filter(
    (_e, i) => i >= beforeConsoleCount,
  )
  const newErrors = newConsoles.filter((e) => e.level === 'error')
  const newNet = session.log.getNetwork().filter(
    (_e, i) => i >= beforeNetworkCount,
  )
  const newFails = newNet.filter((e) => e.failed || (e.status !== undefined && e.status >= 400))
  if (newErrors.length === 0 && newFails.length === 0) return ''
  const parts: string[] = []
  if (newErrors.length > 0) {
    const sample = newErrors[0]!.text.replace(/\s+$/, '').split('\n')[0]!
    parts.push(newErrors.length === 1
      ? `控制台新增错误：${sample}`
      : `控制台新增 ${newErrors.length} 条错误（首条：${sample}）`)
  }
  if (newFails.length > 0) {
    const f = newFails[0]!
    parts.push(newFails.length === 1
      ? `新增失败请求：${f.method} ${f.url}${f.status !== undefined ? ` (${f.status})` : ''}`
      : `新增 ${newFails.length} 条失败请求（首条：${f.method} ${f.url}${f.status !== undefined ? ` ${f.status}` : ''}）`)
  }
  return `\n（${parts.join('；')}）`
}

type BrowserDebugAction =
  | 'open'
  | 'navigate'
  | 'console'
  | 'network'
  | 'network_detail'
  | 'eval'
  | 'screenshot'
  | 'snapshot'
  | 'set_viewport'
  | 'click'
  | 'type'
  | 'press'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'history'
  | 'wait'
  | 'cookies'
  | 'storage'
  | 'set_cookie'
  | 'clear_cookies'
  | 'set_storage'
  | 'clear_storage'
  | 'pages'
  | 'await_login'
  | 'status'
  | 'clear_logs'
  | 'close'
  | 'act'
  | 'extract'
  | 'observe'

function parseNavUrl(raw: string): { url: URL } | { error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: `无效 URL：${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `不支持的协议：${url.protocol}。仅允许 http/https。` }
  }
  return { url }
}

function resolveConnectUrl(input: Record<string, unknown>, action: string): string | undefined {
  const explicit = input.connect_url
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (action === 'open' && process.env.RIVET_BROWSER_URL?.trim()) {
    return process.env.RIVET_BROWSER_URL.trim()
  }
  return undefined
}

function sessionKeyFrom(params: ToolCallParams): string {
  return resolveSessionKey(params.sessionId)
}

async function withLiveLogs<T>(
  session: BrowserDebugSession,
  onOutput: ToolCallParams['onOutput'],
  fn: () => Promise<T>,
): Promise<T> {
  session.setOutputSink(onOutput ?? null)
  try {
    return await fn()
  } finally {
    session.setOutputSink(null)
  }
}

function safePageUrls(session: BrowserDebugSession): string[] {
  try {
    return session.driver.pageUrls()
  } catch {
    return [session.driver.currentUrl()]
  }
}

function formatStatus(session: BrowserDebugSession): string {
  const net = session.log.getNetwork()
  const failed = session.log.getNetwork({ failedOnly: true }).length
  const consoleTotal = session.log.getConsole().length
  const errCount = session.log.getConsole('error').length
  const urls = safePageUrls(session)
  const lines = [
    `会话：${session.sessionKey}`,
    `状态：${session.isAlive() ? '存活' : '已失效（下次页面操作会自动重建）'}`,
    `模式：${session.mode}${session.connectUrl ? `（${session.connectUrl}）` : ''}`,
    `无头：${session.headless}`,
    `url：${session.driver.currentUrl()}`,
    `页面：${urls.length} 个已打开${urls.length > 1 ? `（末个为活动）：${urls.join(' | ')}` : ''}`,
    `控制台：${consoleTotal} 条消息（${errCount} 条错误）`,
    `网络：${net.length} 条请求（${failed} 条失败/4xx/5xx）`,
  ]
  if (session.userDataDir) lines.push(`配置目录：${session.userDataDir}`)
  if (session.mode === 'connect') {
    lines.push('说明：close 会断开与 Chrome 的连接，但不会退出浏览器')
  }
  return lines.join('\n')
}

function buildNetworkQuery(input: Record<string, unknown>): NetworkQuery {
  return {
    failedOnly: input.failed_only === true,
    urlFilter: typeof input.url_filter === 'string' && input.url_filter.trim()
      ? input.url_filter.trim()
      : undefined,
    apiOnly: input.api_only === true,
  }
}

function formatNetworkResults(
  entries: ReturnType<BrowserDebugSession['log']['getNetwork']>,
  includeBody: boolean,
): string {
  return entries.map((e) => formatNetworkLine(e, includeBody)).join('\n')
}

export function createBrowserDebugTool(options: BrowserDebugToolOptions = {}): Tool {
  const driverFactory = options.driverFactory
  const allowlist = options.allowlist ?? envAllowlist
  const enabled = options.enabled ?? false

    const profileDirFor = createProfileDirResolver(options.userDataDir)
  const lifecycle = createSessionLifecycle({ driverFactory, profileDirFor })
  const { ensureSession, withSessionRecovery } = lifecycle

  const tool: Tool = {
    definition: {
      name: 'browser_debug',
      description: `驱动持久浏览器通过 CDP 调试本地 Web 应用（前后端 + API 联调）。

连接：
- 默认：有头 Chromium；profile 按 sessionId 隔离（__default__ 沿用 ~/.rivet/browser-debug-profile，登录态保留）。
- 会话间共享登录态：shared_profile=true 或 RIVET_BROWSER_SHARED_PROFILE=1（同一时刻只能有一个浏览器实例）。
- 连接模式：open 时传 connect_url 或设 RIVET_BROWSER_URL（Chrome --remote-debugging-port=9222）。close 仅断开连接。

API 联调技巧：
- network {url_filter="/api/", failed_only=true, include_body=true, api_only=true} — 失败 API 调用含响应体。
- network_detail {request_id="r2"} — 单个请求完整详情（状态、耗时、响应体）。

操作：
- open / navigate {url}
- console {level?}
- network {failed_only?, url_filter?, api_only?, include_body?}
- network_detail {request_id} — 状态、耗时、请求头+载荷、响应头+响应体（Authorization/Cookie 等密钥已遮蔽）。
- snapshot / eval / screenshot / click
- screenshot — 视觉模型（或已配置的 vision 桥）会直接看到截图；改完 UI 用它自查，别只看 DOM。
- set_viewport {width?, height?} — 改视口验响应式断点；只给 width 时保留当前高度。
- type {selector, text, submit?} — submit=true 填完后按 Enter
- press {selector?, key} — 键盘按键，如 Enter/Tab/Escape/ArrowDown
- select {selector, value} — 选择 <select> 选项
- hover {selector} / scroll {selector? | to?}
- wait {selector? | state?} — 等待选择器可见，或载入状态（load/domcontentloaded/networkidle）
- history {go: back|forward|reload}
- cookies {url_filter?} — 列出上下文 cookie（值已遮蔽）
- storage {kind: local|session} — 导出 localStorage/sessionStorage（疑似密钥的值已遮蔽）
- set_cookie {name, value, url? | domain?+path?} — 注入 cookie（恢复登录态）
- clear_cookies — 清除所有 cookie（重置会话）
- set_storage {kind, key, value} / clear_storage {kind} — 写入/重置 Web Storage
- pages — 列出打开的标签页/弹窗（OAuth 弹窗自动成为操作目标）
- status / clear_logs / await_login / close

自然语言原语（省掉"取全量 DOM 算 selector"的往返）：
- act {instruction, value?, action?, submit?} — 如 {instruction:"点击登录按钮"}。定位是**启发式**的
  （文本/aria-label/placeholder 模糊匹配 + 角色加权），不是语义理解：把握不足或有多个同样像的
  目标时**不动手**，返回候选 selector 清单让你自己选。措辞越贴近页面原文命中越准；
  要精确指定用引号包住原文，如 {instruction:'点击 "忘记密码？" 链接'}。
- extract {schema, selector?} — 取相关区域文本 + 你的 schema 一并返回；解析由你做，工具不解析。
- observe {question} — 返回可交互元素清单（带 selector，可直接接 act/click）+ 页面文本；判断由你做。`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'open', 'navigate', 'console', 'network', 'network_detail', 'eval', 'screenshot', 'snapshot',
              'click', 'type', 'press', 'select', 'hover', 'scroll', 'history', 'set_viewport',
              'wait', 'cookies', 'storage', 'pages',
              'set_cookie', 'clear_cookies', 'set_storage', 'clear_storage',
              'await_login', 'status', 'clear_logs', 'close',
              'act', 'extract', 'observe',
            ],
            description: '要执行的操作。',
          },
          instruction: { type: 'string', description: 'act：自然语言指令，如 "点击登录按钮"。用引号包住页面原文可精确指定。' },
          act_kind: {
            type: 'string',
            enum: ['click', 'type', 'select', 'hover'],
            description: 'act：显式指定动作；不给则从措辞推断（"点击…"→click、"输入…"→type），推不出按 click。',
          },
          schema: { type: 'string', description: 'extract：想要的数据描述，如 "所有商品名和价格"。' },
          question: { type: 'string', description: 'observe：想问页面的问题，如 "有没有错误提示"。' },
          url: { type: 'string', description: 'open/navigate 的目标 URL。' },
          connect_url: { type: 'string', description: 'open 的 CDP 端点，如 http://127.0.0.1:9222。' },
          request_id: { type: 'string', description: 'network_detail：来自 network 输出的 id（如 r2）。' },
          url_filter: { type: 'string', description: 'network：请求 URL 子串过滤（如 /api/）。' },
          api_only: { type: 'boolean', description: 'network：仅 xhr/fetch 请求。' },
          include_body: { type: 'boolean', description: 'network：包含捕获的响应体（xhr/fetch 及 4xx/5xx）。' },
          selector: { type: 'string', description: 'click/type/press/select/hover/scroll/wait/snapshot 的 CSS 选择器。' },
          text: { type: 'string', description: 'type 要填入的文本。' },
          submit: { type: 'boolean', description: 'type：填完后按 Enter（提交表单）。' },
          key: { type: 'string', description: 'press：键盘按键（Enter/Tab/…）；set_storage：存储键名。' },
          value: { type: 'string', description: 'select 选项值 / set_cookie 值 / set_storage 值 / act 要输入或选中的值（也接受 text）。' },
          state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'wait：等待的载入状态（无选择器时）。' },
          to: { type: 'string', enum: ['top', 'bottom'], description: 'scroll：无选择器时的页面目标（默认 bottom）。' },
          go: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'history：导航方向。' },
          kind: { type: 'string', enum: ['local', 'session'], description: 'storage/set_storage/clear_storage：哪个 Web Storage（默认 local）。' },
          name: { type: 'string', description: 'set_cookie：cookie 名称。' },
          domain: { type: 'string', description: 'set_cookie：cookie 域名（无 url 时配合 path 使用）。' },
          path: { type: 'string', description: 'set_cookie：cookie 路径（默认 /）。' },
          expression: { type: 'string', description: 'eval 的 JavaScript 表达式。' },
          level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'], description: '控制台日志级别过滤。' },
          failed_only: { type: 'boolean', description: 'network：仅失败和 4xx/5xx。' },
          headless: { type: 'boolean', description: '隐藏启动（默认 false）。' },
          shared_profile: { type: 'boolean', description: 'open/await_login：显式使用跨会话共享 profile（登录态共享；同一时刻只能有一个浏览器实例）。默认按 sessionId 隔离，避免并行会话抢 profile 导致启动失败。' },
          width: { type: 'integer', description: 'set_viewport/open：视口宽度 px（默认 1280）。响应式断点问题只在特定宽度下暴露，改完 UI 至少验两个宽度。' },
          height: { type: 'integer', description: 'set_viewport/open：视口高度 px（默认 800）。' },
          timeout_ms: { type: 'integer', description: 'wait：超时毫秒数（默认 10000）。' },
          fullPage: { type: 'boolean', description: 'screenshot：截取完整页面而非仅视口（默认 false）。' },
          raw: { type: 'boolean', description: 'screenshot：跳过动画禁用和字体等待（默认 false）。动画驱动的页面中禁用样式表反而引发布局偏移时用。' },
          element: { type: 'string', description: 'screenshot：CSS 选择器，裁剪截图为该元素的包围盒。' },
          compare: { type: 'boolean', description: 'screenshot：与同页面同视口的上一次截图做像素比对，返回差异百分比和变化区域。无基线时保存为基线。' },
          intent: { type: 'string', description: 'screenshot：配合 compare，声明预期变化的 CSS 选择器。compare 会判断变化区域是否落在该元素内，输出三态裁决（在区域内 / 越界 / 无变化）。' },
          message: { type: 'string', description: 'await_login：展示给用户的提示。' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action as BrowserDebugAction
      const headless = params.input.headless === true
      const viewport = parseViewport(params.input)
      if (viewport && 'error' in viewport) return { content: viewport.error, isError: true, errorKind: 'format_error' }
      const connectUrl = resolveConnectUrl(params.input, action)
      const sessionKey = sessionKeyFrom(params)
      const sharedProfile = params.input.shared_profile === true || process.env.RIVET_BROWSER_SHARED_PROFILE === '1'
      const signal = params.abortSignal

      if (action === 'close') {
        const session = getSession(sessionKey)
        if (!session) return { content: `会话 ${sessionKey} 没有打开的浏览器会话。` }
        const mode = session.mode
        await closeSession(sessionKey)
        return {
          content: mode === 'connect'
            ? `已断开与 Chrome 的连接（会话 ${sessionKey}，浏览器仍在运行）。`
            : `浏览器会话已关闭（${sessionKey}）。`,
        }
      }

      if (action === 'status') {
        const session = getSession(sessionKey)
        if (!session) return { content: `会话 ${sessionKey} 没有打开的浏览器会话。`, isError: true }
        return { content: formatStatus(session) }
      }

      if (action === 'await_login') {
        if (connectUrl && !isCdpUrlAllowed(connectUrl, allowlist())) {
          return {
            content: `browser_debug 已拦截：CDP 端点 "${connectUrl}" 不是回环地址且未在许可名单中。`,
            isError: true,
            errorKind: 'refused',
          }
        }
        try {
          const session = await ensureSession(sessionKey, headless, connectUrl, undefined, sharedProfile)
          if (!headless) await session.driver.bringToFront().catch(() => {})
        } catch (err) {
          return { content: `browser_debug 打开失败：${(err as Error).message}`, isError: true, errorKind: errorKindFor(err) }
        }
        const msg =
          (typeof params.input.message === 'string' && params.input.message.trim()) ||
          '请在浏览器窗口完成登录/手动步骤，然后回复以继续。'
        return {
          content: '[等待手动登录——用户完成后会回复。]',
          uiContent: `${msg}\n\n（OAuth 弹窗/新标签页会自动跟踪；持久化配置会为后续 browser_debug 操作保留登录态。）`,
          endTurn: true,
        }
      }

      if (NAV_ACTIONS.has(action)) {
        const rawUrl = params.input.url as string | undefined
        if (!rawUrl) return { content: `${action} 需要 "url"。`, isError: true, errorKind: 'format_error' }
        const parsed = parseNavUrl(rawUrl)
        if ('error' in parsed) return { content: parsed.error, isError: true, errorKind: 'refused' }

        const list = allowlist()
        if (!isDebugHostAllowed(parsed.url.hostname, list)) {
          return {
            content:
              `browser_debug 已拦截：主机 "${parsed.url.hostname}" 不是回环地址且不在许可名单中（fail-closed）。` +
              (list.length === 0
                ? '当前仅 localhost 可访问——其他主机请设置 RIVET_BROWSER_ALLOWLIST。'
                : `已允许：${list.join(', ')}。`),
            isError: true,
            errorKind: 'refused',
          }
        }
        if (connectUrl && !isCdpUrlAllowed(connectUrl, list)) {
          return {
            content: `browser_debug 已拦截：CDP 端点 "${connectUrl}" 不是回环地址且未在许可名单中。`,
            isError: true,
            errorKind: 'refused',
          }
        }

        try {
          const session = await ensureSession(sessionKey, headless, connectUrl, viewport, sharedProfile)
          return await withSessionRecovery(sessionKey, sharedProfile, session, async (s) => {
            await withLiveLogs(s, params.onOutput, () =>
              s.driver.goto(rawUrl, signal),
            )
            const finalUrl = s.driver.currentUrl()
            const netCount = s.log.getNetwork().length
            const errCount = s.log.getConsole('error').length
            const modeHint = s.mode === 'connect' ? '（已通过 CDP 连接）' : ''
            return {
              content:
                // URL 后用 ASCII `. ` 分隔——browser-mirror / walkthrough 的 \S+ 提取依赖此边界。
                `${BROWSER_NAVIGATED_PREFIX} ${finalUrl}${modeHint}. 已捕获 ${netCount} 条网络请求、${errCount} 条控制台错误。` +
                `使用 network 并设 url_filter="/api/" failed_only=true include_body=true 可查看 API 错误。`,
            }
          })
        } catch (err) {
          const msg = (err as Error).message
          const errorKind = errorKindFor(err)
          const isConnErr = /ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_CONNECTION|timeout/i.test(msg)
          if (isConnErr) {
            // Connection failed — probe nearby ports to help the model
            // diagnose. Only probe, never start a server.
            try {
              const livePorts = await probeDevPorts()
              if (livePorts.length > 0) {
                return { content: `browser_debug 导航失败：${msg}\n探测到本机已监听的端口：${livePorts.join(', ')}。是否拼错了 URL 或端口？`, isError: true, errorKind }
              }
            } catch { /* probing best-effort */ }
            try {
              const devPorts = parseDevPortsFromScripts(params.cwd)
              if (devPorts.length > 0) {
                return { content: `browser_debug 导航失败：${msg}\npackage.json scripts 中出现的端口：${devPorts.join(', ')}——这些端口当前均未监听。是否忘记启动 dev server？`, isError: true, errorKind }
              }
            } catch { /* best effort */ }
          }
          return { content: `browser_debug 导航失败：${msg}`, isError: true, errorKind }
        }
      }

      let session = getSession(sessionKey)
      if (!session) {
        return {
          content: `会话 ${sessionKey} 没有打开的浏览器会话。请先用 action="open" 并提供 url。`,
          isError: true,
        }
      }
      // 调用前会话已死（浏览器被关/被杀）：先按旧启动参数重建一次再执行，避免
      // 第一条错误只是死会话回显。页面级死亡由 driver.resolvePage 自愈，不会到这里。
      if (!session.isAlive()) {
        session = await lifecycle.rebuildSession(sessionKey, session, sharedProfile)
      }

      const runAction = async (session: BrowserDebugSession): Promise<ToolResult> => {
        switch (action) {
          case 'console': {
            const level = params.input.level as ConsoleLevel | undefined
            const raw = session.log.getConsole(level)
            if (raw.length === 0) return { content: '（无控制台输出）' }
            // Over ~20 lines the model loses the signal in the noise — cluster
            // by error signature so "15× same TypeError" is one actionable line.
            const useClusters = raw.length > 20
            if (useClusters) {
              const clusters = session.log.getConsoleClusters(level)
              const lines = clusters.map((c) => {
                const prefix = c.count > 1 ? `${c.count}× ` : ''
                const sample = c.sample.replace(/\s+$/, '')
                return `[${c.level}] ${prefix}${sample}`
              })
              return { content: lines.join('\n') + `\n（共 ${raw.length} 条，按签名聚类为 ${clusters.length} 组）` }
            }
            const entries = raw.slice(-CONSOLE_TAIL)
            return { content: entries.map(formatConsoleLine).join('\n') }
          }
          case 'network': {
            const query = buildNetworkQuery(params.input)
            const includeBody = params.input.include_body === true
            const entries = session.log.getNetwork(query).slice(-NETWORK_TAIL)
            if (entries.length === 0) {
              return { content: query.failedOnly ? '（无匹配的失败请求）' : '（无匹配的网络活动）' }
            }
            return { content: formatNetworkResults(entries, includeBody) }
          }
          case 'network_detail': {
            const requestId = params.input.request_id as string | undefined
            if (!requestId) return { content: 'network_detail 需要 "request_id"。', isError: true, errorKind: 'format_error' }
            const entry = session.log.getByRequestId(requestId)
            if (!entry) {
              return { content: `没有 id 为 "${requestId}" 的请求。请先运行 action="network" 列出 id。`, isError: true }
            }
            return { content: formatNetworkDetail(entry) }
          }
          case 'clear_logs': {
            session.log.clear()
            return { content: '控制台与网络日志已清除。' }
          }
          case 'snapshot': {
            const selector = params.input.selector as string | undefined
            const text = await withLiveLogs(session, params.onOutput, () => session.driver.snapshot(selector))
            const trimmed = text.slice(0, SNAPSHOT_MAX)
            return {
              content: trimmed + (text.length > SNAPSHOT_MAX ? '\n…（已截断）' : ''),
              lossiness: text.length > SNAPSHOT_MAX ? 'truncated' : undefined,
            }
          }
          case 'eval': {
            const expression = params.input.expression as string | undefined
            if (!expression) return { content: 'eval 需要 "expression"。', isError: true, errorKind: 'format_error' }
            let result: string
            try {
              result = await withLiveLogs(session, params.onOutput, () =>
                session.driver.evaluate(expression),
              )
            } catch (err) {
              // 死亡签名必须原样冒泡给 withSessionRecovery；其余是模型自己脚本的异常，
              // 标注清楚避免模型以为工具坏了。
              if (isSessionDeathError(err)) throw err
              throw new Error(`eval 脚本自身抛错（不是工具故障）：${(err as Error).message}`)
            }
            return { content: result.slice(0, SNAPSHOT_MAX) }
          }
          case 'act': {
            // 定位与执行都在 primitives 里；这里只做参数搬运。value/text 两个名字
            // 都收——已有的 type action 用 text，别让模型记两套。
            return await withLiveLogs(session, params.onOutput, () =>
              act(session.driver, {
                instruction: params.input.instruction as string,
                value: (params.input.value ?? params.input.text) as string | undefined,
                action: params.input.act_kind as ActionKind | undefined,
                submit: params.input.submit === true,
              }),
            )
          }
          case 'extract': {
            return await withLiveLogs(session, params.onOutput, () =>
              extract(session.driver, {
                schema: params.input.schema as string,
                selector: params.input.selector as string | undefined,
              }),
            )
          }
          case 'observe': {
            return await withLiveLogs(session, params.onOutput, () =>
              observe(session.driver, { question: params.input.question as string }),
            )
          }
          // Interactive actions (click/type/press/select/hover/scroll) —
          // after the action, check whether new console errors or failed
          // network requests appeared so the model sees the consequence
          // without an extra round-trip.
          case 'click': {
            const selector = params.input.selector as string | undefined
            if (!selector) return { content: 'click 需要 "selector"。', isError: true, errorKind: 'format_error' }
            const beforeC = session.log.getConsole().length
            const beforeN = session.log.getNetwork().length
            await withLocatorHint(session, selector, () =>
              withLiveLogs(session, params.onOutput, () => session.driver.click(selector)),
            )
            return { content: `已点击 ${selector}。` + actionImpactNote(session, beforeC, beforeN) }
          }
          case 'type': {
            const selector = params.input.selector as string | undefined
            const text = params.input.text as string | undefined
            if (!selector || text === undefined) {
              return { content: 'type 需要 "selector" 和 "text"。', isError: true, errorKind: 'format_error' }
            }
            const submit = params.input.submit === true
            const beforeC = session.log.getConsole().length
            const beforeN = session.log.getNetwork().length
            await withLocatorHint(session, selector, () =>
              withLiveLogs(session, params.onOutput, async () => {
                await session.driver.type(selector, text)
                if (submit) await session.driver.press(selector, 'Enter')
              }),
            )
            return { content: `已向 ${selector} 输入文本${submit ? '并按下 Enter' : ''}。` + actionImpactNote(session, beforeC, beforeN) }
          }
          case 'press': {
            const selector = params.input.selector as string | undefined
            const key = params.input.key as string | undefined
            if (!key) return { content: 'press 需要 "key"（如 Enter、Tab、Escape）。', isError: true, errorKind: 'format_error' }
            const beforeC = session.log.getConsole().length
            const beforeN = session.log.getNetwork().length
            await withLiveLogs(session, params.onOutput, () => session.driver.press(selector, key))
            return { content: (selector ? `已在 ${selector} 上按下 ${key}。` : `已按下 ${key}。`) + actionImpactNote(session, beforeC, beforeN) }
          }
          case 'select': {
            const selector = params.input.selector as string | undefined
            const value = params.input.value as string | undefined
            if (!selector || value === undefined) {
              return { content: 'select 需要 "selector" 和 "value"。', isError: true, errorKind: 'format_error' }
            }
            const beforeC = session.log.getConsole().length
            const beforeN = session.log.getNetwork().length
            const chosen = await withLocatorHint(session, selector, () =>
              withLiveLogs(session, params.onOutput, () => session.driver.selectOption(selector, value)),
            )
            return { content: `已在 ${selector} 中选择 ${JSON.stringify(chosen)}。` + actionImpactNote(session, beforeC, beforeN) }
          }
          case 'hover': {
            const selector = params.input.selector as string | undefined
            if (!selector) return { content: 'hover 需要 "selector"。', isError: true, errorKind: 'format_error' }
            const beforeC = session.log.getConsole().length
            const beforeN = session.log.getNetwork().length
            await withLocatorHint(session, selector, () =>
              withLiveLogs(session, params.onOutput, () => session.driver.hover(selector)),
            )
            return { content: `已悬停 ${selector}。` + actionImpactNote(session, beforeC, beforeN) }
          }
          case 'scroll': {
            const selector = params.input.selector as string | undefined
            const to = params.input.to === 'top' ? 'top' : 'bottom'
            const beforeC = session.log.getConsole().length
            const beforeN = session.log.getNetwork().length
            await withLiveLogs(session, params.onOutput, () => session.driver.scroll(selector, to))
            return { content: (selector ? `已将 ${selector} 滚入视图。` : `已滚动到 ${to}。`) + actionImpactNote(session, beforeC, beforeN) }
          }
          case 'history': {
            const go = params.input.go as string | undefined
            if (go !== 'back' && go !== 'forward' && go !== 'reload') {
              return { content: 'history 需要 "go"：back | forward | reload。', isError: true, errorKind: 'format_error' }
            }
            if (go === 'reload') {
              await withLiveLogs(session, params.onOutput, () => session.driver.reload(signal))
              return { content: `已重新加载 ${session.driver.currentUrl()}。` }
            }
            const moved = await withLiveLogs(session, params.onOutput, () =>
              go === 'back' ? session.driver.goBack(signal) : session.driver.goForward(signal),
            )
            const goLabel = go === 'back' ? '后退' : '前进'
            return {
              content: moved
                ? `已${goLabel}至 ${session.driver.currentUrl()}。`
                : `没有可${goLabel}的历史记录。`,
            }
          }
          case 'wait': {
            const selector = params.input.selector as string | undefined
            const state = params.input.state as 'load' | 'domcontentloaded' | 'networkidle' | undefined
            const timeoutMs =
              typeof params.input.timeout_ms === 'number' && params.input.timeout_ms > 0
                ? params.input.timeout_ms
                : 10_000
            if (selector) {
              await withLocatorHint(session, selector, () =>
                withLiveLogs(session, params.onOutput, () =>
                  session.driver.waitForSelector(selector, timeoutMs, signal),
                ),
              )
              return { content: `元素 "${selector}" 已可见（超时 ${timeoutMs}ms）。` }
            }
            if (state) {
              await withLiveLogs(session, params.onOutput, () =>
                session.driver.waitForLoadState(state, timeoutMs, signal),
              )
              return { content: `已到达载入状态 "${state}"（超时 ${timeoutMs}ms）。` }
            }
            return { content: 'wait 需要 "selector" 或 "state"（load/domcontentloaded/networkidle）。', isError: true, errorKind: 'format_error' }
          }
          case 'cookies': {
            const urlFilter = typeof params.input.url_filter === 'string' && params.input.url_filter.trim()
              ? params.input.url_filter.trim()
              : undefined
            const cookies = await withLiveLogs(session, params.onOutput, () => session.driver.cookies(urlFilter))
            return { content: formatCookies(cookies) }
          }
          case 'storage': {
            const kind = params.input.kind === 'session' ? 'session' : 'local'
            const record = await withLiveLogs(session, params.onOutput, () => session.driver.storage(kind))
            return { content: `${kind}Storage:\n${formatStorage(record)}` }
          }
          case 'set_cookie': {
            const name = params.input.name as string | undefined
            const value = params.input.value as string | undefined
            if (!name || value === undefined) {
              return { content: 'set_cookie 需要 "name" 和 "value"。', isError: true, errorKind: 'format_error' }
            }
            const url = typeof params.input.url === 'string' ? params.input.url : undefined
            const domain = typeof params.input.domain === 'string' ? params.input.domain : undefined
            const path = typeof params.input.path === 'string' ? params.input.path : undefined
            if (!url && !domain) {
              const current = (() => { try { return new URL(session.driver.currentUrl()).origin } catch { return undefined } })()
              if (!current) return { content: 'set_cookie 需要 "url" 或 "domain"（当前页面没有可用 URL）。', isError: true, errorKind: 'format_error' }
              await withLiveLogs(session, params.onOutput, () => session.driver.addCookie({ name, value, url: current }))
              return { content: `已为 ${current} 设置 cookie "${name}"。` }
            }
            await withLiveLogs(session, params.onOutput, () =>
              session.driver.addCookie({ name, value, url, domain, path: path ?? (domain ? '/' : undefined) }),
            )
            return { content: `已为 ${url ?? `${domain}${path ?? '/'}`} 设置 cookie "${name}"。` }
          }
          case 'clear_cookies': {
            await withLiveLogs(session, params.onOutput, () => session.driver.clearCookies())
            return { content: '已清除此上下文的全部 cookie。' }
          }
          case 'set_storage': {
            const kind = params.input.kind === 'session' ? 'session' : 'local'
            const key = params.input.key as string | undefined
            const value = params.input.value as string | undefined
            if (!key || value === undefined) {
              return { content: 'set_storage 需要 "key" 和 "value"。', isError: true, errorKind: 'format_error' }
            }
            await withLiveLogs(session, params.onOutput, () => session.driver.setStorage(kind, key, value))
            return { content: `已设置 ${kind}Storage["${key}"]。` }
          }
          case 'clear_storage': {
            const kind = params.input.kind === 'session' ? 'session' : 'local'
            await withLiveLogs(session, params.onOutput, () => session.driver.clearStorage(kind))
            return { content: `已清除 ${kind}Storage。` }
          }
          case 'pages': {
            const urls = safePageUrls(session)
            if (urls.length === 0) return { content: '（无打开的页面）' }
            const active = urls.length - 1
            return {
              content: urls
                .map((u, i) => `${i === active ? '* ' : '  '}[${i}] ${u}`)
                .join('\n'),
            }
          }
          case 'set_viewport': {
            // Re-parse against the live size so a width-only resize keeps the
            // height the page already has.
            const target = parseViewport(params.input, session.driver.viewportSize() ?? DEFAULT_VIEWPORT)
            if (!target) {
              return { content: 'set_viewport 需要 "width" 和/或 "height"（整数 px）。', isError: true, errorKind: 'format_error' }
            }
            if ('error' in target) return { content: target.error, isError: true }
            await session.driver.setViewport(target.width, target.height)
            return { content: `视口已设为 ${target.width}×${target.height}。重新截图或量 DOM 以查看该宽度下的布局。` }
          }
          case 'screenshot': {
            const png = await session.driver.screenshot({
              fullPage: params.input.fullPage === true,
              raw: params.input.raw === true,
              element: typeof params.input.element === 'string' && params.input.element.trim()
                ? params.input.element.trim()
                : undefined,
            })
            const base64 = png.toString('base64')
            let artifactId: string | undefined
            if (params.artifactStore) {
              const host = (() => {
                try {
                  return new URL(session.driver.currentUrl()).hostname
                } catch {
                  return 'page'
                }
              })()
              artifactId = await params.artifactStore.save({
                tool: 'browser_screenshot',
                target: `${host}-screenshot.png`,
                rawContent: base64,
                summary: `Screenshot of ${session.driver.currentUrl()}`,
                sections: [],
              })
            }
            // CLI 可见性：纯 ANSI 终端无法内联渲染截图——把 PNG 落成真实文件，
            // 结果尾注给出可直接打开的路径（桌面端仍走 artifact id 内联渲染）。
            let pngNote = ''
            if (artifactId) {
              const rawPath = params.artifactStore?.get?.(artifactId)?.rawPath
              if (rawPath) {
                const pngPath = rawPath.replace(/\.raw$/, '.png')
                try {
                  await writeFile(pngPath, png)
                  pngNote = `\n已保存：${pngPath}`
                } catch { /* 落盘失败不影响截图结果 */ }
              }
            }
            // Vision channel: hand the PNG to the pipeline, which forwards it
            // to a vision-capable model or routes it through the configured
            // vision bridge for a text-only one. Without this the model only
            // ever learned that a screenshot exists, never what was in it —
            // the loop stopped one step short of actually looking.
            const size = session.driver.viewportSize()
            const sizeNote = size ? `（视口 ${size.width}×${size.height}）` : ''
            const tooBig = png.byteLength > SCREENSHOT_VISION_MAX_BYTES
            // 附图能不能被看见，取决于当前模型有无视觉能力、有无配 visionModel 桥——
            // 三条分支里最后一条是静默丢弃。这条结果文字原先只说"截图于 X → artifact Y"，
            // 不含任何页面信息，模型收到它无法区分"我看到了页面"和"我拿到一个我看不见
            // 的文件名"，于是可能凭截图存在就断言渲染正常。截图是验证手段，一个能让模型
            // 声称验证过它其实没看见的东西的工具，比没有这个工具更糟。read_file 读图时
            // 早就用两种情况都讲清的写法处理了同一问题（且实测正是那句话把模型拉去了
            // observe），这里对齐它——不需要知道当前模型的能力，也就不必把 config 穿进来。
            // computer_use 无此缺口：它的结果文本始终带无障碍树，图掉了页面结构还在。
            const blindNote = '\n（视觉模型可直接看图；非视觉模型该附件会被自动丢弃——'
              + '若你没有真的看到画面，不要凭截图存在断言渲染结果，改用 observe / extract / eval 读 DOM。）'
            // compare mode: pixel-diff against previous screenshot for this
            // host + path + viewport. A deterministic, zero-LLM-cost verdict
            // that the model can cite as evidence without needing to see the
            // image itself.
            let compareNote = ''
            const wantCompare = params.input.compare === true
            if (wantCompare && params.artifactStore && !tooBig) {
              const cmpHost = (() => {
                try { return new URL(session.driver.currentUrl()).hostname }
                catch { return 'page' }
              })()
              const cmpPath = (() => {
                try { return new URL(session.driver.currentUrl()).pathname }
                catch { return '/' }
              })()
              const vp = size ?? { width: 0, height: 0 }
              const elKey = typeof params.input.element === 'string' && params.input.element.trim()
                ? `:${params.input.element.trim()}`
                : ''
              const cmpKey = `screenshot-baseline:${cmpHost}${cmpPath}@${vp.width}x${vp.height}${elKey}`
              try {
                const prev = params.artifactStore.listByTarget(cmpKey)
                if (prev.length === 0) {
                  await params.artifactStore.save({
                    tool: 'browser_screenshot',
                    target: cmpKey,
                    rawContent: base64,
                    summary: `Baseline: ${session.driver.currentUrl()} (${vp.width}×${vp.height})`,
                    sections: [],
                  })
                  compareNote = '\n[compare] 已保存为基线（首次截图）。下次同页面同视口截图时将自动比对。'
                } else {
                  const baseline = prev[prev.length - 1]!
                  const baselineRaw = await params.artifactStore.readRaw(baseline.id)
                  if (!baselineRaw) {
                    compareNote = '\n[compare] 基线无法读取，已跳过比对。'
                  } else {
                    const baselineBuf = Buffer.from(baselineRaw, 'base64')
                    const curPng = PNG.sync.read(png)
                    const basePng = PNG.sync.read(baselineBuf)
                    const dimNote = (curPng.width !== basePng.width || curPng.height !== basePng.height)
                      ? `（尺寸不同：当前 ${curPng.width}×${curPng.height}，基线 ${basePng.width}×${basePng.height}——比对重叠区域）`
                      : ''
                    const w = Math.min(curPng.width, basePng.width)
                    const h = Math.min(curPng.height, basePng.height)
                    // pixelmatch requires width-aligned RGBA arrays. When
                    // dimensions differ, extract the common region row by row.
                    let curAligned: Uint8Array, baseAligned: Uint8Array
                    if (curPng.width === basePng.width) {
                      curAligned = curPng.data
                      baseAligned = basePng.data
                    } else {
                      curAligned = new Uint8Array(w * h * 4)
                      baseAligned = new Uint8Array(w * h * 4)
                      for (let y = 0; y < h; y++) {
                        curAligned.set(curPng.data.subarray(y * curPng.width * 4, y * curPng.width * 4 + w * 4), y * w * 4)
                        baseAligned.set(basePng.data.subarray(y * basePng.width * 4, y * basePng.width * 4 + w * 4), y * w * 4)
                      }
                    }
                    const diffPng = new PNG({ width: w, height: h })
                    const mismatched = pixelmatch(
                      curAligned, baseAligned, diffPng.data, w, h,
                      { threshold: 0.1, diffMask: true },
                    )
                    const total = w * h
                    const pct = ((mismatched / total) * 100).toFixed(1)
                    if (mismatched === 0) {
                      compareNote = '\n[compare] 与基线完全一致（0% 差异）。'
                    } else {
                      // Bounding box of changed pixels for a rough region hint
                      let minX = w, minY = h, maxX = 0, maxY = 0
                      for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                          if (diffPng.data[(y * w + x) * 4 + 3] !== 0) {
                            if (x < minX) minX = x
                            if (y < minY) minY = y
                            if (x > maxX) maxX = x
                            if (y > maxY) maxY = y
                          }
                        }
                      }
                      const bboxW = maxX - minX + 1
                      const bboxH = maxY - minY + 1
                      compareNote = `\n[compare] 差异 ${pct}%（${mismatched} / ${total} 像素）${dimNote}`
                        + `，变化区域集中于 (${minX},${minY})–(${maxX},${maxY}) ${bboxW}×${bboxH}。`
                      // Intent-aware verdict: when the model declares what it
                      // meant to change, check whether the actual pixel diff
                      // stays within that declared region.
                      const intentSel = typeof params.input.intent === 'string' && params.input.intent.trim()
                        ? params.input.intent.trim()
                        : ''
                      if (intentSel) {
                        try {
                          const intentJson = await session.driver.evaluate(`
                            (() => {
                              const el = document.querySelector(${JSON.stringify(intentSel)});
                              if (!el) return 'null';
                              const r = el.getBoundingClientRect();
                              return JSON.stringify({x:r.x, y:r.y, w:r.width, h:r.height});
                            })()
                          `)
                          if (intentJson === 'null') {
                            compareNote += `\n[intent] 声明区域 "${intentSel}" 未在页面中找到。`
                          } else {
                            const ir = JSON.parse(intentJson) as { x: number; y: number; w: number; h: number }
                            const iLeft = ir.x, iTop = ir.y, iRight = ir.x + ir.w, iBottom = ir.y + ir.h
                            const dLeft = minX, dTop = minY, dRight = maxX, dBottom = maxY
                            // Overlap rectangle
                            const oLeft = Math.max(iLeft, dLeft)
                            const oTop = Math.max(iTop, dTop)
                            const oRight = Math.min(iRight, dRight)
                            const oBottom = Math.min(iBottom, dBottom)
                            const overlapArea = Math.max(0, oRight - oLeft) * Math.max(0, oBottom - oTop)
                            const diffArea = (dRight - dLeft) * (dBottom - dTop)
                            const overlapRatio = diffArea > 0 ? overlapArea / diffArea : 0
                            if (overlapRatio >= 0.95) {
                              compareNote += `\n[intent] ✓ 变化在声明区域 "${intentSel}" 内。`
                            } else if (overlapRatio > 0) {
                              const pctOverlap = (overlapRatio * 100).toFixed(0)
                              compareNote += `\n[intent] ⚠ 变化 ${pctOverlap}% 在 "${intentSel}" 内——其余部分越界。`
                            } else {
                              compareNote += `\n[intent] ✗ 越界——变化在 (${minX},${minY})–(${maxX},${maxY})，`
                                + `但声明区域 "${intentSel}" 在 (${iLeft.toFixed(0)},${iTop.toFixed(0)})–(${iRight.toFixed(0)},${iBottom.toFixed(0)})，无交集。`
                            }
                          }
                        } catch {
                          compareNote += `\n[intent] 无法读取声明区域 "${intentSel}" 的位置。`
                        }
                      }
                    }
                  }
                }
              } catch (cmpErr) {
                compareNote = `\n[compare] 比对失败：${(cmpErr as Error).message}`
              }
            }
            return {
              content: `${BROWSER_SCREENSHOT_OF_PREFIX} ${session.driver.currentUrl()}${sizeNote}`
                + (artifactId ? ` → artifact ${artifactId}` : '')
                + pngNote
                + compareNote
                + (tooBig
                  ? `\n（${Math.round(png.byteLength / 1024)}KB 超出视觉通道上限，未附图——缩小视口后重截，或用 eval 量 DOM。）`
                  : blindNote),
              images: tooBig ? undefined : [`data:image/png;base64,${base64}`],
            }
          }
          default:
            return { content: `未知操作：${String(action)}`, isError: true, errorKind: 'format_error' }
        }
      }

      try {
        return await withSessionRecovery(sessionKey, sharedProfile, session, runAction)
      } catch (err) {
        return {
          content: `browser_debug ${action} 失败：${(err as Error).message}`,
          isError: true,
          errorKind: errorKindFor(err),
        }
      }
    },

    requiresApproval(params: ToolCallParams): boolean {
      const action = params.input.action as string
      const connectUrl = resolveConnectUrl(params.input, action)
      if (connectUrl) {
        try {
          if (!isLoopbackHost(new URL(connectUrl).hostname)) return true
        } catch {
          /* invalid URL handled in execute */
        }
      }
      if (!NAV_ACTIONS.has(action)) return false
      const rawUrl = params.input.url
      if (typeof rawUrl !== 'string') return false
      try {
        return !isLoopbackHost(new URL(rawUrl).hostname)
      } catch {
        return false
      }
    },

    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: (params) => (params?.input.action === 'wait' ? 120_000 : 60_000),
  }
  const execute=tool.execute
  tool.execute=async params=>{
    try{return await browserOperation(sessionKeyFrom(params),'agent',()=>execute(params))}
    catch(err){return {content:`浏览器由用户接管或操作失败：${(err as Error).message}。等待用户交还后继续。`,isError:true,endTurn:true}}
  }
  return tool

}

export const BROWSER_DEBUG_TOOL: Tool = createBrowserDebugTool({ enabled: true })
