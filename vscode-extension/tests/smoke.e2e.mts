/**
 * 端到端冒烟（CI 与手动运行）：
 *   node --import tsx tests/smoke.e2e.mts [cliPath]
 *
 * launcher 起真实 sidecar → health → 建会话 → SSE 订阅（重放 + 存活）→
 * steer 幂等校验（idle 应 409）→ 归档清理。不触发模型调用（零 token 成本）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchSidecar } from '../src/sidecar/launcher.ts'
import { SidecarClient } from '../src/sidecar/client.ts'

const siblingMain = join(fileURLToPath(new URL('.', import.meta.url)), '../../dist/main.js')
const cliPath = process.argv[2] || (existsSync(siblingMain) ? siblingMain : 'rivet')
const cwd = mkdtempSync(join(tmpdir(), 'tianshu-ext-smoke-'))
const configPath = join(cwd, '.rivet-config.json')
const previousConfigPath = process.env.RIVET_CONFIG_PATH
writeFileSync(configPath, JSON.stringify({
  provider: { default: 'smoke', providers: { smoke: {
    name: 'Smoke', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'smoke-not-a-real-key',
    userSaved: true, models: [{ id: 'smoke-model', alias: 'smoke-model', contextWindow: 128000 }],
  } } },
  agent: { defaultModel: 'smoke:smoke-model' },
}))
process.env.RIVET_CONFIG_PATH = configPath

// P1 变更审查面需要 git 仓 + 基线提交
execSync('git init && git config user.email t@t && git config user.name T', { cwd, windowsHide: true })
writeFileSync(join(cwd, 'hello.txt'), 'v1\n')
execSync('git add . && git commit -m init', { cwd, windowsHide: true })

function fail(msg: string): never {
  throw new Error(`✗ ${msg}`)
}

const sidecar = await launchSidecar({
  cwd,
  cliPath,
  onLog: (l) => console.log(`  [sidecar] ${l}`),
})
console.log(`✓ sidecar healthy @ ${sidecar.baseUrl}`)

try {
  const client = new SidecarClient(sidecar.baseUrl, sidecar.token)

  const rec = await client.createSession({ cwd, title: 'ext-smoke' })
  if (!rec.id || rec.status !== 'idle') fail(`unexpected session record: ${JSON.stringify(rec)}`)
  console.log(`✓ session created: ${rec.id} (${rec.status})`)

  const listed = await client.listSessions()
  if (!listed.some((s) => s.id === rec.id)) fail('created session missing from list')
  console.log(`✓ session listed (${listed.length} total)`)

  // SSE：应立即完成空重放并保持连接存活。
  const gotLive = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000)
    const off = client.subscribe(
      rec.id,
      0,
      () => { /* 空会话无事件 */ },
      (live) => {
        if (live) {
          clearTimeout(timer)
          off()
          resolve(true)
        }
      },
    )
  })
  if (!gotLive) fail('SSE stream did not go live within 5s')
  console.log('✓ SSE stream live')

  // PlusMenu 契约：模型/星域列表应可读且各有一个 current 标记。
  const models = await client.listModels(rec.id)
  if (!Array.isArray(models) || models.length === 0) fail('listModels returned empty')
  if (models.filter((m) => m.current).length !== 1) fail('expected exactly one current model')
  console.log(`✓ models listed (${models.length}, current: ${models.find((m) => m.current)?.alias})`)

  const domains = await client.listDomains(rec.id)
  if (!Array.isArray(domains) || domains.length === 0) fail('listDomains returned empty')
  console.log(`✓ domains listed (${domains.length}, current: ${domains.find((d) => d.current)?.name ?? 'auto'})`)

  // @file 提及：空目录会话应返回数组（可能为空）。
  const files = await client.listFiles(rec.id, '')
  if (!Array.isArray(files)) fail('listFiles did not return array')
  console.log(`✓ files endpoint ok (${files.length} in tmp cwd)`)

  // P1 变更审查契约：修改文件后 working-tree 列出、file-base 返回基线内容。
  writeFileSync(join(cwd, 'hello.txt'), 'v2\n')
  const wt = await client.sessionWorkingTree(rec.id)
  if (!wt.isRepo) fail('working-tree: isRepo should be true')
  if (!wt.files.some((f) => f.path === 'hello.txt' && f.status === 'modified')) {
    fail(`working-tree missing modified hello.txt: ${JSON.stringify(wt.files)}`)
  }
  console.log(`✓ working-tree lists modified file (${wt.files.length} changed)`)

  const base = await client.fileAtBase(rec.id, 'hello.txt')
  if (!base.exists || base.content !== 'v1\n') fail(`file-base wrong: ${JSON.stringify(base)}`)
  const noBase = await client.fileAtBase(rec.id, 'nonexistent.txt')
  if (noBase.exists) fail('file-base: nonexistent file should have exists=false')
  console.log('✓ file-base returns baseline content (v1) & exists=false for new files')

  const rb = await client.rollbackPreview(rec.id)
  if (rb.available !== false) fail('rollback preview should be unavailable (no agent checkpoint)')
  console.log('✓ rollback preview → available=false (无 checkpoint，契约一致)')

  // E4 委托契约：协议版本头 + 能力注册 + 无挂起时 result → 409
  const proto = await client.probeProtocolVersion()
  if (proto < 1) fail(`expected X-Tianshu-Protocol ≥ 1, got ${proto}`)
  console.log(`✓ protocol version ${proto}`)

  await client.registerDelegateCapabilities(rec.id, 'smoke-client', ['apply_edit'])
  console.log('✓ delegate-capabilities registered')

  let gone409 = false
  try {
    await client.answerDelegation(rec.id, 'nonexistent-rid', { content: 'x', status: 'ok' })
  } catch (err) {
    gone409 = String((err as Error).message).includes('409')
  }
  if (!gone409) fail('answerDelegation for missing rid should 409')
  console.log('✓ delegate result for missing rid → 409')

  // idle 会话 steer 应 409（契约校验）。
  if (await client.steer(rec.id, 'noop') !== 'idle') fail('client steer on idle session should return idle')
  const steerResponse = await fetch(`${sidecar.baseUrl}/sessions/${rec.id}/steer`, {
    method: 'POST', headers: { authorization: `Bearer ${sidecar.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'noop' }),
  })
  if (steerResponse.status !== 409) fail('steer on idle session should return 409')
  console.log('✓ steer-on-idle → 409 (契约一致)')

  const res = await fetch(`${sidecar.baseUrl}/sessions/${rec.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${sidecar.token}` },
  })
  if (!res.ok) fail(`archive failed: ${res.status}`)
  console.log('✓ session archived (cleanup)')

  console.log('\nSMOKE PASS')
} finally {
  await sidecar.dispose()
  if (previousConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
  else process.env.RIVET_CONFIG_PATH = previousConfigPath
  rmSync(cwd, { recursive: true, force: true })
}
