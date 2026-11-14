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

npx --yes "@electron/packager@$PACKAGER_VERSION" . Lectern \
  --platform=darwin --arch="$ARCH" --out=dist --overwrite \
  --app-bundle-id=local.lectern.app \
  --app-version="$VERSION" --build-version="$VERSION" \
  --app-copyright="Lectern $VERSION" \
  --ignore='^/(test|dist|release|scripts|Lectern|\.git|\.github|\.vscode|CLAUDE\.md)($|/)'

APP="dist/Lectern-darwin-$ARCH/Lectern.app"
# Apple Silicon only runs signed apps. An "ad-hoc" signature is enough for an app you built yourself.
codesign --force --deep --sign - "$APP"

echo
echo "Built: $APP"
echo "To install it, drag it into Applications, or run:"
echo "  cp -R \"$APP\" /Applications/"
