'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createUsageMonitor, claudeWindows, codexWindows, readCodexUsage } = require('../server/llm/usage');

test('Claude limits distinguish zero, missing values and over-limit usage', () => {
  const windows = claudeWindows({ five_hour: { utilization: 0, resets_at: '2026-11-15T12:00:00Z' }, seven_day: { utilization: 104 } });
  assert.equal(windows.fiveHour.usedPercent, 0);
  assert.equal(windows.fiveHour.resetsAt, '2026-11-15T12:00:00.000Z');
  assert.equal(windows.weekly.usedPercent, 100);
  assert.equal(windows.weekly.resetsAt, null);
  assert.deepEqual(claudeWindows({ five_hour: { utilization: null }, seven_day: { utilization: '20' } }), { weekly: null, fiveHour: null });
  assert.equal(claudeWindows({ five_hour: { utilization: -3 } }).fiveHour.usedPercent, 0);
});

test('Codex windows use their duration and account-wide bucket, not their order or a model quota', () => {
  const weekly = { usedPercent: 70, windowDurationMins: 10080, resetsAt: 1800000000 };
  const session = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 };
  const windows = codexWindows({ rateLimits: { primary: { ...weekly, usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: weekly, secondary: session } } });
  assert.equal(windows.weekly.usedPercent, 70);
  assert.equal(windows.fiveHour.usedPercent, 25);
  assert.equal(windows.fiveHour.resetsAt, new Date(1800000000000).toISOString());
  assert.deepEqual(codexWindows({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 60 } } }), { weekly: null, fiveHour: null });
  assert.deepEqual(codexWindows({}), { weekly: null, fiveHour: null });
});

test('usage monitor coalesces refreshes, caches results, isolates failures and honors binary changes', async () => {
  let time = 0, reads = 0;
  const find = async (_name, bin) => bin;
  const read = async () => { reads++; await new Promise((r) => setImmediate(r)); return { weekly: { usedPercent: 42 } }; };
  const monitor = createUsageMonitor({ find, now: () => time, readers: { 'claude-code': read, codex: async () => { throw new Error('secret credential'); } } });
  const settings = { bins: { claude: 'fake-claude', codex: 'fake-codex' } };
  const [a, b] = await Promise.all([monitor(settings), monitor(settings)]);
  assert.deepEqual(a, b);
  assert.equal(reads, 1);
  assert.equal(a.providers['claude-code'].weekly.usedPercent, 42);
  assert.equal(a.providers.codex.weekly, null);
  assert.ok(!JSON.stringify(a).includes('secret'));
  await monitor(settings);
  assert.equal(reads, 1);
  time = 120001;
  await monitor(settings);
  assert.equal(reads, 2);
  await monitor({ bins: { claude: 'new-claude', codex: '' } });
  assert.equal(reads, 3);
});

test('Codex app-server reads account limits without starting a model turn', async () => {
  const usage = await readCodexUsage(path.join(__dirname, 'fakes', 'codex'));
  assert.equal(usage.weekly.usedPercent, 44);
  assert.equal(usage.fiveHour.usedPercent, 18);
  assert.equal(usage.stale, false);
  assert.ok(usage.checkedAt);
});

test('Codex failures and hung RPCs terminate without returning made-up percentages', async () => {
  const bin = path.join(__dirname, 'fakes', 'codex');
  process.env.FAKE_SIGNED_OUT = '1';
  try { await assert.rejects(readCodexUsage(bin), /usage is unavailable/); }
  finally { delete process.env.FAKE_SIGNED_OUT; }
  process.env.FAKE_USAGE_HANG = '1';
  try { await assert.rejects(readCodexUsage(bin, { timeout: 100 }), /usage is unavailable/); }
  finally { delete process.env.FAKE_USAGE_HANG; }
});
