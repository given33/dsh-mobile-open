---
name: relay-project-tools
description: DSH 从 Windows 接手到 Linux，或 Linux 构建缺少工具、运行时、包依赖时，在当前工作区补齐环境并验证。适用于 Node、Python 和本机编译，不用于重放部署或恢复进程内存。
---

先调用 `relay_environment`（如果可用），再用当前会话的原生 Bash 核对工作目录、项目声明的版本、锁文件、磁盘余量和 `command -v`。不要把 Windows 的 `node_modules`、虚拟环境或二进制直接带到 Linux；不要把桌面用过的安装命令当成它已经成功的记录。

* **Node**：优先使用 `packageManager` 与锁文件指定的工具和版本。对于已有完整 npm 锁文件的新检出，使用 `npm ci --ignore-scripts`；它会替换现有 `node_modules`，不要在还有任务使用该目录时运行。pnpm 使用 `pnpm install --frozen-lockfile --ignore-scripts`。依赖确实需要安装钩子时，先核对具体脚本及会话权限，再单独运行所需步骤。以项目自身的构建或测试命令验证，不只看 `--version`。
  接力后读取 `relay_environment.nodeSetup`。当 `modules` 为 `absent` 且有 `freshInstall` 建议时，先核对本轮任务需要安装、接手端确实具备锁定的输入以及本会话允许写入，再通过原生 Shell 执行。已交付本地包且不需要网络时可加 `--offline`。随后执行 `verify` 并运行项目的实际构建。`present-unverified` 不表示安装完成，也不表示可以删除旧依赖。
* **Python**：这个运行环境有 `python3.11`，系统 `python3` 可能是旧版。先核对 `requires-python`；缺依赖时在项目 `.venv` 安装，不改系统 Python。例如 `python3.11 -m venv .venv`，然后使用 `.venv/bin/python -m pip`。使用项目锁定的依赖和索引；锁文件有哈希时开启哈希校验。已存在的 `.venv` 先检查解释器和目标路径，不覆盖。用实际 import、CLI 或项目测试验证。
* **PowerShell 项目**：如果源端用 `.ps1`，先看 `foundOnPath` 是否包含 `pwsh`，再核对脚本的模块、路径和系统 API。对两端兼容的脚本，可用本机原生终端调用 `pwsh -NoLogo -NoProfile -NonInteractive -File ./scripts/Build-Project.ps1`（路径以项目为准）；不要把脚本逐行猜译成 Bash。Win32、COM、注册表和 Windows 专用模块不会因为 Linux 装了 PowerShell 就可用。
* **编译工具**：从 CMake 生成器、编译器版本及系统库探测入手。只有在项目支持时，Ninja 缺失才可选已有的 Unix Makefiles，并使用新的构建目录。如果工具是项目声明且版本已锁定的用户空间包，可以用项目自己的包管理器安装到工作区，不全局安装。`pwsh` 不存在不等于 Bash 能执行 PowerShell 脚本；先验证有对应的 Linux 实现和所需输入。
* **权限与接力**：所有写入或联网都走当前会话原生工具和审批，计划/只读模式只检查。需要 root、驱动、系统服务、来源不明的软件源或超出磁盘预算时，说明缺哪个包、版本和用途，不改服务权限、不用 `sudo` 或远程脚本管道。安装后重新探测环境，记录实际完成的步骤与产物再继续。部署、发消息等有外部副作用的步骤必须查实际回执或幂等键；无法证明未执行，不自动重放。
