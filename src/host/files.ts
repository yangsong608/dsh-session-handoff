/**
 * 落盘与路径安全：所有写入都限制在会话 cwd 之下，且拒绝覆盖既有文档。
 *
 * 写入使用「同目录临时文件 + rename」，失败不留半截文件；记忆台账先读后合并，
 * 并在超过上限时滚动到 .1 备份，不静默丢弃历史。
 *
 * @module dsh-session-handoff/host/files
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 单次交接目录名的安全化：保留中英文、数字与连字符。 */
export function slug(text: string, fallback = 'session'): string {
  const cleaned = text
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned !== '' ? cleaned : fallback
}

/** 时间戳目录名：20261023-031500。 */
export function stamp(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 解析 base 之下的相对路径，拒绝绝对路径、`..` 与指向 base 外的符号链接结果。
 * @throws 当路径越界或 base 为空。
 */
export function resolveInside(base: string, relativePath: string): string {
  if (base === '' || !isAbsolute(base)) throw new Error(`工作目录必须是绝对路径：${base === '' ? '(空)' : base}`)
  if (isAbsolute(relativePath)) throw new Error(`拒绝绝对路径：${relativePath}`)
  const root = resolve(base)
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径越界：${relativePath}`)
  return target
}

/** 原子写：先写临时文件再 rename（同目录保证同文件系统）。 */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/** 读取文本；不存在返回空串，其他错误抛出。 */
export async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw cause
  }
}

/** 文件是否存在。 */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 在既有文件后追加内容；超过上限时先把旧文件滚动为 .1。 */
export async function appendWithRoll(path: string, header: string, block: string, limitBytes: number): Promise<void> {
  const existing = await readTextIfExists(path)
  const base = existing === '' ? header : existing
  const next = `${base}${block}`
  if (Buffer.byteLength(next, 'utf8') > limitBytes && existing !== '') {
    const backup = `${path}.1`
    await writeAtomic(backup, existing)
    await writeAtomic(path, `${header}${block}`)
    return
  }
  await writeAtomic(path, next)
}

/** 为一次交接创建独占目录（存在则加序号，绝不覆盖）。 */
export async function createRunDir(root: string, name: string): Promise<string> {
  await mkdir(root, { recursive: true })
  for (let index = 1; index <= 50; index += 1) {
    const candidate = join(root, index === 1 ? name : `${name}-${index}`)
    try {
      // 非递归 mkdir 的原子性就是「目录名独占」：已存在即换下一个序号。
      await mkdir(candidate, { recursive: false })
      return candidate
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    }
  }
  throw new Error(`无法创建交接目录：${join(root, name)}`)
}

/**
 * 过滤参考文件：绝对路径必须存在，工作区内优先，其次相对路径，最后外部绝对路径。
 * 目的是避免把 /tmp 临时截图或历史错误里的畸形路径带进交接文档与新会话提示词。
 */
export async function filterReferences(base: string, files: readonly string[], limit = 40): Promise<string[]> {
  const seen = new Set<string>()
  const inside: string[] = []
  const relativeFiles: string[] = []
  const outside: string[] = []
  const root = base === '' ? '' : resolve(base)
  for (const raw of files) {
    const file = String(raw ?? '').trim()
    if (file === '' || seen.has(file)) continue
    seen.add(file)
    if (!isAbsolute(file)) {
      relativeFiles.push(file)
      continue
    }
    let normalized: string
    try {
      normalized = resolve(file)
    } catch {
      continue
    }
    if (!(await exists(normalized))) continue
    const rel = root === '' ? '..' : relative(root, normalized)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) inside.push(normalized)
    else outside.push(normalized)
  }
  return [...inside, ...relativeFiles, ...outside].slice(0, limit)
}

/** 站内相对路径（用于日志与返回值展示）。 */
export function displayPath(base: string, target: string): string {
  const rel = relative(resolve(base), resolve(target))
  return rel.startsWith('..') ? target : rel.split(sep).join('/')
}
