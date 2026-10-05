import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const valid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value)

/** Desktop supplies its native fingerprint; CLI and browser preview reuse the saved ID. */
export function accountDeviceFingerprint(home: string, supplied?: unknown): string {
  const path = join(home, '.account-device-id')
  if (supplied !== undefined && !valid(supplied)) throw new Error('invalid device fingerprint')
  if (valid(supplied)) {
    mkdirSync(home, { recursive: true })
    writeFileSync(path, supplied, { mode: 0o600 })
    return supplied
  }
  const native = process.env.RIVET_PRO_DEVICE_ID
  if (valid(native)) return native
  try { const saved = readFileSync(path, 'utf8').trim(); if (valid(saved)) return saved } catch { /* first login */ }
  const id = randomUUID()
  mkdirSync(home, { recursive: true })
  try { writeFileSync(path, id, { mode: 0o600, flag: 'wx' }); return id }
  catch { const saved = readFileSync(path, 'utf8').trim(); if (valid(saved)) return saved; throw new Error('invalid saved device fingerprint') }
}
