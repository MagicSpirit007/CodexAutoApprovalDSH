# 来源与 DSH 适配

Codex CLI 来源为工作区 `codex` 的固定 commit `d42056091aded7feb1d88ac7e83972108b2aa478`：

- `codex-rs/prompts/templates/guardian/policy.md`：保留完整租户默认策略。
- `codex-rs/prompts/templates/guardian/policy_template.md`：保留风险分级、授权分级、证据规则与结果策略；替换执行环境并补充 DSH 消息来源。
- Guardian assessment、重试时限和 rejection feedback：移植为 `assessment.ts`、`reviewer.ts`、`denials.ts`。

这是一份 TypeScript 移植，未链接或捆绑 Rust、Codex CLI、Codex app-server 或其鉴权层。DSH 的 provider 注册与凭据服务承担模型适配。

DSH 依据为目标 npm 包 `0.2.0-rc.2` 的运行时类型/实现，以及官方 `639ed015397290b3745d163aafe02ffee4aa3f84` 的 `dsh-auto-review`、`dsh-tools`、`dsh-session`、`dsh-agent`、`dsh-llm`、`dsh-fs`、`dsh-user-approval` 与 `dsh-permission-presets`。`snapshot.ts` 改写自官方 Auto reviewer，保留当前 step 的原生/PTC 日志身份校验和冻结快照。

与宿主原生 Auto reviewer 的差异：审查外层 `run_code`；使用 Codex 四字段协议和完整风险策略；允许私有只读调查；真正拒绝直接交给模型纠正，技术错误才转人工；PTC 内部拒绝额外注入工具来源反馈；提供时限、并发限制、拒绝熔断与安全的卸载回退。

快照包括精确工具 schema、参数、cwd 和当前请求路由。日志保留用户 RPC、直接父来源和约束的原文，即使表层历史已压缩；摘要不能取代授权。输入预算不足时保留操作与可信原文，省略事实并明确标注；若必要内容仍超限则转人工，不以片段自动授权。

没有决策缓存。每次放行绑定 registry 自建的 execution token，最终 monotonic guard 再检查调用取消、插件生命周期、Auto 权限和指令版本。其他插件的 deny/ask/guard 与 DSH 工具 schema 验证仍生效。无法绑定日志的操作不能通过人工回退获得许可。

卸载判断同时读取持久权限事实，避免预设提供方先撤销目录、将 Auto 派生为 custom 后漏掉恢复。正常路径使用预设服务；提供方已消失时，用捕获的已选 bundle 与官方 `setSandboxMode` / `setApprovalPolicy` 写回，再撤销 Auto 贡献。

审批输入与上下文预算有界；目录后端 `listDir` 返回完整数组后再限量，读取窗口通过后端的 `readByteRange`。完整动作历史的查询沿用官方 `snapshotEvents()`：当前公开 API 没有等价的分页动作投影，临时扫描成本仍随持久日志增长；没有另建无限增长的插件日志或审批许可表。与 Codex 一样，模型评估不能提供确定性风险判断；本插件不是 OS 隔离机制。

## 0.1.1 独立权限入口

官方 `auto` 仍由 `@deepseek-ai/dsh-experimental-auto-review` 注册。本插件只注册 `codex-auto-approval`，菜单显示 `CodexAutoApproval`。rc.2 没有通用预设注册接口，因此插件在自己的 effect 生命周期内适配原服务的 `names`、`resolve` 和运行时 `derive`，仅增加本插件身份。原服务实例、配置、远程目录、投影、默认预设和 `registerAuto` 保持原实现；停用会恢复原属性描述符。`derive` 在类型声明中标为私有，因此这层适配限定于已验收的 rc.2，不修改宿主文件或 bundle 的官方权限行。

rc.2 原生委派只捕获 `auto` 和完全访问身份。插件以 effect 包裹公开的 AgentRegistry.create，在调用发生时捕获 Codex 身份，原生 setup 完成后、子代理发布前写入该身份；取消和卸载恢复原方法。子代理原生沙箱和 `never` 策略保持原值，恢复会话沿用持久身份。

停用插件只撤销自己的预设，官方 `auto` 继续可用；从官方模式切换到 Codex 后停用，会恢复原先所选的官方模式。
