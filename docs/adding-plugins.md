# 新增与维护设备插件（API v2）

本仓库面向 DevKit API v2 插件体系，按 `plugins/<slug>/` 组织独立设备插件源码、清单、测试与变更记录。一个插件可同时声明支持多种会话传输（`serial`、`ssh`、`net`、`pty`），在 DevKit 中创建多个独立配置实例并按需绑定。

## 1. 用模板创建插件

在仓库根目录执行：

```bash
npm run new -- at-device --id company.at-device --name "AT 设备查询"
```

脚手架基于 `templates/serial-plugin/` 生成 `plugins/at-device/`（API v2 模板），替换 `__PLUGIN_SLUG__`、`__PLUGIN_ID__`、`__PLUGIN_NAME__` 并自动刷新 `catalog.json`（`schemaVersion: 2`）。

## 2. 目录约定与可选 TypeScript / esbuild 预打包

每个插件独立放在 `plugins/<slug>/`：

```text
plugins/<slug>/
  manifest.json
  src/
    index.cjs          # 或直接编写 src/index.ts，打包时自动由 esbuild 编译为 src/index.cjs
  assets/              # 可选 UTF-8 文本资源
  test/
    plugin.test.cjs
  README.md
  CHANGELOG.md
  LICENSE              # 可选，缺省使用仓库根目录 LICENSE
```

- 运行时分发包严禁包含 `node_modules` 或二进制文件，总包与转义后 JSON 均不超过 `4 MiB`。
- 若插件使用 TypeScript 或纯 JS 依赖，可直接提供 `src/index.ts`（同时在 `manifest.json` 中保持 `"entry": "src/index.cjs"`），`scripts/lib/repository.cjs` 会在加载与打包阶段自动调用内置 `esbuild` 将其编译打包为自包含的 `src/index.cjs`（产物中不包含 `.ts` 源码）。

## 3. 定义 manifest（API v2）

- `id`：稳定命名空间 ID（如 `devkit.text-hex-responder`）。
- `version`：语义版本号（`X.Y.Z`，不接受 `+build`），为构建与索引的唯一版本来源。
- `apiVersion`：必须为 `2`。
- `minHostVersion`（可选）：最低兼容 DevKit 宿主版本（如 `"0.1.10"`）。
- `transports`：必填非空数组，支持 `serial`、`ssh`、`net`、`pty`。
- `entry`：位于 `src/` 下的 `.cjs`/`.js`/`.mjs` 入口。
- `configSchema`：顶层为 `object`，支持 `x-visibleWhen` 条件显隐（`{ field, equals?, notEquals?, in? }`）以及 `type: "array"` 对象数组多规则表单。
- `actions`：最多 32 项动作定义。
- `autoRespond`：是否提供 `onData` 自动监听。
- `capabilities`：仅接受 `stream.read`、`stream.write`（`autoRespond: true` 须声明 `stream.read`）。

## 4. 生命周期、流调用与并发约定

入口导出 `activate(ctx)`，返回 `{ run, onData?, dispose }`：

```js
exports.activate = async function activate(ctx) {
  return {
    async run(actionId) {
      ctx.signal.throwIfAborted()
      if (actionId !== 'query') throw new Error('未知动作')
      const reply = await ctx.stream.exchange('AT\r\n', {
        match: 'OK',
        timeoutMs: 3000
      })
      return { ok: true, response: reply.text }
    },
    async dispose() {
      // 清理自建定时器、写队列与缓冲区
    }
  }
}
```

- **顺序 `await` 与串行写队列**：所有 `ctx.stream.write` / `ctx.stream.exchange` 必须顺序 `await`。若插件支持延时回复（如 `replyDelayMs > 0`），必须在内部维护串行写队列，防止多次触发并发写流。
- **异常传播与中止信号**：失败或已停止状态下调用 `run()` 必须直接 `throw Error`（不要返回 `{ ok: false }`），以确保宿主宏中止后续步骤；同时监听 `ctx.signal` 并在 `dispose()` / `reset` 中取消所有待发定时器。
- **有界缓冲与防洪泛**：`event.bytes` 不保证单次即为完整协议帧，应维护有界缓冲并防止单次回调触发回复洪泛。

## 5. 测试、跨仓契约校验与 Electron E2E

| 命令 | 用途 |
| --- | --- |
| `npm run catalog` | 重新生成 `catalog.json`（v2） |
| `npm run validate` | 校验目录、清单、符号链接与体积边界 |
| `npm test` | 运行仓库元测试与全部插件单测 |
| `npm run pack:all` | 打包全部插件为自包含 JSON 与 `SHA256SUMS` |
| `npm run check:host -- ../DevKit` | 隔离编译 `DevKit/packages/plugin-sdk`，用官方 `createMockPluginContext` 在全部声明 `transports` 上校验每个插件 |
| `npm run check:electron -- ../DevKit` | 自动遍历 `catalog.json` 中全部插件执行真实 Electron `utilityProcess` 冒烟测试 |

## 6. 批量发布与索引 v2 治理

`releases/request.json` 支持批量发布与问题版本撤回：

```json
{
  "tags": ["text-hex-responder/v2.0.0"],
  "yank": [],
  "deprecations": {}
}
```

- `tags`：支持一次发布多个 `<slug>/vX.Y.Z` 稳定版本。
- `yank`：填入需撤回的 `pluginId`，发布脚本在 `install-index-v2` 中将其标记为 `yanked: true`（不篡改既有 `sha256` 与 `url`），宿主侧将禁止安装。
- `deprecations`：按 `{ "<pluginId>": "迁移提示" }` 写入废弃说明。
- `scripts/publish.cjs` 保持版本单调递增与同版本哈希不可变校验，并同步写入 `apiVersion: 2`、`transports` 与 `minHostVersion`。
