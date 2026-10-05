import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUserQuestionEvent } from '../user-question-event.js'
import { ASK_USER_QUESTION_TOOL } from '../../tools/ask-user-question.js'

test('server events and tool callbacks agree on recommendation validation and additive metadata', async () => {
  for (const options of [['A', 'B'], [{ label: 'A', recommended: true }, { label: 'B' }],
    [{ label: 'A', recommended: true, recommendation_reason: '符合目标' }, { label: 'B' }]]) {
    const input = { question: '请选择', options }
    let callback = false
    const result = await ASK_USER_QUESTION_TOOL.execute({ cwd: '/unused', input, toolUseId: 'ask', onAskUserQuestion: () => { callback = true } })
    const event = buildUserQuestionEvent('ask', input)
    assert.equal(!!event, callback)
    assert.equal(!!result.isError, !callback)
    if (event) {
      assert.deepEqual(event.questions[0]!.options, ['A', 'B'])
      assert.equal((event.questions[0]!.optionDetails as any)[0].recommendationReason, '符合目标')
    }
  }
})
