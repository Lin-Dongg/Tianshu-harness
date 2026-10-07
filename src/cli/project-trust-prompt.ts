/**
 * 项目授信启动提示 —— 配置加载前的 raw-stdin 单键确认。
 *
 * 设计动机：信任门（config/project-trust.ts）默认剥离未授信项目的安全敏感键，
 * 但此前只在 stderr 打一行通知——用户发现时机会话已过半，项目里配的
 * provider/network 等键"神秘失效"。本提示在进入目录（bootstrap 之前、
 * loadConfig 消费项目配置之前）主动问一次，授信则**当次会话生效**，无需重启。
 *
 * 注意：审批 / 沙箱 / 权限档位（agent.approval / agent.unsandboxed /
 * agent.permissions）由「永久门」剥离，**授信与否都不生效**——它们不是信任
 * 赌注，归入 stakes.ignoredSafetyKeys 如实告知，不混进「授信以启用」叙事。
 *
 * 只在有真实赌注时出现（项目配置含敏感键或存在 .rivet/hooks.json）；
 * RIVET_TRUST_PROJECT env 覆盖、已授信、已选"不再提示"时完全跳过。
 */

import { wrapReadingText } from '../tui/format/reading-layout.js'
import { type ProjectTrustStakes } from '../config/project-trust.js'

export type TrustPromptDecision = 'trust' | 'skip' | 'dismiss'

/** 单键映射（纯函数）：y=授信 n/Esc=暂不 d=本项目不再提示。 */
export function interpretTrustKey(ch: string): TrustPromptDecision | null {
  if (ch === 'y' || ch === 'Y') return 'trust'
  if (ch === 'n' || ch === 'N' || ch === '\x1B') return 'skip'
  if (ch === 'd' || ch === 'D') return 'dismiss'
  return null
}

/** 提示正文（纯函数，便于测试）。 */
export function buildTrustPromptText(stakes: ProjectTrustStakes, options: { cwd?: string; columns?: number } = {}): string {
  const lines: string[] = [
    '',
    '是否信任这个项目的配置与 hooks？',
    '',
    `工作区：${options.cwd ?? process.cwd()}`,
    '',
  ]
  if (stakes.sensitiveKeys.length > 0) {
    lines.push(`项目配置会改变安全设置：${stakes.sensitiveKeys.join('、')}`)
  }
  if (stakes.ignoredSafetyKeys.length > 0) {
    lines.push(`以下安全档位无论是否授信都被忽略（安全设计）：${stakes.ignoredSafetyKeys.join('、')}`)
  }
  if (stakes.hasHooks) {
    lines.push('项目 .rivet/hooks.json 可在工具执行前后运行进程。')
  }
  if (stakes.hasSkills) {
    lines.push('项目 .rivet/skills/ 携带技能——技能正文可驱动本会话的动作，未授信时不装载。')
  }
  if (stakes.hasRules) {
    lines.push('项目 .rivet/rules/ 携带项目规则（会随会话注入执行上下文），未授信时不载入。')
  }
  lines.push(
    '',
    '请确认这是你创建或信任的项目；不确定时，先检查项目配置。',
    '授信可启用项目其余安全敏感配置（MCP / provider / 网络出口等）与 hooks；审批档与权限档不来自项目配置。记录仅保存在本机，绝不写回仓库。',
    '暂不授信仍可继续，项目安全敏感配置和 hooks 将被忽略。',
    '',
    '  [y] 信任此项目（当次会话生效）',
    '  [n] 暂不信任（下次启动再问）',
    '  [d] 暂不信任，并不再提示本项目',
    '',
    'y / n / d 选择 · Esc 暂不信任',
    '',
  )
  return lines.flatMap(line => wrapReadingText(line, Math.max(1, (options.columns ?? 80) - 4))).map(line => '  ' + line).join('\n')
}

/**
 * raw-stdin 单键读取。stdin 卫生与模板首启选择器同模式（main.ts 模板 picker）：
 * 结束后恢复 rawMode(false) + pause，不影响后续 bootstrap/TUI 接管。
 */
export async function promptProjectTrust(stakes: ProjectTrustStakes): Promise<TrustPromptDecision> {
  process.stderr.write(buildTrustPromptText(stakes, { cwd: process.cwd(), columns: process.stderr.columns ?? process.stdout.columns ?? 80 }))
  if (!process.stdin.isTTY) return 'skip'

  process.stdin.setRawMode(true)
  process.stdin.resume()
  let onData: ((chunk: Buffer) => void) | undefined
  try {
    return await new Promise<TrustPromptDecision>((resolve) => {
      onData = (chunk: Buffer) => {
        const decision = interpretTrustKey(chunk.toString())
        if (decision) resolve(decision)
      }
      process.stdin.on('data', onData)
    })
  } finally {
    if (onData) process.stdin.removeListener('data', onData)
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}
