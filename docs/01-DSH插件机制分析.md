# DSH 与它的插件机制

> 分析对象：`deepseek-harness` 0.2.1-rc.2（本地检出 `/Volumes/软件目录/work/zkxh/deepseek/deepseek-harness`）
> 分析方式：读上游源码 + 官方 `docs/` + 本机 profile 里 27 个已装 bundle + 4 个自研插件的实证
> 写作目的：为「会话接力」插件选定接缝，并说明每条接缝的稳定性与代价

---

## 0. 一句话结论

DeepSeek Harness（DSH）是**一个 Cordis 依赖注入内核 + 一层 Agent 运行时 + 一套 Web 客户端组合系统**。
插件不是一个「扩展目录」，而是**一个 npm 包同时声明两个半（host / client）**：

- 宿主半是一个普通 Cordis 插件（ESM，`apply(ctx)`），能拿到 `ctx.sessions`、`ctx.llm`、`ctx.webServer` 等能力；
- 浏览器半是一个 **CJS 模块工厂**产物（`window.__ModuleLoader__.load({ id, factory })`），只能往 **slot** 里注册 React 组件，
  依赖从宿主的模块表解析，不打包 React。

装进 profile 的形态是「`package.json` 声明 + `cordis.patch.yml` 插一行 + `dsh.profile.bundles` 排序」，
profile 的 `dependencies` 决定从 npm 装还是 `link:` 本地目录。

对「会话接力」这个需求，DSH 恰好同时提供了三块拼图：**会话日志的只读查询**（`ctx.sessionQuery`）、
**一次性模型调用**（`ctx.llm.stream`）、**输入框右侧的空座位**（`conversation.input.right`）。
这是本插件可行的根本原因，也是本文档要证明的事。

---

## 1. 仓库形态与版本

| 维度 | 事实 |
|---|---|
| 版本 | `dsh-v0.2.1-rc.2`（git `687f282e86`） |
| 形态 | pnpm monorepo：`apps/`（cli、web、desktop、desktop-host、plugin-market-generator）+ `packages/`（60+ 包组）+ `native/`、`python/`、`website/` |
| 文档 | `docs/` 下 80+ 中英对照子系统文档；`AGENTS.md` 是给 Agent 的仓库规则 |
| 客户端包 | `packages/client/*` 约 60 个 UI 包，按「能力 + slot 贡献」拆分 |
| 扩展包 | `packages/extensions/*`：`cordis-host-runner`、`cordis-client-runner`、`tool-cordis`、`ui-cordis` |
| 插件生态 | 本机 `~/.dsh/profiles/desktop/package.json` 分析时已装 27 个 bundle（本插件安装后 28 个），其中 20+ 为第三方插件 |

关键目录：

```text
packages/core/session          # 会话事件日志、surface、fork、请求头折叠
packages/session-query         # 跨 live/持久化的只读会话查询
packages/compaction            # 压缩能力 seam + 内置后端 + /compact 命令
packages/llm                   # LlmRuntime.stream、BlockAssembler、消息与调用配置
packages/client/ui-slots       # slot 注册表（不依赖 React）
packages/client/ui-renderer    # slot → React 树，标准 hooks 的装配处
packages/client/ui-conversation# 输入框、消息流、composer 座位声明
packages/extensions/cordis-client-runner/src/client/slot-catalog.ts  # 全部客户端座位的编译期契约
packages/host/webserver        # ctx.webServer.register
```

---

## 2. 运行时骨架：Cordis 两半模型

### 2.1 宿主半

一个包只要 `main` 指向一个 ESM 模块并导出 `apply(ctx)`，就能被 Cordis loader 当作插件加载：

```ts
export const inject = ['webServer']          // 等待的服务
export function apply(ctx, config) {         // 同步/异步都可
  ctx.webServer.register({ kind: 'exact', path: '/x', handler })
  ctx.effect(() => { /* 资源 */ return () => { /* 清理 */ } })
}
```

`inject` 里的服务名是 Typed 的（声明合并），加载顺序由 Cordis 的「等待服务就绪」决定，而不是 bundle 顺序。
拿不到的服务可以用 `ctx.get(name, false)` 软取——这是第三方插件做**能力降级**的标准写法。

### 2.2 浏览器半

浏览器半不是 ESM，而是「模块工厂」：构建产物外壳固定为三行（上游 `packages/client/tsdown.client.ts:663-669`）：

