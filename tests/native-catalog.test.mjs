import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { WorkspacePluginManager } from '../src/manager.js'
import { NativePluginCatalog, nativeId } from '../src/native-catalog.js'
import { publicConfig, retainSecrets } from '../src/config-data.js'
import { installLifecycle } from '../src/index.js'

async function fixture(t, overrides = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools, {})
  const module = { inject: ['systemPrompt'], Config: z.object({ text: z.string().default('base'), secret: z.string().role('secret').default('') }),
    apply(ctx, config) { ctx.get('systemPrompt').section({ name: 'ordinary-plugin', order: 96, text: config.text }) }, ...overrides }
  const entry = { id: 'include:ordinary', options: { id: 'ordinary', name: 'ordinary-plugin', config: { text: 'base', secret: 'fixture-only' } }, disabled: true, moduleNamespace: module }
  const calls = []
  const rows = () => [{ entryId: entry.id, moduleName: entry.options.name, enabled: !entry.disabled }]
  ctx.provide('loader', { entries: () => [entry], unwrapExports: p => p.default ?? p })
  ctx.provide('pluginManager', { listPlugins: async () => rows(), listBundles: () => [{ name: 'ordinary-bundle', installed: true, enabled: true }],
    setPluginEnabled: async (id, enabled) => { calls.push(['plugin', id, enabled]); entry.disabled = !enabled; return { application: 'applied' } },
    setBundleEnabled: async (...args) => { calls.push(['bundle', ...args]); return { application: 'restart-required' } } })
  let document = { workspaces: [], nativePlugins: [] }
  const agents = []
  const workspaces = [{ id: 'a', path: '/tmp/catalog-a' }, { id: 'b', path: '/tmp/catalog-b' }]
  const manager = new WorkspacePluginManager({ ctx, agents: () => agents, workspaces: () => workspaces, readDocument: () => document, writeDocument: async value => { document = value } })
  const catalog = new NativePluginCatalog(ctx, manager)
  manager.beforeReconcile = () => catalog.sync()
  installLifecycle(ctx, manager)
  async function agent(id, workspace) {
    const agent = { id, session: { header: { cwd: workspaces.find(w => w.id === workspace).path } }, status: 'idle' }
    const scope = createScope(ctx, agent); agent.ctx = scope.ctx; agent.dispose = () => scope.dispose(); agents.push(agent)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  const text = async agent => (await ctx.get('systemPrompt').assemble({ agent, scope: agent })).sections.find(s => s.name === 'ordinary-plugin')?.text
  const set = (workspaceId, text, enabled = true) => manager.update(workspaceId, nativeId(entry.id), { enabled, config: { settings: { text } } })
  t.after(async () => { await manager.dispose(); for (const agent of agents) await agent.dispose(); await ctx.fiber.dispose() })
  return { ctx, manager, catalog, entry, calls, agent, text, set, document: () => document }
}

test('ordinary Cordis plugin needs no adapter: independent A/B config and disable', async t => {
  const f = await fixture(t)
  await f.catalog.manage(f.entry.id, true)
  await f.set('a', 'native A'); await f.set('b', 'native B')
  const [a, b] = await Promise.all([f.agent('a', 'a'), f.agent('b', 'b')])
  assert.deepEqual(await Promise.all([f.text(a), f.text(b)]), ['native A', 'native B'])
  await f.set('a', 'native A', false)
  assert.deepEqual(await Promise.all([f.text(a), f.text(b)]), [undefined, 'native B'])
  assert.equal((await f.ctx.get('systemPrompt').assemble()).sections.some(s => s.name === 'ordinary-plugin'), false)
})

test('native Config validates workspace settings before persistence', async t => {
  const f = await fixture(t); await f.catalog.manage(f.entry.id, true)
  await assert.rejects(f.manager.update('a', nativeId(f.entry.id), { enabled: true, config: { settings: { text: false } } }))
  assert.equal(f.document().workspaces.length, 0)
})

test('global enable and duplicate activation are refused for a managed plugin', async t => {
  const f = await fixture(t); await f.catalog.manage(f.entry.id, true); await f.set('a', 'A')
  const a = await f.agent('a', 'a')
  await assert.rejects(f.catalog.setEnabled('plugin', f.entry.id, true), { code: 'workspace-owned' })
  f.entry.disabled = false
  await assert.rejects(f.text(a), { code: 'global-conflict' })
  assert.deepEqual(f.calls, [])
})

test('active global plugins and cross-workspace dependencies cannot be silently taken over', async t => {
  const f = await fixture(t)
  f.entry.disabled = false
  await assert.rejects(f.catalog.manage(f.entry.id, true), { code: 'global-conflict' })
  f.entry.disabled = true; f.entry.moduleNamespace.inject = ['connection', 'workspaceRegistry']
  await assert.rejects(f.catalog.manage(f.entry.id, true), { code: 'global-dependencies' })
  assert.deepEqual(f.document().nativePlugins, [])
})

