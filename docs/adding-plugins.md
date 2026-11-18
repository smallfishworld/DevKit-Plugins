# 新增与维护串口插件

本仓库按插件分别组织源码、配置定义、测试和变更记录。一个插件对应一个稳定的 `manifest.id`，可以在 DevKit 中创建多个配置实例，并按需绑定到不同串口。

## 1. 用模板创建插件

在仓库根目录执行：

```bash
npm run new -- at-device --id company.at-device --name "AT 设备查询"
```

这会使用 `templates/serial-plugin/` 生成 `plugins/at-device/`，替换以下占位符，并刷新 `catalog.json`：

| 占位符 | 来源 | 示例 |
| --- | --- | --- |
| `__PLUGIN_SLUG__` | 命令的位置参数 | `at-device` |
| `__PLUGIN_ID__` | `--id` | `company.at-device` |
| `__PLUGIN_NAME__` | `--name` | `AT 设备查询` |

目录名建议采用小写字母、数字与连字符。插件 ID 建议使用组织命名空间，例如 `company.at-device`，并确保在本仓库和安装环境中唯一。

生成后，先按实际设备修改命令与响应标记，再尝试运行。默认查询命令只是示例，不代表任意设备都支持。

## 2. 目录约定

每个插件独立放在 `plugins/<slug>/`：

```text
plugins/<slug>/
  manifest.json
  src/
    index.cjs
  assets/
    protocol.json
  test/
    plugin.test.cjs
  README.md
  CHANGELOG.md
  LICENSE
```

`assets/` 是可选目录，插件自身的 `LICENSE` 也是可选文件；没有时打包工具使用仓库根目录的 LICENSE。模板放在 `templates/`，不参与插件索引，也不作为可安装插件发布。

| 文件或目录 | 职责 |
| --- | --- |
| `manifest.json` | 插件身份、唯一版本来源、入口、配置 schema、动作与能力 |
| `src/` | 运行时代码；入口默认是 `src/index.cjs` |
| `assets/` | 运行时需要的 UTF-8 文本资源，如协议定义 |
| `test/` | 独立的 Node.js 测试 |
| `README.md` | 用途、设备要求、配置说明和使用方法 |
| `CHANGELOG.md` | 每次插件版本变化的用户可见内容 |
| `LICENSE`（可选） | 插件自己的许可证文本；打包时优先使用，否则使用仓库根目录版本 |

不要为每个插件重复维护一套 package 版本。构建文件名、目录与索引版本均读取该插件的 `manifest.json.version`。

## 3. 定义 manifest

模板默认使用 API v1、版本 `0.1.0`，声明 `serial.read` 与 `serial.write`，提供 `query` 动作，关闭自动应答。

修改 manifest 时，重点核对：

- `id`：稳定的插件身份。升级、目录重命名和展示名调整时保持不变。
- `version`：本插件的版本，不与其他插件一起机械递增。
- `apiVersion`：宿主 API 兼容级别，目前使用 `1`。
- `entry`：相对于插件根目录的入口路径；本仓库入口必须位于 `src/`。
- `configSchema`：实例配置的数据结构、默认值和约束。
- `actions`：可手动运行、可供宏引用的动作列表。
- `autoRespond`：是否提供常驻接收处理能力。
- `capabilities`：声明插件使用的宿主能力，例如 `serial.read`、`serial.write`。

DevKit 的配置界面根据 schema 展示基础字段，复杂数组和对象可以用 JSON 编辑。API v1 只支持宿主实现的 JSON Schema 子集；不要直接假设 `$ref`、`oneOf` 或任意 UI 扩展关键字可用。以 DevKit 的校验结果为准。

模板中的 `expected` 是响应里的字符串标记，不是正则表达式。对二进制协议，应明确帧边界、长度、序列号与校验策略；仅判断某个子串出现不能替代协议校验。

## 4. 实现生命周期与串口调用

入口导出 `activate(ctx)`，返回插件实例：

