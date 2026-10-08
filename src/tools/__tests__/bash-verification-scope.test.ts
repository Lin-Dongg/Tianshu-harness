import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferBashVerificationScope, isVerificationCommand, suggestSingleCommand } from '../../agent/bash-verification.js'

/**
 * 台账卫生：只有「验证形态」的命令才该进 verification 台账。
 * 旧行为：记账入口（tool-pipeline 的 bash 分支）用一条宽松文本正则——命令里出现
 * test/build/check 字样即记，连 `wc -l foo.test.ts`、`gh run list --workflow=build-*`
 * 这类纯查询也命中，于是台账被 blocked 淹没（2026-10-06 实测：一轮 21 条 blocked
 * 里大半是纯查询），反过来污染交付报表。
 */
test('纯查询命令不构成验证（不得进台账）', () => {
  for (const cmd of [
    'wc -l src/tools/__tests__/syntax-check.test.ts',
    "sed -n '355,395p' src/__tests__/assembly-audit.test.ts",
    'ls scripts/build-windows-release.sh',
    'gh run list --workflow=build-windows.yml --limit 5',
    'grep -rn "name: 1" src/tools/',
    'git log --oneline -3',
    'ls -la dist/main.js',
    'npm --version',
    'npm install',
    'npm view esbuild version',
    'pnpm list',
    'yarn install',
    'node -e "console.log(1)"',
    'rtk node scripts/query.mjs',
    'rtk ls scripts/build-windows-release.sh',
    'tsc --version',
    'npx vitest --help',
    'cargo metadata',
    'go env',
  ]) {
    assert.equal(isVerificationCommand(cmd), false, `${cmd} 不是验证命令`)
  }
})

test('引号里的运行器字样不算验证意图', () => {
  assert.equal(isVerificationCommand('grep -rn "npm test" src/'), false)
  assert.equal(isVerificationCommand("grep -rn 'node --test' src/"), false)
})

test('验证意图即使归因不了也保留（blocked 诊断有指引价值）', () => {
  // 复合 shell / 重定向拿不到逐文件证明，但用户确实在跑验证——要在台账里标
  // blocked 并给写法指引，而不是静默消失（静默失效比噪音更贵）。
  assert.equal(isVerificationCommand('cd /Users/h/work/revit && npm run typecheck > /tmp/t.log 2>&1'), true)
  assert.equal(isVerificationCommand('cd repo && npm test 2>&1 | tail -5'), true)
  assert.equal(isVerificationCommand('custom node --test a.test.ts'), true)
  assert.equal(isVerificationCommand('node --test --unknown'), true)
  assert.equal(isVerificationCommand('npm run test:unit'), true)
  assert.equal(isVerificationCommand('cargo check | tail -5'), true)
  assert.equal(isVerificationCommand('go vet ./... > result.log'), true)
  assert.equal(isVerificationCommand('node --test --test-name-pattern "--version" a.test.mjs'), true, '过滤值不是运行器的版本查询')
})

test('受支持的验证命令照旧识别', () => {
  assert.equal(isVerificationCommand('npx tsx --test src/tools/__tests__/syntax-check.test.ts'), true)
  const t = inferBashVerificationScope('npx tsx --test src/tools/__tests__/syntax-check.test.ts')
  assert.equal(t.kind, 'test')
  assert.equal(t.scope, 'targeted')
  const tc = inferBashVerificationScope('npm run typecheck')
  assert.equal(tc.kind, 'typecheck')
  assert.equal(tc.scope, 'full')
})

test('复合 shell 给出可复制的单条建议命令（blocked 时不能只说"请用独立命令"）', () => {
  assert.equal(
    suggestSingleCommand('cd /Users/h/work/revit && npm run typecheck > /tmp/t.log 2>&1'),
    'npm run typecheck',
  )
  assert.equal(
    suggestSingleCommand('cd /Users/h/work/revit && node --import tsx --test src/a.test.ts | tail -5'),
    'node --import tsx --test src/a.test.ts',
  )
  assert.equal(suggestSingleCommand('git status && npm test'), 'npm test')
  // gradle 模块任务路径同样能切出可复制的单条（#380 收尾）
  assert.equal(suggestSingleCommand('cd repo && ./gradlew :app:test | tail -5'), './gradlew :app:test')
  // 引号里的分隔符不该把命令切坏
  assert.equal(suggestSingleCommand(`cd x && node --import tsx --test "src/a b.test.ts"`), 'node --import tsx --test "src/a b.test.ts"')
  // 已经是单条 → 无需建议（避免把同一条命令回显成"建议"）
  assert.equal(suggestSingleCommand('npm test'), null)
  // 非验证命令 → 无建议
  assert.equal(suggestSingleCommand('ls -la && wc -l foo.test.ts'), null)
})
