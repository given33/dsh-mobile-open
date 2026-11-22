#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to a recent NDK}"
bin="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
for spec in 'arm64-v8a arm64 aarch64' 'armeabi-v7a arm armv7a' 'x86_64 amd64 x86_64' 'x86 386 i686'; do
  read -r abi arch triple <<< "$spec"
  dest="$PWD/app/src/main/jniLibs/$abi"; mkdir -p "$dest"
  cc="$bin/${triple}-linux-android28-clang"; [[ "$arch" != arm ]] || cc="$bin/armv7a-linux-androideabi28-clang"
  (cd bridge; env CGO_ENABLED=1 GOOS=android GOARCH="$arch" GOARM=7 CC="$cc" go build -buildmode=c-shared -trimpath -ldflags='-s -w -extldflags=-Wl,-z,max-page-size=16384' -o "$dest/libdshlink.so" .)
  rm -f "$dest/libdshlink.h"
done
