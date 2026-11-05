import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-auto-'));
const { nextRunAt } = await import('../server/autodeal.js');
const local = (t, tz) => new Date(t).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' });

test('daily runs at 05:00 local, across a DST change', () => {
  const t = nextRunAt('daily', 'Europe/London', Date.parse('2026-03-28T12:00:00Z'));
  assert.equal(local(t, 'Europe/London'), 'Sun 05:00');
  assert.equal(new Date(t).toISOString(), '2026-03-29T04:00:00.000Z');
});

test('weekly runs on Monday', () => {
  const t = nextRunAt('weekly', 'America/New_York', Date.parse('2026-11-05T12:00:00Z'));
  assert.equal(local(t, 'America/New_York'), 'Mon 05:00');
});

test('half-hour time zones work', () => {
  const t = nextRunAt('daily', 'Asia/Kolkata', Date.parse('2026-11-05T12:00:00Z'));
  assert.match(local(t, 'Asia/Kolkata'), /05:00$/);
});

test('always strictly in the future', () => {
  const now = Date.now();
  assert.ok(nextRunAt('daily', 'UTC', now) > now);
});
