# dsh-session-handoff · 会话接力

[English](./README.en.md) | 简体中文

> 在 DSH 输入框的提交按钮旁多一个按钮：一键把当前会话「总结 → 固化记忆 → 写成交接文档 → 带进新会话继续干」。

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933)](./package.json)
[![DSH 0.2.x](https://img.shields.io/badge/DSH-0.2.x-4c8dff)](./docs/04-可行性分析.md)

长任务跑到上下文快满、要换模型/换预设、要把手里的一摊活交给另一个会话或同事时，
最贵的不是「再开一个会话」，而是**重新讲一遍已经发生了什么**。

本插件把这一步做成一次点击：读取当前会话日志 → 确定性提取事实 → 让模型归纳成五段式交接 →
在会话工作目录写一份 `WorkSummary.md`（+ 机器可读 `handoff.json` + 记忆台账）→
打开一个新会话，把摘要、交接文档路径与参考文件预填成第一句提示词。

- **不删原会话、不 fork 历史**：新会话是干净的，只携带「结论 + 文档指针」，token 成本可控。
- **失败也能用**：模型不可用/超时/输出不合法时自动降级为确定性摘要，文档照样生成。
- **可审阅**：默认只预填草稿，你在发送前能改；想全自动可开 `autoSend`。
- **零运行时依赖**：宿主半只用 node 内置模块，浏览器半只从宿主的 React 基线取模块。

## 体验路径

1. 在任意会话里，输入框右侧、发送按钮附近会出现「接力」图标按钮。
2. 点一下 → 按钮转圈（整理中）→ 成功后自动切到一个**同一工作区的新会话**，输入框里已经填好交接提示词。
3. 新会话的第一件事：读交接文档（绝对路径已写进提示词），然后从「下一步」第一项继续。
4. 交接文档留在 ` <工作目录>/.dsh-handoff/<时间戳>-<标题>/WorkSummary.md`，可归档、可交接给同事、可进 Git。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-session-handoff

# 或从本地检出（开发态）
dsh plugin --profile desktop add link:/path/to/dsh-session-handoff
```

桌面端装完通常无需重启（客户端 bundle 走 HMR）；若按钮未出现，刷新一次页面。
卸载：`dsh plugin --profile desktop remove dsh-session-handoff`。

## 配置（可选）

在 profile 的 bundle patch 里给这一行加 `config:`，全部字段可选：

```yaml
- insert:
    - id: session-handoff
      name: dsh-session-handoff
      config:
        dir: .dsh-handoff          # 交接文档目录（相对会话 cwd）
        writeMemory: true          # 写/合并记忆台账
        autoSend: false            # true = 直接发送到新会话；false = 预填草稿
        provider: ''               # 为空则沿用会话最后一次请求的路由
        model: ''
        maxTokens: 4096
        maxInputChars: 80000
        promptCharBudget: 6000
```

## 产物长什么样

```text
<工作目录>/.dsh-handoff/
├── 20261023-031500-建立会话接力插件/
│   ├── WorkSummary.md      # 人读：五段式交接 + 工具活动附录
│   └── handoff.json        # 机器读：schema dsh-session-handoff/v1
└── 交接记忆.md              # 跨会话可复用的偏好/约定/事实（去重追加）
```

`WorkSummary.md` 固定包含：目标与意图 / 已完成 / 关键决策 / 当前状态 / 下一步 / 记忆候选 /
参考文件 / 工具活动附录。没有模型时，前四段由确定性规则生成并标注 `generated_by: deterministic`。

## 工作原理

```text
[按钮 conversation.input.right]
   │ POST /session-handoff/prepare { sessionId }        (x-dsh-handoff: 1 同源标记)
   ▼
[宿主半]  ctx.sessionQuery.readSession(sessionId)   ← 只读，不写会话日志
   │       → 事实采集（用户诉求 / 助手进展 / 工具调用 / 失败 / 文件 / 路由）
   │       → ctx.llm.stream 一次性归纳（JSON 协议，temperature 0，可取消）
   │       → 渲染 + 原子写盘（WorkSummary.md / handoff.json / 记忆台账）
   ▼
{ promptText, docPath, dataPath, degraded[], stats }
   │
   ▼
[浏览器半] uiWorkspace.startSession(undefined, { prompt })  ← 预填草稿（默认）
           或 sessions.create → retain → prompt → openSession（autoSend）
```

细节、接缝证据与降级矩阵见 [`docs/03-技术设计.md`](./docs/03-技术设计.md)。

## 安全边界

- **只读会话**：不向会话日志追加事件，不修改标题/压缩状态；写盘仅限当前会话 `cwd` 下配置目录。
- **同源**：POST 必须带 `x-dsh-handoff: 1` 且 Origin 与 Host 一致；不提供 CORS。
- **不引入新外发通道**：摘要走 DSH 已配置的模型路由；插件自身不联网。
- **文件权限 0600、原子写、不覆盖**：同名交接目录自动追加序号，绝不覆盖既有文档。
- **记忆可控**：只追加 `memory` 候选；重复内容不重复写；台账可随时人工删改。

## 开发与自检

```bash
pnpm install
pnpm run bundle       # lib/index.js（host） + lib/client.js（浏览器模块工厂）
pnpm run typecheck    # tsc --noEmit
pnpm run verify       # 29 项产物契约自检
node scripts/smoke.mjs # 32 项宿主半端到端冒烟（假 ctx + 临时目录，不启动 DSH）
```

当前基线（DSH 0.2.1-rc.2 / node 24）：`tsc` 0 错误、`verify` 29/29、`smoke` 32/32。

## 兼容性

- DSH `>=0.2.0-rc.1 <0.3.0-0`（`engines.dsh`）；实测基线 `0.2.1-rc.2`。
- 缺少 `sessionQuery` 时退回活会话 `deriveMessages()`（降级标记 `no-session-query`）；
  缺少 `uiWorkspace.startSession` 时退回 `sessions.create + retain + prompt`；
  缺少 LLM 路由时退回确定性摘要。
- 依赖的座位 `conversation.input.right` 若在将来版本移除，会退回
  `conversation.session.header.utilities`；两者都缺失时浏览器半静默，宿主端点仍可用。

## 文档

| 文档 | 内容 |
|---|---|
| [01 DSH 插件机制分析](./docs/01-DSH插件机制分析.md) | Cordis 两半模型、profile 装载、宿主/浏览器扩展面、会话数据模型、稳定性分级 |
| [02 同类插件调研](./docs/02-同类插件调研.md) | dshfind / GitHub 上 10+ 个相邻插件的能力对比与市场空白 |
| [03 技术设计](./docs/03-技术设计.md) | 架构、接缝、数据流、协议、降级矩阵、成本与安全、测试 |
| [04 可行性分析](./docs/04-可行性分析.md) | 逐项诉求的技术验证、证据链、不确定性实验计划、替代方案对比 |
| [05 产品设计](./docs/05-产品设计.md) | 定位、场景、交互规格、信息架构、指标、路线图 |

## 已知限制

- 交接质量受源会话日志完整度影响；极端长会话会在输入预算处按「保头保尾」截断。
- 记忆台账目前是本插件自有格式（Markdown），与 `dsh-mnemon` 等记忆插件的自动同步在 v0.2。
- `autoSend` 依赖半公开的 `sessions.retain/prompt`，DSH 内部改动时可能失效（自动回退草稿）。
- 不做跨机器/跨用户传输：交接文档要不要进 Git、要不要发给别人，由用户决定。

## License

MIT © 2026 yangsong608
