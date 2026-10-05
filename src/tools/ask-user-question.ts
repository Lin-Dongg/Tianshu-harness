import type { Tool, ToolCallParams, ToolResult } from './types.js'

// ── 决策选项（结构卡）纯函数── 原 decision-options.ts，2026-10-05 并入本叶：
// 本文件是桌面共享叶子（boundary 门禁：叶子只允许 import type），拆出独立模块
// 会让叶子产生 value import、拖垮检查。plan.ts 与 types.ts 从这里取。

export interface DecisionOptionDetail {
  description?: string
  recommended?: boolean
  recommendationReason?: string
}

export function normalizeDecisionOptions(raw: unknown): { options: string[]; optionDetails?: DecisionOptionDetail[] } {
  if (!Array.isArray(raw)) return { options: [] }
  const options: string[] = [], details: DecisionOptionDetail[] = []
  let structured = false
  for (const item of raw) {
    const object = item && typeof item === 'object' ? item as Record<string, unknown> : undefined
    const label = typeof item === 'string' ? item.trim() : typeof object?.label === 'string' ? object.label.trim() : ''
    if (!label) continue
    options.push(label)
    structured ||= !!object
    details.push(object ? {
      ...(typeof object.description === 'string' ? { description: object.description.trim() } : {}),
      ...(typeof object.recommended === 'boolean' ? { recommended: object.recommended } : {}),
      ...(typeof object.recommendation_reason === 'string' ? { recommendationReason: object.recommendation_reason.trim() } : {}),
    } : {})
  }
  return { options, ...(structured ? { optionDetails: details } : {}) }
}

export function recommendationError(details: readonly DecisionOptionDetail[] | undefined, count: number): string | undefined {
  if (count < 2) return undefined
  const recommended = details?.filter(d => d.recommended === true) ?? []
  if (recommended.length !== 1 || !recommended[0]!.recommendationReason?.trim()) {
    return '有多个选项时必须恰好标记一个 recommended: true，并填写非空 recommendation_reason，说明为何最符合用户目标及主要取舍。'
  }
  return undefined
}

export const decisionOptionSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'object', properties: {
      label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' },
      recommendation_reason: { type: 'string' },
    }, required: ['label'] },
  ],
}

/**
 * AskUserQuestion tool — allows the model to ask the user a question.
 *
 * The tool emits the question and returns a placeholder result, then
 * the turn completes. The user's next message in the conversation
 * serves as the answer to the question.
 *
 * Usage:
 *  1. Model calls ask_user_question({ question: "..." }) — or the multi-question
 *     form ask_user_question({ questions: [{ prompt, options }] })
 *  2. Tool displays the question(s) as output
 *  3. Returns "{response placeholder}" — turn ends
 *  4. User types their answer as a new message
 *  5. Model processes the answer in the next turn
 *
 * The desktop client additionally renders a structured question card (the
 * server forwards the parsed questions over a `user_question` SSE event);
 * CLI and desktop cards return answers through the normal user-message channel.
 */

/** Structured question shape shared by the tool, server SSE and desktop card. */
export interface AskUserQuestionItem {
  /** Stable id for the card UI (auto-assigned q1..qN when omitted). */
  id: string
  prompt: string
  options: string[]
  optionDetails?: DecisionOptionDetail[]
  allowMultiple: boolean
}

/**
 * Normalize raw tool input into the structured question list.
 * Accepts both the legacy single-question form ({ question, options,
 * allow_multiple }) and the multi-question form ({ questions: [...] }).
 * Returns [] when no valid question is present.
 */
