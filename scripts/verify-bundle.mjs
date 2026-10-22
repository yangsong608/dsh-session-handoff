#!/usr/bin/env node
/**
 * 产物自检：不启动 DSH，静态校验「装得上、找得到、不被宿主拒绝」的最小契约。
 *
 * 检查项：包声明 / patch / 两个产物 / 模块工厂包装与包 id / 座位 id / 外部依赖白名单 /
 * 宿主半不引用 @deepseek-ai/* 运行期模块 / 关键端点字符串。
 * 退出码非 0 表示不可发布。
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const passes = []
const baseline = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

function check(name, condition, detail = '') {
  if (condition) passes.push(name)
  else failures.push(`${name}${detail === '' ? '' : `：${detail}`}`)
}

async function read(path) {
  return await readFile(join(root, path), 'utf8')
}

const pkg = JSON.parse(await read('package.json'))
check('package.json name 为 dsh-session-handoff', pkg.name === 'dsh-session-handoff')
check('声明 dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string')
check('声明 dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
check('main 指向 lib/index.js', pkg.main === 'lib/index.js')
check('exports["."] 指向宿主半', pkg.exports?.['.']?.default === './lib/index.js')
check('exports["./client"] 指向浏览器半', pkg.exports?.['./client']?.default === './lib/client.js')
check('engines.dsh 锁定 0.2.x', />=0\.2\.\d+.*<0\.3\.0/.test(pkg.engines?.dsh ?? ''))
check('files 包含 lib 与 patch', (pkg.files ?? []).includes('lib') && (pkg.files ?? []).includes('cordis.patch.yml'))

const patch = await read('cordis.patch.yml')
check('patch 含 insert 行', /-\s*insert:/.test(patch))
check('patch 行 name 与包名一致', patch.includes('name: dsh-session-handoff'))
check('patch 行 id 存在', /id:\s*session-handoff/.test(patch))

for (const artifact of ['lib/index.js', 'lib/client.js']) {
  try {
    const info = await stat(join(root, artifact))
    check(`${artifact} 存在且非空`, info.size > 512, `size=${info.size}`)
  } catch {
    failures.push(`${artifact} 缺失（先运行 pnpm run bundle）`)
  }
}

let client = ''
try {
  client = await read('lib/client.js')
} catch {
  client = ''
}
if (client !== '') {
  check('浏览器半以 __ModuleLoader__.load 开头', client.trimStart().startsWith('window.__ModuleLoader__.load({'))
  check('浏览器半注册的 id 等于包名', client.includes('id: "dsh-session-handoff"'))
  check('浏览器半注册到 conversation.input.right 座位', client.includes('conversation.input.right'))
  check('浏览器半带降级座位 header.utilities', client.includes('conversation.session.header.utilities'))
  check('浏览器半不打包 react 副本', !/node_modules[\\/]react[\\/]/.test(client))
  const requires = [...client.matchAll(/require\((["'])([^"']+)\1\)/g)].map(match => match[2])
  const offenders = [...new Set(requires)].filter(specifier => !baseline.has(specifier))
  check('浏览器半的 require 仅限宿主基线模块', offenders.length === 0, offenders.join(', '))
  check('浏览器半请求宿主端点', client.includes('/session-handoff/prepare'))
  check('浏览器半带同源标记头', client.includes('x-dsh-handoff'))
}

let host = ''
try {
  host = await read('lib/index.js')
} catch {
  host = ''
}
if (host !== '') {
  check('宿主半导出 apply', /export\s*\{[^}]*\bapply\b/.test(host) || /export\s+function\s+apply/.test(host))
  check('宿主半声明 webServer 注入', /inject\s*=\s*\[[^\]]*["']webServer["']/.test(host))
  check('宿主半注册 prepare 路由', host.includes('/session-handoff/prepare'))
  check('宿主半注册 health 路由', host.includes('/session-handoff/health'))
  check('宿主半不 import @deepseek-ai 运行期模块', !/from\s*["']@deepseek-ai\//.test(host))
  check('宿主半只用 node 内置模块', (() => {
    const imports = [...host.matchAll(/from\s*["']([^"']+)["']/g)].map(match => match[1])
    return imports.every(specifier => specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'))
  })())
  check('宿主半写交接文档文件名', host.includes('WorkSummary.md'))
  check('宿主半写结构化数据', host.includes('handoff.json'))
}

const total = passes.length + failures.length
process.stdout.write(`\ndsh-session-handoff verify: ${passes.length}/${total} passed\n`)
for (const pass of passes) process.stdout.write(`  PASS  ${pass}\n`)
for (const failure of failures) process.stdout.write(`  FAIL  ${failure}\n`)
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} 项失败——不要发布此产物。\n`)
  process.exit(1)
}
process.stdout.write('\n全部通过。\n')
