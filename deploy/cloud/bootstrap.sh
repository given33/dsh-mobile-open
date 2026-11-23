#!/bin/sh
# Bootstrap a dedicated runtime without changing the host's system Node or DSH installation.
set -eu
root=/opt/dsh-cloud
state=/var/lib/dsh-cloud
if ! id dsh-cloud >/dev/null 2>&1; then useradd --system --create-home --home-dir "$state" --shell /sbin/nologin dsh-cloud; fi
[ "$(getent passwd dsh-cloud | cut -d: -f6)" = "$state" ] || exit 1
install -d -m 0755 "$root"
install -d -m 0700 -o dsh-cloud -g dsh-cloud "$state" "$state/workspace" "$state/install" "$state/.dsh"
[ "$(df -Pk "$state" | awk 'NR==2{print $4}')" -gt 3000000 ] || { echo 'Not enough free space for installation'; exit 1; }
# No npm lifecycle scripts execute as root. The pinned node-linux-x64 package supplies a standalone binary.
runuser -u dsh-cloud -- env HOME="$state" npm install --prefix "$state/install/runtime" --ignore-scripts --no-fund --no-audit --loglevel=error node-linux-x64@24.22.3 pnpm@11.28.5
install -m 0755 "$state/install/runtime/node_modules/node-linux-x64/bin/node" "$root/node"
install -d "$root/pnpm"; cp -a "$state/install/runtime/node_modules/pnpm/." "$root/pnpm/"; chown -R root:root "$root/pnpm"
cd "$state/install"
runuser -u dsh-cloud -- env HOME="$state" PATH="$root:$PATH" "$root/node" "$root/pnpm/bin/pnpm.cjs" add --save-exact --ignore-scripts --config.child-concurrency=1 --network-concurrency=4 --reporter=append-only @deepseek-ai/dsh@0.2.3-alpha.2
