# DSH Mobile Link 0.6.5

桌面端「手机连接」插件。需要 Node.js 22+ 和已安装的 DeepSeek Harness。首次使用须在 DSH 界面明确开启连接。

兼容 Harness `0.2.2-rc.5` 和 CLI 预发行版 `0.2.3-alpha.2` 的 Web 宿主。运行 `0.2.3-alpha.2` CLI 时需满足上游的 Node.js 要求（`^24.22.3 || >=26.13.1`）。CLI 预发行包不是 Windows 桌面安装包。

## 打包插件

在仓库根目录运行：

```sh
mkdir -p build
npm --prefix desktop ci
npm --prefix desktop test
(cd desktop && npm pack --pack-destination ../build)
```

Windows 也可在根目录用 PowerShell 执行：

```powershell
New-Item -ItemType Directory -Path build -Force | Out-Null
npm --prefix desktop ci
npm --prefix desktop test
Push-Location desktop
try { npm pack --pack-destination ../build } finally { Pop-Location }
```

## 安装并配对

Windows 桌面版先从系统托盘彻底退出，再执行：

```powershell
$dsh = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
$package = (Resolve-Path 'build/dsh-mobile-link-0.6.5.tgz').Path
& $dsh plugin --profile desktop add $package
```

若 DSH 安装在其他位置，调整 `$dsh`。Web 版使用 `dsh plugin --profile web add ./build/dsh-mobile-link-0.6.5.tgz`。

重开 DSH，点左下角「手机连接」，开启连接，再用手机扫码。连接初次开启时先在可信局域网配对。已配对设备默认只读；需要主动发送和审批时再开启「允许手机操作」，需要输入终端指令时才启用单独的终端权限。可随时在此面板撤销配对。

手机端通过四宫格工具箱的「任务」查看会话。列表展示最后更新时间，支持搜索、打开、左滑归档或恢复，以及批量操作。归档会同步到电脑，不会删除聊天记录；只读连接不能修改归档状态。

## 网络选项

跨网优先使用自己的私人组网。如需公网入口，使用由你控制的 TCP 透传中继，保持加密流端到端传输，并在 `cordis.patch.yml` 的插件配置中设置 `extraHosts`。示例地址 `203.0.113.12:443` 仅作格式演示，需换成你的地址。本项目没有预置公网中继。不要把配置文件、状态目录或配对二维码发给他人。

Windows 可另外开启[远程启动组件](tools/WINDOWS-WAKE.md)，默认关闭。

## 可选：推送任务状态到手机

支持自建 Bark 与 iOS 实时活动，使用独立签名通道，不需要开放宿主 API。配置 `push-relay.json` 的位置、签名要求和测试步骤见 [部署指南](../deploy/task-push/README.md)。

### 手机首页与当地天气

空白会话在可用区域居中显示输入卡，并播放一次宿主自带的鲸鱼动画；启用「减少动态效果」时不自动播放。会话保留原工具箱入口。0.6.4 客户端在插件、自动化等全局页面将工具箱放到原生顶栏，不遮挡页面控件。

会话标题左侧默认显示配对电脑所在地的天气，而不是手机的位置。Windows 插件通过系统位置服务获取近似位置，再以两位小数精度向 Open-Meteo 查询；坐标不会发给手机，也不写入插件存储。电脑未允许定位、取不到位置（包括目前未接入系统定位的非 Windows 主机）、天气过期或天气服务不可用时，按电脑时钟和时区显示时段，不用公网 IP 推测位置。图标仅作显示，点击不会弹窗。在「工具箱 → 工具 → 阅读与显示偏好」关闭「显示电脑所在地天气」后，此手机仅显示电脑时间，不再发起天气查询。天气为模型估算，不是街道级实测；公开免费接口适用于非商业使用，商业部署须遵守供应商条款。

### 手机上传附件

在新会话或已有会话的输入框点击「＋」→ 添加附件。从「照片或视频」选择的普通照片会保留图片预览；「选择文件」按原始字节上传，不限制扩展名。支持多选。文件夹在手机上打包成 ZIP，保留文件的相对目录，不自动解压；只包含系统文件选择器交付的条目。不支持目录选择的系统可以在「文件」中先压缩再上传。

每个文件（或生成的 ZIP）最大 200 MiB（209,715,200 字节），不是一次选择的总上限。读图仍受 DSH 的模型和单条消息限制；超出上游默认 50 MiB 单图预算的照片以普通文件上传。「上传成功」不等于模型能预览或解析所有格式。主机需有空间保存文件；若使用自建反向代理，请为附件路由允许足够的请求体大小和上传时间。

### 模型 Base URL 自动选线

手机连接电脑或云端时，实际发送模型请求的 DSH 主机会为 HTTPS 模型接口选择线路。默认先沿用主机配置的 HTTP(S) 代理；Windows 只配置了系统代理时，也会按目标读取系统代理。没有可用代理或命中绕过规则时，保持原请求不变。不会修改 Windows、代理软件、环境变量或其他应用的路由。若你的网络要求所有请求必须经过代理，可在 `mobile-link` 的 `config` 中设置 `modelRouting: false`。

- 代理返回 401、403、407、451 或在建立连接前失败时，用相同的 Base URL 和凭据立即试另一路一次。不会切换供应商；两条线路都拒绝时保留服务端错误，不保存新规则。
- 获取模型列表时，首选线路 3.5 秒未返回响应头就尝试另一路。生成请求不会因为模型思考很久而被并发重发；发送后不确定服务端是否已接单时，只在下一次重试改走另一路。已经开始的流式回答不会被重新提交。
- 成功后按接口地址（包括路径前缀）在该主机本地记住代理或直连。规则文件 `model-network-rules.json` 只含地址摘要、线路和过期时间，不含 API 密钥、请求内容或代理地址。规则有效期 30 天；首选线路失败后可重新学习。电脑和云端分别学习，互不覆盖。
- 直连指该主机不使用应用层代理，不代表一定获得中国大陆出口；全局 VPN / TUN 或网络网关仍可能接管流量。非 HTTPS、WebSocket 及自行指定传输器的 SDK 保持原行为。
