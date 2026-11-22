#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen'; exit 1; }
swift test --package-path Core
xcodegen generate
xcodebuild -skipPackagePluginValidation -project DSHMobile.xcodeproj -scheme DSHMobile -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
staging="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mobile-ipa.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/Payload"
ditto build/DerivedData/Build/Products/Release-iphoneos/DSHMobile.app "$staging/Payload/DSHMobile.app"
(cd "$staging" && /usr/bin/zip -q -r DSH-Mobile-unsigned.ipa Payload)
mv -f "$staging/DSH-Mobile-unsigned.ipa" build/DSH-Mobile-unsigned.ipa
(cd build && shasum -a 256 DSH-Mobile-unsigned.ipa > DSH-Mobile-unsigned.ipa.sha256)
echo 'Unsigned device IPA: build/DSH-Mobile-unsigned.ipa'
