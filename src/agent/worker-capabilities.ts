import { LocalWorkerPolicyError } from '../api/continuation-prefix.js'
import type { WorkOrder } from './work-order.js'
import type { WorkerSessionConfig } from './worker-session.js'

/** Contract checks use the effective runtime registry, including domain filtering. */
export function enforceWorkerCapabilities(order: WorkOrder, config: WorkerSessionConfig): void {
  const delivery = order.delivery ?? (order.kind === 'patch_proposal' ? 'patch' : undefined)
  if (!delivery || delivery === 'diagnosis') return
  const names = new Set(config.toolRegistry.getDefinitions().map(t => t.name))
  if (delivery === 'patch' && !['edit_file', 'write_file', 'hash_edit', 'apply_patch'].some(n => names.has(n))) {
    throw new LocalWorkerPolicyError('worker lacks file editing capability required by delivery=patch; request not sent')
  }
  if (delivery === 'verification' && !names.has('run_tests')) {
    throw new LocalWorkerPolicyError('worker lacks run_tests required by delivery=verification; request not sent')
  }
}
