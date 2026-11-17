# 文本 / HEX 自动应答

通过完整文本行或十六进制字节序列触发串口应答。默认收到 `PING` 加换行后，回复 `PONG\r\n`；也可以配置收到 `AA 01` 后回复 `55 FE`。

| 项目 | 内容 |
| --- | --- |
| 插件 ID | `devkit.text-hex-responder` |
| 版本 | `1.0.0` |
| DevKit 插件 API | `1` |
| 入口 | `src/index.cjs` |
| 宿主能力 | `serial.read`、`serial.write` |
| 运行依赖 | Node.js 内置能力与 DevKit 提供的插件 SDK |
| OA / 登录 | 无需配置 |

## 打包与安装

在 **DevKit-Plugins 仓库根目录**执行：

```sh
npm run pack -- text-hex-responder
```

生成的 JSON 插件包为：

```text
dist/text-hex-responder/1.0.0/devkit.text-hex-responder-1.0.0.devkit-plugin.json
```

在 DevKit 的串口面板打开插件管理，导入该 JSON 插件包。也可以选择目录安装，推荐选打包生成的干净目录：

```text
dist/text-hex-responder/1.0.0/package/
```

该目录包含 `manifest.json`、`src/` 和随包保留的许可证。开发时也可以直接选择源码目录 `plugins/text-hex-responder/`；宿主会一并复制目录中的测试和说明文件。目录选择应定位到包含 `manifest.json` 的这一层。

安装之后，创建配置实例，将实例绑定到已连接的串口，再开启该实例的自动监听。安装插件本身不会打开串口或开始发送。需要主动发送时，调用“发送配置的回复”动作。

## 配置

DevKit 根据 `manifest.json` 生成配置表单并填入默认值。插件在激活时再次校验配置；独立调用 `activate()` 的测试或开发代码应传入完整配置。

| 字段 | 默认值 | 含义与范围 |
| --- | --- | --- |
| `mode` | `"text"` | `"text"` 按完整文本行匹配；`"hex"` 按字节序列匹配。 |
| `match` | `"PING"` | 匹配内容，1–4096 个字符。HEX 模式须为非空、完整字节的十六进制文本。 |
| `response` | `"PONG"` | 回复内容，最多 4096 个字符。HEX 模式同样须为非空、完整字节。 |
| `newline` | `"crlf"` | 文本回复追加 `none`、`cr`、`lf` 或 `crlf`；HEX 模式忽略此项。 |
| `ignoreCase` | `false` | 文本模式是否忽略大小写。 |
| `replyDelayMs` | `0` | 每次回复前延时，0–5000 毫秒的整数。 |
| `maxBufferBytes` | `8192` | 接收缓存上限，256–65536 字节的整数。文本未完行按 UTF-8 字节数计算。 |

### 文本示例

```json
{
  "mode": "text",
  "match": "PING",
  "response": "PONG",
  "newline": "crlf",
  "ignoreCase": false,
  "replyDelayMs": 0,
  "maxBufferBytes": 8192
}
```

匹配需要完整一行，以 CR、LF 或 CRLF 结束。数据可以分多次到达：先收到 `PI`，再收到 `NG\r\n`，仍只回复一次。同一批数据包含多条匹配行时，逐条回复。

匹配默认区分大小写，保留首尾空格。`PING`、`ping`、` PING` 和 `PING ` 是不同内容。文本回复正文可以为空；此时应选择一个换行符，确保发送内容非空。

### HEX 示例

```json
{
  "mode": "hex",
  "match": "AA 01",
  "response": "55 FE",
  "newline": "none",
  "ignoreCase": false,
  "replyDelayMs": 0,
  "maxBufferBytes": 8192
}
```

HEX 内容支持空白分隔、大小写字母，例如 `aa 01`、`AA01`。不接受 `0xAA`、单个半字节或非十六进制字符。应答以字节数组交给宿主，文本换行设置不会额外追加字节。

匹配直接使用 `event.bytes`，保留 `00`、`FF` 等任意字节。支持分批到达和同一批数据多次命中；每次匹配会消费已命中的字节，后续匹配不与该次重叠。请确保缓存上限至少覆盖匹配序列的字节数。

## 手动动作

| 动作 ID | 界面名称 | 行为 |
| --- | --- | --- |
| `send` | 发送配置的回复 | 按当前配置主动发送一次回复，包含配置的延时及文本换行。 |
| `reset` | 清空协议缓存 | 清空文本和 HEX 接收缓存，并退出超长行丢弃状态；不发送串口数据，也不重置累计回复次数。 |

手动动作可以通过 DevKit 插件界面或快捷命令调用。插件通过 `ctx.state({ replies })` 报告当前实例累计成功回复次数。

## 接收与停止行为

- 文本模式只处理完整行。未结束的文本行超过缓存上限时，记录警告并丢弃到下一个换行符，避免把被截断行的后缀误认成新指令。
- HEX 缓存超过上限时保留最新字节并记录警告；正常处理后保留可能组成下一次匹配的末尾字节。
- 单次接收回调最多回复 32 次；更多命中会抛出错误，阻止本批继续回复。
- 多个命中按顺序应答，配置的延时作用于每次回复。
- 停止实例时，`dispose()` 清理接收缓存和等待中的延时，取消尚未发送的回复。
- 串口连接、事务互斥、实例绑定以及自动监听开关由 DevKit 宿主管理。插件只通过受控 SDK 写入数据。

## 开发与测试

在仓库根目录单独运行此插件的测试：

```sh
node --test plugins/text-hex-responder/test/responder.test.cjs
```

测试使用 Node.js 内置的 `node:test`、断言和虚拟计时器，无需安装额外测试依赖，也无需启动 DevKit、OA 服务或连接物理串口。

覆盖文本分批与粘包、CR/LF 边界、大小写、Unicode、二进制分批与粘包、缓存上限、超长行恢复、手动动作、延时取消、停止清理、回复洪泛限制、写入失败及非法配置。宿主进程隔离和真实串口连接由 DevKit 的集成验证负责。

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 稳定插件身份、配置 Schema、动作与所需能力。 |
| `src/index.cjs` | 独立 CommonJS 实现；不导入 DevKit 内部源码或原生串口模块。 |
| `test/responder.test.cjs` | 可独立运行的协议行为与生命周期测试。 |
| `CHANGELOG.md` | 本插件的版本变更记录。 |

该插件由 DevKit 主仓库 `6264ff6` 中的 `examples/plugins/text-hex-responder` 迁入。本仓库按插件目录独立维护；插件 ID 保持不变，版本变更记录在本目录的变更日志中。
