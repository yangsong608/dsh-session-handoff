/**
 * dsh-session-handoff 宿主半：会话读取 → 确定性采集 → LLM 归纳 → 交接文档落盘 → 新会话提示词。
 *
 * 只注册两条只读/单次写路由，不向会话日志追加事件，不修改会话本身：
 *   GET  /session-handoff/health   能力探测（浏览器半用于降级提示）
 *   POST /session-handoff/prepare  生成交接包（需要 x-dsh-handoff: 1 头，挡跨站表单）
 *
 * 端点在本机同源下工作；写入范围限制在当前会话 cwd 的配置目录内。
 *
 * @module dsh-session-handoff
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { DEFAULTS, readConfig, type HandoffConfig } from './config.ts'
import { COLLECT_LIMITS, collectFacts } from './collect.ts'
import {
  appendWithRoll, createRunDir, exists, filterReferences, resolveInside, slug, stamp, writeAtomic,
} from './files.ts'
import { buildPromptParts, buildPromptText, MEMORY_HEADER, memoryDelta, renderJson, renderMarkdown } from './render.ts'
import { summarize } from './summary.ts'
import type {
  Facts, HandoffData, HandoffResult, LlmRuntimeLike, SessionEventLike, SessionHeaderLike,
  SessionLogSnapshotLike, SessionQueryLike,
} from './types.ts'

/** 版本号：与 package.json 保持一致（宿主半不 import JSON，避免 loader 差异）。 */
export const VERSION = '0.2.3'

const PREFIX = '[dsh-session-handoff]'
const ROUTE_HEALTH = '/session-handoff/health'
const ROUTE_PREPARE = '/session-handoff/prepare'
/** 单次生成的最大等待时间之外的绝对上限（配置值再夹取）。 */
const MAX_TIMEOUT_MS = 900_000
/** 记忆台账软上限；超过则滚动为 .1 备份。 */
const MEMORY_LIMIT_BYTES = 256 * 1024
/** 浏览器半必须带的自定义头，避免被跨站简单请求触发。 */
const REQUIRED_HEADER = 'x-dsh-handoff'

interface RouteRequest {
  url?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array>
}

interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: unknown): void
}

interface WebServerFace {
  register(route: { kind: string; path: string; handler: (req: RouteRequest, res: RouteResponse) => void }): () => void
}

interface SessionFace {
  id?: string
  deriveMessages?(): readonly unknown[]
}

interface SessionsFace {
  get?(id: string): SessionFace | undefined
  list?(): readonly SessionFace[]
}

/** Cordis 宿主上下文里本插件读取的那一部分。 */
interface HostContextLike {
  webServer?: WebServerFace
  sessionQuery?: SessionQueryLike
  llm?: LlmRuntimeLike
  sessions?: SessionsFace
  get?(name: string, soft?: boolean): unknown
  effect?(callback: () => unknown, label?: string): unknown
  logger?: { info?(message: string): void; warn?(message: string): void }
}

/** 等待 webServer；其余能力按可选处理（缺失时降级而不是拒绝加载）。 */
export const inject = ['webServer']

class HandoffError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function log(ctx: HostContextLike, level: 'info' | 'warn', message: string): void {
  const logger = ctx.logger
  if (logger !== undefined && typeof logger[level] === 'function') logger[level](`${PREFIX} ${message}`)
  else if (level === 'warn') console.warn(`${PREFIX} ${message}`)
  else console.log(`${PREFIX} ${message}`)
}

function service<T>(ctx: HostContextLike, name: 'sessionQuery' | 'llm' | 'sessions'): T | undefined {
  // 注意顺序：cordis 4 的插件作用域上下文是严格代理，读取未写进 inject 的服务名会直接抛
  // `cannot get property "<name>" without inject`，所以必须先走软查询。
  // ctx.get(name, false) 的契约就是「跳过 inject 要求」（见 cordis Context#get），
  // 未提供时返回 undefined，正好对应本插件的可选能力语义。
  if (typeof ctx.get === 'function') {
    const resolved = ctx.get(name, false)
    if (resolved !== undefined && resolved !== null) return resolved as T
  }
  // 兜底：非 cordis 上下文（例如冒烟脚本里的普通对象）没有 get，只能直接读属性。
  try {
    const direct = (ctx as unknown as Record<string, unknown>)[name]
    if (direct !== undefined) return direct as T
  } catch {
    // 命中 inject 保护：该服务对本插件不可用，按降级处理而不是让 apply 抛错。
  }
  return undefined
}

