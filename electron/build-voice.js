'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

async function buildVoice(destination) {
  const source = path.join(__dirname, 'voice');
  const fingerprint = crypto.createHash('sha256').update(process.arch)
    .update(fs.readFileSync(path.join(source, 'main.m')))
    .update(fs.readFileSync(path.join(source, 'Info.plist'))).digest('hex');
  const bundle = path.join(destination, 'Lectern Voice.app');
  const contents = path.join(bundle, 'Contents');
  const binary = path.join(contents, 'MacOS', 'LecternVoice');
  const stamp = path.join(destination, 'voice-build.txt');
  if (fs.existsSync(binary) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint) return bundle;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(path.join(source, 'Info.plist'), path.join(contents, 'Info.plist'));
  try {
    const selected = process.env.SDKROOT || (await run('/usr/bin/xcrun', ['--show-sdk-path'])).stdout.trim();
    // A beta SDK can be newer than the installed linker. Try other installed SDKs
    // only for that toolchain mismatch, without changing the Mac's selected tools.
    const sdkRoot = path.dirname(selected);
    const alternatives = process.env.SDKROOT ? [] : fs.readdirSync(sdkRoot)
      .filter((name) => /^MacOSX\d+\.\d+\.sdk$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((name) => path.join(sdkRoot, name));
    const sdks = [...new Set([selected, ...alternatives])];
    for (let i = 0; i < sdks.length; i++) {
      try {
        await run('/usr/bin/xcrun', ['clang', '-O2', '-fobjc-arc', '-isysroot', sdks[i], '-mmacosx-version-min=13.0', '-framework', 'AppKit', '-framework', 'AVFoundation', '-framework', 'Speech', path.join(source, 'main.m'), '-o', binary], { timeout: 120000 });
        break;
      } catch (e) {
        if (i === sdks.length - 1 || !/unknown architecture|SDK is not supported/.test(e.stderr || '')) throw e;
      }
    }
    await run('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { timeout: 15000 });
  } catch (e) {
    throw new Error('Voice input could not be built. Install the Xcode Command Line Tools, or use a packaged Lectern app. ' + e.message);
  }
  fs.writeFileSync(stamp, fingerprint);
  return bundle;
}
module.exports = { buildVoice };
if (require.main === module) buildVoice(path.resolve(process.argv[2] || 'native')).then(console.log).catch((e) => { console.error(e.message); process.exitCode = 1; });
