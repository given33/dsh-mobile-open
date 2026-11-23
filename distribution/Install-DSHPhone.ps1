[CmdletBinding()] param([string]$DshCli)
$ErrorActionPreference = 'Stop'
try {
  $name = 'dsh-mobile-link-0.7.14.tgz'
  $package = Join-Path $PSScriptRoot $name
  if (!(Test-Path -LiteralPath $package -PathType Leaf)) { throw '请先解压整个 ZIP，再双击 Install.cmd。' }
  if (!$DshCli) {
    $cliPaths = @("$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd", "$env:ProgramFiles\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd")
    $DshCli = $cliPaths | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf} | Select-Object -First 1
    if (!$DshCli) { $DshCli = (Get-Command dsh.cmd,dsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
  }
  if (!$DshCli) { throw '找不到 DSH。请先安装 DeepSeek Harness 桌面版，或用 -DshCli 指定它的 dsh.cmd。' }
  $homePath = if ($env:DSH_HOME) {$env:DSH_HOME} else {Join-Path $env:USERPROFILE '.dsh'}
  $digest = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
  $dir = Join-Path (Join-Path $homePath 'mobile-link-packages') $digest.Substring(0,16)
  [void][IO.Directory]::CreateDirectory($dir)
  $target = Join-Path $dir $name
  if ([IO.Path]::GetFullPath($package) -ne [IO.Path]::GetFullPath($target)) {Copy-Item -LiteralPath $package -Destination $target -Force}
  & $DshCli plugin --profile desktop add $target
  if ($LASTEXITCODE -ne 0) { throw "DSH 安装失败（退出码 $LASTEXITCODE）。请检查桌面版安装与上方错误。" }
  Write-Host '安装成功。请从托盘彻底退出并重新打开 DSH，再点击左下角「手机连接」。' -ForegroundColor Green
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
