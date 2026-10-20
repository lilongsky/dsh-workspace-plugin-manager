import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { WorkspacePluginManager } from '../src/manager.js'
import { installLifecycle } from '../src/index.js'
import { workspaceInstructions, workspaceToolPolicy } from '../src/builtins.js'

async function fixture(t) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools, {})
  let document = { workspaces: [] }
  const agents = []
  const workspaces = [{ id: 'a', title: 'A', path: '/tmp/wpm-test-a' }, { id: 'b', title: 'B', path: '/tmp/wpm-test-b' }]
  const manager = new WorkspacePluginManager({ ctx, agents: () => agents, workspaces: () => workspaces, readDocument: () => document, writeDocument: async value => { document = value } })
  manager.register(workspaceInstructions); manager.register(workspaceToolPolicy)
  installLifecycle(ctx, manager)
  async function agent(id, workspace) {
    const a = { id, status: 'idle', phase: { kind: 'idle' }, session: { id, header: { cwd: workspaces.find(w => w.id === workspace).path } }, inbox: { nextTurn: [], nextStep: [] } }
    const scope = createScope(ctx, a); a.ctx = scope.ctx; a.dispose = () => scope.dispose(); agents.push(a)
    await ctx.serial('agent/created', { agent: a })
    return a
  }
  const assemble = agent => ctx.get('systemPrompt').assemble({ scope: agent, agent, signal: new AbortController().signal })
  const text = async agent => (await assemble(agent)).sections.find(s => s.name === 'workspace-manager:instructions')?.text
  const set = (w, id, enabled, config = {}) => manager.update(w, id, { enabled, config })
  t.after(async () => { await manager.dispose(); for (const a of agents) await a.dispose(); await ctx.fiber.dispose() })
  return { ctx, manager, agent, agents, workspaces, assemble, text, set }
}

