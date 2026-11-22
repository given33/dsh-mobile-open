# DSH Mobile 0.4.2：让已配对的 iPhone 启动已退出的 DSH

组件默认关闭。手机只能请求启动 Windows 标准安装位置的 `DeepSeek Harness.exe`；不能提供命令、参数或程序路径，也不能开机、解锁电脑。电脑需开机、未睡眠且桌面用户已登录。开启后，该 DSH 桌面当前有效的所有已配对手机都可请求启动；如有旧手机，请先在「手机连接」中移除。

1. 把桌面插件 `dsh-mobile-link-0.4.2.tgz` 下载到电脑，退出 DSH（含托盘），在下载目录的 PowerShell 安装，然后手动打开 DSH：

   ```powershell
   $dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
   & $dsh plugin --profile desktop add (Resolve-Path '.\dsh-mobile-link-0.4.2.tgz').Path
   ```

2. 在 DSH「手机连接」中开启连接，并与装有 0.4.2 的 iPhone 至少配对一次。电脑需可运行 Node.js 22 或以上。将启动组件 ZIP 解压到一个以后不会移动或删除的目录。用运行 DSH 的同一 Windows 用户打开普通 PowerShell，不需要管理员。

3. 在解压目录运行以下命令。其中 `192.168.1.20` 必须换成**电脑自己的局域网 IP**，不是手机 IP。有私人组网时也可以指定电脑的组网 IP。脚本不会放开防火墙；请仅在信任的内网或 VPN 上允许访问这个端口，不要将其直接映射到公网。

   ```powershell
   .\tools\windows-wake.ps1 -Enable -BindAddress 192.168.1.20
   ```

   如果权限策略阻止了你已检查过的下载脚本，可先对该文件执行 `Unblock-File -LiteralPath .\tools\windows-wake.ps1`。不要降低整机执行策略。默认端口 `3444`，可用 `-Port` 修改。若自定义了插件状态目录，添加 `-StateDir '完整路径'`，它应包含同一 DSH 的 `devices.json`、`settings.json` 与链接证书；**不要复制或分享其中的任何文件**。

4. **在 DSH 仍然运行时**，在手机 `… → 重新连接（切换局域网/公网）` 一次，以获取启动地址。然后彻底退出桌面 DSH。在手机断开界面点 **启动电脑 DSH**（也可在 `…` 中选择）；或者点 **重试**，先尝试普通重连，确认网络连接失败后再请求启动。正常的前后台切换和自动重连都不会触发启动。连续成功请求 30 秒内只启动一次。

**从 5G 使用**：原来的 DSH 会话中继一般只转发一个端口。需使用在 DSH 退出后仍在线的私人组网，或额外配置独立的透传 TCP 中继，将同一已配对公网域名的另一端口转到启动组件。例如中继客户端就在这台电脑且连接回环地址，公网端口是 `8444`：

```powershell
.\tools\windows-wake.ps1 -Enable -BindAddress 127.0.0.1 -Port 3444 -PublicPort 8444
```

这条命令只公布地址，不会替你建立中继。绑定回环只适用于本机中继，不对局域网直连开放。若日常会话的中继也随 DSH 一同退出，则重启后还需要它自行恢复，才能重新看到会话。

**关闭/卸载**：同一账号从解压目录执行下列命令（自定义过状态目录须传同一 `-StateDir`）。这会关闭策略并移除该用户的登录任务；之后可删除解压目录。普通已配对连接不受影响。仅移除某台手机的配对也会立刻撤销它的启动权限。

```powershell
.\tools\windows-wake.ps1 -Disable
```
