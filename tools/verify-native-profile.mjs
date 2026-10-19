import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createNativeFixture } from './native-fixture.mjs'

const { sdk, evidence, profileDir, profile, workspaces, agents, start, rpc } = await createNativeFixture()
let ctx
try {
  ctx = await start()
  const form = await ctx.get('settings').describe()
  assert.ok(JSON.stringify(form).includes('workspace-plugin-manager'))
  for (const [workspaceId, text] of [['a', 'Native A'], ['b', 'Native B']]) {
    const result = await rpc('update', { workspaceId, pluginId: 'workspace-instructions', override: { enabled: true, config: { text } } })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  const patch = await readFile(profile.patchPath, 'utf8')
  assert.ok(patch.includes('Native A') && patch.includes('Native B'))
  const before = await rpc('snapshot')
  await ctx.fiber.dispose()
  ctx = await start()
  const after = await rpc('snapshot')
  assert.deepEqual(after.value.document, before.value.document)
  const prompts = []
  for (const workspace of workspaces) {
    const agent = { id: workspace.id, status: 'idle', session: { header: { cwd: workspace.path } } }
    const scope = createScope(ctx, agent); agent.ctx = scope.ctx; agents.push(agent)
    await ctx.serial('agent/created', { agent })
    const assembly = await ctx.get('systemPrompt').assemble({ agent, scope: agent })
    prompts.push(assembly.sections.find(s => s.name === 'workspace-manager:instructions')?.text)
  }
  assert.deepEqual(prompts, ['Native A', 'Native B'])
  const result = { status: 'pass', sdk, temporaryProfile: profileDir, nativeSettingsPersistence: true, restartRecovery: true, prompts, modelRequests: 0, liveDshConnections: 0, liveProfileWrites: 0 }
  await writeFile(join(evidence, 'native-profile-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await ctx?.fiber.dispose() }