export function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestionItem[] {
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    const items: AskUserQuestionItem[] = []
    for (const raw of input.questions) {
      if (typeof raw !== 'object' || raw === null) continue
      const q = raw as Record<string, unknown>
      const prompt = typeof q.prompt === 'string' && q.prompt.trim()
        ? q.prompt.trim()
        : (typeof q.question === 'string' ? q.question.trim() : '')
      if (!prompt) continue
      // options 字段名兼容：标准 'options' + 别名 'choices'（部分 SDK 用）
      const rawOptions = Array.isArray(q.options)
        ? q.options
        : Array.isArray(q.choices)
          ? q.choices
          : []
      // 多选字段名兼容：snake_case 'allow_multiple' + camelCase 'multiSelect'（Anthropic 原生）
      const allowMultiple = q.allow_multiple === true || q.multiSelect === true
      items.push({
        id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q${items.length + 1}`,
        prompt,
        ...normalizeDecisionOptions(rawOptions),
        allowMultiple,
      })
    }
    return items
  }

  if (typeof input.question === 'string' && input.question.trim()) {
    const rawOptions = Array.isArray(input.options)
      ? input.options
      : Array.isArray(input.choices)
        ? input.choices
        : []
    return [{
      id: 'q1',
      prompt: input.question.trim(),
      ...normalizeDecisionOptions(rawOptions),
      allowMultiple: input.allow_multiple === true || input.multiSelect === true,
    }]
  }

  return []
}

/** Render the questions as plain text for the TUI / uiContent channel. */
export function renderAskUserQuestionText(questions: AskUserQuestionItem[]): string {
  const blocks = questions.map((q, qi) => {
    const heading = questions.length > 1 ? `${qi + 1}. ${q.prompt}` : q.prompt
    if (q.options.length === 0) return heading
    const numbered = q.options.map((opt, i) => `  ${i + 1}. ${opt}`).join('\n')
    const hint = q.allowMultiple ? '\n\n(You can pick more than one.)' : ''
    return `${heading}\n\n${numbered}${hint}`
  })
  return blocks.join('\n\n')
}

/** Per-question draft answer — mirrors desktop QuestionCard DraftAnswer. */
export interface AskAnswerDraft {
  /** Selected option indices. */
  selected: number[]
  /** Free-text "Other…" was chosen. */
  otherSelected: boolean
  otherText: string
  /** User skipped this question. */
  skipped: boolean
}

const SKIPPED_ALL = '(skipped all questions)'

/** Convert a single draft into an answer string (options joined by ；). */
export function draftToAnswer(draft: AskAnswerDraft, options: string[]): string | null {
  if (draft.skipped) return null
  const parts = draft.selected.map((i) => options[i]).filter((o): o is string => !!o)
  if (draft.otherSelected && draft.otherText.trim()) parts.push(draft.otherText.trim())
  if (parts.length === 0) return null
  return parts.join('；')
}

/**
 * Compose all drafts into a single user-message string — parity with desktop
 * QuestionCard.submitAll:
 * - multi-question: `${prompt} → ${answer}` lines joined by `\n`
 * - single question: just the answer text
 * - all skipped: SKIPPED_ALL placeholder
 */
export function composeAnswers(
  questions: AskUserQuestionItem[],
  drafts: AskAnswerDraft[],
  skippedAllLabel: string = SKIPPED_ALL,
): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const d = drafts[i] ?? { selected: [], otherSelected: false, otherText: '', skipped: true }
    const answer = draftToAnswer(d, q.options)
    if (answer) lines.push(questions.length > 1 ? `${q.prompt} → ${answer}` : answer)
  })
  if (lines.length === 0) return skippedAllLabel
  return lines.join('\n')
}

export function validateAskUserQuestions(questions: AskUserQuestionItem[]): string | undefined {
  if (!questions.length) return 'question（或 questions[]）必填'
  for (const q of questions) {
    const error = recommendationError(q.optionDetails, q.options.length)
    if (error) return error
  }
  return undefined
}

export const ASK_USER_QUESTION_TOOL: Tool = {
  definition: {
    name: 'ask_user_question',
    description: `向用户提出一个或多个问题，并等待其输入回答。当你需要澄清信息、了解偏好，或需要一个无法从上下文推断的决定时使用。

单个问题：传 \`question\`（+ 可选 \`options\`）。多个相关问题（最多 4 个）：传 \`questions\`——CLI 与桌面端会把它们渲染成一张结构化卡片，用户逐页作答。

为一小组互斥选项提供 \`options\`（UI 渲染为编号列表，用户可直接按编号回答；卡片还提供自定义回答项）。开放式问题省略 \`options\`。

有选项时必须结构化调用本工具，不得只在普通回复列菜单；恰好一个选项标记 recommended: true，并用 recommendation_reason 解释为何更符合用户目标及主要取舍。推荐不代表替用户选择。

当用户要的是你的分析、建议或观点时，禁止用这个工具把决定推回给用户——那种情况直接回答。优先只问一个问题；先处理你能确定的部分。`,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题。清晰、具体。' },
        options: {
          type: 'array',
          items: decisionOptionSchema,
          description: '可选的 2-4 个简短互斥选项。开放式问题、或用户要的是你的分析而不是菜单时省略。',
        },
        allow_multiple: { type: 'boolean', description: '允许选择多个选项（默认：false）。' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '该问题的可选稳定 id（省略时自动分配）。' },
              prompt: { type: 'string', description: '问题文本。' },
              options: { type: 'array', items: decisionOptionSchema, description: '可选的 2-4 个简短互斥选项。' },
              allow_multiple: { type: 'boolean', description: '允许选择多个选项（默认：false）。' },
            },
            required: ['prompt'],
          },
          description: '多问题形式（最多 4 个）。存在时优先于单问题字段。',
        },
      },
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const questions = parseAskUserQuestions(params.input)
    const invalid = validateAskUserQuestions(questions)
    if (invalid) return { content: `错误：${invalid}`, isError: true }
    // content: what the LLM sees. When options exist it MUST include the same
    // numbered rendering the user sees — the numbering lives only in uiContent
    // otherwise, so a bare "1" reply forces the model to guess the mapping
    // (session 91840816: user answered 1 = plan mode, model read it as
    // option 2 = execute directly).
    // Both clients receive structured cards; uiContent remains a readable transcript.
    const rendered = renderAskUserQuestionText(questions)
    const hasOptions = questions.some(q => q.options.length > 0)
    params.onAskUserQuestion?.({ requestId: params.toolUseId, questions })
    const content = hasOptions
      ? `[等待你的回复…]\n\n已向用户展示以下编号选项：\n${rendered}\n\n回复中的裸数字对应这里的编号。`
      : '[等待你的回复…]'
    return {
      content,
      uiContent: rendered,
      endTurn: true,
    }
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe(): boolean {
    return true
  },

  isEnabled(): boolean {
    return true
  },
}
