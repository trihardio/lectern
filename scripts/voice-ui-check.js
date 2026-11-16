'use strict';
// Run with: node scripts/ui-check.js --steps scripts/voice-ui-check.js --mock --no-ask
const assert = require('node:assert/strict');
module.exports = async ({ ev, send, until, sleep, shot, dark, motion }) => {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.voiceCalls = [];
    window.voiceStatus = { state: 'starting', text: '' };
    window.voiceDelay = 0;
    let voiceID = 0;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = String(args[0]);
      if (url === '/api/state') {
        const response = await originalFetch(...args);
        const data = await response.json();
        data.dictation = localStorage.voiceTest !== 'browser';
        return new Response(JSON.stringify(data), { status: 200 });
      }
      if (url.startsWith('/api/voice')) {
        const body = JSON.parse(args[1]?.body || '{}');
        voiceCalls.push({ url, ...body });
        if (body.action === 'start') {
          const id = 'test-' + ++voiceID;
          await new Promise(r => setTimeout(r, voiceDelay));
          return new Response(JSON.stringify({ ok: true, id, state: 'starting' }));
        }
        return new Response(JSON.stringify({ ok: true, ...voiceStatus }));
      }
      return originalFetch(...args);
    };
    window.recognizers = [];
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      constructor() { recognizers.push(this); }
      start() {}
      abort() { this.aborted = true; this.onend?.(); }
    };
  ` });
  async function reload() {
    await send('Page.reload');
    assert.ok(await until(`document.querySelector('.mic')`));
  }
  const active = () => ev(`return document.querySelector('.mic').classList.contains('on')`);
  const idle = () => ev(`return document.querySelector('.mic').getAttribute('aria-pressed') === 'false'`);
  const click = () => ev(`document.querySelector('.mic').click()`);
  await reload();
  // Pending means cancellable, not recording. Cancellation must survive a late start response.
  await ev(`voiceDelay = 500; document.querySelector('.mic').click()`);
  assert.equal(await active(), false);
  assert.equal(await ev(`return document.querySelector('.mic').getAttribute('aria-busy')`), 'true');
  await click();
  await sleep(650);
  assert.equal(await idle(), true);
  assert.equal(await ev(`return voiceCalls.filter(x => x.action === 'start').length`), 1);
  assert.equal(await ev(`return voiceCalls.filter(x => x.action === 'stop').length`), 1);
  await ev(`voiceDelay = 0; voiceStatus = { state: 'listening', text: '' }`);
  for (let i = 0; i < 3; i++) {
    await click();
    assert.ok(await until(`document.querySelector('.mic.on')`));
    await click();
    assert.equal(await idle(), true);
  }
  // Text replaces a selected phrase and updates the draft/send button.
  await ev(`const box = document.querySelector('.ask'); box.value = 'Before old after'; box.dispatchEvent(new Event('input')); box.setSelectionRange(7,10); voiceStatus = {state:'listening', text:'new words'}; document.querySelector('.mic').click()`);
  assert.ok(await until(`document.querySelector('.ask').value === 'Before new words after'`));
  assert.equal(await ev(`return document.querySelector('.send').disabled`), false);
  await shot('voice-light');
  await dark(true); await shot('voice-dark');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await motion('reduce'); await shot('voice-mobile-reduced');
  assert.equal(await ev(`const r=document.querySelector('.mic').getBoundingClientRect(); return r.width>0 && r.x>=0 && r.right<=390`), true);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`);
  assert.equal(await idle(), true);
  // Error messages reset the control, and late polls cannot replace the next draft.
  await ev(`voiceStatus = {state:'error',error:'Allow the microphone',text:''}; document.querySelector('.mic').click()`);
  assert.ok(await until(`document.querySelector('#toast').textContent.includes('Allow the microphone')`));
  assert.equal(await idle(), true);
  await send('Emulation.clearDeviceMetricsOverride');
  await dark(false); await motion('no-preference');
  // Sending the test draft builds the docked composer without spending plan credits.
  await ev(`document.querySelector('.send').click()`);
  assert.ok(await until(`document.querySelector('.dock .mic') && !document.querySelector('.send.stop')`, 60000));
  await ev(`voiceStatus = { state:'listening',text:'A follow-up question' }; document.querySelector('.mic').click()`);
  assert.ok(await until(`document.querySelector('.dock .ask').value === 'A follow-up question'`));
  await shot('voice-docked');
  await click();
  // Browser sessions start only on onstart, separate transcript segments with spaces,
  // reset after permission errors, and ignore stale callbacks after cancellation.
  await ev(`localStorage.voiceTest = 'browser'`);
  await reload();
  await ev(`const box=document.querySelector('.ask'); box.value=''; box.dispatchEvent(new Event('input')); document.querySelector('.mic').click()`);
  assert.equal(await active(), false);
  await ev(`recognizers[0].onstart()`);
  assert.equal(await active(), true);
  await ev(`recognizers[0].onresult({results:[[{transcript:'First sentence.'}],[{transcript:'Second sentence.'}]]})`);
  assert.equal(await ev(`return document.querySelector('.ask').value`), 'First sentence. Second sentence.');
  await click();
  await ev(`recognizers[0].onresult({results:[[{transcript:'Should be ignored'}]]}); recognizers[0].onstart()`);
  assert.equal(await idle(), true);
  assert.equal(await ev(`return document.querySelector('.ask').value`), 'First sentence. Second sentence.');
  await click();
  await ev(`recognizers[1].onerror({error:'not-allowed'})`);
  assert.equal(await idle(), true);
  assert.match(await ev(`return document.querySelector('#toast').textContent`), /Allow microphone/);
  console.log('Voice UI: pending/cancel, late responses, repeated sessions, transcripts, selection, errors, Escape, both composers, browser lifecycle and responsive layouts passed.');
};
