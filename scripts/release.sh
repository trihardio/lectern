#!/bin/bash
# One word, one release. When the owner says "release", Claude runs this (see .claude/skills/release/SKILL.md):
#
#   bash scripts/release.sh --notes <notes.md> [--trailer "Co-Authored-By: ..."] [--dry-run]
#
# 1. Checks: on main, not behind origin/main, gh signed in, the no-reply commit email, no private data in the files.
# 2. Raises the patch version of the last published release by one (v0.2.0 -> v0.2.1 -> v0.2.2 ...) in package.json,
#    package-lock.json and the download names in README.md.
# 3. Builds every download into release/ with scripts/make-release.sh (which runs the tests first).
# 4. Checks the Mac app inside the DMG (version, signature, voice helper) and launches a copy once.
# 5. Commits the whole working tree as "Lectern X.Y.Z", pushes main, publishes the GitHub release with the notes,
#    then downloads the files back and checks their checksums.
#
# --dry-run stops after step 4 and puts the version files back: nothing is committed or published.
# If anything fails before the commit, the version files are put back too. Saying "release" is the owner's approval
# for exactly one release; nothing else in the repo publishes.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

NOTES=""
TRAILER=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    --trailer) TRAILER="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "release: unknown option $1" >&2; exit 2 ;;
  esac
done
fail() { echo "release: $*" >&2; exit 1; }
[ -n "$NOTES" ] && [ -s "$NOTES" ] || fail "give --notes <file>: the release notes, written for ordinary users"
NOTES="$(cd "$(dirname "$NOTES")" && pwd)/$(basename "$NOTES")"

echo "== checks"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || fail "not on the main branch"
git fetch -q --tags origin
git merge-base --is-ancestor origin/main HEAD || fail "main is behind origin/main: pull first"
command -v gh >/dev/null || fail "gh is not installed (see Lectern/Playbooks/Release a version.md)"
gh auth status -h github.com >/dev/null 2>&1 || fail "gh is not signed in: run 'gh auth login'"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
git config user.email | grep -q 'users.noreply.github.com' || fail "this repo's commit email is not the GitHub no-reply address"

LAST="$(git tag -l 'v[0-9]*' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
[ -n "$LAST" ] || LAST="$(node -p "require('./package.json').version")"
NEW="$(node -e 'const [a, b, c] = process.argv[1].split(".").map(Number); console.log(`${a}.${b}.${c + 1}`)' "$LAST")"
git rev-parse -q --verify "refs/tags/v$NEW" >/dev/null && fail "tag v$NEW already exists"
gh release view "v$NEW" --repo "$REPO" >/dev/null 2>&1 && fail "release v$NEW already exists on GitHub"
echo "   last release v$LAST, this release v$NEW ($REPO)"

# A public repo must not get the owner's account name, home folder path, API keys or personal email addresses.
# The pattern is built from this computer, so no personal detail is written in this file.
USER_NAME="$(id -un)"
PATTERN="$HOME|sk-[A-Za-z0-9]{20}|sk-ant-|@gmail\.com"
[ "${#USER_NAME}" -ge 4 ] && PATTERN="$USER_NAME|$PATTERN"
if git ls-files -co --exclude-standard -z -- . ":!scripts/release.sh" | xargs -0 grep -nIE "$PATTERN" 2>/dev/null; then
  fail "the lines above may hold private data; nothing was changed"
fi

