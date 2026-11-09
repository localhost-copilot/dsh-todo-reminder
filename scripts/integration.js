import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const harness = resolve(process.env.DSH_SOURCE ?? resolve(root, '../deepseek-harness'))
const tsx = resolve(harness, 'node_modules/tsx/dist/esm/index.mjs')
const runtime = process.env.DSH_RUNTIME
if (!runtime && !existsSync(tsx)) {
  throw new Error('Set DSH_SOURCE to a DeepSeek Harness source checkout with dependencies installed (including tsx).')
}
const result = spawnSync(process.execPath, [
  ...runtime ? [] : ['--import', pathToFileURL(tsx).href],
  '--import', fileURLToPath(new URL(runtime ? './dsh-runtime-loader.js' : './dsh-source-loader.js', import.meta.url)),
  '--test', fileURLToPath(new URL('../test/integration.spec.js', import.meta.url)),
], { cwd: root, env: { ...process.env, DSH_SOURCE: harness }, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
