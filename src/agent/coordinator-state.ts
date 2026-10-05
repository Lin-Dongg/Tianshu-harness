export type WorkerEventType = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'escalated'

export interface WorkerEvent {
  type: WorkerEventType
  workOrderId: string
  timestamp: number
  detail?: string
}

export interface CoordinatorSummary {
  /** Cumulative event counts — each completed work order increments queued, running, AND its terminal status */
  queued: number
  running: number
  passed: number
  failed: number
  blocked: number
  escalated: number
}

export interface FailureBudgetConfig {
  maxFailures: number
}

const MAX_EVENTS = 100

export class CoordinatorState {
  private events: WorkerEvent[] = []
  private maxConcurrency: number
  private failureBudget: FailureBudgetConfig
  private consecutiveFailures = 0

  constructor(maxConcurrency = 2, failureBudget?: FailureBudgetConfig) {
    this.maxConcurrency = maxConcurrency
    this.failureBudget = failureBudget ?? { maxFailures: 3 }
  }

  recordEvent(event: WorkerEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS)
    }
    if (event.type === 'failed') this.consecutiveFailures++
    if (event.type === 'passed') this.consecutiveFailures = 0
  }

  shouldEscalate(): boolean {
    return this.consecutiveFailures >= this.failureBudget.maxFailures
  }

  recordFinalOutcome(type: 'passed' | 'blocked' | 'failed', workOrderId: string): { escalated: boolean; consecutiveFailures: number } {
    this.recordEvent({ type, workOrderId, timestamp: Date.now(), detail: 'objective and evidence gates applied' })
    const escalated = type === 'failed' && this.shouldEscalate()
    if (escalated) {
      this.events[this.events.length - 1] = { type: 'blocked', workOrderId, timestamp: Date.now(), detail: 'execution failed; failure budget escalated final delivery' }
      this.recordEvent({ type: 'escalated', workOrderId, timestamp: Date.now() })
    }
    return { escalated, consecutiveFailures: this.consecutiveFailures }
  }

  getEvents(): WorkerEvent[] {
    return [...this.events]
  }

  getSummary(): CoordinatorSummary {
    const summary: CoordinatorSummary = { queued: 0, running: 0, passed: 0, failed: 0, blocked: 0, escalated: 0 }
    for (const event of this.events) {
      summary[event.type]++
    }
    return summary
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency
  }
}
