import { it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpuPool } from '../../workers/cpu-pool.js'
import { _resetEsbuildCacheForTest } from '../syntax-check.js'
import { WRITE_FILE_TOOL } from '../write-file.js'
import type { ToolCallParams } from '../types.js'

function params(cwd: string, filePath: string, content: string): ToolCallParams {
  return { input: { file_path: filePath, content }, toolUseId: 'issue-366-write-file', cwd }
}

it('write_file stores valid JS/TS/MJS/CJS without a false low-risk warning when the Windows esbuild package is missing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'issue-366-write-file-'))
  const originalRun = cpuPool.run
  let esbuildCalls = 0
  cpuPool.run = async (task, args, softMs) => {
    if (task === 'esbuildTransformRaw') {
      esbuildCalls += 1
      throw new Error('The package "@esbuild/win32-x64" could not be found, and is needed by esbuild.')
    }
    return originalRun.call(cpuPool, task, args, softMs)
  }

  const cases = [
    ['.js', 'const value = 1;\nconsole.log(value);\n'],
    ['.ts', 'const value: number = 1;\nconsole.log(value);\n'],
    ['.mjs', 'export const value = 1;\n'],
    ['.cjs', 'module.exports = { value: 1 };\n'],
  ] as const

  try {
    for (const [extension, source] of cases) {
      _resetEsbuildCacheForTest()
      const filePath = join(cwd, `valid${extension}`)
      const esbuildCallsBefore = esbuildCalls
      const result = await WRITE_FILE_TOOL.execute(params(cwd, filePath, source))
      const userVisibleOutput = `${result.content}\n${result.uiContent ?? ''}`

      assert.equal(esbuildCalls, esbuildCallsBefore + 1, `${extension}: the esbuild worker failure must be exercised`)
      assert.ok(!result.isError, `${extension}: ${result.content}`)
      assert.ok(existsSync(filePath), `${extension}: write_file must leave the new file on disk`)
      assert.equal(readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'), source, `${extension}: written content`)
      assert.doesNotMatch(userVisibleOutput, /\u8bed\u6cd5\u68c0\u67e5|\u4f4e\u98ce\u9669/, `${extension}: unexpected syntax diagnostic`)
    }
  } finally {
    cpuPool.run = originalRun
    _resetEsbuildCacheForTest()
    rmSync(cwd, { recursive: true, force: true })
  }
})
