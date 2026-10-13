# QQ Agent 上游更新维护流程

本地定制使用独立 Git 分支与固定基线维护，不通过整目录覆盖接入上游。先比较差异，在集成分支解决冲突并完成测试，再更新运行容器；源码回退与数据卷回退必须分开处理。

## 本地 Git 布局

| 名称 | 用途 |
| --- | --- |
| `main` | 本地可工作的定制版本，不直接等同上游 main |
| `upstream-official` | 唯一主上游 remote，指向 `K0nd1us/QQ-agent` 官方 Git 源码 |
| `upstream-official-base-20261013` | 官方 Git 基线 `11577baad321d1774caf0765d791c211072bfa83` |
| `upstream-linux` | 历史来源只读参考，不再向主线合并 |
| `before-official-migration-20261013` | 迁移前本地源码回退锚点 |
| `upstream-linux-base-20261007` | 原始导入提交 `da6f0560c1c7530a985bb4c1542a88cae104b80e` |
| `local-docker-20261011` | 已完成的本地功能和本轮维护文档快照，不表示正式发布 |
| `codex/upstream-日期` | 每次更新的临时集成分支，验证完成才合回 main |
| `origin` | `pcg562240/qq-agent-docker`，公开 main 为独立的干净发布历史，仅推 `public:main` |
| `public` | 对应公开 main，不合并本地集成 main 的旧历史 |

`upstream-official` 和 `upstream-linux` 的 push URL 设置为 `disabled://local-read-only`，本仓库 `push.default=nothing`，避免裸 `git push` 误发。它们只是本地防误操作设置，不会阻止有意指定 URL 的发布，也不随 clone 自动继承。

新集成主线以官方真实 Git commit 为祖先，不合并无关 Linux 历史；迁移过程见 [迁移记录](OFFICIAL-UPSTREAM-MIGRATION.md)。较早的会话没有独立提交，因此没有“每次修复一条原始 commit”；按功能定位依靠改动清单、文件 diff 和测试。

## 先查看我们改了什么

以下命令在项目根执行。目录名包含空格时务必引用路径。

```bash
git status --short --branch
git log --oneline --decorate -8
git diff --stat upstream-official-base-20261013..main
git diff --name-status upstream-official-base-20261013..main
# 精确查看关键实现，不只看新文件：
git diff upstream-official-base-20261013..main -- src/app.js src/config.js src/routes.js
git diff upstream-official-base-20261013..main -- src/qqbot.js src/sender.js src/orchestrator.js
# 当前是否偏离最初本地交付：
git diff local-docker-20261011..HEAD -- src ui examples/skills test
```

原 Linux README 保存在 `docs/UPSTREAM-LINUX-README.md`。原版 `.github` 和 `ci-input/app-code.tar.gz` 初次导入时有意没有复制，因此 Git diff 中显示删除：不是这轮误删了本机文件。不要为了让 diff 变小恢复未知 CI、发布凭据或缓存归档。

## 一次上游更新的操作顺序

### 1 检查工作区和备份

先提交/妥善保存当前工作，不在有未完成修改的 main 上合并。不要以 `reset --hard`、`clean -fd` 或 `checkout --theirs .` 清空问题。

```bash
git status --short
# 确认无未保存代码后，给当前 main 留回退点：
git tag before-upstream-YYYYMMDD main
```

如果后续会启动新代码、迁移配置或更新运行技能，还要先备份 **完整数据卷** 和 `.env`。Git 标签不含聊天、记忆、密钥或已安装技能。

完整卷备份示例（会暂停当前机器人，应选择空闲时间）：

```bash
umask 077
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p artifacts/backups
chmod 700 artifacts/backups
CID=$(docker compose ps -q qq-agent)
test -n "$CID" || exit 1
docker image tag qq-agent-docker:local "qq-agent-docker:before-$STAMP"
docker compose stop qq-agent
docker run --rm --network none --read-only --user 0 \
  --volumes-from "${CID}:ro" --entrypoint tar qq-agent-docker:local \
  -C /data -cf - . > "artifacts/backups/data-$STAMP.tar"
# 确认 tar 命令成功，再备份本地环境配置。
cp .env "artifacts/backups/env-$STAMP"
chmod 600 "artifacts/backups/data-$STAMP.tar" "artifacts/backups/env-$STAMP"
# 核对备份可读后可先启动旧服务，继续离线集成。
docker compose start qq-agent
```

