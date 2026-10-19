// DSH module-loader/settings-seat integration follows GBDJXB/dsh-workspace-presets.
// The page, data transport, workspace forms and lifecycle below are new.
// Upstream commit and MIT license are recorded in THIRD_PARTY_NOTICES.md.
window.__ModuleLoader__.load({
  id: 'dsh-workspace-plugin-manager',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const control = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'inherit', font: 'inherit' }
    const button = { ...control, width: 'auto', cursor: 'pointer', marginRight: 8 }

    function Field({ field, value, onChange, disabled, id }) {
      const common = { id, disabled, style: control }
      let input
      if (field.type === 'boolean') input = h('input', { ...common, style: {}, type: 'checkbox', checked: value, onChange: event => onChange(event.target.checked) })
      else if (field.options) input = h('select', { ...common, value, onChange: event => onChange(event.target.value) }, field.options.map(v => h('option', { key: v, value: v }, v)))
      else if (field.type === 'json') input = h(JsonField, { ...common, value, onChange })
      else if (field.type === 'multiline' || field.type === 'string-list') input = h('textarea', { ...common, rows: 4, value: Array.isArray(value) ? value.join('\n') : value, onChange: event => onChange(field.type === 'string-list' ? event.target.value.split('\n').map(s => s.trim()).filter(Boolean) : event.target.value) })
      else input = h('input', { ...common, type: field.type === 'number' ? 'number' : 'text', value, onChange: event => onChange(field.type === 'number' ? Number(event.target.value) : event.target.value) })
      return h('div', { style: { marginTop: 12 } }, h('label', { htmlFor: id, style: { display: 'block', marginBottom: 6 } }, field.title), input)
    }
    function JsonField({ value, onChange, ...props }) {
      const [text, setText] = useState(JSON.stringify(value, null, 2))
      useEffect(() => setText(JSON.stringify(value, null, 2)), [JSON.stringify(value)])
      return h('textarea', { ...props, rows: 8, value: text, onChange: event => {
        const raw = event.target.value; setText(raw)
        try { const parsed = JSON.parse(raw); event.target.setCustomValidity(''); onChange(parsed) }
        catch { event.target.setCustomValidity('请输入有效 JSON') }
      } })
    }
    function NativeCatalog({ inventory, call, refresh }) {
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      const [selected, setSelected] = useState(null)
      const [draft, setDraft] = useState(null)
      const [filter, setFilter] = useState('')
      if (!inventory?.available) return null
      async function action(endpoint, payload) {
        setBusy(true); setMessage('')
        try {
          const response = await call(endpoint, payload)
          const result = response?.result
          if (result?.application === 'failed') throw new Error(result.error?.diagnostic ?? result.error?.code ?? '宿主操作失败')
          setMessage(result?.application === 'restart-required' ? '已保存，宿主要求重启后生效。' : result?.application === 'overridden' ? '已保存，但被更高层配置覆盖。' : '已完成。')
        } catch (error) { setMessage(error.message) }
        finally { await refresh(); setBusy(false) }
      }
      async function edit(row) {
        setBusy(true); setMessage('')
        try { const config = await call('config-read', { entryId: row.entryId }); setSelected(config); setDraft(config.value) }
        catch (error) { setMessage(error.message) }
        finally { setBusy(false) }
      }
      return h('section', { style: { marginTop: 28 } },
        h('h2', null, '原生插件管理'),
        h('p', null, '这里的原生开关与配置影响当前 profile 的所有工作区。工作区接管要求先全局停用该条目，再为各工作区分别启用。'),
        h('label', null, '筛选插件', h('input', { style: control, value: filter, onChange: event => setFilter(event.target.value) })),
        ...inventory.plugins.filter(row => `${row.entryId} ${row.moduleName}`.toLowerCase().includes(filter.toLowerCase())).map(row => h('article', { key: row.entryId, style: { borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '12px 0' } },
          h('strong', { title: row.moduleName }, row.moduleName.startsWith('/') || row.moduleName.startsWith('file:') ? row.moduleName.split('/').pop() : row.moduleName), h('div', null, row.entryId),
          h('label', null, h('input', { type: 'checkbox', checked: !!row.enabled, disabled: busy || !!row.readOnlyReason || row.managed, onChange: event => void action('native-enabled', { kind: 'plugin', id: row.entryId, enabled: event.target.checked }) }), ' 全局启用'),
          row.readOnlyReason ? h('span', null, ` · 只读：${row.readOnlyReason}`) : null,
          row.configurable ? h('button', { type: 'button', style: button, disabled: busy, onClick: () => void edit(row) }, '编辑全局配置') : null,
          !row.readOnlyReason && (!row.enabled || row.managed) ? h('button', { type: 'button', style: button, disabled: busy, onClick: () => void action('native-manage', { entryId: row.entryId, enabled: !row.managed }) }, row.managed ? '解除工作区接管' : '接管到工作区') : null,
          row.workspaceReason ? h('p', null, row.workspaceReason) : null)),
        h('details', null, h('summary', null, '组合包全局开关'), ...inventory.bundles.filter(row => row.installed || row.enabled).map(row => h('p', { key: row.name }, h('label', null, h('input', { type: 'checkbox', checked: !!row.enabled, disabled: busy || row.protected, onChange: event => void action('native-enabled', { kind: 'bundle', id: row.name, enabled: event.target.checked }) }), ` ${row.name} ${row.version ?? ''}`), row.error ? h('span', null, ' · 加载错误') : null))),
        selected ? h('form', { onSubmit: event => { event.preventDefault(); void (async () => {
          setBusy(true); setMessage('')
          try { const next = await call('config-write', { entryId: selected.entryId, value: draft, revision: selected.revision }); setSelected(next); setDraft(next.value); setMessage('全局配置已保存。') }
          catch (error) { setMessage(error.message) }
          finally { setBusy(false) }
        })() } }, h('h3', null, `全局配置：${selected.entryId}`),
        h('p', null, 'JSON 中省略的隐藏密钥会保留；填写同名字段可替换密钥。'),
        h(JsonField, { key: selected.entryId, value: draft, onChange: setDraft, style: control, disabled: busy, 'aria-label': '全局配置 JSON' }),
        h('button', { type: 'submit', style: button, disabled: busy }, '保存全局配置'), h('button', { type: 'button', style: button, disabled: busy, onClick: () => setSelected(null) }, '关闭配置')) : null,
        h('p', { role: 'status' }, message))
    }
    function PluginCard({ plugin, workspaceId, document, save }) {
      const saved = document.workspaces.find(w => w.workspaceId === workspaceId)?.plugins.find(p => p.id === plugin.id)
      const [enabled, setEnabled] = useState(saved?.enabled ?? plugin.enabledByDefault)
      const [values, setValues] = useState({ ...plugin.defaults, ...saved?.config })
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      useEffect(() => {
        setEnabled(saved?.enabled ?? plugin.enabledByDefault)
        setValues({ ...plugin.defaults, ...saved?.config })
      }, [workspaceId, JSON.stringify(saved)])
      async function submit(override) {
        setBusy(true); setMessage('')
        try { await save(workspaceId, plugin.id, override); setMessage('已保存；此工作区的对话将在下一次请求前应用。') }
        catch (error) { setMessage(error.message) }
        finally { setBusy(false) }
      }
      const isGlobal = plugin.scope === 'global'
      return h('section', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: 16, marginTop: 16 } },
        h('h3', { style: { margin: '0 0 8px' } }, plugin.title),
        h('p', { style: { margin: '0 0 12px', opacity: .75 } }, plugin.description),
        isGlobal ? h('p', null, '全局插件，尚未提供工作区管理接口。') : h('form', { onSubmit: event => { event.preventDefault(); void submit({ enabled, config: values }) } },
          h('label', null, h('input', { type: 'checkbox', disabled: busy, checked: enabled, onChange: event => setEnabled(event.target.checked) }), ' 在此工作区启用'),
          plugin.scope === 'cross-workspace' ? h('p', null, '跨工作区操作要求来源和目标均启用。') : null,
          ...Object.entries(plugin.fields).map(([key, field]) => h(Field, { key, field, id: `wpm-${plugin.id}-${key}`, value: values[key], disabled: busy, onChange: value => setValues(v => ({ ...v, [key]: value })) })),
          h('div', { style: { marginTop: 16 } }, h('button', { type: 'submit', style: button, disabled: busy }, busy ? '保存中…' : '保存'), h('button', { type: 'button', style: button, disabled: busy || !saved, onClick: () => void submit(null) }, '恢复默认'))),
        h('p', { role: 'status', style: { marginBottom: 0 } }, message))
    }
    return {
      name: 'dsh-workspace-plugin-manager', inject: ['slots', 'connection'],
      apply(ctx) {
        let live = true
        async function call(endpoint, payload) {
          const result = await ctx.connection.rpc.call('/dsh-workspace-plugin-manager', endpoint, payload)
          if (!result?.ok) throw new Error(result?.error?.message ?? '无法读取工作区插件设置')
          return result.value
        }
        function WorkspacePluginsPage() {
          const [snapshot, setSnapshot] = useState(null)
          const [workspaceId, setWorkspaceId] = useState('')
          const [error, setError] = useState('')
          async function refresh() {
            try {
              const next = await call('snapshot')
              if (live) { setSnapshot(next); setError(''); setWorkspaceId(id => next.workspaces.some(w => w.id === id) ? id : next.workspaces[0]?.id ?? '') }
            } catch (failure) { if (live) setError(failure.message) }
          }
          useEffect(() => { let mounted = true; call('snapshot').then(next => { if (live && mounted) { setSnapshot(next); setWorkspaceId(next.workspaces[0]?.id ?? '') } }).catch(failure => { if (live && mounted) setError(failure.message) }); return () => { mounted = false } }, [])
          async function save(id, pluginId, override) {
            const next = await call('update', { workspaceId: id, pluginId, override })
            if (live) setSnapshot(next)
          }
          return h('main', { style: { maxWidth: 800, margin: '0 auto', padding: 24, color: 'var(--dsw-alias-label-primary)' } },
            h('h2', null, '工作区插件'),
            h('p', null, '各工作区分别保存开关和参数，同时运行时各用自己的设置。'),
            h('p', null, '工作区开关使用独立实例；原生全局开关在下方单独管理。'),
            h('button', { type: 'button', onClick: () => void refresh(), style: button }, '刷新'),
            error ? h('p', { role: 'alert' }, error) : null,
            !snapshot ? h('p', null, '正在读取…') : snapshot.workspaces.length === 0 ? h('p', null, '请先在 DSH 中添加工作区。') : h('div', null,
              h('label', { htmlFor: 'wpm-workspace' }, '工作区'),
              h('select', { id: 'wpm-workspace', style: control, value: workspaceId, onChange: event => setWorkspaceId(event.target.value) }, snapshot.workspaces.map(w => h('option', { key: w.id, value: w.id }, w.title || w.path))),
              ...snapshot.plugins.map(plugin => h(PluginCard, { key: `${workspaceId}:${plugin.id}`, plugin, workspaceId, document: snapshot.document, save })),
              snapshot.globalPlugins?.length ? h('section', { style: { marginTop: 28 } }, h('h3', null, '仍由全局管理的插件'), h('p', null, '这些插件的全局状态由原生管理器控制。'), h('ul', null, snapshot.globalPlugins.map(p => h('li', { key: p.name }, `${p.name}${p.enabled ? ' · 已启用' : ' · 未启用'}`)))) : null),
            snapshot ? h(NativeCatalog, { inventory: snapshot.inventory, call, refresh }) : null)
        }
        const seat = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'workspace-plugin-manager', order: 26, label: () => '工作区插件' }, WorkspacePluginsPage))
        ctx.effect(() => () => { live = false; seat() })
      },
    }
  },
})
