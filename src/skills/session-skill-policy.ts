import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionDir } from '../agent/session-persist.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { assertValidSessionId } from '../validation.js'
import type { SkillMode } from './skill-metadata.js'
import type { SkillRegistry } from './skill-loader.js'

function path(cwd: string, sessionId: string) { assertValidSessionId(sessionId); return join(getSessionDir(cwd), `${sessionId}.skill-modes.json`) }
export function sessionSkillModes(cwd: string, sessionId: string): Record<string, SkillMode> {
  const file = path(cwd, sessionId)
  const modes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  if (!modes || typeof modes !== 'object' || Array.isArray(modes) || Object.values(modes).some(v => !['auto', 'manual', 'off'].includes(String(v)))) throw new Error('Invalid session skill modes')
  return modes
}
export function queueSessionSkillMode(cwd: string, sessionId: string, registry: SkillRegistry, name: string, mode: SkillMode) {
  if (!registry.get(name)) throw new Error('Skill is not in this session snapshot')
  if (!['auto', 'manual', 'off'].includes(mode)) throw new Error('Invalid mode')
  writeFileAtomicSync(path(cwd, sessionId), JSON.stringify({ ...sessionSkillModes(cwd, sessionId), [name]: mode }))
  return { name, mode, effective: 'next-user-message' }
}
/** Called only at a user boundary, before discovery and execution of that turn. */
export function applySessionSkillModes(cwd: string, sessionId: string | undefined, registry: SkillRegistry, disabled = new Set<string>()) {
  const modes = sessionId ? sessionSkillModes(cwd, sessionId) : {}
  for (const skill of registry.list()) {
    if (modes[skill.name]) skill.mode = modes[skill.name]
    if (disabled.has(skill.name)) skill.mode = 'off'
  }
}
