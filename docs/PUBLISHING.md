# GitHub / GHCR 发布维护

## 发布目标

- 源码：https://github.com/pcg562240/qq-agent-docker
- 镜像：`ghcr.io/pcg562240/qq-agent-docker`
- 首版标签：`v0.4.7-docker.1`；镜像标签去掉前导 `v`。
- `compose.release.yaml`：只拉预构建镜像；默认固定版本，不自动追随 `latest`。
- `compose.yaml`：本地源码构建，继续使用 `qq-agent-docker:local`，不改现有部署。
- 许可边界见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)，尤其腾讯扫码依赖的 `UNLICENSED` 标记。发行镜像按发布者选择保留该包，但不将其声称为 MIT 或已获得再分发授权。

## 版本口径（2026-10-13 首次源码对齐记录）

- 应用 `package.json`、锁文件根版本和历史 Linux 打包脚本默认值统一为 **0.4.0**，与主上游官方 Git 源码一致；不回退已完成的 Docker／官方 QQ 适配和扩展修复。
- 扩展各自版本、Git 来源提交和 Docker 发行修订仍独立记录。新镜像发行使用新的 `v0.4.0-docker.N` 标签；不要重命名或移动旧 `v0.4.7-docker.1`。
- 本轮用户请求为 GitHub 源码更新，包含官方上游迁移、已验证的扩展修复和版本对齐；不触发镜像发布或运行容器重启。`compose.release.yaml` 继续固定已经存在的旧镜像，不能把它改成尚未发布的版本。
- `test/docker-version.test.mjs` 检查应用版本、锁文件、上游元数据及打包默认值一致。
- 本轮版本变更后，本机和隔离 Linux 的 `test:local` 各 373/373，Linux 平台 35/35，选定官方核心回归通过；索引审计覆盖 629 文件、22 项保护规则。没有向真实 QQ 发送测试消息。

## 新发行：v0.4.0-docker.1

- 应用版本仍为上游 0.4.0；Docker 修订单列为 `package.json.dockerVersion`，版本 API 和控制台同时显示，旧发行标签不移动。
- 本次用户授权修复、备份更新运行容器并推送 GitHub；使用新发行标签触发双架构 GHCR 流水线，成功后发布 Release 附件。预构建 Compose 和示例镜像版本同步为 `0.4.0-docker.1`。
- 包含前轮已验证的短消息编号、回复历史归属，本轮普通群消息先入库/按档位触发、旧仅 @ 设置迁移及维护者小鲸鱼默认人设、可选隔离 MongoDB 叠加配置，以及网页当前机器人备份／预览／导入／回退。人设只含用户授权模板，已有运行人设不覆盖。
- 旧 `requireMention=true` 在读取时转换为全局/已有分群/峰谷 1 档以避免调用量突增，正常保存后退休该字段；旧 `false` 保持响应档位。活跃模式、主动任务及确定性插件仍独立工作；过去被过滤的正文不补回。
- 源码、镜像、生产状态分别验收，流水线/平台权限未验证前不声称真实 QQ 收发通过。只推干净 `public:main` 和精确发行标签，不推集成历史。

## 为什么公开历史不同

发布前扫描发现，上游旧提交的 `ci-input/app-code.tar.gz` 含疑似凭据。虽然当前树已删除归档，直接推送原 `main` 仍会带上传统 Git 历史中的对象。因此：

1. **本地集成仓库**保留原 `main`、上游完整历史和固定标签，不重写、不删除；继续按 `UPSTREAM-MAINTENANCE.md` 接入上游。
2. **公开仓库 main** 从首个经审计的完整源码快照开始，没有把上游历史伪装为新作者原创。原作者、原 LICENSE、上游 URL / 提交号均保留。
3. 本地 `public` 分支跟踪这一独立的公开发布历史；只允许推 `public:main` 和明确审核的发行标签。**不推本地 main、上游基线标签或 `--all` / `--mirror` / `--tags`**。
4. 后续公开更新沿用公开 main 的父提交，再覆盖为新一轮通过审计的源码快照，保留每次发布的差异。不要把本地集成 main 合并进公开 main。
5. 从公开仓库 clone 的维护者使用 `npm run audit:public`；它核对受保护文件、敏感内容和基线元数据格式，不宣称验证本地集成标签。`audit:local` 仍严格要求原始基线标签。

## 首次创建与后续更新

先在本地集成 main 完成测试并提交。用 `git archive HEAD` 导出**已提交文件**到隔离临时目录；不复制工作目录、不导出数据卷或 Docker 容器文件系统。

首次发布在导出目录建立新 Git 根提交；后续从公开远程 main 开始，用导出快照更新已跟踪文件。扫描整个待发布历史，排除压缩包中的秘密；至少使用 Gitleaks 的 `--redact --max-archive-depth 2`，再以当前 `.env` 和运行配置中的已知秘密做精确比对。秘密与报告只保留在被忽略的本地 `artifacts/`，不要打印秘密值。

公开树审核通过后，将它获取为本地 `public` 分支，并显式发布：

```bash
# public 是经过单独审核的公开历史，不是本地集成 main。
git push origin public:main
git push origin refs/tags/v0.4.7-docker.1
```

发行标签必须指向公开提交，而不是本地集成 main。`push.default=nothing` 保持开启；本地 `origin` 的默认推送 refspec 只设置为 `public:main`。远程 `upstream-official` 和 `upstream-linux` 的 push URL 均禁用。官方祖先迁移不改变干净快照发布策略，不直接推送新本地 main。

## 镜像流程与验证

`.github/workflows/publish-image.yml` 只在明确的 `vX.Y.Z-docker.N` 标签触发发布；手动执行也必须选择发行标签。普通 main 提交不发布 `latest`。

