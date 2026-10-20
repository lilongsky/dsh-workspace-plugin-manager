import z from '@deepseek-ai/schemastery'
import { WorkspacePluginManager } from './manager.js'
import { workspaceInstructions, workspaceToolPolicy } from './builtins.js'
import { fail } from './policy.js'
import { NativePluginCatalog } from './native-catalog.js'

export const name = 'dsh-workspace-plugin-manager'
export const inject = ['agents', 'workspaceRegistry', 'systemPrompt', 'settings', 'connection']
export const Config = z.object({
  workspaces: z.array(z.object({
    workspaceId: z.string(),
    plugins: z.array(z.object({ id: z.string(), enabled: z.boolean(), config: z.any() })),
  })).default([]),
  nativePlugins: z.array(z.object({ entryId: z.string() })).default([]),
}).default({ workspaces: [], nativePlugins: [] }).volatile()
const ENTRY_ID = 'workspace-plugin-manager'

export function installLifecycle(ctx, manager) {
  ctx.on('agent/created', ({ agent }) => manager.ensure(agent))
  ctx.on('agent/disposed', ({ agent }) => manager.detach(agent))
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (!context.agent) return next()
    const changed = await manager.ensure(context.agent)
    return changed ? ctx.get('systemPrompt').assemble(context) : next()
  }, { prepend: true })
  ctx.effect(() => () => manager.dispose())
}

export function apply(ctx, config) {
  const manager = new WorkspacePluginManager({
    ctx,
    workspaces: () => ctx.workspaceRegistry.list(),
    agents: () => ctx.agents.list(),
    readDocument: () => config.get(),
    writeDocument: document => ctx.settings.update(ENTRY_ID, document),
  })
  manager.register(workspaceInstructions)
  manager.register(workspaceToolPolicy)
  const catalog = new NativePluginCatalog(ctx, manager)
  manager.beforeReconcile = () => catalog.sync()
  ctx.provide('workspacePlugins', manager)
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
  installLifecycle(ctx, manager)
  async function snapshot() {
    await catalog.sync()
    const view = manager.snapshot()
    const inventory = ctx.get('pluginManager')
    const bundles = inventory ? await inventory.listBundles() : []
    view.globalPlugins = bundles.filter(b => b.name !== 'dsh-workspace-plugin-manager' && (b.installed || b.enabled)).map(b => ({ name: b.name, enabled: b.enabled }))
    view.inventory = await catalog.snapshot()
    return view
  }
  ctx.effect(() => ctx.connection.register(ctx, '/dsh-workspace-plugin-manager', async (endpoint, payload) => {
    try {
      if (endpoint === 'snapshot') return { ok: true, value: await snapshot() }
      if (endpoint === 'native-enabled') {
        const result = await catalog.setEnabled(payload?.kind, payload?.id, payload?.enabled)
        return { ok: true, value: { result, snapshot: await snapshot() } }
      }
      if (endpoint === 'config-read') return { ok: true, value: catalog.readConfig(payload?.entryId) }
      if (endpoint === 'config-write') return { ok: true, value: await catalog.writeConfig(payload?.entryId, payload?.value, payload?.revision) }
      if (endpoint === 'native-manage') {
        await catalog.manage(payload?.entryId, payload?.enabled)
        return { ok: true, value: await snapshot() }
      }
      if (endpoint === 'update') {
        const { workspaceId, pluginId, override } = payload ?? {}
        if (typeof workspaceId !== 'string' || typeof pluginId !== 'string') fail('bad-request', '缺少工作区或插件标识')
        await manager.update(workspaceId, pluginId, override)
        return { ok: true, value: await snapshot() }
      }
      fail('bad-request', '未知操作')
    } catch (error) { return { ok: false, error: { code: error.code ?? 'internal', message: error.message } } }
  }))
}
