#!/usr/bin/env node
/**
 * 宿主半端到端冒烟：用假的 ctx（webServer / sessionQuery / llm）+ 临时工作目录
 * 走完 prepare 的真实代码路径，断言交接文档、结构化数据、记忆台账、提示词与错误分支。
 *
 * 不启动 DSH、不安装插件、不联网：验证的是插件自己的契约与降级路径。
 */
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, VERSION } = await import('../lib/index.js')

const failures = []
const passes = []
function check(name, condition, detail = '') {
  if (condition) passes.push(name)
  else failures.push(`${name}${detail === '' ? '' : `：${detail}`}`)
}

const cwd = await mkdtemp(join(tmpdir(), 'dsh-handoff-smoke-'))
const routes = new Map()
const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  logger: { info() {}, warn() {} },
  effect: callback => callback(),
  sessionQuery: {
    async readSession(sessionId) {
      if (sessionId !== 'session-smoke') throw new Error('session not found: ' + sessionId)
      return {
        session: { id: sessionId, title: '冒烟测试会话', cwd, createdAt: Date.UTC(2026, 9, 23) },
        events: [
          { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '把插件仓库建好并推送' }], source: { kind: 'user' } } },
          { type: 'request/header', seq: 2, time: 2, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } } },
          { type: 'assistant/message', seq: 3, time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '先读 DSH 源码确认座位，再写文档。' }] } } },
          { type: 'tool/call', seq: 4, time: 4, data: { name: 'bash', callId: 'c1', arguments: JSON.stringify({ command: 'git status' }) } },
          { type: 'tool/result', seq: 5, time: 5, data: { message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'clean' }] } } },
          { type: 'tool/call', seq: 6, time: 6, data: { name: 'write', callId: 'c2', arguments: JSON.stringify({ path: 'docs/技术设计.md', content: 'x' }) } },
          { type: 'tool/result', seq: 7, time: 7, data: { message: { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'ENOENT' }] } } },
        ],
      }
    },
  },
  llm: {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '{"title":"建立会话接力插件",' }
      yield {
        type: 'text-delta', index: 0,
        text: '"summary":"已确认座位并生成文档","goal":"建好插件仓库并推送",'
          + '"completed":["确认 conversation.input.right 座位","生成技术/可行性/产品文档"],'
          + '"decisions":[{"decision":"用 input.right 座位","rationale":"官方 list 座位且为空"}],'
          + '"state":{"current":"产物已生成，待推送","files":["docs/技术设计.md"],"blockers":[]},'
          + '"nextSteps":[{"step":"推送 GitHub 仓库","why":"最后一步"}],'
          + '"memoryCandidates":[{"text":"第三方插件不 import @deepseek-ai 运行时模块","scope":"memory"}]}',
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}

apply(ctx, { dir: '.dsh-handoff', writeMemory: true })

function makeReq({ method = 'POST', headers = {}, body = '' } = {}) {
  async function* iterate() {
    if (body !== '') yield Buffer.from(body)
  }
  return Object.assign(iterate(), { method, headers, url: '/session-handoff/prepare' })
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = String(body ?? '') },
  }
}

