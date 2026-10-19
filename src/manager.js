import { isAbsolute, relative, resolve } from 'node:path'
import { clone, effective, fail, validateConfig, validateDocument } from './policy.js'
import { publicConfig } from './config-data.js'

/** Owns scoped instances; profile operations go through the native catalog. */
export class WorkspacePluginManager {
  constructor({ ctx, workspaces, agents, readDocument, writeDocument }) {
    Object.assign(this, { ctx, workspaces, agents, readDocument, writeDocument })
    this.descriptors = new Map()
    this.bindings = new Map()
    this.queues = new Map()
    this.operationQueues = new Map()
    this.writeQueue = Promise.resolve()
    this.closed = false
  }
  register(descriptor) {
    if (this.closed) fail('disposed', '管理器已停止')
    if (!descriptor || !/^[a-z0-9][a-z0-9._-]*$/.test(descriptor.id) || this.descriptors.has(descriptor.id)) fail('invalid-plugin', '插件标识无效或重复')
    if (!['workspace', 'cross-workspace', 'global'].includes(descriptor.scope)) fail('invalid-plugin', '插件必须声明作用范围')
    if (descriptor.scope === 'workspace' && typeof descriptor.mount !== 'function') fail('invalid-plugin', '工作区插件必须提供 mount')
    if (descriptor.scope === 'cross-workspace' && typeof descriptor.execute !== 'function') fail('invalid-plugin', '跨工作区插件必须提供 execute')
    validateConfig(descriptor, descriptor.defaults)
    const record = { ...descriptor, fields: clone(descriptor.fields ?? {}), defaults: clone(descriptor.defaults ?? {}) }
    this.descriptors.set(record.id, record)
    return () => { if (this.descriptors.get(record.id) === record) this.descriptors.delete(record.id) }
  }
  workspaceFor(agent) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string') fail('workspace-not-found', '对话没有工作目录')
    const matches = this.workspaces().filter(w => {
      const child = relative(resolve(w.path), resolve(cwd))
      return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\'))
    }).sort((a, b) => resolve(b.path).length - resolve(a.path).length)
    if (!matches.length || (matches[1] && resolve(matches[0].path) === resolve(matches[1].path))) fail('workspace-not-found', '对话工作目录没有唯一的工作区归属')
    return matches[0]
  }
  snapshot() {
    const document = clone(this.readDocument())
    for (const workspace of document.workspaces) for (const row of workspace.plugins) {
      const descriptor = this.descriptors.get(row.id)
      if (descriptor?.native) row.config.settings = descriptor.native.unavailable ? {} : publicConfig(descriptor.native.schema, row.config.settings).value
      else if (row.id.startsWith('native.')) row.config = {}
    }
    return {
      workspaces: this.workspaces().map(w => ({ id: w.id, title: w.title, path: w.path })),
      plugins: [...this.descriptors.values()].map(d => ({
        id: d.id, title: d.title ?? d.id, description: d.description ?? '', scope: d.scope,
        fields: clone(d.fields), defaults: d.native ? { settings: publicConfig(d.native.schema, d.defaults.settings).value } : clone(d.defaults), enabledByDefault: d.enabledByDefault ?? false,
        native: d.native ? { entryId: d.native.entryId, schema: d.native.schema?.toJSON() } : undefined,
      })),
      document: clone(document),
    }
  }
  update(workspaceId, pluginId, override) {
    const run = this.writeQueue.then(async () => {
      if (this.closed) fail('disposed', '管理器已停止')
      if (override !== null && (!override || typeof override !== 'object' || Array.isArray(override) || Object.keys(override).some(k => !['enabled', 'config'].includes(k)))) fail('invalid-config', '工作区覆盖只接受开关和配置')
      const document = clone(this.readDocument())
      const descriptor = this.descriptors.get(pluginId)
      if (override !== null && descriptor?.prepareConfig) override = { ...override, config: descriptor.prepareConfig(effective(document, workspaceId, descriptor).config, override.config) }
      let workspace = document.workspaces.find(w => w.workspaceId === workspaceId)
      if (!workspace) document.workspaces.push(workspace = { workspaceId, plugins: [] })
      workspace.plugins = workspace.plugins.filter(p => p.id !== pluginId)
      if (override !== null) workspace.plugins.push({ id: pluginId, enabled: override.enabled, config: clone(override.config ?? {}) })
      if (!descriptor || descriptor.scope === 'global') fail('unsupported-plugin', '此插件没有工作区独立配置接口')
      // Validate the edited workspace/plugin only. Preferences belonging to a
      // removed adapter or a removed workspace must remain intact and must not
      // prevent editing an unrelated, still-supported plugin.
      validateDocument({ workspaces: [{ workspaceId, plugins: workspace.plugins.filter(p => p.id === pluginId) }] }, this.descriptors, new Set(this.workspaces().map(w => w.id)))
      await this.writeDocument(document)
      // Existing fibers remain intact until their next prompt assembly.
      return this.snapshot()
    })
    this.writeQueue = run.catch(() => {})
    return run
  }
  editDocument(change) {
    const run = this.writeQueue.then(async () => {
      if (this.closed) fail('disposed', '管理器已停止')
      await this.writeDocument(change(clone(this.readDocument())))
    })
    this.writeQueue = run.catch(() => {})
    return run
  }
  ensure(agent) {
    const previous = this.queues.get(agent.id) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => this.reconcile(agent))
    this.queues.set(agent.id, run)
    void run.finally(() => { if (this.queues.get(agent.id) === run) this.queues.delete(agent.id) }).catch(() => {})
    return run
  }
  async reconcile(agent) {
    if (this.closed) fail('disposed', '管理器已停止')
    await this.beforeReconcile?.()
    let workspace
    try { workspace = this.workspaceFor(agent) }
    catch (error) {
      if (error.code !== 'workspace-not-found') throw error
      const changed = this.bindings.has(agent.id)
      await this.releaseBinding(agent.id)
      return changed
    }
    const document = this.readDocument()
    const desired = [...this.descriptors.values()].filter(d => d.scope === 'workspace').map(descriptor => ({ descriptor, ...effective(document, workspace.id, descriptor) }))
    for (const item of desired) if (item.enabled) await item.descriptor.check?.()
    const old = this.bindings.get(agent.id)
    const key = JSON.stringify([workspace.id, desired.map(d => [d.descriptor.id, d.enabled, d.config])])
    if (old?.agent === agent && old.key === key && desired.every(d => old.records.get(d.descriptor.id)?.descriptor === d.descriptor)) return false
    await this.releaseBinding(agent.id)
    const binding = { agent, workspaceId: workspace.id, key, records: new Map() }
    this.bindings.set(agent.id, binding)
    try {
      for (const item of desired) {
        if (!item.enabled) { binding.records.set(item.descriptor.id, { descriptor: item.descriptor }); continue }
        let activate, reject
        const ready = new Promise((yes, no) => { activate = yes; reject = no })
        const fiber = agent.ctx.plugin({
          name: `workspace-managed:${item.descriptor.id}`,
          apply: async child => {
            try {
              const stop = await item.descriptor.mount(child, clone(item.config), { agent, workspace: clone({ id: workspace.id, path: workspace.path, title: workspace.title }) })
              if (typeof stop === 'function') child.effect(() => stop)
              activate()
            } catch (error) { reject(error); throw error }
          },
        })
        binding.records.set(item.descriptor.id, { descriptor: item.descriptor, fiber })
        await ready
      }
      return true
    } catch (error) {
      await this.releaseBinding(agent.id)
      throw error
    }
  }
  async releaseBinding(id) {
    const binding = this.bindings.get(id)
    this.bindings.delete(id)
    if (binding) for (const record of [...binding.records.values()].reverse()) await record.fiber?.dispose()
  }
  async detach(agent) {
    await this.queues.get(agent.id)?.catch(() => {})
    if (this.bindings.get(agent.id)?.agent === agent) await this.releaseBinding(agent.id)
  }
  runCrossWorkspace(pluginId, sourceId, targetId, payload) {
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) return Promise.reject(new Error('迁移操作必须指定对话'))
    const previous = this.operationQueues.get(sessionId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      await this.writeQueue
      const descriptor = this.descriptors.get(pluginId)
      if (!descriptor || descriptor.scope !== 'cross-workspace') fail('unsupported-plugin', '插件未接入跨工作区操作接口')
      const source = this.workspaces().find(w => w.id === sourceId)
      const target = this.workspaces().find(w => w.id === targetId)
      if (!source || !target || sourceId === targetId) fail('invalid-workspace', '来源或目标工作区无效')
      const agent = this.agents().find(a => a.id === sessionId)
      if (!agent || this.workspaceFor(agent).id !== sourceId) fail('source-mismatch', '对话不属于指定来源工作区')
      if (agent.status !== 'idle' || (agent.phase && agent.phase.kind !== 'idle') || (agent.inbox?.nextTurn?.length ?? 0) || (agent.inbox?.nextStep?.length ?? 0)) fail('session-busy', '请等待该对话完成当前工作和待处理输入')
      const document = this.readDocument()
      const a = effective(document, sourceId, descriptor), b = effective(document, targetId, descriptor)
      if (!a.enabled || !b.enabled) fail('workspace-disabled', '来源和目标工作区都必须启用此插件')
      // WorkspaceRegistry returns live objects. Pass only their public data,
      // never try to clone storage handles or methods into an operation.
      const result = await descriptor.execute({
        source: { id: source.id, title: source.title, path: source.path, config: a.config },
        target: { id: target.id, title: target.title, path: target.path, config: b.config },
        payload: clone(payload), agent,
      })
      // A real migration adapter must update durable placement itself. The
      // next assembly also reconciles placement, including after agent rebuild.
      if (this.workspaceFor(agent).id !== sourceId) await this.ensure(agent)
      return result
    })
    this.operationQueues.set(sessionId, run)
    void run.finally(() => { if (this.operationQueues.get(sessionId) === run) this.operationQueues.delete(sessionId) }).catch(() => {})
    return run
  }
  async dispose() {
    this.closed = true
    await this.writeQueue
    await Promise.allSettled([...this.queues.values(), ...this.operationQueues.values()])
    for (const id of [...this.bindings.keys()]) await this.releaseBinding(id)
    this.descriptors.clear()
  }
}
