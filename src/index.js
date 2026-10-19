import z from '@deepseek-ai/schemastery'
import { WorkspacePluginManager } from './manager.js'
import { workspaceInstructions, workspaceToolPolicy } from './builtins.js'
import { fail } from './policy.js'

export const name = 'dsh-workspace-plugin-manager'
export const inject = ['agents', 'workspaceRegistry', 'systemPrompt', 'settings', 'connection']
export const Config = z.object({
  workspaces: z.array(z.object({
    workspaceId: z.string(),
    plugins: z.array(z.object({ id: z.string(), enabled: z.boolean(), config: z.any() })),
  })).default([]),
}).default({ workspaces: [] }).volatile()
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
  ctx.provide('workspacePlugins', manager)
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
  installLifecycle(ctx, manager)
  async function snapshot() {
    const view = manager.snapshot()
    const inventory = ctx.get('pluginManager')
    const bundles = inventory ? await inventory.listBundles() : []
    view.globalPlugins = bundles.filter(b => b.name !== 'dsh-workspace-plugin-manager' && (b.installed || b.enabled)).map(b => ({ name: b.name, enabled: b.enabled }))
    return view
  }
  ctx.effect(() => ctx.connection.register(ctx, '/dsh-workspace-plugin-manager', async (endpoint, payload) => {
    try {
      if (endpoint === 'snapshot') return { ok: true, value: await snapshot() }
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
