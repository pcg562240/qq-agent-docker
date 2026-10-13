# 扩展独立维护约定

官方 Git 源码的当前基线未提供这批技能/插件；不能把 Linux 交付包附加的模块称为官方 0.4 核心的一部分。

## 布局与版本

- `skills/`、`plugins/`：镜像内置的下游扩展，保留路径和相对导入兼容性。
- `examples/skills/`：独立可安装的 ComfyUI / Steam 示例包。
- 运行卷 `robots/<APP_ID>/extensions/`：管理员已安装的扩展和各机器人设置，**不属于源码仓库**，重建核心镜像不覆盖它们。
- [catalog.json](catalog.json)：每个 manifest 的路径、ID、版本、分发形态、维护归属。`nested-package-copy` 是旧打包嵌套副本，不等于新安装的扩展。重复 ID 保留为待治理事实，不隐藏。

独立维护指每个模块按自己的 manifest 版本、依赖和回归升级，不把核心版本号当作所有扩展的版本；目前仍是一个仓库，不额外建立多个远程仓库。核心更新不自动拉取、重装、启用或删除扩展。

## 更新步骤

1. 先读 `doc/extend_development/` 的开发规范/API，明确工具型技能或确定性插件。
2. 检查 `api.capability(name, args)` 的即时调用语义；不得在 setup 中把返回值缓存成函数。setup 不应搜索、画图或发送 QQ。
3. 使用完整字符串 OpenID，并沿用当前会话/机器人边界；只有明确 OneBot 数字参数才转换成数值。
4. 更改自己的 manifest 版本、源码、说明与离线测试；存在嵌套发布副本时同步或显式迁移，不能无说明删包。
5. 显式执行 `npm run upstream:inventory` 更新扩展目录清单，审阅 diff 后暂存。这个命令不修改生产数据，也不下载/执行扩展。
6. 安装到测试实例验收后再升级运行副本；保留旧安装包、设置与独立数据。只重建镜像不代表外置扩展已升级。

## 迁移前审计发现、仍待单独修复

以下不是本次官方源码迁移新增问题，迁移没有自动修复或自动关闭相关功能：

- 部分旧模块（emotion/feeling/mood/threads/meme-lib/memory-growth/knowledge-verify/proactive-chat）把 `api.capability()` 结果当函数调用。
- memory-growth 的抽取函数为占位实现；部分检索阈值高于纯关键词得分上限；“自动注入”缺少完整消费链。
- conv-memory 与 todo 的部分路径仅接收数字 QQ 标识，对官方 OpenID 不完整。
- affinity 的技能/插件共用 ID，存在覆盖；threads 有作用域/会话字段问题；ask-admin 缺少实际通知/答复消费链。
- 外置 verify-first 来源未纳入本仓库，部分联网边界需单独核查；不能靠更新内置包宣称修复外置副本。
- video-frames 需要 ffmpeg，当前 Docker 镜像没有该二进制；嵌套旧包的相对路径也需要单独治理。

扩展目录完整和模块可加载不等于所有工具执行正确。现有功能保护回归与专项测试只证明覆盖到的行为，不为全部第三方扩展背书。
