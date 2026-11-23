# 云端共享任务

需要在电脑关机后继续的任务，从 **DSH 云端共享任务**（电脑）或已开通云端配对的 iPhone 顶栏 **新建会话**进入。两端连接的是同一个云端 DSH 进程；断开浏览器不会要求模型重新生成或重做工具操作。首次使用先在云端 DSH 配置模型。电脑本地文件、凭据及已运行的 Windows 进程不随配对上传。

点手机顶栏的设备名切换。在正在运行的会话上，保留原执行端的网页和实时连接；抽屉会区分所选设备与执行端。已在云端运行时，本地连接掉线不会重建会话。普通本机任务不具有运行时迁移能力。历史镜像只导入指定共享工作区已结束轮次的用户、助手文本，不当作可执行的检查点。

## 部署约定

* `bootstrap.sh` 与 `dsh-cloud.service` 使用独立非 root 账户和回环 Web 监听器。不要把含 owner 权限的 Web/插件管理 API 直接暴露到公网。iPhone 通过单独的 TLS 端口访问手机插件，锁定公钥。PC 浏览器用 `py -3.11 open_web.py <SSH 别名>`；别名须事先配置并核对 SSH 主机密钥。`--verify` 只检查隧道与 Web 登录。
* 在电脑 `mobile-link/family-route.json` 填入 `familyID`（本机 DSH ID）、`cloudID`、`fingerprint`（通过受信 SSH 从云端获取的手机连接公钥指纹）、`endpoint`（云端公网主机:端口）。在云端对应目录的 `family-policy.json` 仅填前三项。两端凭据与证书保持独立。
* 同步插件的 `role` 分别为 `desktop`、`cloud`；`workspace` 是各自显式选择的共享目录。桌面额外配置 `sshHost`。SSH 对端命令固定为以 `dsh-cloud` 身份运行 `/opt/dsh-cloud/transfer.py --peer /var/lib/dsh-cloud/.dsh/shared-sessions`。电脑每轮发布云端专用凭证的校验值，撤销在下次同步后生效；不要上传电脑 bearer、模型密钥或完整 `.dsh` 目录。
* 更新手机后先成功连接电脑一次，云端专用凭证才会进本机钥匙串。首次开通及撤销需电脑与云端在线；之后使用云端不依赖电脑运行。