```js
window.__ModuleLoader__.load({ id: "包名", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* …你的代码… */
return module.exports; } });
```

`require` 是宿主模块表：只有 `react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
`@deepseek-ai/dsh-client-ui-dockkit` 这几行基线（`packages/client/web/src/platform.ts:8-13`）。
**不能 import 任何其他 `@deepseek-ai/*` 运行时模块**——宿主模块表里没有，装进页面就会报缺模块。

浏览器半的装载链路：

```text
profile bundles → Loader entries
   → ctx.clientModules 扫描声明了 dsh.client 的包
   → 组合 __DSH_BOOT__ 图（行 = 包，批 = 启动脚本）
   → GET /plugins/??<pkg-a>/client.js,<pkg-b>/client.js&rev=<rev>
   → 浏览器 __ModuleLoader__ 物化 factory
   → Cordis 客户端插件 apply(ctx) → ctx.slots.register(...)
```

对应官方文档：`docs/subsystems/client-modules.zh.md`。HMR 只认「bundle 元数据（mtime/ctime/size）变化」，
所以插件开发可以「改 → 构建 → 页面自动重载」，但**产物没变就不会刷新**。

### 2.3 装载三件套

第三方插件（本机 4 个自研 + 20 个市场插件）全部同构：

```text
<plugin>/
├── package.json        # main / exports["."] / exports["./client"] / dsh.bundle.patch / dsh.client.platform
├── cordis.patch.yml    # - insert: [{ id, name }]（可带 config）
├── lib/index.js        # 宿主半（ESM）
└── lib/client.js       # 浏览器半（模块工厂 CJS）
```

profile 侧则是两处登记：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-session-handoff": "link:/…/dsh-session-handoff" },
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "...", "dsh-session-handoff" ] } }
}
```

`bundles` 是有序的**组合层**；每个 bundle 的 patch 依次插进 loader。插件的生命周期与 bundle 的启用/禁用绑定。

---

## 3. 宿主侧扩展面（本插件相关）

| 服务 | 用途 | 稳定性 | 证据 |
|---|---|---|---|
| `ctx.webServer.register({kind,path,handler})` | 给浏览器半开同源 HTTP 端点 | **A 公开**（文档 + 大量第三方插件使用） | `docs/subsystems/web-server.zh.md:200`；`webServer.register` 返回 disposer |
| `ctx.sessionQuery.readSession(id)` | 只读读取完整日志（live 优先，归档可读，回放校验） | **A 公开** | `docs/subsystems/session-query.zh.md:416-421` |
| `ctx.sessions.get/list/create/fork` | 内存会话存储、fork 历史 | A/B（`create/fork` 文档化，但普通业务更常用 API 控制器） | `docs/subsystems/session.zh.md:681,1004+` |
| `ctx.llm.stream(GenerateOptions)` | 一次性模型调用（压缩、标题、审阅都用它） | **A 公开** | `docs/subsystems/llm-streaming.zh.md:984+`；`packages/experimental/auto-review/src/index.ts:589-617` |
| `ctx.compaction.compactNow(agent)` | 原地压缩（同会话） | A（但与「新会话接力」目标不同） | `docs/subsystems/compaction.zh.md` |
| `ctx.tokenMeter` | token 估算 | A | `docs/subsystems/token-meter.zh.md` |
| `ctx.tools.register` | 注册 Agent 工具 | A | `docs/subsystems/tools.zh.md` |
| `ctx.commands` | 注册斜杠命令 | A | `docs/subsystems/commands.zh.md` |
| `ctx.workingDirectory` | 解析 agent 的工作目录 | A | `packages/experimental/auto-review/src/index.ts:592` |
| `ctx.sessions.retain/prompt`（浏览器半 `sessions` 服务） | 绑定会话并入队一轮 | **B 半公开**（官方 UI 与多个第三方插件在用，非为插件设计） | 本机 `dsh-workbench/src/client/app.ts:4083-4130` |

**读取会话的正确姿势**：会话对象上的 `eventAt/snapshotEvents/ownEvents` 已被标注为「新增生产调用禁止」
（`packages/core/session/README.zh.md`「读取日志」一节），读历史应走 `ctx.sessionQuery`
（`readSession` / `observeSession`），或者从 `session/event` 事件流增量订阅。
本插件的宿主半因此把 `sessionQuery.readSession` 作为首选，`deriveMessages()` 只作为没有该服务时的降级。

**一次性模型调用的正确姿势**（照抄上游 auto-review 的写法）：

```ts
const stream = ctx.llm.stream({
  provider, model,               // 必填：注册过的路由
  system: PROMPT,
  messages: [{ role: 'user', content: [{ type: 'text', text: digest }] }],
  temperature: 0,
  maxTokens,
  signal,
})
// 流分片：block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish
// finish.reason.kind !== 'stop' 即失败（error / aborted / max-tokens …）
```

自己拼流时只需读 `text-delta` 与 `block-end`（文本块），并用 `finish` 判定终止；
上游 `BlockAssembler`（`packages/llm/llm/src/assembler.ts`）是参考实现。

**路由从哪来**：`GenerateOptions.provider/model` 是必填，没有「用当前模型」的隐式默认。
会话日志里的 `request/header` 事件（`data.header.config.{provider,model}`）记录了最近一次真实路由，
这是本插件「沿用会话模型」的依据；显式配置优先于它。

---

## 4. 浏览器侧扩展面：Slot

### 4.1 注册模型

```ts
export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: 'session-handoff',   // list 座位必填：你的 cell key
      order: 40,
    }, Component))
}
```

规则（`docs/subsystems/slots.zh.md`）：

- **cardinality**：`single`（一个 cell，优先级高者渲染）/ `list`（按 `id` 排列，`order` 升序）/ `keyed`（owner 传 key）/ `chain`（按 `select` 选举）。
- **scope**：`root` / `session-maybe` / `session`。`session` 座位保证 `sessionId` 存在。
- **owner 必须先声明**：座位由挂载中的 owner 组件在 `children` 里声明；owner 卸载则座位消失。
  所以注册一律用 `ctx.slots.inject(key, …)`，声明出现时自动注册、owner 重挂时重跑。
- **不要传 `priority`**：浏览器半的 facade 自动分配，且低于所有内置条目——在 single/keyed 里你就是赢家，
  在 list 里你只是新的一格。
- 组件拿不到 `ctx`，只拿 owner props + 标准 hooks（`useSession`、`useSessions`、`useWorkspaces`、`useProjection` …）
  + 注册项 `inject` factory 返回的数据与回调。

### 4.2 输入框座位全图

`conversation.input.*` 由 `InputBar`（`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`）渲染，
座位在 `contract/slots.ts` 声明，编译期契约汇总在 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`：

| 座位 | 基数/作用域 | 位置 | 现有占用者 |
|---|---|---|---|
| `conversation.input.left` | list/session | 工具行左侧（附件、计划、权限之后） | 空 |
| `conversation.input.right` | list/session | **提交按钮之前的右侧工具行** | **空** |
| `conversation.input.model` | single/session | 模型选择器 | `ModelSelect` |
| `conversation.input.activity` | single/session | 模型选择器与发送按钮之间的活动位（可展开占满工具栏） | `VoiceInput`（实验包） |
| `conversation.input.dock` | list/session | composer 卡片上方全宽区 | queue / todo / goal / 第三方 |
| `conversation.composer.dock` | list/session | composer 卡片下方环境条 | ActivityPill、UsagePill |
| `conversation.input.overlay` | list/session | composer 卡片内浮层 | 命令菜单、反馈弹窗 |
| `conversation.session.header.utilities` | list/session | 会话标题栏右侧实用按钮 | open-in-app、schedule、log-export… |

`InputBar.tsx:449-476` 的实际顺序是：

```text
[+] [权限] [计划] [input.left] …… [input.right] [model] [activity] [停止/发送]
```

也就是说：`conversation.input.right` 是**官方为空、语义明确为「发送动作之前的紧凑控件」的 list 座位**，
这是本插件放「接力」按钮的第一选择；`conversation.input.activity` 在视觉上更贴近发送键，但它是 single，
注册即遮蔽语音输入，而且 owner props 要求实现展开/收起语义，不适合常驻动作按钮。

### 4.3 样式与主题

浏览器半不能 import 设计系统组件，但可以用 CSS 变量（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-font-family` 等）
对齐原生外观；样式通过一次性 `<style>` 注入，跟随主题切换。既有插件的实践（`dsh-portal/src/client/ui.ts`）证明这条路径稳定。

---

## 5. 会话数据模型（读取侧）

- **事件日志**：append-only，`seq` 单调；`SessionEventMap` 声明类型，插件可合并扩展。
- **surface**：只有 `system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`
  进入模型可见历史；`tool/call`、`request/header`、`turn/*`、`step/*`、`compaction/*` 是 log-only。
- **派生**：`session.deriveMessages()` = surface → `Message[]`；离线读取用 `foldSurface(events, projections)`。
- **压缩**：`compaction/*` 只写日志；摘要以 `user/message` + `surfaceOp: replace` 进入 surface。
  压缩会改变 surface，但**不改写被遮蔽的原始日志**——这使「读原始日志做交接」始终可行。
- **fork**：`ctx.sessions.fork(source, boundary)` 复制到某 seq 的前缀，生成带 `parentSession` 的子会话。
  这是「继承历史」的官方原语，与本插件「只带结论」形成两种不同取舍。
- **只读查询**：`ctx.sessionQuery.readSession(id)` 返回 `{ session, events, inheritedEventCount }`，
  live 优先、归档可读、回放校验；`observeSession` 还能只要 surface。

对交接最有信息量的字段：`user/message.content`、`assistant/message.message.content`、
`tool/call.{name,arguments}`、`tool/result.{message.content,isError}`、`compaction/summary.summary`、
`request/header.header.config`。

---

## 6. 稳定性分级（本插件的依赖策略）

| 级别 | 定义 | 本插件用法 |
|---|---|---|
| A 公开契约 | 官方 `docs/` 有专页 + 生成的服务目录；第三方插件普遍使用 | `ctx.webServer`、`ctx.sessionQuery`、`ctx.llm`、`ctx.slots`、slot 座位名 |
| B 半公开 | 未为插件设计但稳定在用，升级需回归 | 浏览器半 `sessions.create/retain/prompt`（仅 `autoSend` 路径）、`uiWorkspace.startSession` |
| C 私有 | 类名/CSS/内部 DOM | **完全不用**（对比：某自研插件克隆 `button[class*="newSession"]`，升级即断） |

设计原则：**A 级能力完成主流程，B 级只做可选增强，C 级永不触碰**。
每条 B 级路径都必须有 A 级降级（见技术设计「降级矩阵」）。

---

## 7. 一个插件从加载到卸载

```text
profile 启动
  → Loader 读 package.json 的 patch，插入 entry
  → import lib/index.js → Cordis plugin（等待 inject 服务）→ apply(ctx, config)
      → ctx.webServer.register(...)     // 端点
      → ctx.effect(...)                 // 与 fiber 同生共死
  → ctx.clientModules 扫描到 dsh.client，组合 boot 图
  → 页面加载 /plugins/... 组合脚本 → __ModuleLoader__ 物化
  → 客户端 Cordis 插件 apply(ctx) → ctx.slots.inject(seat, register)
  → 组件渲染；点击 → fetch 宿主端点 → 打开新会话
禁用 bundle / 卸载 fiber
  → 宿主 disposer 撤销路由；客户端 entry 卸载 → 座位贡献随之移除（无需手工清理 DOM）
```

这也是为什么「给会话页加一个按钮」在 DSH 里是**一个座位注册**，而不是改前端源码：
会话页本身是组合出来的，任何位置都可以被插件声明或占用。

---

## 8. 对本插件的结论

1. **按钮放在 `conversation.input.right`**：官方 list 座位、当前为空、语义就是「提交前的紧凑控件」；
   父级 owner 是 `conversation.composer.bar` 的 InputBar，随 composer 生命周期自动挂载/卸载。
2. **总结放宿主半**：日志读取（`sessionQuery`）与模型调用（`llm`）都在宿主侧，浏览器半只做「点一下 + 打开新会话」。
3. **新会话由浏览器半创建**：`uiWorkspace.startSession(workspaceId?, { prompt })` 是官方导航服务，
   会处理工作区分组、空白会话复用与草稿初始化；宿主半不应该自己造 UI 状态。
4. **不写会话日志**：交接是「旁路产物」，写日志会污染模型上下文，也会让压缩/回放语义复杂化。
5. **所有产物落在工作目录**：`<cwd>/.dsh-handoff/…`，可被 Git、编辑器、下个会话的 Read 工具直接消费。

更细的接缝选择、协议、降级矩阵与成本估算，见 [03 技术设计](./03-技术设计.md)；
逐项可行性证据见 [04 可行性分析](./04-可行性分析.md)。
