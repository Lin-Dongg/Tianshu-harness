import type { ChildProcess } from 'child_process'
import { killProcessTree, type RunTaskkill } from './process-kill.js'

const activeProcesses = new Set<ChildProcess>()

export function track(child: ChildProcess, _loopId?: string): ChildProcess {
  activeProcesses.add(child)
  child.on('close', () => activeProcesses.delete(child))
  child.on('error', () => activeProcesses.delete(child))
  return child
}

export function getActiveCount(): number {
  return activeProcesses.size
}

// Synchronous variant for exit paths: process.exit() runs before any setTimeout
// fires, so a deferred SIGKILL never executes and children are orphaned
// (PPID=1). This kills inline so the tree dies before the process exits.
//
// 两阶段终止只在**有等待窗口**时才有意义（异步版留 2 秒让 SIGTERM 先生效）。
// 同步路径没有窗口，两次调用紧挨着发出：Windows 上 killProcessTree 忽略 signal
// （process-kill.ts:64-65，一律 `taskkill /F /T`），第二发与第一发参数逐字相同，
// 剩下的只有 spawnSync 空转（每次 timeout 5000；实测单子进程 ~800ms）。故 win32 只发一次。
// 见 issue #185。
//
// `platform` / `runTaskkill` 是测试缝（与 process-kill.ts 同款）：此前本函数不可注入，
// process-tracker.test.ts 断言的是 Unix 回退路径，于是在 Windows 宿主上恒红。
export function killAllSync(
  platform: NodeJS.Platform = process.platform,
  runTaskkill?: RunTaskkill,
): void {
  for (const child of activeProcesses) {
    if (platform === 'win32') {
      // 退出/注销路径零 spawn（issue #398）：Windows 注销阶段会话拆除中，新进程
      // DLL 初始化大量失败（0xC0000142），spawnSync('taskkill') 的加载器弹系统
      // 硬错误框（NtRaiseHardError → CSRSS，windowsHide 压不住）阻塞关机甚至中止
      // 关机。改为进程内直杀（child.kill = TerminateProcess，不 spawn）。
      // 树杀兜底：经 job-launch.exe 的壳由 Job Object KILL_ON_JOB_CLOSE 收树（#144），
      // 注销场景由会话拆除收余；runTaskkill 缝保留给 unix 分支与调用方兼容。
      try { child.kill('SIGKILL') } catch { /* best-effort */ }
    } else {
      killProcessTree(child, 'SIGTERM', process.kill, platform, runTaskkill)
      killProcessTree(child, 'SIGKILL', process.kill, platform, runTaskkill)
    }
  }
  activeProcesses.clear()
}
