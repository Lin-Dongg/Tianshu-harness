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
import { loadProjectSkills } from '../../skills/skill-loader.js'
import { resolveAppPromptInput } from '../../tui/prompt-input-resolver.js'
import { loadProjectRules } from '../../context/rules-loader.js'
import { loadCustomCommands, resolveCustomCommand } from '../../commands/loader.js'
import { renderMemoryBlock } from '../../memory/unified-memory.js'
import { loadPresence } from '../../agent/companion-presence.js'
import { resolvePlanContract, findApprovedPlanConstraints, resetApprovedPlanCache } from '../../agent/plan-constraints.js'
import { KnowledgeIndex } from '../../memory/knowledge-index.js'

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

  it('授信切换即拍即生效（同进程内无缓存跳过结论）', () => {
    process.env.RIVET_TRUST_PROJECT = '0'
    assert.equal(loadProjectRules(proj).length, 0)
    process.env.RIVET_TRUST_PROJECT = '1'
    assert.equal(loadProjectRules(proj).length, 1, 'no cached deny verdict — trust applies immediately')
  })
})
