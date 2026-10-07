import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 服务器 device-id 正则 `[A-Za-z0-9._:-]{8,128}`。
 *
 * 单点：落盘（device flow 登记的指纹）与路由（恢复请求透传的设备指纹）共用，
 * 两处各写一份就是下一次「一边放宽一边没放宽」的起点。
 */
export function isValidDeviceFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
}

/** Desktop supplies its native fingerprint; CLI and browser preview reuse the saved ID. */
export function accountDeviceFingerprint(home: string, supplied?: unknown): string {
  const path = join(home, '.account-device-id')
  if (supplied !== undefined && !isValidDeviceFingerprint(supplied)) throw new Error('invalid device fingerprint')
  if (isValidDeviceFingerprint(supplied)) {
    mkdirSync(home, { recursive: true })
    writeFileSync(path, supplied, { mode: 0o600 })
    return supplied
  }
  const native = process.env.RIVET_PRO_DEVICE_ID
  if (isValidDeviceFingerprint(native)) return native
  try { const saved = readFileSync(path, 'utf8').trim(); if (isValidDeviceFingerprint(saved)) return saved } catch { /* first login */ }
  const id = randomUUID()
  mkdirSync(home, { recursive: true })
  try { writeFileSync(path, id, { mode: 0o600, flag: 'wx' }); return id }
  catch { const saved = readFileSync(path, 'utf8').trim(); if (isValidDeviceFingerprint(saved)) return saved; throw new Error('invalid saved device fingerprint') }
}
