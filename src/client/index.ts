/**
 * dsh-session-handoff 浏览器半入口。
 *
 * 三个入口共用一条链路：
 *   1. 输入框右侧「接力」按钮（conversation.input.right）
 *   2. 快捷键 Cmd/Ctrl+Shift+H（ctx.shortcuts）
 *   3. 生成后的可编辑预览卡（shell.overlay）
 *
 * 链路：请求宿主生成交接包 → 默认打开预览卡（可编辑提示词/勾选参考文件）→
 * 用户确认后打开同工作区新会话；`preview: false` 时退回 v0.1 的直接草稿/发送。
 *
 * @module dsh-session-handoff/client
 */

import { createElement as h, useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import { openWithPrompt, copyText } from './open.ts'
import { PreviewCard } from './preview.ts'
import { activeSession, previewStore } from './store.ts'
import { CLS, ensureStyles, handoffIcon, spinner, toast, useDoneLatch } from './ui.ts'
import type { PreviewPayload, SessionHint } from './types.ts'

const NS = 'handoff'
const API_PREPARE = '/session-handoff/prepare'

/** 浏览器半只要求 slots；其余服务按可选读取。 */
export const inject = ['slots']

interface SlotsFace {
  inject(key: string, contribute: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
  entries(slot: string): unknown[]
}

interface ShortcutsFace {
  register(command: Record<string, unknown>): () => void
}

interface ClientContextLike {
  slots: SlotsFace
  shortcuts?: ShortcutsFace
  effect?(callback: () => unknown, label?: string): unknown
  get?(name: string, soft?: boolean): unknown
}

interface SnapshotHook {
  (selector: (snapshot: any) => unknown): unknown
}

interface HandoffButtonProps {
  sessionId?: string
  t?: (key: string) => string
  run?: (sessionId: string, hint?: SessionHint) => Promise<{ mode: 'preview' | 'draft' | 'sent' }>
  useWorkspaces?: SnapshotHook
  useSession?: SnapshotHook
}

const ZH: Record<string, string> = {
  'action.label': '接力到新会话',
  'action.aria': '总结当前会话并打开新会话继续',
  'action.busy': '正在整理交接…',
  'toast.preview': '已生成交接预览，确认后打开新会话',
  'toast.draft': '已生成交接文档，新会话已预填提示词：',
  'toast.sent': '已生成交接文档并发送到新会话：',
  'toast.failed': '会话接力失败：',
  'shortcut.label': '会话接力',
}

const EN: Record<string, string> = {
  'action.label': 'Hand off to a new session',
  'action.aria': 'Summarize this session and continue in a new one',
  'action.busy': 'Preparing handoff…',
  'toast.preview': 'Handoff preview ready — confirm to open a new session',
  'toast.draft': 'Handoff written; the new session is prefilled: ',
  'toast.sent': 'Handoff written and sent to the new session: ',
  'toast.failed': 'Handoff failed: ',
  'shortcut.label': 'Session handoff',
}

function language(): 'zh' | 'en' {
  const value = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '')
  return value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function softGet(ctx: ClientContextLike, name: string): unknown {
  if (typeof ctx.get === 'function') {
    try {
      const resolved = ctx.get(name, false)
      if (resolved !== undefined && resolved !== null) return resolved
    } catch {
      // 落在下面的直读兜底
    }
  }
  // 兜底：普通对象 ctx（冒烟脚本、旧版宿主）没有严格代理，可直接读属性。
  // 在 cordis 4 的插件作用域里这一句会抛 `cannot get property "..." without inject`，被 catch 吞掉。
  try {
    return (ctx as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** shell.overlay 是否可用；不可用时预览退化为 v0.1 的直接打开。 */
let overlayAvailable = false

/** 请求宿主生成交接包（不打开会话）。 */
async function preparePayload(sessionId: string, hint: SessionHint = {}): Promise<{ payload: PreviewPayload; preview: boolean }> {
  const response = await fetch(API_PREPARE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-handoff': '1' },
    body: JSON.stringify({ sessionId }),
  })
  const body = await response.json().catch(() => undefined) as
    | {
      ok?: boolean
      message?: string
      promptText?: string
      promptParts?: PreviewPayload['promptParts']
      title?: string
      docPath?: string
      dataPath?: string
      memoryPath?: string
      memoryCandidates?: PreviewPayload['memoryCandidates']
      degraded?: string[]
      autoSend?: boolean
      preview?: boolean
    }
    | undefined
  if (!response.ok || body === undefined || body.ok !== true) {
    const detail = body?.message ?? `HTTP ${response.status}`
    if (response.status === 404) throw new Error(`${detail}（宿主端点未注册：确认插件宿主半已启用）`)
    throw new Error(detail)
  }
  if (typeof body.promptText !== 'string' || body.promptParts === undefined) {
    throw new Error('宿主返回缺少 promptParts/promptText（插件宿主半与浏览器半版本不匹配？）')
  }
  return {
    preview: body.preview !== false,
    payload: {
      sessionId,
      title: typeof body.title === 'string' ? body.title : '会话交接',
      promptText: body.promptText,
      promptParts: body.promptParts,
      docPath: typeof body.docPath === 'string' ? body.docPath : '',
      dataPath: typeof body.dataPath === 'string' ? body.dataPath : '',
      ...(typeof body.memoryPath === 'string' ? { memoryPath: body.memoryPath } : {}),
      memoryCandidates: Array.isArray(body.memoryCandidates) ? body.memoryCandidates : [],
      degraded: Array.isArray(body.degraded) ? body.degraded : [],
      autoSend: body.autoSend === true,
      hint,
    },
  }
}

/** 生成 → 预览 / 直接打开；返回最终方式。 */
async function trigger(ctx: ClientContextLike, sessionId: string, hint: SessionHint = {}): Promise<{ mode: 'preview' | 'draft' | 'sent' }> {
  previewStore.set({ phase: 'preparing' })
  try {
    const { payload, preview } = await preparePayload(sessionId, hint)
    if (preview && overlayAvailable) {
      previewStore.set({ phase: 'ready', payload })
      return { mode: 'preview' }
    }
    const mode = await openWithPrompt(ctx, payload.promptText, payload.autoSend, hint)
    previewStore.idle()
    return { mode }
  } catch (cause) {
    previewStore.idle()
    throw cause
  }
}

/** 按钮：紧凑图标 + 悬停说明；生成中显示转圈，完成态短暂打勾变绿。 */
function HandoffButton({ sessionId, t, run, useWorkspaces, useSession }: HandoffButtonProps): unknown {
  const state = useSyncExternalStore(previewStore.subscribe, previewStore.getState, previewStore.getState)
  const latch = useDoneLatch()
  const workspaceId = typeof useWorkspaces === 'function'
    ? useWorkspaces(snapshot => {
      const items = Array.isArray(snapshot?.items) ? snapshot.items as Array<{ workspaceId?: string; sessionIds?: string[] }> : []
      for (const item of items) {
        if (Array.isArray(item.sessionIds) && sessionId !== undefined && item.sessionIds.includes(sessionId)) return item.workspaceId
      }
      return undefined
    })
    : undefined
  const cwd = typeof useSession === 'function' ? useSession(snapshot => typeof snapshot?.cwd === 'string' ? snapshot.cwd : undefined) : undefined
  const hint: SessionHint = {
    ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
  }

  // 快捷键在没有渲染上下文时也要有目标：把最近渲染的会话记下来。
  useEffect(() => {
    if (sessionId !== undefined) activeSession.set(sessionId, hint)
  }, [sessionId, hint.workspaceId, hint.cwd])

  const text = useCallback((key: string): string => {
    const translated = typeof t === 'function' ? t(key) : undefined
    if (typeof translated === 'string' && translated !== '' && translated !== key) return translated
    return (language() === 'zh' ? ZH : EN)[key] ?? key
  }, [t])

  const busy = state.phase === 'preparing'
  const onClick = useCallback((): void => {
    if (busy || sessionId === undefined || run === undefined) return
    void (async () => {
      try {
        const result = await run(sessionId, hint)
        latch.succeed()
        if (result.mode === 'preview') {
          const current = previewStore.getState()
          toast(`${text('toast.preview')}${current.phase === 'ready' ? `：${current.payload.title}` : ''}`)
        }
        else if (result.mode === 'sent') toast(text('toast.sent'))
        else toast(text('toast.draft'))
      } catch (cause) {
        latch.fail()
        toast(`${text('toast.failed')}${errorMessage(cause)}`, 'error')
      }
    })()
  }, [busy, hint, latch, run, sessionId, text])

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
function registerButton(ctx: ClientContextLike, canLocale: boolean, run: NonNullable<HandoffButtonProps['run']>): boolean {
  const seats = ['conversation.input.right', 'conversation.session.header.utilities']
  for (const seat of seats) {
    try {
      ctx.slots.inject(seat, () => {
        try {
          return ctx.slots.register({
            name: seat,
            id: 'dsh-session-handoff',
            order: 40,
            ...(canLocale ? { locale: NS } : {}),
            inject: () => ({ run }),
          }, HandoffButton)
        } catch (cause) {
          // 唯一 id 冲突/重复注册只应让本按钮缺席，不能影响同座位的其他插件。
          console.warn(`[dsh-session-handoff] 按钮注册失败（其他条目不受影响）：${errorMessage(cause)}`)
          return undefined
        }
      })
      return true
    } catch (cause) {
      console.warn(`[dsh-session-handoff] 座位 ${seat} 不可用：${errorMessage(cause)}`)
    }
  }
  return false
}

/** 注册预览卡（root 作用域的 shell.overlay）。 */
function registerPreview(ctx: ClientContextLike): boolean {
  const face = {
    open: async (prompt: string): Promise<'draft' | 'sent'> => {
      const state = previewStore.getState()
      if (state.phase !== 'ready') throw new Error('没有待确认的交接预览')
      return await openWithPrompt(ctx, prompt, state.payload.autoSend, state.payload.hint)
    },
    regenerate: async (): Promise<void> => {
      const state = previewStore.getState()
      if (state.phase !== 'ready') return
      await trigger(ctx, state.payload.sessionId, state.payload.hint)
    },
    copy: copyText,
    close: () => { previewStore.idle() },
  }
  try {
    ctx.slots.inject('shell.overlay', () => {
      try {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-handoff-preview',
          order: 900,
          inject: () => face,
        }, PreviewCard)
      } catch (cause) {
        console.warn(`[dsh-session-handoff] 预览卡注册失败（其他条目不受影响）：${errorMessage(cause)}`)
        return undefined
      }
    })
    return true
  } catch (cause) {
    console.warn(`[dsh-session-handoff] 预览座位 shell.overlay 不可用：${errorMessage(cause)}`)
    return false
  }
}

/** 注册快捷键：Cmd/Ctrl+Shift+H。 */
function registerShortcut(ctx: ClientContextLike): boolean {
  // shortcuts 是可选能力，必须在 inject 之外软读取：cordis 4 的插件作用域是严格代理，
  // 直读未声明 inject 的服务名会抛 `cannot get property "shortcuts" without inject`。
  const shortcuts = softGet(ctx, 'shortcuts') as ShortcutsFace | undefined
  if (shortcuts === undefined || typeof shortcuts.register !== 'function' || typeof ctx.effect !== 'function') return false
  const modifiers = ['primary', 'shift'] as const
  const command = {
    id: 'session.handoff',
    label: () => (language() === 'zh' ? ZH['shortcut.label'] : EN['shortcut.label']),
    aliases: ['handoff', 'session handoff', '会话接力', '新会话接力'],
    defaults: {
      // DSH 的键位校验把 primary+KeyH 视为保留组合（桌面 Linux 与全部 Web Linux），
      // 因此 Linux 档改用 primary+shift+Period；其余平台保持 Cmd/Ctrl+Shift+H。
      'desktop:macos': { code: 'KeyH', modifiers },
      'desktop:windows': { code: 'KeyH', modifiers },
      'desktop:linux': { code: 'Period', modifiers },
      'web:macos': { code: 'KeyH', modifiers },
      'web:windows': { code: 'KeyH', modifiers },
      'web:linux': { code: 'Period', modifiers },
    },
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => {
      const active = activeSession.get()
      if (active === undefined) return { status: 'blocked', reason: language() === 'zh' ? '没有可接力的会话' : 'No session to hand off' }
      return {
        status: 'handled',
        run: () => {
          void trigger(ctx, active.sessionId, active.hint).catch((cause: unknown) => {
            toast(`${language() === 'zh' ? ZH['toast.failed'] : EN['toast.failed']}${errorMessage(cause)}`, 'error')
          })
        },
      }
    },
  }
  try {
    ctx.effect(() => shortcuts.register(command), 'dsh-session-handoff: shortcut')
    return true
  } catch (cause) {
    console.warn(`[dsh-session-handoff] 快捷键注册失败：${errorMessage(cause)}`)
    return false
  }
}

/** 插件入口。 */
export function apply(ctx: ClientContextLike): void {
  ensureStyles()
  overlayAvailable = registerPreview(ctx)
  const run: NonNullable<HandoffButtonProps['run']> = (sessionId, hint) => trigger(ctx, sessionId, hint)
  registerShortcut(ctx)
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
  console.log(`[dsh-session-handoff] 浏览器半已加载（按钮${registered ? '已注册' : '未找到'}；预览${overlayAvailable ? '可用' : '不可用，退回直接打开'}）`)
}

/** 供测试/二次开发引用：内部座位 id。 */
export const SEAT_ID = 'dsh-session-handoff'

/** 提示词组装（与服务端逐字一致，parity 测试使用）。 */
export { composePrompt } from './compose.ts'

/** 测试用只读探针（不参与运行时 UI）。 */
export const __testing = { previewStore, activeSession, trigger }
