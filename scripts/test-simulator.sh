#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

scratch="$(mktemp -d)"
fixture_pid=
plugin_fixture_pid=
cleanup() {
  if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; fi
  if [ -n "$plugin_fixture_pid" ]; then kill "$plugin_fixture_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

node desktop/tools/demo-server.mjs --fixture desktop/test/fixtures/simulator.json --actions \
  --host 127.0.0.1 --port 0 --link-file "$scratch/pair.txt" > "$scratch/fixture.log" 2>&1 &
fixture_pid=$!
node desktop/tools/demo-server.mjs --fixture desktop/test/fixtures/simulator.json --actions \
  --host 127.0.0.1 --port 0 --link-file "$scratch/plugin-pair.txt" > "$scratch/plugin-fixture.log" 2>&1 &
plugin_fixture_pid=$!
for ((n=0; n<50; n++)); do
  [ -s "$scratch/pair.txt" ] && [ -s "$scratch/plugin-pair.txt" ] && break
  if ! kill -0 "$fixture_pid" "$plugin_fixture_pid" 2>/dev/null; then exit 1; fi
  sleep 0.2
done
[ -s "$scratch/pair.txt" ] && [ -s "$scratch/plugin-pair.txt" ] || { echo 'Simulator fixtures did not start'; exit 1; }

simulator="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
for runtime, rows in reversed(list(devices.items())):
    if ".iOS-" not in runtime:
        continue
    for row in rows:
        if row["name"].startswith("iPhone"):
            print(row["udid"])
            sys.exit(0)
sys.exit("No available iPhone simulator")
')"
xcrun simctl boot "$simulator" 2>/dev/null || true

xcodegen generate
set --
if [ -n "${DSH_UI_ONLY_TEST:-}" ]; then
  set -- "-only-testing:$DSH_UI_ONLY_TEST"
fi
TEST_RUNNER_DSH_UI_LINK="$(cat "$scratch/pair.txt")" \
TEST_RUNNER_DSH_UI_LINK_PLUGINS="$(cat "$scratch/plugin-pair.txt")" \
TEST_RUNNER_DSH_UI_LINK_PUBLIC="${DSH_UI_PUBLIC_PAIRING_LINK:-}" \
  xcodebuild -skipPackagePluginValidation test -project DSHMobile.xcodeproj -scheme DSHMobile \
  -destination "platform=iOS Simulator,id=$simulator" -parallel-testing-enabled NO \
  "$@" \
  -derivedDataPath build/Simulator -resultBundlePath "$scratch/DSHMobile.xcresult" \
  > "$scratch/xcodebuild.log" 2>&1 || {
    sed -E 's/(dshmobile:\/\/pair)[^[:space:]]*/\1[redacted]/g' "$scratch/xcodebuild.log" | tail -130
    exit 1
  }
grep -Fq '** TEST SUCCEEDED **' "$scratch/xcodebuild.log"
if [ -n "${DSH_UI_PUBLIC_PAIRING_LINK:-}" ]; then
  grep -F "testPublicAddressReachesPairingServer]' passed" "$scratch/xcodebuild.log"
fi
grep -E 'Executed [0-9]+ test|TEST SUCCEEDED' "$scratch/xcodebuild.log"
