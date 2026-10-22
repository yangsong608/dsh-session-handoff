/**
 * 摘要层：把事实集交给模型归纳成固定 JSON（五段式交接），并提供确定性兜底。
 *
 * 这是插件唯一的模型调用点：一次一次性生成，温度 0，不写会话日志、不写请求头。
 * 路由优先取显式配置，其次取会话最后一次 request/header 的路由；两者都没有时
 * 直接走确定性兜底，而不是猜一个 provider。
 *
 * @module dsh-session-handoff/host/summary
 */

import type { HandoffConfig } from './config.ts'
import type { Facts, HandoffData, LlmRuntimeLike, LlmStreamChunk } from './types.ts'

/** 固定摘要协议：只输出一个 JSON 对象。 */
export const SYSTEM_PROMPT = `你是会话交接编辑。你会收到一个编码 Agent 会话的结构化事实集，需要把它写成「下一个会话可以直接接着干」的交接材料。

只输出一个 JSON 对象，不要 Markdown 代码围栏，不要额外说明。字段固定：
{
  "title": "≤24 字的会话标题（动宾结构）",
  "summary": "≤120 字，一句话说明做到哪了",
  "goal": "用户真正的目标与约束（≤300 字）",
  "completed": ["已完成的工作，每条 ≤80 字，带可验证结果（文件/命令/结论）"],
  "decisions": [{"decision": "已定决策", "rationale": "依据/取舍"}],
  "state": {"current": "当前状态（≤200 字）", "files": ["相关文件路径"], "blockers": ["阻塞或风险"]},
  "nextSteps": [{"step": "下一步动作", "why": "为什么它排在这里"}],
  "memoryCandidates": [{"text": "值得长期记住的一句话（偏好/约定/事实/教训）", "scope": "memory|user|project"}]
}

规则：
1. 只写事实集里出现过的东西，不要编造文件名、结论或数字。
2. completed 用「动词 + 对象 + 结果」；没有结果就写「已起草，未验证」。
3. nextSteps 按依赖顺序排列，第一条必须能在新会话立刻执行。
4. memoryCandidates 只放跨会话仍然成立的内容（用户偏好、项目约定、环境事实、可复用教训），不要放本次任务的进度；没有就输出空数组。
5. 中文输出；代码标识符、路径、命令保持原文。`

/** 摘要结果。 */
export interface SummaryOutcome {
  data: HandoffData
  llm: boolean
  model?: string
  degraded: string[]
}

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function textList(value: unknown, itemMax: number, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(clip(item, itemMax))
    if (out.length >= limit) break
  }
  return out
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 从模型输出里取出 JSON 并按协议做宽松校验（字段缺失即降级，不抛给用户）。 */
export function parseHandoff(raw: string): HandoffData | undefined {
  const cleaned = raw.replace(/^\uFEFF/, '').trim()
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? cleaned).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
  const object = record(value)
  if (object === undefined) return undefined
  const state = record(object['state']) ?? {}
  const decisions = Array.isArray(object['decisions'])
    ? object['decisions'].flatMap(item => {
      const entry = record(item)
      const decision = clip(entry?.['decision'], 160)
      if (decision === '') return []
      return [{ decision, rationale: clip(entry?.['rationale'], 240) }]
    }).slice(0, 12)
    : []
  const nextSteps = Array.isArray(object['nextSteps'])
    ? object['nextSteps'].flatMap(item => {
      const entry = record(item)
      const step = clip(entry?.['step'], 200)
      if (step === '') return []
      return [{ step, why: clip(entry?.['why'], 240) }]
    }).slice(0, 12)
    : []
  const memoryCandidates = Array.isArray(object['memoryCandidates'])
    ? object['memoryCandidates'].flatMap(item => {
      const entry = record(item)
      const text = clip(entry?.['text'], 240)
      if (text === '') return []
      const scope = entry?.['scope']
      const resolved: 'memory' | 'user' | 'project' = scope === 'user' || scope === 'project' ? scope : 'memory'
      return [{ text, scope: resolved }]
    }).slice(0, 12)
    : []
  return {
    title: clip(object['title'], 48) || '会话交接',
    summary: clip(object['summary'], 240),
    goal: clip(object['goal'], 600),
    completed: textList(object['completed'], 200, 20),
    decisions,
    state: {
      current: clip(state['current'], 500),
      files: textList(state['files'], 300, 40),
      blockers: textList(state['blockers'], 300, 12),
    },
    nextSteps,
    memoryCandidates,
  }
}

/** 确定性兜底：不调用模型，用事实集拼出可用但不精致的交接内容。 */
export function fallbackData(facts: Facts): HandoffData {
  const first = facts.userMessages[0] ?? ''
  const last = facts.userMessages.at(-1) ?? ''
  const title = facts.title !== '' ? facts.title : (first.split(/[\n。！？!?]/)[0] ?? '').slice(0, 24) || '会话交接'
  const changed = facts.files.slice(0, 12)
  const completed: string[] = []
  for (const file of changed.slice(0, 6)) completed.push(`已改/读过 ${file}`)
  for (const text of facts.assistantTexts.slice(-3)) completed.push(clip(text.split('\n')[0], 200))
  const blockers = [...facts.failures.slice(0, 6)]
  return {
    title,
    summary: last !== ''
      ? `最近一次诉求：${clip(last.split('\n')[0], 160)}`
      : `共 ${facts.eventCount} 条事件、${facts.tools.length} 次工具调用`,
    goal: first !== '' ? clip(first, 600) : last !== '' ? clip(last, 600) : '（未记录到用户诉求）',
    completed,
    decisions: [],
    state: {
      current: facts.assistantTexts.at(-1)?.slice(0, 500) ?? '（模型摘要不可用，仅保留确定性事实）',
      files: facts.files.slice(0, 40),
      blockers,
    },
    nextSteps: [{ step: '阅读本交接文档与列出的参考文件，确认现状后继续', why: '模型摘要不可用，先以事实集为准' }],
    memoryCandidates: [],
  }
}