不要把备份上传 GitHub。备份要保留链接本身，不使用 tar 的解引用选项遍历 `extensions/src` 或 `extensions/node_modules`。不要用 `docker compose down -v`。

### 2 只拉取上游并查看变化

```bash
# 未来若从浅克隆开始，先补全历史；fetch 不会覆盖工作区。
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --unshallow --no-tags upstream-official
fi
git fetch --no-tags upstream-official refs/heads/main:refs/remotes/upstream-official/main
BASE=$(git merge-base main upstream-official/main) || exit 1
git log --oneline "$BASE"..upstream-official/main
git diff --stat "$BASE"..upstream-official/main
git diff "$BASE"..upstream-official/main -- src/app.js src/config.js src/routes.js src/sender.js
```

若找不到共同祖先或上游重写历史，停止普通合并，人工核对基线；不使用 `--allow-unrelated-histories` 掩盖问题。其他 QQ-agent 仓库可以研究或有选择移植，不默认当作本仓库的直接合并上游。

### 3 在集成分支解决冲突

```bash
git switch -c codex/upstream-YYYYMMDD main
git merge --no-commit --no-ff upstream-official/main
```

遇到冲突后逐项审阅 [本地保护清单](LOCAL-CUSTOMIZATIONS.md)，同时保留上游修复与本地行为。尤其检查：

- 新文件仍在，但 `app.js`/`routes.js` 的挂载被覆盖，是典型“文件没丢、功能已失效”。
- 控制台密码保留 8–256 位安全字符校验与默认长随机密码生成；不能恢复最低 24 位导致已有用户自定密码启动失败，也不能跳过空密码校验、Host/同源或 API/SSE 鉴权。改密需备份私有 `.env`、重建服务容器并核验新旧凭据，不记录实际密码。
- `config.js` 回到单账号写盘、`api.provider` 被清空或新 URL 继承旧 Key，会造成串号或凭据泄漏。
- 回复路由回到“发送时取群里最新消息”，会重现短时间多人 @ 时回复错人的问题。
- 保留 `reply-history.js` / `ChatStore.responseTo`：入队时捕获原提问与回复对象，成功发送后写入每个分泡/媒体，下一轮提示词和历史查询均可读。不能只保存到 session.sent 而丢掉持久历史，也不能混淆历史引用与当前收件人、把关联拼进 QQ 正文。旧记录和主动无对象发送不猜人；撤回/删除的源不重新展示原文或可用编号。
- 官方 QQ `off` 模式纯文本路径不自动拼接 `<@OpenID>` 或 `qqbot-at-user`，以避免已复现的原标签显示；这是当前实现选择，不代表所有纯文本 @ 均无协议支持。原生 @ 仅在用户选择 `qqbot.groupReplyMentionMode=markdown` 时使用明确的 msg_type=2 / markdown.content，并按固定成员在首条发送。明确的权限/指令拒绝才退回无标签纯文本；超时、5xx 不另发以免重复。保留锚点、规范化、冲突校验及 OneBot 原生段。禁止再用 SDK 替身 HTTP 200 宣称客户端已显示 @。
- 用户明确选择 `legacy` 时保留旧 SDK 辅助方法和 @ 提示词，不走新 Markdown 分支；但必须保留后续裸 ID 复现修复：不再手工拼 `<@ID>`，模型行首标签先对照冻结成员规范化。`atUserId` 仍用于选择/校验，原 `msg_id` 和显式引用必须保留。19:29 的完整标签回退属于历史排查阶段，用户在复现后已要求修复，不得把该已知缺陷恢复为验收要求。其余机器人保持自己的模式，不整目录回退，也不把干净正文等同客户端原生 @ 已修复。
- 已匹配的旧正常 @ 样本来自不含手拼标签的纯文本被动回复，裸 ID 样本来自旧应用额外拼接；两者不可混淆，更不能为补可见 @ 丢掉原 `msg_id` 路径。用户实测 Markdown 在其手机 QQ 正常、电脑 QQ 报不支持消息类型，当前已按要求关闭群 Markdown 模式。更新/重启不得自行重开；纯文本模式须保留成员路由及显式引用，不以伪 @ 字符串或重复补发来伪装兼容。
- 发送诊断只解析 SDK 已序列化请求的白名单元数据，保持每客户端有界内存和异步隔离；不把原始 SDK 日志（含正文/身份/密钥）写到磁盘或状态接口。保留诊断失败不干扰发送及未知结果不补发边界，不能以 HTTP 200 推断客户端 @ 渲染。
- 保留模型长消息 ID 的稳定短编号（`src/message-reference.js`），提示词/历史/图片/失败提示一致；统一工具入口将已知消息参数精确还原后再走冻结回复/引用/取图检查。不得把短编号写回存档或传给 QQ，也不得忽略绘图 references/mask、旧 `#数字` 本地序号兼容及回复提醒。跨群、撤回/清空/裁剪后的失效编号必须拒绝，不使用模糊或最新图片兜底。
- 消息展示用 `#` 的兼容必须仍为“去掉单个前缀后精确命中当前会话”；不得改成省略号/前缀模糊匹配或错误时借用最新消息，入队与去重都须使用规范化 ID。
- 官方 QQ 普通消息必须先经过名单/屏蔽检查后存档，再交给上游响应档位；不恢复 `requireMention` 入库前过滤。保留旧开关向可见滑条的幂等只读迁移及旧表单字段退休，覆盖全局/分群/峰谷，不能因升级把原仅 @ 变成全响应。历史 `not_mentioned` 不补造正文。
- 维护者的小鲸鱼默认文本与原版独立保留；更新默认不能覆盖已有全局/分群人设，也不能将运行配置或其他私人资料混入模板。
- 引用图解析丢失、`atMe` 标记丢失、仅思考没有调用发送工具，是不同问题，不相互替代。
- 可见回复提醒保留两个独立阶段：零工具/当前消息查询后的初始提醒一次，以及有新完成查询结果后的查询提醒一次（总计最多两次，且仍受轮次上限约束）。仅对本轮直接 @/私聊，查询范围限定联网查询和本条消息查询，调用 ID/名称须匹配；已有提醒后无新查询结果不再催促。任何发送尝试、明确 `finish`、未知工具/技能均阻止提醒，不能借此重试发送。不得把思考原文直接发进 QQ，也不能对已发送/主动运行追加回复。
- 看板要展示未启用/缺依赖的具体原因，不把已有的 `404 { reason }` 简化成 HTTP 404，也不在点开看板时自动启用插件。
- 群备注必须按机器人独立保存，仅用于控制台展示，保留 OpenID 路由/名单和提示词原语义；不能被新入站事件覆盖。接收诊断只能保留有界元数据，不能为了排障把未授权正文和发送者写入日志或把缺失记录当作平台未推送的证据。
- 工具注册和序列化均保留对象根 schema 规范化；无参工具不能退回裸 `{}`，否则 DeepSeek 等严格端点会拒掉整轮聊天。基础连接测试是文本探测，不应宣称验证了技能工具/图片/QQ 收发。
- 安装目录回到 `/app/skills`、恢复默认热重载、移除兼容链接，都要重新验证只读镜像。
- 上游新增 CI、自动遥测、外部进程启动或网络预热需单独审核，不因为没有文本冲突就自动接受。

