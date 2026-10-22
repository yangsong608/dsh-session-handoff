/**
 * 可编辑预览卡：生成后先让用户看一眼、改一改，再打开新会话。
 *
 * 挂在 root 作用域的 `shell.overlay`（list，点击穿透，条目自行接管指针事件），
 * 所以它不属于某个会话、不会被 composer 裁切；当前会话身份来自预览载荷。
 *
 * @module dsh-session-handoff/client/preview
 */

import { createElement as h, useCallback, useEffect, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'

import { composePrompt } from './compose.ts'
import { previewStore } from './store.ts'
import { CLS, spinner, toast } from './ui.ts'
import type { PreviewPayload } from './types.ts'

/** 预览卡注入面。 */
export interface PreviewInjectedFace {
  open(prompt: string): Promise<'draft' | 'sent'>
  regenerate(): Promise<void>
  copy(text: string): Promise<void>
  close(): void
}

/** 预览卡组件 props（t 可选，缺失时用内置中英文案）。 */
export interface PreviewCardProps {
  t?: (key: string) => string
  open?: PreviewInjectedFace['open']
  regenerate?: PreviewInjectedFace['regenerate']
  copy?: PreviewInjectedFace['copy']
  close?: PreviewInjectedFace['close']
}

const ZH: Record<string, string> = {
  'preview.title': '会话交接预览',
  'preview.summary': '一句话状态',
  'preview.next': '下一步',
  'preview.memory': '记忆候选（已写入交接记忆台账）',
  'preview.docs': '交接文档',
  'preview.prompt': '发往新会话的提示词（可编辑）',
  'preview.refs': '参考文件（勾选后重建提示词；手动编辑后锁定）',
  'preview.refsLocked': '提示词已手动编辑，参考文件勾选已锁定；如需调整请重新生成。',
  'preview.open': '打开新会话',
  'preview.copy': '复制提示词',
  'preview.regen': '重新生成',
  'preview.close': '关闭',
  'preview.opening': '正在打开…',
  'preview.regenerating': '正在重新生成…',
  'preview.copied': '提示词已复制',
  'preview.copyPath': '复制文档路径',
  'preview.pathCopied': '文档路径已复制',
  'preview.degraded': '降级生成：',
  'preview.emptyRefs': '（没有识别到参考文件）',
  'preview.sent': '已发送到新会话：',
  'preview.draft': '已在新会话预填提示词：',
  'preview.failed': '打开新会话失败：',
}

const EN: Record<string, string> = {
  'preview.title': 'Session handoff preview',
  'preview.summary': 'Status',
  'preview.next': 'Next steps',
  'preview.memory': 'Memory candidates (written to the handoff ledger)',
  'preview.docs': 'Handoff document',
  'preview.prompt': 'Prompt for the new session (editable)',
  'preview.refs': 'Reference files (rebuilds the prompt; locked after manual edits)',
  'preview.refsLocked': 'The prompt was edited manually, so reference toggles are locked. Regenerate to change them.',
  'preview.open': 'Open new session',
  'preview.copy': 'Copy prompt',
  'preview.regen': 'Regenerate',
  'preview.close': 'Close',
  'preview.opening': 'Opening…',
  'preview.regenerating': 'Regenerating…',
  'preview.copied': 'Prompt copied',
  'preview.copyPath': 'Copy document path',
  'preview.pathCopied': 'Document path copied',
  'preview.degraded': 'Degraded output: ',
  'preview.emptyRefs': '(no reference files detected)',
  'preview.sent': 'Sent to the new session: ',
  'preview.draft': 'Prefilled the new session: ',
  'preview.failed': 'Failed to open a new session: ',
}

function language(): 'zh' | 'en' {
  const value = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '')
  return value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 可编辑预览卡；没有载荷时渲染 null。 */
export function PreviewCard({ t, open, regenerate, copy, close }: PreviewCardProps): unknown {
  const state = useSyncExternalStore(previewStore.subscribe, previewStore.getState, previewStore.getState)
  const payload: PreviewPayload | undefined = state.phase === 'ready' ? state.payload : undefined
  const [prompt, setPrompt] = useState('')
  const [refs, setRefs] = useState<string[]>([])
  const [edited, setEdited] = useState(false)
  const [busy, setBusy] = useState<'open' | 'regen' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (payload === undefined) return
    setPrompt(payload.promptText)
    setRefs([...payload.promptParts.references])
    setEdited(false)
    setError('')
  }, [payload])

  const requestClose = useCallback((): void => {
    if (busy !== null) return
    close?.()
  }, [busy, close])

  useEffect(() => {
    if (payload === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [payload, requestClose])

  const text = useCallback((key: string): string => {
    const translated = typeof t === 'function' ? t(key) : undefined
    if (typeof translated === 'string' && translated !== '' && translated !== key) return translated
    return (language() === 'zh' ? ZH : EN)[key] ?? key
  }, [t])

  if (payload === undefined) return null

  const toggleRef = (file: string): void => {
    if (edited) return
    const set = new Set(refs)
    if (set.has(file)) set.delete(file)
    else set.add(file)
    const next = payload.promptParts.referenceOptions.filter(option => set.has(option))
    setRefs(next)
    setPrompt(composePrompt(payload.promptParts, next))
  }

  const onOpen = async (): Promise<void> => {
    if (busy !== null || open === undefined) return
    setBusy('open')
    setError('')
    try {
      const mode = await open(prompt)
      toast(`${text(mode === 'sent' ? 'preview.sent' : 'preview.draft')}${payload.title}`)
      close?.()
    } catch (cause) {
      setError(`${text('preview.failed')}${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const onRegenerate = async (): Promise<void> => {
    if (busy !== null || regenerate === undefined) return
    setBusy('regen')
    setError('')
    try {
      await regenerate()
    } catch (cause) {
      setError(`${text('preview.failed')}${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const onCopy = async (value: string, doneKey: string): Promise<void> => {
    try {
      if (copy !== undefined) await copy(value)
      toast(text(doneKey))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const header = h('div', { className: CLS.cardHead },
    h('h2', null, payload.title),
    h('span', { className: CLS.meta }, payload.sessionId),
    h('button', { type: 'button', className: CLS.action, onClick: requestClose, disabled: busy !== null, title: text('preview.close') }, '✕'))

  const bodyChildren: ReactNode[] = [
    h('div', { key: 'summary', className: CLS.summary }, payload.promptParts.summary),
    payload.promptParts.nextSteps.length > 0
      ? h('div', { key: 'next' },
        h('div', { className: CLS.label }, text('preview.next')),
        h('ol', { className: CLS.candidates },
          payload.promptParts.nextSteps.slice(0, 6).map((step, index) => h('li', { key: index }, step.step))))
      : null,
    payload.memoryCandidates.length > 0
      ? h('div', { key: 'memory' },
        h('div', { className: CLS.label }, text('preview.memory')),
        h('ul', { className: CLS.candidates },
          payload.memoryCandidates.map((candidate, index) => h('li', { key: index }, `[${candidate.scope}] ${candidate.text}`))))
      : null,
    h('div', { key: 'docs' },
      h('div', { className: CLS.label }, text('preview.docs')),
      h('div', { className: CLS.meta }, payload.docPath),
      h('button', {
        type: 'button', className: CLS.action,
        onClick: () => { void onCopy(payload.docPath, 'preview.pathCopied') },
      }, text('preview.copyPath'))),
    payload.degraded.length > 0
      ? h('div', { key: 'degraded', className: CLS.meta }, `${text('preview.degraded')}${payload.degraded.join('; ')}`)
      : null,
    h('div', { key: 'prompt' },
      h('div', { className: CLS.label }, text('preview.prompt')),
      h('textarea', {
        className: CLS.prompt,
        value: prompt,
        spellCheck: false,
        onChange: (event: { target: { value: string } }) => { setPrompt(event.target.value); setEdited(true) },
      })),
    h('div', { key: 'refs' },
      h('div', { className: CLS.label }, text('preview.refs')),
      edited ? h('div', { className: CLS.meta }, text('preview.refsLocked')) : null,
      payload.promptParts.referenceOptions.length === 0
        ? h('div', { className: CLS.meta }, text('preview.emptyRefs'))
        : h('div', { className: CLS.refs },
          payload.promptParts.referenceOptions.map(file => h('label', {
            key: file,
            className: CLS.ref,
            'data-disabled': String(edited),
          },
          h('input', {
            type: 'checkbox',
            checked: refs.includes(file),
            disabled: edited,
            onChange: () => { toggleRef(file) },
          }),
          h('span', { title: file }, file))))),
    error !== '' ? h('div', { key: 'error', className: CLS.error, role: 'alert' }, error) : null,
  ]

  const footer = h('div', { className: CLS.cardFoot },
    h('div', { className: CLS.actions },
      h('button', { type: 'button', className: CLS.action, onClick: requestClose, disabled: busy !== null }, text('preview.close')),
      h('button', {
        type: 'button', className: CLS.action,
        onClick: () => { void onCopy(prompt, 'preview.copied') },
        disabled: busy !== null,
      }, text('preview.copy')),
      h('button', {
        type: 'button', className: CLS.action,
        onClick: () => { void onRegenerate() },
        disabled: busy !== null || regenerate === undefined,
      }, busy === 'regen' ? spinner() : text('preview.regen')),
      h('button', {
        type: 'button', className: CLS.actionPrimary,
        onClick: () => { void onOpen() },
        disabled: busy !== null || open === undefined,
      }, busy === 'open' ? spinner() : text('preview.open'))))

  return h('div', {
    className: CLS.backdrop,
    onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
      if (event.target === event.currentTarget) requestClose()
    },
  },
  h('div', {
    className: CLS.card,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': text('preview.title'),
  }, header, h('div', { className: CLS.cardBody }, bodyChildren), footer))
}
