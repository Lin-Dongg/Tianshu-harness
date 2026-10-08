/**
 * Domain Knowledge Block Builder — inject domain experience into worker prompts (V3 Component B-read).
 *
 * Formats top-K domain lessons as a structured block for prompt injection.
 * Mirrors buildWorkerKnowledgeBlock pattern from worker-knowledge.ts.
 */

import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import type { StigmergyStore } from '../context/stigmergy.js'
import { starDomainRegistry } from './star-domain-registry.js'

const MAX_BLOCK_CHARS = 2000
const MAX_LESSONS_PER_BLOCK = 6
const MAX_BATCH_SIGNALS = 3

/** Grade display names for prompt formatting */
const GRADE_LABEL: Record<string, string> = {
  expert: '★★★',
  journeyman: '★★',
  novice: '★',
}

const KIND_LABEL: Record<string, string> = {
  defect_pattern: '缺陷模式',
  invariant: '不变量',
  adversarial_input: '对抗输入',
  selection_rule: '选择规则',
  reframe: '视角转换',
}

/**
 * Build a domain knowledge block for prompt injection.
 *
 * Returns empty string if no lessons available or domain unknown.
 * Caps at MAX_BLOCK_CHARS to avoid prompt bloat.
 */
export function buildDomainKnowledgeBlock(
  store: DomainKnowledgeStore,
  domainId: string,
  options: { maxLessons?: number } = {},
): string {
  if (!starDomainRegistry.has(domainId)) return ''

  const lessons = store.recall(domainId, options.maxLessons ?? MAX_LESSONS_PER_BLOCK)
  if (lessons.length === 0) return ''

  const domainName = starDomainRegistry.get(domainId)?.name ?? domainId
  const lines: string[] = [
    `## ${domainName}的经验`,
    '',
    `以下是 ${domainName} 在本代码库积累的经验教训：`,
    '',
  ]

  let totalChars = lines.join('\n').length

  for (const lesson of lessons) {
    const gradeLabel = GRADE_LABEL[lesson.grade] ?? '★'
    const kindLabel = KIND_LABEL[lesson.kind] ?? lesson.kind
    const line = `${gradeLabel} [${kindLabel}] ${lesson.text}`
    if (totalChars + line.length + 1 > MAX_BLOCK_CHARS) break
    lines.push(line)
    totalChars += line.length + 1
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * 批级共享信息素块（星河收编 #3）：同批先完成的 worker 沉积的语义信号，
 * 供后启动的 worker 优先核验/避让。最多 MAX_BATCH_SIGNALS 条，按衰减后
 * 强度排序。store 为批级内存实例（不落盘，批结束 GC）——空库返回空串。
 */
export async function formatBatchStigmergyBlock(store: StigmergyStore): Promise<string> {
  const entries = await store.query()
  if (entries.length === 0) return ''

  const top = [...entries]
    .sort((a, b) => b.currentStrength - a.currentStrength)
    .slice(0, MAX_BATCH_SIGNALS)
  const lines: string[] = [
    '## 本批共享信号',
    '',
    '同批协作的 worker 已对以下文件沉积语义信号——优先核验这些位置、避让死路：',
    '',
  ]
  for (const e of top) {
    const ctx = e.context ? ` — ${e.context}` : ''
    lines.push(`- [${e.signal}] ${e.path}${ctx}`)
  }
  lines.push('')
  return lines.join('\n')
}