主上游变化、官方文件新覆盖或扩展版本变化后，显式运行 `npm run upstream:inventory`，审阅生成清单；不可用它掩盖未经审查的核心覆盖。

只暂存已审阅文件。`npm run audit:local` 读取的是 **Git 索引**，未 `git add` 的变更不会被当作待提交内容检查。有意移动文件时同步 `docs/local-overrides.json` 和测试，不自动批量删除保护项。

### 4 运行回归

```bash
npm ci --omit=dev --ignore-scripts
npm run audit:local
npm run test:local
npm run test:upstream # 仅隔离测试环境；不会运行桌面安装器测试
git diff --cached --check
```

- `test:local` = 核心 Docker 测试 + ComfyUI 技能 + Steam 技能 + 维护检查；`npm test` 原本是平台测试，不等同此集合。
- 普通回归使用临时目录、本地模型/QQ 替身，不需要真实 API Key，不调用真实 ComfyUI、不主动发 QQ 消息。
- `audit:local` 检查关键文件/测试是否仍在索引、固定官方上游标签及祖先关系、官方文件覆盖层/扩展目录清单、禁止文件、明显密钥格式，以及当前 `.env` 中已知秘密是否误入索引。**它不是完整安全扫描，也不能判断功能语义**；仍需看 diff 和运行测试。
- Mac 原生的上游 `platform-test` 含 Windows/Linux 平台假设；在 Linux 容器执行，不通过删断言掩盖。

构建候选镜像并在 Linux 再测（先保留旧镜像标签，不会自动重建运行容器）：

