# 验收记录

日期：2026-09-30。插件：`dsh-codex-auto-approval@0.1.0`。

## 实际环境

| 项目 | 实测/证据 |
| --- | --- |
| 目标宿主 | 已安装 Windows DeepSeek Harness Desktop `0.2.0-rc.2`，`D:\DeepSeekHarness\resources\app.asar` |
| DSH 运行时 | npm 官方包及 CLI `0.2.0-rc.2`，实际 types/实现用于编译和功能验收 |
| DSH 源码基线 | `639ed015397290b3745d163aafe02ffee4aa3f84`；已安装 Desktop 的实际源码 commit 未获取 |
| Codex 基线 | `d42056091aded7feb1d88ac7e83972108b2aa478`，Apache-2.0 |
| 源码/产物功能环境 | Linux / WSL，Node `v22.21.1`，pnpm `11.7.0` |
| Windows 实跑 | Desktop 随附 `primary-runtime/dependencies/node/bin/node.exe` 返回 `v24.21.0`；与早先构建元数据中的 Node `24.18.1` 有差异，验收采用实际可执行文件版本 |
| 测试 profile | 每次新建临时 `DSH_HOME`，profile `codex-auto-artifact-test`，结束后删除 |

## 结果

| 检查 | 实跑命令/路径 | 观察结果 | 状态 |
| --- | --- | --- | --- |
| 类型 | `node node_modules/typescript/bin/tsc --noEmit` | 无类型错误 | 通过 |
| 源码功能 | `node --import tsx test/all.ts` | 32 个测试全部通过 | 通过 |
| 构建/打包 | `node /mnt/d/DeepSeekHarness/resources/runtime/pnpm/bin/pnpm.cjs pack --pack-destination artifacts` | prepack 编译通过；包含 ESM、类型、patch、策略与许可证 | 通过 |
| 编译入口与 Loader | `node test/artifact.test.mjs` | 3 个测试全部通过；缺依赖保持 pending；无默认导出；错误配置加载失败 | 通过 |
| 实际 tarball 安装 | `node scripts/accept-package.mjs` | 官方 CLI 安装到新 profile，`--dump-config` 出现插件层 | 通过 |
| 安装后核心功能 | 同一脚本调用官方 `runProfile()` | 真实 runtime resolution、Loader、会话/工具/审批/FS；拒绝操作无副作用，后续放行写入 `approved` | 通过 |
| 停用/移除 | 同一脚本 | Auto 会话恢复 workspace-write；Auto 贡献消失；CLI remove 后 bundle 层消失 | 通过 |
| Windows 基础兼容 | 随附 Node `--check lib/index.js` 与 `test/windows-smoke.mjs` | ESM 语法、决策解析、策略资源读取通过 | 通过 |
| Desktop 界面/真实模型 | Windows 进程只读检查 | 当前 Desktop 未运行；没有调用真实提供方或读取用户凭据 | 未运行 |

## 具体覆盖

真实 Cordis、Loader、AgentRegistry、AgentLoop、Session、工具注册表、原生审批、文件系统、进程服务和 PTC runtime 参与测试。仅模型/API 边界使用确定性适配器。以下结果检查了调用、文件或持久日志，不依靠模型自述：

- 策略拒绝包含原由及 Codex 纠正指引；安全后续动作在同一轮执行。
- 放行保留其他 deny、ask 和 monotonic guard；观察事件不能篡改评估。
- 外层 `run_code` 与内层调用均审查；内部错误被 `catch` 捕获后，主模型仍收到拒绝反馈。
- 模型错误/无效输出重试，超时转人工，`allowed-once` 才执行；`never` 和 unavailable 不执行。
- 调用取消、停用、指令改变和权限改变不能留下可用的旧审批。
- 每轮拒绝熔断保留排队用户输入；全插件并发上限在六个真实代理中生效。
- 原生子代理继承文件权限/Auto 身份并固定 never；新根默认不能覆盖子代理设置。
- 压缩替换不能把摘要提升为授权；长历史请求按 UTF-8 与 JSON 转义计数，保留完整操作并标注省略事实。
- 私有文件调查读取实际内容；拒绝宿主工具调用、超限窗口及二进制内容，没有写入调查目标。
- 手动权限切换、进入 Auto 前的明确预设、插件重载、FS 提供方消失和权限预设提供方自身重载均有回归场景。

## 证据和复现

仓库的 `docs/evidence/` 提供 `source.tap`、`built.tap`、`windows-node.json`、`package-contents.txt` 和 `verification.json`。`verification.json` 保留实际安装验证的结果、规范化命令和交付 tarball 的 SHA-256；安装包与校验文件位于 `artifacts/`。

`build-pack.log`、`package-install.log`、`profile-config.log`、`package-run.log`、`package-result.json`、`package-remove.log` 与 `profile-after-remove.log` 是本地完整日志，含本机路径，按 `.gitignore` 保留在开发环境，不上传仓库。证据文件不捆入运行时 tarball。

`scripts/accept-package.mjs` 使用正式 CLI 执行安装、dump 与移除；功能启动只保留本插件依赖的官方服务并把工具模式设为 native，避免启动无关 UI、凭据和遥测服务。PTC 功能另在源码测试中使用真实进程运行时验证。测试不会修改用户现有 profile。

源码测试的 PTC 子进程控制通道需要本地 IPC；当前编码沙箱限制该通道，完整测试在已获准的沙箱外运行，文件副作用仍只发生在测试专用临时目录。普通本机可直接执行 README 中的脚本。若没有本机 pnpm，可以用 `DSH_TEST_PNPM` 指向一个可用的 `pnpm.cjs`；`DSH_TEST_STORE` 可指定测试缓存目录。

## 证据限制

Windows 检查只证明随附 Node 的基础运行兼容，不能证明 Desktop GUI 或真实 DeepSeek 模型效果。未验证 Electron 内的实际安装/界面、付费模型调用、第三方适配器的取消实现或源码 HMR；已验证 dispose/reload。固定 API 基线不等于已安装 Desktop 的源码 commit。

当前官方公开接口缺少等价的分页动作投影，`snapshotEvents()` 的临时扫描仍随持久日志增长；插件持有的授权、事实窗口、拒绝窗口、审批输入/输出和并发均设置预算。Auto 使用完整宿主访问，由审批模型判断风险，仍受其他宿主门禁约束；它不提供内核级隔离或确定性的安全证明。
