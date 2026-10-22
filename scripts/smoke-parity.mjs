#!/usr/bin/env node
/**
 * 提示词一致性：宿主半产出的 promptText 必须与浏览器半 composePrompt(promptParts) 逐字一致。
 *
 * 否则预览卡里「取消勾选参考文件后重建提示词」会与服务端默认提示词产生偏差。
 * 做法：真实 lib/index.js 跑一次 prepare 拿 promptText/promptParts，再把真实
 * lib/client.js 加载进 Node vm 取 composePrompt 比对。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { apply } = await import('../lib/index.js')

const failures = []
const passes = []
function check(name, condition, detail = '') {
  if (condition) passes.push(name)
  else failures.push(`${name}${detail === '' ? '' : `：${detail}`}`)
}

const cwd = await mkdtemp(join(tmpdir(), 'dsh-handoff-parity-'))
const routes = new Map()
const ctx = {
  webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
  logger: { info() {}, warn() {} },
  sessionQuery: {
    async readSession(id) {
      return {
        session: { id, title: '一致性测试', cwd, createdAt: Date.UTC(2026, 9, 23) },
        events: [
          { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '把交接提示词做成可编辑的' }], source: { kind: 'user' } } },
          { type: 'assistant/message', seq: 2, time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: '已实现 preview 卡。' }] } } },
          { type: 'tool/call', seq: 3, time: 3, data: { name: 'write', callId: 'c1', arguments: JSON.stringify({ path: 'src/client/preview.ts' }) } },
          { type: 'tool/result', seq: 4, time: 4, data: { message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] } } },
        ],
      }
    },
  },
}
apply(ctx, { dir: '.dsh-handoff', writeMemory: false })

function makeReq(body) {
  async function* iterate() { yield Buffer.from(body) }
  return Object.assign(iterate(), { method: 'POST', headers: { 'x-dsh-handoff': '1' } })
}
function makeRes() {
  return { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = String(body ?? '') } }
}
const res = makeRes()
routes.get('/session-handoff/prepare')(makeReq(JSON.stringify({ sessionId: 'session-parity' })), res)
const deadline = Date.now() + 10_000
while (res.body === '' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
const result = JSON.parse(res.body)
check('prepare 成功', result.ok === true, result.message)

// 加载真实浏览器半，取 composePrompt
const code = await readFile(join(root, 'lib/client.js'), 'utf8')
let captured
const fakeReact = {
  createElement: () => null, useState: () => [undefined, () => {}], useCallback: fn => fn,
  useEffect: () => {}, useSyncExternalStore: () => undefined,
}
const window = { __ModuleLoader__: { load: entry => { captured = entry } } }
const context = {
  window,
  document: { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} }, body: { appendChild: () => {} }, querySelectorAll: () => [] },
  navigator: { language: 'zh-CN' },
  console: { log: () => {}, warn: () => {}, error: () => {} },
  setTimeout, clearTimeout, URL, Promise,
}
vm.runInNewContext(code, context, { filename: 'lib/client.js' })
const client = captured.factory(specifier => {
  if (specifier === 'react') return fakeReact
  if (specifier === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement }
  throw new Error(`unexpected require: ${specifier}`)
})

const composed = client.composePrompt(result.promptParts)
check('客户端 composePrompt 与服务端 promptText 逐字一致', composed === result.promptText, `client=${composed.length}B server=${result.promptText.length}B`)
check('默认参考文件即分段里的 references', result.promptParts.references.length > 0 && composed.includes('- `' + result.promptParts.references[0] + '`'))
check('清空参考文件后不渲染该小节', !client.composePrompt(result.promptParts, []).includes('## 参考文件'))
check('分段包含候选参考文件与交接要求', result.promptParts.referenceOptions.length >= result.promptParts.references.length && result.promptParts.requirements.length === 4)

await rm(cwd, { recursive: true, force: true })

const total = passes.length + failures.length
process.stdout.write(`\ndsh-session-handoff parity: ${passes.length}/${total} passed\n`)
for (const pass of passes) process.stdout.write(`  PASS  ${pass}\n`)
for (const failure of failures) process.stdout.write(`  FAIL  ${failure}\n`)
if (failures.length > 0) process.exit(1)
process.stdout.write('\n提示词一致性通过。\n')
