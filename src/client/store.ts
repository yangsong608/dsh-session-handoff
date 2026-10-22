/**
 * 会话级预览状态：按钮、预览卡与快捷键共享的极简可观察存储。
 *
 * 故意不引入 client-store：模块级单例足够，且与 React 解耦，
 * SSR/冒烟测试里也能直接驱动。
 *
 * @module dsh-session-handoff/client/store
 */

import type { PreviewState, SessionHint } from './types.ts'

let state: PreviewState = { phase: 'idle' }
const listeners = new Set<() => void>()

/** 预览状态存储（getSnapshot 必须返回稳定引用，状态变化时整体替换）。 */
export const previewStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getState(): PreviewState {
    return state
  },
  set(next: PreviewState): void {
    state = next
    for (const listener of listeners) listener()
  },
  idle(): void {
    previewStore.set({ phase: 'idle' })
  },
}

/** 最近一次渲染过的会话（快捷键在没有渲染上下文时用它定位目标）。 */
let active: { sessionId: string; hint: SessionHint } | undefined

/** 当前活跃会话与落点提示。 */
export const activeSession = {
  get(): { sessionId: string; hint: SessionHint } | undefined {
    return active
  },
  set(sessionId: string, hint: SessionHint): void {
    active = { sessionId, hint }
  },
  clear(): void {
    active = undefined
  },
}
