import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { previewWorkspaceSkills } from '../workspace-skills-route.js'
import { buildWorkspaceRoutes } from '../workspace-route.js'
import { skillRegistry } from '../../skills/skill-loader.js'

/** 项目技能装载自 2667803f6（信任门下沉到 workspaceSkillSnapshot）起要求项目已授信。
 *  fixture 是 mkdtemp 临时目录、天然未授信。RIVET_TRUST_PROJECT 是文档明示的
 *  CI/无头授信开关（project-trust.ts:10）——不写信任文件、不污染真实 home。
 *  每个用例内联设置并在 finally 恢复；不要把恢复写在 async 回调外层。 */
const TRUST_ENV = 'RIVET_TRUST_PROJECT'
function setTrust(): () => void {
  const prior = process.env[TRUST_ENV]
  process.env[TRUST_ENV] = '1'
  return () => {
    if (prior === undefined) delete process.env[TRUST_ENV]
    else process.env[TRUST_ENV] = prior
  }
}

test('welcome discovery follows skill precedence, isolates projects and leaves live registry/files untouched', () => {
  const restoreTrust = setTrust()
  const root = mkdtempSync(join(tmpdir(), 'welcome-skills-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const other = join(root, 'other')
  const add = (dir: string, name: string, description: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nInstructions`)
  }
  const before = skillRegistry.list()
  try {
    add(join(home, '.agents', 'skills'), 'shared', 'agents-global')
    add(join(home, '.rivet', 'skills'), 'shared', 'rivet-global')
    add(join(project, '.agents', 'skills'), 'shared', 'agents-project')
    add(join(project, '.rivet', 'skills'), 'shared', 'rivet-project')
    add(join(project, '.rivet', 'skills'), 'project-only', 'Only this project')
    mkdirSync(other)
    const preview = previewWorkspaceSkills(project, home)
    assert.equal(preview.skills.find(s => s.name === 'shared')?.description, 'rivet-project')
    assert.ok(preview.skills.some(s => s.name === 'project-only' && s.enabled))
    assert.equal(previewWorkspaceSkills(other, home).skills.find(s => s.name === 'shared')?.description, 'rivet-global')
    assert.ok(!previewWorkspaceSkills(other, home).skills.some(s => s.name === 'project-only'))
    assert.deepEqual(skillRegistry.list(), before)
    assert.equal(existsSync(join(other, '.rivet')), false)
  } finally { rmSync(root, { recursive: true, force: true }); restoreTrust() }
})

test('welcome skill route is wired and authenticated without creating a session', async () => {
  const restoreTrust = setTrust()
  const root = mkdtempSync(join(tmpdir(), 'welcome-skills-route-'))
  const handler = buildWorkspaceRoutes('welcome-test')['GET /workspace/skills']!
  const auth = { authorization: 'Bearer welcome-test' }
  try {
    mkdirSync(join(root, '.rivet', 'skills'), { recursive: true })
    writeFileSync(join(root, '.rivet', 'skills', 'welcome-test.md'), '---\nname: welcome-test\ndescription: Before first message\n---\nInstructions')
    assert.equal((await handler(undefined, { cwd: root }, {})).status, 401)
    const result = await handler(undefined, { cwd: root }, auth)
    assert.equal(result.status, 200)
    assert.ok((result.body as { skills: { name: string }[] }).skills.some(s => s.name === 'welcome-test'))
    assert.equal((await handler(undefined, { cwd: 'relative' }, auth)).status, 400)
    assert.equal((await handler(undefined, { cwd: join(root, 'missing') }, auth)).status, 404)
  } finally { rmSync(root, { recursive: true, force: true }); restoreTrust() }
})
