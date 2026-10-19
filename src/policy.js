export class WorkspacePluginError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkspacePluginError'; this.code = code }
}
export function fail(code, message) { throw new WorkspacePluginError(code, message) }
export function clone(value) { return structuredClone(value) }
export function validateConfig(descriptor, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-config', '插件配置必须是对象')
  const result = clone(descriptor.defaults ?? {})
  for (const key of Object.keys(input)) {
    const field = descriptor.fields?.[key]
    if (!field) fail('invalid-config', `未知配置项：${key}`)
    const value = input[key]
    const valid = field.type === 'boolean' ? typeof value === 'boolean'
      : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : field.type === 'string-list' ? Array.isArray(value) && value.every(v => typeof v === 'string')
      : typeof value === 'string'
    if (!valid || (field.options && !field.options.includes(value))) fail('invalid-config', `配置项格式错误：${key}`)
    result[key] = clone(value)
  }
  descriptor.validate?.(result)
  return result
}
export function validateDocument(document, descriptors, workspaceIds) {
  if (!document || !Array.isArray(document.workspaces)) fail('invalid-document', '缺少工作区配置列表')
  const seen = new Set()
  for (const workspace of document.workspaces) {
    if (!workspaceIds.has(workspace.workspaceId) || seen.has(workspace.workspaceId)) fail('invalid-workspace', '工作区不存在或重复')
    seen.add(workspace.workspaceId)
    if (!Array.isArray(workspace.plugins)) fail('invalid-document', '缺少插件配置列表')
    const ids = new Set()
    for (const row of workspace.plugins) {
      const descriptor = descriptors.get(row.id)
      if (!descriptor || descriptor.scope === 'global' || ids.has(row.id)) fail('unsupported-plugin', `不能为此插件保存工作区覆盖：${row.id}`)
      if (typeof row.enabled !== 'boolean') fail('invalid-config', '插件开关必须为布尔值')
      ids.add(row.id)
      validateConfig(descriptor, row.config)
    }
  }
  return clone(document)
}
export function effective(document, workspaceId, descriptor) {
  const row = document.workspaces.find(w => w.workspaceId === workspaceId)?.plugins.find(p => p.id === descriptor.id)
  return {
    enabled: row?.enabled ?? descriptor.enabledByDefault ?? false,
    config: validateConfig(descriptor, row?.config),
    inherited: row === undefined,
  }
}
