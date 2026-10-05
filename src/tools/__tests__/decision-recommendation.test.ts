import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestions, validateAskUserQuestions } from '../ask-user-question.js'
import { PLAN_TOOL } from '../plan.js'

test('new selectable calls require exactly one recommendation and its reason, before emitting any card', async () => {
  for (const options of [ ['A', 'B'], [{ label: 'A', recommended: true }, 'B'],
    [{ label: 'A', recommended: true, recommendation_reason: 'a' }, { label: 'B', recommended: true, recommendation_reason: 'b' }] ]) {
    let emitted = false
    const question = await ASK_USER_QUESTION_TOOL.execute({ cwd: '/unused', toolUseId: 'invalid', input: { question: 'pick', options }, onAskUserQuestion: () => { emitted = true } })
    assert.equal(question.isError, true)
    assert.match(question.content, /recommended/)
    assert.equal(question.endTurn, undefined, 'invalid payload must let the model correct the call')
    assert.equal(emitted, false)
    const plan = await PLAN_TOOL.execute({ cwd: '/unused', toolUseId: 'invalid', input: { action: 'submit', title: 'invalid', options: options.map(o => typeof o === 'string' ? { label: o, description: 'compare' } : { ...o, description: 'compare' }) } })
    assert.equal(plan.isError, true)
    assert.match(plan.content, /recommended/)
  }
})

test('legacy parsing stays readable; metadata stays aligned after invalid entries are removed', () => {
  const legacy = parseAskUserQuestions({ question: 'legacy', options: ['A', 'B'] })
  assert.deepEqual(legacy[0]?.options, ['A', 'B'])
  assert.equal(legacy[0]?.optionDetails, undefined)
  const current = parseAskUserQuestions({ question: 'current', options: [null, { label: 'A', description: 'scope', recommended: true, recommendation_reason: '减少风险' }, { label: '' }, 'B'] })
  assert.deepEqual(current[0]?.options, ['A', 'B'])
  assert.equal(current[0]?.optionDetails?.length, 2)
  assert.equal(current[0]?.optionDetails?.[0]?.recommendationReason, '减少风险')
  assert.equal(validateAskUserQuestions(current), undefined)
})
