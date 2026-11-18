'use strict';
// Fetch Beemo (toloka/beemo, MIT card) through the public Hugging Face rows service, politely and cached.
//   node bench/review/fetch-beemo.js      downloads 22 pages (2,187 rows) and checks the dataset's revision
const fs = require('fs');
const { get, cacheFile } = require('./hf');

const REVISION = '9c014107fe9b85c4c784c1ce3a43b0b7b0a6d162'; // commit seen on 2026-11-18, last modified 2025-01-28
const url = (off) => `https://datasets-server.huggingface.co/rows?dataset=toloka/beemo&config=default&split=train&offset=${off}&length=100`;

/** Rows of one cached page (synchronous, for build.js). */
function pageRows(off) {
  const f = cacheFile(url(off));
  if (!fs.existsSync(f)) throw new Error('Beemo is not downloaded yet: run node bench/review/fetch-beemo.js');
  return JSON.parse(fs.readFileSync(f, 'utf8')).rows.map((r) => r.row);
}

async function main() {
  const info = await get('https://huggingface.co/api/datasets/toloka/beemo');
  if (info.sha !== REVISION) console.warn(`Warning: Beemo is now at revision ${info.sha}, not ${REVISION}. Record the change in the manifest.`);
  console.log(`Beemo revision ${info.sha}, licence ${info.cardData && info.cardData.license}`);
  for (let off = 0; off < 2187; off += 100) { await get(url(off)); process.stdout.write(`\r${Math.min(off + 100, 2187)}/2187`); }
  process.stdout.write('\n');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { pageRows, REVISION };
