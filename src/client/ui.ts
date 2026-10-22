/**
 * 浏览器半的样式与轻量反馈件（零第三方依赖，全部走 DSH 的 --dsw-* 变量）。
 *
 * 不 import 设计系统组件：动态包的 factory 只保证 React 基线，样式通过一次性
 * <style> 注入，跟随主题切换（token 由页面根注入）。
 *
 * @module dsh-session-handoff/client/ui
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactElement } from 'react'

export const CLS = {
  button: 'dsh-handoff-btn',
  spinner: 'dsh-handoff-spinner',
  toast: 'dsh-handoff-toast',
  toastError: 'dsh-handoff-toast-error',
} as const

const STYLE_ID = 'dsh-session-handoff-style'

const CSS = `
.${CLS.button} {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; flex: none;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.${CLS.button}:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.${CLS.button}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.${CLS.button}[data-busy="true"] { pointer-events: none; opacity: .7; }
.${CLS.button}[data-done="true"] { color: var(--dsw-alias-state-success-primary, #2f9e44); }
.${CLS.button}[data-error="true"] { color: var(--dsw-alias-state-error-primary, #e03131); }
.${CLS.spinner} {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor; animation: dsh-handoff-spin .7s linear infinite;
}
@keyframes dsh-handoff-spin { to { transform: rotate(360deg); } }
.${CLS.toast} {
  position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
  z-index: 2147483000; max-width: min(560px, 86vw);
  padding: 9px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5;
  font-family: var(--dsw-font-family, inherit);
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2, #1f1f22);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  box-shadow: var(--dsw-elevation-panel, 0 8px 28px rgba(0,0,0,.28));
  animation: dsh-handoff-in .16s ease-out;
}
.${CLS.toastError} { color: var(--dsw-alias-state-error-primary, #ff8787); }
@keyframes dsh-handoff-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
`

/** 幂等注入样式。 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

/** 一条 3.6s 自动消失的轻提示（不阻塞输入）。 */
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  if (typeof document === 'undefined') return
  ensureStyles()
  document.querySelectorAll(`.${CLS.toast}`).forEach(node => node.remove())
  const node = document.createElement('div')
  node.className = kind === 'error' ? `${CLS.toast} ${CLS.toastError}` : CLS.toast
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  node.textContent = text
  document.body.appendChild(node)
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.remove() }, 3_600)
}

/** 接力图标（方框 + 出栈箭头），语义：把当前会话搬到新会话。 */
export function handoffIcon(size = 16): ReactElement {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
  },
  h('path', { d: 'M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5' }),
  h('path', { d: 'M10 8l4 4-4 4' }),
  h('path', { d: 'M14 12H4' }))
}

/** 加载中的小转圈。 */
export function spinner(): ReactElement {
  return h('span', { className: CLS.spinner, 'aria-hidden': 'true' })
}

/**
 * 让按钮在「完成」态停留一秒再复位；返回当前态与触发器。
 * @param resetMs - 成功态停留时间。
 */
export function useDoneLatch(resetMs = 1_200): { done: boolean; error: boolean; succeed: () => void; fail: () => void } {
  const [done, setDone] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!done) return undefined
    const timer = setTimeout(() => { setDone(false) }, resetMs)
    return () => { clearTimeout(timer) }
  }, [done, resetMs])
  return {
    done,
    error,
    succeed: () => { setError(false); setDone(true) },
    fail: () => { setDone(false); setError(true) },
  }
}
