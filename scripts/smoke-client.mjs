#!/usr/bin/env node
/**
 * 浏览器半冒烟：在 Node vm 里加载真实的 lib/client.js（模块工厂产物），
 * 用假的 window/document/react/ctx 跑 apply() 与按钮的 run 链路。
 *
 * 覆盖：座位注册（含降级）、草稿路径、autoSend 路径、端点失败提示。
 * 不覆盖 React 渲染本身——那属于 DSH 框架，不是插件逻辑。
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

/** 造一个假浏览器环境，返回 window 与可替换的 fetch。 */
function makeBrowser() {
  const styles = []
  const document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: node => { styles.push(node); } },
    body: { appendChild: () => {} },
    querySelectorAll: () => [],
  }
  const window = { __ModuleLoader__: null }
  const state = { styles, fetch: null }
  let captured
  window.__ModuleLoader__ = {
    load: (entry) => { captured = entry },
  }
  const context = {
    window,
    document,
    navigator: { language: 'zh-CN' },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    fetch: (...args) => state.fetch(...args),
    URL,
    Promise,
  }
  vm.runInNewContext(code, context, { filename: 'lib/client.js' })
  return { window, state, document, captured: () => captured, context }
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: fn => fn,
  useEffect: () => {},
}

// 有 React 运行时就把组件真正渲染一遍（SSR）；没有则跳过这两项。
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

/** 造一个收集注册的客户端 ctx。 */
function makeCtx({ failSeats = [], locale = undefined } = {}) {
  const registrations = []
  const injections = []
  const ctx = {
    slots: {
      inject(key, callback) {
        if (failSeats.includes(key)) throw new Error(`seat ${key} unavailable`)
        injections.push(key)
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
  }
  return { ctx, registrations }
}

function loadPlugin(env, ctx) {
  const entry = env.captured()
  if (entry === undefined) throw new Error('bundle 未调用 __ModuleLoader__.load')
  const factory = entry.factory
  const exports = factory(specifier => {
    if (specifier === 'react') return reactImpl
    if (specifier === 'react/jsx-runtime') {
      return jsxRuntime ?? { jsx: fakeReact.createElement, jsxs: fakeReact.createElement }
    }
    throw new Error(`unexpected require: ${specifier}`)
  })
  exports.apply(ctx)
  return exports
}

// --- 1. 正常路径：注册到 input.right，注入面可用 ---
{
  const env = makeBrowser()
  const { ctx, registrations } = makeCtx()
  const exports = loadPlugin(env, ctx)
  check('bundle id 正确', env.captured()?.id === 'dsh-session-handoff')
  check('导出 apply/inject', typeof exports.apply === 'function' && Array.isArray(exports.inject))
  check('座位列表包含 input.right 优先', ctx.slotsProvided !== undefined || registrations.some(r => r.options.name === 'conversation.input.right'))
  const seat = registrations.find(r => r.options.name === 'conversation.input.right')
  check('注册项 id 为 session-handoff', seat?.options.id === 'session-handoff')
  check('注册项 order=40', seat?.options.order === 40)
  check('注册项带 inject 工厂', typeof seat?.options.inject === 'function')
  check('组件是函数', typeof seat?.component === 'function')
  check('注入了样式', env.state.styles.length === 1 && env.state.styles[0].id === 'dsh-session-handoff-style')

  if (typeof renderToString === 'function' && realReact !== undefined) {
    const html = renderToString(realReact.createElement(seat.component, {
      sessionId: 'session-1',
      useWorkspaces: () => undefined,
      useSession: () => undefined,
    }))
    check('组件可真实渲染（SSR）', typeof html === 'string' && html.includes('dsh-handoff-btn'))
    check('按钮可访问名正确', html.includes('aria-label="总结当前会话并打开新会话继续"'))
    check('按钮带中文 tooltip', html.includes('title="接力到新会话"'))
    check('初始态未禁用', !html.includes('disabled=""'))
  } else {
    check('跳过 SSR（未安装 react-dom）', true)
    check('跳过 SSR 可访问名', true)
    check('跳过 SSR tooltip', true)
    check('跳过 SSR 初始态', true)
  }

  // 点击链路：草稿路径
  const face = seat.options.inject()
  check('注入面提供 run', typeof face.run === 'function')
  let opened
  env.state.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, promptText: '# 会话接力：测试', title: '测试', autoSend: false }),
  })
  ctx.get = name => {
    if (name === 'uiWorkspace') return { startSession: (workspaceId, options) => { opened = { workspaceId, options } } }
    if (name === 'locale') return undefined
    return undefined
  }
  const result = await face.run('session-1', { workspaceId: 'ws-1' })
  check('草稿路径返回 mode=draft', result.mode === 'draft' && result.title === '测试')
  check('草稿调用 startSession(workspaceId,{prompt})', opened?.workspaceId === 'ws-1' && opened?.options?.prompt?.includes('会话接力'))

  // autoSend 路径
  let sent
  let openedId
  env.state.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, promptText: '接力提示词', title: '自动发送', autoSend: true }),
  })
  ctx.get = name => {
    if (name === 'uiWorkspace') return { openSession: id => { openedId = id }, startSession: () => {} }
    if (name === 'sessions') return {
      create: async options => { sent = { options }; return 'session-new' },
      retain: () => ({ ready: Promise.resolve(), binding: { session: { prompt: async (content, mode) => { sent.prompt = { content, mode }; return { ok: true } } } }, release: () => {} }),
    }
    return undefined
  }
  const auto = await face.run('session-1', {})
  check('autoSend 返回 mode=sent', auto.mode === 'sent')
  check('autoSend 入队一轮', sent?.prompt?.mode === 'queue' && JSON.stringify(sent?.prompt?.content).includes('接力提示词'))
  check('autoSend 打开新会话', openedId === 'session-new')

  // 宿主端点缺失
  env.state.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, message: 'not found' }) })
  let error
  try {
    await face.run('session-1', {})
  } catch (cause) {
    error = cause
  }
  check('404 提示宿主端点未注册', typeof error?.message === 'string' && error.message.includes('端点未注册'), error?.message)
}

// --- 2. 座位降级 ---
{
  const env = makeBrowser()
  const { ctx, registrations } = makeCtx({ failSeats: ['conversation.input.right'] })
  loadPlugin(env, ctx)
  check('input.right 不可用时降级到标题栏', registrations.length === 1 && registrations[0].options.name === 'conversation.session.header.utilities')
}

// --- 3. locale 可用时注册词典 ---
{
  const env = makeBrowser()
  const dictionaries = []
  const { ctx, registrations } = makeCtx({ locale: { register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} } } })
  loadPlugin(env, ctx)
  check('注册 handoff 词典', dictionaries.length === 1 && dictionaries[0].ns === 'handoff' && dictionaries[0].dict.zh['action.label'] === '接力到新会话')
  check('注册项带 locale 命名空间', registrations[0].options.locale === 'handoff')
}

const total = passes.length + failures.length
process.stdout.write(`\ndsh-session-handoff client smoke: ${passes.length}/${total} passed\n`)
for (const pass of passes) process.stdout.write(`  PASS  ${pass}\n`)
for (const failure of failures) process.stdout.write(`  FAIL  ${failure}\n`)
if (failures.length > 0) process.exit(1)
process.stdout.write('\n浏览器半冒烟全部通过。\n')
