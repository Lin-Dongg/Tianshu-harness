import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateReleaseNotes } from './release-notes.mjs'
const fixture = JSON.parse(readFileSync(new URL('../../docs/releases/summaries/3.28.0.json',import.meta.url)))
test('localized human summary validates and stays limited to three highlights',()=>{assert.equal(validateReleaseNotes(fixture,'3.28.0'),fixture);const tooMany=structuredClone(fixture);tooMany.locales.zh.highlights.push('four');assert.throws(()=>validateReleaseNotes(tooMany,'3.28.0'))})
test('notes must match exact version and links cannot use scripts or credentials',()=>{assert.throws(()=>validateReleaseNotes(fixture,'3.29.0'));for(const link of ['javascript:alert(1)','https://user:pass@github.com/foo','https://untrusted.example/foo'])assert.throws(()=>validateReleaseNotes({...fixture,fullNotesUrl:link},'3.28.0'))})
