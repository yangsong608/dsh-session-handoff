/**
 * 会话接力的本地类型面。
 *
 * 这里刻意只声明「结构化最小集」，不 import 任何 @deepseek-ai/* 运行时模块：
 * 第三方插件的宿主半由 profile 的 loader 直接加载，只有 node 内置模块可用；
 * 借用 harness 的内部类型会让产物在别的 DSH 版本上加载即崩。字段来自
 * packages/core/session/src/types.ts 与 packages/llm/llm/src/types.ts 的公开形状。
 *
 * @module dsh-session-handoff/host/types
 */

/** 一个内容块（只关心文本；图片/工具调用块按类型忽略或单独计数）。 */
export interface ContentBlockLike {
  type: string
  text?: string
  [key: string]: unknown
}

/** 一条会话事件的最小形状。 */
export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data?: unknown
}

/** 会话头（sessionQuery.readSession / SessionHeader 的公开子集）。 */
export interface SessionHeaderLike {
  id: string
  title?: string
  cwd?: string
  createdAt?: number
  parentSession?: string
}

/** 一次完整日志观测。 */
export interface SessionLogSnapshotLike {
  session: SessionHeaderLike
  events: SessionEventLike[]
  inheritedEventCount?: number
}

/** 会话查询 seam（ctx.sessionQuery）的结构化子集。 */
export interface SessionQueryLike {
  readSession(sessionId: string): Promise<SessionLogSnapshotLike>
}

/** LLM 运行时（ctx.llm）的结构化子集。 */
export interface LlmRuntimeLike {
  stream(options: Record<string, unknown>): AsyncIterable<LlmStreamChunk>
}

/** 流分片（只关心文本与终止原因）。 */
export interface LlmStreamChunk {
  type: string
  index?: number
  text?: string
  block?: { type: string; text?: string }
  reason?: { kind: string; failure?: { code?: string; message?: string } }
}

/** 工具活动（用于确定性时间线与参考文件提取）。 */
export interface ToolFact {
  seq: number
  name: string
  callId: string
  /** 原始参数（截断）。 */
  argumentsExcerpt: string
  /** 从参数中识别出的文件路径。 */
  files: string[]
  /** 从参数中识别出的命令。 */
  commands: string[]
  /** 结果是否失败。 */
  failed: boolean
  /** 结果摘要（截断）。 */
  resultExcerpt: string
}

/** 确定性采集的事实集：LLM 不可用时也能独立生成交接文档。 */
export interface Facts {
  sessionId: string
  title: string
  cwd: string
  createdAt: number
  capturedAt: number
  eventCount: number
  /** 最近一次请求头解析出的模型路由。 */
  lastRoute?: { provider: string; model: string }
  /** 用户消息（source.kind === 'user'，按时间顺序）。 */
  userMessages: string[]
  /** 注入上下文消息（source.kind !== 'user'）。 */
  injectedMessages: string[]
  /** 助手正文（按时间顺序）。 */
  assistantTexts: string[]
  /** 工具活动（按时间顺序，受 maxToolCalls 限制）。 */
  tools: ToolFact[]
  /** 变更过或引用过的文件路径（去重，按首次出现顺序）。 */
  files: string[]
  /** 执行过的命令（去重，按首次出现顺序）。 */
  commands: string[]
  /** 失败的工具结果摘要。 */
  failures: string[]
  /** 压缩摘要（若会话被压缩过）。 */
  compactionSummaries: string[]
  /** 采集阶段的降级标记。 */
  degraded: string[]
}

/** LLM 归纳出的结构化交接内容（受 JSON 协议约束）。 */
export interface HandoffData {
  title: string
  summary: string
  goal: string
  completed: string[]
  decisions: { decision: string; rationale: string }[]
  state: { current: string; files: string[]; blockers: string[] }
  nextSteps: { step: string; why: string }[]
  memoryCandidates: { text: string; scope: 'memory' | 'user' | 'project' }[]
}

/** 新会话提示词的结构化分段（服务端与浏览器半共享同一形状）。 */
export interface PromptParts {
  title: string
  sessionId: string
  docPath: string
  dataPath: string
  summary: string
  goal: string
  completed: string[]
  nextSteps: { step: string; why: string }[]
  blockers: string[]
  /** 默认勾选的参考文件。 */
  references: string[]
  /** 全部候选参考文件。 */
  referenceOptions: string[]
  requirements: string[]
}

/** 一次 prepare 的结果。 */
export interface HandoffResult {
  ok: true
  sessionId: string
  title: string
  promptText: string
  promptParts: PromptParts
  /** 浏览器半是否先展示可编辑预览（false = v0.1 直接草稿/发送）。 */
  preview: boolean
  markdown: string
  data: HandoffData
  docPath: string
  dataPath: string
  memoryPath?: string
  memoryCandidates: HandoffData['memoryCandidates']
  /** 浏览器半据此决定「预填草稿」还是「直接发送」。 */
  autoSend: boolean
  degraded: string[]
  stats: {
    events: number
    toolCalls: number
    files: number
    chars: number
    llm: boolean
    model?: string
    durationMs: number
  }
}
