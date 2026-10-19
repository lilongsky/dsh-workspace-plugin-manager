import { createRequire, registerHooks } from 'node:module'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const sdkPath = process.env.DSH_NATIVE_ROOT
if (!sdkPath) throw new Error('Set DSH_NATIVE_ROOT to an isolated DSH SDK directory before running verification')
const root = resolve(sdkPath)
const sdkURL = pathToFileURL(root + sep).href
const sdkRequire = createRequire(resolve(root, 'package.json'))
let resolving = false

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sdkURL)) return nextResolve(specifier, context)
    if (specifier.startsWith('@deepseek-ai/') && !resolving) {
      resolving = true
      try { return { url: pathToFileURL(sdkRequire.resolve(specifier)).href, shortCircuit: true } }
      finally { resolving = false }
    }
    return nextResolve(specifier, context)
  },
})
