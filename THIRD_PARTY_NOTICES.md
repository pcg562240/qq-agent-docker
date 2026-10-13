# 第三方依赖与来源说明

本发行版是 `pcg562240/qq-agent-docker` 的非官方 Docker 改造，不是腾讯、OpenAI 或上游作者的官方产品。

## 应用源码

- 原始 QQ Agent：Kondius，MIT；保留根目录 `LICENSE` 的原始声明。
- 主上游：K0nd1us/QQ-agent 官方 Git 源码，提交 `11577baad321d1774caf0765d791c211072bfa83`。
- 历史 Linux 兼容层与附加扩展来源（不再作为主上游）：prolet1966/QQ-Agent-for-Linux，提交 `da6f0560c1c7530a985bb4c1542a88cae104b80e`。
- 本地 Docker 接入、兼容和维护修改：见 `docs/LOCAL-CUSTOMIZATIONS.md`。
- 公开仓库采用经审查的源码快照，不包含上游旧提交中的构建缓存归档；详见 `docs/PUBLISHING.md`。这不删除源码中原有的作者与许可声明。

## npm 运行时依赖

版本和完整传递依赖以 `package-lock.json` 为准。镜像保留依赖包自身的 `package.json`、随包提供的 LICENSE / NOTICE / README，不将它们改写为应用的许可。

| 依赖 | 固定/锁定版本 | 发布包许可元数据 |
| --- | --- | --- |
| `@tencent-connect/qqbot-nodejs` | 1.0.4 | MIT |
| `@tencent-connect/qqbot-connector` | 1.2.0 | **UNLICENSED** |
| `mongodb` | 6.21.0 | Apache-2.0 |
| `bson` | 6.10.4 | Apache-2.0 |
| `qrcode` | 1.5.4 | MIT |
| `ws`、`undici`、`js-yaml` 等传递/直接依赖 | 见 lockfile | 各自包内声明 |

**特别提示：** 镜像包含腾讯扫码 connector 1.2.0，其 npm 元数据标注 `UNLICENSED`。目前未取得或核实该包独立的再分发授权；本说明和本项目的 MIT LICENSE 都不构成对该包的授权。公开发布、再分发或商业使用时应向发布者核实，联系方式见其 npm README（qq_bot_api@tencent.com）。不要把“可从 npm 下载”理解为“本项目可授予它的 MIT 权利”。

- 包信息：https://www.npmjs.com/package/@tencent-connect/qqbot-connector
- 官方反馈入口：https://github.com/tencent-connect/openclaw-qqbot/issues

基础镜像为 Docker Official Image `node:22-bookworm-slim`，其中 Node.js 和 Debian 组件分别遵循各自许可。镜像中的 npm 依赖不包含 Electron；运行时不包含 QQ 客户端、NapCat、SnowLuma、ComfyUI 模型或用户下载的技能市场包。
