# 全部现有扩展验证与适配（2026-10-13）

## 范围与判断口径

73 个内置目录（43 技能、30 插件），以及当前后装的 ComfyUI、Steam 好价、网页求证、梗鲸表情包、Bangumi 五个技能；共 78 个唯一模块。旧 affinity 同名覆盖已分离为默认关闭的 affinity-snapshot，原 live affinity 插件配置保留。嵌套重复包也做语法和相对导入检查，不视为额外运行模块。

“基础通过”只代表清单、语法、导入、真实加载器、能力声明和工具 schema 通过；不是所有第三方业务接口已实测。测试以替身模型/数据库/网络和合成聊天为主，实际 Linux ffmpeg 用合成视频，不使用 GPU。没有真实 QQ 测试发送，没有调用付费模型。

## 已修复

1. 七个技能把 api.capability 的返回值当函数：改为执行时动态检查、调用、await，供应插件迟加载/关闭/异常均有测试。
2. 官方 OpenID：记忆、待办、主人识别、群友印象等保留完整字符串；多人好感度按实际发送人计分，不把后人的话归到首人。
3. threads 真正使用 sessionId；todo 注入对应会话/成员；ask-admin 使用已配置且获准私聊的管理员完成求教/答复闭环，未知发送状态不自动重试。
4. Mongo 检索原来“满分也达不到默认阈值”：归一化实际词面评分；不声称无向量时有语义检索。记忆抽取补实现，只有显式 extractionEnabled 才调用模型；autoApproveEnabled 默认关。
5. 记忆生命周期限制当前会话；遗忘先写审计；知识队列低流量也刷盘，失败保留并幂等重试，审计/缓存按 DATA_DIR 隔离。
6. 扩展安全抓取统一 DNS/IP/重定向/浏览名单、流式体积和时限检查；公开抓取不借私有图床例外访问局域网。图片采集限制 profile 内真实文件，拒绝符号链接越界。
7. 异步关闭只释放旧资源；停用定时推送、角色卡同步、价格表、梗库后台后不迟到写入/发送。定时推送查允许/拒绝名单，并保存尝试记录。
8. Docker 增加 ffmpeg；修正嵌套 reverse-image-pro 导入、分类/能力声明和文档中错误的 capability 例子。

## 配置和依赖边界

不更换机器人身份、模型、名单、技能开关、Key。未配置 Mongo、语音服务、搜索/模型 Key 或第三方失联时仍会显示依赖不可用；这与加载失败不同。没有自动开启记忆抽取/管理员私聊/主动推送。记忆抽取仅缓存本次运行观察到的新触发消息，失败不自动重放旧聊天；重启不追溯历史。词向量服务探活不等于语义检索已实现。

外置源码在 examples/skills 单独维护：verify-first、whale-memes 本轮升级至 1.0.1；bangumi-lookup 是无配置、无数据的原已安装源码副本，仅用于复验，运行源码不更换。ComfyUI 和 Steam 沿用既有维护副本和专项测试。不要用市场同名异版整包覆盖本地优化。

## 逐项矩阵

每行均参加基础检查；“专项”列明确哪些行为有离线断言，没有专项者只做基础核验，不冒充完整业务验证。可重现命令：`npm run test:local`、`npm run test:extensions`，候选 Linux 内另跑 `npm run test:platform`、`npm run test:upstream`、`node test/extensions-video-smoke.mjs`。

