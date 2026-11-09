// Test against a shipped CLI or Desktop runtime, keeping its Cordis and DSH instances together.
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const anchor = pathToFileURL(resolve(process.env.DSH_RUNTIME, 'package.json')).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, specifier.startsWith('@deepseek-ai/')
      ? { ...context, parentURL: anchor }
      : context)
  },
})