test('inventory explains global management while preserving native controls', async t => {
  const f = await fixture(t, { inject: ['connection', 'workspaceRegistry'] })
  let row = (await f.catalog.snapshot()).plugins[0]
  assert.equal(row.managementScope, 'global')
  assert.equal(row.workspaceSupport.status, 'global')
  assert.match(row.workspaceSupport.reason, /connection, workspaceRegistry/)
  await assert.rejects(f.catalog.manage(f.entry.id, true), { code: 'global-dependencies' })
  assert.equal((await f.catalog.setEnabled('plugin', f.entry.id, true)).application, 'applied')
  row = (await f.catalog.snapshot()).plugins[0]
  assert.equal(row.enabled, true)
  assert.equal(row.managementScope, 'global')
  assert.equal(row.managed, false)
})

test('inventory does not import inactive modules and distinguishes candidates from managed entries', async t => {
  const f = await fixture(t)
  const namespace = f.entry.moduleNamespace
  f.entry.moduleNamespace = undefined
  f.entry.parent = { tree: { import() { throw new Error('inventory must not execute inactive code') } } }
  assert.equal((await f.catalog.snapshot()).plugins[0].workspaceSupport.status, 'unchecked')
  f.entry.moduleNamespace = namespace
  assert.equal((await f.catalog.snapshot()).plugins[0].workspaceSupport.status, 'candidate')
  assert.equal((await f.catalog.snapshot()).plugins[0].managementScope, 'global')
  await f.catalog.manage(f.entry.id, true)
  assert.equal((await f.catalog.snapshot()).plugins[0].managementScope, 'workspace')
})

test('known root service providers stay global after their active instance stops', async t => {
  const f = await fixture(t, { inject: [] })
  const fiber = f.ctx.plugin({ apply(ctx) { ctx.provide('fixtureGlobalService', {}) } })
  await fiber.await()
  f.entry.fiber = fiber.ctx.fiber
  let support = (await f.catalog.snapshot()).plugins[0].workspaceSupport
  assert.equal(support.status, 'global')
  assert.match(support.reason, /fixtureGlobalService/)
  await fiber.dispose(); f.entry.fiber = undefined
  support = (await f.catalog.snapshot()).plugins[0].workspaceSupport
  assert.equal(support.status, 'global')
  await assert.rejects(f.catalog.manage(f.entry.id, true), { code: 'global-services' })
})

test('native API outcomes and identity are retained, including restart requirements', async t => {
  const f = await fixture(t)
  assert.equal((await f.catalog.setEnabled('plugin', f.entry.id, true)).application, 'applied')
  assert.equal((await f.catalog.setEnabled('bundle', 'ordinary-bundle', false)).application, 'restart-required')
  assert.deepEqual(f.calls, [['plugin', f.entry.id, true], ['bundle', 'ordinary-bundle', false]])
})

test('workspace snapshots redact native secrets while edits preserve their stored values', async t => {
  const f = await fixture(t); await f.catalog.manage(f.entry.id, true); await f.set('a', 'A')
  assert.equal(JSON.stringify(f.manager.snapshot()).includes('fixture-only'), false)
  assert.equal(f.document().workspaces[0].plugins[0].config.settings.secret, 'fixture-only')
  await f.set('a', 'A next')
  assert.equal(f.document().workspaces[0].plugins[0].config.settings.secret, 'fixture-only')
})

test('root service providers fail activation and release their global service', async t => {
  const f = await fixture(t, { inject: [], apply(ctx) { ctx.provide('mustNotLeak', {}) } })
  await f.catalog.manage(f.entry.id, true); await f.set('a', 'A')
  await assert.rejects(f.agent('a', 'a'), { code: 'global-services' })
  assert.equal(f.ctx.get('mustNotLeak'), undefined)
})

test('releasing native management removes scoped contributions at the next boundary', async t => {
  const f = await fixture(t); await f.catalog.manage(f.entry.id, true); await f.set('a', 'A')
  const a = await f.agent('a', 'a')
  await f.catalog.manage(f.entry.id, false)
  assert.equal(await f.text(a), undefined)
  assert.equal(f.entry.disabled, true)
})

test('a replaced native module is rebound at the next boundary', async t => {
  const f = await fixture(t); await f.catalog.manage(f.entry.id, true); await f.set('a', 'A')
  const a = await f.agent('a', 'a')
  f.entry.moduleNamespace = { ...f.entry.moduleNamespace, apply(ctx, config) { ctx.get('systemPrompt').section({ name: 'ordinary-plugin', order: 96, text: 'updated ' + config.text }) } }
  assert.equal(await f.text(a), 'updated A')
})

test('native config schema redacts nested secrets and avoids credential shifts in lists', () => {
  const schema = z.object({ rows: z.array(z.object({ name: z.string(), password: z.string().role('secret') })) })
  const current = { rows: [{ name: 'a', password: 'fixture-password' }] }
  assert.equal(JSON.stringify(publicConfig(schema, current)).includes('fixture-password'), false)
  assert.deepEqual(retainSecrets(schema, current, { rows: [{ name: 'changed' }] }), { rows: [{ name: 'changed', password: 'fixture-password' }] })
  assert.throws(() => retainSecrets(schema, current, { rows: [] }), { code: 'secret-array-edit' })
})
