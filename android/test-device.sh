#!/usr/bin/env bash
set -euo pipefail
apk=android/app/build/outputs/apk
adb install -r "$apk/debug/app-debug.apk"
adb install -r "$apk/androidTest/debug/app-debug-androidTest.apk"
pinfile=$(mktemp -d)/pin
node android/qa/peer.mjs "$pinfile" &
peer=$!
for i in {1..80}; do [[ ! -s "$pinfile" ]] || break; sleep .1; done
adb reverse tcp:39463 tcp:39463
trap 'kill "$peer" || true; adb reverse --remove tcp:39463; adb shell wm size reset; adb shell wm density reset' EXIT
for geometry in '720x1280' '1280x720' '1600x2400'; do
  adb shell wm size "$geometry"; adb shell wm density 320
  echo "Testing window $geometry"
  timeout --kill-after=5s 90s adb shell am instrument -w -e pin "$(cat "$pinfile")" app.dshmobile.android.test/androidx.test.runner.AndroidJUnitRunner | tee /tmp/android-test-result || { adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | tail -4; adb logcat -d -s chromium:E AndroidRuntime:E TestRunner:I DSH-QA:I | tail -30; exit 1; }
  adb logcat -d -s DSH-QA:I | tail -2
  if ! grep -q 'OK (' /tmp/android-test-result; then adb logcat -d -s chromium:E AndroidRuntime:E | tail -25; fi
  grep -Eq 'OK \([1-9][0-9]* tests?\)' /tmp/android-test-result
done
