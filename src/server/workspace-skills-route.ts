import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import type { RouteHandler } from './index.js'
import { withAuth } from './route-auth.js'
import { getWorkspaceConfig } from '../config/workspace-config.js'
import { workspaceSkillSnapshot } from '../skills/workspace-skill-snapshot.js'

/** Preview without seeding files or changing the registry of running sessions. */
export function previewWorkspaceSkills(cwd?: string, home = homedir()) {
  const { registry, errors } = workspaceSkillSnapshot(cwd, home)
  return {
    skills: registry.list().map(skill => ({
      name: skill.name, description: skill.description, source: skill.source ?? 'builtin',
      enabled: true, editable: false,
    })),
    loadErrors: errors,
  }
}

export function buildWorkspaceSkillsRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /workspace/skills': withAuth(async (_body, params) => {
      const cwd = typeof params?.cwd === 'string' ? params.cwd : getWorkspaceConfig().defaultDir
      if (cwd) {
        if (!isAbsolute(cwd)) return { status: 400, body: { error: 'Workspace directory must be absolute' } }
        try {
          if (!(await stat(cwd)).isDirectory()) return { status: 400, body: { error: 'Not a directory' } }
        } catch { return { status: 404, body: { error: 'Workspace directory is unavailable' } } }
      }
      return { status: 200, body: previewWorkspaceSkills(cwd ?? undefined) }
    }, apiToken),
  }
}
