import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBashVerification, inferBashVerificationScope, isVerificationCommand } from '../bash-verification.js'

describe('bash verification facts', () => {
  it('preserves domain failure exit codes even when the command executed normally', () => {
    const result = { content: 'AssertionError', isError: false, exitCode: 1 }
    const verification = buildBashVerification('node --test src/cache.test.mjs', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.exitCode, 1)
    assert.equal(verification.failureKind, 'test_failure')
    assert.equal(verification.scope, 'targeted')
    assert.deepEqual(verification.targetFiles, ['src/cache.test.mjs'])
  })

  it('does not fabricate a successful exit when the tool returned no exit code', () => {
    const result = { content: 'still running', isError: false }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'blocked')
    assert.equal(verification.exitCode, undefined)
  })

  it('keeps timeouts distinct from failed test assertions', () => {
    const result = { content: 'timed out', isError: true, exitCode: -1, errorClass: 'timeout' as const }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.exitCode, -1)
    assert.equal(verification.failureKind, 'timeout')
  })

  it('uses the successful retry result instead of an earlier harness error class', () => {
    const result = { content: '# pass 1\n# fail 0', isError: false, exitCode: 0 }
    const verification = buildBashVerification('npm test', result, { ...result, errorClass: 'timeout' })
    assert.equal(verification.status, 'passed')
    assert.equal(verification.exitCode, 0)
    assert.equal(verification.failureKind, undefined)
  })

  it('rejects a contradictory successful exit with failed TAP assertions', () => {
    const result = { content: '# pass 3\n# fail 1\n# skipped 2', isError: false, exitCode: 0 }
    const verification = buildBashVerification('npm test', result, result)
    assert.equal(verification.status, 'failed')
    assert.equal(verification.passed, 3)
    assert.equal(verification.failed, 1)
    assert.equal(verification.skipped, 2)
  })
})

describe('bash verification scope', () => {
  it('allows known unfiltered suite invocations', () => {
    for (const command of ['npm test', 'npm run typecheck', 'npx tsc --noEmit', 'node --test', 'npx vitest run']) {
      assert.equal(inferBashVerificationScope(command).scope, 'full', command)
    }
  })

  it('does not extend selected files, test names or shell chains to full coverage', () => {
    for (const command of ['npm test -- src/cache.test.ts', 'pytest -k cache', 'node --test --test-name-pattern cache',
      'node --test src/cache.test.ts --test-name-pattern cache', 'pytest tests/test_cache.py -k cache',
      'npx jest src/cache.test.ts --testNamePattern=cache',
      'npm test && echo done', 'npm test || true', 'npm run custom-verify']) {
      assert.equal(inferBashVerificationScope(command).scope, command === 'npm test -- src/cache.test.ts' ? 'targeted' : 'unknown', command)
    }
    assert.equal(inferBashVerificationScope('cd nested && npm test').scope, 'full', 'literal cd is a supported transparent wrapper')
  })

  it('preserves quoted file targets and Windows executable paths', () => {
    assert.deepEqual(inferBashVerificationScope('node --test "src/cache manager.test.mjs"'), {
      scope: 'targeted', kind: 'test', targetFiles: ['src/cache manager.test.mjs'],
    })
    assert.equal(inferBashVerificationScope('"C:\\Program Files\\nodejs\\node.exe" --test').scope, 'full')
  })

  it('区分验证种类：test 类才是测试覆盖，typecheck/lint/build/check 只是检查（8784b64b8 审查 P3）', () => {
    // test 类：scope='full' + kind='test' —— 覆盖算法唯一采信的形态
    for (const command of ['npm test', 'node --test', 'npx vitest run']) {
      const r = inferBashVerificationScope(command)
      assert.equal(r.scope, 'full', command)
      assert.equal(r.kind, 'test', command)
    }
    // 检查类：scope 仍为 'full'（status 判据 scope !== 'unknown' 不变，成功仍记 passed），
    // 但 kind 非 test —— 不得清空 impacted-test 未覆盖列表
    assert.deepEqual(inferBashVerificationScope('npm run typecheck'), { scope: 'full', kind: 'typecheck' })
    assert.deepEqual(inferBashVerificationScope('npx tsc --noEmit'), { scope: 'full', kind: 'typecheck' })
    assert.deepEqual(inferBashVerificationScope('npm run build'), { scope: 'full', kind: 'build' })
    assert.deepEqual(inferBashVerificationScope('npm run lint'), { scope: 'full', kind: 'lint' })
    assert.deepEqual(inferBashVerificationScope('cargo check'), { scope: 'full', kind: 'check' })
  })
})

it('pipeline success cannot attest to the hidden test process and later batches retain failures', () => {
  const hidden = { content: 'filtered text', isError: false, exitCode: 0 }
  assert.equal(buildBashVerification('npm test | tail -5', hidden, hidden).status, 'blocked')
  const mixed = { content: '# pass 2\n# fail 0\n# pass 3\n# fail 1', isError: false, exitCode: 0 }
  const result = buildBashVerification('npm test', mixed, mixed)
  assert.equal(result.status, 'failed'); assert.equal(result.failed, 1); assert.equal(result.passed, 5)
})


