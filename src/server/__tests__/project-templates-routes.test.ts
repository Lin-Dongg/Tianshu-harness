/**
 * issue #221 —— `/project-templates/*` 的 cwd 必须在册。
 *
 * `POST /project-templates/apply` 会往 cwd 铺 AGENTS.md / .rivet.md 模板。此前
 * cwd 不校验是否属于已注册工作区，任意目录都能被铺上模板（跨项目提示注入投毒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildProjectTemplatesRoutes } from '../project-templates-routes.js'

const TOKEN = 'project-templates-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

test('未注册工作区的 cwd 一律 403，在册的照常（issue #221）', async () => {
  const known = mkdtempSync(join(tmpdir(), 'rivet-tpl-known-'))
  const outside = mkdtempSync(join(tmpdir(), 'rivet-tpl-outside-'))
  try {
    const router = createRouter(buildProjectTemplatesRoutes(TOKEN, () => [known]))

    const status = await router('GET', `/project-templates/status?cwd=${encodeURIComponent(outside)}`, {}, AUTH)
    assert.equal(status.status, 403, '未注册目录的 status 必须被拒')

    const apply = await router('POST', '/project-templates/apply', { cwd: outside, agentsMode: 'overwrite' }, AUTH)
    assert.equal(apply.status, 403, '未注册目录不得被铺模板')
    assert.ok(!existsSync(join(outside, 'AGENTS.md')), '被拒的 apply 不得留下文件')

    const ok = await router('GET', `/project-templates/status?cwd=${encodeURIComponent(known)}`, {}, AUTH)
    assert.equal(ok.status, 200, '在册工作区照常')
  } finally {
    rmSync(known, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

/**
 * P0-5 —— 已注册但目录已被删除的工作区：apply 不得让 ENOENT 穿透路由
 * （现场：测试临时目录被删后仍在会话库里，桌面端点「应用模板」→ 整 sidecar
 * 因未处理 rejection 退出）。
 */
test('工作目录不存在 → 404 workspace-missing（status 与 apply）', async () => {
  const known = mkdtempSync(join(tmpdir(), 'rivet-tpl-gone-'))
  const gone = join(known, 'deleted-subdir') // 已注册、磁盘上不存在
  try {
    const router = createRouter(buildProjectTemplatesRoutes(TOKEN, () => [gone]))

    const status = await router('GET', `/project-templates/status?cwd=${encodeURIComponent(gone)}`, {}, AUTH)
    assert.equal(status.status, 404, '目录不存在时 status 不得报 needsInit=true 诱导初始化')
    assert.deepEqual(status.body, { error: 'workspace-missing' })

    const apply = await router('POST', '/project-templates/apply', { cwd: gone, agentsMode: 'overwrite' }, AUTH)
    assert.equal(apply.status, 404, '目录不存在时 apply 不得抛 ENOENT')
    assert.deepEqual(apply.body, { error: 'workspace-missing' })
  } finally {
    rmSync(known, { recursive: true, force: true })
  }
})
