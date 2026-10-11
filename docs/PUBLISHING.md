# GitHub / GHCR 发布维护

## 发布目标

- 源码：https://github.com/pcg562240/qq-agent-docker
- 镜像：`ghcr.io/pcg562240/qq-agent-docker`
- 首版标签：`v0.4.7-docker.1`；镜像标签去掉前导 `v`。
- `compose.release.yaml`：只拉预构建镜像；默认固定版本，不自动追随 `latest`。
- `compose.yaml`：本地源码构建，继续使用 `qq-agent-docker:local`，不改现有部署。
- 许可边界见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)，尤其腾讯扫码依赖的 `UNLICENSED` 标记。发行镜像按发布者选择保留该包，但不将其声称为 MIT 或已获得再分发授权。

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

发行标签必须指向公开提交，而不是本地集成 main。`push.default=nothing` 保持开启；本地 `origin` 的默认推送 refspec 只设置为 `public:main`。远程 `upstream-linux` 的 push URL 继续禁用。

## 镜像流程与验证

`.github/workflows/publish-image.yml` 只在明确的 `vX.Y.Z-docker.N` 标签触发发布；手动执行也必须选择发行标签。普通 main 提交不发布 `latest`。

- GitHub 的 AMD64 和 ARM64 原生 runner 分别安装锁定生产依赖、执行本地回归及平台测试。
- 分别构建镜像；用 `scripts/release-smoke.sh` 在**新建、无网络、无生产挂载**容器检查 UID 1000、只读启动、HTTP 健康、私有路径排除和许可文件。
- 测试通过才推送架构标签；两个架构都成功后合成版本及 `latest` manifest。
- 使用仓库的短期 `GITHUB_TOKEN`（仅 `contents: read`、`packages: write`），不上传本机登录 token、QQ 凭据或 API Key。Actions 固定 commit SHA；升级前审核。
- GHCR 首次发布默认可能为 private；在包设置中确认 public，最后用没有 Docker 登录配置的客户端验证匿名拉取。
- GitHub Release 附上 `compose.yaml`（来自 `compose.release.yaml`）、`.env.example` 和 `SHA256SUMS`；不附带实际 `.env`。
- 分别验证两个 manifest 架构，不把构建成功或 `/healthz` 当作真实 QQ / 模型收发测试。

## 使用预构建版本

在一个新的空目录中下载 Release 的 `compose.yaml` 与 `.env.example`。复制示例为 `.env`，填写随机的 `QQ_AGENT_CONSOLE_TOKEN`，然后：

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
