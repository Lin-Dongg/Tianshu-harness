import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { OaiMessage } from '../api/oai-types.js'

export const MAX_WORKER_HISTORY_BYTES = 64 * 1024 * 1024
export interface WorkerHistoryRef { file: string; digest: string; bytes: number }
export interface WorkerPersistenceOutcome { ok: boolean; error?: string }

export function writeWorkerFileAtomic(path: string, content: string | Buffer): boolean {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    const fd = openSync(tmp, 'wx')
    try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
    if (process.platform !== 'win32') {
      const dir = openSync(dirname(path), 'r')
      try { fsyncSync(dir) } finally { closeSync(dir) }
    }
    return true
  }
  catch { try { unlinkSync(tmp) } catch { /* absent */ }; return false }
}

export function archiveWorkerHistory(manifestPath: string, messages: readonly OaiMessage[]): WorkerHistoryRef {
  const raw = Buffer.from(JSON.stringify(messages))
  if (raw.length > MAX_WORKER_HISTORY_BYTES) throw new Error('worker history exceeds durable history limit')
  const digest = createHash('sha256').update(raw).digest('hex')
  const file = `${basename(manifestPath)}.${digest}.history.gz`
  if (!writeWorkerFileAtomic(join(dirname(manifestPath), file), gzipSync(raw))) throw new Error('worker history archive write failed')
  return { file, digest, bytes: raw.length }
}

export function readWorkerHistory(manifestPath: string, value: unknown): OaiMessage[] {
  const ref = value as WorkerHistoryRef
  if (!ref || typeof ref.file !== 'string' || !ref.file.startsWith(`${basename(manifestPath)}.`)
    || !/^[A-Za-z0-9_.%-]+\.history\.gz$/.test(ref.file) || !/^[a-f0-9]{64}$/.test(ref.digest)
    || !Number.isInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_WORKER_HISTORY_BYTES) throw new Error('invalid worker history reference')
  const path = join(dirname(manifestPath), ref.file)
  if (statSync(path).size > MAX_WORKER_HISTORY_BYTES) throw new Error('worker history archive too large')
  const raw = gunzipSync(readFileSync(path), { maxOutputLength: MAX_WORKER_HISTORY_BYTES })
  if (raw.length !== ref.bytes || createHash('sha256').update(raw).digest('hex') !== ref.digest) throw new Error('worker history digest mismatch')
  const messages: unknown = JSON.parse(raw.toString('utf8'))
  if (!Array.isArray(messages) || !messages.every(m => m && typeof m === 'object' && typeof m.role === 'string')) throw new Error('invalid worker history')
  return messages as OaiMessage[]
}
