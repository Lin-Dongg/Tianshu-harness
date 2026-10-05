import type { ArtifactStore } from '../artifact/store.js'
import type { WorkerResult } from './work-order.js'

/** 降级视图的 summary 字符预算——超出时保留首段并附截断标记（明示遗漏，不裸截）。 */
const SUMMARY_CHAR_BUDGET = 300

export async function fitWorkerPacket(compact: Array<Record<string, unknown>>, results: WorkerResult[], store: ArtifactStore | undefined, maxChars: number): Promise<{ json: string; artifactId?: string }> {
  if (JSON.stringify(compact).length <= maxChars) return { json: JSON.stringify(compact) }
  let artifactId: string | undefined
  try { artifactId = await store?.saveDurable({ tool: 'delegate_task', target: 'worker-packet', rawContent: JSON.stringify(results), summary: `${results.length} complete worker results`, sections: [] }) } catch { /* bounded inline delivery still available */ }
  const reduced = compact.map((r, index) => {
    const summaryText = String(r.summary ?? '')
    const summaryTruncated = summaryText.length > SUMMARY_CHAR_BUDGET
    return {
      workOrderId: r.workOrderId, objective: r.objective, status: r.status,
      summary: summaryTruncated ? `${summaryText.slice(0, SUMMARY_CHAR_BUDGET - 1)}…` : summaryText,
      evidenceStatus: r.evidenceStatus === 'verified' ? 'unverified' : r.evidenceStatus,
      // 验证结论/交付事实是调用方判读依据（WORKER_RESULTS_HINT 让主控按 verification.status
      // 判可信度），降级视图必须保留——否则只见归一后的 status，真实验证失败不可见。
      verification: results[index]?.verification,
      deliveredOnAbort: results[index]?.deliveredOnAbort,
      failureReason: r.failureReason, _truncated: true,
      _truncationNote: artifactId ? '完整证据保存在 artifact；内联内容只覆盖下列条目。' : '内联内容已收口；完整证据未能保存。',
      _coverage: { findingCount: results[index]?.findings.length ?? 0, artifactCount: results[index]?.artifacts.length ?? 0, originalEvidenceStatus: r.evidenceStatus, summaryTruncated, artifactId, omittedFields: Object.keys(r).filter(k => !['workOrderId', 'objective', 'status', 'summary', 'evidenceStatus', 'failureReason', 'verification', 'deliveredOnAbort'].includes(k)) },
      nextActions: Array.isArray(r.nextActions) && r.nextActions.some(a => typeof a === 'string' && a.startsWith('Resumable:')) ? r.nextActions.filter(a => typeof a === 'string' && a.startsWith('Resumable:')) : undefined,
    }
  }) as Array<Record<string, unknown>>
  // Add complete findings only when the whole batch stays within budget.
  for (let i = 0; i < reduced.length; i++) {
    const original = compact[i]!
    if (!Array.isArray(original.findings)) continue
    const findings: unknown[] = []
    for (const finding of original.findings) {
      const candidate = [...findings, finding]
      reduced[i]!.findings = candidate
      if (JSON.stringify(reduced).length > maxChars) { reduced[i]!.findings = findings; break }
      findings.push(finding)
    }
    if (!findings.length) delete reduced[i]!.findings
    ;(reduced[i]!._coverage as Record<string, unknown>).inlineFindingCount = findings.length
  }
  let json = JSON.stringify(reduced)
  if (json.length > maxChars) {
    for (const r of reduced) { delete r.findings; delete r.nextActions; delete r.objective; r.summary = ''; r._coverage = { artifactId, inlineFindingCount: 0 } }
    json = JSON.stringify(reduced)
  }
  if (json.length > maxChars) {
    // Extreme input: never silently drop orders or emit a partial JSON array.
    // 文案必须与实际可读性一致：无 artifact 时不存在「完整结果」可读，不得伪称。
    json = JSON.stringify([{ workOrderId: 'batch-coverage', status: 'blocked',
      summary: artifactId
        ? '工单覆盖清单超过内联预算，完整结果保存在 artifact（见 _coverage.artifactId）；未读取前不得宣布全部完成。'
        : '工单覆盖清单超过内联预算，完整证据未能保存；不得宣布全部完成，需缩小批次或重派。',
      evidenceStatus: 'unverified', _truncated: true, _coverage: { orderCount: results.length, artifactId, unavailable: !artifactId } }])
  }
  return { json, artifactId }
}
