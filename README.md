# DevKit Plugins

DevKit 设备插件仓库。每个插件独立维护协议逻辑、配置清单、测试和版本；宿主继续持有会话连接，并负责会话绑定、事务互斥和停止清理。

## 当前插件

| 插件 | ID | 用途 |
|---|---|---|
| [文本 / HEX 自动应答](plugins/text-hex-responder/README.md) | `devkit.text-hex-responder` | 在串口、SSH、网络会话中按多条文本 / HEX 规则自动回复，支持手动发送和清空缓存，无需 OA。 |
| [OA 设备解锁](plugins/oa-unlock/README.md) | `devkit.oa-debug` | 串口设备挑战码、OA 会话取码、口令注入与结果验证，保留手动和自动扣键补发流程。 |

机器可读目录是 [catalog.json](catalog.json)，由各插件 manifest 生成，不能手工维护第二份版本号。该目录用于仓库浏览和构建。DevKit 扩展中心默认使用[官方安装索引](https://github.com/smallfishworld/DevKit-Plugins/releases/download/install-index-v2/index.json)，索引包含正式包的下载地址和 SHA-256。

## 使用插件

需要支持**设备插件 API v2** 以及插件所声明能力的 DevKit。CI 使用 [compatibility.json](compatibility.json) 中的完整宿主提交 SHA，对官方 SDK、真实安装器和 Electron 独立进程执行兼容验证。OA 插件还需要 `stream.exclusive` 和 `auth.session` 能力；只有基础 API v2 的旧宿主不足以运行它。

安装开发环境为 Node.js 22 或更新版本：

```sh
npm ci
npm run check
```

以文本 / HEX 插件为例，打包会生成两种等价的安装产物：

| 产物 | 路径 |
|---|---|
| 自包含 JSON 包 | `dist/text-hex-responder/2.0.0/devkit.text-hex-responder-2.0.0.devkit-plugin.json` |
| 干净安装目录 | `dist/text-hex-responder/2.0.0/package/` |
| JSON 包校验值 | 同版本目录下的 `SHA256SUMS` |

在 DevKit 的“扩展中心”安装插件，选择安装目录，或输入 JSON 包的本地路径进行安装。随后创建配置实例、绑定到支持的已连接会话，再按需要开启自动监听。默认配置收到完整的 `PING` 行后回复 `PONG\r\n`。

不要选择整个仓库根目录作为插件。目录安装会复制选中目录内的文件，分发时优先选上面的干净 `package/` 目录。GitHub Actions 的成功运行也会上传相同的 `dist/` 构建产物，保留 14 天；长期安装包可从各插件的 GitHub Release 下载。

## 目录职责

| 路径 | 职责 |
|---|---|
| `plugins/<slug>/manifest.json` | 稳定插件 ID、该插件版本、API 版本、入口、配置 schema 和动作，版本的唯一来源。 |
| `plugins/<slug>/src/` | JavaScript 或预打包的 TypeScript 源码；安装包入口通常为 `src/index.cjs`。 |
| `plugins/<slug>/assets/` | 可选 UTF-8 运行资源；API v2 JSON 包不存放二进制文件。 |
| `plugins/<slug>/test/` | 该插件独立的 `node:test` 测试，文件名为 `*.test.cjs`。 |
| `plugins/<slug>/README.md`、`CHANGELOG.md` | 使用方式和该插件自己的版本记录。 |
| `templates/serial-plugin/` | 新插件模板，不作为已发布插件参与索引与打包。 |
| `scripts/`、`tests/` | 全仓库共用的发现、校验、打包、模板生成与工具测试。 |
| `docs/adding-plugins.md` | 新增插件和维护版本的约定。 |
| `dist/<slug>/<version>/` | 生成的安装产物和校验值，不提交 Git。 |

插件运行文件不会跨目录引用其他插件的源码。共享的是仓库工具；每个安装包都能独立运行。打包只选择 manifest、`src/`、可选 `assets/` 和 LICENSE，测试、文档及开发依赖不进入安装包。

## 新增插件

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
| `npm run check:host -- /path/to/DevKit` | 使用真实安装器验证目录及 JSON 包，并在全部声明的会话类型上验证官方 SDK 契约。 |
| `npm run check:electron -- /path/to/DevKit` | 在已构建的真实宿主中，逐个验证打包插件的界面和独立进程。 |

[新增插件指南](docs/adding-plugins.md)说明接口、测试、变更和发布步骤。仓库工具只做本地结构校验，完整 schema/API 兼容性由真实宿主验证；CI 在 Windows 和 Linux 上均执行两层检查。

## 版本与发布

每个插件使用自己的语义版本号和 CHANGELOG；不要把根 `package.json` 的版本当作插件版本。已被用户使用的插件 ID 和动作 ID 应保持稳定，配置实例属于宿主，不能放进仓库。

单插件标签采用 `<slug>/v<version>`，例如 `text-hex-responder/v2.0.0`。普通 CI 验证并上传构建产物；将 `releases/request.json` 的发布请求合并到 `main` 后，发布流程通过校验才会创建相应标签和 Release、更新官方安装索引。修正 `compatibility.json` 并合并到 `main` 也会重试已有发布请求，发布流程仍执行同版本哈希不可变检查；不会自动把目录中的其他插件加入请求。发布流程也支持手动触发。安装包中保留源项目的 MIT LICENSE；插件无需运行安装脚本或携带 `node_modules`。

API v2 面向用户信任的本地代码。utilityProcess 方便隔离故障与终止实例，仍具备 Node API；能力声明不是操作系统权限沙箱。

## 来源与许可证

首个插件和查询模板源自 [DevKit](https://github.com/smallfishworld/DevKit) 的插件示例，保留原项目的 [MIT LICENSE](LICENSE) 与版权归属。源码仓库与独立插件包均包含许可证文本。
