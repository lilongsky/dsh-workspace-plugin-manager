import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { boot, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot'

export async function createNativeFixture({ nativeCatalog = false } = {}) {
  const sdk = process.env.DSH_NATIVE_ROOT
  if (!sdk) throw new Error('DSH_NATIVE_ROOT must point to the isolated SDK copy')
  const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const evidence = resolve(project, '.verification')
  await mkdir(evidence, { recursive: true })
  const home = await mkdtemp(join(evidence, 'native-profile-'))
  const profileDir = join(home, 'profiles', 'spec')
  const bundle = join(home, 'fixture-bundle')
  await mkdir(join(profileDir, 'node_modules'), { recursive: true }); await mkdir(bundle)
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'workspace-fixture', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const sdkEntry = name => join(sdk, 'node_modules', '@deepseek-ai', name, 'lib/index.js')
  const rows = [
    { id: 'system-prompt', name: sdkEntry('dsh-system-prompt') },
    { id: 'tools', name: sdkEntry('dsh-tools') },
    { id: 'config-editor', name: sdkEntry('dsh-config-editor') },
    { id: 'settings', name: sdkEntry('dsh-settings') },
    { id: 'workspace-plugin-manager', name: join(project, 'src/index.js') },
  ]
  if (nativeCatalog) {
    const ordinary = join(bundle, 'ordinary.mjs')
    await writeFile(ordinary, `import z from '@deepseek-ai/schemastery'\nexport const inject = ['systemPrompt']\nexport const Config = z.object({ text: z.string().default('global'), credential: z.string().role('secret').default('') })\nexport function apply(ctx, config) { ctx.get('systemPrompt').section({ name: 'ordinary-native', order: 95, text: config.text }) }\n`)
    rows.push({ id: 'native-plugin-manager', name: sdkEntry('dsh-plugin-manager') }, { id: 'ordinary-native', name: ordinary, config: { text: 'global', credential: 'fixture-credential-only' } })
  }
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  await symlink(bundle, join(profileDir, 'node_modules', 'workspace-fixture'), 'dir')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, name: 'wpm-isolated-spec', dependencies: { 'workspace-fixture': 'file:' + bundle }, dsh: { profile: { bundles: ['workspace-fixture'] } } }))
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n'); await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  const workspaces = [{ id: 'a', title: '工作区 A', path: join(home, 'a') }, { id: 'b', title: '工作区 B', path: join(home, 'b') }]
  const agents = []
  let handler
  const profile = { name: 'spec', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'), home, cwd: home, installAnchor: join(sdk, 'package.json'), overlays: [], startedBundles: ['workspace-fixture'] }
  async function start() {
    const loaded = loadProfileDirectory('workspace-native-spec', profileDir, profile.installAnchor)
    return boot('workspace-native-spec', join(profileDir, 'cordis.yml'), readProfilePatches('workspace-native-spec', profile, loaded), async ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('agents', { list: () => agents })
      ctx.provide('workspaceRegistry', { list: () => workspaces })
      // Inventory fixture only; no installed DSH profile is queried.
      if (!nativeCatalog) ctx.provide('pluginManager', { listBundles: () => [{ name: 'dsh-session-workspace', enabled: true }, { name: 'dsh-unrestricted', enabled: true }] })
      ctx.provide('connection', { register(_owner, path, rpc) { assert.equal(path, '/dsh-workspace-plugin-manager'); handler = rpc; return () => {} } })
    }, pathToFileURL(join(sdk, 'package.json')).href)
  }
  return { sdk, project, evidence, home, profileDir, profile, agents, workspaces, start, rpc: (...args) => handler(...args) }
}
