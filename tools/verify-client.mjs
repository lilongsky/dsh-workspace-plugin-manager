import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createNativeFixture } from './native-fixture.mjs'

if (!process.env.WPM_BROWSER_DEPENDENCIES || !process.env.WPM_REACT_DEPENDENCIES || !process.env.WPM_CHROME_EXECUTABLE) throw new Error('Set the three WPM browser/React fixture paths; this check never installs a browser or dependencies')
const browserRequire = createRequire(join(process.env.WPM_BROWSER_DEPENDENCIES, 'package.json'))
const reactRequire = createRequire(join(process.env.WPM_REACT_DEPENDENCIES, 'package.json'))
const { chromium } = browserRequire('playwright')
const nativeCatalog = process.env.WPM_NATIVE_CATALOG === '1'
const fixture = await createNativeFixture({ nativeCatalog })
let ctx = await fixture.start()
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.WPM_CHROME_EXECUTABLE, headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('fixtureRpc', (endpoint, payload) => fixture.rpc(endpoint, payload))
  const react = await readFile(join(dirname(reactRequire.resolve('react/package.json')), 'umd/react.development.js'), 'utf8')
  const dom = await readFile(join(dirname(reactRequire.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8')
  const client = await readFile(join(fixture.project, 'src/client.js'), 'utf8')
  const inline = source => source.replace(/<\/script/gi, '<\\/script')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>工作区插件管理 · 独立验证</title><style>:root{--dsw-alias-border-l2:#d9dde3;--dsw-alias-bg-layer-3:#fff;--dsw-alias-label-primary:#202a38}body{margin:0;background:#f6f8fb;color:#202a38;font:14px -apple-system,BlinkMacSystemFont,sans-serif}button,input,select,textarea{font:inherit}textarea{resize:vertical}input[type=checkbox]{accent-color:#2563eb}</style><div id="app"></div><script>${inline(react)}</script><script>${inline(dom)}</script><script>window.__ModuleLoader__={load(registration){const plugin=registration.factory(name=>{if(name==='react')return React;throw Error(name)});plugin.apply({connection:{rpc:{call:(_path,endpoint,payload)=>window.fixtureRpc(endpoint,payload)}},slots:{inject:(_name,callback)=>callback(),register:(_entry,Page)=>{const root=ReactDOM.createRoot(document.getElementById('app'));root.render(React.createElement(Page));return()=>root.unmount()}},effect:callback=>callback()})}};</script><script>${inline(client)}</script></html>`
  // All browser requests are intercepted. This is not a connection to DSH.
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await page.goto('http://workspace-plugin-fixture.invalid/')
  await page.getByLabel('工作区', { exact: true }).waitFor()
  const card = () => page.locator('section').filter({ has: page.getByRole('heading', { name: '工作区指令', exact: true }) })
  const select = page.getByLabel('工作区', { exact: true })
  await card().getByLabel('在此工作区启用').check()
  await card().getByLabel('指令内容').fill('A：独立项目指令')
  await card().getByRole('button', { name: '保存', exact: true }).click()
  await card().getByRole('status').filter({ hasText: '已保存' }).waitFor()
  await select.selectOption('b')
  assert.equal(await card().getByLabel('在此工作区启用').isChecked(), false)
  assert.equal(await card().getByLabel('指令内容').inputValue(), '')
  await card().getByLabel('在此工作区启用').check()
  await card().getByLabel('指令内容').fill('B：另一套项目指令')
  await card().getByRole('button', { name: '保存', exact: true }).click()
  await card().getByRole('status').filter({ hasText: '已保存' }).waitFor()
  await select.selectOption('a')
  assert.equal(await card().getByLabel('指令内容').inputValue(), 'A：独立项目指令')
  await card().getByLabel('在此工作区启用').uncheck()
  await card().getByRole('button', { name: '保存', exact: true }).click()
  await card().getByRole('status').filter({ hasText: '已保存' }).waitFor()
  await select.selectOption('b')
  assert.equal(await card().getByLabel('在此工作区启用').isChecked(), true)
  assert.equal(await card().getByLabel('指令内容').inputValue(), 'B：另一套项目指令')
  const globals = page.locator('section').filter({ has: page.getByRole('heading', { name: '仍由全局管理的插件' }) })
  assert.equal(await globals.getByRole('checkbox').count(), 0)
  const prompts = []
  for (const workspace of fixture.workspaces) {
    const agent = { id: workspace.id, status: 'idle', session: { header: { cwd: workspace.path } } }
    const scope = createScope(ctx, agent); agent.ctx = scope.ctx; fixture.agents.push(agent)
    await ctx.serial('agent/created', { agent })
    prompts.push((await ctx.get('systemPrompt').assemble({ agent, scope: agent })).sections.find(s => s.name === 'workspace-manager:instructions')?.text ?? null)
  }
  assert.deepEqual(prompts, [null, 'B：另一套项目指令'])
  const nativeChecks = []
  if (nativeCatalog) {
    const inventory = page.locator('section').filter({ has: page.getByRole('heading', { name: '原生插件管理', exact: true }) })
    await inventory.getByLabel('筛选插件').fill('ordinary-native')
    await inventory.getByRole('button', { name: '编辑全局配置' }).click()
    const globalJson = inventory.getByLabel('全局配置 JSON')
    assert.equal((await globalJson.inputValue()).includes('fixture-credential-only'), false)
    await globalJson.fill('{"text":"UI global"}')
    await inventory.getByRole('button', { name: '保存全局配置' }).click()
    await inventory.getByRole('status').filter({ hasText: '全局配置已保存' }).waitFor()
    await inventory.getByRole('button', { name: '关闭配置' }).click()
    await inventory.getByLabel('全局启用').click()
    await inventory.getByRole('status').filter({ hasText: '宿主要求重启后生效' }).waitFor()
    assert.equal(await inventory.getByLabel('全局启用').isChecked(), true)
    // Reconstruct only the isolated fixture; never restart the desktop DSH.
    await ctx.fiber.dispose(); ctx = await fixture.start()
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await inventory.getByRole('button', { name: '接管到工作区' }).click()
    const ordinary = () => page.locator('section').filter({ has: page.getByRole('heading', { name: 'ordinary.mjs', exact: true }) })
    try { await ordinary().waitFor({ timeout: 5000 }) }
    catch { throw new Error('普通插件接管没有生成配置卡：' + await inventory.getByRole('status').textContent()) }
    for (const [id, text] of [['a', 'UI ordinary A'], ['b', 'UI ordinary B']]) {
      await select.selectOption(id)
      await ordinary().getByLabel('在此工作区启用').check()
      await ordinary().getByLabel('插件配置（JSON）').fill(JSON.stringify({ text }))
      await ordinary().getByRole('button', { name: '保存', exact: true }).click()
      await ordinary().getByRole('status').filter({ hasText: '已保存' }).waitFor()
    }
    await select.selectOption('a')
    await ordinary().getByLabel('在此工作区启用').uncheck()
    await ordinary().getByRole('button', { name: '保存', exact: true }).click()
    await ordinary().getByRole('status').filter({ hasText: '已保存' }).waitFor()
    await select.selectOption('b')
    assert.equal(await ordinary().getByLabel('在此工作区启用').isChecked(), true)
    assert.deepEqual(JSON.parse(await ordinary().getByLabel('插件配置（JSON）').inputValue()), { text: 'UI ordinary B' })
    const nativePrompts = []
    for (const workspace of fixture.workspaces) {
      const agent = { id: 'native-' + workspace.id, status: 'idle', session: { header: { cwd: workspace.path } } }
      agent.ctx = createScope(ctx, agent).ctx; fixture.agents.push(agent)
      await ctx.serial('agent/created', { agent })
      nativePrompts.push((await ctx.get('systemPrompt').assemble({ agent, scope: agent })).sections.find(s => s.name === 'ordinary-native')?.text ?? null)
    }
    assert.deepEqual(nativePrompts, [null, 'UI ordinary B'])
    nativeChecks.push('原生清单与全局开关', '原生全局配置保存', '密钥未展示', '原生重启要求如实展示', '普通插件经页面直接接管', '普通插件 A/B 独立配置及单方停用')
  }
  await page.screenshot({ path: join(fixture.evidence, 'workspace-manager-ui.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const result = { status: 'pass', browser: await browser.version(), temporaryProfile: fixture.profileDir, checks: ['A 保存', 'B 初始独立', 'A/B 参数独立', '关闭 A 保留 B', '全局插件没有伪开关', '浏览器保存到原生 Settings 并影响隔离 Agent 提示词', '没有浏览器运行错误', ...nativeChecks], prompts, modelRequests: 0, liveDshConnections: 0 }
  await writeFile(join(fixture.evidence, 'client-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await browser?.close(); await ctx.fiber.dispose() }
