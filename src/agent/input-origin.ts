export type InputOrigin = 'human' | 'runtime_command' | 'worker_task' | 'hook' | 'compact' | 'legacy_unknown'
export interface InputOptions { origin?: InputOrigin; literalText?: boolean }

/** Legacy unknown inputs never acquire human authority from imperative wording. */
export const isHumanInput = (origin: InputOrigin | undefined): boolean => origin === 'human'
