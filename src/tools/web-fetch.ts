export { createWebFetchTool, WEB_FETCH_TOOL } from './web-fetch/tool.js'
export { htmlToMarkdown } from './web-fetch/extract.js'
// isPrivateIP：fail-closed 语义（2026-10-07 审计 Finding 6）——不可解析输入返回 true
// （按不可信拒绝）。对外复用时按「true = 必须拦截」理解，勿作放行侧判定。
export { isPrivateIP } from './net/ssrf.js'
