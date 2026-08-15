# DeepSeek Harness Windows 客户端

运行 `npm run build` 生成独立的 Windows 客户端。客户端会连接本机的 Harness，并在需要时自动启动 Harness 与仅限局域网访问的手机网关。

每台电脑首次运行时会要求使用者填写自己的 DeepSeek API Key，随后随机生成本机端口、手机端口和手机连接保护密钥。所有值仅保存在应用数据目录；源码、Android APK 和安装包不包含固定密钥或固定端口。

工作区文件夹统一使用 Harness 的应用内目录浏览器，避免打包环境中 Win32 原生目录对话框子进程异常退出，并兼容电脑端和手机端。

客户端升级到本修复版本时会刷新一次随机端口和手机连接地址，确保不会继续复用旧版本遗留的 Harness 后台进程。以后关闭客户端时，它启动的 Harness 进程也会一并停止。

生成后的主程序位于 `dist/DeepSeek Harness-win32-x64/DeepSeek Harness.exe`。
