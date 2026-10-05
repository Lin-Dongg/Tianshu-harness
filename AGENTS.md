# 天枢 (Tiānshū) — AGENTS.md

> 本仓是开发主仓的同步投影（外部 PR 处置与双仓模型见 [EXTERNAL-PRS.md](EXTERNAL-PRS.md)）。
> 本文件是给在本仓工作的 agent / 贡献者的最小上手说明。

## 项目

全功能终端编程智能体运行时（CLI 命令 `rivet`，别名 `tianshu`）：Node.js 24（engines 钉 24.18.0）+ TypeScript strict + 纯 ANSI 终端 UI（`src/tui/engine/`，零 React/Ink）。桌面端与 VS Code 插件均经 `src/server/` sidecar 驱动同一内核。

## 构建与测试

```bash
npm install && npm run build
npm test            # node:test + node:assert/strict（runner: scripts/run-node-tests.ts）
npm run typecheck   # tsc --noEmit
node dist/cli/entry.js  # 启动
```

## 目录速览

| 路径 | 职责 |
|------|------|
| `src/` | 内核：agent 循环（`src/agent/`）、工具（`src/tools/`）、API 客户端（`src/api/`）、提示词与缓存（`src/prompt/`、`src/cache/`） |
| `vscode-extension/` | VS Code / Cursor 插件（开源，sidecar 客户端） |
| `docs/` | 用户手册（`user-guide.md`）、架构、changelog、发布记录（`releases/`） |
| `scripts/` | 构建、测试 runner、门禁、公开仓同步 |
| `plugins/` | 示例插件（office 系列等） |

桌面端（`desktop/`）与部分高级实现不在本仓（闭源边界见 [EXTERNAL-PRS.md](EXTERNAL-PRS.md)）。

## 贡献

- PR 不会被直接 merge——内容经评审后移植进开发主仓、验证、再同步回本仓（关闭 ≠ 拒绝）：[EXTERNAL-PRS.md](EXTERNAL-PRS.md)
- 贡献者指南：[CONTRIBUTING.md](CONTRIBUTING.md)；安全披露：[SECURITY.md](SECURITY.md)
- 贡献者名单：[CONTRIBUTORS.md](CONTRIBUTORS.md)（全体 PR 作者，与 merge 状态无关）

## 给 agent 的纪律

- 求证优先：涉及代码库/运行时状态的断言，先用工具核实，不凭记忆下结论。
- 敏感文件禁止：不读取、不提交 `.env`、密钥、token 类文件。
- 测试失败先定位根因，不用 git 清场（stash/reset/checkout）骗过验证。
- 提交用小而准的 `git add <文件列表>`，不用 `git add -A`。
