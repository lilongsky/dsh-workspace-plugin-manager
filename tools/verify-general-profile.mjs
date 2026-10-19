import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createScope } from '@deepseek-ai/dsh-scope'
import { nativeId } from '../src/native-catalog.js'
import { createNativeFixture } from './native-fixture.mjs'

const fixture = await createNativeFixture({ nativeCatalog: true })
let ctx
const request = async (endpoint, payload) => {
  const result = await fixture.rpc(endpoint, payload)
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}
try {
  ctx = await fixture.start()
  let snapshot = await request('snapshot')
  assert.equal(snapshot.inventory.available, true)
  const owner = snapshot.inventory.plugins.find(p => p.entryId.endsWith(':workspace-plugin-manager'))
  assert.equal(owner.readOnlyReason, 'manager-required')
  const protectedOwner = await fixture.rpc('native-enabled', { kind: 'plugin', id: owner.entryId, enabled: false })
  assert.equal(protectedOwner.error.code, 'protected-plugin')
  const row = snapshot.inventory.plugins.find(p => p.entryId.endsWith(':ordinary-native'))
  assert.ok(row)
  const initial = await request('config-read', { entryId: row.entryId })
  assert.equal(JSON.stringify(initial).includes('fixture-credential-only'), false)
  const changed = await request('config-write', { entryId: row.entryId, revision: initial.revision, value: { text: 'global changed' } })
  const invalid = await fixture.rpc('config-write', { entryId: row.entryId, revision: changed.revision, value: { text: false } })
  assert.equal(invalid.ok, false)
  const stale = await fixture.rpc('config-write', { entryId: row.entryId, revision: initial.revision, value: { text: 'stale' } })
  assert.equal(stale.error.code, 'config-conflict')
  const result = await request('native-enabled', { kind: 'plugin', id: row.entryId, enabled: false })
  assert.equal(result.result.application, 'restart-required')
  await ctx.fiber.dispose(); ctx = await fixture.start()
  await request('native-manage', { entryId: row.entryId, enabled: true })
  for (const [workspaceId, text] of [['a', 'ordinary A'], ['b', 'ordinary B']]) {
    await request('update', { workspaceId, pluginId: nativeId(row.entryId), override: { enabled: true, config: { settings: { text } } } })
  }
  const patch = await readFile(fixture.profile.patchPath, 'utf8')
  assert.ok(patch.includes('ordinary A') && patch.includes('ordinary B') && patch.includes('fixture-credential-only'))
  await ctx.fiber.dispose(); ctx = await fixture.start()
  snapshot = await request('snapshot')
  assert.equal(JSON.stringify(snapshot).includes('fixture-credential-only'), false)
  const prompts = []
  for (const workspace of fixture.workspaces) {
    const agent = { id: workspace.id, status: 'idle', session: { header: { cwd: workspace.path } } }
    const scope = createScope(ctx, agent); agent.ctx = scope.ctx; fixture.agents.push(agent)
    await ctx.serial('agent/created', { agent })
    prompts.push((await ctx.get('systemPrompt').assemble({ agent, scope: agent })).sections.find(s => s.name === 'ordinary-native')?.text)
  }
  assert.deepEqual(prompts, ['ordinary A', 'ordinary B'])
  assert.equal((await ctx.get('systemPrompt').assemble()).sections.some(s => s.name === 'ordinary-native'), false)
  const conflict = await fixture.rpc('native-enabled', { kind: 'plugin', id: row.entryId, enabled: true })
  assert.equal(conflict.error.code, 'workspace-owned')
  const summary = { status: 'pass', nativeInventory: true, nativeConfigPersistence: true, nativeSchemaValidation: true, staleWriteRejected: true, secretsRedactedAndRetained: true, nativeRestartRequirement: true, ordinaryPluginWithoutAdapter: true, persistedAfterReconstruction: true, prompts, modelRequests: 0, liveDshConnections: 0, liveProfileWrites: 0 }
  await writeFile(join(fixture.evidence, 'general-profile-result.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary))
} finally { await ctx?.fiber.dispose() }
