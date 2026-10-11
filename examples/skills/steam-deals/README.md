# Steam 史低好价 · Docker 修复版 1.5.0

修复原 1.4.0 在 Linux Docker 中调用 `curl.exe` 失败后吞掉错误、误报零结果的问题。

## 行为

- Node 原生 HTTPS 请求，无需安装 curl、Windows 程序或自动启动代理。
- Steam 中国区特惠/热销搜索 → 评测数量筛选 → ITAD Steam 商店（61）的 `storeLow`。
- 当前价格取 Steam；不把其他商城报价或全商店最低价当作 Steam 本店价格。
- 只对可核实的历史记录标新史低/平史低；其余明确标普通折扣/史低待核实。
- 数据源、评测或 ITAD 出错与真实零结果分开；部分数据源失败会在清单中披露。
- 不会自动放宽用户的评测门槛；汇率换算不代表更换商店国家。
- 官方 QQ：一份文字清单 + 至多第一款游戏的一张封面，均经 `ctx.sender` 发送并留档。
- OneBot：保留逐款图文；旧 Pixiv 结尾图仅限 Windows OneBot，Docker/macOS 自动跳过。
- 封面放在当前机器人的 `media/steam-deals` 下，不向只读的 `/app` 或技能目录写缓存。
- ITAD Key 在清单中声明为 secret，仅通过 HTTPS 请求头发送，不进入错误信息。
- 保留原有配置项、工具 id、分类、译名字典与计价货币设置。译名补全最多等 10 秒，失败显示原名。

## 安装及更新

安装目录是当前机器人的 `extensions/skills/steam-deals`，不要直接替换 `/app/skills`。
入口依赖 QQ Agent 的 `extensions/src` 兼容链接；项目的扩展加载器会建立该链接。
Docker 生产环境关闭自动热重载，更新后由控制台的技能重载接口重新加载，无需重建镜像。
新辅助模块使用独立文件名，避免加载器只刷新入口时复用旧辅助模块。

## 验证

项目根执行 `node --test test/steam-deals.test.mjs`。
网络冒烟测试只抓公开价格并用替身发送队列验证消息格式，不自动向真实 QQ 群广播。
