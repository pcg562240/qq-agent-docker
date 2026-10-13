# 知识库／记忆库的可选 MongoDB

两个自增长插件默认连接 `127.0.0.1:27017`。在 Docker 中它指 **QQ Agent 容器自身**，不是 Mac/NAS，也不是另一容器。基础 Compose 不包含数据库；启用插件不等于安装了数据库，因此看板可能显示“数据库连接失败”。已有聊天 JSON 存档不依赖 MongoDB。

## 启用方式

先备份完整 `qq-agent-data` 与私有 `.env`，在 `.env` 中配置独立随机 `QQ_AGENT_MONGO_ROOT_PASSWORD`（不是控制台密码）。使用附带的 `compose.mongodb.yaml` 叠加文件：

```sh
# 本地源码；GHCR 部署把第一个文件改为 compose.release.yaml / 下载的 compose.yaml
# 先仅启动数据库，创建应用账号、配置插件后，再更新 qq-agent。
docker compose -f compose.yaml -f compose.mongodb.yaml up -d --wait mongodb
```

后续始终使用相同的两个 `-f` 参数；也可在本地 `.env` 设置 `COMPOSE_FILE=compose.yaml:compose.mongodb.yaml`（Windows 分隔符按 Compose 平台约定）。不要因漏用叠加文件而删库。MongoDB 容器重建不会删除独立命名卷 `qq-agent-mongodb-data`。

- 数据库仅加入 `internal: true` 的 Docker 网络，不映射宿主 27017；Agent 同时保留原网络以访问 QQ/API。
- 强制身份认证；管理员凭据仅交给数据库初始化和管理，不注入 Agent 环境。
- 以 UID 999、只读根文件系统运行，独立数据卷、1 GiB 内存上限、256 MiB WiredTiger 缓存。
- 默认固定已验证的 MongoDB 8.0.32 多架构 digest（`mongo:8.0@sha256:…`），可用 `QQ_AGENT_MONGO_IMAGE` 固定已验证的多架构 digest。镜像由 Docker Official Images 提供，MongoDB 自身许可独立，不打入 QQ Agent 镜像。
- 初始化管理员变量只对**空卷**生效；更改 `.env` 不会自动修改已有数据库账号密码。已有卷需通过数据库管理命令轮换，先备份，不删卷重建。

## 每个机器人独立授权

使用数据库管理员在 `admin` 库创建一个**每机器人独立**的应用账号，仅赋予两个专属数据库的 `readWrite` 权限。不要用 root 连接插件，也不要让多个机器人共享默认库名。例如（名称是占位符）：

```javascript
// 在 MongoDB 容器内认证后的 mongosh 中执行；密码从安全输入取得，不写入公开脚本。
db.getSiblingDB('admin').createUser({
  user: 'profile_a_growth', pwd: APP_PASSWORD,
  roles: [
    {role: 'readWrite', db: 'qq_agent_kb_profile_a'},
    {role: 'readWrite', db: 'qq_agent_memory_profile_a'}
  ]
});
```

在当前机器人两个插件的设置中填写：

- `mongoUri`：`mongodb://profile_a_growth:URL_ENCODED_PASSWORD@mongodb:27017/?authSource=admin`
- 知识库 `mongoDb`：`qq_agent_kb_profile_a`
- 记忆库 `mongoDb`：`qq_agent_memory_profile_a`

连接串属于秘密，仅保存在该机器人私有 `config.json` 的 `skills[插件ID]` 中；不要贴进 issue、日志或提交。通过页面保存后需重载技能（或停用/启用插件）让连接配置生效；离线改配置必须先停应用，原子写入、保留所有其他字段，再启动。不要切换机器人身份或替换已有外置扩展。

配置好后检查两个看板的 MongoDB 状态均为“已连接”，不是只看 HTTP 200。首次接入是空库；不会自动回填以前没有入库的聊天/死信。没有向量服务仍可降级词面/哈希检索，不代表 MongoDB 又失败。

**接通数据库不自动开启模型抽取。** 保持现有 `extractionEnabled`、`inject`、自动审核、清理和插件开关。记忆插件默认模型抽取关闭，需用户另行开启；已明确启用的能力接通数据库后会恢复，可能消耗模型额度。

## 备份与恢复

启用后有**两个**数据卷需要保留。升级前暂停 Agent 写入，使用 MongoDB 自带 `mongodump --archive --gzip` 做认证备份（凭据经私有配置/安全输入，不放命令历史），并备份 Agent 完整数据卷和 `.env`。也可在 MongoDB **正常停止后**完整归档其卷；不要在线直接 tar WiredTiger 文件。

恢复时保持备份文件私有，先恢复对应版本数据库，再恢复匹配的应用连接配置。管理员/应用账号凭据也必须能恢复。数据库版本升级按 MongoDB 官方升级路径操作，不随应用镜像盲目降级数据库。绝不使用 `docker compose down -v`。

首次安装失败可以恢复原配置、原 Compose 环境与旧应用镜像；保留新数据库卷，不删除已经写入的数据。隔离测试仅用一次性库，禁止向真实 QQ 发送测试消息。

参考：[MongoDB 安装文档](https://www.mongodb.com/docs/v8.0/installation/)；[Docker Official Images 入口实现](https://github.com/docker-library/mongo/blob/master/8.0/docker-entrypoint.sh)。
