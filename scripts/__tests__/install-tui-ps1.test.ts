import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 远程一键是 `irm ... | iex`。Invoke-Expression 在当前作用域执行文本，
// 脚本级 param() 会被当成命令名，安装在 param 那一行停住。
// 还原：把 param([switch]$NoLaunch) 加回脚本顶部，本用例必须变红。
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'install-tui.ps1')
const source = readFileSync(SCRIPT, 'utf8')
const code = source
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n')

describe('install-tui.ps1 — irm | iex', () => {
  it('没有脚本级 param()，远程 iex 才能执行下去', () => {
    assert.doesNotMatch(code, /^\s*param\s*\(/m)
  })

  it('本地 -File -NoLaunch 仍从 $args 识别，只安装不启动', () => {
    assert.match(code, /\$NoLaunch\s*=\s*@\(\$args\)\s*-contains\s+'-NoLaunch'/)
    assert.match(code, /if \(\$NoLaunch\)/)
  })
})