| 模块 | 分发 | 本轮源码调整 | 专项覆盖/限制 |
|---|---|---|---|
| `api-deals` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `bili-info` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `affinity-snapshot` | bundled | 是 | 改为唯一只读 ID，默认关闭，保留 live affinity 配置 |
| `ask-admin-skill` | bundled | 是 | 私聊名单/求教入队/管理员答复/跨群隔离/发送未知不重发 |
| `calculator` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `chatgpt2api-image` | bundled | 否 | 现有 docker-chatgpt2api 模拟协议/身份模型设置隔离 |
| `chatgpt2api-search` | bundled | 否 | 现有 docker-chatgpt2api 模拟搜索协议 |
| `check-in` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `conv-memory-skill` | bundled | 是 | 数字及 OpenID 写入/空数据拒绝 |
| `emotion-skill` | bundled | 是 | 能力延迟加载/异步成功与失败 |
| `feeling-skill` | bundled | 是 | 能力延迟加载/冻结请求者 |
| `forward-skill` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `help-board` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `image-gen-skill` | bundled | 否 | 现有生图/搜索联动专项 |
| `image-generate` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `keyword-reply` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `knowledge-memes` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `knowledge-verify` | bundled | 是 | 能力延迟加载/图片路径及网络边界 |
| `meme-lib` | bundled | 是 | 能力延迟加载/不伪造搜索命中 |
| `memory-growth-skill` | bundled | 是 | 能力延迟加载/会话过滤 |
| `memory-recall` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `mood-skill` | bundled | 是 | 能力延迟加载/错误回报 |
| `music-skill` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `random-image` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `reverse-image` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `reverse-image-pro` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `schedule` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `search-aggregator-skill` | bundled | 否 | 现有聚合搜索路由专项 |
| `sticker-annotate` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `sticker-annotate-plus` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `text-tools` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `threads-skill` | bundled | 是 | 能力延迟加载/异步查询 |
| `timed-message` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `todo-skill` | bundled | 是 | 逐人去重/会话注入/写失败 |
| `voice-tts-skill` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `weather-alert` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `weather-query` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `send-forward` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `wiki-search` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `people-memory` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `image-lib` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `self-impressions` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `memory-admin` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `account-pool` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `affinity` | bundled | 是 | 多人逐人计分/OpenID 搜索/设置映射/轮回持久化/实例定时器 |
| `ban-state` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `body-state` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `browse-lock` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `conversation-memory` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `image-compat` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `instance-lock` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `kb-growth` | bundled | 是 | 词面归一化评分/租户过滤/失败保留队列/审计路径/定时器清理 |
| `media-download` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `meme-engine` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `memory-growth` | bundled | 是 | 合成模型抽取/隐私过滤/审核晋升/重复/归档确认/审计先于删除/慢停用竞态 |
| `mood-tune` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `owner-identity` | bundled | 是 | OpenID 精确身份 |
| `proactive-chat` | bundled | 是 | 共享禁言与解禁/运行守卫真实编排/只计发送/分群窗口 |
| `red-packet-radar` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `reply-safety` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `search-aggregator` | bundled | 否 | 现有 docker-search-aggregator 聚合/失败/模型开关测试 |
| `speaker-identity` | bundled | 是 | OpenID 标签剥离/现有 mention 路由回归 |
| `speech-to-text` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `thinking-adapters` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `threads` | bundled | 是 | 真实 sessionId 注入/停用清理 |
| `video-frames` | bundled | 否 | 候选 Linux 镜像真实 ffmpeg 生成并抽取合成视频 |
| `wake-policy` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `proactiveChat` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `echo-guard` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `scheduled-announcer` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `bot-emotion` | bundled | 否 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `role-tool-sync` | bundled | 是 | 保留下一个角色卡章节/停用取消延时 |
| `price-feed` | bundled | 是 | 基础覆盖；外部服务/全部业务组合未穷尽验证 |
| `bangumi-lookup` | installed | 是 | 外置布局/搜索/详情/缓存/输入校验/429错误 |
| `comfy-draw` | installed | 否 | 现有 comfy-draw 工作流/参考图/失败/发送测试，未用 GPU |
| `steam-deals` | installed | 否 | 现有 steam-deals 全套模拟端点测试/外置布局加载 |
| `verify-first` | installed | 是 | 外置布局/引用提取/拒绝私网及凭据/限流式抓取 |
| `whale-memes` | installed | 是 | 外置布局/索引缓存/图片字节校验/发送留档与失败 |

## 最终验收记录

最终计数与部署验收在候选镜像测试、完整备份及上线后填写到 validation.json；上线必须核对配置指纹、只允许指定外置包源码变动。备份、真实日志、密钥、聊天不进入 Git。此次不推送 GitHub/GHCR。

候选验收：本机与 Linux `test:local` 均 371/371；扩展专项 116/116（已包含于前述 371）；Linux 平台 35/35；官方离线覆盖 147/147；流式下载 6/6；选定官方核心测试、发布启动检查、ffmpeg 合成视频 2 帧均通过。全部断网或模拟端点执行，不等于第三方服务实测。

上线验收已完成：78 个模块加载、39 个生效、0 个加载失败；ffmpeg 抽帧已可用。旧镜像、完整卷和环境配置已私下备份并校验，原身份/模型/名单/技能设置及环境文件指纹保持不变；只升级两个指定外置包的四个源码文件。

现装 ComfyUI 与示例包只有本机端点默认值和对应说明的差异；又使用现装源码跑了 20/20 项模拟端点测试，没有覆盖该本机设置。Steam/Bangumi 源码与复验副本一致。

首次上线在健康与配置检查通过后，因为部署脚本最后一步把 `/api/status` 当作扩展列表读取而自动回退；脚本改用 `/api/skills` 后重新完整备份、切换并通过 78/0 加载门槛。回退只恢复旧镜像和指定源码，没有回滚新聊天。此次仅本机部署与本地 Git 记录，未公开发布镜像/源码。
