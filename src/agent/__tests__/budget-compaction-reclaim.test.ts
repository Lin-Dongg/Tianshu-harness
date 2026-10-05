/**
 * budget-compaction 判据回归：压缩后若仍高于 targetTokens，不得整单放弃——
 * 只要 reclaim ≥ minReclaimTokens 就提交（targetTokens 是「尽力压到」的目标，
 * 不是通过线）。
 *
 * 缺陷（线上现场）：长会话里 human 消息 + 大 recent 逐字保留，压缩保留下限
 * 恒高于 targetTokens(⌊inputBudget×0.7⌋−16384)，旧判据 `actualAfter > targetTokens`
 * 使 compact() 永远 false → prepareContextRequest 空转三次 → 预算闸门死锁
 * （实测：预计输入 566,016 > 可用输入 566,000，仅超 16 token 就拒绝发送）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactBudgetHistory } from '../budget-compaction.js'
import { estimateBudgetInput } from '../../context/request-budget.js'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'
import type { OaiMessage } from '../../api/oai-types.js'

const ENVELOPE = JSON.stringify({ version: 1, summary: 's', facts: [], requirements: [], pendingApprovals: [] })

function summaryClient(): StreamClient {
  return {
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta(ENVELOPE)
      cb.onStopReason('stop', { input_tokens: 1, output_tokens: 1 } as never)
    },
  } as unknown as StreamClient
}

test('压缩后仍高于 targetTokens，但 reclaim ≥ minReclaim → 必须提交（不得整单放弃）', async () => {
  const messages: OaiMessage[] = [
    { role: 'user', content: 'initial request' },
    { role: 'assistant', content: 'X'.repeat(400_000) },
    { role: 'user', content: 'second request' },
    { role: 'assistant', content: 'Y'.repeat(400_000) },
    { role: 'user', content: 'active question' },
    { role: 'assistant', content: 'answer' },
  ]
  const before = estimateBudgetInput(messages).inputTokens
  let committed: OaiMessage[] | undefined

  const changed = await compactBudgetHistory(messages, {
    client: summaryClient(),
    model: 'deepseek-flash',
    targetTokens: 1_000, // 不可达的小目标——旧判据据此整单放弃
    minReclaimTokens: 1_000,
    archive: async () => 'artifact-1',
    commit: async m => { committed = m },
  })

  assert.equal(changed, true, 'reclaim ≥ minReclaim 时应提交，而非因未达 target 放弃')
  assert.ok(committed, '必须真切提交新历史')
  assert.ok(
    before - estimateBudgetInput(committed!).inputTokens >= 1_000,
    '实际回收必须 ≥ minReclaimTokens',
  )
})
