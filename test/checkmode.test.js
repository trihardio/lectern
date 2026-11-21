'use strict';
// Launch tests must never put a window, Dock icon or dialog on the owner's screen (2026-11-19: the release check's
// visible copy popped up "Lectern could not start"). electron/main.js has a hidden check mode, and release.sh uses it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

test('check mode: no window, no Dock icon, no dialog; the page load is reported and the app quits itself', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  assert.match(main, /const CHECK = process\.env\.LECTERN_CHECK === '1';/);
  assert.match(main, /show: !CHECK,/);
  assert.match(main, /if \(CHECK && process\.platform === 'darwin'\) app\.setActivationPolicy\('accessory'\)/);
  assert.match(main, /did-finish-load', \(\) => \{ console\.log\(`LECTERN_CHECK ok/);
  assert.match(main, /did-fail-load'.*LECTERN_CHECK failed page load/);
  assert.match(main, /if \(CHECK\) \{ console\.log\(`LECTERN_CHECK failed \$\{message\}`\); app\.exit\(1\); return; \}\s*\n\s*dialog\.showErrorBox/);
});

test('the release script launches its test copy hidden and waits for the app to quit by itself', () => {
  const sh = fs.readFileSync(path.join(root, 'scripts', 'release.sh'), 'utf8');
  const block = sh.slice(sh.indexOf('echo "== launch a copy once, hidden"'), sh.indexOf('[ "$STARTED" = 1 ]'));
  assert.ok(block.length > 100);
  assert.match(block, /LECTERN_CHECK=1 /);
  assert.match(block, /grep -q '\^LECTERN_CHECK ok'/);
  assert.doesNotMatch(block, /pkill/, 'no pattern kill: it took the window\'s helpers down mid-load');
});
