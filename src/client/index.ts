/**
 * dsh-session-handoff 浏览器半：在输入框右侧工具行、提交按钮之前放一个「接力」按钮。
 *
 * 一次点击完成：请求宿主生成交接包 → 在（同一工作区的）新会话里预填交接提示词
 * → 打开新会话。默认是「预填草稿」，用户可以在发送前审阅；配置 autoSend 时
 * 走 sessions.retain + prompt 直接发出（能力缺失会自动回退到草稿）。
 *
 * 座位：conversation.input.right（list / session，注册前为空）。若该座位在某个
 * DSH 版本被移除，退回 conversation.session.header.utilities；两者都没有时插件
 * 的浏览器半保持静默（宿主能力仍可用）。
 *
 * @module dsh-session-handoff/client
 */

import { createElement as h, useCallback, useState } from 'react'

import { CLS, ensureStyles, handoffIcon, spinner, toast, useDoneLatch } from './ui.ts'

const NS = 'handoff'
const API_PREPARE = '/session-handoff/prepare'

/** 浏览器半只要求 slots；其余服务按可选读取。 */
export const inject = ['slots']

interface SlotOption { id?: string; order?: number }
interface SlotEntryLike { options: SlotOption }
interface SlotsFace {
  inject(key: string, contribute: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
  entries(slot: string): SlotEntryLike[]
}

interface ClientContextLike {
  slots: SlotsFace
  effect?(callback: () => unknown, label?: string): unknown
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

/** 组件拿到的注入面：一次点击的全部副作用。 */
interface HandoffInjectedFace {
  run(sessionId: string): Promise<{ title: string; mode: 'draft' | 'sent' }>
}

interface HandoffButtonProps {
  sessionId?: string
  t?: (key: string) => string
  run?: HandoffInjectedFace['run']
}

const ZH: Record<string, string> = {
  'action.label': '接力到新会话',
  'action.aria': '总结当前会话并打开新会话继续',
  'action.busy': '正在整理交接…',
  'toast.draft': '已生成交接文档，新会话已预填提示词：',
  'toast.sent': '已生成交接文档并发送到新会话：',
  'toast.failed': '会话接力失败：',
  'toast.no-session': '没有可接力的会话',
}

const EN: Record<string, string> = {
  'action.label': 'Hand off to a new session',
  'action.aria': 'Summarize this session and continue in a new one',
  'action.busy': 'Preparing handoff…',
  'toast.draft': 'Handoff written; the new session is prefilled: ',
  'toast.sent': 'Handoff written and sent to the new session: ',
  'toast.failed': 'Handoff failed: ',
  'toast.no-session': 'No session to hand off',
}

function detectLanguage(): 'zh' | 'en' {
  const language = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '')
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
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

/** 把交接提示词写进新会话；返回发送方式。 */
async function openWithPrompt(
  ctx: ClientContextLike,
  promptText: string,
  autoSend: boolean,
): Promise<'draft' | 'sent'> {
  const nav = softGet(ctx, 'uiWorkspace') as WorkspaceNavigationFace | undefined
  const sessions = softGet(ctx, 'sessions') as SessionsFace | undefined
  if (autoSend && sessions !== undefined && typeof sessions.create === 'function' && nav?.openSession !== undefined) {
    try {
      const created = await sessions.create({})
      const sessionId = String(created ?? '')
      if (sessionId === '') throw new Error('sessions.create 未返回会话 id')
      await sendToSession(sessions, sessionId, promptText)
      nav.openSession(sessionId)
      return 'sent'
    } catch (cause) {
      // autoSend 是可选增强：失败就退回草稿，不把用户挡在错误里。
      toast(`自动发送失败，改为预填草稿（${errorMessage(cause)}）`, 'error')
    }
  }
  if (nav !== undefined && typeof nav.startSession === 'function') {
    nav.startSession(undefined, { prompt: promptText })
    return 'draft'
  }
  if (sessions !== undefined && typeof sessions.create === 'function') {
    const sessionId = String(await sessions.create({}) ?? '')
    if (sessionId === '') throw new Error('sessions.create 未返回会话 id')
    await sendToSession(sessions, sessionId, promptText)
    const open = (softGet(ctx, 'uiWorkspace') as WorkspaceNavigationFace | undefined)?.openSession
    open?.(sessionId)
    return 'sent'
  }
  throw new Error('当前 DSH 缺少创建会话的入口（uiWorkspace.startSession / sessions.create）')
}

/** 通过 sessions.retain 拿到已绑定会话再入队一轮（能力缺失时抛出）。 */
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

/** 请求宿主生成交接包，并打开新会话。 */
async function requestHandoff(ctx: ClientContextLike, sessionId: string): Promise<{ title: string; mode: 'draft' | 'sent' }> {
  const response = await fetch(API_PREPARE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-handoff': '1' },
    body: JSON.stringify({ sessionId }),
  })
  const body = await response.json().catch(() => undefined) as
    | { ok?: boolean; message?: string; promptText?: string; title?: string; autoSend?: boolean }
    | undefined
  if (!response.ok || body === undefined || body.ok !== true || typeof body.promptText !== 'string') {
    const detail = body?.message ?? `HTTP ${response.status}`
    if (response.status === 404) throw new Error(`${detail}（宿主端点未注册：确认插件宿主半已启用）`)
    throw new Error(detail)
  }
  const mode = await openWithPrompt(ctx, body.promptText, body.autoSend === true)
  return { title: typeof body.title === 'string' ? body.title : '会话交接', mode }
}

/** 按钮：紧凑图标 + 悬停说明；生成中显示转圈，完成态短暂打勾变绿。 */
function HandoffButton({ sessionId, t, run }: HandoffButtonProps): unknown {
  const [busy, setBusy] = useState(false)
  const latch = useDoneLatch()
  const text = useCallback((key: string): string => {
    const translated = typeof t === 'function' ? t(key) : undefined
    if (typeof translated === 'string' && translated !== '' && translated !== key) return translated
    return (detectLanguage() === 'zh' ? ZH : EN)[key] ?? key
  }, [t])

  const onClick = useCallback((): void => {
    if (busy || sessionId === undefined) return
    setBusy(true)
    void (async () => {
      try {
        if (run === undefined) throw new Error('注入面缺失')
        const result = await run(sessionId)
        latch.succeed()
        toast(`${text(result.mode === 'sent' ? 'toast.sent' : 'toast.draft')}${result.title}`)
      } catch (cause) {
        latch.fail()
        toast(`${text('toast.failed')}${errorMessage(cause)}`, 'error')
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, latch, run, sessionId, text])

  const title = busy ? text('action.busy') : text('action.label')
  return h('button', {
    type: 'button',
    className: CLS.button,
    title,
    'aria-label': text('action.aria'),
    'aria-busy': busy,
    'data-busy': String(busy),
    'data-done': String(latch.done),
    'data-error': String(latch.error),
    disabled: busy,
    onClick,
    onMouseDown: (event: { preventDefault?(): void }) => { event.preventDefault?.() },
  }, busy ? spinner() : handoffIcon(16))
}

/** 注册按钮座位；返回是否成功。 */
function registerButton(ctx: ClientContextLike, canLocale: boolean, run: HandoffInjectedFace['run']): boolean {
  const options: Record<string, unknown> = {
    name: 'conversation.input.right',
    id: 'session-handoff',
    order: 40,
    ...(canLocale ? { locale: NS } : {}),
    inject: () => ({ run }),
  }
  const seats = ['conversation.input.right', 'conversation.session.header.utilities']
  for (const seat of seats) {
    try {
      ctx.slots.inject(seat, () => ctx.slots.register(
        seat === 'conversation.input.right' ? options : { ...options, name: seat },
        HandoffButton,
      ))
      return true
    } catch (cause) {
      console.warn(`[dsh-session-handoff] 座位 ${seat} 不可用：${errorMessage(cause)}`)
    }
  }
  return false
}

/** 插件入口。 */
export function apply(ctx: ClientContextLike): void {
  ensureStyles()
  const run: HandoffInjectedFace['run'] = sessionId => requestHandoff(ctx, sessionId)
  const locale = softGet(ctx, 'locale') as { register?(namespace: string, dictionaries: Record<string, unknown>): unknown } | undefined
  const canLocale = locale !== undefined && typeof locale.register === 'function' && typeof ctx.effect === 'function'
  if (canLocale && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => (locale as { register(n: string, d: Record<string, unknown>): unknown }).register(NS, { zh: ZH, en: EN }), 'dsh-session-handoff: dictionaries')
    } catch (cause) {
      console.warn(`[dsh-session-handoff] 词典注册失败，使用内置文案：${errorMessage(cause)}`)
    }
  }
  const registered = registerButton(ctx, canLocale, run)
  console.log(`[dsh-session-handoff] 浏览器半已加载（按钮座位${registered ? '已注册' : '未找到，保持静默'}）`)
}

/** 供测试/二次开发引用：内部座位 id。 */
export const SEAT_ID = 'session-handoff'
