#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM_ID="L6DX4VDCTF"
BUNDLE_ID="com.resonancegroup.rglink"
SCHEME="RGLink"
WORKSPACE="ios/RGLink.xcworkspace"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_DIR="$HOME/Library/Developer/Xcode/Archives/RG-Agent-Link"
ARCHIVE_PATH="$ARCHIVE_DIR/RG-Agent-Link-$TIMESTAMP.xcarchive"
EXPORT_DIR="$REPO_ROOT/.release/testflight-$TIMESTAMP"
EXPORT_PLIST="$EXPORT_DIR/ExportOptions.plist"

cd "$REPO_ROOT"
mkdir -p "$ARCHIVE_DIR" "$EXPORT_DIR"

if [[ "$(git branch --show-current)" != "ios-native-build" ]]; then
  echo "ERROR: release must run from ios-native-build" >&2
  exit 2
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ERROR: tracked working tree is not clean" >&2
  git status --short >&2
  exit 2
fi

APP_BUNDLE="$(node -p "require('./app.json').expo.ios.bundleIdentifier")"
APP_BUILD="$(node -p "require('./app.json').expo.ios.buildNumber")"
APP_NAME="$(node -p "require('./app.json').expo.name")"
if [[ "$APP_BUNDLE" != "$BUNDLE_ID" ]]; then
  echo "ERROR: bundle id is $APP_BUNDLE, expected $BUNDLE_ID" >&2
  exit 2
fi

echo "== RG Agent Link local TestFlight release =="
echo "App: $APP_NAME"
echo "Bundle: $APP_BUNDLE"
echo "Build: $APP_BUILD"
echo "Commit: $(git rev-parse --short HEAD)"
echo

echo "[1/5] Typecheck"
npm run typecheck

echo "[2/5] Regenerate native iOS project"
npx expo prebuild --platform ios --no-install

if [[ ! -d "$WORKSPACE" ]]; then
  echo "ERROR: workspace missing after prebuild: $WORKSPACE" >&2
  exit 2
fi

echo "[3/5] Install/update CocoaPods"
(
  cd ios
  pod install --silent
)

cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>upload</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
PLIST

echo "[4/5] Archive locally with Xcode"
/usr/bin/xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  archive

ARCHIVE_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' "$ARCHIVE_PATH/Info.plist")"
ARCHIVE_BUNDLE="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleIdentifier' "$ARCHIVE_PATH/Info.plist")"
if [[ "$ARCHIVE_BUILD" != "$APP_BUILD" || "$ARCHIVE_BUNDLE" != "$BUNDLE_ID" ]]; then
  echo "ERROR: archive identity mismatch: bundle=$ARCHIVE_BUNDLE build=$ARCHIVE_BUILD" >&2
  exit 2
fi

echo "[5/5] Upload archive directly to Apple App Store Connect"
/usr/bin/xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates

echo
echo "SUCCESS: Apple accepted RG Agent Link build $APP_BUILD for App Store Connect/TestFlight upload."
echo "Archive: $ARCHIVE_PATH"
echo "Release artifacts/log support: $EXPORT_DIR"
