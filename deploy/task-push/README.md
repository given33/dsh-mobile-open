# 在自己的阿里云 ECS 部署 DSH 任务推送

两条通道可以独立开启：普通通知走这台 ECS 上的 Bark Server，由手机上的 **Bark 应用**收取；DSH 自己的锁屏实时活动与灵动岛走 **你的 Apple 团队的 APNs**。Bark 的内置签名不能给另一个应用的灵动岛签名。无需修改现有手机连接隧道，也不需要向 ECS 上传对话或同步文件。

## 1. 服务端

适用于自己管理的一台 Linux ECS（Docker 和 Compose v2），不是对外出租的多租户推送平台。准备一个已指向该 ECS 的域名，并允许 TCP 80、443 及服务器对 APNs 的出站 HTTPS。若机器已经有 Nginx/Caddy/其他服务占用这些端口，请**不要停止它们**：将随包 Caddyfile 的路由接入现有反向代理，让内部服务使用私有网络或仅绑定回环地址。不要对外暴露 Bark 的 `/push`、设备推送路径、8080 或 8081。

在独立目录解压此部署包。以下命令只在**首次安装**时生成签名密钥；升级时保留 `secrets/`、`.env` 和 Docker 卷：

```sh
umask 077
mkdir -p secrets && chmod 700 secrets
test -s secrets/relay || openssl rand -hex 32 > secrets/relay
```

创建 `.env`（示例值须替换；只做 Bark 时仅填第一行即可）：

```dotenv
PUSH_DOMAIN=push.example.com
APNS_TEAM_ID=YOUR_APPLE_TEAM_ID
APNS_KEY_ID=YOUR_APNS_KEY_ID
APNS_BUNDLE_ID=app.dshmobile.client
APNS_SANDBOX=false
```

若启用后台灵动岛，从自己的 Apple 开发者团队创建具有 APNs 权限、正确环境和 topic 范围的 `.p8`，安全复制到 `secrets/apns.p8`，权限 `600`。不要将 `.p8` 或 `secrets/relay` 放进代码仓库、工单、命令历史或聊天。开发签名用 `APNS_SANDBOX=true`，分发签名使用生产环境。iOS 主应用须开启 Push Notifications 并使用包含 `aps-environment` 的有效配置描述文件；嵌入的 Widget 扩展也须由同一团队以对应的标识符签名。如果换了主应用 Bundle ID，需一起更改主应用和扩展标识、构建校验脚本及 `APNS_BUNDLE_ID`，重新构建并签名；仅改服务器配置不够。

```sh
docker compose config --quiet
docker compose up -d
docker compose ps
curl --fail https://push.example.com/ping
```

公网只允许 Bark 注册/健康检查和 `POST /v1/event`。后者按时间戳、随机数、原始正文做 HMAC-SHA256 校验；电脑和 ECS 要校时。Bark 容器关闭请求日志，以免写出设备 Key。不要在外层代理启用请求体日志，或记录 `/register/*` 中的 Key。密钥、活动令牌和状态数据库均应按私有数据处理。

## 2. 电脑插件

安装随版本发布的桌面插件。在插件 `stateDir` 下创建 `push-relay.json`（Windows 默认 `%USERPROFILE%\.dsh\mobile-link\push-relay.json`；自定义 `DSH_HOME` 时为其下的 `mobile-link`）。仅让运行 DSH 的用户和受信系统管理员读取这个文件：

```json
{"url":"https://push.example.com/v1/event","secret":"替换为 ECS 的 secrets/relay 中的完整一行"}
```

重启插件或 DSH 使配置生效，打开「手机连接」。电脑需要能主动访问上述 HTTPS 地址；不要把配对凭据、桌面账户、工作区或 DSH 宿主端口暴露给推送服务。使用官方插件接收宿主事件，独立测试代理不产生真实任务事件。

## 3. 手机验收

1. 在 iOS Bark 中允许通知并添加自建服务器 `https://push.example.com`。复制**这个服务器**分配的设备 Key（不是 Apple 令牌、完整 URL 或 DSH 配对码）。
2. 手机与 DSH 配对，在连接设置的「任务推送与灵动岛」输入 Key，启用 Bark，再点「发送一条测试通知」。应能在 **Bark** 收到通知。不同手机请分别注册；不要共用 Key。
3. 启用「锁屏实时活动 / 灵动岛」，并确认 iOS 系统允许 DSH 的实时活动。用实际团队签名的 DSH 打开一次完成令牌登记。先在前台运行任务，再回桌面或锁屏，验证步骤更新、等待审批、失败和成功。支持灵动岛的机型会在岛上显示，其他支持实时活动的机型显示于锁屏。点活动可回到对应电脑的会话；Bark 通知附有同一会话的应用链接。
4. 成功立即结束活动；取消、受阻和异常结束保留约五分钟供查看。等待输入或审批不是结束。普通步骤、工具分类与待办计数显示于活动，不为每一步弹出通知。有事需要你处理、状态变化或任务结束时才通过 Bark 提醒。默认不传用户提问原文、审批内容、工具实参、文件路径或模型回答。

**边界：** iOS 17.0–17.1 需要先在应用前台启动活动，17.2+ 才支持符合系统条件的远程启动。更新受网络、APNs 调度、系统频率预算、强退应用和权限影响，不按每个流式 token 推送。桌面短暂断网会重试重要通知，但不会把失联当作任务完成；宿主异常退出且没有发出终态时只能显示进度可能过期。桌面停机期间不可能观察新事件。关闭开关或撤销配对停止后续推送。Bark 通知与 DSH 的签名推送分开排障：收到 Bark 测试不能证明灵动岛也已获 APNs 授权。
