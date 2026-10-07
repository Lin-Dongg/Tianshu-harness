import { SkillManagement } from './skill-management.js'
import { parseSkillMarkdown } from './skill-loader.js'
import { fingerprint } from './skill-package.js'

/** Legacy name-based API: scope comes from the session, never from the process singleton. */
export function legacyReadSkill(cwd: string, name: string) {
  const management = new SkillManagement()
  const skill = management.list(cwd).skills.find(s => s.name === name && !s.shadowedBy)
  return skill ? management.content(skill.skillId, cwd) ?? null : null
}
export function legacyWriteSkill(cwd: string, name: string, content: string, scope: 'project' | 'global') {
  const management = new SkillManagement(), target = { scope: scope === 'global' ? 'personal' as const : 'project' as const, cwd }
  const definition = parseSkillMarkdown(content, name)
  if (definition.name !== name) throw new Error('Skill name must match its declaration')
  const existing = management.list(cwd).skills.find(s => s.name === name && s.scope === target.scope && s.editable)
  if (existing) { management.edit(existing.skillId, content, existing.version, cwd); return { path: existing.path! } }
  const files = [{ path: 'SKILL.md', data: Buffer.from(content).toString('base64'), executable: false }]
  const result = management.install({ definition, files, fingerprint: fingerprint(files), subpath: '' }, target, { origin: { kind: 'text', fingerprint: fingerprint(files) } })
  if (!result.skillId) throw new Error('Skill already exists')
  return { path: management.inspect(result.skillId, cwd).path! }
}
export function legacyRemoveSkill(cwd: string, name: string) {
  const management = new SkillManagement()
  const skill = management.list(cwd).skills.find(s => s.name === name && s.scope === 'project' && s.editable)
  if (!skill) return { removed: false, wasDir: false }
  management.remove(skill.skillId, skill.version, cwd)
  return { removed: true, wasDir: skill.path?.endsWith('SKILL.md') ?? false }
}