function respond(res: RouteResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function headerValue(req: RouteRequest, name: string): string {
  const value = req.headers?.[name]
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

/** 读取并解析 JSON 请求体，限制字节数（畸形输入一律 400）。 */
async function readJsonBody(req: RouteRequest, maxBytes: number): Promise<unknown> {
  if (typeof req[Symbol.asyncIterator] !== 'function') throw new HandoffError('bad-request', '请求体不可读')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new HandoffError('body-too-large', `请求体超过 ${maxBytes} 字节`, 413)
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new HandoffError('bad-json', '请求体不是合法 JSON')
  }
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** 只接受本机同源的按钮请求。 */
function assertSameOrigin(req: RouteRequest): void {
  if (headerValue(req, REQUIRED_HEADER) !== '1') throw new HandoffError('forbidden', `缺少 ${REQUIRED_HEADER}: 1 请求头`, 403)
  const origin = headerValue(req, 'origin')
  if (origin === '') return
  let host = ''
  try {
    host = new URL(origin).host
  } catch {
    throw new HandoffError('forbidden', 'Origin 非法', 403)
  }
  const target = headerValue(req, 'host')
  if (target !== '' && host !== target) throw new HandoffError('forbidden', '跨站请求被拒绝', 403)
}

/** 把派生消息包装成伪事件序列，作为没有 sessionQuery 时的降级读取。 */
function eventsFromMessages(messages: readonly unknown[]): SessionEventLike[] {
  const events: SessionEventLike[] = []
  const now = Date.now()
  messages.forEach((raw, index) => {
    const message = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : undefined
    if (message === undefined) return
    const role = message['role']
    const data = { message: { ...message, role } }
    const type = role === 'assistant' ? 'assistant/message' : role === 'tool' ? 'tool/result' : role === 'user' ? 'user/message' : ''
    if (type === '') return
    events.push({
      type,
      seq: index + 1,
      time: now,
      data: type === 'user/message'
        ? { content: message['content'], source: { kind: 'user' } }
        : data,
    })
  })
  return events
}

/** 读取一份会话日志：优先 sessionQuery（live 优先、可读归档），否则退回活会话派生消息。 */
async function readSnapshot(
  ctx: HostContextLike,
  sessionId: string,
): Promise<{ snapshot: SessionLogSnapshotLike; degraded: string[] }> {
  const query = service<SessionQueryLike>(ctx, 'sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    let snapshot: SessionLogSnapshotLike
    try {
      snapshot = await query.readSession(sessionId)
    } catch (cause) {
      // 查询后端对「不存在」的措辞不稳定：能识别的映射成 404，其余保留 500 与原始信息。
      const message = cause instanceof Error ? cause.message : String(cause)
      if (/not[ _-]?found|unknown session|no such|missing session/i.test(message)) {
        throw new HandoffError('session-not-found', `找不到会话 ${sessionId}`, 404)
      }
      throw new HandoffError('internal', `读取会话失败：${message}`, 500)
    }
    if (snapshot === undefined || snapshot.session === undefined) {
      throw new HandoffError('session-not-found', `找不到会话 ${sessionId}`, 404)
    }
    return { snapshot, degraded: [] }
  }
  const sessions = service<SessionsFace>(ctx, 'sessions')
  const live = sessions?.get?.(sessionId)
  if (live === undefined) throw new HandoffError('session-not-found', `找不到会话 ${sessionId}（缺少 sessionQuery 且会话不在内存）`, 404)
  const messages = typeof live.deriveMessages === 'function' ? live.deriveMessages() : []
  const header: SessionHeaderLike = { id: sessionId }
  return {
    snapshot: { session: header, events: eventsFromMessages(messages) },
    degraded: ['no-session-query'],
  }
}

function normalizeTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 执行一次交接生成。 */
async function prepare(
  ctx: HostContextLike,
  config: HandoffConfig,
  sessionId: string,
): Promise<HandoffResult> {
  const started = Date.now()
  const read = await readSnapshot(ctx, sessionId)
  const facts: Facts = collectFacts(read.snapshot, { ...COLLECT_LIMITS, maxToolCalls: config.maxToolCalls })
  for (const marker of read.degraded) facts.degraded.push(marker)
  if (facts.cwd === '') throw new HandoffError('no-cwd', '会话没有工作目录（cwd），无法写入交接文档', 409)
  if (!isAbsolute(facts.cwd)) throw new HandoffError('no-cwd', `会话工作目录不是绝对路径：${facts.cwd}`, 409)

  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, config.timeoutMs))
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error(`摘要超时（${timeout}ms）`)) }, timeout)
  // 关键：llm 是可选服务，必须先通过软查询解析成普通对象再传下去。
  // 直接把 ctx 传给协作者会在 cordis 严格代理上触发
  // `cannot get property "llm" without inject`（插件未声明 inject: ['llm']）。
  const llm = service<LlmRuntimeLike>(ctx, 'llm')
  let outcome
  try {
    outcome = await summarize({ llm }, facts, config, controller.signal)
  } finally {
    clearTimeout(timer)
  }
  const data: HandoffData = outcome.data
  if (normalizeTitle(facts.title) !== '' && normalizeTitle(data.title) === '') data.title = facts.title
  // 参考文件只保留真实存在/可解释的路径：工作区内优先，去掉临时文件与历史畸形路径。
  const references = await filterReferences(facts.cwd, [...data.state.files, ...facts.files])
  facts.files = references
  if (data.state.files.length > 0) data.state.files = references
  const root = resolveInside(facts.cwd, config.dir)
  // 记忆台账是增强项：写失败只降级记录，不能让已经可用的交接文档整单失败。
  let memoryPath: string | undefined
  if (config.writeMemory && data.memoryCandidates.length > 0) {
    const memoryFile = join(root, config.memoryFile)
    try {
      const existing = await exists(memoryFile)
      const { block, added } = memoryDelta(existing ? await readFile(memoryFile, 'utf8') : '', data, facts)
      if (added > 0) {
        await appendWithRoll(memoryFile, MEMORY_HEADER, block, MEMORY_LIMIT_BYTES)
        memoryPath = memoryFile
        log(ctx, 'info', `记忆台账追加 ${added} 条 → ${memoryFile}`)
      } else if (existing) {
        memoryPath = memoryFile
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      facts.degraded.push(`memory-write-failed:${detail}`.slice(0, 300))
      log(ctx, 'warn', `记忆台账写入失败，已降级：${detail}`)
    }
  }

  const meta = {
    ...(outcome.model === undefined ? {} : { model: outcome.model }),
    llm: outcome.llm,
    degraded: [...facts.degraded, ...outcome.degraded],
  }
  const runDir = await createRunDir(root, `${stamp(facts.capturedAt)}-${slug(data.title)}`)
  const docPath = join(runDir, 'WorkSummary.md')
  const dataPath = join(runDir, 'handoff.json')
  const markdown = renderMarkdown(facts, data, meta)
  const json = renderJson(facts, data, meta)
  await writeAtomic(docPath, markdown)
  await writeAtomic(dataPath, json)

  const paths = { doc: docPath, json: dataPath }
  const promptParts = buildPromptParts(facts, data, paths)
  const promptText = buildPromptText(facts, data, paths, config.promptCharBudget)
  log(ctx, 'info', `交接完成：${sessionId} → ${docPath}（llm=${outcome.llm}${meta.model !== undefined ? `, ${meta.model}` : ''}, ${Date.now() - started}ms）`)
  return {
    ok: true,
    sessionId,
    title: data.title,
    promptText,
    promptParts,
    preview: config.preview,
    markdown,
    data,
    docPath,
    dataPath,
    ...(memoryPath === undefined ? {} : { memoryPath }),
    memoryCandidates: data.memoryCandidates,
    autoSend: config.autoSend,
    degraded: meta.degraded,
    stats: {
      events: facts.eventCount,
      toolCalls: facts.tools.length,
      files: facts.files.length,
      chars: markdown.length,
      llm: outcome.llm,
      ...(outcome.model === undefined ? {} : { model: outcome.model }),
      durationMs: Date.now() - started,
    },
  }
}