/** 把事实集渲染成模型可读的 Markdown 摘要输入（带字符预算，保头保尾）。 */
export function buildDigest(facts: Facts, maxChars: number): string {
  const lines: string[] = []
  const push = (line: string): void => { lines.push(line) }
  push(`# 会话事实集`)
  push('')
  push(`- 会话：${facts.title !== '' ? facts.title : '(无标题)'}（${facts.sessionId}）`)
  push(`- 工作目录：${facts.cwd !== '' ? facts.cwd : '(未知)'}`)
  push(`- 事件数：${facts.eventCount}；工具调用：${facts.tools.length}；涉及文件：${facts.files.length}`)
  if (facts.lastRoute !== undefined) push(`- 会话模型：${facts.lastRoute.provider}/${facts.lastRoute.model}`)
  push('')
  push(`## 用户诉求（按时间，共 ${facts.userMessages.length} 条）`)
  facts.userMessages.forEach((message, index) => { push(`${index + 1}. ${message}`) })
  if (facts.injectedMessages.length > 0) {
    push('')
    push('## 注入上下文（非用户直接输入，摘录）')
    push(facts.injectedMessages.slice(-8).map(message => `- ${message}`).join('\n'))
  }
  push('')
  push(`## 助手进展（按时间，最多保留 ${facts.assistantTexts.length} 条）`)
  facts.assistantTexts.forEach((text, index) => { push(`### 进展 ${index + 1}\n${text}`) })
  if (facts.compactionSummaries.length > 0) {
    push('')
    push('## 历史压缩摘要')
    facts.compactionSummaries.forEach((text, index) => { push(`### 摘要 ${index + 1}\n${text}`) })
  }
  push('')
  push(`## 工具活动（按时间，${facts.tools.length} 条）`)
  for (const tool of facts.tools) {
    const status = tool.failed ? '失败' : 'ok'
    const detail = tool.commands[0] ?? tool.files[0] ?? tool.argumentsExcerpt
    push(`- [${tool.seq}] ${tool.name}（${status}）：${clip(detail, 220)}`)
  }
  if (facts.failures.length > 0) {
    push('')
    push('## 失败与阻塞')
    facts.failures.forEach(failure => push(`- ${failure}`))
  }
  if (facts.files.length > 0) {
    push('')
    push('## 涉及文件')
    facts.files.slice(0, 120).forEach(file => push(`- ${file}`))
  }
  if (facts.commands.length > 0) {
    push('')
    push('## 执行过的命令（去重）')
    facts.commands.slice(0, 60).forEach(command => push(`- \`${clip(command, 200)}\``))
  }
  const body = lines.join('\n')
  if (body.length <= maxChars) return body
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${body.slice(0, head)}\n\n…（中间 ${body.length - maxChars} 字已省略）…\n\n${body.slice(-tail)}`
}

/** 读取一次性补全的文本（只关心文本块与终止原因）。 */
async function readCompletion(stream: AsyncIterable<LlmStreamChunk>): Promise<string> {
  let text = ''
  let finished = false
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      text = chunk.block.text === '' ? text : chunk.block.text
    } else if (chunk.type === 'finish') {
      finished = true
      const kind = chunk.reason?.kind ?? 'unknown'
      if (kind !== 'stop') {
        const code = chunk.reason?.failure?.code ?? kind
        throw new Error(`模型以 ${kind} 结束（${code}）`)
      }
    }
  }
  if (!finished) throw new Error('模型流未给出终止原因')
  return text.trim()
}

/** 调用一次模型做归纳；失败时不抛出，交给调用方降级。 */
export async function summarize(
  ctx: { llm?: LlmRuntimeLike },
  facts: Facts,
  config: HandoffConfig,
  signal: AbortSignal,
): Promise<SummaryOutcome> {
  const degraded: string[] = []
  const route = config.provider !== '' && config.model !== ''
    ? { provider: config.provider, model: config.model }
    : facts.lastRoute
  if (ctx.llm === undefined) {
    degraded.push('llm-unavailable')
    return { data: fallbackData(facts), llm: false, degraded }
  }
  if (route === undefined) {
    degraded.push('no-model-route')
    return { data: fallbackData(facts), llm: false, degraded }
  }
  const digest = buildDigest(facts, config.maxInputChars)
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: digest }] }],
      temperature: 0,
      maxTokens: config.maxTokens,
      signal,
    })
    const raw = await readCompletion(stream)
    const parsed = parseHandoff(raw)
    if (parsed === undefined) {
      degraded.push('llm-unparseable')
      return { data: fallbackData(facts), llm: false, degraded }
    }
    return { data: parsed, llm: true, model: `${route.provider}/${route.model}`, degraded }
  } catch (cause) {
    degraded.push(`llm-failed:${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300))
    return { data: fallbackData(facts), llm: false, degraded }
  }
}
