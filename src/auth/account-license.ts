import { accountApiBase, accountHeaders, HTTP_TIMEOUT_MS as ACCOUNT_TIMEOUT_MS, type FetchInjection } from './account.js'

/**
 * 设备许可恢复（Pro）：用账号凭据换官网签名的 grant。
 *
 * ## 为什么单独成文件
 * 这个能力与 `account.ts`（device flow / 星籍 / 资料快照）不是同一件事：它的产物
 * 是**设备级许可**而不是账号状态，且消费方只有 sidecar 的
 * `POST /account/activate-device` 一处。合进 `account.ts` 会同时把那个文件推过
 * 800 行红线（棘轮只降不升，见 `src/agent/structure-gate.ts`）。
 *
 * ## 为什么凭据消费在 Node 侧而不在壳里
 * `account.json` 自 v3.21.1 起是 AES-256-GCM 密文信封（`secure-store.ts`
 * `encodeSecret`：顶层只有 v/s/b/d），只有持有 `TokenStore` 的进程解得开。桌面壳曾按
 * 明文取顶层 `accessToken`，于是「恢复 Pro 激活」在默认安装下恒返回 auth_required
 * （2026-10-06 P0，`.rivet/plans/账户激活-p0-修复-把凭据消费收回-sidecar.md`）。
 * 凭据消费因此收在 sidecar：壳只接已签名的 grant 并负责验签落盘——与
 * `server/account-routes.ts` 顶部「凭据不出 sidecar」同一条线。
 */

/**
 * 官网恢复接口能回的业务失败码（与授权服务器 `tui-account-activate` 同一套词表，
 * 桌面端 `accountRights.errors.*` 逐字消费）。其余 reason 一律降级 `service_error`
 * ——把服务端新词原样透给 UI 只会显示成裸 key。
 */
const ACTIVATE_BUSINESS_CODES = new Set([
  'device_mismatch', 'license_not_owned', 'pro_required', 'activation_limit_reached',
  'activation_revoked', 'code_revoked', 'license_expired', 'code_not_found', 'trial_already_used',
])

export type ActivateAccountLicenseCode =
  | 'ok' | 'auth_required' | 'endpoint_unavailable' | 'protocol_error'
  | 'network_error' | 'timeout' | 'service_error'
  | 'device_mismatch' | 'license_not_owned' | 'pro_required' | 'activation_limit_reached'
  | 'activation_revoked' | 'code_revoked' | 'license_expired' | 'code_not_found' | 'trial_already_used'

export interface ActivateAccountLicenseResult {
  code: ActivateAccountLicenseCode
  /** `ok` 时是官网签名的设备许可 grant；其余情况缺席。 */
  grant?: string
}

/**
 * 调官网 EF `tui-account-activate`：Bearer 走账号凭据，body 带许可号与设备指纹。
 *
 * 失败不抛——返回码本身是接口：调用方（路由）要按码分派 HTTP 状态，抛异常会把
 * 「官网说设备不匹配」和「网线没插」混成同一个 500。
 */
export async function activateAccountLicense(
  accessToken: string,
  licenseId: string,
  deviceId: string,
  opts: FetchInjection = {},
): Promise<ActivateAccountLicenseResult> {
  let response: Response
  try {
    response = await (opts.fetchImpl ?? fetch)(`${accountApiBase()}/functions/v1/tui-account-activate`, {
      method: 'POST',
      headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ licenseId, deviceId }),
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    })
  } catch (error) {
    return { code: (error as Error | undefined)?.name === 'TimeoutError' ? 'timeout' : 'network_error' }
  }
  // 先把响应体读出来，再分类：官网**既**用 404 表示接口缺失，**也**用 404 透出授权服务
  // 的业务错误（`tui-account-activate` 把上游 status 原样转发，body 是 `code_not_found`）。
  // 顺序反了就会把「许可尚未进入授权服务」说成「官网服务版本暂不支持此功能」，
  // 用户被告知去等服务更新，而实际该做的是联系支持。
  let data: { grant?: unknown; error?: unknown } | null = null
  try { data = await response.json() as { grant?: unknown; error?: unknown } } catch { /* 非 JSON 体：留给下面按状态码判断 */ }
  if (response.status === 401) return { code: 'auth_required' }
  if (response.status === 404) {
    const reason = typeof data?.error === 'string' ? data.error : ''
    return { code: ACTIVATE_BUSINESS_CODES.has(reason) ? reason as ActivateAccountLicenseCode : 'endpoint_unavailable' }
  }
  if (response.status !== 200) {
    if (!data) return { code: 'protocol_error' }
    const reason = typeof data.error === 'string' ? data.error : ''
    return { code: ACTIVATE_BUSINESS_CODES.has(reason) ? reason as ActivateAccountLicenseCode : 'service_error' }
  }
  if (!data) return { code: 'protocol_error' }
  const grant = typeof data.grant === 'string' ? data.grant : ''
  return grant ? { code: 'ok', grant } : { code: 'protocol_error' }
}
