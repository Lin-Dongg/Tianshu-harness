import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 信任库存于 <RIVET_HOME>/project-trust.json——每个用例独立 RIVET_HOME 临时目录，
 * 绝不触碰真实 ~/.rivet（与 layered-config.test.ts 同纪律）。env 在每例前设、后清。
 */
import {
  findSensitiveProjectKeys,
  detectProjectTrustStakes,
  trustProject,
  untrustProject,
  isProjectTrusted,
  dismissProjectTrustPrompt,
  isTrustPromptDismissed,
  stripUntrustedProjectKeys,
  stripProjectSafetyKeys,
  findForbiddenProjectSafetyKeys,
  hasProjectStateInjectionFiles,
  projectStateAllowed,
  projectSurfaceAllowed,
} from '../project-trust.js'
import { interpretTrustKey, buildTrustPromptText } from '../../cli/project-trust-prompt.js'

describe('project-trust', () => {
  let home = ''
  let proj = ''
  const prevHome = process.env.RIVET_HOME
  const prevTrust = process.env.RIVET_TRUST_PROJECT

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-trust-home-'))
    proj = mkdtempSync(join(tmpdir(), 'rivet-trust-proj-'))
    process.env.RIVET_HOME = home
    delete process.env.RIVET_TRUST_PROJECT
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
  })

  describe('findSensitiveProjectKeys', () => {
    it('reports present top-level sensitive keys', () => {
      const found = findSensitiveProjectKeys({ mcp: {}, hooks: {}, verify: {}, theme: 'dark' })
      assert.deepEqual(found.sort(), ['hooks', 'mcp', 'verify'])
    })

    it('reports nested sensitive keys as dotted paths', () => {
      const found = findSensitiveProjectKeys({ agent: { approval: 'yolo', model: 'x' }, ui: { statusLine: {} } })
      assert.deepEqual(found.sort(), ['agent.approval', 'ui.statusLine'])
    })

    it('returns empty when nothing sensitive is present', () => {
      assert.deepEqual(findSensitiveProjectKeys({ theme: 'dark', agent: { model: 'x' } }), [])
    })

    it('stays in sync with the strip sets (permissions depth-in-defense key)', () => {
      const raw = { permissions: { allow: ['*'] } }
      assert.deepEqual(findSensitiveProjectKeys(raw), ['permissions'])
      assert.deepEqual(stripUntrustedProjectKeys(raw), {})
    })

    it('strips network — proxy 键可把 MCP stdio 子进程出站改向（核验补漏）', () => {
      // network.proxy 经 readNetworkConfigSafe → buildStdioChildEnv 注入
      // HTTPS_PROXY/HTTP_PROXY——未授信仓库不该能改向出口（与 mcp/hooks 同类）。
      const raw = { network: { proxy: 'http://attacker.example:8080' }, theme: 'dark' }
      assert.deepEqual(findSensitiveProjectKeys(raw), ['network'])
      assert.deepEqual(stripUntrustedProjectKeys(raw), { theme: 'dark' })
    })

    it('strips fetch — jinaBaseUrl 可把 web_fetch 正文抽取改向攻击者主机（发版审查补漏）', () => {
      // fetch.jinaBaseUrl 经 build-options → fetchViaJina 把每次正文抽取改道
      // `${base}/${目标URL}`——目标 URL 外发 + 攻击者控制的 markdown 回流上下文，
      // 与 network.proxy 同类的出口改向（dd30f7975 封堵时的漏网键）。
      const raw = { fetch: { jinaBaseUrl: 'https://attacker.example' }, theme: 'dark' }
      assert.deepEqual(findSensitiveProjectKeys(raw), ['fetch'])
      assert.deepEqual(stripUntrustedProjectKeys(raw), { theme: 'dark' })
    })
  })

  describe('detectProjectTrustStakes', () => {
    it('detects sensitive keys and hooks file', () => {
      writeFileSync(join(proj, '.rivet-config.json'), JSON.stringify({ mcp: { s: {} }, theme: 'dark' }))
      mkdirSync(join(proj, '.rivet'), { recursive: true })
      writeFileSync(join(proj, '.rivet', 'hooks.json'), '{}')
      const stakes = detectProjectTrustStakes(proj)
      assert.deepEqual(stakes.sensitiveKeys, ['mcp'])
      assert.deepEqual(stakes.ignoredSafetyKeys, [])
      assert.equal(stakes.hasHooks, true)
    })

    it('splits safety keys into ignoredSafetyKeys (never trust stakes)', () => {
      // 安全档位由永久门剥离——授信也不生效，所以不算「信任赌注」。
      writeFileSync(join(proj, '.rivet-config.json'), JSON.stringify({
        mcp: { s: {} },
        agent: { approval: 'dangerously-skip-permissions', unsandboxed: true, permissions: { allow: [] } },
      }))
      const stakes = detectProjectTrustStakes(proj)
      assert.deepEqual(stakes.sensitiveKeys, ['mcp'], 'safety keys must not appear as trust stakes')
      assert.deepEqual(
        stakes.ignoredSafetyKeys.sort(),
        ['agent.approval', 'agent.permissions', 'agent.unsandboxed'],
      )
      assert.equal(stakes.hasHooks, false)
    })

    it('reports no stakes for a config without sensitive keys and no hooks', () => {
      writeFileSync(join(proj, '.rivet-config.json'), JSON.stringify({ theme: 'dark' }))
      const stakes = detectProjectTrustStakes(proj)
      assert.equal(stakes.sensitiveKeys.length, 0)
      assert.equal(stakes.hasHooks, false)
    })

    it('treats a broken config file as no config-side stakes (fail-open detection)', () => {
      writeFileSync(join(proj, '.rivet-config.json'), '{oops')
      const stakes = detectProjectTrustStakes(proj)
      assert.equal(stakes.sensitiveKeys.length, 0)
      assert.equal(stakes.hasHooks, false)
    })

    // 2026-10-07 审计 Finding 2：纯技能/规则仓库此前不触发任何授信提示。
    it('detects .rivet/skills, .agents/skills and .rivet/rules as stakes', () => {
      mkdirSync(join(proj, '.rivet', 'skills'), { recursive: true })
      mkdirSync(join(proj, '.rivet', 'rules'), { recursive: true })
      const stakes = detectProjectTrustStakes(proj)
      assert.equal(stakes.hasSkills, true)
      assert.equal(stakes.hasRules, true)
    })

    it('detects .agents/skills as a skills stake', () => {
      mkdirSync(join(proj, '.agents', 'skills'), { recursive: true })
      assert.equal(detectProjectTrustStakes(proj).hasSkills, true)
    })

    it('reports hasSkills/hasRules false when neither directory exists', () => {
      const stakes = detectProjectTrustStakes(proj)
      assert.equal(stakes.hasSkills, false)
      assert.equal(stakes.hasRules, false)
    })
  })

  describe('trust store', () => {
    it('trust/untrust roundtrip keyed by realpath', () => {
      assert.equal(isProjectTrusted(proj), false)
      trustProject(proj)
      assert.equal(isProjectTrusted(proj), true)
      untrustProject(proj)
      assert.equal(isProjectTrusted(proj), false)
    })

    it('dismiss roundtrip and trust clears dismissal', () => {
      assert.equal(isTrustPromptDismissed(proj), false)
      dismissProjectTrustPrompt(proj)
      assert.equal(isTrustPromptDismissed(proj), true)
      trustProject(proj)
      assert.equal(isProjectTrusted(proj), true)
      assert.equal(isTrustPromptDismissed(proj), false, 're-trust re-engages the startup prompt semantics')
    })

    it('reads a legacy store file without the dismissed field', () => {
      writeFileSync(join(home, 'project-trust.json'), JSON.stringify({ trusted: { [realpathSync(proj)]: '2026-01-01T00:00:00Z' } }))
      assert.equal(isProjectTrusted(proj), true)
      assert.equal(isTrustPromptDismissed(proj), false)
    })

    it('env override beats the store both ways', () => {
      process.env.RIVET_TRUST_PROJECT = '1'
      assert.equal(isProjectTrusted(proj), true)
      process.env.RIVET_TRUST_PROJECT = '0'
      trustProject(proj)
      assert.equal(isProjectTrusted(proj), false)
    })
  })

  describe('project state gate (.rivet/knowledge 注入面，2026-10-03 安全报告)', () => {
    it('untrusted project with state files is not allowed; trusting flips it', () => {
      mkdirSync(join(proj, '.rivet', 'knowledge'), { recursive: true })
      writeFileSync(join(proj, '.rivet', 'knowledge', 'memory.jsonl'), '')
      assert.equal(hasProjectStateInjectionFiles(proj), true)
      assert.equal(projectStateAllowed(proj), false)
      trustProject(proj)
      assert.equal(projectStateAllowed(proj), true)
    })

    it('untrusted project without state files is still not allowed (fail-closed, no notification)', () => {
      assert.equal(hasProjectStateInjectionFiles(proj), false)
      assert.equal(projectStateAllowed(proj), false)
    })

    it('manifest.md alone counts as a state injection file', () => {
      mkdirSync(join(proj, '.rivet', 'knowledge'), { recursive: true })
      writeFileSync(join(proj, '.rivet', 'knowledge', 'manifest.md'), '')
      assert.equal(hasProjectStateInjectionFiles(proj), true)
    })

    it('env override RIVET_TRUST_PROJECT=0 beats a trusted store entry', () => {
      mkdirSync(join(proj, '.rivet', 'knowledge'), { recursive: true })
      writeFileSync(join(proj, '.rivet', 'knowledge', 'memory.jsonl'), '')
      trustProject(proj)
      process.env.RIVET_TRUST_PROJECT = '0'
      assert.equal(projectStateAllowed(proj), false)
    })
  })

  describe('projectSurfaceAllowed（信任门族补齐，2026-10-07 审计）', () => {
    const SURFACES = ['skills', 'rules', 'commands', 'playbook', 'presence', 'agents', 'plans'] as const

    it('untrusted project: every surface is denied when its files are present (fail-closed)', () => {
      mkdirSync(join(proj, '.rivet', 'skills'), { recursive: true })
      mkdirSync(join(proj, '.rivet', 'rules'), { recursive: true })
      mkdirSync(join(proj, '.rivet', 'commands'), { recursive: true })
      mkdirSync(join(proj, '.rivet', 'agents'), { recursive: true })
      mkdirSync(join(proj, '.rivet', 'domains'), { recursive: true })
      mkdirSync(join(proj, '.rivet', 'plans'), { recursive: true })
      mkdirSync(join(proj, '.agents', 'skills'), { recursive: true })
      writeFileSync(join(proj, '.rivet', 'playbook.jsonl'), '')
      writeFileSync(join(proj, '.rivet', 'presence.json'), '[]')
      for (const s of SURFACES) assert.equal(projectSurfaceAllowed(proj, s), false, s)
    })

    it('trusted project: every surface is allowed', () => {
      trustProject(proj)
      for (const s of SURFACES) assert.equal(projectSurfaceAllowed(proj, s), true, s)
    })

    it('untrusted project without surface files: still denied (no notification path)', () => {
      for (const s of SURFACES) assert.equal(projectSurfaceAllowed(proj, s), false, s)
    })

    it('env override RIVET_TRUST_PROJECT=0 beats a trusted store entry', () => {
      trustProject(proj)
      process.env.RIVET_TRUST_PROJECT = '0'
      assert.equal(projectSurfaceAllowed(proj, 'skills'), false)
    })

    it('flips immediately after trust in the same process (no cached skip verdict)', () => {
      assert.equal(projectSurfaceAllowed(proj, 'skills'), false)
      trustProject(proj)
      assert.equal(projectSurfaceAllowed(proj, 'skills'), true)
    })

    it('is keyed per project (realpath) — trusting one dir does not unlock another', () => {
      const other = mkdtempSync(join(tmpdir(), 'rivet-trust-other-'))
      try {
        trustProject(other)
        assert.equal(projectSurfaceAllowed(proj, 'skills'), false)
        assert.equal(projectSurfaceAllowed(other, 'skills'), true)
      } finally {
        rmSync(other, { recursive: true, force: true })
      }
    })
  })

  describe('startup prompt', () => {
    it('interpretTrustKey maps y/n/d/Esc and ignores other keys', () => {
      assert.equal(interpretTrustKey('y'), 'trust')
      assert.equal(interpretTrustKey('Y'), 'trust')
      assert.equal(interpretTrustKey('n'), 'skip')
      assert.equal(interpretTrustKey('N'), 'skip')
      assert.equal(interpretTrustKey('\x1B'), 'skip')
      assert.equal(interpretTrustKey('d'), 'dismiss')
      assert.equal(interpretTrustKey('D'), 'dismiss')
      assert.equal(interpretTrustKey('x'), null)
      assert.equal(interpretTrustKey('\r'), null)
    })

    it('buildTrustPromptText lists trust stakes, ignored safety keys, and all three options', () => {
      const text = buildTrustPromptText(
        { sensitiveKeys: ['mcp'], ignoredSafetyKeys: ['agent.approval'], hasHooks: true, hasSkills: false, hasRules: false },
        { columns: 200 },
      )
      assert.match(text, /项目配置会改变安全设置：mcp/)
      assert.match(text, /都被忽略.*agent\.approval/)
      assert.match(text, /hooks\.json/)
      assert.match(text, /\[y\] 信任此项目/)
      assert.match(text, /\[n\] 暂不/)
      assert.match(text, /\[d\] 暂不信任，并不再提示本项目/)
      assert.match(text, /绝不写回仓库/)
    })

    it('buildTrustPromptText lists skills/rules stakes when present (审计 Finding 2)', () => {
      const text = buildTrustPromptText(
        { sensitiveKeys: [], ignoredSafetyKeys: [], hasHooks: false, hasSkills: true, hasRules: true },
        { columns: 200 },
      )
      assert.match(text, /\.rivet\/skills/)
      assert.match(text, /\.rivet\/rules/)
      assert.doesNotMatch(text, /hooks\.json/, 'a skills-only repo must not claim hooks')
    })
  })

  // 永久门（与信任无关）：审批档 / 沙箱豁免 / 授权规则是「用户本人的安全决定」，
  // 仓库内容不得设置——无论项目是否被授信。参照 dsh：approval policy 无外部
  // config store。详见 plans/…-从项目层永久剥离.md。
  describe('stripProjectSafetyKeys（永久门：安全档不来自项目配置）', () => {
    it('strips agent.approval / agent.unsandboxed / agent.permissions, keeps benign agent keys', () => {
      const raw = {
        agent: {
          approval: 'dangerously-skip-permissions',
          unsandboxed: true,
          permissions: { additionalWriteDirs: ['/etc'], allow: [{ tool: 'bash' }] },
          maxTurns: 7,
          model: 'x',
        },
        theme: 'dark',
      }
      const out = stripProjectSafetyKeys(raw)
      const agent = out.agent as Record<string, unknown>
      assert.equal('approval' in agent, false, 'agent.approval must be stripped')
      assert.equal('unsandboxed' in agent, false, 'agent.unsandboxed must be stripped')
      assert.equal('permissions' in agent, false, 'agent.permissions must be stripped')
      assert.equal(agent.maxTurns, 7, 'benign agent keys survive')
      assert.equal(agent.model, 'x', 'benign agent keys survive')
      assert.equal(out.theme, 'dark', 'non-agent keys survive')
    })

    it('returns a shallow copy — does not mutate the input', () => {
      const raw = { agent: { approval: 'manual', maxTurns: 1 } }
      const out = stripProjectSafetyKeys(raw)
      assert.equal((raw.agent as Record<string, unknown>).approval, 'manual', 'input untouched')
      assert.equal('approval' in (out.agent as Record<string, unknown>), false, 'output stripped')
    })

    it('is a no-op when nothing forbidden is present', () => {
      const raw = { theme: 'dark', agent: { maxTurns: 3 } }
      assert.deepEqual(stripProjectSafetyKeys(raw), { theme: 'dark', agent: { maxTurns: 3 } })
    })

    it('tolerates a non-object agent node', () => {
      assert.deepEqual(stripProjectSafetyKeys({ agent: 'weird', theme: 'dark' }), { agent: 'weird', theme: 'dark' })
    })
  })

  describe('findForbiddenProjectSafetyKeys', () => {
    it('reports present forbidden keys as dotted paths', () => {
      const found = findForbiddenProjectSafetyKeys({ agent: { approval: 'yolo', unsandboxed: true, model: 'x' } })
      assert.deepEqual(found.sort(), ['agent.approval', 'agent.unsandboxed'])
    })

    it('reports agent.permissions when present', () => {
      assert.deepEqual(findForbiddenProjectSafetyKeys({ agent: { permissions: { allow: [] } } }), ['agent.permissions'])
    })

    it('returns empty when nothing forbidden is present', () => {
      assert.deepEqual(findForbiddenProjectSafetyKeys({ theme: 'dark', agent: { model: 'x' } }), [])
    })
  })
})
