# Run as the SAME signed-in Windows user as DSH. No elevation/firewall change.
[CmdletBinding(DefaultParameterSetName='Disable')]
param([Parameter(Mandatory,ParameterSetName='Enable')][switch]$Enable,
      [Parameter(Mandatory,ParameterSetName='Disable')][switch]$Disable,
      [string]$StateDir = $(if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'mobile-link' } else { Join-Path $HOME '.dsh\mobile-link' }),
      [ValidateRange(1024,65535)][int]$Port=3444, [ValidateRange(0,65535)][int]$PublicPort=0,
      [ipaddress]$BindAddress='127.0.0.1')
$ErrorActionPreference='Stop'
$dir=(Resolve-Path -LiteralPath $StateDir).Path
$cfg=Join-Path $dir 'wake.json'
$taskName='DSH Mobile Wake - '+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Write-Policy($data) {
  $tmp=Join-Path $dir ('wake-'+[guid]::NewGuid()+'.tmp'); [IO.File]::WriteAllText($tmp,($data | ConvertTo-Json -Compress)); Move-Item -LiteralPath $tmp -Destination $cfg -Force
}
if ($Disable) {
  Write-Policy @{enabled=$false}; $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -InputObject $task; Unregister-ScheduledTask -InputObject $task -Confirm:$false }; return
}
foreach ($file in @('identity.json','link-key.pem','link-cert.pem','devices.json','settings.json')) { if (!(Test-Path -LiteralPath (Join-Path $dir $file) -PathType Leaf)) { throw "Pair first / check StateDir ($file missing)." } }
$app=Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'; if (!(Test-Path -LiteralPath $app -PathType Leaf)) { throw 'Standard DSH desktop installation not found.' }
$node=(Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
if ([int](& $node -p "process.versions.node.split('.')[0]") -lt 22) { throw 'Node.js 22+ is required.' }
if ((Get-Content -LiteralPath (Join-Path $dir 'settings.json') -Raw | ConvertFrom-Json).enabled -ne $true) { throw 'Enable Phone Link in DSH first.' }
$helper=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\bin\wake-helper.mjs')).Path
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$act=New-ScheduledTaskAction -Execute $node -Argument ('"'+$helper+'" "'+$dir+'"')
$trig=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -InputObject $existing }
Write-Policy @{enabled=$true;port=$Port;publicPort=$(if($PublicPort){$PublicPort}else{$null});bind=$BindAddress.ToString()}
try {
 Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trig -Principal $principal -Settings $settings -Force | Out-Null
 Start-ScheduledTask -TaskName $taskName
 Start-Sleep -Seconds 2
 if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { throw 'Wake listener did not stay running. Check port/bind address and Node installation.' }
} catch {
 Write-Policy @{enabled=$false}
 $failed=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
 if ($failed) { Stop-ScheduledTask -InputObject $failed -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $failed -Confirm:$false }
 throw
}
Write-Output "Wake enabled on ${BindAddress}:$Port. Reconnect the phone once while DSH is running."
