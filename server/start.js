'use strict';
// "npm run web": run Lectern without the desktop window and use it in your browser instead.

const { execFile } = require('child_process');
const { createApp } = require('./index');

const PORT = Number(process.env.LECTERN_PORT || 4319);

// Ctrl+C and a plain kill end the process through process.exit, so the 'exit' handler in server/llm/cli.js
// stops any command-line tool that is still writing an answer.
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

(async () => {
  const app = createApp();
  let url;
  try {
    url = await app.listen(PORT);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    url = await app.listen(0); // the usual port is taken; use any free one
  }
  // The address carries this run's access token: only someone who can see this terminal can open the window.
  console.log(`Lectern is running at ${url}`);
  console.log(`Your settings, chats and library are kept in: ${app.config.dataDir}`);
  console.log('Press Ctrl+C to stop.');
  if (process.platform === 'darwin' && !process.env.LECTERN_NO_OPEN) execFile('open', [url], () => {});
})().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
