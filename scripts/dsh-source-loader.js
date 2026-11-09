// Test-only resolution: use one coherent set of current harness sources without rebuilding or editing it.
import { registerHooks, createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const harness = process.env.DSH_SOURCE
const packages = new Map()
for (const group of readdirSync(join(harness, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const entry of readdirSync(join(harness, 'packages', group.name), { withFileTypes: true })) {
    if (entry.isDirectory()) add(join(harness, 'packages', group.name, entry.name))
  }
}
for (const entry of readdirSync(join(harness, 'vendor'), { withFileTypes: true })) {
  if (entry.isDirectory()) add(join(harness, 'vendor', entry.name))
}
function add(directory) {
  const manifest = join(directory, 'package.json')
  if (!existsSync(manifest)) return
  const info = JSON.parse(readFileSync(manifest, 'utf8'))
  packages.set(info.name, directory)
}
const require = createRequire(new URL('../package.json', import.meta.url))
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      const [scope, name, ...subpath] = specifier.split('/')
      const directory = packages.get(`${scope}/${name}`)
      if (directory) {
        const part = subpath.join('/') || 'index'
        const base = resolve(directory, 'src', part.replace(/^src\//, '').replace(/\.js$/, ''))
        for (const candidate of [base + '.ts', join(base, 'index.ts'), base]) {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            return nextResolve(pathToFileURL(candidate).href, context)
          }
        }
      }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // Some local workspaces have stale node_modules links. Use this project's installed peers/deps only.
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !['zod', '@standard-schema/spec'].some(name =>
        specifier === name || specifier.startsWith(name + '/'))) throw error
      return nextResolve(pathToFileURL(require.resolve(specifier)).href, context)
    }
  },
})
