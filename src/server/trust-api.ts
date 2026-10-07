/**
 * /project/trust — 桌面端的项目授信入口。
 *
 * 信任门（config/project-trust.ts）对未授信项目剥离安全敏感键
 * （mcp.servers / agent.approval / agent.permissions / plugins / mirrors …），
 * 项目级 hooks 也不执行。但此前只有 CLI 能授信——`--trust` / `/trust` /
 * RIVET_TRUST_PROJECT；桌面端侧只有一句注释「桌面端项目信任 UI 落地前的
 * fail-closed」（serve-agent.ts），于是终端用户在桌面端配了项目级 MCP，
 * 看到的是「服务器全没了」且无处恢复。
 *
 * 本路由补齐这一环：
 *   GET  /project/trust?cwd=<dir>  → 授信状态 + 会被剥离的敏感键 + hooks 赌注
 *   POST /project/trust            → { cwd, trusted } 授信 / 撤销（幂等）
 *
 * cwd 必须由调用方给出：桌面端的「项目」是会话工作区，而 sidecar 进程的 cwd
 * 未必是它（安装目录 / 启动目录）。缺省才回落到 process.cwd()。
 */

import { dirname } from 'node:path'
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { isKnownWorkspace, UNKNOWN_WORKSPACE_ERROR } from './workspace-guard.js'
import { findProjectConfig } from '../config/manager.js'
import { isProjectTrusted, isTrustPromptDismissed, trustProject, untrustProject, dismissProjectTrustPrompt, detectProjectTrustStakes, listTrustedProjectEntries } from '../config/project-trust.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

/** 未授信时会被剥离（配置键）或禁用（hooks / skills / rules）的东西——UI 据此说明
 *  「授信能得到什么」。**单一真源**：与 CLI 启动提示共用 detectProjectTrustStakes
 *  （此前是本文件自实现的 collectStakes，2026-10-07 审计给 stakes 扩字段时合并，
 *  防双实现漂移）。安全档位（approval / unsandboxed / permissions）由永久门剥离，
 *  授信**也不**生效，不算「授信能得到什么」——单列 `ignoredSafetyKeys`，避免弹窗
 *  误导用户以为授信会启用审批（它们只来自全局配置 / CLI / 运行时）。 */

function resolveDir(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/** 项目目录由配置所在目录决定；没有项目配置时退化为传入的 cwd。 */
function projectDirFor(cwd: string): { projectDir: string; projectPath: string | undefined } {
  const projectPath = findProjectConfig(cwd)
  return { projectDir: projectPath ? dirname(projectPath) : cwd, projectPath }
}

/**
 * @param knownWorkspaces 已注册工作区（存活会话 cwd + 默认工作区）。缺省为空 =
 * 拒绝一切显式 cwd——fail-closed，装配点必须显式提供（issue #221）。
 */
export function buildTrustRoutes(
  apiToken?: string,
  knownWorkspaces: () => string[] = () => [],
): Record<string, RouteHandler> {
  return {
    // GET /project/trust — 当前项目的授信状态与赌注。
    'GET /project/trust': withAuth((_body, params) => {
      const requested = resolveDir(params?.cwd)
      // 显式传入的 cwd 必须命中已注册工作区；省略时回落到服务进程自己的 cwd
      // （那不是调用方可控的输入，保持原行为）。
      if (requested && !isKnownWorkspace(requested, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }
      const cwd = requested ?? process.cwd()
      const { projectDir, projectPath } = projectDirFor(cwd)
      return {
        status: 200,
        body: {
          cwd,
          projectPath,
          trusted: isProjectTrusted(projectDir),
          /** 用户曾选「不再提示」——桌面端别再弹引导。 */
          dismissed: isTrustPromptDismissed(projectDir),
          stakes: detectProjectTrustStakes(projectDir),
        },
      }
    }, apiToken),

    // GET /project/trust/list — 已授信项目清单（带授信时间）。
    // 授权总览页据此列出「我授信过哪些目录」并逐个撤销；撤销沿用
    // POST /project/trust { trusted:false }（同一存储、同一幂等语义），
    // 故不再开一个 DELETE 端点——两条写路径指向同一件事只会分叉。
    'GET /project/trust/list': withAuth(() => ({
      status: 200,
      body: { projects: listTrustedProjectEntries() },
    }), apiToken),

    // POST /project/trust — 授信 / 撤销（幂等，与 CLI 的 --trust / /trust 同一存储）。
    'POST /project/trust': withAuth((body) => {
      const data = (body ?? {}) as { cwd?: unknown; trusted?: unknown }
      const cwd = resolveDir(data.cwd)
      if (!cwd) return { status: 400, body: { error: 'cwd is required' } }
      if (!isKnownWorkspace(cwd, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }
      if (typeof data.trusted !== 'boolean') {
        return { status: 400, body: { error: 'trusted must be a boolean' } }
      }
      const { projectDir } = projectDirFor(cwd)
      if (data.trusted) trustProject(projectDir)
      else untrustProject(projectDir)
      return { status: 200, body: { cwd, projectDir, trusted: isProjectTrusted(projectDir) } }
    }, apiToken),

    // POST /project/trust/dismiss — 记「不再提示」（与 TUI 的启动提示同一存储：
    // project-trust.json 的 dismissed 表）。此前只有 TUI 能写这个标记，桌面端只能
    // 用 localStorage 各记各的——同一个项目在两端行为不一致。授信会清掉该标记
    // （trustProject 内置），故无需反向端点。
    'POST /project/trust/dismiss': withAuth((body) => {
      const cwd = resolveDir((body as { cwd?: unknown } | undefined)?.cwd)
      if (!cwd) return { status: 400, body: { error: 'cwd is required' } }
      if (!isKnownWorkspace(cwd, knownWorkspaces())) {
        return { status: 403, body: { error: UNKNOWN_WORKSPACE_ERROR } }
      }
      const { projectDir } = projectDirFor(cwd)
      dismissProjectTrustPrompt(projectDir)
      return { status: 200, body: { cwd, projectDir, dismissed: isTrustPromptDismissed(projectDir) } }
    }, apiToken),
  }
}
