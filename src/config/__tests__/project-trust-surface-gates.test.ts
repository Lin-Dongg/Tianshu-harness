/**
 * 信任门族清单式回归（2026-10-07 安全审计修复配套）。
 *
 * 枚举「项目表面 × 授信状态」——未授信一律不读不注入（fail-closed），授信后恢复。
 * **新增项目级读取通道时在此登记**；漏登记 = 该通道无门也无人察觉（审计根因：
 * 逐通道后补门必然遗漏，清单测试是把"继续漏"变成红灯的机械防线）。
 *
 * 配套单测：谓词层在 src/config/__tests__/project-trust.test.ts（projectSurfaceAllowed）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProjectSkills, SkillRegistry, type SkillDefinition } from '../../skills/skill-loader.js'
import { workspaceSkillSnapshot } from '../../skills/workspace-skill-snapshot.js'
import { resolveAppPromptInput } from '../../tui/prompt-input-resolver.js'
import { loadProjectRules } from '../../context/rules-loader.js'
import { loadCustomCommands, resolveCustomCommand } from '../../commands/loader.js'
import { renderMemoryBlock } from '../../memory/unified-memory.js'
import { loadPresence } from '../../agent/companion-presence.js'
import { resolvePlanContract, findApprovedPlanConstraints, resetApprovedPlanCache } from '../../agent/plan-constraints.js'
import { KnowledgeIndex } from '../../memory/knowledge-index.js'
import { readCommitFacts } from '../../context/project-memory-writer.js'

describe('信任门族 surface 清单（未授信不读 / 授信恢复）', () => {
  let proj = ''
  let skillHome = ''
  const prevTrust = process.env.RIVET_TRUST_PROJECT

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'gate-proj-'))
    skillHome = mkdtempSync(join(tmpdir(), 'gate-skills-home-'))
    // ── payload 布置（每个 surface 一份中性样本）──
    mkdirSync(join(proj, '.rivet', 'skills', 'gate-probe-skill'), { recursive: true })
    writeFileSync(join(proj, '.rivet', 'skills', 'gate-probe-skill', 'SKILL.md'),
      '---\nname: gate-probe-skill\ndescription: GATE-PROBE-DESC\n---\n# Probe\n')
    mkdirSync(join(proj, '.rivet', 'rules'), { recursive: true })
    writeFileSync(join(proj, '.rivet', 'rules', 'gate-probe-rule.md'), 'GATE-PROBE-RULE')
    mkdirSync(join(proj, '.rivet', 'commands'), { recursive: true })
    writeFileSync(join(proj, '.rivet', 'commands', 'gate-probe-cmd.md'), 'GATE-PROBE-COMMAND $ARGUMENTS')
    mkdirSync(join(proj, '.rivet', 'knowledge'), { recursive: true })
    writeFileSync(join(proj, '.rivet', 'knowledge', 'memory.jsonl'), JSON.stringify({
      id: 'gate_probe_mem', text: 'GATE-PROBE-MEMORY', kind: 'fact', confidence: 0.9,
      source: 'agent-crafted', status: 'verified', tags: [], ts: Date.now(), repeatCount: 1,
    }) + '\n')
    writeFileSync(join(proj, '.rivet', 'knowledge', 'commit-facts.jsonl'), JSON.stringify({
      id: 'gate_probe_cf', text: 'GATE-PROBE-COMMIT-FACT', kind: 'decision', confidence: 0.95,
      createdAt: 1, source: 'gate-probe', tags: ['commit_fact'],
    }) + '\n')
    writeFileSync(join(proj, '.rivet', 'presence.json'), JSON.stringify([
      { sessionId: 'gate-other-session', starDomain: '瑶光', objective: '(active task)', updatedAt: Date.now() },
    ]))
    mkdirSync(join(proj, '.rivet', 'plans'), { recursive: true })
    writeFileSync(join(proj, '.rivet', 'plans', 'gate-probe-plan.md'),
      '## 反目标\n\n- GATE-PROBE-ANTIGOAL\n')
    delete process.env.RIVET_TRUST_PROJECT
    resetApprovedPlanCache()
  })

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true })
    rmSync(skillHome, { recursive: true, force: true })
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
  })

  it('skills：未授信不装载项目技能；授信后装载', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    const denied = loadProjectSkills(proj, { homeDir: skillHome })
    assert.equal(denied.loaded.includes('gate-probe-skill'), false, 'untrusted must not load project skills')

    process.env.RIVET_TRUST_PROJECT = '1'
    const allowed = loadProjectSkills(proj, { homeDir: skillHome })
    assert.equal(allowed.loaded.includes('gate-probe-skill'), true, 'trusted must load project skills')
  })

  it('rules：未授信不产出 claim 提案；授信后带 user 权威标注产出', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.deepEqual(loadProjectRules(proj), [], 'untrusted must not load rules')

    process.env.RIVET_TRUST_PROJECT = '1'
    const rules = loadProjectRules(proj)
    assert.equal(rules.length, 1)
    assert.match(rules[0]!.text, /GATE-PROBE-RULE/)
    assert.equal(rules[0]!.source.actor, 'user')
  })

  it('commands：未授信不解析/列出项目命令；授信后展开正文', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.equal(resolveCustomCommand(proj, '/gate-probe-cmd hello'), null, 'untrusted must not resolve project commands')
    assert.deepEqual(loadCustomCommands(proj), [])

    process.env.RIVET_TRUST_PROJECT = '1'
    assert.equal(resolveCustomCommand(proj, '/gate-probe-cmd hello'), 'GATE-PROBE-COMMAND hello')
  })

  it('memory（craftedMemory 渲染层）：未授信不注入跨会话记忆', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.equal(renderMemoryBlock(proj, 'gate probe', 2000, 'agent-crafted'), null, 'untrusted must not render project memory')

    process.env.RIVET_TRUST_PROJECT = '1'
    const block = renderMemoryBlock(proj, 'gate probe', 2000, 'agent-crafted')
    assert.ok(block && block.includes('GATE-PROBE-MEMORY'), 'trusted must render project memory')
  })

  it('presence：未授信不读项目在线状态；授信后读到', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.deepEqual(loadPresence(proj, 'gate-self'), [], 'untrusted must not read project presence')

    process.env.RIVET_TRUST_PROJECT = '1'
    const entries = loadPresence(proj, 'gate-self')
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.sessionId, 'gate-other-session')
  })

  it('plans：未授信不解析计划约束；授信后解析', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.deepEqual(resolvePlanContract(proj, { planPath: '.rivet/plans/gate-probe-plan.md' }).constraints, [], 'untrusted must not resolve plan constraints')
    resetApprovedPlanCache()
    assert.equal(findApprovedPlanConstraints(proj), undefined)

    process.env.RIVET_TRUST_PROJECT = '1'
    const contract = resolvePlanContract(proj, { planPath: '.rivet/plans/gate-probe-plan.md' })
    assert.ok(contract.constraints.some(c => c.includes('GATE-PROBE-ANTIGOAL')), 'trusted must resolve plan constraints')
  })

  it('playbook 检索面（KnowledgeIndex，recall 工具与 adaptive 注入共用底层）：未授信不建索引；授信后检索到', async () => {
    writeFileSync(join(proj, '.rivet', 'playbook.jsonl'), JSON.stringify({
      id: 'gate_pb', createdAt: Date.now(), keywords: ['gateprobe'], lesson: 'GATE-PROBE-PLAYBOOK',
      context: 'probe', useCount: 0, lastUsedAt: null, importance: 0.9,
    }) + '\n')

    process.env.RIVET_TRUST_PROJECT = '0'
    const denied = new KnowledgeIndex(proj)
    assert.deepEqual(await denied.search('gateprobe'), [], 'untrusted must not index project playbook')

    process.env.RIVET_TRUST_PROJECT = '1'
    const allowed = new KnowledgeIndex(proj)
    const hits = await allowed.search('gateprobe')
    assert.ok(hits.some(h => h.playbook), 'trusted must search project playbook')
  })

  it('skills（slash 解析入口，对抗验证补测）：未授信不展开技能正文（/skill 与裸名两形态）；授信展开', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    const bare = resolveAppPromptInput('/gate-probe-skill', proj)
    assert.ok(!(bare?.prompt ?? '').includes('# Probe'), '未授信时裸名形态不得展开技能正文')
    const viaSkill = resolveAppPromptInput('/skill gate-probe-skill', proj)
    assert.ok(!(viaSkill?.prompt ?? '').includes('# Probe'), '未授信时 /skill 网关不得展开技能正文')

    process.env.RIVET_TRUST_PROJECT = '1'
    const allowed = resolveAppPromptInput('/skill gate-probe-skill do it', proj)
    assert.ok((allowed?.prompt ?? '').includes('# Probe'), '授信后正常展开技能正文')
  })

  it('skills（slash 解析按 origin 判门）：未授信项目全局/内置技能可展开，项目槽位技能（含冻结 session 快照残留）不展开', () => {
    process.env.RIVET_TRUST_PROJECT = '0'

    // A. 真实 workspace 快照组合：全局技能（fake home 的 ~/.rivet/skills）未授信照常展开。
    mkdirSync(join(skillHome, '.rivet', 'skills'), { recursive: true })
    writeFileSync(join(skillHome, '.rivet', 'skills', 'gate-global-skill.md'),
      '---\nname: gate-global-skill\ndescription: GATE-GLOBAL-DESC\n---\nGATE-GLOBAL-BODY\n')
    const workspaceRegistry = workspaceSkillSnapshot(proj, skillHome).registry
    assert.ok(workspaceRegistry.get('gate-global-skill'), '未授信快照须保留全局技能')
    assert.ok(!workspaceRegistry.get('gate-probe-skill'), '未授信快照不得含项目技能')
    const globalViaSkill = resolveAppPromptInput('/skill gate-global-skill do it', proj, undefined, undefined, workspaceRegistry)
    assert.ok((globalViaSkill?.prompt ?? '').includes('GATE-GLOBAL-BODY'), '未授信时 /skill 网关须展开全局技能')
    const globalBare = resolveAppPromptInput('/gate-global-skill', proj, undefined, undefined, workspaceRegistry)
    assert.ok((globalBare?.prompt ?? '').includes('GATE-GLOBAL-BODY'), '未授信时裸名形态须展开全局技能')
    // 内置技能（registerBuiltinSkills 形态：source 缺失、无 backing 文件）不受项目信任门管辖
    const builtin = resolveAppPromptInput('/skill galaxy', proj, undefined, undefined, workspaceRegistry)
    assert.ok((builtin?.prompt ?? '').includes('星河'), '未授信时内置技能须可用')

    // B. 冻结 session 快照窄例：授信期冻入的快照撤信后按 pinned 语义原样读回，
    //    registry 里仍含项目技能——按 origin 判门必须仍挡住（/skill 与裸名两形态）。
    const frozen = new SkillRegistry()
    const def = (name: string, body: string, extra: Partial<SkillDefinition>): SkillDefinition =>
      ({ name, description: '', triggers: [], body, ...extra })
    // 项目槽位（快照里 source 随 ManagedSkill 冻入）
    frozen.register(def('gate-frozen-rivet', 'GATE-FROZEN-RIVET-BODY', { source: 'rivet', bodyPath: join(proj, '.rivet', 'skills', 'gate-frozen-rivet.md') }))
    frozen.register(def('gate-frozen-agents', 'GATE-FROZEN-AGENTS-BODY', { source: 'project-agents', bodyPath: join(proj, '.agents', 'skills', 'gate-frozen-agents', 'SKILL.md') }))
    // source 缺失但 backing 在项目目录内（早期快照形态）——路径兜底仍须门住
    frozen.register(def('gate-frozen-legacy', 'GATE-FROZEN-LEGACY-BODY', { bodyPath: join(proj, '.rivet', 'skills', 'gate-frozen-legacy.md') }))
    // 全局/内置/插件（快照再水合形态：内置技能的 source 冻为 'builtin'）
    frozen.register(def('gate-frozen-global', 'GATE-FROZEN-GLOBAL-BODY', { source: 'global-rivet', bodyPath: join(skillHome, '.rivet', 'skills', 'gate-frozen-global.md') }))
    frozen.register(def('gate-frozen-builtin', 'GATE-FROZEN-BUILTIN-BODY', { source: 'builtin', builtIn: true }))
    frozen.register(def('gate-frozen-plugin', 'GATE-FROZEN-PLUGIN-BODY', { source: 'plugin' }))

    for (const [name, body] of [['gate-frozen-rivet', 'GATE-FROZEN-RIVET-BODY'], ['gate-frozen-agents', 'GATE-FROZEN-AGENTS-BODY'], ['gate-frozen-legacy', 'GATE-FROZEN-LEGACY-BODY']] as const) {
      const viaSkill = resolveAppPromptInput(`/skill ${name}`, proj, undefined, undefined, frozen)
      assert.ok(!(viaSkill?.prompt ?? '').includes(body), `未授信时 /skill 不得展开项目槽位技能 ${name}（冻结快照残留）`)
      const bare = resolveAppPromptInput(`/${name}`, proj, undefined, undefined, frozen)
      assert.ok(!(bare?.prompt ?? '').includes(body), `未授信时裸名不得展开项目槽位技能 ${name}（冻结快照残留）`)
    }
    for (const [name, body] of [['gate-frozen-global', 'GATE-FROZEN-GLOBAL-BODY'], ['gate-frozen-builtin', 'GATE-FROZEN-BUILTIN-BODY'], ['gate-frozen-plugin', 'GATE-FROZEN-PLUGIN-BODY']] as const) {
      const viaSkill = resolveAppPromptInput(`/skill ${name}`, proj, undefined, undefined, frozen)
      assert.ok((viaSkill?.prompt ?? '').includes(body), `未授信时 /skill 须展开非项目技能 ${name}`)
      const bare = resolveAppPromptInput(`/${name}`, proj, undefined, undefined, frozen)
      assert.ok((bare?.prompt ?? '').includes(body), `未授信时裸名须展开非项目技能 ${name}`)
    }

    // 授信恢复：项目槽位技能立即可展开
    process.env.RIVET_TRUST_PROJECT = '1'
    const allowed = resolveAppPromptInput('/skill gate-frozen-rivet', proj, undefined, undefined, frozen)
    assert.ok((allowed?.prompt ?? '').includes('GATE-FROZEN-RIVET-BODY'), '授信后项目技能恢复展开')
  })

  it('commit-facts 侧车（recall 的 includeCommitFacts/hash 查询通道）：未授信不读；授信读到', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.deepEqual(readCommitFacts(proj), [], 'untrusted must not read commit-facts sidecar')

    process.env.RIVET_TRUST_PROJECT = '1'
    const facts = readCommitFacts(proj)
    assert.ok(facts.some(e => e.text.includes('GATE-PROBE-COMMIT-FACT')), 'trusted must read commit-facts sidecar')
  })

  it('授信切换即拍即生效（同进程内无缓存跳过结论）', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.equal(loadProjectRules(proj).length, 0)
    process.env.RIVET_TRUST_PROJECT = '1'
    assert.equal(loadProjectRules(proj).length, 1, 'no cached deny verdict — trust applies immediately')
  })
})
