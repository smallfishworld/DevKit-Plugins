# OA 设备解锁

通过 OA 会话读取设备挑战码、申请一次性口令并注入设备，最后验证设备是否接受。支持手动解锁与常驻自动应答；自动应答在授权期间扣住用户输入，成功后才补发。

| 项目 | 内容 |
| --- | --- |
| 插件 ID | `devkit.oa-debug` |
| 版本 | `1.0.0` |
| DevKit 插件 API | `1` |
| 入口 | `src/index.cjs` |
| 宿主能力 | `serial.read`、`serial.write`、`serial.exclusive`、`auth.session` |
| 运行依赖 | Node.js 内置能力与 DevKit 提供的插件 SDK |
| OA / 登录 | 需要公司 OA 登录页、会话检查接口与取码接口 |

插件 ID 与旧版内置 OA 解锁保持一致。DevKit 升级后不再内置该功能；安装本插件后，DevKit 才会把已有的 `device-actions.json` 迁移成插件实例。未安装前旧配置不会被读取或删除。

## 打包与安装

在 **DevKit-Plugins 仓库根目录**执行：

```sh
npm run pack -- oa-unlock
```

生成的 JSON 插件包与目录安装包位于：

```text
dist/oa-unlock/1.0.0/devkit.oa-debug-1.0.0.devkit-plugin.json
dist/oa-unlock/1.0.0/package/
```

在 DevKit 串口面板打开插件管理，导入 JSON 包或选择 `package/` 目录。插件是可信本地代码，由 DevKit 的独立进程运行，但不是安全沙箱；安装或更新前请确认来源。

安装后创建配置实例、绑定到已连接的串口，再选择手动动作或开启自动监听。安装插件本身不会打开串口，也不会开始发送。

## 配置

DevKit 配置表单中的 `deviceActions` 就是原先 `device-actions.json` 的内容，结构与旧内置版本一致；`profileId` 选择手动动作，`auto` 允许本实例自动应答。

```json
{
  "loginUrl": "https://oa.example.com/login",
  "authOrigins": [],
  "authCheck": {
    "type": "json",
    "url": "https://oa.example.com/api/session",
    "field": "authenticated"
  },
  "issue": {
    "url": "https://oa.example.com/api/device/token",
    "body": { "challenge": "$challenge" },
    "responsePath": "response",
    "loginExpiredHttp": [401, 403],
    "loginExpiredCodes": [],
    "retryLoginOnce": true
  },
  "profiles": [
    {
      "id": "debug-unlock",
      "label": "Release 设备解锁 Debug",
      "actionLabel": "解锁 Debug",
      "kind": "challenge-response",
      "trigger": "manual",
      "detect": { "type": "prefix", "prefix": "Challenge:" },
      "result": { "type": "line", "successLine": "Debug unlocked", "failureLine": "Debug denied" },
      "command": "debug",
      "newline": "cr",
      "challengeTimeoutMs": 5000,
      "challengeTtlMs": 30000,
      "resultTimeoutMs": 5000,
      "holdInput": false
    },
    {
      "id": "debug-auto",
      "label": "Release 设备自动解锁",
      "actionLabel": "自动解锁 Debug",
      "kind": "challenge-response",
      "trigger": "auto",
      "triggerWords": ["debug"],
      "detect": {
        "type": "base64-line",
        "shortMin": 20,
        "shortMax": 21,
        "longMin": 300,
        "longMinDecoded": 260
      },
      "result": { "type": "prompt-repeat", "promptText": "Password:", "decisionDelayMs": 150, "silenceMs": 3000 },
      "newline": "cr",
      "challengeTimeoutMs": 5000,
      "challengeTtlMs": 30000,
      "resultTimeoutMs": 5000,
      "holdInput": { "maxBytes": 4096, "maxMs": 15000 }
    }
  ]
}
```

### 顶层字段

| 字段 | 含义 |
| --- | --- |
| `loginUrl` | OA 登录入口，必须为 HTTPS。登录检查与取码接口必须与其同源。 |
| `authOrigins` | 登录窗口额外允许跳转的来源，只能是 `http(s)://host[:port]`；用于企业 SSO 回跳。 |
| `authCheck` | 会话检查。`json` 读取点路径字段并要求为 `true`；`http-ok` 只要求 2xx 且不跳转。 |
| `issue.url` | 取码接口，必须与登录入口同源。 |
| `issue.body` | POST JSON 模板，至少一个值包含 `$challenge`，运行时替换为设备挑战码。 |
| `issue.responsePath` | 从响应中点路径取口令；未命中时会尝试其父级字符串（兼容 `data.data`）。 |
| `issue.loginExpiredHttp` | 视为登录失效的 HTTP 状态，默认 `[401, 403]`。 |
| `issue.loginExpiredCodes` | 视为登录失效的业务 `code`，默认空。 |
| `issue.retryLoginOnce` | 登录失效时自动重登一次并重试取码，默认 `true`。 |
| `issue.userAgent` | 可选自定义 User-Agent；不填时由宿主会话提供。 |