```bash
docker build -t qq-agent-docker:candidate .
docker run --rm --read-only --network none \
  --tmpfs /tmp:rw,nosuid,size=256m,mode=1777 \
  -v "$PWD:/workspace:ro" --entrypoint sh qq-agent-docker:candidate -c '
    set -eu
    mkdir /tmp/qa
    tar -C /workspace --exclude=./node_modules --exclude=./.git --exclude=./artifacts -cf - . | tar -C /tmp/qa -xf -
    ln -s /app/node_modules /tmp/qa/node_modules
    cd /tmp/qa
    npm run test:local
    npm run test:platform
    npm run test:upstream
  '
```

这里把只读待测试源码复制到临时目录，并复用镜像中的 Linux 依赖，避免宿主 node_modules 符号链接或原生模块干扰；还需检查运行镜像中的源文件与候选源码一致。所有测试文件落在隔离的 tmpfs，不应挂载生产 `/data`。

### 5 人工验收和上线

部署后核对 QQ `connected`、当前 AppID、选中数据目录和配置/账号文件哈希。SDK 的恢复连接事件 `resumed` 不一定携带 `selfInfo`，此可选展示字段为空本身不是换号或断线证据；不能仅因它与重启前不同而误回退。两边都有自身 ID 时仍需对比，不能删除配置/账号/数据目录的一致性验收。

使用**独立测试数据卷、测试机器人/会话**核对下表，再选择生产空闲时段更新。没有真实 QQ 测试证据的项目应标“待验证”，不要以 HTTP 200 代替消息收发证明。

| 验收点 | 预期 |
| --- | --- |
| LAN 登录与鉴权 | 正确地址可登录，未登录/错误 Host/跨源被拒 |
| A → B → A | 私有名单、聊天、技能隔离；模型共用；旧页面提交 409 |
| 删除非当前/当前/最后一个 | 不误切他人；保留原数据；当前删除进入 setup |
| 群 @ 和纯 @ | 唤醒标记到达模型；@ 别人不误触发 |
| 先 @ A 再 @ B | 回复各自对准来源；排队分泡/出图也不串 |
| 引用图片询问 | 可取引用图；无图时可见提示重发，不发内部思考 |
| 模型获取/测试/保存/切换 | 只保存不切换；切回保留 Key；新服务不泄漏旧 Key |
| 口令/ZIP 安装 | 写入当前机器人的 extensions，重启后仍加载 |
| Steam | 请求失败不是“零款成功”；Steam 本店史低标记正确 |
| ComfyUI | 文生图/编辑/查任务/补发；不重复提交，不影响其他任务 |

初次迁移是新祖先线：保留旧 main 为 `codex/legacy-linux-main-20261013` 后，将经审计的新集成分支提升为 main，不做无关历史合并；`public` 分支不动。后续官方更新有共同祖先，main 使用快进更新：

```bash
git commit -m "Merge reviewed upstream update and retain local Docker customizations"
git switch main
git merge --ff-only codex/upstream-YYYYMMDD
```

然后按既有备份方案部署：`docker compose up -d --no-deps --no-build --wait --wait-timeout 90 qq-agent`。核对 healthy、QQ 连接、当前机器人/模型/技能、配置及 `.env` 哈希未被意外改写。部署成功与用户业务测试通过分别记录；不要移动原始两个基线标签，新增带日期的已验收标签。

失败时先回退镜像与源码。若有数据格式迁移，旧镜像应配合迁移前备份在独立卷验证，不对当前运行卷盲目解压覆盖。

## 技能和外部资产怎样保留

- `examples/skills/comfy-draw`、`examples/skills/steam-deals` 保存我们维护的可安装源码；运行副本在 `/data/robots/APP_ID/extensions/skills/`，不是 Git 工作区。
- 核心 Docker 重建不应重新安装/覆盖运行技能，尤其不能替换其管理员设置、任务记录、ITAD Key 或 ComfyUI 地址。
- 技能源码升级后，先导出旧安装包和配置，在测试机器人安装，按实际技能重载机制验证；镜像重建不能代替技能安装验证。
- `whale-memes` 的市场包、ComfyUI 权重、外部工作流、生成头像原稿需另行备份。当前 Git 不包括这些运行资产。

## 待测试通过后再发布 GitHub

