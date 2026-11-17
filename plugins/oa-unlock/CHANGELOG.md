# 变更记录

## 1.0.0 — 2026-11-17

首个独立仓库发布：从 DevKit 内置 OA 设备动作迁出为外部插件。

### 功能与兼容

- 保留插件 ID `devkit.oa-debug`、配置结构 `{ deviceActions, profileId, auto }` 与动作 ID `run`，已有实例与宏无需改名。
- 保留 OA 登录、会话检查、挑战码识别、取码、口令注入和结果验证流程。
- 保留手动解锁与常驻自动应答；自动应答在授权期间扣住用户输入，设备接受后才补发。
- 保留登录过期自动重登一次、挑战码 TTL、prefix/base64 挑战码识别以及 `line` / `prompt-repeat` 结果判定。
- 改用宿主通用能力 `serial.subscribe`、`serial.acquire`、`serial.hold` / `releaseHold` 与 `auth.session`，不依赖 DevKit 内部 OA 类。

### 安全与隐私

- 口令只以 `secret` 写入，不回显到终端历史。
- Cookie 由宿主 Chromium 独立持久分区保存，不进入插件配置、宏或诊断。
- 取码失败只输出字段结构与业务 code，不输出响应中的口令值。
- 登录窗口限制主框架跳转来源并拒绝弹窗。

### 验证

- 覆盖手动解锁、自动触发与扣键补发、拒绝判定、登录过期重登、配置校验、跨批次分行匹配及口令不进入日志/状态。
