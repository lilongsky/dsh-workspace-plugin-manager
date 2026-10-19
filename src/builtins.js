import { scopedService } from './scoped-service.js'

export const workspaceInstructions = {
  id: 'workspace-instructions', title: '工作区指令', scope: 'workspace',
  description: '为本工作区的对话添加独立指令。',
  defaults: { text: '' }, fields: { text: { title: '指令内容', type: 'multiline' } },
  mount(ctx, config) {
    return scopedService(ctx, 'systemPrompt').section({ name: 'workspace-manager:instructions', order: 95, text: config.text })
  },
}
export const workspaceToolPolicy = {
  id: 'workspace-tool-policy', title: '继承工具开关', scope: 'workspace',
  description: '按名称禁用本对话继承的工具。不会卸载提供工具的全局插件。',
  defaults: { deniedTools: [] }, fields: { deniedTools: { title: '禁用的工具名称，每行一个', type: 'string-list' } },
  mount(ctx, config) {
    if (config.deniedTools.length === 0) return
    return scopedService(ctx, 'tools').restrict({ deny: config.deniedTools })
  },
}
