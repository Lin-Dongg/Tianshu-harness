import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LocalWorkerPolicyError } from '../api/continuation-prefix.js'
import { consumeCheckpointOnce, loadWorkerSession, workerSessionPath, type WorkerSessionRecord } from './worker-session-persist.js'
import { stableStringify } from '../api/stable-json.js'

const generation = (record: WorkerSessionRecord) => createHash('sha256').update(stableStringify(record)).digest('hex')

export function leaseWorkerResume(sourceId: string, expected: WorkerSessionRecord, homeDir?: string): { release: () => void; ack: () => void } {
  const path = `${workerSessionPath(sourceId, homeDir)}.lease`
  const owner = randomUUID()
  mkdirSync(dirname(path), { recursive: true })
  const acquisition = `${path}.acquiring`
  try { writeFileSync(acquisition, owner, { flag: 'wx' }) }
  catch { throw new LocalWorkerPolicyError('worker resume acquisition is busy; request not sent') }
  try {
  if (existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
      if (!Number.isInteger(prior.pid) || prior.pid < 1) throw new LocalWorkerPolicyError('invalid worker resume lease; request not sent')
      try { process.kill(prior.pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') unlinkSync(path)
      }
    } catch (error) { if (error instanceof LocalWorkerPolicyError) throw error }
  }
  try { writeFileSync(path, JSON.stringify({ owner, pid: process.pid, generation: generation(expected) }), { flag: 'wx' }) }
  catch { throw new LocalWorkerPolicyError('worker resume already leased or lease could not be persisted; request not sent') }
  } finally { try { unlinkSync(acquisition) } catch { /* remains fail-closed if unlink fails */ } }
  const release = () => {
    try { if (JSON.parse(readFileSync(path, 'utf8')).owner === owner) unlinkSync(path) } catch { /* already released */ }
  }
  const current = loadWorkerSession(sourceId, homeDir)
  if (!current || generation(current) !== generation(expected)) { release(); throw new LocalWorkerPolicyError('worker resume generation changed; request not sent') }
  return { release, ack: () => { consumeCheckpointOnce(sourceId, homeDir, expected.savedAt, generation(expected)) } }
}
