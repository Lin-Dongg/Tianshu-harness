export type AccountDeviceErrorCode = 'account-device-proxy-config' | 'account-device-network' | 'account-device-timeout' | 'account-device-tls'
  | 'account-device-service-auth' | 'account-device-forbidden' | 'account-device-endpoint'
  | 'account-device-service' | 'account-device-protocol'

export class AccountDeviceRequestError extends Error {
  constructor(readonly code: AccountDeviceErrorCode, readonly upstreamStatus?: number) {
    super(code)
  }
}

export function deviceHttpError(status: number): AccountDeviceRequestError {
  const code = status === 401 ? 'account-device-service-auth'
    : status === 403 ? 'account-device-forbidden'
    : status === 404 ? 'account-device-endpoint' : 'account-device-service'
  return new AccountDeviceRequestError(code, status)
}

/** Project only categories; never forward upstream bodies, credentials or URLs. */
export function classifyDeviceError(error: unknown): AccountDeviceRequestError {
  if (error instanceof AccountDeviceRequestError) return error
  if (error instanceof SyntaxError) return new AccountDeviceRequestError('account-device-protocol')
  const e = error as { name?: string; code?: string; cause?: { code?: string } } | null
  const code = e?.cause?.code ?? e?.code
  if (code === 'INVALID_PROXY_URL') return new AccountDeviceRequestError('account-device-proxy-config')
  if (['TimeoutError', 'AbortError'].includes(e?.name ?? '') || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new AccountDeviceRequestError('account-device-timeout')
  }
  if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code ?? '')) {
    return new AccountDeviceRequestError('account-device-tls')
  }
  return new AccountDeviceRequestError('account-device-network')
}
