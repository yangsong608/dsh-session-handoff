/**
 * 配置读取：零依赖、逐字段校验、越界即夹取并记录告警。
 *
 * 配置来自 bundle patch 的 `config:`（Cordis 直接以普通对象传给 apply），
 * 因此这里只做结构校验，不引入 schemastery——第三方插件不带运行时依赖，
 * 校验失败也不能让宿主半加载失败。
 *
 * @module dsh-session-handoff/host/config
 */

/** 完整的插件配置。 */
export interface HandoffConfig {
  /** 总开关；false 时所有路由返回 503，浏览器按钮提示未启用。 */
  enabled: boolean
  /** 交接文档目录，相对会话 cwd；必须以非绝对路径给出。 */
  dir: string
  /** 记忆台账文件名（位于 dir 内）。 */
  memoryFile: string
  /** 是否写入/合并记忆台账。 */
  writeMemory: boolean
  /** 显式模型路由；两者都给才生效，否则回退会话最后一次请求头。 */
  provider: string
  model: string
  /** 摘要调用的输出上限。 */
  maxTokens: number
  /** 送给摘要模型的输入字符上限。 */
  maxInputChars: number
  /** 采集工具活动时的条数上限（保留最近的）。 */
  maxToolCalls: number
  /** 新会话提示词内联摘要的字符上限（文档本身不受此限）。 */
  promptCharBudget: number
  /** 浏览器半在生成后是否直接发送（false = 预填草稿，由用户确认）。 */
  autoSend: boolean
  /** 生成后是否先展示可编辑预览卡（true）还是直接开新会话（false，v0.1 行为）。 */
  preview: boolean
  /** 摘要请求的超时毫秒数。 */
  timeoutMs: number
  /** 路由请求体大小上限。 */
  maxBodyBytes: number
}

export const DEFAULTS: HandoffConfig = {
  enabled: true,
  dir: '.dsh-handoff',
  memoryFile: '交接记忆.md',
  writeMemory: true,
  provider: '',
  model: '',
  maxTokens: 4096,
  maxInputChars: 80_000,
  maxToolCalls: 400,
  promptCharBudget: 6000,
  autoSend: false,
  preview: true,
  timeoutMs: 180_000,
  maxBodyBytes: 256 * 1024,
}

function bool(value: unknown, fallback: boolean, warnings: string[], key: string): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warnings.push(`${key}: 需要 boolean，已回退`)
  return fallback
}

function text(value: unknown, fallback: string, warnings: string[], key: string): string {
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  warnings.push(`${key}: 需要 string，已回退`)
  return fallback
}

function int(value: unknown, fallback: number, min: number, max: number, warnings: string[], key: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${key}: 需要数字，已回退`)
    return fallback
  }
  const rounded = Math.trunc(value)
  if (rounded < min || rounded > max) {
    warnings.push(`${key}: 越界，已夹取到 ${min}..${max}`)
    return Math.min(max, Math.max(min, rounded))
  }
  return rounded
}

/** 目录必须是相对路径且不含 `..`，否则回退默认值。 */
function relativeDir(value: unknown, fallback: string, warnings: string[], key: string): string {
  const raw = text(value, fallback, warnings, key).trim()
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    if (raw !== fallback) warnings.push(`${key}: 只接受不含 .. 的相对目录，已回退 ${fallback}`)
    return fallback
  }
  return normalized
}

/** 只接受纯文件名（不含路径分隔符/越界段），否则回退。 */
function fileName(value: unknown, fallback: string, warnings: string[], key: string): string {
  const raw = text(value, fallback, warnings, key).trim()
  if (raw === '') return fallback
  if (raw.length > 80 || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
    warnings.push(`${key}: 只接受纯文件名（不含路径分隔符），已回退 ${fallback}`)
    return fallback
  }
  return raw
}

/** 校验任意原始配置并返回规范化结果与告警。 */
export function readConfig(raw: unknown): { config: HandoffConfig; warnings: string[] } {
  const warnings: string[] = []
  const source = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const config: HandoffConfig = {
    enabled: bool(source['enabled'], DEFAULTS.enabled, warnings, 'enabled'),
    dir: relativeDir(source['dir'], DEFAULTS.dir, warnings, 'dir'),
    memoryFile: fileName(source['memoryFile'], DEFAULTS.memoryFile, warnings, 'memoryFile'),
    writeMemory: bool(source['writeMemory'], DEFAULTS.writeMemory, warnings, 'writeMemory'),
    provider: text(source['provider'], DEFAULTS.provider, warnings, 'provider').trim(),
    model: text(source['model'], DEFAULTS.model, warnings, 'model').trim(),
    maxTokens: int(source['maxTokens'], DEFAULTS.maxTokens, 256, 32_768, warnings, 'maxTokens'),
    maxInputChars: int(source['maxInputChars'], DEFAULTS.maxInputChars, 4_000, 400_000, warnings, 'maxInputChars'),
    maxToolCalls: int(source['maxToolCalls'], DEFAULTS.maxToolCalls, 20, 2_000, warnings, 'maxToolCalls'),
    promptCharBudget: int(source['promptCharBudget'], DEFAULTS.promptCharBudget, 1_000, 20_000, warnings, 'promptCharBudget'),
    autoSend: bool(source['autoSend'], DEFAULTS.autoSend, warnings, 'autoSend'),
    preview: bool(source['preview'], DEFAULTS.preview, warnings, 'preview'),
    timeoutMs: int(source['timeoutMs'], DEFAULTS.timeoutMs, 5_000, 900_000, warnings, 'timeoutMs'),
    maxBodyBytes: int(source['maxBodyBytes'], DEFAULTS.maxBodyBytes, 1_024, 4 * 1024 * 1024, warnings, 'maxBodyBytes'),
  }
  return { config, warnings }
}
