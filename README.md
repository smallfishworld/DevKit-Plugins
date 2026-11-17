# DevKit Plugins

DevKit 串口设备插件仓库。每个插件独立维护协议逻辑、配置清单、测试和版本；宿主继续持有串口，并负责会话绑定、事务互斥和停止清理。

## 当前插件

| 插件 | ID | 用途 |
|---|---|---|
| [文本 / HEX 自动应答](plugins/text-hex-responder/README.md) | `devkit.text-hex-responder` | 按完整文本行或 HEX 字节序列匹配设备输入，自动回复；提供手动发送和清空缓存动作，无需 OA。 |

机器可读目录是 [catalog.json](catalog.json)，由各插件 manifest 生成，不能手工维护第二份版本号。该索引用于仓库浏览和构建，当前 DevKit 不会据此自动下载或更新插件。

## 使用插件

需要支持**设备插件 API v1** 的 DevKit。最初兼容基线来自 [DevKit PR #10](https://github.com/smallfishworld/DevKit/pull/10) 的 [6264ff6 提交](https://github.com/smallfishworld/DevKit/commit/6264ff63e3f1f58a9f736e6cec74e3526e841048)，完整基线记录见 [compatibility.json](compatibility.json)。如果应用中没有“串口 → 插件”入口，应先使用包含该功能的 DevKit 版本；仅安装此仓库不会为旧宿主增加插件能力。

安装开发环境为 Node.js 22 或更新版本：

```sh
npm ci
npm run check
```

首个插件会生成两种等价的安装产物：

| 产物 | 路径 |
|---|---|
| 自包含 JSON 包 | `dist/text-hex-responder/1.0.0/devkit.text-hex-responder-1.0.0.devkit-plugin.json` |
| 干净安装目录 | `dist/text-hex-responder/1.0.0/package/` |
| JSON 包校验值 | 同版本目录下的 `SHA256SUMS` |

在 DevKit 中打开串口和“插件”管理器，选择安装目录，或输入 JSON 包的本地路径进行安装。随后创建配置实例、绑定到串口，再按需要开启自动监听。默认配置收到完整的 `PING` 行后回复 `PONG\r\n`。

不要选择整个仓库根目录作为插件。目录安装会复制选中目录内的文件，分发时优先选上面的干净 `package/` 目录。GitHub Actions 的成功运行也会上传相同的 `dist/` 构建产物，保留 14 天；长期稳定下载可在后续单插件 Release 中提供。

## 目录职责

| 路径 | 职责 |
|---|---|
| `plugins/<slug>/manifest.json` | 稳定插件 ID、该插件版本、API 版本、入口、配置 schema 和动作，版本的唯一来源。 |
| `plugins/<slug>/src/` | 可直接运行的 JavaScript；入口通常为 `src/index.cjs`。 |
| `plugins/<slug>/assets/` | 可选 UTF-8 运行资源；API v1 JSON 包不存放二进制文件。 |
| `plugins/<slug>/test/` | 该插件独立的 `node:test` 测试，文件名为 `*.test.cjs`。 |
| `plugins/<slug>/README.md`、`CHANGELOG.md` | 使用方式和该插件自己的版本记录。 |
| `templates/serial-plugin/` | 新插件模板，不作为已发布插件参与索引与打包。 |
| `scripts/`、`tests/` | 全仓库共用的发现、校验、打包、模板生成与工具测试。 |
| `docs/adding-plugins.md` | 新增插件和维护版本的约定。 |
| `dist/<slug>/<version>/` | 生成的安装产物和校验值，不提交 Git。 |

插件运行文件不会跨目录引用其他插件的源码。共享的是仓库工具；每个安装包都能独立运行。打包只选择 manifest、`src/`、可选 `assets/` 和 LICENSE，测试、文档及开发依赖不进入安装包。

## 新增第二个插件

```sh
npm run new -- my-device --id company.my-device --name "我的设备"
npm run check
```

生成器创建完整模板并刷新 `catalog.json`。命令会拒绝重复目录和重复 ID；随后只需实现新插件的协议和测试，无需改共用脚本。已有插件的版本不会因为仓库增加另一个插件而变化。

常用命令：

| 命令 | 用途 |
|---|---|
| `npm run validate` | 校验仓库结构、清单基本字段、打包范围和索引是否同步。 |
| `npm test` | 自动发现并运行工具测试和所有插件测试。 |
| `npm run catalog` | 修改 manifest 或版本后更新索引。 |
| `npm run pack -- <slug>` | 单独打包一个插件。 |
| `npm run pack:all` | 打包全部插件，分别输出版本目录。 |
| `npm run check:host -- /path/to/DevKit` | 使用真实宿主的 schema 校验器和安装器验证目录及 JSON 包。 |

[新增插件指南](docs/adding-plugins.md)说明接口、测试、变更和发布步骤。仓库工具只做本地结构校验，完整 schema/API 兼容性由真实宿主验证；CI 在 Windows 和 Linux 上均执行两层检查。

## 版本与发布

每个插件使用自己的语义版本号和 CHANGELOG；不要把根 `package.json` 的版本当作插件版本。已被用户使用的插件 ID 和动作 ID 应保持稳定，配置实例属于宿主，不能放进仓库。

建议单插件标签采用 `<slug>/v<version>`，例如 `text-hex-responder/v1.0.0`。此次 CI 只验证和上传构建产物，不会自动创建标签或 Release。安装包中保留源项目的 MIT LICENSE；插件无需运行安装脚本或携带 `node_modules`。

API v1 面向用户信任的本地代码。utilityProcess 方便隔离故障与终止实例，仍具备 Node API；能力声明不是操作系统权限沙箱。

## 来源与许可证

首个插件和查询模板源自 [DevKit](https://github.com/smallfishworld/DevKit) 的插件示例，保留原项目的 [MIT LICENSE](LICENSE) 与版权归属。源码仓库与独立插件包均包含许可证文本。
