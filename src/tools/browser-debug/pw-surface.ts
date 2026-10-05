/**
 * browser-debug/pw-surface — Playwright 的最小结构面。
 *
 * 只声明 browser-debug 真正用到的方法（不做 Playwright 类型全量耦合），
 * `as never` 的动态加载集中在这里。从 driver.ts 沿接缝拆出（行数棘轮）。
 */

import { loadPlaywrightCore } from '../net/playwright-driver.js'

export interface BrowserCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface PwRequest {
  method(): string
  url(): string
  resourceType(): string
  failure(): { errorText: string } | null
  headers(): Record<string, string>
  postData(): string | null
}
export interface PwResponse {
  status(): number
  request(): PwRequest
  headers(): Record<string, string>
  text(): Promise<string>
}
export interface PwConsoleMessage {
  type(): string
  text(): string
}
export interface PwKeyboard {
  insertText?(text:string):Promise<void>
  press(key: string): Promise<void>
}
export interface PwPage {
  close?():Promise<void>
  setInputFiles?(selector:string,files:string[]|Array<{name:string;mimeType:string;buffer:Buffer}>):Promise<void>
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  evaluate(expr: string): Promise<unknown>
  screenshot(opts: Record<string, unknown>): Promise<Buffer>
  click(selector: string, opts: Record<string, unknown>): Promise<void>
  fill(selector: string, text: string, opts: Record<string, unknown>): Promise<void>
  press(selector: string, key: string, opts: Record<string, unknown>): Promise<void>
  selectOption(selector: string, value: string, opts: Record<string, unknown>): Promise<string[]>
  hover(selector: string, opts: Record<string, unknown>): Promise<void>
  textContent(selector: string, opts?: Record<string, unknown>): Promise<string | null>
  waitForSelector(selector: string, opts: Record<string, unknown>): Promise<unknown>
  waitForLoadState(state: string, opts: Record<string, unknown>): Promise<void>
  reload(opts: Record<string, unknown>): Promise<unknown>
  goBack(opts: Record<string, unknown>): Promise<unknown>
  goForward(opts: Record<string, unknown>): Promise<unknown>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  viewportSize(): { width: number; height: number } | null
  keyboard: PwKeyboard
  url(): string
  bringToFront(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
  /** page 是否已关闭——页面级自愈（resolvePage）判定用。 */
  isClosed(): boolean
}
/** Playwright CDPSession 的最小面——只声明本模块用到的三件事。 */
export interface PwCDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: string, handler: (arg: never) => void): void
  detach(): Promise<void>
}
export interface PwContext {
  pages(): PwPage[]
  newPage(): Promise<PwPage>
  close(): Promise<void>
  cookies(urls?: string | string[]): Promise<BrowserCookie[]>
  addCookies(cookies: unknown[]): Promise<void>
  clearCookies(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
  newCDPSession(page: PwPage): Promise<PwCDPSession>
  /** context 是否已关闭——会话级存活判定用。 */
  isClosed(): boolean
  /** persistent context / CDP attach 下返回所属 Browser；测试桩可为 null。 */
  browser(): PwBrowser | null
}
export interface PwBrowser {
  contexts(): PwContext[]
  close(): Promise<void>
  isConnected(): boolean
  on(event: string, handler: (arg: never) => void): void
}
export interface PwChromium {
  launchPersistentContext(userDataDir: string, opts: Record<string, unknown>): Promise<PwContext>
  connectOverCDP(endpointUrl: string): Promise<PwBrowser>
  /** registry 托管缓存里的 chromium 可执行文件路径（#302：launch 统一判据解析用；测试桩可省）。 */
  executablePath?(): string
}

export async function loadPlaywright(): Promise<{ chromium: PwChromium }> {
  return (await loadPlaywrightCore()) as never
}
