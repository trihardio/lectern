'use strict';
// Windows: finding claude.exe / codex.cmd on a ';'-separated PATH, and starting an npm .cmd script
// through node directly (cmd.exe would mangle a long prompt passed as an argument).
// Run on any OS: the platform switch is simulated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../server/llm/cli');

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-win-'));
  const write = (rel, text, exec) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    if (exec) fs.chmodSync(f, 0o755);
    return f;
  };
  // the shape npm's cmd-shim writes
  write('npm/codex.cmd', '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
    + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n'
    + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n', true);
  write('npm/node_modules/@openai/codex/bin/codex.js', '// codex');
  write('npm/node.exe', '', true);
  write('npm/odd.cmd', '@echo off\r\nsomething-else.exe %*\r\n', true);
  write('native/claude.exe', '', true);
  return dir;
}

test('Windows: tools are found on a ";" PATH, .exe before .cmd, and an npm .cmd runs through node', async (t) => {
  const dir = tree();
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; cli._setPlatformForTest(process.platform === 'win32'); fs.rmSync(dir, { recursive: true, force: true }); });
  cli._setPlatformForTest(true);
  process.env.PATH = [path.join(dir, 'native'), path.join(dir, 'npm')].join(';');

  assert.equal(await cli.findBin('claude'), path.join(dir, 'native', 'claude.exe'));
  const codex = await cli.findBin('codex');
  assert.equal(codex, path.join(dir, 'npm', 'codex.cmd'));

  const prompt = 'Line one\n"quoted" & 100% <sure>';
  const how = await cli.launch(codex, ['exec', '--json', '-c', 'model_reasoning_effort="high"', prompt]);
  assert.equal(how.shell, false, 'never through cmd.exe');
  assert.equal(how.file, path.join(dir, 'npm', 'node.exe'), 'the node.exe beside the script');
  assert.deepEqual(how.args, [path.join(dir, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'exec', '--json', '-c', 'model_reasoning_effort="high"', prompt]);

  const exe = await cli.launch(path.join(dir, 'native', 'claude.exe'), ['-p', prompt]);
  assert.deepEqual(exe, { file: path.join(dir, 'native', 'claude.exe'), args: ['-p', prompt], shell: false });

  // a .cmd that is not an npm script: plain arguments may go through cmd.exe, a prompt may not
  const odd = path.join(dir, 'npm', 'odd.cmd');
  assert.equal((await cli.launch(odd, ['auth', 'status'])).shell, true);
  await assert.rejects(cli.launch(odd, ['-p', prompt]), /Could not start odd\.cmd/);
});

test('macOS and Linux: launch is unchanged and PATH stays ":"-separated', async (t) => {
  cli._setPlatformForTest(false);
  t.after(() => cli._setPlatformForTest(process.platform === 'win32'));
  assert.deepEqual(await cli.launch('/usr/local/bin/claude', ['-p']), { file: '/usr/local/bin/claude', args: ['-p'], shell: false });
  assert.ok(!(await cli.shellPath()).includes(';'));
});