echo "== version $NEW"
BACKUP="$(mktemp -d)"
cp package.json package-lock.json README.md "$BACKUP/"
COMMITTED=0
on_exit() {
  local code=$?
  if [ "$COMMITTED" = 0 ]; then
    cp "$BACKUP/package.json" "$BACKUP/package-lock.json" "$BACKUP/README.md" .
    [ "$code" = 0 ] || echo "release: stopped before the commit; package.json, package-lock.json and README.md are back as they were" >&2
  elif [ "$code" != 0 ]; then
    echo "release: committed locally but not finished. To finish by hand:" >&2
    echo "  git push origin main" >&2
    echo "  gh release create v$NEW release/Lectern-$NEW.dmg release/Lectern-$NEW-windows-x64.zip release/SHA256SUMS.txt --title \"Lectern $NEW\" --notes-file \"$NOTES\" --target main" >&2
  fi
}
trap on_exit EXIT
node -e '
  const fs = require("fs");
  const v = process.argv[1];
  for (const f of ["package.json", "package-lock.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    if (j.packages && j.packages[""]) j.packages[""].version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }' "$NEW"
sed -i '' -E "s/Lectern-[0-9]+\.[0-9]+\.[0-9]+(\.dmg|-windows-x64\.zip)/Lectern-$NEW\1/g" README.md

echo "== build: tests, Mac app, DMG, Windows zip, checksums"
env -u OPENAI_API_KEY -u ELECTRON_RUN_AS_NODE bash scripts/make-release.sh
DMG="release/Lectern-$NEW.dmg"
ZIP="release/Lectern-$NEW-windows-x64.zip"
SUMS="release/SHA256SUMS.txt"
[ -s "$DMG" ] && [ -s "$ZIP" ] && [ -s "$SUMS" ] || fail "the build did not produce every file"

echo "== check the Mac app inside the DMG"
MOUNT="$(hdiutil attach -nobrowse -readonly "$DMG" 2>/dev/null | tail -1 | awk -F'\t' '{print $NF}')"
[ -d "$MOUNT/Lectern.app" ] || fail "could not open the DMG"
APP="$MOUNT/Lectern.app"
GOT="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
SIGNED=1; codesign --verify --deep --strict "$APP" 2>/dev/null || SIGNED=0
VOICE=1; [ -d "$APP/Contents/Resources/app.asar.unpacked/native/Lectern Voice.app" ] || VOICE=0
TRY="$(mktemp -d)"
ditto "$APP" "$TRY/Lectern.app"
hdiutil detach "$MOUNT" -quiet || true
[ "$GOT" = "$NEW" ] || fail "the app in the DMG says version $GOT, expected $NEW"
[ "$SIGNED" = 1 ] || fail "the app in the DMG fails 'codesign --verify --deep --strict'"
[ "$VOICE" = 1 ] || fail "the voice helper is missing from the app in the DMG"

echo "== launch a copy once"
env -u ELECTRON_RUN_AS_NODE LECTERN_DATA_DIR="$TRY/data" "$TRY/Lectern.app/Contents/MacOS/Lectern" --user-data-dir="$TRY/profile" >"$TRY/app.log" 2>&1 &
STARTED=0
for _ in $(seq 1 60); do
  PID="$(pgrep -f "user-data-dir=$TRY/profile" | head -1 || true)"
  if [ -n "$PID" ] && lsof -nP -a -p "$PID" -iTCP -sTCP:LISTEN >/dev/null 2>&1; then STARTED=1; break; fi
  sleep 0.5
done
pkill -f "user-data-dir=$TRY/profile" || true
[ "$STARTED" = 1 ] || fail "the built app did not start its local server (log: $TRY/app.log)"
echo "   version $GOT, signed, voice helper present, starts"

if [ "$DRY" = 1 ]; then
  echo "== dry run finished: v$NEW was built and checked in release/; nothing was committed or published"
  exit 0
fi

echo "== commit and push"
git add -A
git status --short | sed 's/^/   /'
if [ -n "$TRAILER" ]; then git commit -q -m "Lectern $NEW" -m "$TRAILER"; else git commit -q -m "Lectern $NEW"; fi
COMMITTED=1
git push -q origin main

echo "== publish v$NEW"
gh release create "v$NEW" "$DMG" "$ZIP" "$SUMS" --repo "$REPO" --title "Lectern $NEW" --notes-file "$NOTES" --target main >/dev/null

echo "== download the published files and check them"
CHECK="$(mktemp -d)"
( cd "$CHECK" && gh release download "v$NEW" --repo "$REPO" && shasum -a 256 -c SHA256SUMS.txt )
URL="$(gh release view "v$NEW" --repo "$REPO" --json url --jq .url)"
echo "Released Lectern $NEW: $URL"
echo "Commit $(git rev-parse --short HEAD) is on origin/main. Downloads: $DMG ($(du -h "$DMG" | cut -f1 | tr -d ' ')), $ZIP ($(du -h "$ZIP" | cut -f1 | tr -d ' '))"
