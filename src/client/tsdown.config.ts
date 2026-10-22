/**
 * 浏览器半构建：复刻 DSH 上游「模块工厂」产物形态。
 *
 * banner/intro/footer 三行与 deepseek-harness/packages/client/tsdown.client.ts:663-669
 * 保持一致：产物是一个 window.__ModuleLoader__.load({ id, factory }) 调用，
 * 依赖经注入的 require 从宿主模块表解析，不打包 react 副本。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

/** 基线模块：只从宿主模块表取，绝不打进产物。 */
const BASELINE_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

export default defineConfig({
  name: 'dsh-session-handoff/client',
  cwd: packageRoot,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: { neverBundle: BASELINE_MODULES },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-session-handoff", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
