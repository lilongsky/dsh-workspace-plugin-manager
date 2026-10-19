# DSH 工作区插件管理器

开发原型 `0.1.0-prototype.1`，目标宿主为 DSH `0.2.1-rc.2`。源码与验证均在独立目录中完成，未安装进运行中的 DSH。

每个工作区可以为接入管理器的插件分别保存开关和参数。对话始终按自己的工作目录解析工作区；界面切换不会改变其他对话的配置。修改在该对话下一次提示词组装前应用，不撤销已经发出的请求。原型使用 DSH 原生 Config/Settings 保存自己的配置，使用原生 Agent 作用域注册提示词与工具限制，不修改 DSH 文件、不替换全局配置、不切换已有会话的 Agent 预设。

## 当前已实现

- 工作区选择、逐插件开关、逐字段配置、恢复默认。
- 同时运行的 A/B 对话使用各自配置；同一工作区的多个对话分别持有注册。
- 配置通过当前 profile 中管理器自己的 `workspace-plugin-manager` 条目持久化。
- 原生 `agent/created` / `agent/disposed` 生命周期接入；对已有 Agent 在下一次组装时接入。
- 工作目录变更后，管理器拥有的注册在下一次组装前重新绑定。
- 跨工作区适配接口在调用执行函数前检查来源、目标的开关和对话来源；运行中或有待处理输入时拒绝。
- 原生插件清单中的其他组合包以“仍由全局管理”展示，不提供无效的工作区开关。

随包提供两个实际功能：**工作区指令**和**继承工具开关**。继承工具开关限制全局工具的可见性/可调用性，不会停止其后台进程，也不能隐藏精确 Agent 层自己的工具。

独立验证页面如下，A/B 工作区和全局插件清单均为测试数据：

![工作区插件管理页面](docs/images/workspace-manager-ui.png)

## 兼容范围

管理器不会自动隔离任意第三方插件。其他插件需要显式注册以下接口之一：

| `scope` | 含义 |
| --- | --- |
| `workspace` | 通过 `mount(ctx, config, { agent, workspace })` 注册此 Agent 的贡献 |
| `cross-workspace` | 通过 `execute({ source, target, payload, agent })` 执行同时涉及两个工作区的操作 |
| `global` | 仅展示为全局插件，拒绝保存工作区覆盖 |

工作区插件示例：

```js
export const inject = ['workspacePlugins']
export function apply(ctx) {
  ctx.effect(() => ctx.workspacePlugins.register({
    id: 'my-workspace-prompt', title: '项目指令', scope: 'workspace',
    defaults: { text: '' },
    fields: { text: { type: 'multiline', title: '指令内容' } },
    mount(agentCtx, config) {
      return agentCtx.get('systemPrompt').section({
        name: 'my-plugin:prompt', order: 96, text: config.text,
      })
    },
  }))
}
```

`mount` 只做注册，不驱动 Agent；它返回的清理函数由管理器拥有。插件仍在同一宿主进程中运行：模块全局变量、外部文件、后台任务及自行调用全局注册表的代码，不会被这个接口自动隔离。注册接口表示插件作者已适配这一约定，不是权限沙箱。

## 跨工作区迁移

默认规则为来源与目标均启用才准入。`runCrossWorkspace(pluginId, sourceId, targetId, { sessionId })` 在 Host 端调用已注册的 `execute`，没有向浏览器开放任意执行回调。

**当前没有接管已安装的 dsh-session-workspace。** 它原来的全局 RPC 仍独立存在；在新接口中加检查不会限制旧 RPC，因此本原型不会声称已经控制了它。接入该插件时必须让其所有菜单、拖拽与 RPC 执行路径使用统一准入，并保留原迁移实现对会话释放、待处理输入、磁盘写入及回滚的检查。管理器的状态检查不能代替迁移期间的原子性。

迁移验证中的执行函数是测试适配器，只修改临时 Agent 的工作目录，未迁移真实会话文件。验证通过说明管理器能阻止调用、传入两端独立配置、重新绑定自身贡献；不能据此声称磁盘迁移已经验收。

## 验证

需要 Node.js 24 或更新版本，以及 DSH `0.2.1-rc.2` 的**隔离 SDK 副本**。副本目录须含 `package.json` 和可解析的 `node_modules/@deepseek-ai/`，包括 Cordis、Scope、Tools、Agent、SystemPrompt、App Boot、Settings、ConfigEditor 及它们的依赖。SDK 不随本仓库分发。

使用系统 Node，在仓库根目录执行；`DSH_NATIVE_ROOT` 必须显式指向独立副本，解析 hook 没有运行中应用的默认路径：

```sh
export DSH_NATIVE_ROOT=/absolute/path/to/isolated-sdk
npm run check
npm test
npm run test:native
```

`test:native` 会在本仓库被 Git 忽略的 `.verification/` 下创建独立 profile，使用原生 Loader、Settings、ConfigEditor 验证表单投影、配置落盘、销毁/重建后的恢复，以及两个工作区的不同提示词。它不启动 DSH 桌面服务，不连接运行实例，不发模型请求。

`test:client` 额外需要显式设置 `WPM_BROWSER_DEPENDENCIES`（已含 Playwright 的目录）、`WPM_REACT_DEPENDENCIES`（已含 React 18 和 React DOM 18 的目录）与 `WPM_CHROME_EXECUTABLE`（独立 Chrome/Chromium 可执行文件）。该脚本不下载依赖或浏览器，全部页面请求由测试路由拦截。输出与截图也写入 `.verification/`。

核心检查共 17 项；隔离 SDK 已与当时安装文件核对。Node 24.21.0 与系统 Node 26.12.0 的核心检查已通过。临时原生 profile 与独立浏览器验证记录见 [验证说明](docs/VALIDATION.md)。运行中的桌面页面、真实在线对话和真实迁移尚未验收；此原型不提供正式安装脚本。`package.json` 中的 `private: true` 用于避免意外发布到 npm，不影响本仓库公开。

## 来源

见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。保留了两个上游项目的 MIT 许可证，并区分直接改编代码与仅参考的设计。另附[源码审查](docs/SOURCE_REVIEW.md)和[上游提交及归档校验记录](docs/upstream-provenance.json)。