### 设备动作

`trigger: "manual"` 的动作由插件动作或快捷命令发起，必须配置 `command`，插件先发送命令再等待挑战码。

`trigger: "auto"` 的动作常驻监听串口输出，命中 `triggerWords` 时先扣住用户输入，命中挑战码后自动执行。`detect` 支持：

- `{ "type": "prefix", "prefix": "Challenge:" }`：行首前缀后的内容作为挑战码。
- `{ "type": "base64-line", "shortMin": 20, "shortMax": 21, "longMin": 300, "longMinDecoded": 260 }`：按长度与解码后长度识别裸 base64 挑战码。

`result` 支持：

- `{ "type": "line", "successLine": "...", "failureLine": "..." }`：整行精确匹配成功/失败提示。
- `{ "type": "prompt-repeat", "promptText": "Password:", "decisionDelayMs": 150, "silenceMs": 3000 }`：注入口令后若设备重新索要口令则判定拒绝；无输出到 `silenceMs` 或首行输出后 `decisionDelayMs` 内未再次索要口令则判定成功。

`challengeTtlMs` 从收到挑战码开始计算。取码耗时超过该时限、或取码后已过期，都会中止并提示“设备挑战码已过期”。

## 动作与自动应答

| 动作 ID | 界面名称 | 行为 |
| --- | --- | --- |
| `run` | 执行设备动作 | 使用 `args.profileId`、实例的 `profileId` 或配置中第一个手动动作执行一次解锁。 |

自动解锁只在实例启用自动监听且配置的 `auto` 不为 `false` 时生效。流程为：

1. 命中触发词时扣住用户输入，避免把按键送进口令提示。
2. 命中挑战码后取得串口独占事务，必要时先登录 OA。
3. 申请口令并注入设备（口令以 secret 写入，不回显到终端历史）。
4. 设备接受后按原顺序补发扣住的输入；拒绝、超时或出错则丢弃。

同一实例同一时间只执行一个解锁。串口事务获取失败、文件传输占用、连接变化或实例停止都会安全退出并释放租约。

## 安全与隐私

- Cookie 只保存在 DevKit 宿主的 Chromium 独立持久分区中，不写入插件配置、宏或日志。
- 口令通过 `ctx.serial.write(..., { secret: true })` 注入，由宿主屏蔽回显；插件日志和状态只描述阶段与结果。
- 取码失败只报告结构（字段名、长度、业务 code），绝不输出可能的口令。
- 登录窗口只允许配置的来源跳转，拒绝 `window.open`，禁用权限请求。

## 开发与测试

```sh
node --test plugins/oa-unlock/test/oa-unlock.test.cjs
```

测试使用模拟 OA 接口与模拟串口，不连接真实设备，也不调用 DevKit 或 Electron。覆盖手动解锁、自动触发与扣键补发、拒绝判定、登录过期重登、配置校验、挑战码分行匹配以及口令不进日志/状态。

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 稳定插件身份、配置 Schema、动作与宿主能力。 |
| `src/index.cjs` | 独立 CommonJS 实现；不导入 DevKit 内部源码、Electron 或原生串口模块。 |
| `test/oa-unlock.test.cjs` | 模拟宿主下的协议、生命周期与隐私回归。 |
| `CHANGELOG.md` | 本插件的版本变更记录。 |

## 从内置 OA 解锁迁移

DevKit 旧版本内置 `devkit.oa-debug`。升级后该内置实现被移除，但审计记录、宏和实例 ID 仍然有效：

1. 在 DevKit 插件管理中安装本插件。
2. DevKit 检测到已安装 `devkit.oa-debug` 后，把用户目录下的 `device-actions.json` 迁移为插件实例（每个 profile 一个 `legacy-<id>` 实例）。
3. 迁移失败时会在插件日志中提示，不影响其他插件；修复或移除旧配置后可在插件页重试迁移。
4. 旧 `device-actions.json` 不会被自动删除。
