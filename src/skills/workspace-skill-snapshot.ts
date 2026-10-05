import { homedir } from 'node:os'
import { join } from 'node:path'
import { SkillRegistry, registerBuiltinSkills, skillRegistry, type SkillSource } from './skill-loader.js'

/** Discovery and explicit invocation must not seed files or mutate live session registries. */
export function workspaceSkillSnapshot(cwd?: string, home = homedir()) {
  const registry = new SkillRegistry()
  registerBuiltinSkills(registry)
  for (const skill of skillRegistry.list()) if (skill.source === 'plugin') registry.register(skill)
  const directories: Array<[string, SkillSource]> = [
    [join(home, '.agents', 'skills'), 'global-agents'], [join(home, '.rivet', 'skills'), 'global-rivet'],
  ]
  if (cwd) directories.push([join(cwd, '.agents', 'skills'), 'project-agents'], [join(cwd, '.rivet', 'skills'), 'rivet'])
  const errors: string[] = []
  for (const [directory, source] of directories) errors.push(...registry.loadFromDirectory(directory, source).errors)
  return { registry, errors }
}
