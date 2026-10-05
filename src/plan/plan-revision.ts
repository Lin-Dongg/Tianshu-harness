import { createHash } from 'node:crypto'

/** Includes options and status, so a decision only applies to what was displayed. */
export function planRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
