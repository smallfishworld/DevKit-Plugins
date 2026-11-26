# 串口取数回传

设备在串口输出命中规则后，插件从 HTTPS 接口取回数据（或使用固定值、本地映射表），再把结果回传到串口。触发词、内容匹配、结果确认、行尾、超时与扣键都可以在 DevKit 表单中逐条配置。自动回传期间会扣住用户输入，成功后才按原顺序补发。

这是通用的“网址取数 → 串口回传”插件：设备挑战码解锁、授权码/校验码获取、后台下发配置等场景都可以用同一套流程实现，不绑定任何特定厂商的 OA。

| 项目 | 内容 |
| --- | --- |
| 插件 ID | `devkit.serial-url-relay` |
| 版本 | `1.0.0` |
| DevKit 插件 API | `2` |
| 会话类型 | `serial`（输入扣留仅串口支持） |
| 入口 | `src/index.cjs` |
| 宿主能力 | `stream.read`、`stream.write`、`stream.exclusive`、`auth.session` |
| 运行依赖 | Node.js 内置能力与 DevKit 提供的插件 SDK |
| 登录 | 仅 `replySource: "http"` 需要登录页、会话检查接口与取数接口 |

## 打包与安装

在 **DevKit-Plugins 仓库根目录**执行：

```sh
npm run pack -- serial-url-relay
```

生成的 JSON 插件包与目录安装包位于：

```text
dist/serial-url-relay/1.0.0/devkit.serial-url-relay-1.0.0.devkit-plugin.json
dist/serial-url-relay/1.0.0/package/
```

在 DevKit 的扩展中心，导入 JSON 包或选择 `package/` 目录。插件是可信本地代码，由 DevKit 的独立进程运行，但不是安全沙箱；安装或更新前请确认来源。

安装后创建配置实例、绑定到已连接的串口，再选择手动动作或开启自动监听。安装插件本身不会打开串口，也不会开始发送。

## 配置

配置由 `manifest.json` 的 Schema 驱动：顶层字段描述回传内容来源，`rules` 数组描述每种设备动作。表单默认只展示因环境而异的字段；各类超时、缓存上限、字符集校验等调参字段收在「高级选项」折叠区（标记了 `x-advanced`），保持默认即可，完整 JSON 页签仍可编辑全部字段。

### 选择回传内容来源

| `replySource` | 适用场景 | 必填字段 |
| --- | --- | --- |
| `http`（默认） | 内网接口按设备输出换回数据 | `loginUrl`、`authCheckUrl`、`fetchUrl`（以及需要的请求体模板） |
| `static` | 设备接受固定口令或应答 | `staticReply`，不使用 `auth.session` |
| `map` | 少数固定输出、离线环境 | `replyMap`，设备输出必须完全一致 |

新建实例默认是 `http`，因此首次绑定前必须填写上述地址；缺少时会直接提示还缺哪几项，而不是只报“地址无效”。

### 通用字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `ruleId` | 空 | 手动执行默认使用的规则 `id`；留空取第一条手动规则。也可用动作参数 `args.ruleId` 临时指定。 |
| `auto` | `true` | 允许自动回传。设为 `false` 时即使开启“绑定后自动监听”，也不会自动匹配设备输出或回传内容。 |
| `replyCharset` | `base64` | 回传内容字符集校验。`base64` 接受字母数字与 `. _ ~ + / = -`；`printable` 接受任意可打印字符。 |
| `replyMinLength` / `replyMaxLength` | `4` / `4096` | 回传内容长度范围，适用于三种来源。 |

