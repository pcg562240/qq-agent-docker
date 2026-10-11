# QQ Agent Docker · 官方 QQ 机器人接入版

基于 [prolet1966/QQ-Agent-for-Linux](https://github.com/prolet1966/QQ-Agent-for-Linux) 的无界面 Node.js 服务改造，保留 Agent、聊天记录、记忆与 Web 控制台，新增 **QQ 龙虾扫码授权 / 手动凭据接入**。使用腾讯官方机器人 API，不托管个人 QQ 客户端；扫码自动取得凭据，不要求用户手填 AppID / AppSecret。

**当前是可运行的首版 MVP，不是全功能桌面版等价移植。** 镜像不安装 QQ、Electron、NapCat 或 SnowLuma，不依赖 OpenClaw / QwenPaw，也不需要图形桌面、注入权限、特权容器或修改宿主机 sysctl。

## 本地定制与上游更新

更新代码前先读 [本地改动清单](docs/LOCAL-CUSTOMIZATIONS.md) 和 [上游更新维护流程](docs/UPSTREAM-MAINTENANCE.md)。本分支包含多机器人与模型切换、引用图片和并发回复修复、只读 Docker 扩展安装及技能适配，不能用上游压缩包直接覆盖。源码基线记录在维护清单中；维护者的本地集成仓库另用标签 `upstream-linux-base-20261007` 固定，公开仓库不包含该旧历史。运行数据和秘密不在 Git 中。

维护入口：从本公开仓库 clone 后使用 `npm run audit:public` 检查关键文件及 Git 索引；维护者的完整本地集成仓库使用 `npm run audit:local`，额外核对基线标签。`npm run test:local` 运行完整本地回归。已有的 `test:docker` 只包含核心 Docker 测试，不包含两个定制技能测试。

## 预构建 Docker 镜像（推荐）

- GitHub：[pcg562240/qq-agent-docker](https://github.com/pcg562240/qq-agent-docker)
- 镜像：`ghcr.io/pcg562240/qq-agent-docker:0.4.7-docker.1`，提供 `linux/amd64` 与 `linux/arm64`。
- [下载 Release 部署附件](https://github.com/pcg562240/qq-agent-docker/releases/latest)：`compose.yaml`、`env.example`、校验文件。
- 仓库内的 [compose.release.yaml](compose.release.yaml) 对应上述预构建部署；根目录 `compose.yaml` 仍用于本地源码构建。

无需安装本机 Node.js。在**新建空目录**保存部署文件，将 Release 附件 `env.example`（源码中为 `.env.example`）复制为 `.env`，填写随机控制台密码（可用 `openssl rand -hex 32` 生成），然后：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

打开 [本机控制台](http://127.0.0.1:3210)，扫码连接 QQ，再配置模型和允许的群/私聊。LAN 配置见下文。默认固定版本；更新/回退、发布历史说明见 [发布维护](docs/PUBLISHING.md)。公开仓库不携带旧上游构建归档，完整上游集成历史仍在维护者本地保留。

**依赖许可提示：** 镜像包含许可元数据为 `UNLICENSED` 的腾讯扫码 connector；应用 MIT 许可不覆盖此包，详见 [第三方依赖说明](THIRD_PARTY_NOTICES.md)。

## 1. 从源码构建

前提：Docker Desktop / OrbStack 或 Linux Docker，支持 Compose v2；初始化脚本需要本机 Node.js 20+。构建和运行服务使用镜像内 Node.js 22。

在本项目目录执行：

```bash
npm run docker:init
# 已存在 .env 时，脚本保留现有文件，不覆盖密码。
docker compose up -d --build
docker compose ps
```

打开 [本机控制台](http://127.0.0.1:3210)。控制台密码是本项目 `.env` 中的 `QQ_AGENT_CONSOLE_TOKEN`，初始化脚本会生成随机密码；不要公开该文件或把密钥贴进聊天。

没有本机 Node.js 时，可复制 `.env.example` 为 `.env`，自行填写随机的控制台密码：24–256 位字母、数字、下划线或连字符；之后仅用 Docker 构建运行即可。

### 首次配置

1. 登录后进入「连接设置」，点击 **生成 QQ 授权二维码**，用手机 QQ 扫码，在腾讯页面选择 / 授权你的机器人。回到控制台点击 **确认保存并连接**；无需手填 AppID / AppSecret。也可在上方「新增机器人」填写凭据后点击 **保存并切换**。
2. 填写支持 **OpenAI 兼容 Chat Completions + 工具调用** 的模型地址、模型 ID 与 API Key。Base URL 通常以 `/v1` 结尾，不要重复填 `/chat/completions`。留空密钥输入框表示保留已有值。
3. 保存，等待数秒后「刷新连接状态」。应显示已连接；未连接时先检查凭据、网络和平台配置。
4. 先向机器人私聊发一条消息；或在平台允许加入的群中 **@ 机器人**。在「最近发现的会话」找到对应 OpenID，加入白名单并保存。
5. **再发送一条新消息**，测试实际模型回复。默认白名单为空时不处理任何会话；首次用于发现的消息不会自动补发给模型。

群 OpenID / 用户 OpenID 是平台标识，**不是传统 QQ 群号 / QQ 号**，必须保留完整字符串。列表只显示本实例观察到的会话，不代表完整好友或群列表。

### 扫码授权说明

- 与 QwenPaw 使用同一腾讯 Portal 绑定流程：`create_bind_task` → 手机 QQ 授权 → `poll_bind_result`。Node 实现直接使用腾讯 `@tencent-connect/qqbot-connector@1.2.0`，不部署 QwenPaw / OpenClaw，不把二维码交给外部图片服务。
- 二维码及授权中的会话最长保留 5 分钟，过期后重新生成。只有点击「确认保存并连接」才写入本地配置；关闭页面 / 取消 / 过期会清理本地待确认凭据。取消本地任务不等同于撤销手机端已经完成的腾讯授权。
- AppSecret / AES 密钥不返回浏览器、不打印日志；待确认凭据仅在服务端内存中，确认后存入原数据卷。`/api/qq/login/*` 仍要求控制台密码与同源访问。
- 确认时勾选「允许扫码账号与机器人私聊」，会把腾讯返回的扫码用户 OpenID 追加到私聊名单，不清空已有私聊 / 群聊名单；未返回用户标识时仍需按消息发现流程添加。
- 授权其他 AppID 时，会新增 / 更新其独立配置并切换；旧机器人的白名单、聊天、记忆及 SDK 会话不复制过去，也不删除。授权当前 AppID 则仅更新当前凭据与选中的私聊授权。
- `.env` 中非空的 `QQBOT_APP_ID` / `QQBOT_APP_SECRET` 会覆盖 UI。扫码入口在此情况下给出提示，不会静默覆盖环境密钥。
- 每个实例同时保留一个扫码任务；重新生成会替换旧任务。扫码成功仅表示取得凭据，**不等同于 Gateway 已连接或消息已经收发成功**，以连接状态和实际消息测试为准。

### 多机器人配置与切换

- 在「连接设置」顶部选择已保存的机器人，点击 **切换到所选机器人**。手动新增支持显示名称、AppID、AppSecret，可只保存，也可保存后立即切换；更新非当前机器人的凭据时填写相同 AppID，密钥留空表示保留。当前机器人的密钥在下方「当前机器人凭据」更新。
- **多个配置、一个在线**，不是多个机器人同时在线。切换先关闭旧 QQ 连接并停止任务，再通过 Compose 的 `restart: unless-stopped` 启动新进程，页面等待服务就绪后自动刷新；切回会恢复该机器人原有数据。切换前先保存其他表单修改。保留 Compose 的重启策略。
- 模型地址、模型、API Key、多提供商配置共用；机器人密钥、白名单、人设、聊天、记忆、提醒、媒体和 SDK 会话按 AppID 独立。新机器人默认空白名单，需自行授权，不继承原机器人的 OpenID。
- 旧版数据首次启动会先完整复制到 `/data/legacy-backups/`，原根目录文件也保留不动，然后迁入 `/data/robots/<AppID>/`。共享模型在 `/data/shared-models.json`，选择列表在 `/data/robot-profiles.json`；**不要再修改根目录旧 `config.json`**。后续备份应覆盖整个卷。
- 切换后的旧浏览器标签页会提示刷新，阻止把旧机器人表单写到新机器人。非浏览器 API 客户端先读取 `GET /api/robots` 的 `context`，后续 API 请求带 `X-QQ-Profile-Context`；重启后重新读取。SSE 使用同名头或 `profileContext` 查询参数。
- `.env` 凭据非空时为环境管理模式，多机器人新增 / 切换暂不可用。清空这两个变量后重新创建容器，再通过页面配置；原环境密钥不会自动写入磁盘。一个卷仍只运行一个副本，切换 OneBot 通道或同时运行另一实例应使用另一数据卷。

### 群聊与风控边界

- 代码已接入私聊事件、群 @ 事件及普通群消息事件；默认只处理群 @。
- @ 识别兼容 `GROUP_AT_MESSAGE_CREATE`、普通群事件中 `mentions[].is_you === true`，以及精确指向当前机器人的 `<@ID>` / `<@!ID>`；不会仅凭 @ 别人或 @ 全体触发。只发送 @ 而没有正文也会触发处理。
- **机器人是否能加群、能否收到非 @ 群消息，由该应用的腾讯平台权限决定。** 关闭「群聊只接收 @」不会开通平台权限，完整控制台里的响应档位也仍然生效。
- 主动推送、定时提醒、跨会话发送受平台额度、时效、关系和内容规则限制；不要将本地接口调用成功等同于平台无限制投递。
- 官方通道避免了个人 QQ 客户端注入这条依赖链，**不等于保证永不封禁**。Docker 是部署方式，不是规避风控的工具。
- 用户已反馈私聊和群接入可用；具体权限与风控因应用而异。自动回归使用本地替身，不向真实 QQ 发送测试消息。

## 2. 配置与数据

| 项目 | 默认值 / 说明 |
| --- | --- |
| 控制台 | 默认 `127.0.0.1:3210`；可显式启用局域网访问，见下文 |
| `QQ_AGENT_PORT` | 宿主机端口；容器内固定为 `3210` |
| `QQ_AGENT_BIND_ADDRESS` | 默认 `127.0.0.1`；局域网部署设为 `0.0.0.0` 或宿主机指定的局域网 IPv4 |
| `QQ_AGENT_ALLOWED_HOSTS` | 局域网访问使用的明确 `主机:端口`，多个值用逗号分隔；默认空 |
| `QQ_AGENT_CONSOLE_TOKEN` | 必填，随机控制台密码 |
| `QQ_AGENT_CHANNEL` | `qqbot`；另支持外部 `onebot` |
| `QQBOT_APP_ID` / `QQBOT_APP_SECRET` | 可留空，登录后配置；非空环境变量优先于 UI |
| 数据 | 容器 `/data`，Compose 命名卷 `qq-agent_qq-agent-data` |
| 运行身份 | `node`，UID/GID 1000；只读根文件系统 |
| 健康检查 | `/healthz` 表示 HTTP 服务存活；不表示 QQ / 模型已经连通 |
| 通道状态 | 登录后 `/api/integration`，含连接状态和最近发现的会话 |

配置、QQ SDK 会话、聊天记录、记忆、表情缓存保存在数据卷；`.env` 位于宿主项目目录，不复制进镜像。UI 填写的机器人与模型密钥保存在卷内配置中，**不是加密保险箱**；卷和备份都应按敏感数据保护。拥有 Docker 管理权限的人能读取卷及容器环境变量。

- 修改 `.env` 后执行 `docker compose up -d --force-recreate`；仅 `restart` 不会刷新环境变量。
- 修改代码后执行 `docker compose up -d --build`。
- 一个数据卷只供一个实例及一种通道使用。QQ 官方通道可在一个卷内保存多个独立机器人并逐个切换；若需同时在线，使用新的 Compose 项目名与新卷，例如 `docker compose -p qq-agent-second up -d --build`，并改用另一宿主端口。不要复用旧账号记忆。
- 不要对同一个数据卷同时运行多个副本；首版没有分布式锁、共享消息队列或横向扩容设计。
- Mac 本机模型服务可用 `http://host.docker.internal:端口/v1`。容器的 `localhost` 指容器自己；服务还需监听 Docker 能访问的地址，不要因此直接暴露到公网。
- UI API 保留密码鉴权、明确 Host 白名单和同源校验；局域网访问必须同时配置端口绑定与允许的访问地址。不信任 `X-Forwarded-*` 请求头，未配置反向代理信任策略。

### 局域网访问

在 `.env` 中保留原有密码及其他配置，仅增加或修改下面两项。示例 `192.168.100.25` 必须换成运行 Docker 的 Mac / Linux 主机实际局域网 IP；端口与 `QQ_AGENT_PORT` 一致：

```dotenv
QQ_AGENT_BIND_ADDRESS=0.0.0.0
QQ_AGENT_ALLOWED_HOSTS=192.168.100.25:3210
```

代码已经更新到本版本后，执行：

```bash
docker compose up -d --build --force-recreate
```

同一局域网的设备打开 `http://192.168.100.25:3210`，使用原控制台密码登录。本机 `http://127.0.0.1:3210` 仍然可用。需要其他网卡 IP 或可解析的 `.local` 名称时，将对应 `主机:端口` 追加到 `QQ_AGENT_ALLOWED_HOSTS`，例如 `192.168.100.25:3210,mac-studio.local:3210`；不填协议、路径或通配符。名称解析由局域网负责，设置白名单不会创建 DNS 记录。

- 默认仍是仅本机访问；配置为空不会自动放行所有局域网地址。修改端口映射但未设置允许地址时，登录 / API 会返回 403。
- HTTP 登录及操作没有传输加密，**仅在可信局域网使用，不做路由器公网端口转发**。`0.0.0.0` 会绑定宿主机全部 IPv4 接口；需要限制接口时改为指定局域网 IP，或使用宿主防火墙限制来源。
- 设备应在同一可互通网络，避免访客 Wi-Fi / AP 隔离；宿主防火墙应允许所需的局域网连接。建议路由器保留主机 DHCP 地址，IP 改变后同步修改允许地址并重建容器配置。
- 退回仅本机：设置 `QQ_AGENT_BIND_ADDRESS=127.0.0.1`、清空 `QQ_AGENT_ALLOWED_HOSTS`，再执行 `docker compose up -d --force-recreate`。无需删除数据卷。

### QQ 报「接口访问源IP不在白名单」

这是腾讯对**当前凭据的该次接口调用**返回的错误，不是控制台的 `QQ_AGENT_ALLOWED_HOSTS`，也不是机器人私聊 / 群聊的 OpenID 白名单。不能因此推断所有龙虾机器人都要走传统开发者审批 / IP 白名单流程。龙虾入口应先使用上面的扫码授权核对绑定的机器人；仅在确认该应用启用了 IP 白名单时，参考下面步骤：

1. 在 [QQ 开放平台](https://q.qq.com/qqbot/#/developer/developer-setting) 选择对应 AppID 的机器人，进入开发设置中的 IP 白名单。
2. 对启用了该策略的应用，填入 **Docker 访问 QQ API 时实际使用的公网出口 IP**，不填 `127.0.0.1`、`192.168.*` 或容器网段，也不带端口。见 [腾讯传统开发者文档中的 IP 白名单说明](https://github.com/tencent-connect/bot-docs/blob/main/docs/README.md#85-ip白名单配置)，不要将其无条件套用到所有接入入口。
3. 使用代理 / VPN / 路由分流时，不同查 IP 网站可能返回不同出口；普通查 IP 结果只是线索，需核实 QQ API 的实际路由。此版本 SDK 使用 `api.sgroup.qq.com`，token 请求使用 `bots.qq.com`。不要为了消除错误而放行无关地址或整个网段。
4. 平台保存生效后等待自动重连，或执行 `docker compose restart qq-agent` 再刷新连接状态。宽带重拨或代理出口改变后需重新核对平台白名单。

若又出现「接口调用超过频率限制」，不要连续重启或反复保存触发重连；先完成平台设置并等待限频解除。控制台「刷新连接状态」只读取本地状态，不会主动调用 QQ Gateway。

控制台现在会保留这条具体错误并显示操作提示，避免被 SDK 的通用「重连次数耗尽」覆盖。开放局域网端口不会修复腾讯出站 IP 白名单；连接官方 Gateway 也不需要把控制台暴露到公网。

### 私聊正常，群 @ 没回复

1. 确认「当前 AppID」是已加群的机器人，将「最近发现的会话」中的群 OpenID 加入可用群聊后点击 **保存并应用**，再发送一条新的 @ 消息；白名单设置前的消息不会补发处理。
2. 点击「刷新连接状态」，发现列表会显示最新收到时间、QQ 事件类型、@ 识别结果和通道筛选结果。若时间未更新，说明该新消息尚未到达本地通道；先核对 @ 的机器人与当前运行的机器人是否一致。
3. 「被白名单 / 黑名单拦截」需检查当前机器人的名单；「未识别到 @」请用 QQ 的 @ 选择器选中机器人，不仅手打昵称。
4. 「已通过通道筛选」不代表已经回复，继续在完整控制台查看该群的消息记录和 Agent 会话，检查暂停 / 群成员屏蔽、模型错误、发送错误或模型主动选择不回复。不要为了排查而默认开放所有群或关闭 @ 限制。

### 常用命令

```bash
docker compose logs --tail=100 -f qq-agent
docker compose restart qq-agent
docker compose stop
docker compose up -d
curl -fsS http://127.0.0.1:3210/healthz
```

`docker compose down` 默认保留命名卷；**不要追加 `-v`，那会删除聊天记录、配置和记忆**。备份前停止服务，用 Docker 的卷备份方法导出整个 `/data`，并另行备份 `.env`；恢复时保持 UID/GID 1000 和私有访问权限。

## 3. 外部 OneBot 模式

已有独立的 NapCat / SnowLuma 服务时，可在 `.env` 设置：

```dotenv
QQ_AGENT_CHANNEL=onebot
ONEBOT_WS_URL=ws://host.docker.internal:3001
ONEBOT_HTTP_URL=http://host.docker.internal:3000
ONEBOT_ACCESS_TOKEN=填写网关的访问令牌
ONEBOT_HTTP_TOKEN=填写网关的HTTP令牌
```

需要兼容原项目的 **OneBot v11 正向 WebSocket** 服务；使用其他容器时，改成共享 Docker 网络中可解析的服务名和端口。网关配置、令牌必须与上述地址匹配。首次启用前按实际服务替换示例值。

本镜像只负责 Agent，**不会启动、下载或修复外部 QQ / SnowLuma / NapCat**。此模式保留了原项目适配器，尚未对接真实外部网关回归；客户端登录、图形环境、QQ 版本和账号风险仍由网关侧承担。

## 4. 首版能力与限制

| 功能 | 官方 QQ 通道 |
| --- | --- |
| 私聊文字、群 @ 文字、模型工具回复 | 已实现；本地端到端模拟测试通过 |
| 图片收发 | 已实现；SDK 本地上传/投递模拟测试通过，实际格式与限制由平台决定 |
| 历史存档、OpenID 会话与记忆持久化 | 已适配；重启恢复和含连字符 ID 已测试 |
| 白名单、重复入站事件过滤、限频发送队列 | 已接入；去重不是崩溃场景下的严格 exactly-once |
| 引用回复 | 文字引用仅限本进程缓存且属于同一会话的消息；重启后缓存不保留 |
| 普通群消息（免 @） | 代码接收能力就绪，默认关闭，平台权限未验证 |
| 主动提醒 / 推送 | 调用链保留；投递受平台限制，未验证真实账号 |
| 语音、视频、文件、拍一拍、合并转发、频道 | 首版未实现；相关内置工具会隐藏或明确报错 |
| 群成员完整列表 / 群管理 | 未实现，不能当作传统个人号机器人使用 |
| 原项目全部技能 / 插件 | 源码保留，非全量兼容承诺；依赖 OneBot 专有 API 或桌面工具者需另行适配 |

额外说明：

- 首版保留原发送队列限频配置，但这些本地阈值不是腾讯额度保证，建议按实际使用降低发送频率。
- 关闭自动价格表下载、社区名单同步、启动遥测、文生图启动时免费源探测、自动启动 MongoDB 和桌面程序；手动使用联网技能仍可能访问其配置的服务，启用前检查插件设置。
- 官方通道跳过自动链接视频转发；镜像不带 ffmpeg、MongoDB、语音服务或 QQ 桌面工具。内置纯文件存档/记忆可以运行，额外依赖另行部署。
- 根文件系统保持只读。控制台的口令安装和 ZIP 导入支持技能及插件，保存于当前机器人数据目录的 `extensions/skills`、`extensions/plugins`（QQ 多机器人模式为 `/data/robots/<AppID>/extensions/`）。切换机器人时各自独立，切回、重启或重建容器后仍会加载；不要删除数据卷。
- 镜像内置模块仍从 `/app/skills`、`/app/plugins` 加载，可禁用但不直接删除；自行安装的扩展可重载和卸载。扩展目录保留 ESM 及 `../../src`、运行时 npm 依赖的兼容链接。依赖 OneBot、桌面程序或额外系统组件的第三方包仍需单独适配；仅安装可信来源，扩展 JS 与机器人进程拥有相同的数据访问权限。
- 自更新或直接写入应用源码目录仍不适用。调整源码后重建镜像；不要以 `privileged` 或挂载 Docker socket 解决。
- SDK 为当前固定版本 `@tencent-connect/qqbot-nodejs@1.0.4`；`package-lock.json` 固定 npm 依赖。基础镜像可通过 `NODE_IMAGE` 指定审核后的 digest。

## 5. 验证与开发

```bash
npm ci --omit=dev --ignore-scripts
npm run test:local
```

在 Linux 容器中重跑专用测试和上游平台测试：

```bash
docker run --rm --init --read-only --network none \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m,mode=1777 \
  --tmpfs /data:rw,uid=1000,gid=1000,mode=700 \
  --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD:/workspace:ro" -w /workspace --entrypoint sh qq-agent-docker:local \
  -c 'node --test test/docker-*.test.mjs test/steam-deals.test.mjs test/comfy-draw.test.mjs && node test/platform-test.mjs'
```

这些测试使用临时目录、假的 QQ 凭据、本地 HTTP/WebSocket 与本地模型接口，不发送真实 QQ 消息。交付验证结果和源码变更见 [Docker 实现记录](docs/DOCKER-IMPLEMENTATION.md)。

## 来源与许可

- 直接基线：[QQ-Agent-for-Linux](https://github.com/prolet1966/QQ-Agent-for-Linux)，提交 `da6f0560c1c7530a985bb4c1542a88cae104b80e`，包版本 `0.4.7`。
- QQ 官方 SDK：[tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs)，版本 `1.0.4`。
- 扫码参考：[QwenPaw QQQRCodeAuthHandler](https://github.com/agentscope-ai/QwenPaw/blob/2744a976b39452ed612829ea041babaecade72fb/src/qwenpaw/app/channels/qrcode_auth_handler.py#L704-L819)；实际调用 [腾讯 OpenClaw 插件同款 connector](https://github.com/tencent-connect/openclaw-qqbot/blob/main/src/setup/login.ts)。依赖版本固定于 lockfile，第三方包遵循各自许可；connector 1.2.0 包元数据标记 `UNLICENSED`，项目 MIT 许可不覆盖该包。
- 原作者与 Linux 维护者的署名及 MIT 许可保留，见 `LICENSE` 和 `package.json`。
- 原 Linux 安装说明留在 [UPSTREAM-LINUX-README](docs/UPSTREAM-LINUX-README.md)，其中桌面 QQ、SnowLuma、ptrace 配置 **不适用于本 Docker 官方通道**。
- 本地新增 Docker 接入层不是腾讯或上游项目发布的正式发行版；保留 `0.4.7` 作为基线版本，不表示上游已经发布这些改动。