test('native scoped prompts: simultaneous A/B requests use independent settings', async t => {
  const f = await fixture(t)
  await f.set('a', 'workspace-instructions', true, { text: 'A instruction' })
  await f.set('b', 'workspace-instructions', true, { text: 'B instruction' })
  const [a, b] = await Promise.all([f.agent('a1', 'a'), f.agent('b1', 'b')])
  assert.deepEqual(await Promise.all([f.text(a), f.text(b), f.text(a), f.text(b)]), ['A instruction', 'B instruction', 'A instruction', 'B instruction'])
  assert.equal((await f.ctx.get('systemPrompt').assemble()).sections.some(s => s.name === 'workspace-manager:instructions'), false)
})
test('saving A does not change the in-flight registration; next assembly updates A only', async t => {
  const f = await fixture(t)
  await f.set('a', 'workspace-instructions', true, { text: 'A old' }); await f.set('b', 'workspace-instructions', true, { text: 'B' })
  const a = await f.agent('a', 'a'), b = await f.agent('b', 'b')
  await f.set('a', 'workspace-instructions', true, { text: 'A new' })
  const before = await f.ctx.get('systemPrompt').assemble({ scope: a })
  assert.equal(before.sections.find(s => s.name === 'workspace-manager:instructions').text, 'A old')
  assert.deepEqual(await Promise.all([f.text(a), f.text(b)]), ['A new', 'B'])
})
test('turning A off leaves B enabled and does not unload the global service', async t => {
  const f = await fixture(t)
  await f.set('a', 'workspace-instructions', true, { text: 'A' }); await f.set('b', 'workspace-instructions', true, { text: 'B' })
  const a = await f.agent('a', 'a'), b = await f.agent('b', 'b')
  await f.set('a', 'workspace-instructions', false)
  assert.deepEqual(await Promise.all([f.text(a), f.text(b)]), [undefined, 'B'])
  assert.ok(f.ctx.get('systemPrompt'))
})
test('native ToolRuntime: A mask never hides the tool from B or Host', async t => {
  const f = await fixture(t)
  f.ctx.get('tools').register({ name: 'example_tool', description: 'native test tool', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'ok' })
  await f.set('a', 'workspace-tool-policy', true, { deniedTools: ['example_tool'] })
  const a = await f.agent('a', 'a'), b = await f.agent('b', 'b')
  const tools = f.ctx.get('tools')
  assert.equal(tools.get('example_tool', a), undefined)
  assert.ok(tools.get('example_tool', b)); assert.ok(tools.get('example_tool'))
  await f.set('a', 'workspace-tool-policy', false)
  await f.assemble(a); assert.ok(tools.get('example_tool', a))
})
test('two conversations in one workspace receive the same configuration independently', async t => {
  const f = await fixture(t)
  await f.set('a', 'workspace-instructions', true, { text: 'same workspace' })
  const [a1, a2] = await Promise.all([f.agent('a1', 'a'), f.agent('a2', 'a')])
  await a1.dispose()
  assert.equal(await f.text(a2), 'same workspace')
})
test('configuration validation and global-only classification reject fake workspace control', async t => {
  const f = await fixture(t)
  f.manager.register({ id: 'global-example', scope: 'global', title: 'Global-only', fields: {}, defaults: {} })
  await assert.rejects(f.set('a', 'global-example', true), { code: 'unsupported-plugin' })
  await assert.rejects(f.set('a', 'workspace-instructions', true, { text: false }), { code: 'invalid-config' })
  await assert.rejects(f.set('missing', 'workspace-instructions', true), { code: 'invalid-workspace' })
  assert.equal(f.manager.snapshot().document.workspaces.length, 0)
})
test('concurrent saves to different workspaces preserve both records', async t => {
  const f = await fixture(t)
  await Promise.all([f.set('a', 'workspace-instructions', true, { text: 'A' }), f.set('b', 'workspace-instructions', true, { text: 'B' })])
  const a = await f.agent('a', 'a'), b = await f.agent('b', 'b')
  assert.deepEqual(await Promise.all([f.text(a), f.text(b)]), ['A', 'B'])
})
test('restore defaults removes only that plugin override', async t => {
  const f = await fixture(t)
  await f.set('a', 'workspace-instructions', true, { text: 'A' }); await f.set('b', 'workspace-instructions', true, { text: 'B' })
  await f.manager.update('a', 'workspace-instructions', null)
  const a = await f.agent('a', 'a'), b = await f.agent('b', 'b')
  assert.deepEqual(await Promise.all([f.text(a), f.text(b)]), [undefined, 'B'])
})
function migration(f, execute) {
  f.manager.register({ id: 'migration-example', scope: 'cross-workspace', fields: { note: { type: 'string', title: 'note' } }, defaults: { note: '' }, execute })
  return (source = 'a', target = 'b', sessionId = 'a') => f.manager.runCrossWorkspace('migration-example', source, target, { sessionId })
}
test('migration: target disabled rejects on Host before the handler runs', async t => {
  const f = await fixture(t); let called = false
  const run = migration(f, async () => { called = true })
  await f.agent('a', 'a'); await f.set('a', 'migration-example', true)
  await assert.rejects(run(), { code: 'workspace-disabled' }); assert.equal(called, false)
})
test('migration: source disabled also rejects', async t => {
  const f = await fixture(t); const run = migration(f, async () => assert.fail('must not execute'))
  await f.agent('a', 'a'); await f.set('b', 'migration-example', true)
  await assert.rejects(run(), { code: 'workspace-disabled' })
})
test('migration: both enabled passes separate configs and rebinds the next request to B', async t => {
  const f = await fixture(t)
  f.workspaces[0].nativeMethod = () => assert.fail('live registry methods must not be transferred')
  const run = migration(f, async ({ agent, source, target }) => {
    assert.equal(source.config.note, 'source'); assert.equal(target.config.note, 'target')
    assert.equal('nativeMethod' in source, false)
    // Test adapter only: no real session file is migrated in this test.
    agent.session.header.cwd = target.path
    return { moved: true }
  })
  await f.set('a', 'workspace-instructions', true, { text: 'A' }); await f.set('b', 'workspace-instructions', true, { text: 'B' })
  await f.set('a', 'migration-example', true, { note: 'source' }); await f.set('b', 'migration-example', true, { note: 'target' })
  const a = await f.agent('a', 'a')
  assert.deepEqual(await run(), { moved: true }); assert.equal(await f.text(a), 'B')
})
test('migration: running or queued session is rejected, unrelated conversation can continue', async t => {
  const f = await fixture(t); const run = migration(f, async () => assert.fail('must not execute'))
  await f.set('a', 'migration-example', true); await f.set('b', 'migration-example', true)
  const a = await f.agent('a', 'a'), b = await f.agent('b', 'b')
  a.status = 'running'; await assert.rejects(run(), { code: 'session-busy' })
  a.status = 'idle'; a.inbox.nextTurn.push({}); await assert.rejects(run(), { code: 'session-busy' })
  await f.assemble(b)
})
test('migration: false source identity cannot authorize the move', async t => {
  const f = await fixture(t); const run = migration(f, async () => assert.fail('must not execute'))
  await f.agent('a', 'a'); await f.set('a', 'migration-example', true); await f.set('b', 'migration-example', true)
  await assert.rejects(run('b', 'a'), { code: 'source-mismatch' })
})
test('a restarted manager recovers settings from its supplied persistent document', async t => {
  const f = await fixture(t)
  await f.set('a', 'workspace-instructions', true, { text: 'persisted' })
  const saved = f.manager.snapshot().document
  const manager = new WorkspacePluginManager({ ctx: f.ctx, workspaces: () => f.workspaces, agents: () => [], readDocument: () => saved, writeDocument: async () => {} })
  manager.register(workspaceInstructions)
  assert.deepEqual(manager.snapshot().document, saved)
  await manager.dispose()
})
test('unloading manager releases all scoped prompt registrations', async t => {
  const f = await fixture(t); await f.set('a', 'workspace-instructions', true, { text: 'A' }); const a = await f.agent('a', 'a')
  await f.manager.dispose()
  const assembly = await f.ctx.get('systemPrompt').assemble({ scope: a })
  assert.equal(assembly.sections.some(s => s.name === 'workspace-manager:instructions'), false)
})