### HTTP 取数字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `loginUrl` | — | 登录入口，必须为 HTTPS。登录检查与取数接口必须与其同源。 |
| `authOrigins` | 空 | 登录窗口额外允许跳转的来源，英文逗号分隔，只能是 `http(s)://host[:port]`。 |
| `authCheckType` | `json` | 会话检查方式。`json` 要求点路径字段为 `true`；`http-ok` 只要求 2xx 且不跳转。 |
| `authCheckUrl` / `authCheckField` | — / `authenticated` | 会话检查接口与字段点路径。 |
| `fetchMethod` | `POST` | 取数请求方法。`GET` 时地址中必须包含 `$value`。 |
| `fetchUrl` | — | 取数接口，必须与登录入口同源。 |
| `fetchBody` | `{"value": "$value"}` | POST 请求体模板；至少一个值包含 `$value`，运行时替换为设备输出匹配到的内容。 |
| `fetchResponsePath` | 空 | 从响应 JSON 中点路径取回传内容，例如 `data.token`；留空则原样回传响应文本（自动去掉首尾空白）。未命中路径时会回退到父级字符串（兼容 `data.data`）。 |
| `fetchLoginExpiredHttp` | `401,403` | 视为登录失效的 HTTP 状态，英文逗号分隔。 |
| `fetchLoginExpiredCodes` | 空 | 视为登录失效的业务 `code`，英文逗号分隔，例如 `003,403003`。 |
| `fetchRetryLoginOnce` | `true` | 登录失效时自动重登一次并重试取数。 |
| `fetchUserAgent` | 空 | 可选自定义 User-Agent；留空使用宿主登录会话的浏览器 UA。 |

> 提示：不同接口的响应结构差异很大。若取数一直报“未返回有效内容”，先看诊断里的 `code` 与字段结构，再调整 `fetchResponsePath`；日志不会输出响应中的内容本身。

### 规则（`rules`）

每条规则对应一种设备动作，字段如下：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `id` | `rule-1`… | 规则 ID，手动执行与 `ruleId` 使用它。留空自动按序号生成。 |
| `label` / `actionLabel` | `id` / `取数回传` | 规则名称与手动按钮名称。 |
| `trigger` | `manual` | `manual` 由插件动作发起，先发送 `command`；`auto` 常驻监听设备输出。 |
| `triggerWords` | 空 | 自动规则的触发词，英文逗号分隔、**区分大小写**、按整行匹配；自动折叠退格并容忍 `# $ > %` 提示符。命中时先扣住用户输入。 |
| `match` | `prefix` | `prefix`：行首前缀后的内容作为输入；`base64-line`：按长度与解码后长度识别裸 base64；`line`：任意一整行内容（触发词所在行除外）。 |
| `prefix` | `Challenge:` | `prefix` 匹配的行首前缀。 |
| `shortMin` / `shortMax` / `longMin` / `longMinDecoded` | `20` / `21` / `300` / `260` | `base64-line` 的短码与长码（RSA 挑战）判定边界。 |
| `result` | `line` | `line`：整行精确匹配成功/失败提示；`prompt-repeat`：回传后再次出现提示即判定拒绝；`none`：写入后立即结束，不等待设备确认。 |
| `successLine` / `failureLine` | — | `line` 判定的两行提示，不能相同。 |
| `promptText` / `decisionDelayMs` / `silenceMs` | `Password:` / `150` / `3000` | `prompt-repeat` 的提示文本与判定时序。 |
| `command` | — | 手动起始命令；自动规则不会发送它。 |
| `newline` | `cr` | 行尾：`cr`、`lf`、`crlf` 或 `none`。 |
| `replyTemplate` | `$value` | 回传内容模板，可用 `$value` 引用取回的数据，例如 `auth $value`；留空等同于 `$value`。 |
| `inputTimeoutMs` / `valueTtlMs` / `resultTimeoutMs` | `5000` / `30000` / `5000` | 等待设备输出、取回内容有效期、等待结果的毫秒上限。 |
| `holdInput` | `true` | 自动规则是否扣住用户输入（仅串口）。 |
| `holdMaxBytes` / `holdMaxMs` | `4096` / `15000` | 扣键缓存上限与最长时间；超出或超时即丢弃。 |

`valueTtlMs` 从收到设备输出开始计算；取数耗时超过该时限或取数后已过期，都会中止并提示“设备输出已过期”。

### 示例：接口取数后回传

```json
{
  "replySource": "http",
  "loginUrl": "https://relay.example.com/login",
  "authCheckType": "json",
  "authCheckUrl": "https://relay.example.com/api/session",
  "authCheckField": "authenticated",
  "fetchUrl": "https://relay.example.com/api/device/reply",
  "fetchBody": { "input": "$value" },
  "fetchResponsePath": "data.reply",
  "rules": [
    {
      "id": "auto",
      "label": "自动取数回传",
      "trigger": "auto",
      "triggerWords": "fetch,Fetch",
      "match": "base64-line",
      "result": "prompt-repeat",
      "promptText": "Password:",
      "newline": "cr",
      "replyTemplate": "$value",
      "holdInput": true
    }
  ]
}
```

