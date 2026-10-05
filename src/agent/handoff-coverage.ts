import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export function writeHandoffCoverage(path: string, sessionId: string, text: string, turnCount: number): void {
  writeFileAtomicSync(`${path}.coverage.json`, JSON.stringify({ version: 1, sessionId, digest: digest(text), turnCount }))
}

export function writeHandoffTail(path: string, sessionId: string, text: string, turnCount: number): void {
  const parentDigest = digest(readFileSync(path, 'utf8'))
  writeFileAtomicSync(`${path}.tail.md`, text)
  writeFileAtomicSync(`${path}.tail.coverage.json`, JSON.stringify({ version: 1, sessionId, parentDigest, digest: digest(text), turnCount }))
}

export function readHandoffWithCoverage(path: string, sessionId: string, currentTurn: number): string {
  const text = readFileSync(path, 'utf8')
  let coveredTurn: number | undefined
  try {
    const meta = JSON.parse(readFileSync(`${path}.coverage.json`, 'utf8'))
    if (meta.version === 1 && meta.sessionId === sessionId && meta.digest === digest(text) && Number.isInteger(meta.turnCount)) coveredTurn = meta.turnCount
  } catch { /* legacy/manual handoff has unknown coverage */ }
  let tail = ''
  try {
    const candidate = readFileSync(`${path}.tail.md`, 'utf8'), meta = JSON.parse(readFileSync(`${path}.tail.coverage.json`, 'utf8'))
    if (coveredTurn !== currentTurn && meta.version === 1 && meta.sessionId === sessionId && meta.turnCount === currentTurn
      && meta.parentDigest === digest(text) && meta.digest === digest(candidate)) tail = candidate
  } catch { /* no proven current tail */ }
  const notice = coveredTurn === currentTurn ? '' : `\n[handoff coverage: ${coveredTurn === undefined ? 'unknown' : `stale, covered turn ${coveredTurn}, current turn ${currentTurn}`}; verify against session history.]\n`
  return text + notice + (tail ? `\n<handoff-latest-tail>\n${tail}\n</handoff-latest-tail>` : '')
}

/**
 * shutdown 自动交接（buildSessionHandoff 结构化摘要）是否该写：
 * 会话内 /handoff（或人工编辑）已产出更新的交接文档时（mtime 晚于 agent 创建时间）
 * 不覆盖——自动摘要只是「会话内没做手动交接」的兜底。
 */
export function shouldAutoWriteHandoff(existingMtimeMs: number | null, sessionStartMs: number): boolean {
  if (existingMtimeMs === null) return true
  return existingMtimeMs <= sessionStartMs
}
