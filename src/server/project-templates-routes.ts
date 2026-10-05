/**
 * GET /project-templates/status  — check whether a project needs first-run template init.
 * POST /project-templates/apply  — apply .rivet.md / AGENTS.md templates and record sentinel.
 *
 * Mirrors the TUI first-run prompt in `src/main.ts`, but exposed as HTTP routes
 * so the desktop UI can drive the same flow with a modal/banner.
 */
import type { RouteHandler } from './index.js'
import { statSync } from 'node:fs'
import { isAuthorizedRequest } from './auth.js'
import { isKnownWorkspace, UNKNOWN_WORKSPACE_ERROR } from './workspace-guard.js'
import {
  needsTemplatesInit,
  applyProjectTemplates,
  recordTemplatesDecision,
  AGENTS_MD_TEMPLATE,
  RIVET_MD_TEMPLATE,
  type ApplyTemplatesOptions,
  type ApplyTemplatesResult,
} from '../bootstrap/project-templates.js'

/** 工作区已注册、但目录已从磁盘消失。 */
export const WORKSPACE_MISSING_ERROR = 'workspace-missing'

/**
 * 已注册的工作区目录是否真的还在磁盘上。
 *
 * 「在册」来自存活会话 cwd + 默认工作区——测试临时目录被删后会话仍留在会话库
 * 里，路径照样在册（现场：21 个 fac-* 测试会话）。此时 applyProjectTemplates 的
 * writeFileSync 会抛 ENOENT；status 则会对不存在的目录回 needsInit=true，
 * 诱导桌面端弹「初始化模板」从而踩中同一条崩溃路径。两处都先挡在门口。
 * fail-closed：stat 失败（不存在 / 不是目录 / 权限）一律视为不可用。
 */
function workspaceDirAvailable(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

export interface ProjectTemplatesStatus {
  needsInit: boolean
  cwd: string
  agentsTemplate: string
  rivetTemplate: string
}

export interface ProjectTemplatesApplyBody {
  cwd: string
  agentsMode: ApplyTemplatesOptions['agentsMode']
}

/**
 * @param knownWorkspaces 已注册工作区（存活会话 cwd + 默认工作区）。缺省为空 =
 * 拒绝一切 cwd——fail-closed，装配点必须显式提供（issue #221）。
 */
export function buildProjectTemplatesRoutes(
  apiToken?: string,
  knownWorkspaces: () => string[] = () => [],
): Record<string, RouteHandler> {
  return {
    'GET /project-templates/status': (body, params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
      if (!cwd) return { status: 400, body: { error: 'Missing cwd query parameter' } }
      if (!isKnownWorkspace(cwd, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }
      if (!workspaceDirAvailable(cwd)) {
        return { status: 404, body: { error: WORKSPACE_MISSING_ERROR } }
      }
      const status: ProjectTemplatesStatus = {
        needsInit: needsTemplatesInit(cwd),
        cwd,
        agentsTemplate: AGENTS_MD_TEMPLATE,
        rivetTemplate: RIVET_MD_TEMPLATE,
      }
      return { status: 200, body: status }
    },

    'POST /project-templates/apply': (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const input = body as ProjectTemplatesApplyBody
      const cwd = typeof input?.cwd === 'string' ? input.cwd : ''
      const agentsMode = input?.agentsMode ?? 'overwrite'
      if (!cwd) return { status: 400, body: { error: 'Missing cwd' } }
      if (!isKnownWorkspace(cwd, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }
      if (!['overwrite', 'append', 'skip'].includes(agentsMode)) {
        return { status: 400, body: { error: 'Invalid agentsMode' } }
      }
      if (!workspaceDirAvailable(cwd)) {
        return { status: 404, body: { error: WORKSPACE_MISSING_ERROR } }
      }

      const result: ApplyTemplatesResult = applyProjectTemplates(cwd, { agentsMode })
      const decision = agentsMode === 'skip' ? 'declined' : 'created'
      recordTemplatesDecision(cwd, decision, {
        created: result.created,
        appended: result.appended,
        skipped: result.skipped,
      })
      return { status: 200, body: { ...result, decision } }
    },
  }
}
