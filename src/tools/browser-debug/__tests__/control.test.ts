import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  browserOperation,
  takeBrowserControl,
  setBrowserOwner,
} from '../control.js'
import { browserUrl } from '../../../server/session-browser.js'
test('takeover waits for active agent work, rejects queued agent work, serializes user input', async () => {
  const key = 'queue-test'
  const events: string[] = []
  let release!: () => void
  const first = browserOperation(key, 'agent', async () => {
    events.push('agent')
    await new Promise<void>((r) => (release = r))
    events.push('done')
  })
  await new Promise((r) => setImmediate(r))
  const second = browserOperation(key, 'agent', async () => {
    events.push('should-not-run')
  })
  const rejection = assert.rejects(second, /control/)
  const takeover = takeBrowserControl(key, 'user').then(() =>
    events.push('user-ready'),
  )
  release()
  await Promise.all([first, rejection, takeover])
  assert.deepEqual(events, ['agent', 'done', 'user-ready'])
  let inFlight = 0,
    max = 0
  await Promise.all(
    [1, 2, 3].map(() =>
      browserOperation(key, 'user', async () => {
        max = Math.max(max, ++inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
      }),
    ),
  )
  assert.equal(max, 1)
  await assert.rejects(
    browserOperation(key, 'agent', async () => {}),
    /control/,
  )
  await takeBrowserControl(key, 'agent')
  await browserOperation(key, 'agent', async () => events.push('returned'))
  assert.equal(events.at(-1), 'returned')
  setBrowserOwner('other', 'agent')
  await browserOperation('other', 'agent', async () => {})
})
test('web navigation accepts only HTTP and HTTPS', () => {
  assert.equal(browserUrl('https://example.com'), 'https://example.com/')
  for (const url of [
    'file:///tmp/note.md',
    'javascript:alert(1)',
    'data:text/html,hello',
  ])
    assert.throws(() => browserUrl(url))
})