```js
exports.activate = async function activate(ctx) {
  return {
    async run(actionId) {
      if (actionId !== 'query') throw new Error('未知动作')
      const reply = await ctx.serial.exchange('AT\r\n', {
        match: 'OK',
        timeoutMs: 3000
      })
      return { response: reply.text }
    },
    async dispose() {
      // 清理本插件创建的计时器和监听器。
    }
  }
}
```

宿主管理串口连接、发送仲裁和连接代际。插件通过 `ctx.serial` 使用串口，不再自行创建 SerialPort 或打开同一端口。

**每个串口操作必须顺序 `await`。** 例如，先等待查询完成，再发下一条命令。不要用 `Promise.all` 并发发送，也不要发起未等待的串口 Promise 后立即从 `run` 或 `onData` 返回。这样宿主才能把串口租约与操作生命周期正确关联。

失败应抛出异常，使宿主中止宏的后续步骤。不要仅返回 `{ ok: false }`，否则该返回值仍可能被视作一次已完成的插件调用。

`ctx.signal` 可用于响应停止或断开，`dispose()` 负责释放插件自行创建的资源。实例数据放在各自的 `activate` 闭包中，避免不同设备配置共用可变的模块级状态。

### 自动应答

需要常驻自动应答时：

1. 在 manifest 中声明 `autoRespond: true` 和所需能力。
2. 在实例上实现 `onData(event)`。
3. 在 DevKit 的配置实例中开启自动监听，并绑定串口。

一个 `event.bytes` 是收到的数据块，不保证恰好是一帧。应按协议维护有界缓冲，处理分包、粘包、超时和连接结束。二进制解析使用 `event.bytes`；`event.text` 供文本场景使用。不要将 text 重新编码后当成原始协议字节。

默认模板仅提供手动查询，不会因安装或保存配置而开始监听。

### 可信代码与秘密值

API v1 插件是**可信本地代码**。外部插件运行在独立进程中以隔离故障，这不是针对恶意代码的安全沙箱；能力声明也不等同于操作系统级权限隔离。审查后再安装和执行插件。

发送口令等秘密内容时使用 `secret: true`，让宿主按秘密数据处理审计与观察者输出。插件自身仍应避免把凭证写进日志、状态、返回结果或仓库配置示例。测试使用假数据。

## 5. 区分插件、配置实例与会话绑定

| 对象 | 含义 | 典型操作 |
| --- | --- | --- |
| 插件包 | 可复用的实现与 manifest | 安装、升级、卸载 |
| 配置实例 | 某个设备或环境的一组参数，有独立实例 ID | 创建、编辑、启用、禁用 |
| 会话绑定 | 将一个实例用于当前已打开的串口连接 | 绑定、停止、解绑 |

同一个插件可以有“设备 A”和“设备 B”两份配置。当前 API v1 下，同一个实例同一时刻绑定一个串口；需要同时使用两个串口时创建两个实例。

在 DevKit 中验证时，依次完成：安装包 → 新建配置 → 打开串口 → 绑定实例 → 运行动作或开启自动监听。断开、休眠或停止后，需要根据宿主状态重新绑定，不能继续使用上一次连接的事务。

## 6. 测试与本地检查

