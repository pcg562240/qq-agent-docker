# QQ Agent 上游更新维护流程

本地定制使用独立 Git 分支与固定基线维护，不通过整目录覆盖接入上游。先比较差异，在集成分支解决冲突并完成测试，再更新运行容器；源码回退与数据卷回退必须分开处理。

## 本地 Git 布局

| 名称 | 用途 |
| --- | --- |
| `main` | 本地可工作的定制版本，不直接等同上游 main |
| `upstream-linux` | 只取代码的上游 remote，指向 `prolet1966/QQ-Agent-for-Linux` |
| `upstream-linux-base-20261007` | 原始导入提交 `da6f0560c1c7530a985bb4c1542a88cae104b80e` |
| `local-docker-20261011` | 已完成的本地功能和本轮维护文档快照，不表示正式发布 |
| `integrate/upstream-日期` | 每次更新的临时集成分支，验证完成才合回 main |
| `origin` | `pcg562240/qq-agent-docker`，公开 main 为独立的干净发布历史，仅推 `public:main` |
| `public` | 对应公开 main，不合并本地集成 main 的旧历史 |

`upstream-linux` 的 push URL 设置为 `disabled://local-read-only`，本仓库 `push.default=nothing`，避免裸 `git push` 误发。它们只是本地防误操作设置，不会阻止有意指定 URL 的发布，也不随 clone 自动继承。

现有定制提交以上游真实提交为父提交，不是无关历史。较早的会话没有独立提交，因此没有“每次修复一条原始 commit”；按功能定位依靠改动清单、文件 diff 和测试。

## 先查看我们改了什么

以下命令在项目根执行。目录名包含空格时务必引用路径。

```bash
git status --short --branch
git log --oneline --decorate -8
git diff --stat upstream-linux-base-20261007..main
git diff --name-status upstream-linux-base-20261007..main
# 精确查看关键实现，不只看新文件：
git diff upstream-linux-base-20261007..main -- src/app.js src/config.js src/routes.js
git diff upstream-linux-base-20261007..main -- src/qqbot.js src/sender.js src/orchestrator.js
# 当前是否偏离最初本地交付：
git diff local-docker-20261011..HEAD -- src ui examples/skills test
```

原 README 保存在 `docs/UPSTREAM-LINUX-README.md`。原版 `.github` 和 `ci-input/app-code.tar.gz` 初次导入时有意没有复制，因此 Git diff 中显示删除：不是这轮误删了本机文件。不要为了让 diff 变小恢复未知 CI、发布凭据或缓存归档。

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
  git fetch --unshallow --no-tags upstream-linux
fi
git fetch --no-tags upstream-linux refs/heads/main:refs/remotes/upstream-linux/main
BASE=$(git merge-base main upstream-linux/main) || exit 1
git log --oneline "$BASE"..upstream-linux/main
git diff --stat "$BASE"..upstream-linux/main
git diff "$BASE"..upstream-linux/main -- src/app.js src/config.js src/routes.js src/sender.js
```

若找不到共同祖先或上游重写历史，停止普通合并，人工核对基线；不使用 `--allow-unrelated-histories` 掩盖问题。其他 QQ-agent 仓库可以研究或有选择移植，不默认当作本仓库的直接合并上游。

### 3 在集成分支解决冲突

```bash
git switch -c integrate/upstream-YYYYMMDD main
git merge --no-commit --no-ff upstream-linux/main
```

遇到冲突后逐项审阅 [本地保护清单](LOCAL-CUSTOMIZATIONS.md)，同时保留上游修复与本地行为。尤其检查：

- 新文件仍在，但 `app.js`/`routes.js` 的挂载被覆盖，是典型“文件没丢、功能已失效”。
- `config.js` 回到单账号写盘、`api.provider` 被清空或新 URL 继承旧 Key，会造成串号或凭据泄漏。
- 回复路由回到“发送时取群里最新消息”，会重现短时间多人 @ 时回复错人的问题。
- 消息展示用 `#` 的兼容必须仍为“去掉单个前缀后精确命中当前会话”；不得改成省略号/前缀模糊匹配或错误时借用最新消息，入队与去重都须使用规范化 ID。
- 引用图解析丢失、`atMe` 标记丢失、仅思考没有调用发送工具，是不同问题，不相互替代。
- 可见回复提醒须同时覆盖当前消息查询后和零工具调用结束；仅对本轮直接 @/私聊、最多一次且不超出轮次上限。不得改成把思考原文直接发进 QQ，也不能对已经发过消息的轮次追加回复。
- 看板要展示未启用/缺依赖的具体原因，不把已有的 `404 { reason }` 简化成 HTTP 404，也不在点开看板时自动启用插件。
- 安装目录回到 `/app/skills`、恢复默认热重载、移除兼容链接，都要重新验证只读镜像。
- 上游新增 CI、自动遥测、外部进程启动或网络预热需单独审核，不因为没有文本冲突就自动接受。

只暂存已审阅文件。`npm run audit:local` 读取的是 **Git 索引**，未 `git add` 的变更不会被当作待提交内容检查。有意移动文件时同步 `docs/local-overrides.json` 和测试，不自动批量删除保护项。

### 4 运行回归

```bash
npm ci --omit=dev --ignore-scripts
npm run audit:local
npm run test:local
git diff --cached --check
```

- `test:local` = 核心 Docker 测试 + ComfyUI 技能 + Steam 技能 + 维护检查；`npm test` 原本是平台测试，不等同此集合。
- 普通回归使用临时目录、本地模型/QQ 替身，不需要真实 API Key，不调用真实 ComfyUI、不主动发 QQ 消息。
- `audit:local` 检查关键文件/测试是否仍在索引、固定上游标签、禁止文件、明显密钥格式，以及当前 `.env` 中已知秘密是否误入索引。**它不是完整安全扫描，也不能判断功能语义**；仍需看 diff 和运行测试。
- Mac 原生的上游 `platform-test` 含 Windows/Linux 平台假设；在 Linux 容器执行，不通过删断言掩盖。

构建候选镜像并在 Linux 再测（先保留旧镜像标签，不会自动重建运行容器）：

```bash
docker compose build qq-agent
docker run --rm --read-only --network none \
  --tmpfs /tmp:rw,nosuid,size=128m,mode=1777 \
  -v "$PWD:/workspace:ro" -w /workspace --entrypoint sh qq-agent-docker:local \
  -c 'node --test test/docker-*.test.mjs test/steam-deals.test.mjs test/comfy-draw.test.mjs && node test/platform-test.mjs'
```

这里挂载的是待测试源码，允许回归发现问题；还需检查运行镜像中的源文件与候选源码一致。测试目录可能在执行时创建本机临时文件，不应向生产 `/data` 写入测试配置。

### 5 人工验收和上线

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

合并验收后提交集成结果，main 使用快进更新：

```bash
git commit -m "Merge reviewed upstream update and retain local Docker customizations"
git switch main
git merge --ff-only integrate/upstream-YYYYMMDD
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
6. 明确配置自己的 `origin`，只推 `public:main` 及指向公开提交的发行标签；不推本地集成 main、基线或备份标签，不对 `upstream-linux` 强推。
7. 公布测试范围与限制，不把离线替身结果写成全平台实测。
