# Third-party notices

本项目是独立开发的工作区插件管理原型，不是以下两个上游项目的官方版本。没有复制它们的完整运行时或完整界面。

## dsh-workspace-scope

- 作者/版权方：Ri0n72Y；dsh-workspace-scope contributors。
- 仓库：[Ri0n72Y/dsh-workspace-scope](https://github.com/Ri0n72Y/dsh-workspace-scope)。
- 版本：0.5.3。
- 审查提交：`71db3f5ceb166b88f259f89e610ac6c88b1e5d78`。
- 许可证：MIT，[保留的原文](licenses/dsh-workspace-scope.LICENSE)。
- 直接改编：`src/host/scoped-service.ts` → 本项目 `src/scoped-service.js`，将 TypeScript 转为 JavaScript，并将 Agent 参数改成具体注册 Context。
- 设计参考：`src/host/runtime-policy.ts` 的 Agent 作用域注册、组装边界与重组装流程。本项目新写管理器、逐插件配置、生命周期、跨工作区准入和测试；没有移植 Skill deny shadows 或 MCP 名称分组逻辑。

## dsh-workspace-presets

- 作者/版权方：GBDJXB；dsh-workspace-presets contributors。
- 仓库：[GBDJXB/dsh-workspace-presets](https://github.com/GBDJXB/dsh-workspace-presets)。
- 版本：0.2.2。
- 审查提交：`304883bab1ebcabb82cdf4c57f6f2cbdc4b8d536`。
- 许可证：MIT，[保留的原文](licenses/dsh-workspace-presets.LICENSE)。
- 集成形式参考：`client.js` 的 `window.__ModuleLoader__.load` 外壳和 `settings.section` 注册模式；`host.js` 的原生 volatile Config 存储思路。
- 本项目管理页面、RPC、字段编辑、服务端生命周期均为新写，没有复用其浏览器预设选择/绑定算法，也没有修改或复制其完整页面。

## DeepSeek Harness / Cordis / Schemastery

运行与开发使用宿主公开接口，未复制宿主实现进发布目录。SDK 测试读取独立目录中的宿主包副本；该副本不包含在插件包内。各运行时依赖继续适用其各自许可证。

下载来源、提交日期和归档 SHA-256 记录在 [docs/upstream-provenance.json](docs/upstream-provenance.json)。上游完整源码与 SDK 副本不随本仓库分发；原始源码另在本地保留，未作修改。
