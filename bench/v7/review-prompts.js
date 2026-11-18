'use strict';
// The review prompts of version 7.
//   B0_SYSTEM  the prompt shipped in version 6, copied unchanged from server/prompts.js into review-b0.txt before any version 7 call.
//   R1_SYSTEM  the one revised prompt, in review-r1.txt (written from the development results only; absent until then).
const fs = require('fs');
const path = require('path');
const read = (f) => { try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch { return null; } };
module.exports = { B0_SYSTEM: read('review-b0.txt'), R1_SYSTEM: read('review-r1.txt') };
