import { configRevision, publicConfig, retainSecrets } from './config-data.js'
import { clone, fail } from './policy.js'
import { Context } from '@deepseek-ai/cordis'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWN_MODULE = 'dsh-workspace-plugin-manager'
const SCOPED_SERVICES = new Set(['systemPrompt', 'tools', 'commands'])
export const nativeId = entryId => `native.${configRevision(entryId).slice(0, 20)}`
function moduleLabel(name) {
  const path = name.startsWith('file:') ? fileURLToPath(name) : name
  return isAbsolute(path) ? basename(path) : name
}

function dependencies(plugin) {
  const inject = plugin.inject ?? []
  return Array.isArray(inject) ? inject : Object.keys(inject)
}

// Root-realm ownership audit adapted from dsh-agent-preset-registry 0.2.1-rc.2,
// lib/types/mount.js (MIT). See THIRD_PARTY_NOTICES.md and the retained license.
// This audit checks Cordis services; it cannot audit arbitrary file/module state.
function rootServices(ctx, root) {
  const result = []
  for (const key of Object.getOwnPropertySymbols(ctx.reflect.store)) {
    const service = ctx.reflect.store[key]
    if (!service || ctx.root[Context.isolate]?.[service.name] !== key) continue
    let fiber = service.fiber
    while (fiber) {
      if (fiber === root) { result.push(service.name); break }
      const parent = fiber.parent.fiber
      if (parent === fiber) break
      fiber = parent
    }
  }
  return result
}

