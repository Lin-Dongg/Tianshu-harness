import { parseAskUserQuestions, validateAskUserQuestions } from '../tools/ask-user-question.js'
import { redactText, redactValue } from './redact.js'

/** Emit the same validated canonical options as the tool callback; retain wire compatibility. */
export function buildUserQuestionEvent(toolUseId: string, input: Record<string, unknown>) {
  const questions = parseAskUserQuestions(input)
  if (!questions.length || validateAskUserQuestions(questions)) return undefined
  return { toolUseId, questions: questions.map(q => ({
    id: q.id, prompt: redactText(q.prompt), options: q.options.map(o => redactText(o)),
    ...(q.optionDetails ? { optionDetails: redactValue(q.optionDetails) } : {}), allowMultiple: q.allowMultiple,
  })) }
}
