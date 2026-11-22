"""Fail packaging if the iOS device binary or either app icon is missing."""
import plistlib
import sys
import zipfile
from pathlib import PurePosixPath

APP = "Payload/DSHMobile.app/"
PNG = b"\x89PNG\r\n\x1a\n"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def verify(ipa):
    with zipfile.ZipFile(ipa) as archive:
        require(archive.testzip() is None, "Corrupt IPA")
        names = set(archive.namelist())
        require(all(n.startswith("Payload/") and ".." not in PurePosixPath(n).parts for n in names), "Unexpected IPA member")
        require(len(names) == len(archive.infolist()), "Duplicate IPA member")
        info = plistlib.loads(archive.read(APP + "Info.plist"))
        require(info["CFBundleIdentifier"] == "app.dshmobile.client" and info["CFBundleSupportedPlatforms"] == ["iPhoneOS"], "Expected an iOS device application")
        with archive.open(APP + info["CFBundleExecutable"]) as executable:
            require(executable.read(8) == bytes.fromhex("cffaedfe0c000001"), "Expected the arm64 device executable")
        require(archive.getinfo(APP + "Assets.car").file_size > 0, "Asset catalog is empty")
        for platform, icons_key, stem, suffix in [
            ("iPhone", "CFBundleIcons", "AppIcon60x60", "@2x.png"),
            ("iPad", "CFBundleIcons~ipad", "AppIcon76x76", "@2x~ipad.png"),
        ]:
            icon = info.get(icons_key, {}).get("CFBundlePrimaryIcon", {})
            require(icon.get("CFBundleIconName") == "AppIcon" and stem in icon.get("CFBundleIconFiles", []), f"Missing {platform} icon declaration")
            name = APP + stem + suffix
            require(name in names and archive.read(name).startswith(PNG), f"Missing {platform} icon bitmap")
        print(f"Verified iOS {info['CFBundleShortVersionString']} build {info['CFBundleVersion']}: arm64 device binary and iPhone/iPad icons")


if __name__ == "__main__":
    verify(sys.argv[1])
