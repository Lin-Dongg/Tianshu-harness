import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager } from '../session-manager.js'
import { skillRegistry } from '../../skills/skill-loader.js'

test('welcome skill selection loads the skill body for the first agent run and retains user text', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'welcome-first-skill-'))
  const name = `welcome-first-${Date.now()}`
  mkdirSync(join(cwd, '.rivet', 'skills'), { recursive: true })
  writeFileSync(join(cwd, '.rivet', 'skills', `${name}.md`), `---\nname: ${name}\ndescription: Welcome test\n---\nInspect spacing and keyboard navigation.`)
  let observed = ''
  const manager = new RuntimeSessionManager({
    defaultCwd: cwd,
    createAgent: () => ({
      run: async prompt => { observed = prompt },
      abort: () => {},
      listArtifacts: () => [],
      readArtifact: async () => null,
      getMessages: () => [],
      replaceMessages: () => {},
      rewindToMessages: () => {},
    }),
  })
  try {
    const typed = `/${name} Check the welcome page`
    const record = manager.createSession({ cwd, prompt: typed })
    for (let attempt = 0; !observed && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(observed, /Inspect spacing and keyboard navigation/)
    assert.match(observed, /User task: Check the welcome page/)
    const event = manager.getEvents(record.id, 0)!.events.find(event => event.type === 'user')
    assert.ok(event)
    assert.equal((event.data as { promptText: string }).promptText, typed)
  } finally {
    await manager.shutdownAll()
    skillRegistry.unregister(name)
    rmSync(cwd, { recursive: true, force: true })
  }
})
