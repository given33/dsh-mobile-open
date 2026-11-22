# DSH Mobile Link 0.6.0

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
$package = (Resolve-Path 'build/dsh-mobile-link-0.6.0.tgz').Path
& $dsh plugin --profile desktop add $package
```

若 DSH 安装在其他位置，调整 `$dsh`。Web 版使用 `dsh plugin --profile web add ./build/dsh-mobile-link-0.6.0.tgz`。

重开 DSH，点左下角「手机连接」，开启连接，再用手机扫码。连接初次开启时先在可信局域网配对。已配对设备默认只读；需要主动发送和审批时再开启「允许手机操作」，需要输入终端指令时才启用单独的终端权限。可随时在此面板撤销配对。

手机端通过四宫格工具箱的「任务」查看会话。列表展示最后更新时间，支持搜索、打开、左滑归档或恢复，以及批量操作。归档会同步到电脑，不会删除聊天记录；只读连接不能修改归档状态。

## 网络选项

跨网优先使用自己的私人组网。如需公网入口，使用由你控制的 TCP 透传中继，保持加密流端到端传输，并在 `cordis.patch.yml` 的插件配置中设置 `extraHosts`。示例地址 `203.0.113.12:443` 仅作格式演示，需换成你的地址。本项目没有预置公网中继。不要把配置文件、状态目录或配对二维码发给他人。

Windows 可另外开启[远程启动组件](tools/WINDOWS-WAKE.md)，默认关闭。
