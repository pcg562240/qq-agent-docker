# 本地绘图 (ComfyUI) · Qwen-Image-2.1-Turbo

这是已安装 `comfy-draw` 的 Docker 适配升级，不是另一个重复技能。原包作者标注为 QQ Agent。当前版本 **2.0.0**。

## 怎么用

- 私聊或群里 @ 机器人：**画一只戴黄色围巾的蓝色 Q 版胖鲸鱼，做头像。**
- **画一张竖版海报，640x960。** 默认方图 768×768，也可用 1024×1024。
- 发图片并说明：**把这张图的围巾改成红色，其他不变。** 支持静态 PNG、JPEG、WebP。
- 对机器人刚生成的图说：**刚才那张换成水彩风，保留构图。** 模型应使用上次返回的任务编号。
- 生成后未收到图：**查一下刚才的绘图任务。** 确认需要再次发送时说 **补发刚才那张图，不要重新画。**

群聊本身仍须在 QQ Agent 允许的会话里；此技能不会更改群权限、机器人凭据或其他技能。

## 为什么是技能

需要模型理解自然语言，决定文生图还是改图、提取描述，因此使用 `registerTool`，不是固定条件触发的插件。注册工具：

1. `comfy-draw__local_draw`：文生图，1～2 张顺序生成，随机种子或显式 seed。
2. `comfy-draw__local_edit`：单张参考图编辑；同会话图片消息或同会话已生成任务。
3. `comfy-draw__local_draw_result`：查结果及用户明确要求的补发，不会重新采样。

QQ 官方机器人消息 ID 保留为字符串；`#123` 表示当前会话的本地消息编号，不与 QQ 消息 ID 混淆。

## 部署配置

- 分发示例默认使用 `http://host.docker.internal:9000`，适合 Docker 访问宿主机。若 ComfyUI 在其他机器，请在技能设置填写其实际地址；宿主机直接运行测试脚本可用 `--base http://127.0.0.1:9000`。已有 ComfyUI 0.37.4 原生节点，无需安装自定义节点。
- Diffusion：`qwen_image_2.1_turbo_bf16.safetensors`（新增）。
- Encoder：`qwen3vl_8b_int8_convrot.safetensors`（复用）。
- VAE：`qwen_image_2.1_vae_bf16.safetensors`（复用）。
- 固定 **Euler / CFG=1 / 8 步**，使用 Qwen Turbo model_index 的完整 sigma 序列，不是将普通模型的步数随意改成 8。
- 配置按每次工具调用读取。旧包自动启动 ComfyUI、Mac 磁盘路径、负面词及旧采样器设置不再参与执行。
- ComfyUI 需保持开启；Docker 不启动宿主机应用，不自动切换云端服务。

安装目录（机器人 APP_ID 的 Docker 数据卷）：

`/data/robots/APP_ID/extensions/skills/comfy-draw/`

此 Docker 版本并非文档模板所说的自动热重载：部署后调用控制台的技能重载 API，已经加载即可使用，**不需重建镜像或重登 QQ**。原技能及设置在更新前有独立备份。

源码保留在仓库的 `examples/skills/comfy-draw`，不纳入镜像内置技能，避免其他机器人意外启用。将这一目录打包导入其他机器人时，需单独启用和配置。

## 网络与数据

图片走 ComfyUI 的 `/upload/image` → `/prompt` → `/history/{id}` → `/view`，不会读取 Mac 的绝对图片路径。取回的图片位于当前机器人 `/media/comfy-draw/`，通过 `ctx.sender` 发到当前聊天，沿用核心限频、留档和媒体路径检查。

QQ 参考图只从当前聊天记录解析，使用核心 `safeFetchBinary` 下载（DNS/IP、重定向及大小检查），不接受模型传入任意 URL 或本地文件。ComfyUI 的内网地址仅来自管理员设置。默认单图 12 MB、一次 1～2 张、约 100 万输出像素；参考图长宽比最多 4:1，改图按照像素预算保持大致比例并对齐 32 像素，尺寸可能小幅变化。GIF/APNG/动画 WebP 不自动展开。

任务记录位于当前机器人的 `/skill-data/comfy-draw/jobs/`。同一会话轮次相同工具重试复用记录；网络提交失败也先保存 ComfyUI UUID，避免重复生成。发送结果未确认时不盲目补发。技能关闭或重载停止等待和后续发送，但**不会全局中断 ComfyUI**。默认保留最近 200 张已发送结果；未发送结果保留供排错。ComfyUI 自身的 `qqagent_comfy` 输入/输出不由此技能擅自删除。

ComfyUI 接口没有新增认证，仅应在可信局域网访问，不应转发到公网。图片生成在本机完成；QQ 参考图下载和结果发送仍通过腾讯服务，机器人理解请求仍使用原有语言模型。

## 2026-10-11 实测

Apple MPS，ComfyUI 0.37.4，BF16 Turbo，INT8 Qwen3-VL 编码器，CPU VAE，空队列，单张。

| 测试 | 分辨率 | 秒 |
|---|---:|---:|
| 首次使用新 Turbo 权重 | 768×768 | 31.2 |
| 相同提示词、新种子，缓存已热 | 768×768 | 20.1 |
| 新中文提示词 | 1024×1024 | 41.3 |
| 修改参考图围巾颜色 | 768×768 | 36.4 |
| Docker 完整技能文生图链路 | 640×960 | 25.3 |
| Docker 完整技能参考图编辑链路 | 640×928 | 37.3 |

首次测试复用了已有编码器和 VAE 缓存，**不是整个 ComfyUI 重启冷启动测试**。这些是单次测量，不是长期均值，排队、切模型、提示词和尺寸都会影响耗时。Docker 链路使用真实 ComfyUI 与真实图片下载，但 QQ sender 为测试替身，没有向真实群友自动发送测试图。单元测试覆盖队列忙、错误、跨聊天隔离、输入限额、提交去重、补发和取消等。

## 模型来源与许可

- [Qwen 官方 Turbo 模型](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo)
- [Comfy-Org 官方格式转换权重](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)
- 模型来源 revision：`df94239739eef7205973a145ffa6f441f7b64e84`。
- 文件大小：14,230,280,616 字节。
- SHA-256：`8b74237a7f505773e2c66726fa696444b4c704585c93a347cff9044937f7914a`（安装时验证）。
- 模型许可按 Qwen 模型仓库的许可文件执行；不随 QQ Agent 代码许可改变。

没有删除或替换原有 ComfyUI 权重、工作流，也没有升级 ComfyUI。
