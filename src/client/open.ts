/**
 * 打开新会话：官方导航优先，半公开 sessions 能力只做可选增强。
 *
 * 与 v0.1 相同的三级降级：startSession（草稿）→ sessions.create+retain+prompt（发送）
 * → 抛错由调用方提示并复制提示词。
 *
 * @module dsh-session-handoff/client/open
 */

import type { SessionHint } from './types.ts'

interface ClientContextLike {
  get?(name: string, soft?: boolean): unknown
}

interface SessionFace {
  prompt?(content: unknown, mode?: string): Promise<{ ok?: boolean; error?: { message?: string } } | undefined>
}

interface RetainRef {
  ready?: Promise<unknown>
  binding?: { session?: SessionFace }
  release?(): void
}

interface SessionsFace {
  create?(options?: Record<string, unknown>): Promise<unknown>
  retain?(sessionId: string, options?: Record<string, unknown>): RetainRef
}

interface WorkspaceNavigationFace {
  startSession?(workspaceId: string | undefined, options?: { prompt?: string }): void
  openSession?(target: unknown): void
}

function softGet(ctx: ClientContextLike, name: string): unknown {
  if (typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name, false)
  } catch {
    return undefined
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function createOptions(hint: SessionHint): Record<string, unknown> {
  if (hint.workspaceId !== undefined) return { workspaceId: hint.workspaceId }
  if (hint.cwd !== undefined) return { cwd: hint.cwd }
  return {}
}

/** 通过 sessions.retain 拿到已绑定会话再入队一轮。 */
async function sendToSession(sessions: SessionsFace, sessionId: string, text: string): Promise<void> {
  if (typeof sessions.retain !== 'function') throw new Error('缺少 sessions.retain')
  const ref = sessions.retain(sessionId, { source: 'handoff' })
  try {
    await Promise.race([
      Promise.resolve(ref.ready).catch(() => undefined),
      new Promise((_, reject) => { setTimeout(() => reject(new Error('会话打开超时')), 10_000) }),
    ])
    const session = ref.binding?.session
    if (session === undefined || typeof session.prompt !== 'function') throw new Error('会话不可用')
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (result !== undefined && result.ok === false) throw new Error(result.error?.message ?? '发送失败')
  } finally {
    ref.release?.()
  }
}

/** 把提示词写进新会话；返回发送方式。 */
export async function openWithPrompt(
  ctx: ClientContextLike,
  promptText: string,
  autoSend: boolean,
  hint: SessionHint = {},
): Promise<'draft' | 'sent'> {
  const nav = softGet(ctx, 'uiWorkspace') as WorkspaceNavigationFace | undefined
  const sessions = softGet(ctx, 'sessions') as SessionsFace | undefined
  if (autoSend && sessions !== undefined && typeof sessions.create === 'function' && nav?.openSession !== undefined) {
    try {
      const created = await sessions.create(createOptions(hint))
      const sessionId = String(created ?? '')
      if (sessionId === '') throw new Error('sessions.create 未返回会话 id')
      await sendToSession(sessions, sessionId, promptText)
      nav.openSession(sessionId)
      return 'sent'
    } catch (cause) {
      // autoSend 是可选增强：失败就退回草稿，不把用户挡在错误里。
      console.warn(`[dsh-session-handoff] 自动发送失败，改为预填草稿：${errorMessage(cause)}`)
    }
  }
  if (nav !== undefined && typeof nav.startSession === 'function') {
    nav.startSession(hint.workspaceId, { prompt: promptText })
    return 'draft'
  }
  if (sessions !== undefined && typeof sessions.create === 'function') {
    const sessionId = String(await sessions.create(createOptions(hint)) ?? '')
    if (sessionId === '') throw new Error('sessions.create 未返回会话 id')
    await sendToSession(sessions, sessionId, promptText)
    nav?.openSession?.(sessionId)
    return 'sent'
  }
  throw new Error('当前 DSH 缺少创建会话的入口（uiWorkspace.startSession / sessions.create）')
}

/** 失败兜底：提示词进剪贴板，避免用户丢失摘要。 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    throw new Error('剪贴板不可用，请手动复制')
  }
}
