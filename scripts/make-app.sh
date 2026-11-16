#!/bin/bash
# Builds Lectern.app, a normal double-clickable Mac app, into the dist/ folder.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
  echo "This builds the Mac app, so it has to run on a Mac."
  exit 1
fi

[ -d node_modules/electron ] || npm install

ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] || ARCH="x64"

# Pinned so a new packager release cannot change the build without anyone noticing.
PACKAGER_VERSION=20.3.0
VERSION="$(node -p "require('./package.json').version")"

# Ship the native speech helper so installed apps do not need a compiler.
node electron/build-voice.js native

npx --yes "@electron/packager@$PACKAGER_VERSION" . Lectern \
  --platform=darwin --arch="$ARCH" --out=dist --overwrite \
  --app-bundle-id=local.lectern.app \
  --app-version="$VERSION" --build-version="$VERSION" \
  --app-copyright="Lectern $VERSION" \
  --asar.unpackDir=native \
  --icon=build/icon.icns \
  --ignore='^/(test|dist|release|build|scripts|Lectern|\.git|\.github|\.vscode|\.impeccable|\.scratch|output|bench|CLAUDE\.md|PRODUCT\.md|DESIGN\.md)($|/)'

APP="dist/Lectern-darwin-$ARCH/Lectern.app"

# Smaller download: Chromium ships its own built-in messages in 55 languages. Lectern's window is English, so
# only the English ones are kept (the app still follows the Mac's language for its own menus and file dialogs,
# which come from Contents/Resources/*.lproj and are left alone).
CHROMIUM_LOCALES="$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
find "$CHROMIUM_LOCALES" -maxdepth 1 -type d -name '*.lproj' ! -name 'en.lproj' ! -name 'en_GB.lproj' ! -name 'Base.lproj' -exec rm -rf {} +
# Apple Silicon only runs signed apps. An "ad-hoc" signature is enough for an app you built yourself.
codesign --force --deep --sign - "$APP"

echo
echo "Built: $APP"
echo "To install it, drag it into Applications, or run:"
echo "  cp -R \"$APP\" /Applications/"