test('removed adapter preferences survive without blocking unrelated edits', async t => {
  const f = await fixture(t)
  const remove = f.manager.register({ id: 'temporary-plugin', scope: 'workspace', defaults: {}, fields: {}, mount() {} })
  await f.set('a', 'temporary-plugin', true)
  remove()
  await f.set('b', 'workspace-instructions', true, { text: 'B remains editable' })
  const snapshot = f.manager.snapshot()
  assert.ok(snapshot.document.workspaces.find(w => w.workspaceId === 'a').plugins.some(p => p.id === 'temporary-plugin'))
  assert.equal(snapshot.plugins.some(p => p.id === 'temporary-plugin'), false)
})

test('an adapter activation error blocks assembly and cleans up its partial registrations', async t => {
  const f = await fixture(t)
  f.manager.register({ id: 'broken-plugin', scope: 'workspace', defaults: {}, fields: {}, mount(ctx) {
    ctx.get('systemPrompt').section({ name: 'broken:partial', order: 98, text: 'must be removed' })
    throw new Error('expected adapter error')
  } })
  const a = await f.agent('a', 'a')
  await f.set('a', 'broken-plugin', true)
  await assert.rejects(f.assemble(a), /expected adapter error/)
  const safe = await f.ctx.get('systemPrompt').assemble({ scope: a })
  assert.equal(safe.sections.some(s => s.name === 'broken:partial'), false)
})

test('changing into a workspace subdirectory keeps its settings; leaving registered workspaces releases them', async t => {
  const f = await fixture(t)
  await f.set('a', 'workspace-instructions', true, { text: 'project A' })
  const a = await f.agent('a', 'a')
  a.session.header.cwd += '/src'
  assert.equal(await f.text(a), 'project A')
  a.session.header.cwd = '/tmp/unregistered-project'
  assert.equal(await f.text(a), undefined)
})
