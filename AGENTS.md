# DevKit-Plugins 开发约定

先阅读 README.md 和 docs/adding-plugins.md。一个插件一个 plugins/<slug>/ 目录；manifest.json 是该插件版本的唯一来源。保持已使用的插件 ID 和动作 ID 稳定。

- 运行代码放 src/，可选 UTF-8 资源放 assets/；测试放 test/*.test.cjs，文档和测试不打进安装包。
- 插件不能在运行时引用别的插件目录或仓库根工具；依赖须预先打包，不能让宿主运行安装脚本。
- 使用宿主串口 SDK，并顺序 await；每个实例保持独立状态，停止时回收自建资源。
- 修改 manifest 后运行 npm run catalog；所有改动运行 npm run check。打包、接口或目录结构变化，还需 npm run check:host -- <DevKit源码目录>；CI 使用 compatibility.json 的宿主基线。
- 新行为增加协议与生命周期回归，测试使用模拟数据，不把真实设备凭证或用户配置放入仓库。
- 保留上游 MIT 版权与许可证。dist/ 是生成物，不提交；CI 上传安装产物，标签与 Release 按插件单独维护。
- 对目录、校验或生成器的改动，检查路径越界、符号链接和 Windows 路径兼容，避免覆盖已有插件。
