#!/usr/bin/env node
/**
 * 浏览器半冒烟：在 Node vm 里加载真实的 lib/client.js（模块工厂产物），
 * 用假的 window/document/react/ctx 跑 apply()、按钮、预览卡与快捷键。
 *
 * 覆盖：三个座位注册与降级、预览生成与渲染、编辑后打开、autoSend、404 文案、
 * 快捷键 resolve、locale 词典。React 用真实运行时做 SSR。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const code = await readFile(join(root, 'lib/client.js'), 'utf8')

const failures = []
const passes = []
function check(name, condition, detail = '') {
  if (condition) passes.push(name)
  else failures.push(`${name}${detail === '' ? '' : `：${detail}`}`)
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: fn => fn,
  useEffect: () => {},
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

let realReact
let renderToString
let jsxRuntime
try {
  realReact = (await import('react')).default
  ;({ renderToString } = await import('react-dom/server'))
  jsxRuntime = await import('react/jsx-runtime')
} catch {
  realReact = undefined
}
const reactImpl = realReact ?? fakeReact

function makeBrowser() {
  const styles = []
  const listeners = new Map()
  const document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: node => { styles.push(node); } },
    body: { appendChild: () => {} },
    querySelectorAll: () => [],
    addEventListener: (type, handler) => { listeners.set(type, handler); },
    removeEventListener: type => { listeners.delete(type); },
  }
  const window = { __ModuleLoader__: null }
  const state = { styles, fetch: null, listeners }
  let copied
  let captured
  window.__ModuleLoader__ = { load: entry => { captured = entry } }
  const context = {
    window,
    document,
    navigator: {
      language: 'zh-CN',
      clipboard: { writeText: async text => { copied = text } },
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    fetch: (...args) => state.fetch(...args),
    URL,
    Promise,
  }
  vm.runInNewContext(code, context, { filename: 'lib/client.js' })
  return { window, state, document, captured: () => captured, copied: () => copied }
}

function makeCtx({ failSeats = [], locale = undefined, shortcuts = true } = {}) {
  const registrations = []
  const injectedSeats = []
  const shortcut = { command: undefined }
  const ctx = {
    slots: {
      inject(key, callback) {
        if (failSeats.includes(key)) throw new Error(`seat ${key} unavailable`)
        injectedSeats.push(key)
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
      entries: () => [],
    },
    effect: callback => callback(),
    get: name => name === 'locale' ? locale : undefined,
    ...(shortcuts
      ? { shortcuts: { register(command) { shortcut.command = command; return () => {} } } }
      : {}),
  }
  return { ctx, registrations, injectedSeats, shortcut }
}

function loadPlugin(env, ctx) {
  const entry = env.captured()
  if (entry === undefined) throw new Error('bundle 未调用 __ModuleLoader__.load')
  const exports = entry.factory(specifier => {
    if (specifier === 'react') return reactImpl
    if (specifier === 'react/jsx-runtime') return jsxRuntime ?? { jsx: fakeReact.createElement, jsxs: fakeReact.createElement }
    throw new Error(`unexpected require: ${specifier}`)
  })
  exports.apply(ctx)
  return exports
}

const parts = {
  title: '会话接力测试',
  sessionId: 'session-1',
  docPath: '/tmp/handoff/WorkSummary.md',
  dataPath: '/tmp/handoff/handoff.json',
  summary: '已完成大半',
  goal: '把插件做完',
  completed: ['已完成 A', '已完成 B'],
  nextSteps: [{ step: '继续 C', why: '关键路径' }],
  blockers: [],
  references: ['src/a.ts', 'src/b.ts'],
  referenceOptions: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  requirements: ['要求一', '要求二'],
}

function payloadBody(overrides = {}) {
  return {
    ok: true,
    promptText: '占位',
    promptParts: parts,
    title: parts.title,
    docPath: parts.docPath,
    dataPath: parts.dataPath,
    memoryCandidates: [{ text: '记忆一', scope: 'memory' }],
    degraded: [],
    autoSend: false,
    preview: true,
    ...overrides,
  }
}

function fakeFetch(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
}

// --- 1. 座位、快捷键与样式 ---
const env = makeBrowser()
const { ctx, registrations, injectedSeats, shortcut } = makeCtx()
const exports = loadPlugin(env, ctx)
const button = registrations.find(entry => entry.options.name === 'conversation.input.right')
const overlay = registrations.find(entry => entry.options.name === 'shell.overlay')
const face = button?.options.inject?.()
const previewFace = overlay?.options.inject?.()

check('bundle id 正确', env.captured()?.id === 'dsh-session-handoff')
check('导出 apply/inject', typeof exports.apply === 'function' && Array.isArray(exports.inject))
check('注册按钮到 input.right', button !== undefined && button.options.id === 'session-handoff' && button.options.order === 40)
check('注册预览卡到 shell.overlay', overlay !== undefined && previewFace !== undefined && typeof previewFace.open === 'function')
check('注册快捷键 session.handoff', shortcut.command?.id === 'session.handoff')
check('快捷键默认 Cmd/Ctrl+Shift+H', shortcut.command?.defaults?.['desktop:macos']?.code === 'KeyH'
  && shortcut.command?.defaults?.['desktop:macos']?.modifiers?.includes('primary')
  && shortcut.command?.defaults?.['desktop:macos']?.modifiers?.includes('shift'))
check('Linux 档避开 DSH 保留键', shortcut.command?.defaults?.['desktop:linux']?.code === 'Period' && shortcut.command?.defaults?.['web:linux']?.code === 'Period')
check('六档默认键位全部声明', Object.keys(shortcut.command?.defaults ?? {}).length === 6)
check('座位注入顺序：预览先于按钮', injectedSeats[0] === 'shell.overlay' && injectedSeats.includes('conversation.input.right'))
check('注入了样式', env.state.styles.length === 1 && env.state.styles[0].id === 'dsh-session-handoff-style')
check('注入面提供 run', typeof face?.run === 'function')

// --- 2. 生成预览并渲染 ---
const promptText = exports.composePrompt(parts)
env.state.fetch = fakeFetch(payloadBody({ promptText }))
const runResult = await face.run('session-1', { workspaceId: 'ws-1' })
check('生成后进入预览而非直接打开', runResult.mode === 'preview')
check('预览状态为 ready', exports.__testing.previewStore.getState().phase === 'ready')

const overlayHtml = renderToString(realReact.createElement(overlay.component, { ...previewFace }))
check('预览卡渲染标题', overlayHtml.includes(parts.title))
check('预览卡渲染提示词编辑框', overlayHtml.includes('dsh-handoff-prompt') && overlayHtml.includes('<textarea'))
check('预览卡渲染下一步与记忆候选', overlayHtml.includes('继续 C') && overlayHtml.includes('记忆一'))
check('预览卡渲染三个参考文件候选', (overlayHtml.match(/type="checkbox"/g) ?? []).length === 3)
check('预览卡动作齐全', ['打开新会话', '复制提示词', '重新生成', '关闭'].every(label => overlayHtml.includes(label)))

// 打开新会话（使用编辑后的提示词）
let opened
ctx.get = name => {
  if (name === 'uiWorkspace') return { startSession: (workspaceId, options) => { opened = { workspaceId, options } } }
  return undefined
}
const openedMode = await previewFace.open('# 编辑后的提示词')
check('预览确认后打开新会话', openedMode === 'draft' && opened?.options?.prompt === '# 编辑后的提示词' && opened?.workspaceId === 'ws-1')

// 复制与关闭
await previewFace.copy('复制内容')
check('复制走剪贴板', env.copied() === '复制内容')
previewFace.close()
check('关闭后回到 idle', exports.__testing.previewStore.getState().phase === 'idle')

// --- 3. 重新生成 ---
env.state.fetch = fakeFetch(payloadBody({ promptText: '第二版提示词', title: '第二版' }))
await face.run('session-1', {})
check('第二次生成覆盖预览', exports.__testing.previewStore.getState().phase === 'ready')
await previewFace.regenerate()
check('重新生成后仍是 ready', exports.__testing.previewStore.getState().phase === 'ready' && exports.__testing.previewStore.getState().payload?.title === '第二版')
previewFace.close()

// --- 4. preview=false + autoSend 直达 ---
env.state.fetch = fakeFetch(payloadBody({ preview: false, autoSend: true, promptText: '直达提示词' }))
let created
let sentText
ctx.get = name => {
  if (name === 'uiWorkspace') return { openSession: id => { created = id } }
  if (name === 'sessions') {
    return {
      create: async () => 'session-new',
      retain: () => ({
        ready: Promise.resolve(),
        binding: { session: { prompt: async content => { sentText = JSON.stringify(content); return { ok: true } } } },
        release: () => {},
      }),
    }
  }
  return undefined
}
const direct = await face.run('session-1', { workspaceId: 'ws-1' })
check('preview=false 时直达发送', direct.mode === 'sent' && created === 'session-new' && (sentText ?? '').includes('直达提示词'))

// --- 5. 端点缺失 ---
env.state.fetch = fakeFetch({ ok: false, message: 'not found' }, 404)
let failure
try {
  await face.run('session-1', {})
} catch (cause) {
  failure = cause
}
check('404 提示宿主端点未注册', typeof failure?.message === 'string' && failure.message.includes('端点未注册'), failure?.message)

// --- 6. 快捷键 resolve ---
exports.__testing.activeSession.clear()
check('无活跃会话时快捷键 blocked', shortcut.command.resolve().status === 'blocked')
exports.__testing.activeSession.set('session-9', {})
check('有活跃会话时快捷键 handled', shortcut.command.resolve().status === 'handled')

// --- 7. 座位降级 ---
{
  const env2 = makeBrowser()
  const setup = makeCtx({ failSeats: ['conversation.input.right', 'shell.overlay'] })
  loadPlugin(env2, setup.ctx)
  check('input.right 不可用时降级到标题栏', setup.registrations.some(entry => entry.options.name === 'conversation.session.header.utilities'))
  check('overlay 不可用时插件仍加载', setup.registrations.some(entry => entry.options.name === 'conversation.session.header.utilities'))
  check('shortcuts 缺失时不抛错', loadPlugin(makeBrowser(), makeCtx({ shortcuts: false }).ctx) !== undefined)
}

// --- 8. locale ---
{
  const env3 = makeBrowser()
  const dictionaries = []
  const setup = makeCtx({ locale: { register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} } } })
  loadPlugin(env3, setup.ctx)
  check('注册 handoff 词典', dictionaries.length === 1 && dictionaries[0].ns === 'handoff' && dictionaries[0].dict.zh['action.label'] === '接力到新会话')
}

// --- 9. 客户端提示词组装 ---
const composed = exports.composePrompt(parts)
check('composePrompt 渲染四处引用', composed.includes(parts.docPath) && composed.includes('## 参考文件') && composed.includes('- `src/a.ts`'))
check('composePrompt 空参考文件时省略小节', !exports.composePrompt(parts, []).includes('## 参考文件'))

const total = passes.length + failures.length
process.stdout.write(`\ndsh-session-handoff client smoke: ${passes.length}/${total} passed\n`)
for (const pass of passes) process.stdout.write(`  PASS  ${pass}\n`)
for (const failure of failures) process.stdout.write(`  FAIL  ${failure}\n`)
if (failures.length > 0) process.exit(1)
process.stdout.write('\n浏览器半冒烟全部通过。\n')
