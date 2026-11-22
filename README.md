# DSH Mobile Link

适用于 DeepSeek Harness 的电脑端「手机连接」插件，以及 iPhone、iPad 和 Android 客户端。手机配对后连接自己电脑上正在运行的 DSH，可查看会话、任务、文件和预览；双向操作和终端权限由电脑端分别开启。本项目不是 DeepSeek 官方发行版，不包含 DSH 宿主、模型服务或官方前端的副本。

## 安装与配对

1. 在已安装 DeepSeek Harness 的电脑上，按 [桌面插件说明](desktop/README.md) 打包并安装 `dsh-mobile-link`。
2. 打开电脑的「手机连接」，开启连接，在可信网络上让手机扫码并核对安全码。
3. 查看会话无需开启写入权限。只有需要在手机上发送、审批或操作终端时才打开相应开关。

## 从源码构建

- 桌面插件：Node.js 22+。运行 `npm --prefix desktop ci` 和 `npm --prefix desktop test`。
- iOS：最低 iOS/iPadOS 17。使用 macOS、Xcode 和 XcodeGen，在仓库根目录运行：

  ```sh
  brew install xcodegen
  bash scripts/build-ipa.sh
  ```

  输出 `build/DSH-Mobile-unsigned.ipa` 及其 SHA-256。此包**未签名**，不能直接装到普通 iPhone；如需真机安装，请使用你自己的 Apple 签名与设备配置，或在 Xcode 中为目标设备构建。

- Android：构建配置见 [Android workflow](.github/workflows/android.yml)。

## 隐私与授权

- 开源仓库只有程序源码及演示测试。安装 DSH 之后实际产生的会话、文件、缓存、配对信息与服务商凭证不会上传到此仓库。请勿提交真实日志、截图、链接、主机地址或运行状态目录。
- 手机会读取你授权连接的电脑上的会话和工作区信息；即使是只读权限也可以看到受授权的内容。退出后恢复会话用的画面缓存位于手机。丢失或转交设备时请及时撤销配对。
- 新装默认不启用电脑端连接、双向操作和终端输入。优先使用可信内网或私人组网；如自行经由公网转发，保持端到端加密和公钥校验，不要分享活跃的配对二维码。
- 使用手机客户端并不改变 DSH、模型服务商或你自选网络服务的隐私政策。iOS 语音转写优先在设备上执行；系统不支持设备端识别时可能使用 Apple 的识别服务。

[MIT License](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