describe('非 JavaScript 生态 runner（dotnet / maven / gradle）', () => {
  it('识别验证子命令为 full 覆盖并区分类别', () => {
    for (const [command, kind] of [
      ['dotnet test', 'test'],
      ['dotnet test tests/SelfTest.csproj', 'test'],
      ['dotnet build MonitorApp.csproj --nologo', 'build'],
      ['dotnet run --project tests/SelfTest.csproj', 'build'],
      ['mvn test', 'test'],
      ['./mvnw verify', 'test'],
      ['mvn compile', 'build'],
      ['gradle test', 'test'],
      ['./gradlew build', 'build'],
      ['./gradlew check', 'check'],
    ] as Array<[string, string]>) {
      const inferred = inferBashVerificationScope(command)
      assert.equal(inferred.scope, 'full', command)
      assert.equal(inferred.kind, kind, command)
    }
  })

  it('带过滤选择的调用只跑了子集，保留 unknown', () => {
    for (const command of [
      'dotnet test --filter FullyQualifiedName~CacheTests',
      'mvn test -Dtest=CacheTest',
      'gradle test --tests CacheTest',
    ]) {
      assert.equal(inferBashVerificationScope(command).scope, 'unknown', command)
    }
  })

  it('管道中的非 JS runner 保留 unknown 意图；透明 cd 包装仍为 full', () => {
    assert.equal(inferBashVerificationScope('dotnet test | tail -5').scope, 'unknown')
    assert.equal(inferBashVerificationScope('cd repo && dotnet test').scope, 'full')
  })

  // Maven/Gradle 是「阶段/任务序列」语法：目标词不必紧跟可执行名，前面可以排
  // 生命周期阶段（clean）与全局选项（-q/-B/--no-daemon）。#380 的样本全是 dotnet
  // （flag 在子命令后），这一族没有现场，最初按 npm 的「子命令紧跟」形状实现 → 漏。
  it('生命周期阶段前缀与全局选项不遮挡识别（mvn clean test / gradlew clean build）', () => {
    for (const [command, kind] of [
      ['mvn clean test', 'test'],
      ['mvn clean verify', 'test'],
      ['mvn clean install', 'build'],
      ['mvn -q test', 'test'],
      ['mvn -B clean package', 'build'],
      ['gradle clean test', 'test'],
      ['./gradlew clean build', 'build'],
      ['./gradlew clean check', 'check'],
    ] as Array<[string, string]>) {
      assert.equal(inferBashVerificationScope(command).scope, 'full', command)
      assert.equal(inferBashVerificationScope(command).kind, kind, command)
    }
  })

  it('带选择标志的阶段序列仍降级 unknown；纯 clean / 版本查询不入账', () => {
    assert.equal(inferBashVerificationScope('mvn clean test -Dtest=CacheTest').scope, 'unknown')
    assert.equal(inferBashVerificationScope('gradle clean test --tests CacheTest').scope, 'unknown')
    // clean 本身不是验证；--version/-v 已被上游排除。
    assert.equal(isVerificationCommand('mvn clean'), false)
    assert.equal(isVerificationCommand('mvn -v'), false)
    assert.equal(isVerificationCommand('gradle --version'), false)
  })

  it('Windows 批处理 wrapper（.bat / .cmd）同样识别', () => {
    assert.equal(inferBashVerificationScope('gradlew.bat build').scope, 'full')
    assert.equal(inferBashVerificationScope('gradlew.bat clean build').scope, 'full')
    assert.equal(inferBashVerificationScope('mvnw.cmd test').scope, 'full')
  })

  it('Maven 反应堆选择器与测试跳过标志降级 unknown（#380 收尾：子集/零测试不得冒充全量）', () => {
    // 失效方向：这些形态此前全部误判 {full, test}——多模块仓局部测试被记为全量
    // 证据、跳过执行被记为测试覆盖，是交付门禁的过度举证（错误的一侧）。
    for (const command of [
      'mvn -pl module-a test',
      'mvn -pl module-a -am test',
      'mvn -pl module-a -amd test',
      'mvn --projects module-a,module-b verify',
      'mvn -pl :artifact-id test',
      'mvn -rf module-b test',
      'mvn --resume-from module-b test',
      'mvn test -Dmaven.test.skip=true',
      'mvn test -Dmaven.test.skip.exec=true',
      'mvn test -DskipTests',
      'mvn test -DskipTests=true',
      'mvn verify -DskipITs',
    ]) {
      const inferred = inferBashVerificationScope(command)
      assert.equal(inferred.kind, 'test', command)
      assert.equal(inferred.scope, 'unknown', command)
    }
    // 不选择测试的全局选项不得被误降级：-P 是 profile 激活，--parallel 是并行开关
    // （前缀含 -pl/-p 字样但不是选择器）。
    assert.equal(inferBashVerificationScope('mvn clean test -Pproduction').scope, 'full')
    assert.equal(inferBashVerificationScope('gradle --parallel test').scope, 'full')
  })

  it('模块任务路径与 plugin:goal 直调入账（#380 收尾：多模块最常见形态不再静默漏记）', () => {
    // gradle 模块限定与 mvn -pl 同义——反应堆子集：入账（kind 正确）但 scope unknown
    for (const [command, kind] of [
      ['./gradlew :app:test', 'test'],
      ['./gradlew :app:testDebugUnitTest', 'test'],
      ['gradle :app:build', 'build'],
      ['gradle :core:lib:check', 'check'],
    ] as Array<[string, string]>) {
      const inferred = inferBashVerificationScope(command)
      assert.equal(isVerificationCommand(command), true, command)
      assert.equal(inferred.kind, kind, command)
      assert.equal(inferred.scope, 'unknown', command)
    }
    // maven plugin:goal 未限定反应堆 = 未过滤直调 → full
    assert.deepEqual(inferBashVerificationScope('mvn surefire:test'), { scope: 'full', kind: 'test' })
    assert.deepEqual(inferBashVerificationScope('mvn checkstyle:check'), { scope: 'full', kind: 'check' })
    assert.deepEqual(inferBashVerificationScope('mvn compiler:compile'), { scope: 'full', kind: 'build' })
    // 裸 gradle camelCase 任务未限定模块 = 全反应堆执行 → full
    assert.deepEqual(inferBashVerificationScope('gradle testDebugUnitTest'), { scope: 'full', kind: 'test' })
    // 模块限定 / plugin:goal 叠加既有选择、跳过标志仍降级
    assert.equal(inferBashVerificationScope('./gradlew :app:test -DskipTests').scope, 'unknown')
    assert.equal(inferBashVerificationScope('mvn surefire:test -Dtest=CacheTest').scope, 'unknown')
    // 复合 shell 里的模块任务保留验证意图（管道拿不到逐文件证明 → unknown 而非消失）
    assert.equal(isVerificationCommand('./gradlew :app:test | tail -5'), true)
    assert.equal(inferBashVerificationScope('./gradlew :app:test | tail -5').scope, 'unknown')
  })

  it('冒号词法不误伤：Windows 盘符、-pl 参数值、只编译不跑的 goal、连字符 goal', () => {
    // 盘符属性值不制造虚假验证记录（`C:test` 的冒号前是分隔符+单字母，不是任务语法）
    assert.equal(isVerificationCommand('mvn -Dtest.dir=C:test'), false)
    assert.equal(isVerificationCommand('gradle -Pdir=C:build'), false)
    // 带盘符参数的真实全量调用识别不受影响
    assert.deepEqual(inferBashVerificationScope('mvn -Dmaven.repo.local=C:\\m2\\repo test'), { scope: 'full', kind: 'test' })
    // -pl 的参数值带冒号不算目标词（纯 `-pl a:b` 无 goal 本就不是验证）；`-pl` 本身降级
    assert.equal(isVerificationCommand('mvn -pl a:b'), false)
    assert.equal(inferBashVerificationScope('mvn -pl a:b test').scope, 'unknown')
    // compiler:testCompile 只编译不跑测试——camelCase 续写不给 plugin:goal，不得伪造 test 覆盖
    assert.equal(isVerificationCommand('mvn compiler:testCompile'), false)
    // 连字符 goal（dependency:build-classpath）不是精确目标词，不误判为 build
    assert.equal(isVerificationCommand('mvn dependency:build-classpath'), false)
  })
})

it('批处理 runner 被管道/复合包裹时不致静默消失——保留验证意图（记 blocked 并给单条建议）', () => {
  // 静默失效比噪音贵：`… run-node-tests.ts f | tail` 以前完全不入台账
  // （VERIFICATION_SEGMENT 只认 `--test` 字面量），跑了几千个用例却零记录。
  for (const command of [
    'npx tsx scripts/run-node-tests.ts src/a.test.ts | tail -5',
    'cd src && npx tsx scripts/run-node-tests.ts a.test.ts',
    'rtk node --import tsx scripts/run-node-tests.ts x.test.ts | tail -3',
  ]) {
    assert.equal(isVerificationCommand(command), true, command)
  }
  // 但归因不到逐文件证明 → unknown（不冒充 full）
  assert.equal(inferBashVerificationScope('npx tsx scripts/run-node-tests.ts src/a.test.ts | tail -5').scope, 'unknown')
  // 纯查询仍不得因 runner 字样进台账
  assert.equal(isVerificationCommand('ls scripts/run-node-tests.ts'), false)
  assert.equal(isVerificationCommand('wc -l desktop/scripts/run-tests.ts'), false)
})
