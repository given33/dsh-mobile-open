#!/bin/sh
# Install the Linux x64 PowerShell runtime for the dedicated DSH account only.
# Usage: sudo sh install-project-pwsh.sh /path/to/powershell-7.6.10-linux-x64.tar.gz
set -eu
umask 022
version=7.6.10
digest=e261cabc91c78a9afe8d1e5f24731ab0d38204735ab2ec94b0af55102652e10d
root=/opt/dsh-cloud
tools=$root/toolchains
target=$tools/pwsh-$version
entry=$root/bin/pwsh
[ "$(id -u)" = 0 ] && [ "$(uname -m)" = x86_64 ] && [ "$#" = 1 ] || { echo 'Requires root, Linux x64 and one official release archive.' >&2; exit 1; }
id dsh-cloud >/dev/null
install -d -o root -g root -m 0755 "$tools" "$root/bin"
exec 9>"$tools/.install-pwsh.lock"
flock -x 9
if [ -e "$entry" ] || [ -L "$entry" ]; then
  [ "$(readlink "$entry")" = "$target/pwsh" ] || { echo 'Another pwsh is configured; leaving it unchanged.' >&2; exit 1; }
fi
smoke() {
  runuser -u dsh-cloud -- env HOME=/var/lib/dsh-cloud POWERSHELL_TELEMETRY_OPTOUT=1 "$1" -NoLogo -NoProfile -NonInteractive -Command '
    $ErrorActionPreference = "Stop"
    if ($PSVersionTable.PSVersion.ToString() -ne "7.6.10" -or -not $IsLinux) { exit 1 }
    if ([Globalization.CultureInfo]::GetCultureInfo("zh-CN").Name -ne "zh-CN") { exit 1 }
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("abc"))) -ne "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD") { exit 1 }'
}
if [ ! -d "$target" ]; then
  [ "$(df -Pk "$tools" | awk 'NR==2 {print $4}')" -gt 2600000 ] || { echo 'Insufficient disk reserve.' >&2; exit 1; }
  tmp=$(mktemp -d "$tools/.pwsh-stage.XXXXXXXX")
  trap 'rm -rf -- "$tmp"' EXIT
  install -m 0600 "$1" "$tmp/archive"
  printf '%s  %s\n' "$digest" "$tmp/archive" | sha256sum -c - >/dev/null
  mkdir "$tmp/runtime"
  tar -xzf "$tmp/archive" --no-same-owner --no-same-permissions -C "$tmp/runtime"
  chmod 0755 "$tmp/runtime/pwsh"
  rm "$tmp/archive"
  chmod 0755 "$tmp"
  smoke "$tmp/runtime/pwsh"
  mv -T "$tmp/runtime" "$target"
fi
smoke "$target/pwsh"
if [ ! -L "$entry" ]; then ln -s "$target/pwsh" "$entry"; fi
printf 'DSH tool ready: %s (%s)\n' "$entry" "$version"