async function call(path, request) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route ${path} 未注册`)
  const response = makeRes()
  handler(request, response)
  const deadline = Date.now() + 10_000
  while (response.body === '' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { status: response.status, json: JSON.parse(response.body || '{}') }
}

check('暴露版本号', VERSION === '0.2.2', VERSION)
check('注册 health 路由', routes.has('/session-handoff/health'))
check('注册 prepare 路由', routes.has('/session-handoff/prepare'))

const health = await call('/session-handoff/health', makeReq({ method: 'GET' }))
check('health 返回 ok 与能力', health.status === 200 && health.json.ok === true && typeof health.json.capabilities.llm === 'boolean')

const forbidden = await call('/session-handoff/prepare', makeReq({
  body: JSON.stringify({ sessionId: 'session-smoke' }),
}))
check('缺少同源标记头被拒绝', forbidden.status === 403 && forbidden.json.code === 'forbidden', `status=${forbidden.status}`)

const missing = await call('/session-handoff/prepare', makeReq({
  headers: { 'x-dsh-handoff': '1' },
  body: JSON.stringify({ sessionId: 'no-such-session' }),
}))
check('未知会话返回 404', missing.status === 404 && missing.json.code === 'session-not-found', `status=${missing.status} code=${missing.json.code}`)

const prepared = await call('/session-handoff/prepare', makeReq({
  headers: { 'x-dsh-handoff': '1' },
  body: JSON.stringify({ sessionId: 'session-smoke' }),
}))
check('prepare 成功', prepared.status === 200 && prepared.json.ok === true, `status=${prepared.status} ${prepared.json.message ?? ''}`)
const result = prepared.json
if (result.ok !== true) { console.error('prepare 失败：', result); process.exit(1) }
check('摘要走模型而非兜底', result.stats?.llm === true)
check('返回结构化提示词分段', result.promptParts?.title === '建立会话接力插件' && Array.isArray(result.promptParts.referenceOptions))
check('默认开启可编辑预览', result.preview === true)
check('提示词由分段组装且含文档与下一步', result.promptText.includes(result.docPath) && result.promptText.includes('推送 GitHub 仓库'))

check('标题来自模型', result.title === '建立会话接力插件')
check('提示词包含交接文档绝对路径', typeof result.promptText === 'string' && result.promptText.includes(result.docPath))
check('提示词包含下一步', (result.promptText ?? '').includes('推送 GitHub 仓库'))
check('返回 autoSend=false', result.autoSend === false)

const docStat = await stat(result.docPath)
check('交接文档已落盘', docStat.isFile() && docStat.size > 500, `size=${docStat.size}`)
const doc = await readFile(result.docPath, 'utf8')
for (const heading of ['## 目标与意图', '## 已完成', '## 当前状态', '## 下一步', '## 附录：工具活动', '## 记忆候选']) {
  check(`交接文档含「${heading}」`, doc.includes(heading))
}
check('交接文档记录了失败工具', doc.includes('失败'))
check('交接文档记录了参考文件', doc.includes('docs/技术设计.md'))

const dataFile = JSON.parse(await readFile(result.dataPath, 'utf8'))
check('结构化数据 schema 正确', dataFile.schema === 'dsh-session-handoff/v1')
check('结构化数据保留工具事实', dataFile.source.commands.includes('git status'))
check('结构化数据引用源会话', dataFile.source.sessionId === 'session-smoke')

const memory = await readFile(join(cwd, '.dsh-handoff', '交接记忆.md'), 'utf8')
check('记忆台账已写入', memory.includes('第三方插件不 import'))
check('记忆台账带维护说明', memory.includes('由 dsh-session-handoff 维护'))

const second = await call('/session-handoff/prepare', makeReq({
  headers: { 'x-dsh-handoff': '1' },
  body: JSON.stringify({ sessionId: 'session-smoke' }),
}))
const memoryAfter = await readFile(join(cwd, '.dsh-handoff', '交接记忆.md'), 'utf8')
check('二次生成不重复追加记忆', (memoryAfter.match(/第三方插件不 import/g) ?? []).length === 1)
check('二次生成目录不覆盖', second.json.docPath !== result.docPath)

// 降级路径：没有 llm、也没有可复用的会话路由时，仍必须产出可用交接文档。
const routes2 = new Map()
const ctx2 = {
  ...ctx,
  llm: undefined,
  webServer: { register(route) { routes2.set(route.path, route.handler); return () => routes2.delete(route.path) } },
  sessionQuery: {
    async readSession(sessionId) {
      const base = await ctx.sessionQuery.readSession(sessionId)
      return { ...base, events: base.events.filter(event => event.type !== 'request/header') }
    },
  },
}
apply(ctx2, { dir: '.dsh-handoff', writeMemory: false })
const handler2 = routes2.get('/session-handoff/prepare')
const res2 = makeRes()
handler2(makeReq({ headers: { 'x-dsh-handoff': '1' }, body: JSON.stringify({ sessionId: 'session-smoke' }) }), res2)
const deadline2 = Date.now() + 10_000
while (res2.body === '' && Date.now() < deadline2) await new Promise(resolve => setTimeout(resolve, 10))
const degraded = JSON.parse(res2.body)
check('无模型时仍成功出文档', degraded.ok === true && degraded.stats?.llm === false)
check('无模型时标记降级原因', (degraded.degraded ?? []).some(item => /llm-unavailable|no-model-route/.test(String(item))), JSON.stringify(degraded.degraded))
const degradedDoc = await readFile(degraded.docPath, 'utf8')
check('降级文档标记 deterministic', degradedDoc.includes('generated_by: dsh-session-handoff/deterministic'))
check('降级文档保留确定性事实', degradedDoc.includes('git status'))

// 会话没有绝对 cwd：必须 409 而不是写坏路径。
const routes3 = new Map()
const ctx3 = {
  ...ctx,
  webServer: { register(route) { routes3.set(route.path, route.handler); return () => routes3.delete(route.path) } },
  sessionQuery: { async readSession(id) { return { session: { id, title: '无目录会话' }, events: [] } } },
}
apply(ctx3, {})
const res3 = makeRes()
routes3.get('/session-handoff/prepare')(makeReq({ headers: { 'x-dsh-handoff': '1' }, body: JSON.stringify({ sessionId: 'session-smoke' }) }), res3)
const deadline3 = Date.now() + 10_000
while (res3.body === '' && Date.now() < deadline3) await new Promise(resolve => setTimeout(resolve, 10))
const noCwd = JSON.parse(res3.body)
check('无 cwd 会话返回 409', noCwd.ok === false && noCwd.code === 'no-cwd', JSON.stringify(noCwd))

// memoryFile 只接受纯文件名：越界配置回退，且绝不在工作区外落文件。
const cwd2 = await mkdtemp(join(tmpdir(), 'dsh-handoff-smoke2-'))
const routes4 = new Map()
const ctx4 = {
  ...ctx,
  webServer: { register(route) { routes4.set(route.path, route.handler); return () => routes4.delete(route.path) } },
  sessionQuery: { async readSession(id) { return { session: { id, title: '路径安全测试', cwd: cwd2 }, events: [] } } },
}
apply(ctx4, { provider: 'deepseek', model: 'deepseek-chat', memoryFile: '../escape.md', dir: '.dsh-handoff' })
const res4 = makeRes()
routes4.get('/session-handoff/prepare')(makeReq({ headers: { 'x-dsh-handoff': '1' }, body: JSON.stringify({ sessionId: 'session-smoke' }) }), res4)
const deadline4 = Date.now() + 10_000
while (res4.body === '' && Date.now() < deadline4) await new Promise(resolve => setTimeout(resolve, 10))
const escaped = JSON.parse(res4.body)
const outside = await stat(join(cwd2, '..', 'escape.md')).then(() => true).catch(() => false)
check('越界 memoryFile 不回退到工作区外', escaped.ok === true && outside === false, `outside=${outside}`)
check('越界 memoryFile 回退为默认台账', await stat(join(cwd2, '.dsh-handoff', '交接记忆.md')).then(() => true).catch(() => false))
await rm(cwd2, { recursive: true, force: true })

// 记忆台账写入失败：交接文档仍要成功产出（降级而不是整单失败）。
const cwd3 = await mkdtemp(join(tmpdir(), 'dsh-handoff-smoke3-'))
const routes5 = new Map()
const ctx5 = {
  ...ctx,
  webServer: { register(route) { routes5.set(route.path, route.handler); return () => routes5.delete(route.path) } },
  sessionQuery: { async readSession(id) { return { session: { id, title: '记忆失败测试', cwd: cwd3 }, events: [] } } },
}
apply(ctx5, { provider: 'deepseek', model: 'deepseek-chat', memoryFile: 'blocked.md', dir: '.dsh-handoff' })
// 用一个同名目录占位，让台账写入抛 EISDIR。
await mkdir(join(cwd3, '.dsh-handoff', 'blocked.md'), { recursive: true })
const res5 = makeRes()
routes5.get('/session-handoff/prepare')(makeReq({ headers: { 'x-dsh-handoff': '1' }, body: JSON.stringify({ sessionId: 'session-smoke' }) }), res5)
const deadline5 = Date.now() + 10_000
while (res5.body === '' && Date.now() < deadline5) await new Promise(resolve => setTimeout(resolve, 10))
const memoryFailed = JSON.parse(res5.body)
check('记忆写入失败仍返回成功', memoryFailed.ok === true, memoryFailed.message)
check('记忆失败标记为降级', (memoryFailed.degraded ?? []).some(item => String(item).includes('memory-write-failed')), JSON.stringify(memoryFailed.degraded))
check('降级后交接文档仍落盘', typeof memoryFailed.docPath === 'string' && (await stat(memoryFailed.docPath)).isFile())
await rm(cwd3, { recursive: true, force: true })

// 严格代理：模拟 cordis 插件作用域——未 inject 的服务直读必须抛错。
// 这是本次 "Handoff failed: cannot get property \"llm\" without inject" 的回归测试。
{
  const strictCwd = await mkdtemp(join(tmpdir(), 'dsh-handoff-strict-'))
  const services = {
    sessionQuery: {
      async readSession(id) {
        return { session: { id, title: '严格代理', cwd: strictCwd }, events: [] }
      },
    },
    llm: undefined,
    sessions: undefined,
  }
  const routes6 = new Map()
  const base = {
    webServer: { register(route) { routes6.set(route.path, route.handler); return () => {} } },
    logger: { info() {}, warn() {} },
    effect: callback => callback(),
    get(name) { return services[name] },
  }
  const strictCtx = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && prop in services) throw new Error(`cannot get property "${prop}" without inject`)
      return undefined
    },
  })
  let directThrew = false
  try { void strictCtx.llm } catch { directThrew = true }
  check('严格代理会拦截未注入服务直读', directThrew)
  apply(strictCtx, { dir: '.dsh-handoff', writeMemory: false })
  const res6 = makeRes()
  routes6.get('/session-handoff/prepare')(makeReq({ headers: { 'x-dsh-handoff': '1' }, body: JSON.stringify({ sessionId: 'session-strict' }) }), res6)
  const deadline6 = Date.now() + 10_000
  while (res6.body === '' && Date.now() < deadline6) await new Promise(resolve => setTimeout(resolve, 10))
  const strictResult = JSON.parse(res6.body)
  check('严格代理下 prepare 不因 llm 直读失败', strictResult.ok === true, strictResult.message)
  check('严格代理下走确定性降级', strictResult.stats?.llm === false)
  await rm(strictCwd, { recursive: true, force: true })
}

await rm(cwd, { recursive: true, force: true })

const total = passes.length + failures.length
process.stdout.write(`\ndsh-session-handoff smoke: ${passes.length}/${total} passed\n`)
for (const pass of passes) process.stdout.write(`  PASS  ${pass}\n`)
for (const failure of failures) process.stdout.write(`  FAIL  ${failure}\n`)
if (failures.length > 0) process.exit(1)
process.stdout.write('\n宿主半冒烟全部通过。\n')