所有仓库工具命令均从根目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm run new -- <slug> --id <namespace.id> --name <name>` | 生成模板并刷新索引 |
| `npm run catalog` | 根据插件 manifests 重新生成 `catalog.json` |
| `npm run validate` | 校验插件结构与元数据 |
| `npm test` | 运行仓库测试 |
| `npm run pack -- <slug>` | 构建指定插件的 JSON 安装包 |
| `npm run pack:all` | 构建全部插件的 JSON 安装包 |
| `npm run check` | 执行仓库统一检查 |
| `npm run check:host -- /path/to/DevKit` | 使用指定 DevKit 源码执行真实宿主的校验与安装兼容检查 |

单独测试一个插件：

```bash
node --test plugins/at-device/test/plugin.test.cjs
```

模板测试使用 `node:test` 与假的 `ctx`，不需要真实串口或新增测试依赖。测试覆盖查询参数、异步等待、异常传播、停止后迟到响应以及实例隔离。新增协议时，增加与协议有关的测试，例如一帧分成多次接收、多帧一次接收、异常帧和超时。

单元测试不验证真实串口驱动或 Electron 集成。可运行 `npm run check:host -- /path/to/DevKit` 使用真实宿主校验安装兼容性；CI 使用固定的 DevKit `6264ff6` 作为 API v1 验证基线。交付前仍需在 DevKit 中安装实际产物，验证配置、绑定、动作、停止及重新连接；可用虚拟串口或实际设备。

## 7. 构建与分发

```bash
npm run catalog
npm run validate
npm test
npm run pack -- at-device
npm run check
```

输出路径约定：

```text
dist/<slug>/<version>/<id>-<version>.devkit-plugin.json
dist/<slug>/<version>/package/
```

前者是 JSON 安装包，后者是包含同样运行文件的干净目录。DevKit 的目录安装会复制所选目录内的文件，因此应选择 `package/`；直接选择 `plugins/<slug>/` 仅适合开发调试，会把源码目录中的测试和文档一并复制。

安装包为一个 JSON bundle：

```json
{
  "manifest": {
    "...": "完整的插件 manifest"
  },
  "files": {
    "src/index.cjs": "入口文件的 UTF-8 文本内容",
    "LICENSE": "选定许可证的 UTF-8 文本内容"
  }
}
```

上面的 bundle 仅展示结构，省略号不是可安装的 manifest。构建工具会写入完整 manifest。

`files` 包含 `src/`、可选 `assets/` 内的 UTF-8 文件，以及 `LICENSE`；manifest 单独放在顶层。许可证优先读取插件自己的 `LICENSE`，否则使用仓库根目录的 LICENSE。测试、README、CHANGELOG 和其他文档不会入包。不要把运行时需要的模块放在 `test/` 或仓库根目录，也不要依赖本机未随包交付的模块。这个打包格式不直接收录原生二进制依赖或任意二进制资源。

如需增加外部依赖，先明确依赖如何被打入 `src/` 以及宿主兼容性；模板本身没有外部依赖。

## 8. 版本、标签与兼容

每次变更按插件独立维护：

1. 在该插件的 `manifest.json` 修改版本。
2. 在该插件的 `CHANGELOG.md` 记录用途、行为或兼容性变化。
3. 更新 README 与测试。
4. 运行 `npm run catalog`，检查生成的索引差异。
5. 运行验证、测试和打包，检查实际产物。

每插件 Git 标签约定为：

```text
<slug>/v<version>
```

例如 `at-device/v0.1.0`。标签与插件 manifest 的版本应一致。正式发布按以下步骤进行：

1. 完成版本变更并通过仓库检查。将 `releases/request.json` 的 `tag` 更新为本次要发布的稳定版本，一次提交一个插件的发布请求。
2. 合入 `main` 后，`Publish device plugin` 工作流运行测试及宿主兼容检查，再创建该版本的 GitHub Release 并上传 JSON 包和 `SHA256SUMS`。
3. 发布步骤以已上传资源的地址和校验值更新[固定安装索引](https://github.com/smallfishworld/DevKit-Plugins/releases/download/install-index-v1/index.json)，保留其它插件条目。DevKit 刷新扩展源后即可安装。
4. 发布失败时，在 Actions 中重跑该次工作流。现有同版本安装包须与本次构建字节一致。更新插件代码时提高 manifest 版本并提交新的发布请求。

`catalog.json` 由源码生成。安装索引只列出正式发布的包，发布产物留在 Releases。

目录 `slug` 是仓库组织与构建入口，`manifest.id` 是安装身份。重命名目录时保持插件 ID 和动作 ID 不变；DevKit 宏引用稳定的配置实例 ID 与动作 ID，不会随目录名自动改变。升级时也应保留已有配置实例，而不是删除后新建来“迁移”。

配置结构变化应提供明确迁移步骤并验证旧配置。API v1 的这个模板不提供自动迁移钩子；新增必填字段时优先给出兼容默认值，需要破坏性调整时在变更记录中说明。
