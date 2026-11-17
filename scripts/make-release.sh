#!/bin/bash
# Builds every download for a release into release/:
#   Lectern-<version>.dmg              Mac (Apple Silicon), with the pixel-art drag-to-install window
#   Lectern-<version>-windows-x64.zip  Windows 10/11 (x64), a portable folder with Lectern.exe
#   SHA256SUMS.txt
# Run on a Mac. Needs python3 (for dmgbuild, installed into dist/.dmgbuild-venv on first run).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
PACKAGER_VERSION=20.3.0
DMGBUILD_VERSION=1.6.5
# The Windows app ships the same list of what it runs as the Mac app (scripts/make-app.sh), without the Mac voice
# helper (native/): electron/, server/, shared/, ui/ and package.json. Everything else stays out.
SHIP_WIN='^/(?!(electron|server|shared|ui)(/|$)|package\.json$)'
mkdir -p release

echo "== tests"
npm test

echo "== Mac app"
bash scripts/make-app.sh
APP="dist/Lectern-darwin-$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo x64 )/Lectern.app"

echo "== Mac installer (DMG)"
node scripts/dmg-background.js dist/dmg
[ -x dist/.dmgbuild-venv/bin/dmgbuild ] || { python3 -m venv dist/.dmgbuild-venv && dist/.dmgbuild-venv/bin/pip install -q "dmgbuild==$DMGBUILD_VERSION"; }
DMG="release/Lectern-$VERSION.dmg"
rm -f "$DMG"
dist/.dmgbuild-venv/bin/dmgbuild -s scripts/dmg-settings.py -D app="$APP" -D background=dist/dmg/background.png -D icon=build/icon.icns "Lectern $VERSION" "$DMG"
hdiutil verify "$DMG"

echo "== Windows app (x64)"
npx --yes "@electron/packager@$PACKAGER_VERSION" . Lectern \
  --platform=win32 --arch=x64 --out=dist --overwrite \
  --app-version="$VERSION" --build-version="$VERSION" --app-copyright="Lectern $VERSION" \
  --win32metadata.CompanyName=Lectern --win32metadata.ProductName=Lectern --win32metadata.FileDescription=Lectern \
  --icon=build/icon.ico \
  --ignore="$SHIP_WIN" --ignore='^/electron/voice($|/)' --ignore='\.DS_Store$'
# Smaller download: keep only Chromium's English built-in messages (Lectern's window is English).
find dist/Lectern-win32-x64/locales -name '*.pak' ! -name 'en-US.pak' ! -name 'en-GB.pak' -delete
ZIP="release/Lectern-$VERSION-windows-x64.zip"
rm -f "$ZIP"
( cd dist && mv Lectern-win32-x64 Lectern && ditto -c -k --norsrc --keepParent Lectern "../$ZIP" && mv Lectern Lectern-win32-x64 )

echo "== checksums"
( cd release && shasum -a 256 "Lectern-$VERSION.dmg" "Lectern-$VERSION-windows-x64.zip" > SHA256SUMS.txt && cat SHA256SUMS.txt )
