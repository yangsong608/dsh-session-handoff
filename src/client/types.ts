/**
 * 浏览器半的共享类型：提示词分段、预览载荷与会话目标提示。
 *
 * 与服务端 `src/host/types.ts` 的 PromptParts 保持同形；一致性由
 * `scripts/smoke-parity.mjs` 对同一 payload 逐字比较兜底。
 *
 * @module dsh-session-handoff/client/types
 */

/** 新会话提示词的结构化分段。 */
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
  references: string[]
  referenceOptions: string[]
  requirements: string[]
}

/** 记忆候选（预览里展示，已由服务端写入台账）。 */
export interface MemoryCandidate {
  text: string
  scope: 'memory' | 'user' | 'project'
}

/** 新会话落点提示。 */
export interface SessionHint {
  workspaceId?: string
  cwd?: string
}

/** 一次交接生成的完整预览载荷。 */
export interface PreviewPayload {
  sessionId: string
  title: string
  promptText: string
  promptParts: PromptParts
  docPath: string
  dataPath: string
  memoryPath?: string
  memoryCandidates: MemoryCandidate[]
  degraded: string[]
  autoSend: boolean
  hint: SessionHint
}

/** 预览卡状态机。 */
export type PreviewState =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | { phase: 'ready'; payload: PreviewPayload }
