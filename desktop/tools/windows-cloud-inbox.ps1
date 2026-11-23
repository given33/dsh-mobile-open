# Transports results and explicitly submitted cloud turns. Never starts DSH or executes a prompt locally.
[CmdletBinding(DefaultParameterSetName='Enable')]
param(
    [Parameter(Mandatory,ParameterSetName='Enable')][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*$')][string]$SshHost,
    [Parameter(ParameterSetName='Enable')][switch]$BeforeSignIn,
    [Parameter(Mandatory,ParameterSetName='Disable')][switch]$Disable,
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' })
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$name = 'DSH Mobile Cloud Inbox - ' + $identity.User.Value
if ($Disable) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $name
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
    return
}
$root = (Resolve-Path -LiteralPath (Join-Path $DshHome 'mobile-task-sync')).Path
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\lib\task-sync\transfer.py')).Path
$python = (& py -3.11 -c "import sys; print(sys.executable)")
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Python 3.11 is required.' }
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (!(Test-Path -LiteralPath $pythonw -PathType Leaf)) { throw 'Python windowless runtime missing.' }
# Keep the helper independent of an unpacked plugin directory or a future plugin upgrade.
$helper = Join-Path $root ('receiver-' + (Get-FileHash -LiteralPath $source).Hash + '.py')
Copy-Item -LiteralPath $source -Destination $helper -Force
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"{0}" --mailbox "{1}" {2}' -f $helper,$root,$SshHost)
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
if ($BeforeSignIn) {
    # Requires permission to register boot triggers and an SSH key usable by this account without a UI.
    $startup = New-ScheduledTaskTrigger -AtStartup
    $logon = 'S4U'
} else {
    $startup = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $logon = 'Interactive'
}
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType $logon -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($startup,$repeat) -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $name -ErrorAction Stop
Write-Output "Registered $name ($logon); the receiver retries every minute."

