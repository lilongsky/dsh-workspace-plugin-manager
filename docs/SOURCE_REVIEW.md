# 工作区级插件管理源码审查

核查日期：2026-10-19 至 2026-10-20。目标：DSH 0.2.1-rc.2。运行中的 DSH、安装目录、正式 desktop profile、现有工作区与对话均不在修改范围内。

## 结论

两个项目都不能直接提供“每个工作区独立管理任意原生插件及其参数”。它们的部分接口用法值得参考；若补齐真正的管理层，工作量和职责已经相当于开发新插件。此次采用独立项目，保留上游源码不动。

不修改宿主，可以直接加载符合当前接管范围的普通 Cordis Host 模块，也可以对显式适配的插件按工作区保存参数、按 Agent 隔离注册、并发使用不同配置、迁移后重新绑定管理器拥有的贡献。不能仅凭一个通用开关，透明隔离任意插件的全局服务、模块全局变量、Client 页面和文件副作用。

`0.2.0-alpha.2` 的实施范围为：保持原生工作区、会话与同一运行时结构，尽量提供工作区管理；当前不支持接管的插件保留原生全局管理，并在页面解释原因。独立进程与 profile 能提供另一种隔离边界，但跨实例迁移需要额外协调，因此本版本使用共享工作区注册表。

## dsh-workspace-scope 0.5.3

提交：`71db3f5ceb166b88f259f89e610ac6c88b1e5d78`。

- `src/host/runtime-policy.ts`：`activePolicies` 按 Agent ID 保存，第一次真实组装读取并锁定 `.dsh-scope.json`；通过 Agent 绑定的 `tools.restrict({ deny })` 限制继承的 Host MCP 工具，改变 mask 时重新组装。
- `src/host/skill-policy.ts`：通过 Skill 注册表添加 Agent 层的不可由模型调用的 shadow，不卸载提供 Skill 的插件。
- `src/host/scoped-service.ts`：通过 `agent.ctx.get()` 获取绑定到调用作用域的服务，避免错误读取全局属性。
- `src/host/config.ts`：文件只包含 Skill/MCP 的白名单或黑名单，没有逐个 Cordis 插件的 Config、Loader 实例或 Client 配置页管理。
- 同一 Agent 若只改 `cwd` 而不销毁，已锁定策略不会自动重读；若迁移流程销毁并重建 Agent，则新 Agent 会重新读取策略。这不能直接等同于通用迁移联动。
- 源码和 AGENTS.md 明确限定 DSH 0.1.6-alpha.2，且不支持 Agent/Preset 自有 MCP。移植到 0.2.1 需要重新核对接口，不能依据 npm 包成功导入就宣称兼容。

## dsh-workspace-presets 0.2.2

提交：`304883bab1ebcabb82cdf4c57f6f2cbdc4b8d536`。

- `host.js`：Config 只有 `bindings: [{ workspaceId, agentPreset }]`，Host 只提供持久配置，没有每个工作区的插件运行实例。
- `client.js` 的 Reconciler：遍历工作区下的空白会话，调用 `remote.agentPresets.select`；排除已开始、归档、子代理及手动选择过的会话。
- 绑定由浏览器 overlay 协调，不是 Host 在每次 Agent 创建时强制绑定；它不能覆盖无浏览器创建的 Agent，也不能把已开始的对话在迁移后任意切换到另一预设。
- 它选择已有预设，不创建预设的 `plugins`，不编辑其他插件 Config，也不隔离全局插件。
- README/peer 范围覆盖 0.1.7、0.2.0 等版本；本次没有把它安装到 0.2.1-rc.2 验证。

## 核查版本宿主的关键约束

原生 `dsh-settings` 与 `dsh-config-editor` 以唯一的 profile 条目 ID 编辑 Config，写入 profile patch。该接口没有工作区维度，不能将它原样套在每个工作区上。

原生 `dsh-agent-preset-registry.select()` 对已经开始的会话抛出 `agent-preset/locked`。因此“迁移后改预设”不能作为已有对话的通用解决方案。

原生 Agent 创建公告是可等待的 serial 事件；Agent 绑定的 Context 注册具备作用域可见性。原型利用 `agent/created` 挂载自己的适配插件，并在 `system-prompt/assemble` 核对最新配置/归属；发生变化时重新组装，保证首次使用的提示词和工具视图一致。

已安装的 dsh-session-workspace 0.2.8 在全局注册 `/dsh-session-workspace`，操作整个工作区注册表。新管理器中新增准入接口不会约束原 RPC，因此它仍必须显示为全局插件，直到所有迁移入口明确接入。

## 独立原型

本节记录 `0.1.0-prototype.1` 的初始实现；`0.2.0-alpha.1` 已加入原生插件通用管理与普通 Cordis 插件直接加载，当前范围见 [GENERAL_MANAGEMENT.md](GENERAL_MANAGEMENT.md)。

源码位于本仓库的 `src/`。它不动态安装第三方包，也不改其他插件的 profile 条目。

`workspacePlugins.register()` 是明确的适配接口。支持工作区和跨工作区两种运行方式，原生全局清单保留只读提示。随包的工作区指令与继承工具开关用于验证真实能力；跨区磁盘迁移仍未接管。

两个上游的代码使用、设计参考和修改均在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 注明，并保留原 MIT 许可证。

## 验证边界

管理器测试使用与安装包逐字节一致的 Cordis、Scope、Tools、Agent、SystemPrompt、Settings SDK 副本，覆盖同时请求、配置更新、单方停用、工具可见性、跨区准入、来源校验和迁移后重新绑定。

额外的临时 profile 测试使用原生 Loader、Settings、ConfigEditor 验证管理器配置落盘和销毁/重建后的恢复。重跑脚本生成的临时 profile 位于仓库的 `.verification/`，不接触正式 profile，不运行模型。

独立无头浏览器通过真实 React 页面调用临时 profile 的 RPC，验证保存 A、切换 B、保存另一套参数、关闭 A 保留 B，最后用原生提示词注册表核对结果。浏览器请求全部被测试路由拦截，没有连接正式 DSH；页面中的全局插件列表为测试清单。

这些证据不等于正式桌面端安装、真实在线模型对话或真实会话文件迁移验收。原型中关于迁移的数据变更由测试适配器模拟；已安装迁移插件没有被替换、拦截或接管。