/** 插件入口。 */
export function apply(ctx: HostContextLike, rawConfig?: unknown): void {
  const { config, warnings } = readConfig(rawConfig ?? DEFAULTS)
  for (const warning of warnings) log(ctx, 'warn', `配置告警：${warning}`)
  const capabilities = {
    sessionQuery: service(ctx, 'sessionQuery') !== undefined,
    sessions: service(ctx, 'sessions') !== undefined,
    llm: service(ctx, 'llm') !== undefined,
  }
  log(ctx, 'info', `已加载 v${VERSION}（${Object.entries(capabilities).map(([key, value]) => `${key}=${value ? 'on' : 'off'}`).join(', ')}）`)

  const register = (path: string, handler: (req: RouteRequest, res: RouteResponse) => void): void => {
    const webServer = ctx.webServer
    if (webServer === undefined) {
      log(ctx, 'warn', '缺少 webServer，交接端点未注册')
      return
    }
    webServer.register({ kind: 'exact', path, handler })
  }

  register(ROUTE_HEALTH, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, { ok: false, code: 'method-not-allowed', message: '只支持 GET' })
      return
    }
    respond(res, 200, {
      ok: true,
      plugin: 'dsh-session-handoff',
      version: VERSION,
      enabled: config.enabled,
      capabilities,
      config: {
        dir: config.dir,
        writeMemory: config.writeMemory,
        autoSend: config.autoSend,
        preview: config.preview,
        route: config.provider !== '' && config.model !== '' ? `${config.provider}/${config.model}` : 'session',
      },
      warnings,
    })
  })

  register(ROUTE_PREPARE, (req, res) => {
    void (async () => {
      try {
        if (req.method !== 'POST') throw new HandoffError('method-not-allowed', '只支持 POST', 405)
        assertSameOrigin(req)
        if (!config.enabled) throw new HandoffError('disabled', '会话接力已在配置中关闭', 503)
        const body = await readJsonBody(req, config.maxBodyBytes)
        const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
        const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'].trim() : ''
        if (!SESSION_ID.test(sessionId)) throw new HandoffError('bad-session', 'sessionId 缺失或格式不合法')
        const result = await prepare(ctx, config, sessionId)
        respond(res, 200, result)
      } catch (cause) {
        const error = cause instanceof HandoffError
          ? cause
          : new HandoffError('internal', cause instanceof Error ? cause.message : String(cause), 500)
        log(ctx, 'warn', `${error.code}: ${error.message}`)
        respond(res, error.status, { ok: false, code: error.code, message: error.message })
      }
    })()
  })
}
