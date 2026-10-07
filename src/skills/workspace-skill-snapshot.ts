import { rivetHome } from '../config/paths.js'
import { projectSurfaceAllowed } from '../config/project-trust.js'
import { SkillManagement } from './skill-management.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SkillRegistry, registerBuiltinSkills, skillRegistry, type SkillSource } from './skill-loader.js'

/** Discovery and explicit invocation must not seed files or mutate live session registries. */
export function workspaceSkillSnapshot(cwd?: string, home = homedir(), nativeHome = home === homedir() ? rivetHome() : join(home, '.rivet')) {
  const registry = new SkillRegistry()
  registerBuiltinSkills(registry)
  for (const skill of skillRegistry.list()) if (skill.source === 'plugin') registry.register(skill)
  const directories: Array<[string, SkillSource]> = [
    [join(home, '.agents', 'skills'), 'global-agents'], [join(nativeHome, 'skills'), 'global-rivet'],
  ]
  // 未授信项目不装载项目技能目录（2026-10-07 审计 Finding 1 第二入口：slash 解析
  // 经本快照装载项目技能，独立于 loadProjectSkills 的门——同契约收口）。list 同样
  // 不传 cwd（SkillManagement.list 对 cwd 会无条件读项目槽位）。
  const listCwd = cwd && projectSurfaceAllowed(cwd, 'skills') ? cwd : undefined
  if (listCwd) directories.push([join(listCwd, '.agents', 'skills'), 'project-agents'], [join(listCwd, '.rivet', 'skills'), 'rivet'])
  const errors: string[] = []
  for (const [directory, source] of directories) errors.push(...registry.loadFromDirectory(directory, source).errors)
  const catalog = new SkillManagement(nativeHome, home).list(listCwd)
  for (const managed of catalog.skills) if (!managed.shadowedBy) {
    const skill = registry.get(managed.name)
    if (skill) skill.mode = managed.mode
  }
  return { registry, errors }
}
