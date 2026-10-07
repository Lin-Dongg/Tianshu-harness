import { sessionSkillSnapshot } from '../skills/session-skill-snapshot.js'
import { previewWorkspaceSkills } from './workspace-skills-route.js'
import { resolveAppPromptInput } from '../tui/prompt-input-resolver.js'
import { getPaletteCommands } from '../tui/command-palette.js'
import type { RuntimeSessionManager } from './session-manager.js'

export class SlashPromptError extends Error {}
export function resolveSlashCommandPrompt(prompt: string, cwd: string, sessionId?: string) {
  const known = new Set(getPaletteCommands().filter(c => c.name.startsWith('/')).map(c => c.name.slice(1).split(/\s/)[0]!))
  const resolved = resolveAppPromptInput(prompt.trim(), cwd, name => known.has(name), undefined, sessionId ? sessionSkillSnapshot(cwd, sessionId) : undefined)
  if (!resolved) throw new SlashPromptError(`Unknown slash command: "${prompt.trim().split(/\s+/)[0]}". Type a normal message or use the command menu (+).`)
  return resolved
}
export function isDraftSessionId(id?: string): boolean { return !id || ['draft', 'new', 'default'].includes(id.trim().toLowerCase()) }
export function draftSkills(manager: RuntimeSessionManager, cwd?: string) {
  return previewWorkspaceSkills(cwd || manager.getDefaultCwd())
}

export function prepareSessionPrompt(prompt: unknown, accept: (resolved: ReturnType<typeof resolveSlashCommandPrompt>) => void) {
  return (cwd: string) => {
    if (typeof prompt === 'string' && prompt.trim().startsWith('/')) accept(resolveSlashCommandPrompt(prompt, cwd))
  }
}
