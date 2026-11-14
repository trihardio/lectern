'use strict';
// "npm run web": run Lectern without the desktop window and use it in your browser instead.

const { execFile } = require('child_process');
const { createApp } = require('./index');

const PORT = Number(process.env.LECTERN_PORT || 4319);

(async () => {
  const app = createApp();
  let url;
  try {
    url = await app.listen(PORT);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    url = await app.listen(0); // the usual port is taken; use any free one
  }
  console.log(`Lectern is running at ${url}`);
  console.log(`Your settings, conversations and library are kept in: ${app.config.dataDir}`);
  console.log('Press Ctrl+C to stop.');
  if (process.platform === 'darwin' && !process.env.LECTERN_NO_OPEN) execFile('open', [url], () => {});
})().catch((e) => { console.error(e); process.exit(1); });
