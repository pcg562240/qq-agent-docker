# QQ Agent Docker 本地改动清单

这份清单用于合并上游更新时保留本地功能。它记录已经落盘的实现、关键接入点和回归要求，不把研究过的方案当作已交付功能。更新操作见 [上游更新维护流程](UPSTREAM-MAINTENANCE.md)，机器可读清单见 [local-overrides.json](local-overrides.json)。

## 基线和当前状态

- 直接代码基线：[prolet1966/QQ-Agent-for-Linux](https://github.com/prolet1966/QQ-Agent-for-Linux)，提交 `da6f0560c1c7530a985bb4c1542a88cae104b80e`，日期 2026-10-07，包版本 0.4.7。已通过 Git 拉取核实，标签 `upstream-linux-base-20261007` 固定原版。
- 2026-10-10 至 2026-10-11 的定制内容原来没有逐次 Git 提交；现在作为一个真实上游提交之上的本地定制提交保存，**不伪造逐次提交历史**。基准标签为 `local-docker-20261011`。
- Mac 上运行的是 Linux Docker headless 服务，不是 macOS 原生 Electron/QQ 客户端移植；没有部署有头 QQ、NapCat、SnowLuma 或反编译补丁。
- QQ 官方 API 通过固定依赖 `@tencent-connect/qqbot-nodejs@1.0.4`；扫码使用 `@tencent-connect/qqbot-connector@1.2.0`。不依赖 OpenClaw/QwenPaw 运行时。
- 本地已有两个机器人配置，每次只运行一个；模型服务共用，聊天、记忆、名单、技能和凭据按机器人隔离。用户已确认私聊、加群；近期部署检查显示当前 QQ 已连接。
- 建立 Git 前，核心 Docker + ComfyUI + Steam 专项共 **142 项测试**，本机和 Linux 容器均通过；测试发送器使用替身，不向真实群自动发送测试消息。真实账号行为仍需人工验收，测试通过不是永不封号或平台权限承诺。
- 代码备份不等于数据备份：Git 不保存 `.env`、Docker 数据卷、聊天记录、模型密钥、截图原稿、权重或运行日志。

## 必须保留的改动

每项都对应 JSON 清单中的稳定 ID。合并中可以重构文件，但须同时迁移行为、测试和清单，不能只把测试删除来消除冲突。

### L01 Docker 运行时和环境隔离

**文件**：`Dockerfile`、`compose.yaml`、`.dockerignore`、`.env.example`、`scripts/docker-init.mjs`、`src/docker-server.js`、`src/docker-env.js`、`src/server.js`、`src/app.js`、`skills/image-generate/index.js`。

- 生产依赖与运行镜像分阶段构建，Node.js 22、非 root、只读 `/app`、`/data` 命名卷、`/tmp` tmpfs、去 capabilities、健康检查和正常停机。
- 在导入配置/应用之前选定机器人目录；环境覆盖不回写密钥，初始化已有 `.env` 时不覆盖密码。
- Docker 不自动启动桌面 QQ/SnowLuma/MongoDB，不后台同步社区名单或价格表，不在启动时预热免费图片模型；用户主动操作仍按能力和配置执行。
- 默认只监听宿主回环；不把宿主程序、权重、私人配置或 `node_modules` 打入源码提交。

**测试**：`docker-channel`、`docker-http`、`docker-console-network`；容器 UID、只读根、卷和健康检查另做部署验收。

### L02 官方 QQ 通道和字符串 ID

**文件**：`src/qqbot.js`、`src/app.js`、`src/config.js`、`src/store.js`、`src/memory.js`、`src/tools.js`、`src/tool-registry.js`、`src/sender.js`、`ui/app/00-core.js`、`ui/app/01-boot.js`、`ui/app/05-memory-settings.js`、`ui/app/06-settings-render.js`、`ui/app/07-settings-events.js`。

- 官方 Gateway/REST 映射到 Agent 所需接口，保留外部 OneBot 模式；SDK `ready/resumed` 才代表就绪，不能等待永久运行的 `start()` 完成才启动 HTTP。
- AppID、OpenID、消息 ID 全程按字符串处理，包括含连字符的 ID、HTTP 路由、存档、提示词和记忆操作。
- 先白名单过滤再正文入库；未授权会话只保留发现信息。去重账本有界持久化，失败不提前确认；不宣称崩溃时严格 exactly-once。
- 媒体读取限制在允许的数据目录并检查真实路径；官方通道不使用旧 base64/跨机读取回退绕过边界。未实现的 OneBot 专用能力隐藏或明确返回错误。

**测试**：`docker-channel`、`docker-sdk`、`docker-agent`、`docker-http`。

### L03 局域网控制台和连接诊断

**文件**：`src/console-auth.js`、`src/app.js`、`src/docker-env.js`、`src/qqbot.js`、`ui/login.*`、`ui/connection.*`、`compose.yaml`。

- 局域网需显式设置绑定地址、精确 Host/端口名单以及控制台密码；保留登录、API/SSE 鉴权、HttpOnly/SameSite Cookie、同源检查。
- 不信任任意转发头，不用通配 Host，不因开放 LAN 放开 QQ 群白名单。
- 保留腾讯 `/gateway` 返回的具体错误。腾讯源 IP 白名单、控制台 Host 名单、允许聊天 OpenID 名单是三个不同机制。

**测试**：`docker-console-network`、`docker-http`、`docker-channel`。

### L04 手机 QQ 扫码授权

**文件**：`src/qqbot-login.js`、`src/qqbot-login-routes.js`、`src/app.js`、`ui/connection.*`、`package.json`、`package-lock.json`。

- 本地生成二维码图，手机确认授权后仍需页面确认才写入配置；允许选择本次授权的机器人。
- 凭据只在服务端暂存，状态接口不回传明文；过期、取消、替换和迟到回调不能重新写入旧凭据。
- 自动将扫码人加入私聊名单必须由用户勾选；扫码不是自动开放群或取得全部平台权限。

**测试**：`docker-qq-login`、`docker-profiles-http`、`docker-http`。

### L05 多机器人隔离和切换

**文件**：`src/robot-profiles.js`、`src/robot-profile-routes.js`、`src/docker-server.js`、`src/config.js`、`src/app.js`、`ui/profile-context.js`、`ui/connection.*`。

```text
/data/robot-profiles.json             当前选择、已保存及归档列表
/data/shared-models.json              共用模型服务与密钥
/data/robots/APP_ID/config.json       当前机器人的私有配置
/data/robots/APP_ID/extensions/       当前机器人后装的技能/插件
/data/robots/APP_ID/...               各自的聊天、记忆、媒体等
/data/robots/setup/                  未选择机器人时的禁用空间
```

- 旧数据迁移保留原文件与备份，验证身份/路径，最后提交索引；拒绝链接、损坏配置及未知已有目标，不覆盖用户数据。
- 切换通过退出进程后由 Compose 重启完成，禁止运行中仅改全局目录；切回恢复该机器人的数据。
- HTML/fetch/SSE 携带进程上下文；旧标签页写入返回 409。环境变量管理的身份禁止页面另行切换；多机器人模式拦截旧版整体重置。
- JSON 原子写入，凭据文件权限 0600；不把共享模型 API 再写回各机器人配置。

**测试**：`docker-profiles`、`docker-profiles-http`、`docker-http`。

### L06 群 @ 识别和提示词

**文件**：`src/qqbot.js`、`src/app.js`、`src/prompt.js`、`src/orchestrator.js`、`src/store.js`、`ui/connection.js`。

- 同时识别专用群 @ 事件、结构化自提及和正文精确自提及；仅 @ 无正文也能触发。@ 别人/全体不当作自提及。
- `officialAtMe → atMe → triggerLabels` 传递到当前轮提示词，不依赖已经剥除的 @ 文本；历史 @ 不当作本轮直接召唤。
- 发现会话显示收到时间、事件类型、@ 识别和过滤阶段；`forwarded` 仅表示放行，不冒充模型已回复。

**测试**：`docker-mention-prompt`、`docker-channel`、`docker-sdk`、`docker-agent`。

### L07 只读容器中的技能安装

**文件**：`src/module-paths.js`、`src/module-import.js`、`src/plugin-loader.js`、`src/market.js`、`src/zip-install.js`、`src/routes.js`、`doc/extend_development/`。

- 修复口令/ZIP 安装向 `/app/skills` 写入导致的 ENOENT；新增扩展落在当前机器人的 `extensions/skills`、`extensions/plugins`。
- 保留内置只读目录与外置扩展加载语义；建立受检的 ESM `package.json`、`src` 和 `node_modules` 兼容链接，不复制一份过时核心代码。
- ZIP 校验路径、展开体积、入口/目录名，失败清理暂存，不直接覆盖已有安装；卸载不删只读内置包。
- Docker 的自动热重载实际为关闭；更新文件后使用技能重载入口，不照搬桌面文档“落盘自动生效”的承诺。

**测试**：`docker-skills`；覆盖口令/ZIP、加载、重载、重启、切换隔离、导出和卸载。

### L08 ComfyUI Qwen Turbo 技能

**源码**：`examples/skills/comfy-draw/`，版本 2.0.0；测试/冒烟脚本 `test/comfy-draw.test.mjs`、`scripts/qwen21-turbo-benchmark.mjs`、`scripts/comfy-draw-smoke.mjs`。

- 文生图、单图编辑、按任务编号查询/补发；不自动启动宿主 ComfyUI 或改用云端。
- 固定 Turbo 三件套、Euler、CFG=1、8 步完整 sigma；编辑输入使用 `images.image_1`。保持原图比例并按像素预算对齐尺寸。
- 只接受当前会话图/当前会话生成任务，QQ 参考图走核心安全下载；结果和任务放在当前机器人数据目录。
- 请求失败/超时保留任务编号，重试去重；发送未确认不盲目重复生成/发送；关闭技能不全局打断他人的 ComfyUI 任务。
- 分发示例地址已改为 `http://host.docker.internal:9000`，实际地址由技能设置覆盖。此次文档/Git 整理**没有修改运行卷中的既有技能地址**。
- 实测单次：768 文生图 31.2 秒，热缓存 20.1 秒，1024 文生图 41.3 秒，768 编辑 36.4 秒。不是长期平均或全冷启动承诺，完整条件和模型哈希见该技能 README。

**注意**：`examples/skills` 不自动复制进镜像或每个机器人；升级安装副本是单独操作，保留其管理员设置、任务数据和密钥。

### L09 Steam 史低查询修复

**源码**：`examples/skills/steam-deals/`，版本 1.5.0；测试 `test/steam-deals.test.mjs`。

- 原 Windows `curl.exe` 失败后被误报“零好价”；改为原生请求，区分上游故障、部分失败、真实零结果与去重未发送。
- Steam 当前价格 + ITAD Steam 商店 61 的 `storeLow`，不把全商店最低价误标为 Steam 史低；无可核验数据时标普通折扣/待核实。
- 保留用户评测门槛、货币及设置；ITAD 密钥脱敏并通过请求头发送，不写进 URL。
- 官方 QQ 使用文字清单加至多一张封面，走发送队列并留档；缓存进媒体目录，Docker/macOS 跳过 Windows Pixiv 结尾图。
- 辅助模块使用版本化文件名，防止只重载入口时复用旧模块缓存。

### L10 引用图片进入模型和可见答复

**文件**：`src/qqbot-quotes.js`、`src/message-quotes.js`、`src/reply-completion.js`、`src/qqbot.js`、`src/app.js`、`src/store.js`、`src/prompt.js`、`src/tools.js`、`src/orchestrator.js`。

- 解析 QQ 引用 `msgElements` 中的文字/附件；引用媒体与当前消息媒体分开持久化，缓存按会话隔离，优先新推送地址。
- `get_message_detail` 返回引用信息/图片数；`get_message_images` 合并当前图与引用图、去重，并仅追溯同会话一跳。
- `refMsgIdx` 是引用索引，**不当作能发送的 QQ 消息 ID**；取不到引用明确标 unavailable，请用户重发，不猜新闻内容。
- 本轮直接群 @ 或私聊、尚未发送时，覆盖两种遗漏：零工具调用就结束（包括空正文/只有思考），或查过本条消息后忘记发送。最多补一次发送工具提醒，不直接发布草稿或思考，不超出管理员设置的模型轮次上限。
- 普通群闲聊、主动运行、已发送、发送工具关闭及明确 `finish` 均不追加提醒；非本条消息的查询和其他工具调用不因零工具补救分支变成自动重试。内部思考和普通模型正文绝不能直接当 QQ 回复发送。

**测试**：`docker-quotes`、`docker-quote-agent`、`docker-reply-completion`、`docker-reply-completion-agent`，含真实 Agent/工具管道、缺图/零工具结束提醒、忽略提醒时不无限重试、不重复发送、不发送思考及轮次上限。

### L11 并发回复不串群友

**文件**：`src/qqbot.js`、`src/sender.js`、`src/orchestrator.js`、`src/tools.js`、`src/prompt.js`。

- `AsyncLocalStorage` 为每轮 Agent 冻结触发消息；发送任务**入队时**固定 `replyRoute`，不在队列真正发送时取该群最新消息。
- 文字分泡、图片、表情及媒体共享当前轮锚点；历史显式引用与本轮提问者的被动回复目标分开。
- 同批多个提问者必须用 `replyToMessageId` 分别指定；矛盾的 @、跨会话引用、过期锚点拒绝发送，不抢用后来群友的消息额度。
- 去重含回复锚点，相同答案给不同提问者不误去重；保存 `replySourceMessageId` 和 `replySourceUserId` 便于诊断。
- 提示词中的 `#` 只是消息 ID 的展示标记，工具说明要求传完整 ID、不要省略。官方发送兼容误带的单个 `#`：仅在去除后精确命中当前会话缓存时规范化，且在入队、去重、引用发送前使用一致的 ID；真实以 `#` 开头的缓存 ID 优先原样处理。不做前缀/省略号/大小写模糊匹配，不因此借用后来群友的回复锚点。
- 本地锚点保留 4 分钟是应用保守策略，不是对腾讯平台时限/配额的保证。

**测试**：`docker-reply-routing`、`docker-reply-routing-agent`、`docker-mention-prompt`、`docker-sdk`；特别保留“推理时 B 到达，A 的回复仍指向 A”，覆盖误带 `#`、规范化后的去重、矛盾 @、未知/缩短/跨会话/过期 ID 拒绝发送。

### L12 删除机器人和站点图标

**文件**：`src/robot-profiles.js`、`src/robot-profile-routes.js`、`src/app.js`、`ui/connection.*`、`ui/favicon.ico`、`ui/favicon.png`、各 HTML 入口。

- 删除需输入 AppID 确认；仅从可用列表移出，原目录和凭据留在数据卷，登记 `archivedAccounts`。重新添加同一 AppID 才恢复，不能自动认领未知目录。
- 删除当前/最后一个机器人时停止连接并重启进入 `setup`，不擅自启用另一个；删除非当前项不干扰当前连接。
- 不是腾讯平台注销，也不是磁盘清空；密钥仍在保留目录，应继续保护整个卷。
- 网站图标复用应用已有蓝色 Q 图标，ICO 包含多尺寸，PNG 256；登录、连接、完整控制台及市场等入口均引用。

**测试**：`docker-profiles`、`docker-profiles-http`、`docker-http`。

### L13 多模型配置和测试

**文件**：`src/connection-models.js`、`src/providers.js`、`src/routes.js`、`ui/connection-models.js`、`ui/connection.*`。

- 连接页复用完整控制台的 `providers` 与 `dshProviderKeys`；拉取 `/models`、下拉/手填模型、最小聊天连接测试和耗时显示。
- 保存不启用、保存并启用、选择已保存模型再启用；主模型切换无需重启 QQ，保留视觉/视频等高级选项。
- 旧手动模型在第一次切换时保留进目录，支持切回；保存其他连接设置不再把 `api.provider` 清空。
- 只有精确匹配的规范化服务地址可复用已存密钥；新地址不带走当前密钥，无 Key 服务清除旧全局回退。多账号同地址需明确选择。
- 密钥不回显，探测错误脱敏，禁止探测自动跟随重定向；HTTP 200 但非聊天协议的响应不能报告成功。

**测试**：`docker-connection-models`；接口 `/api/connection/models` 及 `/fetch`、`/test`、`/save`、`/select` 受原鉴权/同源/机器人上下文保护。

### L14 维护清单和提交检查

**文件**：`AGENTS.md`、本文、`docs/UPSTREAM-MAINTENANCE.md`、`docs/local-overrides.json`、`scripts/check-local-overrides.mjs`、`.gitignore`、`package.json`。

- 固定真实上游基线和本地交付标签，保护清单列出每项关键文件、测试和必须保留的行为。
- 索引检查阻止误跟踪运行数据、明显凭据和缺失关键文件；不输出命中的秘密。该检查不替代代码审查或完整安全扫描。
- `test:local` 汇总核心与两个定制技能的离线测试；新增 `docker-maintenance` 覆盖维护检查自身。
- 文档与示例不再包含本机 AppID/局域网地址；`assets/avatars` 和根目录生成头像原稿均不入库，应用图标仍保留。

### L15 看板不可用状态说明

**文件**：`ui/app/00-core.js`、`ui/app/13-panels.js`、`docs/panels-interface.md`。

- 看板列表的 `usable: false` 是未启用/缺依赖等状态，不是页面损坏；直接展示后端 `reason` 和技能/插件入口，不发起必然失败的详情请求。
- HTTP 错误保留 `error` 优先、`reason` 次之、HTTP 状态最后兜底；兼容既有 `404 { reason }` 面板与动作协议。
- 入口只导航，不自动启用插件或改写配置；显示名称和原因均转义，切换面板后旧请求不得覆盖新选择。

**测试**：`docker-panels-ui`，覆盖全部关闭、缺依赖说明、错误兼容、转义与迟到响应。

### L16 干净公开快照与 GHCR 发布

**文件**：`compose.release.yaml`、`.github/workflows/publish-image.yml`、`scripts/release-smoke.sh`、`THIRD_PARTY_NOTICES.md`、`docs/PUBLISHING.md`、`scripts/check-local-overrides.mjs`、`.dockerignore`。

- 本地集成历史与公开发布历史隔离：不把含旧归档的上游 Git 历史推送到公开仓库。保留原作者、基线信息和维护锚点；公开快照使用单独的 `audit:public`。
- 预构建 Compose 与源码 Compose 共享相同的只读根、非 root、命名卷和鉴权边界；预构建默认固定 GHCR 版本，不改当前运行部署。
- 原生 AMD64 / ARM64 runner 先跑回归和实际镜像离线启动检查，再上传架构镜像并合成 manifest；凭据仅使用仓库短期 GITHUB_TOKEN，不发送本机密钥。
- 镜像保留扫码依赖的原 `UNLICENSED` 声明，并附第三方许可说明；排除个人头像原稿和运行数据。

**测试**：`docker-release`，检查发布 Compose、双架构门禁、固定 Actions SHA、隐私排除及许可文件。

## 高冲突文件和覆盖风险

| 文件或目录 | 合并后重点核对 |
| --- | --- |
| `src/app.js` | 通道选择、导入顺序、路由挂载、引用入库、上下文鉴权、桌面副作用禁用 |
| `src/config.js` | 环境覆盖不落盘、模型共享字段、私有字段剥离、原子写入、密钥保留 |
| `src/routes.js` | 新模型 API、字符串 ID、扩展安装根、旧身份写入防护 |
| `src/qqbot.js`、`src/sender.js` | @ 识别、引用分离、发送前锚点快照、跨会话/过期边界 |
| `src/orchestrator.js`、`src/prompt.js`、`src/tools.js` | 直接召唤语义、仅一次可见回复提醒、工具出图、不可发送内部思考 |
| `src/plugin-loader.js`、`src/module-*`、`src/zip-install.js` | 外置目录、只读内置、ESM 链接、ZIP 验证与重载 |
| `ui/connection.*`、`ui/connection-models.js`、`ui/app/*` | 扫码、配置切换/删除、旧页面防串号、模型 Key 不回显 |
| `package*.json` | 两个腾讯依赖和锁文件不可脱节，保留本地测试命令 |
| `.github/`、`ci-input/` | 初次导入有意不带上游 CI 和打包缓存；合并新增 CI 需单独审查，不默认启用上传/发布 |
| `examples/skills/` 与运行卷 | Git 只管分发源码；不得把示例配置覆盖当前技能密钥和任务数据 |

## 不在本地定制承诺中的范围

- 没有永久不封号保证、个人 QQ 协议规避、群管理/完整成员列表、语音视频文件全量支持或多实例共卷支持。
- 原上游技能、Linux 安装脚本和桌面文档保留不等于 Docker 已逐项兼容；上游 ptrace/QQ 桌面说明不应用到官方 Docker 通道。
- 已安装的第三方 `whale-memes` 是运行卷中的市场包；本次修复的是安装器，不把该包的私有安装状态当成自研源码提交。
- 模型权重在 ComfyUI 所在机器，头像生成原稿与测试图片在本地；它们不因 Git 提交而自动发布。
- 第三方依赖许可独立于本项目 MIT；connector 1.2.0 元数据为 `UNLICENSED`。公开分发前需核对其再分发条件，不将项目 LICENSE 当作对全部依赖的授权。

## 本轮维护基线验收

2026-10-11 建立本地 Git 时，执行并通过：

- `npm run test:local`：本机 **146/146**；包含原 142 项和新增 4 项维护检查测试。
- Linux 容器离线回归：**146/146**；同容器上游平台测试 **35/35**。
- `npm run audit:local`：14 项保护清单、509 个索引文件；固定上游标签、敏感路径和明显凭据检查通过。
- 额外将当前 `.env`、运行中共享模型配置、各机器人配置的已知秘密与待提交文件匹配，命中 **0**；秘密值未写入报告或终端输出。
- 文档内部链接和 `git diff --cached --check` 通过；完整上游历史已补全，不是浅仓库。
- 建立该维护基线时尚无 `origin`，上游 push 地址已禁用；后续公开发布状态见 [发布维护](PUBLISHING.md)，不要把这条历史验收记录视为当前发布状态。

原始测试输出和不含秘密值的检查摘要保留在本地 `artifacts/local-git/`，该目录被 Git 排除。上述数字是此时的结果，不是以后更新自动通过的承诺。

本轮未重建或重启生产容器，未修改运行机器人、模型、名单或已安装技能。除维护文档、检查脚本和测试入口外，源码整理只包含示例默认地址通用化及空白规范化。下一步仍需用户完成真实业务试用后再决定发布。

## 后续修复验收

### 2026-10-11：回复 ID 误带展示前缀

- 排查到模型把展示用 `#` 连同完整消息 ID 传给 `send_message`，导致精确缓存查找失败；不是该条 ID 被省略，也没有证据表明平台屏蔽。该会话随后第二次工具发送已成功，故“已发言”状态本身不需修正。诊断不把真实聊天内容或消息 ID 写进仓库。
- 按 L11 加入严格同会话规范化，调整工具/提示词说明；增加 4 项路由测试，并扩展真实 Agent 管道的多人并发场景。保留原跨会话、@ 对象一致性、过期拒绝与不可发送内部思考的边界。
- 本机 `npm run test:local` **150/150**，Linux 容器 **150/150**，Linux 平台测试 **35/35**。`npm run audit:local` 和索引空白检查通过。
- 已保存旧镜像标签、完整数据卷及 `.env` 备份；2026-10-11 19:42（Asia/Shanghai）部署后健康检查与 QQ 连接正常，运行源码与候选一致。当前机器人未切换，所有机器人配置、共享模型、已安装扩展文件及 `.env` 指纹不变。
- 修正文档备份命令的 `${CID}:ro` 写法，避免 zsh 将未加花括号的变量后缀当作修饰符。
- 未自动向真实 QQ 发送或重放消息；用户实际群聊复测仍需另行验收。修改只保存在本地 Git，不发布 GitHub。测试和部署报告在被忽略的 `artifacts/reply-id-prefix/`，备份在受限权限的 `artifacts/backups/`。

### 2026-10-11：直接召唤空结束与看板不可用提示

- 本地提交 `5d00ec5` 扩展 L10：模型在直接群 @ / 私聊中以零工具调用结束且尚未发送时，最多提醒一次使用发送协议；显式 `finish`、已发送、非直接触发和轮次上限仍保持原边界。不把模型内部文本直接转发给 QQ。
- L15 修复所有看板的未启用提示，而非仅 `affinity`。当前六个提供者均关闭；前端跳过不可用详情请求并展示原始原因及扩展入口，保留后端 `404 { reason }` 契约，不自动改变插件/技能开关。
- 本机 `npm run test:local` **160/160**；Linux 容器离线回归 **160/160**，平台测试 **35/35**；`npm run audit:local` **15 项保护清单、512 个索引文件**及索引空白检查通过。新增 UI 回归包含六个看板、跳转、文本转义及迟到响应。
- 独立临时配置、假 QQ 与暂停的编排器下，浏览器逐项验证六个看板展示正确状态；截图为隔离测试实例，不是生产机器人暂停。未发送真实 QQ 消息，也未启用未配置的依赖服务。
- Docker Hub 的外部 Dockerfile frontend 下载发生 TLS 超时，候选构建临时使用忽略目录中的 Dockerfile 副本，仅去掉首行 frontend 指令，使用 Docker 内置 frontend 和已有依赖缓存；生产 Dockerfile、锁文件及依赖版本未改动。
- 两项修复已于 **2026-10-11 20:26（Asia/Shanghai）**一起部署。部署前保存完整数据卷、`.env` 和旧镜像回退标签；新容器 healthy、QQ 已连接，容器源码和 UI 与工作区一致，所有机器人配置、共享模型、已安装扩展及 `.env` 指纹未变。
- 运行报告与测试截图留在被 Git 忽略的 `artifacts/panels-unavailable/`，受限备份留在 `artifacts/backups/`。仅保存本地 Git，未发布；模型提醒的真实群聊效果仍待用户业务复测。
