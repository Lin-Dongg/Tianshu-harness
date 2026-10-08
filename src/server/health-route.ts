/**
 * GET /health — sidecar liveness + summary counts (N1).
 *
 * Health is intentionally NOT auth-gated: the desktop shell and Rust monitor
 * need to probe it from cold-start / token-rotation windows where the Bearer
 * token may not be available yet. Rich fields (session/running counts, uptime,
 * loop lag) are the 「用户正在跑 agent」活动侧信道——带 token 的请求（Rust 壳/
 * webview 的全部真实消费方）拿全量；无 token 的匿名探测只拿 {ok}。
 */
import type { RouteHandler } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { LoopLagSnapshot } from './loop-health.js'
import type { StoreLockHolder } from './store-lock.js'
import { isAuthorizedRequest } from './auth.js'
import { PROTOCOL_VERSION, RUNTIME_CAPABILITIES, type RuntimeCapabilities } from './protocol.js'
import { randomUUID } from 'node:crypto'

export const RUNTIME_INSTANCE_ID = process.env.RIVET_INSTANCE_ID || randomUUID()

/** 带 token 请求拿到的全量 health 体。`GET /events` 的心跳复用同一份（阶段 4）。 */
export interface HealthBody {
  storage?: { failedSessions: number; pendingEvents: number }
  snapshotAt?: number
  buildId?: string
  nodeVersion?: string
  memory?: { rss: number; heapUsed: number }
  instanceId: string
  readiness: 'ready' | 'initializing' | 'failed'
  ok: boolean
  version: string
  protocolVersion: number
  /** 本运行时**自报**能处理哪些请求族（issue #266）——前端据此决定要不要禁用入口，
   *  而不是靠版本号猜。加性字段：老运行时缺它时前端回退版本比较。 */
  capabilities: RuntimeCapabilities
  uptimeMs: number
  sessionCount: number
  runningCount: number
  registryOk: boolean
  configured: boolean
  loopLagP99Ms?: number
  loopLagMaxMs?: number
  /** 初始化失败原因（如拿不到会话库独占锁而拒绝启动）——有值时 readiness='failed'。 */
  initializationError?: string
  /** 会话库独占锁被**别的进程**占用时的占用者（P0-1）。本进程持锁时省略。 */
  storeLockHolder?: StoreLockHolder
}

export type HealthSnapshot = () => HealthBody

/**
 * 全量 health 体的单一构造点。`buildHealthRoute` 与 `GET /events` 的 5s 心跳
 * 共用，保证推送通道上的 health 与 REST 逐字段一致（前端直接 setQueryData）。
 */
export function createHealthSnapshot(
  manager: RuntimeSessionManager,
  startedAt: number,
  version: string,
  registryReady?: () => boolean,
  configured?: () => boolean,
  loopLag?: () => LoopLagSnapshot,
  initializationError?: () => string | undefined,
  storeLockHolder?: () => StoreLockHolder | undefined,
): HealthSnapshot {
  return () => {
    const registryOk = registryReady ? registryReady() : true
    const configuredOk = configured?.() ?? true
    const { sessionCount, runningCount } = manager.stats()
    const lag = loopLag?.()
    const initError = initializationError?.()
    const lockHolder = storeLockHolder?.()
    return {
      snapshotAt: Date.now(),
      storage: manager.getStorageHealth(),
      buildId: process.env.RIVET_BUILD_ID ?? 'unknown',
      nodeVersion: process.version,
      memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
      instanceId: RUNTIME_INSTANCE_ID,
      readiness: initError ? 'failed' : registryOk ? 'ready' : 'initializing',
      ok: registryOk && configuredOk,
      version,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: RUNTIME_CAPABILITIES,
      uptimeMs: Date.now() - startedAt,
      sessionCount,
      runningCount,
      registryOk,
      configured: configuredOk,
      ...(lag ? { loopLagP99Ms: lag.p99Ms, loopLagMaxMs: lag.maxMs } : {}),
      ...(initError ? { initializationError: initError } : {}),
      ...(lockHolder ? { storeLockHolder: lockHolder } : {}),
    }
  }
}

export function buildHealthRoute(
  manager: RuntimeSessionManager,
  startedAt: number,
  version: string,
  apiToken?: string,
  registryReady?: () => boolean,
  configured?: () => boolean,
  loopLag?: () => LoopLagSnapshot,
  initializationError?: () => string | undefined,
  storeLockHolder?: () => StoreLockHolder | undefined,
): Record<string, RouteHandler> {
  const snapshot = createHealthSnapshot(
    manager, startedAt, version, registryReady, configured, loopLag, initializationError, storeLockHolder,
  )
  return {
    'GET /readyz': (_body, _params, headers) => {
      if (!isAuthorizedRequest({ headers: headers ?? {} }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const body = snapshot()
      return { status: body.registryOk ? 200 : 503, body }
    },
    'GET /health': (_body, _params, headers) => {
      if (!isAuthorizedRequest({ headers: headers ?? {} }, apiToken)) {
        const registryOk = registryReady ? registryReady() : true
        const configuredOk = configured?.() ?? true
        return {
          status: 200,
          body: { ok: registryOk && configuredOk },
        }
      }
      return { status: 200, body: snapshot() }
    },
  }
}
