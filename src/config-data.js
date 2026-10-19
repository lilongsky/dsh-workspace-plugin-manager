import { createHash } from 'node:crypto'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { clone, fail } from './policy.js'

export const configRevision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function publicConfig(schema, value) {
  return schema ? { ...redactSecrets(schema, value), schema: schema.toJSON() } : { value: clone(value), secrets: [] }
}

// A redacted JSON editor omits secrets. Preserve those omissions server-side;
// an explicit replacement value still changes the secret.
export function retainSecrets(schema, current, input) {
  const next = clone(input)
  for (const secret of publicConfig(schema, current).secrets) {
    if (!secret.set) continue
    if (!secret.path.length) return input === undefined ? clone(current) : next
    let before = current, after = next
    for (let index = 0; index < secret.path.length; index++) {
      const key = secret.path[index]
      if (Array.isArray(before) && (!Array.isArray(after) || before.length !== after.length)) fail('secret-array-edit', '含隐藏密钥的列表须保持长度；请通过原生配置页调整列表成员')
      if (after === null || typeof after !== 'object') fail('secret-container-edit', '包含隐藏密钥的配置节点不能整体删除')
      if (index === secret.path.length - 1) {
        if (!Object.hasOwn(after, key)) Object.defineProperty(after, key, { value: clone(before[key]), enumerable: true, configurable: true, writable: true })
      } else {
        if (!Object.hasOwn(after, key)) Object.defineProperty(after, key, { value: Array.isArray(before[key]) ? [] : {}, enumerable: true, configurable: true, writable: true })
        before = before[key]; after = after[key]
      }
    }
  }
  return next
}