用户已于 2026-10-11 授权公开 GitHub / GHCR 发布。旧上游归档扫描检出疑似凭据，因此公开仓库采用独立源码快照历史，见 [发布维护](PUBLISHING.md)。本地集成 main 和固定基线仍保留；以下发布检查继续适用：

1. 用户确认仓库名称、所属账号、公开或私有，以及实际业务验收完成。
2. 再运行本机和 Linux 回归，审查 Git 索引、全部待推送提交历史和大文件；`.gitignore` 不会从既有历史删除秘密。
3. 保留原作者、维护者、MIT LICENSE 和第三方依赖说明。用户选择完整镜像内置 connector；其 `UNLICENSED` 元数据和未核实再分发授权的状态必须明确保留，不能被项目 MIT 声明覆盖；模型许可另算。
4. 不上传 `.env`、数据卷、聊天/图片、运行日志、敏感备份、真实 API Key、浏览器 Cookie。本文示例用 `APP_ID` 等占位，不填实际身份。
5. 本地保留完整基线用于集成；公开仓库不推旧上游历史。公开快照使用 `audit:public`，不要为通过 `audit:local` 而向公开仓库推入敏感历史。
6. 明确配置自己的 `origin`，只推 `public:main` 及指向公开提交的发行标签；不推本地集成 main、基线或备份标签，不对 `upstream-official` 或 `upstream-linux` 强推。
7. 公布测试范围与限制，不把离线替身结果写成全平台实测。

## ChatGPT2API 扩展接入保护（L19）

合并后确认两个默认关闭技能仍被 Docker `COPY skills` 收入镜像，`modelCatalog` 导出仍被加载器透传，路由与 schema UI 均保留（仅保留工具文件会丢失「获取模型」按钮）。保留地址绑定密钥、手填模型/旧目录、任务去重与同会话媒体边界；不得将目录刷新改成生图探测或自动启用。
本接入使用自托管 fork 的异步图片接口和固定搜索接口，不用官方 API 示例直接覆盖其协议；搜索可选模型仅用于整理结果。详见 `docs/CHATGPT2API.md`，接入后运行 `test/docker-chatgpt2api.test.mjs` 及完整本地/Linux 回归。

## 聚合搜索保护（L20）

更新后不可恢复 `engineFns={bingHtml,...}` 配合 `engines=bing,...` 的名称错配，也不能在 setup 中获取 `api.capability(...)` 的返回值当作函数。消费方应执行时 `await api.capability(name,args)`；GPT 来源名为 `search.chatgpt2api`，不是另一个抢占 `search.aggregate` 的提供者。
保留 GPT 默认不参与、共享原技能凭据、并行/备用模式、独立预算/取消与失败状态；聚合不额外执行整理模型或在加载时联网。保留同引擎去重、HTTP(S) 来源与有界响应、检索增强生图的预算与改写开关。嵌套副本也须同步；不要借机覆盖外置技能或改写管理员配置。回归见 `docs/SEARCH-AGGREGATION.md` 与 `test/docker-search-aggregator.test.mjs`。


## 扩展全量复验（L22）

核心/扩展接口变动还需运行 `npm run test:extensions`；Linux 镜像内运行 `npm run test:platform` 与 `npm run test:upstream`。逐项覆盖范围见 `docs/extensions/validation.json`。旧官方离线测试的两条“拒绝一切非数字 ID”断言已改为 OpenID 保存/删除及空 ID 拒绝，保留数值 QQ 原有用例，并非删除失败测试。

外置包代码不随镜像更新：只在完整备份后按清单更新指定包的 JS/manifest，核对旧哈希，拒绝覆盖未知改动；不得覆盖包内缓存、媒体、设置或其他包。回退时先停服务、恢复这两包的源码，再恢复旧镜像；不直接用旧卷覆盖上线后的新聊天。

## 已启用可选 MongoDB 的部署

遵循 [MongoDB 维护说明](MONGODB.md)：必须同时保留 Agent 与数据库卷、现有每机器人账号及数据库名，升级前暂停写入并备份；应用镜像回退不等于数据库版本回退。不得把内部数据库端口映射到 LAN，不能把管理员凭据交给插件。保留连接串脱敏及现有模型抽取开关。

网页备份作业必须在 app 导入前执行，且目录交换中断回退早于 `prepareRobotProfiles` 身份检查。不要把它移到运行中的 HTTP 回调直接覆盖缓存/文件；保留当前数据库连接、不接受归档内主机地址，不覆盖共享模型。[备份维护边界](PROFILE-BACKUP.md)。
