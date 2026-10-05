import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src', 'server', 'serve-agent.ts'), 'utf8')

describe('serve-agent gate wiring', () => {
  it('assigns refs.getImpactedTests so delivery gate module coverage runs on sidecar', () => {
    assert.match(source, /refs\.getImpactedTests\s*=/,
      'sidecar 未接 getImpactedTests —— delivery-gate-v2 的 moduleCoverage 分支在桌面端/插件上永不触发')
  })

  it('passes cwd to injectDurableClaims so the cross-project pollution gate runs', () => {
    assert.match(source, /injectDurableClaims\(\s*claimStore\s*,\s*cwd\s*\)/,
      'sidecar 未传 cwd —— session-persist.ts 的文件交集门禁被整块跳过')
  })
})

describe('包装对象的可选面转发对账', () => {
  it('管理器用到的每个 agent 可选面，包装对象都必须转发（漏一个只会静默 undefined）', () => {
    // 形状：管理器对这些面一律 `agent.X?.()` —— 方法不存在时不报错、只静默拿到
    // undefined，所以「真身有没有转发」读代码看不出来，只能对账。
    // 转录水位就是这么漏的：只在 AgentLoop 上实现了，而 buildManagedAgent 返回的是
    // **手工包装对象**，生产检查点因此一直缺水位。
    const managerSource = readFileSync(join(process.cwd(), 'src', 'server', 'session-manager.ts'), 'utf8')
    const optional = [...new Set(
      [...managerSource.matchAll(/agent\??\.([a-zA-Z][a-zA-Z0-9]*)\?\.\(/g)].map((m) => m[1]!),
    )].sort()
    assert.ok(optional.length >= 15, `前置：应能扫到管理器用到的可选面（实得 ${optional.length}）`)

    // 只看 buildManagedAgent 函数体里的包装字面量（键在 4 空格缩进），避免扫到文件里
    // 其他对象字面量的同名键而虚报「已转发」。
    const start = source.indexOf('export function buildManagedAgent(')
    assert.ok(start > 0, '应能定位 buildManagedAgent')
    const body = source.slice(start, source.indexOf('\nfunction buildSessionStores(', start))
    const forwarded = new Set(
      [...body.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!),
    )

    const missing = optional.filter((name) => !forwarded.has(name))
    assert.deepEqual(missing, [],
      `包装对象漏转发这些面（管理器会静默拿到 undefined）：${missing.join(', ')}`)
  })
})

it('all shared tool registries resolve current delivery impact rather than historical accumulated tests', () => {
  const bootstrap = readFileSync(join(process.cwd(), 'src/bootstrap.ts'), 'utf8')
  assert.match(bootstrap, /resolveDeliveryImpact: \(cwd, files\) => resolveDeliveryImpact\(cwd, files, refs\.meridianIndexer\)/)
  assert.match(source, /createInteractiveToolRegistry\(/)
})
