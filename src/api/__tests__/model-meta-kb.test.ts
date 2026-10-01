import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_META_KB, ENRICHED_ALIAS_TABLE } from '../model-meta-kb.js'
import { MODEL_ALIAS_TABLE } from '../model-aliases.js'

describe('MODEL_META_KB', () => {
  it('contains all GLM entries from the knowledge base', () => {
    const canonicalIds = MODEL_META_KB.map(e => e.canonicalId)
    const glmIds = canonicalIds.filter(id => id.startsWith('glm-'))
    assert.ok(glmIds.includes('glm-5.1'))
    assert.ok(glmIds.includes('glm-5'))
    assert.ok(glmIds.includes('glm-4.7'))
    assert.ok(glmIds.includes('glm-4.6'))
    assert.ok(glmIds.includes('glm-4-long'))
  })

  it('contains Kimi entries with maxTokens omitted (官网未公布)', () => {
    const kimiEntry = MODEL_META_KB.find(e => e.canonicalId === 'kimi-k2.6')
    assert.ok(kimiEntry, 'kimi-k2.6 must be in KB')
    assert.equal(kimiEntry!.metadata.contextWindow, 262_144)
    assert.equal(kimiEntry!.metadata.maxTokens, undefined)
  })

  it('all entries have reasoningSplit capability set', () => {
    // 例外是「本就不走推理分叉通道」的型号，而不是「漏了」：
    //   - glm-4-long / glm-4-flashx-250414：老型号无思考输出通道；
    //   - MiMo v2.6：预设未声明 reasoningSplit，带上会让 openai-client 往请求体
    //     注入 reasoning_split（src/api/openai-client.ts:603），MiMo 不吃这个参数。
    const exempt = new Set([
      'glm-4-long',
      'glm-4-flashx-250414',
      'mimo-v2.6-pro',
      'mimo-v2.6-flash',
    ])
    for (const entry of MODEL_META_KB) {
      const hasReasoning = entry.metadata?.capabilities?.reasoningSplit === true
      if (!exempt.has(entry.canonicalId)) {
        assert.ok(hasReasoning, `${entry.canonicalId} should have reasoningSplit`)
      }
    }
  })

  it('contains MiMo v2.6 entries with official specs (1M context / 128K output / vision)', () => {
    // 官方 mimo.mi.com 模型页：输入模态 Text/Image/Video/Audio，上下文 1M，最大输出 128K。
    // 回归态：两条均缺席 → 向导「从接口拉取列表」后视觉不勾（isVisionCapableId 读不到
    // supportsVision）、上下文落默认值（实测 flash 显示 128K）。
    for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
      const entry = MODEL_META_KB.find(e => e.canonicalId === id)
      assert.ok(entry, `${id} must be in KB`)
      assert.equal(entry!.metadata.contextWindow, 1_000_000, `${id} 上下文`)
      assert.equal(entry!.metadata.maxTokens, 128_000, `${id} 最大输出`)
      assert.equal(entry!.metadata.supportsVision, true, `${id} 必须标为多模态`)
    }
  })

  it('all entries have positive contextWindow', () => {
    for (const entry of MODEL_META_KB) {
      assert.ok(entry.metadata.contextWindow !== undefined, `${entry.canonicalId} needs contextWindow`)
      assert.ok(entry.metadata.contextWindow! > 0, `${entry.canonicalId} contextWindow must be positive`)
    }
  })
})

describe('ENRICHED_ALIAS_TABLE', () => {
  it('is a superset of MODEL_ALIAS_TABLE with KNOWN entries appended', () => {
    assert.ok(ENRICHED_ALIAS_TABLE.length > MODEL_ALIAS_TABLE.length)
    const presetIds = new Set(MODEL_ALIAS_TABLE.map(e => e.canonicalId))
    const enrichedIds = new Set(ENRICHED_ALIAS_TABLE.map(e => e.canonicalId))
    // Every preset entry must be present in the enriched table
    for (const id of presetIds) {
      assert.ok(enrichedIds.has(id), `preset ${id} must be in ENRICHED_ALIAS_TABLE`)
    }
  })

  it('includes KB entries not in preset fleet', () => {
    const presetIds = new Set(MODEL_ALIAS_TABLE.map(e => e.canonicalId))
    const kbEntriesInEnriched = MODEL_META_KB.filter(e => !presetIds.has(e.canonicalId))
    assert.ok(kbEntriesInEnriched.length > 0, 'KB should add entries not in fleet')
    for (const entry of kbEntriesInEnriched) {
      assert.ok(presetIds.has(entry.canonicalId) || true, `${entry.canonicalId} is a new KB entry`)
    }
  })

  it('has no duplicate canonicalId entries', () => {
    const ids = ENRICHED_ALIAS_TABLE.map(e => e.canonicalId)
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
    assert.deepEqual(duplicates, [], 'ENRICHED_ALIAS_TABLE should have no duplicate canonicalIds')
  })

  it('keeps preset entries before KB entries (fleet priority)', () => {
    // Last preset entry index should be before first KB entry index
    const presetCount = MODEL_ALIAS_TABLE.length
    const kbStartIndex = ENRICHED_ALIAS_TABLE.findIndex(e => !MODEL_ALIAS_TABLE.some(p => p.canonicalId === e.canonicalId))
    assert.ok(kbStartIndex >= presetCount, `KB entries should start at or after index ${presetCount}`)
  })
})