### 示例：固定应答

```json
{
  "replySource": "static",
  "staticReply": "S3CR3T-UNLOCK",
  "rules": [
    {
      "id": "factory",
      "label": "出厂口令",
      "actionLabel": "发送口令",
      "trigger": "manual",
      "match": "prefix",
      "prefix": "Challenge:",
      "result": "line",
      "successLine": "Unlocked",
      "failureLine": "Denied",
      "command": "unlock"
    }
  ]
}
```

### 示例：设备输出映射表

```json
{
  "replySource": "map",
  "replyMap": [
    { "input": "BgAAAAAAIzRFZr9OWCI=", "reply": "REPLY-FOR-DEVICE-1" },
    { "input": "BgAAALxeMx/PUkxhLwM=", "reply": "REPLY-FOR-DEVICE-2" }
  ],
  "rules": [
    {
      "id": "auto",
      "label": "自动回传",
      "trigger": "auto",
      "triggerWords": "fetch",
      "match": "base64-line",
      "result": "prompt-repeat"
    }
  ]
}
```

映射表未命中的设备输出会明确失败，不会写入任意内容。

## 动作

| 动作 ID | 界面名称 | 行为 |
| --- | --- | --- |
| `run` | 执行取数回传 | 按 `args.ruleId`、实例 `ruleId` 或第一条手动规则取数并回传一次。 |
| `reset` | 重置监听缓存 | 取消正在等待的设备输出 / 结果，清空未完成行的缓存，并丢弃当前扣住的输入。 |

自动回传只在实例启用自动监听且 `auto` 不为 `false` 时生效。只有手动规则时插件照常启动，并记录一条“自动监听不会生效”的警告，手动动作仍可使用。流程为：

1. 命中触发词时扣住用户输入，避免把按键送进设备的输入提示。
2. 命中设备输出后取得串口独占事务；`http` 来源会先完成登录（必要时）。
3. 取回数据并按模板回传（以 secret 写入，不回显到终端历史）。
4. 设备接受后按原顺序补发扣住的输入；拒绝、超时或出错则丢弃。

同一实例同一时间只执行一次回传。串口事务获取失败、文件传输占用、连接变化或实例停止都会安全退出并释放租约。

## 安全与隐私

- Cookie 只保存在 DevKit 宿主的 Chromium 独立持久分区中，不写入插件配置、宏或日志。
- 回传内容通过 `await ctx.stream.acquire()` 取得的事务租约，以 `lease.write(..., { secret: true })` 写入，由宿主屏蔽回显；插件日志和状态只描述阶段与结果。
- 取数失败只报告结构（字段名、长度、业务 code），绝不输出可能的内容。
- 登录窗口只允许配置的来源跳转，拒绝 `window.open`，禁用权限请求。
- `static` 与 `map` 来源的内容会保存在插件配置里，请自行评估本机与备份的访问范围；更敏感的场景应使用 `http` 来源配合宿主登录会话。

## 开发与测试

```sh
node --test plugins/serial-url-relay/test/serial-url-relay.test.cjs
npm run check
npm run check:host -- /path/to/DevKit
```

`node --test` 只跑本插件的协议与生命周期测试；`npm run check` 额外校验仓库结构、目录索引与安装包；`check:host` 用真实 DevKit 安装器和官方 SDK 验证 API v2 契约。

测试使用模拟接口与模拟串口，不连接真实设备，也不调用 DevKit 或 Electron。覆盖三种来源（含 `GET` 取数、纯文本响应）、手动动作、自动触发与扣键补发、拒绝判定（提示重复与失败行）、登录过期重登、配置校验、回传模板、`result: none`、跨批次分行匹配、内容不进日志/状态，以及停止时取消等待、清理租约和拒绝迟到发送。

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 稳定插件身份、配置 Schema、动作与宿主能力。 |
| `src/index.cjs` | 独立 CommonJS 实现；不导入 DevKit 内部源码、Electron 或原生串口模块。 |
| `test/serial-url-relay.test.cjs` | 模拟宿主下的协议、生命周期与隐私回归。 |
| `test/fixture.cjs`、`test/host-contract.cjs` | 合成设备/接口配置及真实 SDK 契约矢量，不打入运行包。 |
| `CHANGELOG.md` | 本插件的版本变更记录。 |
