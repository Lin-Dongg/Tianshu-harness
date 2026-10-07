import { grantPath } from '../tools/path-grants.js'
import { projectSurfaceAllowed } from '../config/project-trust.js'
import { applySessionSkillModes } from './session-skill-policy.js'
import { existsSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionDir } from '../agent/session-persist.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { SkillRegistry, skillRegistry, BUILTIN_SKILLS, type SkillDefinition } from './skill-loader.js'
import { SkillManagement, type SkillOrigin } from './skill-management.js'
import { isSafeFileName } from '../utils/safe-path.js'
import { assertValidSessionId } from '../validation.js'
import { inside, readPackage, validateResourcePath, type PackageFile } from './skill-package.js'

interface FrozenSkill extends Omit<SkillDefinition, 'triggers'> { triggers: string[]; resources: PackageFile[]; origin?: SkillOrigin }
interface Snapshot { v: 1; skills: FrozenSkill[] }
/** A registry belongs to a session. Neither catalog refresh nor installation can replace it. */
export function sessionSkillSnapshot(cwd: string, sessionId?: string, management = new SkillManagement()): SkillRegistry {
  if (sessionId) assertValidSessionId(sessionId)
  const path = sessionId ? join(getSessionDir(cwd), `${sessionId}.skills.json`) : undefined
  let snapshot: Snapshot
  if (path && existsSync(path)) {
    snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot
    if (snapshot.v !== 1 || !Array.isArray(snapshot.skills)) throw new Error('Invalid session skill snapshot; refusing to replace its pinned versions')
  } else {
    // 未授信项目不把项目技能冻进会话快照（2026-10-07 审计 Finding 1 第二入口：
    // 快照被 slash 解析消费，正文经 /skill 或裸名进用户消息）。
    const listCwd = projectSurfaceAllowed(cwd, 'skills') ? cwd : undefined
    snapshot = { v: 1, skills: management.list(listCwd).skills.filter(s => !s.shadowedBy).map(s => {
      const pkg = s.path ? readPackage(s.path.endsWith('/SKILL.md') ? join(s.path, '..') : s.path) : undefined
      const definition = pkg?.definition ?? skillRegistry.get(s.name) ?? BUILTIN_SKILLS.find(def => def.name === s.name)
      if (!definition) throw new Error(`Missing skill definition: ${s.name}`)
      return { ...definition, skillId: s.skillId, version: s.version, origin: s.origin, name: s.name, source: s.source, bodyPath: s.path, mode: s.mode,
        triggers: definition.triggers.map(t => t.source), resources: pkg?.files ?? [], files: s.files.filter(p => p !== 'SKILL.md').map(p => ({ path: p, kind: 'file' as const })) }
    }) }
    if (path) writeFileAtomicSync(path, JSON.stringify(snapshot))
  }
  const registry = new SkillRegistry()
  for (const skill of snapshot.skills) {
    validateResourcePath(skill.name)
    if (!isSafeFileName(skill.name) || !Array.isArray(skill.resources) || typeof skill.body !== 'string') throw new Error('Invalid snapshot skill')
    const skillDir = skill.resources.length > 1 ? path ? join(getSessionDir(cwd), sessionId!, 'skills', skill.name) : skill.bodyPath ? join(skill.bodyPath, '..') : undefined : undefined
    if (skillDir && path) {
      for (const file of skill.resources) {
        // The persisted snapshot is authoritative even if a cached resource was edited.
        validateResourcePath(file.path)
        const destination = inside(skillDir, file.path)
        const bytes = Buffer.from(file.data, 'base64')
        if (!existsSync(destination) || !readFileSync(destination).equals(bytes)) writeFileAtomicSync(destination, bytes)
        if (file.executable) chmodSync(destination, 0o755)
      }
    }
    if (skillDir && path) grantPath(skillDir, 'read', { cwd, persist: false })
    registry.register({ ...skill, skillDir, triggers: skill.triggers.map(t => new RegExp(t, 'i')) })
  }
  applySessionSkillModes(cwd, sessionId, registry)
  return registry
}
