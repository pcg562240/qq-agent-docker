# QQ Agent 本地维护约定

- 修改或接入上游前先读 `docs/LOCAL-CUSTOMIZATIONS.md`、`docs/UPSTREAM-MAINTENANCE.md` 和 `docs/local-overrides.json`。
- 主上游为 `K0nd1us/QQ-agent` 的 Git 源码，基线 `upstream-official-base-20261013`。`upstream-linux-base-20261007` / `local-docker-20261011` 仅保留作历史来源；迁移回退点 `before-official-migration-20261013`。不要整目录覆盖或再合并 Linux 上游；在 `codex/` 集成分支合并官方 Git，逐项检查本地行为与回归。
- 官方文件覆盖层记录在 `docs/upstream-source.json`，扩展独立目录清单在 `docs/extensions/catalog.json`。核心更新不覆盖运行卷扩展；迁入新官方版本或修改扩展版本后显式刷新并审阅 inventory。
- 不丢掉官方 QQ 通道、数据隔离、旧页面上下文保护、群 @ 标记、引用图片、发送入队时固定回复目标、外置技能安装和多模型 Key 隔离。
- 修改相关行为时同步文档、机器可读清单和测试；不得通过删除测试来绕过回归失败。
- 完整本地集成仓库运行 `npm run audit:local`；公开仓库 clone 运行 `npm run audit:public`，不要为了补基线标签引入旧历史。两者均运行 `npm run test:local`。迁移核心还运行隔离环境中的 `npm run test:upstream`，它不等于全部桌面测试。Linux 平台测试在容器内跑；原测试有 Windows/Linux 假设，不能把 macOS 原生平台断言当 Docker 故障。
- 不提交或输出 `.env`、数据卷、密钥、聊天记录、运行日志、截图/备份和模型权重。忽略规则不保护已跟踪文件；提交前核对 Git 索引。
- 不自动改动正在运行的机器人身份、模型、名单或技能配置。部署与数据迁移须单独备份、测试，不执行 `docker compose down -v`。
- 不向真实 QQ 自动发测试消息。ComfyUI 实测会使用 GPU/内存，不能纳入普通离线测试自动运行。
- 用户已授权公开发布到 `pcg562240/qq-agent-docker` 和同名 GHCR。只发布经审计的 `public:main` 干净历史与明确发行标签；禁止推本地集成 main、上游标签、`--all` / `--mirror` / `--tags`，详见 `docs/PUBLISHING.md`。新的发布账号、仓库或范围仍需用户确认。
