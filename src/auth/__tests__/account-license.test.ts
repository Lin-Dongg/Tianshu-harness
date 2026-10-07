/**
 * 设备许可恢复的官网调用层（`src/auth/account-license.ts`）。
 *
 * 路由用例把这一层桩掉了，所以这里补上它自己的契约：请求形状（Bearer 走凭据、
 * 许可号与设备指纹进 body）、状态码/业务码 → 内部码的映射、以及**网络异常不被
 * 冒充成官网拒绝**。最后一条是真实会踩的：把 ECONNREFUSED 报成 device_mismatch，
 * 用户会去查设备绑定而不是查网络。
 *
 * 运行：npm exec -- tsx --test src/auth/__tests__/account-license.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activateAccountLicense } from '../account-license.js'

/** 记录请求的假 fetch：给定回放响应（或抛出的错误）。 */
function stubFetch(reply: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (reply instanceof Error) throw reply
    return reply.clone()
  }) as unknown as typeof fetch
  return { calls, impl }
}

test('凭据走 Bearer、许可号与设备指纹进 body，且带 apikey', async () => {
  const { calls, impl } = stubFetch(new Response(JSON.stringify({ grant: 'signed-grant' }), { status: 200 }))
  const result = await activateAccountLicense('at-secret', 'lic-1', 'machine-uid-1', { fetchImpl: impl })

  assert.deepEqual(result, { code: 'ok', grant: 'signed-grant' })
  assert.match(calls[0]!.url, /\/functions\/v1\/tui-account-activate$/)
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer at-secret')
  assert.ok(headers.apikey, 'apikey 是 verify_jwt 的凭据，缺了直接 401')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { licenseId: 'lic-1', deviceId: 'machine-uid-1' })
  assert.ok(calls[0]!.init.signal instanceof AbortSignal, '必须有超时信号，否则单请求能挂死')
})

test('状态码与业务码的映射固定；未知 reason 不许原样透给 UI', async () => {
  const cases: Array<[Response, string]> = [
    [new Response('not-json', { status: 401 }), 'auth_required'],
    [new Response(JSON.stringify({ error: 'auth_required' }), { status: 401 }), 'auth_required'],
    [new Response('not-json', { status: 404 }), 'endpoint_unavailable'],
    // 官网既用 404 表示接口缺失，也用 404 透出授权服务的业务错误（`tui-account-activate`
    // 原样转发 `result.status`）。不先认结构化业务码，就会把「许可尚未进入授权服务」
    // 说成「官网服务版本暂不支持此功能」——用户被告知去等服务更新。
    [new Response(JSON.stringify({ error: 'code_not_found' }), { status: 404 }), 'code_not_found'],
    [new Response(JSON.stringify({}), { status: 404 }), 'endpoint_unavailable'],
    [new Response(JSON.stringify({ error: 'brand_new_reason' }), { status: 404 }), 'endpoint_unavailable'],
    [new Response(JSON.stringify({ error: 'activation_limit_reached' }), { status: 403 }), 'activation_limit_reached'],
    [new Response(JSON.stringify({ error: 'trial_already_used' }), { status: 403 }), 'trial_already_used'],
    [new Response(JSON.stringify({ error: 'brand_new_reason' }), { status: 403 }), 'service_error'],
    [new Response(JSON.stringify({ error: 'boom' }), { status: 500 }), 'service_error'],
    [new Response('not-json', { status: 500 }), 'protocol_error'],
    // 合法 JSON 但是裸 null：老写法在 `data.error` 上会直接抛，异常冒到 UI 变成未分类错误。
    [new Response('null', { status: 500 }), 'protocol_error'],
    [new Response(JSON.stringify({}), { status: 200 }), 'protocol_error'],
    [new Response(JSON.stringify({ grant: '' }), { status: 200 }), 'protocol_error'],
  ]
  for (const [reply, expected] of cases) {
    const { impl } = stubFetch(reply)
    const result = await activateAccountLicense('at', 'lic-1', 'machine-uid-1', { fetchImpl: impl })
    assert.equal(result.code, expected, `status ${reply.status} 应映射为 ${expected}`)
  }
})

test('网络异常与超时分开报，不冒充官网拒绝', async () => {
  const refused = stubFetch(new Error('ECONNREFUSED'))
  assert.equal((await activateAccountLicense('at', 'lic-1', 'machine-uid-1', { fetchImpl: refused.impl })).code, 'network_error')

  const timedOut = new Error('The operation was aborted due to timeout')
  timedOut.name = 'TimeoutError'
  const timed = stubFetch(timedOut)
  assert.equal((await activateAccountLicense('at', 'lic-1', 'machine-uid-1', { fetchImpl: timed.impl })).code, 'timeout')
})

test('失败路径不回带凭据或半截 grant', async () => {
  for (const reply of [new Response('not-json', { status: 500 }), new Response(JSON.stringify({ error: 'boom' }), { status: 500 })]) {
    const { impl } = stubFetch(reply)
    const result = await activateAccountLicense('at', 'lic-1', 'machine-uid-1', { fetchImpl: impl })
    assert.equal(result.grant, undefined)
    assert.equal(JSON.stringify(result).includes('at'), false)
  }
})
