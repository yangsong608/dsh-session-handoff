/**
 * 宿主半构建：ESM / node / 不压缩，产物 lib/index.js。
 * 运行期只允许 node: 内置模块；对 @deepseek-ai/* 的引用只允许 type-only（构建后擦除）。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  name: 'dsh-session-handoff/host',
  cwd: packageRoot,
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: false,
  outputOptions: { entryFileNames: 'index.js' },
})
