import { readFileSync } from 'node:fs'
import type { ServerOptions } from 'node:https'
import { isLoopbackBind } from './host-policy.js'

export function assertSecureBind(host: string, tls?: ServerOptions): void {
  if (!isLoopbackBind(host) && !(tls?.cert && tls?.key)) {
    throw new Error('Non-loopback access requires TLS. Use --tls-cert and --tls-key, or keep the server on loopback behind an HTTPS tunnel.')
  }
}

export function readServeTlsArgs(args: string[]): ServerOptions | undefined {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    const path = args[index + 1]
    if (!path || path.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    return path
  }
  const cert = value('--tls-cert'), key = value('--tls-key')
  if (!cert && !key) return undefined
  if (!cert || !key) throw new Error('--tls-cert and --tls-key must be supplied together')
  return { cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.2' }
}
