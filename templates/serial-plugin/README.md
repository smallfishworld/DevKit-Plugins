# __PLUGIN_NAME__

DevKit 串口查询插件。发送配置中的命令，等待设备返回指定标记后完成动作。此模板衍生自 DevKit 的设备查询示例，插件实现位于 `src/index.cjs`。

| 项目 | 值 |
| --- | --- |
| 插件 ID | `__PLUGIN_ID__` |
| 仓库目录 | `plugins/__PLUGIN_SLUG__/` |
| DevKit API | `1` |
| 动作 ID | `query` |
| 自动应答 | 未启用 |
| 版本来源 | `manifest.json` 的 `version` |

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `AT+VERSION?\r\n` | 查询命令；文本中的 `\r`、`\n` 会转换为回车、换行 |
| `expected` | `OK` | 响应中需要出现的字符串标记 |
| `timeoutMs` | `3000` | 等待响应时间，范围 100–30000 毫秒 |

`expected` 是字符串匹配，不是正则表达式。请按设备协议选择足够明确的标记；这个最小模板不负责完整帧校验。

## 在 DevKit 中使用

1. 在“串口 → 插件 → 已安装插件”中安装构建后的 JSON 插件包，或选择干净的 `dist/__PLUGIN_SLUG__/<version>/package/` 目录。
2. 为此插件新建配置实例，填写命令、响应标记与超时。
3. 打开串口，将该实例绑定到当前串口。
4. 点击“查询设备”，或在快捷命令中添加“插件动作”步骤并选择此实例的 `query` 动作。

安装插件包、保存配置和绑定串口是三个独立操作。保存配置不会自动建立串口连接。

## 开发与验证

以下命令在仓库根目录执行：

```bash
node --test plugins/__PLUGIN_SLUG__/test/plugin.test.cjs
npm run validate
npm test
npm run pack -- __PLUGIN_SLUG__
npm run check
```

版本只在 `manifest.json` 中修改，并同步维护 `CHANGELOG.md`。修改版本或展示元数据后，执行 `npm run catalog` 更新索引。

包产物位于：

```text
dist/__PLUGIN_SLUG__/<version>/__PLUGIN_ID__-<version>.devkit-plugin.json
```

同级 `package/` 是可直接安装的纯运行目录。分发内容包括 manifest、`src/`、可选 `assets/` 和 `LICENSE`；测试与说明文档不会入包。目录安装会复制所选目录中的文件，因此分发时使用 `package/`，源码目录只用于开发调试。

可选的真实宿主兼容检查：

```bash
npm run check:host -- /path/to/DevKit
```

## 实现约定

- 使用 `ctx.serial.exchange()` 完成查询，并顺序 `await` 串口操作。插件不自行打开串口。
- 认证、二进制分帧或复杂设备状态机应在插件中按实际协议实现；这个模板仅提供最小查询流程。
- 用 `dispose()` 清理自己创建的计时器和监听器。当前模板没有后台任务。
- API v1 插件是可信本地代码，独立进程用于隔离故障，不构成不可信代码沙箱。
- 保持插件 ID、动作 ID 和配置实例 ID 稳定。目录名不参与 DevKit 宏引用；重命名目录不应修改这些 ID。

扩展与发布约定见 [新增插件指南](../../docs/adding-plugins.md)。