- GitHub 的 AMD64 和 ARM64 原生 runner 分别安装锁定生产依赖、执行本地回归及平台测试。
- 分别构建镜像；用 `scripts/release-smoke.sh` 在**新建、无网络、无生产挂载**容器检查 UID 1000、只读启动、HTTP 健康、私有路径排除和许可文件。
- 测试通过才推送架构标签；两个架构都成功后合成版本及 `latest` manifest。
- 使用仓库的短期 `GITHUB_TOKEN`（仅 `contents: read`、`packages: write`），不上传本机登录 token、QQ 凭据或 API Key。Actions 固定 commit SHA；升级前审核。
- GHCR 首次发布默认可能为 private；在包设置中确认 public，最后用没有 Docker 登录配置的客户端验证匿名拉取。
- GitHub Release 附上 `compose.yaml`（来自 `compose.release.yaml`）、`env.example`（来自源码 `.env.example`）、可选 `compose.mongodb.yaml` 和 `SHA256SUMS`；不附带实际 `.env`。附件使用非隐藏名称，避免 GitHub 自动重命名带前导点的文件；校验清单使用附件最终名称。
- 分别验证两个 manifest 架构，不把构建成功或 `/healthz` 当作真实 QQ / 模型收发测试。

## 使用预构建版本

在一个新的空目录中下载 Release 的 `compose.yaml` 与 `env.example`。复制示例为 `.env`，填写随机的 `QQ_AGENT_CONSOLE_TOKEN`，然后：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

默认只开放本机 `127.0.0.1:3210`。需要局域网访问时按 README 设置 `QQ_AGENT_BIND_ADDRESS` 和精确的 `QQ_AGENT_ALLOWED_HOSTS`，保持密码鉴权，不做公网端口转发。

升级先备份完整数据卷与 `.env`，修改 `.env` 中的 `QQ_AGENT_IMAGE` 到已经审核的版本或 digest，再执行 pull / up；旧镜像和备份分别保留，不执行 `docker compose down -v`。现有本地源码部署无需自动迁移到 GHCR，发布不会重启当前机器人。

## 首版发布验收（2026-10-11）

- 公开源码根提交：`04ea9c3c6ebc3fd30ef644b9bc3d7fc670607072`；`v0.4.7-docker.1` 固定于该提交。后续 main 的文档验收补充不会移动发行标签。
- [双架构发布流水线](https://github.com/pcg562240/qq-agent-docker/actions/runs/38146889365) 成功：AMD64 / ARM64 均通过离线回归、平台测试和实际镜像隔离启动检查，再合成 manifest。
- 版本和 `latest` 镜像已上传；版本 manifest 匿名访问成功，包含 `linux/amd64`、`linux/arm64`。
- 使用空 Docker 登录配置从 GHCR 实际拉取 ARM64 发行镜像成功；再以无网络、无生产挂载、只读文件系统运行 `release-smoke.sh`，启动、UID、私有路径排除和声明保留检查均通过。
- 多架构版本 digest：`sha256:5ef2b25f58856d97f8bad85491f22680965f211217b7bf47a2f2aa87aa86aeec`。需要固定内容时可将 `.env` 的 `QQ_AGENT_IMAGE` 设为 `ghcr.io/pcg562240/qq-agent-docker@sha256:5ef2b25f58856d97f8bad85491f22680965f211217b7bf47a2f2aa87aa86aeec`。
- 本机和 Linux 离线回归为 163/163，Linux 平台测试 35/35；公共源码历史 Gitleaks 扫描未检出秘密，当前索引与已知运行密钥精确匹配为 0。
- 发行镜像检查已验证 connector 1.2.0 内置且保留 `UNLICENSED`。这不改变上文的独立许可边界。
- 本次发布没有重建、重启或替换维护者现有生产容器，没有推送私有配置、数据卷、聊天记录、生成图片或旧上游归档。

### 本轮发布前验证（2026-10-14）

- macOS / 隔离 Linux 离线回归各 413/413，Linux 平台 35/35，选定官方核心回归通过；真实镜像非 root / 只读 / 无网络启动冒烟通过。
- 可选 MongoDB 8.0.32：内部认证网络、应用账户 CRUD、跨库拒绝、重启持久化、两个真实插件看板均已通过一次性容器验证；备份 BSON 类型/索引、恢复和失败回退验证通过。没有向真实 QQ 自动发送测试消息。
- 网页备份登录、页面入口、范围/私密提示已在合成机器人控制台检查；HTTP 导出、下载、预览、确认恢复、旧页拒绝和重启流程由离线真实 HTTP 回归覆盖。不是对生产库执行导入测试。

### 本机部署验收（2026-10-14）

- 已完成旧镜像、完整 Agent 数据卷与私有 `.env` 的备份并验证归档，00:09:45–00:10:01 切换完成，容器 healthy、QQ 已连接、78 个扩展无加载失败。
- 用户授权增加 MongoDB 内网服务/独立卷/专属 readWrite 账号，只更新当前机器人两个插件的连接字段；身份、模型、名单、人设、插件开关及抽取/注入开关均未改。其余受保护文件及外置扩展源文件保持一致，管理员凭据不进入 Agent 环境。
- 两个生产看板均返回 MongoDB 已连接；旧 @ 接收策略在内存迁移到 1 档，普通消息接收入库与触发分离；备份页面与状态接口可用。新版默认小鲸鱼只影响新建/主动选用模板，不覆盖已有会话人设。
- 没有在生产演示导入或自动发送 QQ 测试消息。发布流水线验收另行记录。
