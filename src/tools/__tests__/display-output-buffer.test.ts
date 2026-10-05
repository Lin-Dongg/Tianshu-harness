import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DisplayOutputBuffer } from '../display-output-buffer.js'
test('display capture preserves stream order and declares clipping at its own cap', () => {
 const buffer = new DisplayOutputBuffer(8)
 buffer.append('head');buffer.append('tail');assert.equal(buffer.text(),'headtail');assert.equal(buffer.truncated,false)
 buffer.append('overflow');assert.equal(buffer.text(),'headtail');assert.equal(buffer.truncated,true)
})
