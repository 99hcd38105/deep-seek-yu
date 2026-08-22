# Harness 本地识图插件

该插件在 Harness Host 进程内提供 `ctx.localVision`。当当前模型明确不支持图片时，Host 使用本地 SmolVLM 生成描述，把描述与图片引用一起写进原始 `user/message`，DeepSeek 适配器仅发送该描述文本。原图继续由 Harness 附件存储和聊天界面管理，不会发送给 DeepSeek。

这是 Harness 内部插件能力，不依赖网页按钮拦截或豆包接口。模型文件保存在客户端用户数据目录，第一次使用需要联网下载，之后可离线运行。