/** Native profile management plus direct loading of scoped Cordis modules. */
export class NativePluginCatalog {
  constructor(ctx, manager) { this.ctx = ctx; this.manager = manager; this.ownerEntryId = ctx.fiber.entry?.id; this.sources = new Map(); this.globalProviders = new WeakMap(); this.queue = Promise.resolve() }
  entry(id) {
    const entry = [...(this.ctx.get('loader')?.entries() ?? [])].find(row => row.id === id)
    if (!entry) fail('unknown-plugin', '插件条目不存在或已卸载')
    return entry
  }
  workspaceSupport(entry, readOnlyReason, namespace = entry?.moduleNamespace) {
    const global = (code, reason) => ({ status: 'global', code, reason })
    if (readOnlyReason) return global('unsupported-plugin', '受保护或无法独立寻址的条目保留全局管理')
    if (!entry) return global('unknown-plugin', '原生条目已移除')
    if (entry.options.group || entry.subtree) return global('unsupported-plugin', '组合树保留全局管理')
    if (entry.options.inject && Object.keys(entry.options.inject).length) return global('unsupported-plugin', '带独立服务拦截的条目保留全局管理')
    // Inventory must not import a disabled plugin just to classify it.
    if (namespace === undefined) return { status: 'unchecked', reason: '模块尚未加载，接管时检查入口与依赖' }
    const plugin = this.ctx.get('loader').unwrapExports(namespace)
    if (!plugin || (typeof plugin !== 'function' && typeof plugin.apply !== 'function')) return global('unsupported-plugin', '此模块没有可直接接管的 Cordis Host 入口')
    const provided = entry.fiber ? rootServices(this.ctx, entry.fiber.ctx.fiber) : []
    if (provided.length) this.globalProviders.set(namespace, provided)
    const services = this.globalProviders.get(namespace) ?? []
    if (services.length) return global('global-services', `已提供全局服务，保留全局管理：${services.join(', ')}`)
    const unsupported = dependencies(plugin).filter(name => !SCOPED_SERVICES.has(name))
    if (unsupported.length) return global('global-dependencies', `当前工作区模式不支持这些服务，保留全局管理：${unsupported.join(', ')}`)
    return { status: 'candidate', reason: '入口与依赖符合接管范围；插件须通过所提供的作用域注册贡献' }
  }
  async snapshot() {
    const service = this.ctx.get('pluginManager')
    if (!service?.listPlugins) return { available: false, bundles: [], plugins: [] }
    const [bundles, plugins] = await Promise.all([service.listBundles(), service.listPlugins()])
    const configurable = new Set((this.ctx.get('configEditor')?.entries() ?? []).filter(entry => entry.fiber?.state === 2).map(entry => entry.id))
    const entries = new Map([...(this.ctx.get('loader')?.entries() ?? [])].map(entry => [entry.id, entry]))
    return {
      available: true,
      bundles: bundles.filter(b => b.installed || b.enabled || b.availability !== 'missing').map(b => ({ name: b.name, version: b.version, enabled: b.enabled, installed: b.installed, error: b.error, readOnlyReason: b.readOnlyReason, protected: b.name === OWN_MODULE || !!b.readOnlyReason || (b.rows ?? []).some(row => row.entryId === this.ownerEntryId) })),
      plugins: [...plugins.map(p => {
        const readOnlyReason = p.moduleName === OWN_MODULE || p.entryId === this.ownerEntryId ? 'manager-required' : p.readOnlyReason
        const managed = this.sources.has(p.entryId)
        return { entryId: p.entryId, moduleName: p.moduleName, enabled: p.enabled, state: p.state, readOnlyReason, configurable: p.moduleName !== OWN_MODULE && p.entryId !== this.ownerEntryId && configurable.has(p.entryId), managed, managementScope: managed ? 'workspace' : 'global', workspaceSupport: this.workspaceSupport(entries.get(p.entryId), readOnlyReason), workspaceReason: this.sources.get(p.entryId)?.reason }
      }), ...[...this.sources].filter(([id]) => !plugins.some(p => p.entryId === id)).map(([id, source]) => ({ entryId: id, moduleName: id, enabled: false, managed: true, managementScope: 'workspace', workspaceSupport: this.workspaceSupport(), workspaceReason: source.reason ?? '原生条目已移除，可解除接管' }))],
    }
  }
  async setEnabled(kind, id, enabled) {
    if (typeof id !== 'string' || typeof enabled !== 'boolean' || !['plugin', 'bundle'].includes(kind)) fail('bad-request', '插件操作参数无效')
    const view = await this.snapshot()
    if (!view.available) fail('unavailable', '当前宿主没有原生插件管理服务')
    const row = (kind === 'plugin' ? view.plugins : view.bundles).find(p => (kind === 'plugin' ? p.entryId : p.name) === id)
    if (!row) fail('unknown-plugin', '插件或组合包不存在')
    if (row.readOnlyReason || row.protected) fail('protected-plugin', row.readOnlyReason ?? '管理器自身保持启用')
    if (kind === 'plugin' && enabled && row.managed) fail('workspace-owned', '请先解除工作区接管，再全局启用')
    const service = this.ctx.get('pluginManager')
    return kind === 'plugin' ? service.setPluginEnabled(id, enabled) : service.setBundleEnabled(id, enabled)
  }
  configEntry(id) {
    const entry = this.ctx.get('configEditor')?.entries().find(row => row.id === id)
    if (!entry || entry.id === this.ownerEntryId || entry.options.name === OWN_MODULE || entry.fiber?.state !== 2) fail('not-configurable', '此插件当前没有可编辑的活动配置')
    return entry
  }
  readConfig(id) {
    const entry = this.configEntry(id)
    const schema = entry.fiber.runtime?.Config
    const raw = entry.options.config ?? {}
    return { entryId: id, revision: configRevision(raw), ...publicConfig(schema?.toJSON ? schema : undefined, raw) }
  }
  async writeConfig(id, value, expected) {
    const entry = this.configEntry(id)
    if (typeof expected !== 'string') fail('bad-request', '保存配置需要读取时的版本')
    await this.ctx.get('configEditor').edit(entry, current => {
      if (configRevision(current) !== expected) fail('config-conflict', '配置已被其他页面修改，请刷新后重试')
      const schema = entry.fiber.runtime?.Config
      return retainSecrets(schema?.toJSON ? schema : undefined, current, value)
    })
    return this.readConfig(id)
  }
  async prepare(entryId) {
    const inventory = await this.snapshot()
    const row = inventory.plugins.find(p => p.entryId === entryId)
    if (!row || row.readOnlyReason) fail('unsupported-plugin', '此条目不能接管为工作区插件')
    const entry = this.entry(entryId)
    if (!entry.disabled) fail('global-conflict', '请先通过原生开关停用此全局条目，再接管到工作区')
    const existingSupport = this.workspaceSupport(entry, row.readOnlyReason)
    if (existingSupport.status === 'global') fail(existingSupport.code, existingSupport.reason)
    const loader = this.ctx.get('loader')
    const namespace = entry.moduleNamespace ?? await entry.parent.tree.import(entry.options.name)
    const support = this.workspaceSupport(entry, row.readOnlyReason, namespace)
    if (support.status !== 'candidate') fail(support.code ?? 'unsupported-plugin', support.reason)
    const plugin = loader.unwrapExports(namespace)
    const schema = plugin.Config?.toJSON ? plugin.Config : undefined
    const defaults = { settings: clone(entry.options.config ?? {}) }
    const descriptor = {
      id: nativeId(entryId), title: moduleLabel(entry.options.name), description: '按对话加载独立 Host 实例和配置；作用域注册分别生效。隐藏密钥在保存时保留。', scope: 'workspace',
      fields: { settings: { type: 'json', title: '插件配置（JSON）' } }, defaults,
      native: { entryId, schema },
      validate: config => { schema?.(clone(config.settings)) },
      prepareConfig: (current, incoming = {}) => Object.hasOwn(incoming, 'settings') ? { settings: retainSecrets(schema, current.settings, incoming.settings) } : clone(current),
      check: () => { if (!this.entry(entryId).disabled) fail('global-conflict', '被接管的条目已在其他页面全局启用，请先解决重复运行') },
      mount: async (ctx, config) => {
        const fiber = ctx.plugin(plugin, clone(config.settings))
        try {
          await fiber.await()
          if (fiber.state !== 2) fail('activation-failed', '插件依赖未满足或激活失败')
          // Cordis returns a tracked handle; service ownership stores the
          // underlying context's fiber, whose identity differs from the handle.
          const leaked = rootServices(ctx, fiber.ctx.fiber)
          if (leaked.length) fail('global-services', `此插件提供全局服务，不能作为工作区实例运行：${leaked.join(', ')}`)
          return () => fiber.dispose()
        } catch (error) { await fiber.dispose(); throw error }
      },
    }
    descriptor.validate(defaults)
    return descriptor
  }
  async sync() {
    const run = this.queue.catch(() => {}).then(async () => {
      const wanted = new Set((this.manager.readDocument().nativePlugins ?? []).map(p => p.entryId))
      for (const [id, source] of this.sources) if (!wanted.has(id)) { source.stop?.(); this.sources.delete(id) }
      for (const id of wanted) {
        const entry = [...(this.ctx.get('loader')?.entries() ?? [])].find(row => row.id === id)
        const signature = configRevision(entry ? [entry.options, entry.disabled] : null)
        const previous = this.sources.get(id)
        if (previous && previous.entry === entry && previous.signature === signature && previous.namespace === entry?.moduleNamespace) continue
        previous?.stop?.()
        this.sources.delete(id)
        try {
          const descriptor = await this.prepare(id)
          this.sources.set(id, { stop: this.manager.register(descriptor), entry, signature, namespace: entry?.moduleNamespace })
        } catch (error) {
          // One unavailable source must not prevent the settings page or
          // unrelated workspaces from loading. Its enabled instances fail.
          const descriptor = { id: nativeId(id), title: id, description: error.message, scope: 'workspace', fields: { settings: { type: 'json', title: '配置暂不可用' } }, defaults: { settings: {} }, native: { entryId: id, unavailable: true }, prepareConfig: current => clone(current), mount() { throw error } }
          this.sources.set(id, { stop: this.manager.register(descriptor), reason: error.message, entry, signature, namespace: entry?.moduleNamespace })
        }
      }
    })
    this.queue = run
    return run
  }
  async manage(entryId, enabled) {
    if (typeof entryId !== 'string' || typeof enabled !== 'boolean') fail('bad-request', '接管参数无效')
    if (enabled) await this.prepare(entryId)
    await this.manager.editDocument(document => {
      document.nativePlugins = (document.nativePlugins ?? []).filter(p => p.entryId !== entryId)
      if (enabled) document.nativePlugins.push({ entryId })
      return document
    })
    this.sources.get(entryId)?.stop?.()
    this.sources.delete(entryId)
    await this.sync()
  }
}
