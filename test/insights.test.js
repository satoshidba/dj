import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rediscover, blend, wrapped, wrappedPeriods } from '../server/insights.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const play = (daysAgo, artist, name, extra = {}) => ({ at: NOW - daysAgo * DAY, uri: `spotify:track:${artist}-${name}`, name, artists: [{ id: null, name: artist }], album: '', ms: 200000, ctx: null, ...extra });
const sorted = (rows) => rows.sort((a, b) => a.at - b.at);

test('forgotten favourites: played a lot, then not for 6+ months', () => {
  const rows = sorted([
    ...Array.from({ length: 12 }, (_, i) => play(400 + i, 'Old Band', 'Anthem')),
    ...Array.from({ length: 12 }, (_, i) => play(10 + i, 'New Band', 'Current')),
    ...Array.from({ length: 2 }, (_, i) => play(500 + i, 'Rare', 'Once')),
  ]);
  const f = rediscover(rows, { now: NOW }).find((s) => s.id === 'forgotten');
  assert.equal(f.needs, null);
  assert.deepEqual(f.tracks.map((t) => t.name), ['Anthem']);
});

test('this week, years ago picks plays near today in earlier years', () => {
  const rows = sorted([play(365, 'A', 'Last year this week'), play(366, 'A', 'Last year this week'), play(365 + 60, 'B', 'Wrong time')]);
  const tw = rediscover(rows, { now: NOW }).find((s) => s.id === 'thisweek');
  assert.deepEqual(tw.tracks.map((t) => t.name), ['Last year this week']);
});

test('year sets cover full past years only', () => {
  const rows = sorted(Array.from({ length: 40 }, (_, i) => [play(400 + i, `Ar${i % 12}`, `S${i % 12}`), play(5, 'Now', 'Now')]).flat());
  const ids = rediscover(rows, { now: NOW }).map((s) => s.id);
  assert.ok(ids.includes('year-2025'));
  assert.ok(!ids.includes('year-2026'));
});

test('blend is balanced and leads with what you both play', () => {
  const a = sorted([...Array.from({ length: 30 }, (_, i) => play(i, `A${i}`, `a${i}`)), play(1, 'Shared', 'Both'), play(2, 'Shared', 'Both')]);
  const b = sorted([...Array.from({ length: 30 }, (_, i) => play(i, `B${i}`, `b${i}`)), play(1, 'Shared', 'Both')]);
  const r = blend(a, b, { now: NOW, size: 21 });
  assert.equal(r.tracks.length, 21);
  assert.equal(r.tracks[0].name, 'Both');
  assert.equal(r.tracks[0].who, 'both');
  assert.ok(Math.abs(r.counts.a - r.counts.b) <= 1, JSON.stringify(r.counts));
});

test('wrapped: numbers, top picks, new artists and a personality', () => {
  const rows = sorted([
    play(400, 'Veteran', 'old'),
    ...Array.from({ length: 30 }, (_, i) => play(10 + (i % 20), 'Veteran', `v${i % 3}`, { at: Date.parse(`2026-10-${String(1 + (i % 28)).padStart(2, '0')}T23:30:00Z`) })),
    ...Array.from({ length: 10 }, (_, i) => play(0, 'Newcomer', 'fresh', { at: Date.parse(`2026-10-${String(1 + i).padStart(2, '0')}T08:00:00Z`) })),
  ]);
  const w = wrapped(rows, '2026-10', 'UTC');
  assert.equal(w.plays, 40);
  assert.equal(w.topArtist.name, 'Veteran');
  assert.equal(w.topArtist.share, 75);
  assert.deepEqual(w.newArtists, ['Newcomer']);
  assert.equal(w.label, 'October 2026');
  assert.ok(w.personality.name);
  assert.ok(wrappedPeriods(rows).months.includes('2026-10'));
  assert.equal(wrapped(rows, '2019', 'UTC'), null);
});

test('blend and rediscover treat the same song with two Spotify IDs as one', () => {
  const a = sorted([play(1, 'Foo Fighters', 'Everlong'), play(2, 'Foo Fighters', 'Everlong', { uri: 'spotify:track:other-id' }), play(3, 'Muse', 'Hysteria')]);
  const b = sorted([play(1, 'Pixies', 'Debaser')]);
  const r = blend(a, b, { now: NOW, size: 10 });
  assert.equal(r.tracks.filter((t) => t.name === 'Everlong').length, 1);
});
