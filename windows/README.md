# DeepSeek Harness Windows 客户端

运行 `npm run build` 生成独立的 Windows 客户端。客户端会连接本机的 Harness，并在需要时自动启动 Harness 与仅限局域网访问的手机网关。

每台电脑首次运行时会要求使用者填写自己的 DeepSeek API Key，随后随机生成本机端口、手机端口和手机连接保护密钥。所有值仅保存在应用数据目录；源码、Android APK 和安装包不包含固定密钥或固定端口。

生成后的主程序位于 `dist/DeepSeek Harness-win32-x64/DeepSeek Harness.exe`。
