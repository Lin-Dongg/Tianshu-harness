import { SessionContext } from '../context.js'
import { buildPrimaryWorkerPacket } from '../worker-prompts.js'
import { createDelegateBatchTool } from '../../tools/delegate-batch.js'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolExecutionController, type ToolExecutionDeps, type ToolExecBatchInput } from '../tool-execution.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import { createTurnBudget } from '../turn-budget.js'
import { TurnCacheObservability } from '../cache-log-observability.js'

/**
 * Vision channel contract (Computer Use Wave B): when a batch's ToolResults
 * carry `images` (data URLs), the batch layer forwards them as ONE trailing
 * multimodal user message AFTER addToolResults — and only when the active
 * model declares supportsVision. A text-only model with a separate vision
 * model configured gets the bridge instead: the images are described and the
 * description is appended as text. With neither, behavior is byte-identical
 * to the pre-vision pipeline (images silently dropped).
 */
describe('ToolExecutionController vision-channel injection', () => {
  interface Captured {
    injected: Array<{ text: string; images: string[] }>
    events: string[]
    uiPayloads?: unknown[][]
    sanitized?: Array<{ raw: string; sanitized: string; filterId?: string }>
    registered?: string[][]
    history?: SessionContext
    observability?: TurnCacheObservability
  }

  function makeController(
    captured: Captured,
    opts: {
      execute?: () => Promise<import('../../tools/types.js').ToolResult>
      supportsVision: boolean
      images?: string[]
      wireInjector?: boolean
      throwRegistryGetOnce?: boolean
      /** Vision bridge stub. `'throw'` simulates the side model failing. */
      describe?: ((images: string[]) => Promise<string | null>) | 'throw'
      /** ImageRegistry stub. `false` = 无 registry（worker 场景）。 */
      registerImages?: false
    },
  ) {
    let throwRegistryGet = opts.throwRegistryGetOnce ?? false
    const deps = {
      config: {
        toolRegistry: {
          execute: opts.execute ?? (async () => ({ content: 'Accessibility tree for Safari', isError: false, images: opts.images })),
          get: () => {
            if (throwRegistryGet) {
              throwRegistryGet = false
              throw new Error('tool pipeline exploded')
            }
            return {
              definition: { input_schema: {} },
              isConcurrencySafe: () => false,
              timeoutMs: () => 5000,
            }
          },
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        contextWindow: opts.execute ? 1_000_000 : 200_000,
        promptEngine: { getModel: () => 'test-model' },
      },
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      },
      prewarm: { get: () => null, invalidate: () => {} },
      evidence: {
        getState: () => ({ filesModified: new Set<string>() }),
        trackFileRead: () => {}, trackFileModified: () => {},
      },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
      runtimeHooks: { runPostTool: async () => {} },
      contextInjection: { setCerebellarHint: () => {}, clearCerebellarHint: () => {} },
      trajectory: { getEntries: () => [] },
      getPredictionAccumulator: () => createPredictionAccumulator(),
      setPredictionAccumulator: () => {},
      getVigorState: () => ({}),
      setVigorState: () => {},
      getDoomLoopLevel: () => 'none' as const,
      getSessionTurnCount: () => 1,
      getSessionId: () => 'test-session',
      addToolResults: (results: import('../../api/types.js').ContentBlock[]) => { captured.history?.addToolResults(results); captured.events.push('addToolResults') },
      getSupportsVision: () => opts.supportsVision,
      registerImages: opts.registerImages === false
        ? undefined
        : (images: string[]) => {
            captured.registered?.push(images)
            return images.map((_, i) => `img_${i + 1}`)
          },
      addUserMessageWithImages: opts.wireInjector === false
        ? undefined
        : (text: string, images: string[]) => {
            captured.events.push('inject')
            captured.injected.push({ text, images })
          },
      describeToolImages: opts.describe === undefined
        ? undefined
        : ((describe) => async (images: string[]) => {
            captured.events.push('describe')
            if (describe === 'throw') throw new Error('vision model unreachable')
            return describe(images)
          })(opts.describe),
      recordToolHistory: () => {},
      buildRuntimeSnapshot: () => ({}),
      requestThetaCheck: () => {},
      getAutoReasoning: () => false,
      getReasoningEffort: () => undefined,
      setClientReasoningEffort: () => {},
      getSensorium: () => null,
      getReliabilityDecision: () => null,
      getTurnBudget: () => createTurnBudget(0),
      beginToolBatchObservability: (measured: boolean) => {
        captured.events.push('observe-begin')
        captured.observability?.beginToolBatch(measured)
      },
      recordSanitizedOutput: (raw: string, sanitized: string, filterId?: string) => {
        captured.sanitized?.push({ raw, sanitized, filterId })
        captured.observability?.recordSanitizedOutput(raw, sanitized, filterId)
      },
      recordToolUiEvent: () => {
        captured.events.push('observe-ui')
        captured.observability?.recordToolUiEvent()
      },
      endToolBatchObservability: () => {
        captured.events.push('observe-end')
        captured.observability?.endToolBatch()
      },
    } as unknown as ToolExecutionDeps
    return new ToolExecutionController(deps)
  }

  function makeInput(captured?: Captured): ToolExecBatchInput {
    return {
      toolUses: [{ id: 't1', name: 'computer_use', input: { action: 'snapshot', app: 'Safari' } }],
      callbacks: { onToolResult: (...args: unknown[]) => { captured?.uiPayloads?.push(args) } } as any,
      turn: 1,
      checkpointCreatedThisTurn: false,
      abortSignal: new AbortController().signal,
      traceStore: { events: [], toolFingerprints: [] } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
    }
  }

  it('delegate_batch packet stays valid and covers all orders through pipeline, tiering and SessionContext', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({ workOrderId: `packet:${i}`, status: 'passed' as const, summary: 'complete', findings: [{ claim: 'long finding '.repeat(6000), evidence: 'src/a.ts:1', confidence: 'high' as const }], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified' as const }))
    const packet = await buildPrimaryWorkerPacket(results)
    const tool = createDelegateBatchTool({ delegateBatch: async () => ({ status: 'completed', results, packet }) } as any)
    const captured: Captured = { injected: [], events: [], history: new SessionContext() }
    const controller = makeController(captured, { supportsVision: false, execute: () => tool.execute({ cwd: process.cwd(), toolUseId: 't1', input: { tasks: [{ objective: 'Inspect packet byte stability through all result consumers' }] } }) })
    const input = makeInput(captured); input.toolUses = [{ id: 't1', name: 'delegate_batch', input: { tasks: [] } }]
    await controller.executeBatch(input)
    const message = captured.history!.getMessages().find(m => m.role === 'tool')!
    const view = String(message.content)
    const parsed = JSON.parse(view.match(/<worker_results>([\s\S]*?)<\/worker_results>/)![1]!)
    assert.equal(parsed.length, results.length)
    assert.deepEqual(parsed.map((r: any) => r.workOrderId), results.map(r => r.workOrderId))
    assert.ok(view.length <= 34_000)
    assert.equal((view.match(/<worker_results>/g) ?? []).length, 1)
  })

  const IMG = 'data:image/png;base64,AAAA'

  it('supportsVision=true → images forwarded as one trailing user message after addToolResults', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: true, images: [IMG] })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 1)
    assert.deepEqual(captured.injected[0]!.images, [IMG])
    assert.match(captured.injected[0]!.text, /<system-reminder>/)
    assert.match(captured.injected[0]!.text, /Screenshot/)
    assert.deepEqual(captured.events, ['observe-begin', 'observe-ui', 'addToolResults', 'inject', 'observe-end'], 'append-only: injection strictly after tool results')
  })

  it('supportsVision=false and no bridge → images silently dropped (legacy behavior)', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: false, images: [IMG] })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
    assert.deepEqual(captured.events, ['observe-begin', 'observe-ui', 'addToolResults', 'observe-end'])
  })

  it('text-only model + configured vision model → description appended as text', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, {
      supportsVision: false,
      images: [IMG],
      describe: async () => 'A settings window with a back button at top left.',
    })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 1)
    assert.deepEqual(captured.injected[0]!.images, [], 'text-only model must not receive image parts')
    assert.match(captured.injected[0]!.text, /back button at top left/)
    assert.deepEqual(
      captured.events,
      ['observe-begin', 'observe-ui', 'addToolResults', 'describe', 'inject', 'observe-end'],
      'bridge runs after tool results, injection stays append-only',
    )
  })

  it('vision model preferred over the bridge when the primary model can see', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, {
      supportsVision: true,
      images: [IMG],
      describe: async () => 'should not be called',
    })
    await controller.executeBatch(makeInput())
    assert.equal(captured.events.includes('describe'), false)
    assert.deepEqual(captured.injected[0]!.images, [IMG])
  })

  it('failing vision bridge leaves the tool results intact', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: false, images: [IMG], describe: 'throw' })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
    assert.deepEqual(captured.events, ['observe-begin', 'observe-ui', 'addToolResults', 'describe', 'observe-end'])
  })

  it('empty description from the bridge injects nothing', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: false, images: [IMG], describe: async () => '' })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
  })

  it('no images in the batch → no injection even for vision models', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: true, images: undefined })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
  })

  it('caps forwarded images at the 2 most recent', async () => {
    const captured: Captured = { injected: [], events: [] }
    const imgs = ['data:image/png;base64,ONE', 'data:image/png;base64,TWO', 'data:image/png;base64,THREE']
    const controller = makeController(captured, { supportsVision: true, images: imgs })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 1)
    assert.deepEqual(captured.injected[0]!.images, ['data:image/png;base64,TWO', 'data:image/png;base64,THREE'])
  })

  it('missing injector hook → degrades to drop without throwing', async () => {
    const captured: Captured = { injected: [], events: [] }
    const controller = makeController(captured, { supportsVision: true, images: [IMG], wireInjector: false })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 0)
  })

  // agent 自己截的图也必须进会话 ImageRegistry，否则 ask_image 只能问用户手动附的
  // 图——「截图 → 逐字念出报错那一行」在浏览器验证闭环里就断了。
  it('registers tool screenshots and names the ids for ask_image (vision model)', async () => {
    const captured: Captured = { injected: [], events: [], registered: [] }
    const controller = makeController(captured, { supportsVision: true, images: [IMG] })
    await controller.executeBatch(makeInput())
    assert.deepEqual(captured.registered, [[IMG]], '截图必须寄存')
    assert.match(captured.injected[0]!.text, /img_1/, '提示里要点名 id，模型才知道能追问哪张')
    assert.match(captured.injected[0]!.text, /ask_image/)
  })

  it('registers tool screenshots on the bridge path too', async () => {
    const captured: Captured = { injected: [], events: [], registered: [] }
    const controller = makeController(captured, {
      supportsVision: false,
      images: [IMG],
      describe: async () => '一个设置窗口',
    })
    await controller.executeBatch(makeInput())
    assert.deepEqual(captured.registered, [[IMG]])
    assert.match(captured.injected[0]!.text, /img_1/)
  })

  it('registers only the images actually forwarded (respects the 2-shot cap)', async () => {
    const captured: Captured = { injected: [], events: [], registered: [] }
    const imgs = ['data:image/png;base64,ONE', 'data:image/png;base64,TWO', 'data:image/png;base64,THREE']
    const controller = makeController(captured, { supportsVision: true, images: imgs })
    await controller.executeBatch(makeInput())
    assert.deepEqual(captured.registered, [[imgs[1]!, imgs[2]!]], '被丢掉的第一张不该拿到 id')
  })

  it('no registry (worker) → still injects, just without ask_image ids', async () => {
    const captured: Captured = { injected: [], events: [], registered: [] }
    const controller = makeController(captured, { supportsVision: true, images: [IMG], registerImages: false })
    await controller.executeBatch(makeInput())
    assert.equal(captured.injected.length, 1)
    assert.equal(captured.registered?.length, 0)
    assert.equal(/ask_image/.test(captured.injected[0]!.text), false)
  })

  it('counts tool UI events and observes sanitizer results without changing callback payloads', async () => {
    const captured: Captured = { injected: [], events: [], uiPayloads: [], sanitized: [] }
    const controller = makeController(captured, { supportsVision: false })
    await controller.executeBatch(makeInput(captured))

    assert.equal(captured.uiPayloads?.length, 1)
    assert.deepEqual(captured.uiPayloads?.[0], [
      't1',
      'computer_use',
      'Accessibility tree for Safari',
      false,
      undefined,
      undefined,
      { command: undefined, exitCode: undefined, images: undefined, lossiness: undefined, outputText: 'Accessibility tree for Safari', outputTruncated: undefined },
    ])
    assert.deepEqual(captured.sanitized, [{
      raw: 'Accessibility tree for Safari',
      sanitized: 'Accessibility tree for Safari',
      filterId: undefined,
    }])
  })

  it('finalizes a failed batch before attributing the next batch', async () => {
    const observability = new TurnCacheObservability()
    const captured: Captured = { injected: [], events: [], observability }
    const controller = makeController(captured, {
      supportsVision: false,
      throwRegistryGetOnce: true,
    })

    await assert.rejects(controller.executeBatch(makeInput()), /tool pipeline exploded/)
    assert.deepEqual(observability.consumeForRequest(), {
      outputRawBytes: 0,
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 0,
    })

    await controller.executeBatch(makeInput())
    assert.deepEqual(observability.consumeForRequest(), {
      outputRawBytes: Buffer.byteLength('Accessibility tree for Safari'),
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 1,
    })
  })
})
