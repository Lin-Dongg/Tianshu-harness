import { registerHooks } from 'node:module'

// Isolated runtime mutations; never rewrite the shared worktree.
const variant = process.env.TIANSHU_INSIGHTS_DEFECT
let applied = false
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context)
  if (!result.source) return result
  const code = result.source.toString()
  let changed = code
  if (variant === 'tariff' && url.includes('/utils/deepseek-pricing.')) changed = code.replace(/flash:\s*\{[^}]*\}/, 'flash:{input:1,output:2,cacheRead:0.02,cacheWrite:1}')
  if (variant === 'holiday' && url.includes('/utils/pricing-phase.')) changed = code.replace(/\s*\|\|\s*isChinaPublicHoliday\(new Date\(nowMs\s*\+\s*BEIJING_OFFSET_MS\)\.toISOString\(\)\.slice\(0,\s*10\)\)/, '')
  if (variant === 'timestamp' && url.includes('/cache/usage-aggregator.')) changed = code.replace(/resolvePricing\?\.\(row\.model,\s*row\.provider,\s*row\.t\)/, 'resolvePricing?.(row.model, row.provider)')
  if (variant === 'reasoning' && url.includes('/utils/pricing.')) changed = code.replace(/reasoningTokens\s*>\s*0\s*&&\s*pricing\.reasoning\s*!==\s*void 0/, 'reasoningTokens > 0').replace(/pricing\.reasoning\s*\?\?\s*0/, '(pricing.reasoning ?? pricing.output ?? 0)')
  if (variant === 'ledger' && url.includes('/server/session-routes.')) changed = code.replace(/if\(rows\.length\)mainCost/, 'if(false)mainCost')
  if (variant === 'billing-fallback' && url.includes('/api/deepseek-platform-client.')) changed = code.replace(/legacy\.httpStatus\s*===\s*404\s*\|\|\s*legacy\.httpStatus\s*===\s*405\s*\|\|\s*legacyPayload\.failure\s*===\s*"malformed"\s*\|\|\s*legacyPayload\.data\s*&&\s*!Array\.isArray\(legacyPayload\.data\.days\)/, 'legacy.httpStatus === 404 || legacy.httpStatus === 405')
  if (changed === code) return result
  applied = true
  console.error(`applied Insights defect: ${variant}`)
  return { ...result, source: changed }
} })
process.on('exit', () => { if (variant && !applied) { console.error(`Insights defect did not apply: ${variant}`); process.exitCode = 2 } })
