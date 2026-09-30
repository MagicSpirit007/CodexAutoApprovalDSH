# DSH Codex 自动审批插件任务

圣人授权：实现已确认方案，交付独立插件源码与 tarball，并上传至
https://github.com/MagicSpirit007/CodexAutoApprovalDSH，编写中英文 README。

- 目标：Windows Desktop DSH 0.2.0-rc.2；官方接口基线 639ed015397290b3745d163aafe02ffee4aa3f84。
- Codex 基线：d42056091aded7feb1d88ac7e83972108b2aa478。
- 新顶层会话默认启用 Auto；子任务继承，恢复会话保留已选权限。
- 复用 DSH 当前 provider/model，允许指定独立审批模型。
- 迁移风险/授权规则、冻结上下文、结构化决策、受限只读核查。
- 审查 native、外层 run_code 和 PTC inner 调用；拒绝仅阻止当前动作，向主模型提供原因和安全续行指令。
- 可恢复技术错误最多尝试三次、总时限 90 秒；耗尽转原生人工审批；取消不转人工。
- 同轮连续 3 次或最近 50 次中 10 次拒绝时停止当前轮次。
- 构建、真实 Loader、配置、错误、取消、并发、卸载、安装及桌面链路按开发资料的 docs/ACCEPTANCE.md 验证；本工程记录于 docs/ACCEPTANCE-RESULTS.md。
- 不修改官方 monorepo，不发布 npm、不提交 PR。

默认边界：工具调用前审查，不提供内核调用拦截；不用任意 shell 或网络作审批核查；不保证固定运行时长。
