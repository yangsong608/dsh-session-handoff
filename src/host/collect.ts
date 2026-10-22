/**
 * 确定性采集：把一份会话日志压成「可独立成文」的事实集。
 *
 * 这一层不调用模型，因此摘要失败时交接文档仍然成立（降级路径）。
 * 只读性质：不向会话追加任何事件，不修改会话状态。
 *
 * @module dsh-session-handoff/host/collect
 */

import type { ContentBlockLike, Facts, SessionEventLike, SessionLogSnapshotLike, ToolFact } from './types.ts'

/** 采集阶段的硬性预算（防止畸形日志把内存吃满）。 */
export interface CollectLimits {
  maxToolCalls: number
  maxUserMessages: number
  maxAssistantTexts: number
  excerptChars: number
}

export const COLLECT_LIMITS: CollectLimits = {
  maxToolCalls: 400,
  maxUserMessages: 80,
  maxAssistantTexts: 120,
  excerptChars: 2_000,
}

/** 内容块数组或字符串 → 纯文本。 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as ContentBlockLike[]) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 截断并统一空白，用于模型输入与文档引用。 */
export function excerpt(value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value : ''
  const trimmed = raw.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n…（已截断 ${trimmed.length - max} 字）`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

const FILE_KEY = /(^|_)(path|file|filepath|file_path|notebook_path|target|filename)(_|$)/i
const COMMAND_KEY = /(^|_)(command|cmd|script|shell)(_|$)/i
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

/** 从工具参数里识别文件路径与命令（尽力而为，未知工具名不影响结果）。 */
export function pathsFromArguments(name: string, raw: string): { files: string[]; commands: string[] } {
  const files: string[] = []
  const commands: string[] = []
  let titleFromEvent = ''
  const push = (list: string[], value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.length > 1_024) return
    list.push(trimmed)
  }
  for (const match of raw.matchAll(PATCH_FILE)) push(files, match[1])
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 非 JSON 参数：命令类工具把整段当命令，其余忽略。
    if (/bash|shell|terminal|exec|run/i.test(name)) push(commands, raw)
    return { files, commands }
  }
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const object = record(value)
    if (object === undefined) return
    for (const [key, member] of Object.entries(object)) {
      if (typeof member === 'string') {
        if (FILE_KEY.test(key)) push(files, member)
        else if (COMMAND_KEY.test(key)) push(commands, member)
      } else {
        walk(member, depth + 1)
      }
    }
  }
  walk(parsed, 0)
  if (commands.length === 0 && files.length === 0 && /bash|shell|terminal|exec/i.test(name)) push(commands, raw)
  return { files, commands }
}

function uniq(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (value === '') continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}

function eventData(event: SessionEventLike, key: string): unknown {
  return record(event.data)?.[key]
}

/** 把一份日志观测采集为事实集。 */
export function collectFacts(
  snapshot: SessionLogSnapshotLike,
  limits: CollectLimits = COLLECT_LIMITS,
): Facts {
  const degraded: string[] = []
  const header = snapshot.session ?? { id: '' }
  const facts: Facts = {
    sessionId: String(header.id ?? ''),
    title: String(header.title ?? '').trim(),
    cwd: String(header.cwd ?? '').trim(),
    createdAt: Number(header.createdAt ?? 0) || 0,
    capturedAt: Date.now(),
    eventCount: 0,
    userMessages: [],
    injectedMessages: [],
    assistantTexts: [],
    tools: [],
    files: [],
    commands: [],
    failures: [],
    compactionSummaries: [],
    degraded,
  }

  const events = Array.isArray(snapshot.events) ? snapshot.events : []
  facts.eventCount = events.length
  const callIndex = new Map<string, ToolFact>()
  const files: string[] = []
  const commands: string[] = []
  let titleFromEvent = ''
  const userMessages: string[] = []
  const injected: string[] = []
  const assistants: string[] = []
  const failures: string[] = []
  const compaction: string[] = []
  const tools: ToolFact[] = []

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    switch (event.type) {
      case 'user/message': {
        const text = contentText(eventData(event, 'content'))
        if (text === '') break
        const source = record(eventData(event, 'source'))
        if (source !== undefined && source['kind'] === 'user') userMessages.push(excerpt(text, limits.excerptChars))
        else injected.push(excerpt(text, 600))
        break
      }
      case 'assistant/message': {
        const message = record(eventData(event, 'message'))
        const text = contentText(message?.['content'])
        if (text !== '') assistants.push(excerpt(text, Math.max(1_200, Math.floor(limits.excerptChars))))
        break
      }
      case 'tool/call': {
        const name = String(eventData(event, 'name') ?? '')
        const callId = String(eventData(event, 'callId') ?? '')
        const raw = String(eventData(event, 'arguments') ?? '')
        const extracted = pathsFromArguments(name, raw)
        for (const file of extracted.files) files.push(file)
        for (const command of extracted.commands) commands.push(command)
        const fact: ToolFact = {
          seq: event.seq,
          name,
          callId,
          argumentsExcerpt: excerpt(raw, 600),
          files: extracted.files,
          commands: extracted.commands,
          failed: false,
          resultExcerpt: '',
        }
        tools.push(fact)
        if (callId !== '') callIndex.set(callId, fact)
        break
      }
      case 'tool/result': {
        const message = record(eventData(event, 'message'))
        const callId = String(message?.['toolCallId'] ?? '')
        const fact = callIndex.get(callId)
        const failed = message?.['isError'] === true
        const text = contentText(message?.['content'])
        if (fact !== undefined) {
          fact.failed = failed
          fact.resultExcerpt = excerpt(text, 600)
        }
        if (failed) failures.push(excerpt(`${fact?.name ?? 'tool'} 失败：${text}`, 600))
        break
      }
      case 'session/title': {
        const title = String(eventData(event, 'title') ?? '').trim()
        if (title !== '') titleFromEvent = title
        break
      }
      case 'compaction/summary': {
        const text = contentText(eventData(event, 'summary'))
        if (text !== '') compaction.push(excerpt(text, 3_000))
        break
      }
      case 'request/header': {
        const config = record(record(eventData(event, 'header'))?.['config'])
        const provider = typeof config?.['provider'] === 'string' ? config['provider'] : ''
        const model = typeof config?.['model'] === 'string' ? config['model'] : ''
        if (provider !== '' && model !== '') facts.lastRoute = { provider, model }
        break
      }
      default:
        break
    }
  }

  // 标题是投影事件（session/title），SessionHeader 里通常为空；最新事件优先。
  if (titleFromEvent !== '') facts.title = titleFromEvent
  facts.userMessages = userMessages.slice(-limits.maxUserMessages)
  facts.injectedMessages = injected.slice(-limits.maxAssistantTexts)
  facts.assistantTexts = assistants.slice(-limits.maxAssistantTexts)
  facts.tools = tools.slice(-limits.maxToolCalls)
  facts.failures = uniq(failures, 20)
  facts.compactionSummaries = compaction.slice(-3)
  facts.files = uniq(files, 200)
  facts.commands = uniq(commands, 120)
  if (facts.eventCount === 0) degraded.push('empty-log')
  if (facts.assistantTexts.length === 0 && facts.tools.length === 0) degraded.push('no-work-signal')
  if (facts.title === '') degraded.push('no-title')
  if (facts.cwd === '') degraded.push('no-cwd')
  return facts
}
