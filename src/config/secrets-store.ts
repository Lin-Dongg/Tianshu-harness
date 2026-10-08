/**
 * Disk I/O boundary for provider API keys (0600 secrets file).
 *
 * config.json holds only a `keyRef` pointer; the actual key lives in
 * `secrets.json` next to it.
 *
 * 内容自本次加固起为 **AES-256-GCM 信封**（数据密钥托管在 OS 密钥库或本机密钥
 * 文件，见 `src/auth/secure-store.ts`），与 `TokenStore`（src/auth/token-store.ts）
 * 同款。原因：`0o600` 在 Windows/NTFS 上不生效（权限由 ACL 决定），而
 * `~/.rivet` 常落在云同步/备份路径上——只靠文件权限等于把 key 明文交给任何能读
 * 该目录的进程。旧明文文件仍按原样读取，下次写入自动升级。`chmod` 保留作纵深防御。
 *
 * Reads are fail-open: a missing/corrupt store yields undefined and the
 * caller's existing fallback chain (env vars, friendly error) takes over.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { rivetHome, userConfigPath } from './paths.js'
import { createSecretCipher, decodeSecret, encodeSecret, type SecretCipher } from '../auth/secure-store.js'

interface SecretsFile {
  version: 1
  keys: Record<string, string>
}

/** Secrets live next to config.json (honors RIVET_CONFIG_PATH / RIVET_HOME). */
export function secretsPath(base?: string): string {
  if (base) return join(base, 'secrets.json')
  try {
    return join(dirname(userConfigPath()), 'secrets.json')
  } catch {
    return join(rivetHome(), 'secrets.json')
  }
}

/** cipher 与 secrets 文件同目录（数据密钥落 `<dir>/.token-key*`）；cipher 内部按后端+目录缓存且懒加载。 */
function cipherFor(base?: string): SecretCipher {
  return createSecretCipher(dirname(secretsPath(base)))
}

function readStore(base?: string, forWrite = false): SecretsFile | undefined {
  try {
    const raw = readFileSync(secretsPath(base), 'utf-8')
    const plain = decodeSecret(cipherFor(base), raw)
    if (plain === null) throw new Error('unreadable store')
    const parsed = JSON.parse(plain) as Partial<SecretsFile>
    if (parsed.version !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) throw new Error('invalid store')
    return { version: 1, keys: parsed.keys as Record<string, string> }
  } catch (error) {
    if (forWrite && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Existing model credentials could not be read; refusing to overwrite them')
    }
    return undefined
  }
}

function writeStore(store: SecretsFile, base?: string): void {
  const path = secretsPath(base)
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, encodeSecret(cipherFor(base), JSON.stringify(store, null, 2)), { mode: 0o600 })
  renameSync(tmpPath, path)
  chmodSync(path, 0o600)
}

export function readSecret(keyRef: string, base?: string): string | undefined {
  const store = readStore(base)
  const value = store?.keys[keyRef]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function writeSecret(keyRef: string, value: string, base?: string): void {
  const store = readStore(base, true) ?? { version: 1 as const, keys: {} }
  store.keys[keyRef] = value
  writeStore(store, base)
}

export function deleteSecret(keyRef: string, base?: string): void {
  const store = readStore(base)
  if (!store || !(keyRef in store.keys)) return
  delete store.keys[keyRef]
  if (Object.keys(store.keys).length === 0) {
    try { unlinkSync(secretsPath(base)) } catch { /* already gone */ }
    return
  }
  writeStore(store, base)
}

/** 展示安全的短指纹——用于标记共用同一 key 的条目，不打印密钥材料。 */
export function secretFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export function fingerprintForKeyRef(keyRef: string, base?: string): string | undefined {
  const value = readSecret(keyRef, base)
  return value ? secretFingerprint(value) : undefined
}
