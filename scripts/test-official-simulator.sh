#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

scratch="$(mktemp -d)"
fixture_pid=
cloud_pid=
grant_pid=
cleanup() {
  if [ -n "$grant_pid" ]; then kill "$grant_pid" 2>/dev/null || true; fi
  if [ -n "$cloud_pid" ]; then kill "$cloud_pid" 2>/dev/null || true; fi
  if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir -p build
if [ -z "${DSH_TEST_CLI:-}" ]; then
  dsh_version="${DSH_TEST_VERSION:-0.2.2-rc.5}"
  npm install --prefix build/harness-test-runtime --ignore-scripts --no-audit --no-fund "@deepseek-ai/dsh@${dsh_version}"
  DSH_TEST_CLI="$PWD/build/harness-test-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
fi
node desktop/test/e2e/turn-tail.mjs "$DSH_TEST_CLI"
bundle="$(cd desktop && npm pack --pack-destination ../build --quiet | tail -1)"
node desktop/tools/official-fixture.mjs --cli "$DSH_TEST_CLI" --bundle "$PWD/build/$bundle" \
  --output "$scratch" >"$scratch/fixture.log" 2>&1 &
fixture_pid=$!
for ((n=0; n<180; n++)); do
  [ -s "$scratch/pair.txt" ] && break
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$scratch/fixture.log"; exit 1; fi
  sleep 1
done
[ -s "$scratch/pair.txt" ] || { cat "$scratch/fixture.log"; exit 1; }
simulator="$(xcrun simctl list devices available -j | python3 -c '
import json,sys
for runtime, rows in reversed(list(json.load(sys.stdin)["devices"].items())):
    if ".iOS-" in runtime:
        for row in rows:
            if row["name"].startswith("iPhone"):
                print(row["udid"]);sys.exit(0)
sys.exit("No available iPhone simulator")
')"
xcrun simctl boot "$simulator" 2>/dev/null || true
xcodegen generate
# Build first: the desktop QR expires after five minutes and is single-use.
# Each test gets a fresh code from the isolated local host just before launch.
args=(-project DSHMobile.xcodeproj -scheme DSHMobile -destination "platform=iOS Simulator,id=$simulator" -parallel-testing-enabled NO -derivedDataPath build/OfficialSimulator)
xcodebuild -skipPackagePluginValidation build-for-testing "${args[@]}" >"$scratch/build.log" 2>&1 || { tail -80 "$scratch/build.log"; exit 1; }
mask_test_log() {
  sed -E 's/(dshmobile:\/\/pair)[^[:space:]]*/\1[redacted]/g' "$1"
}
tests=(testOfficialDesktopUILoadsAndTogglesSidebarDrawer testOfficialDesktopStalledFirstPaintCanBeRetried)
if [[ "${DSH_SIMULATE_CLOUD:-0}" == 1 ]]; then
  # The CI runner maps this DNS name to loopback. This deliberately exercises
  # named-host ATS, not the existing IP exception. Never pair a production host.
  python3 -c 'import socket; assert socket.gethostbyname("relay-fixture.dsh-cloud.sslip.io") == "127.0.0.1"'
  node --input-type=module - "$scratch" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadIdentity } from './desktop/lib/identity.mjs';
const scratch = process.argv[2];
const local = new URL(await readFile(join(scratch, 'pair.txt'), 'utf8')).searchParams.get('id');
const dir = join(scratch, 'cloud-home/mobile-link');
const cloud = await loadIdentity(dir, {name: '模拟云服务器'});
await writeFile(join(dir, 'family-policy.json'), JSON.stringify({familyID:local, cloudID:cloud.id, fingerprint:cloud.fingerprint}));
JS
  node desktop/tools/official-fixture.mjs --cli "$DSH_TEST_CLI" --bundle "$PWD/build/$bundle" \
    --home "$scratch/cloud-home" --output "$scratch/cloud" >"$scratch/cloud.log" 2>&1 &
  cloud_pid=$!
  for ((n=0; n<120; n++)); do
    [ -s "$scratch/cloud/host.json" ] && break
    kill -0 "$cloud_pid" || exit 1
    sleep 1
  done
  python3 scripts/simulator-grants.py "$scratch" &
  grant_pid=$!
  tests+=(testSwitchBetweenPinnedDevicesFromHeader)
fi
for test in "${tests[@]}"; do
  fresh_link="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const h=JSON.parse(readFileSync(process.argv[1]));
    const url=new URL(h.base);
    if(url.hostname!=="127.0.0.1") throw Error("Not a test fixture");
    const r=await fetch(new URL("dsh-mobile-link/code",url),{method:"POST",headers:{Cookie:h.cookie,"Content-Type":"application/json"},body:"{}"});
    const d=await r.json();
    if(!r.ok || !d.pairing?.link) throw Error("No fresh pairing offer");
    process.stdout.write(d.pairing.link);
  ' "$scratch/host.json")"
  log="$scratch/$test.log"
  TEST_RUNNER_DSH_UI_LINK="$fresh_link" \
    xcodebuild test-without-building "${args[@]}" \
    -only-testing:"DSHMobileUITests/DSHMobileUITests/$test" \
    -resultBundlePath "$scratch/$test.xcresult" >"$log" 2>&1 || {
      mask_test_log "$log" | tail -85
      exit 1
    }
  if ! grep -Fq '** TEST SUCCEEDED **' "$log" || ! grep -Eq "Test Case .*${test}.* passed" "$log"; then
    echo "Expected executed XCTest did not report a pass: $test" >&2
    mask_test_log "$log" | tail -85
    exit 1
  fi
  grep -E "Test Case .*${test}.* passed" "$log"
done
