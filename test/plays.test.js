import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-plays-'));
const { addPlays, playsFor, fromExport, summarise, overlap } = await import('../server/plays.js');

const play = (at, artist, name, extra = {}) => ({ at, uri: `spotify:track:${artist}-${name}`, name, artists: [{ id: null, name: artist }], album: '', ms: 180000, ctx: null, src: 'poll', ...extra });
const T0 = Date.parse('2026-10-05T08:30:00Z'); // a Monday

test('addPlays de-duplicates and persists', async () => {
  assert.equal(addPlays('u1', [play(T0, 'A', 'x'), play(T0 + 1000, 'B', 'y')]), 2);
  assert.equal(addPlays('u1', [play(T0, 'A', 'x'), play(T0 + 2000, 'C', 'z')]), 1);
  assert.equal(playsFor('u1').length, 3);
  const file = fs.readFileSync(path.join(process.env.DATA_DIR, 'plays', 'u1.ndjson'), 'utf8').trim().split('\n');
  assert.equal(file.length, 3);
});

test('fromExport keeps real plays and drops skips, podcasts and junk', () => {
  const rows = fromExport([
    { ts: '2020-01-01T10:00:00Z', ms_played: 200000, master_metadata_track_name: 'Song', master_metadata_album_artist_name: 'Band', spotify_track_uri: 'spotify:track:1' },
    { ts: '2020-01-01T10:05:00Z', ms_played: 5000, master_metadata_track_name: 'Skipped', master_metadata_album_artist_name: 'Band' },
    { ts: '2020-01-01T10:06:00Z', ms_played: 900000, master_metadata_track_name: null, episode_name: 'Podcast' },
    {},
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artists[0].name, 'Band');
  assert.equal(rows[0].src, 'import');
});

test('summarise counts, ranks, buckets by local time and splits out kids plays', () => {
  const rows = [
    play(T0, 'Foo Fighters', 'Everlong'),
    play(T0 + 3600e3, 'Foo Fighters', 'Everlong'),
    play(T0 + 86400e3, 'Muse', 'Hysteria'),
    play(T0 + 2 * 86400e3, 'Kids Band', 'Wheels', { ctx: 'spotify:playlist:k1' }),
  ];
  const kidsCtx = new Set(['spotify:playlist:k1']);
  const s = summarise(rows, { kidsCtx, tz: 'Europe/London' });
  assert.equal(s.plays, 3);
  assert.equal(s.kidsPlays, 1);
  assert.equal(s.topArtists[0].name, 'Foo Fighters');
  assert.equal(s.topTracks[0].plays, 2);
  assert.equal(s.longestStreak, 2);
  assert.equal(s.clock[0][9], 1, 'Monday 08:30 UTC is 09:30 in London (BST)');
  const k = summarise(rows, { kidsCtx, audience: 'kids' });
  assert.equal(k.plays, 1);
  assert.equal(k.topArtists[0].name, 'Kids Band');
});

test('overlap finds artists both people play', () => {
  const a = [play(1, 'Muse', 'a'), play(2, 'Muse', 'b'), play(3, 'Pixies', 'c')];
  const b = [play(1, 'muse', 'a'), play(2, 'Nirvana', 'b')];
  const o = overlap(a, b);
  assert.equal(o.length, 1);
  assert.equal(o[0].a, 2);
  assert.equal(o[0].b, 1);
});
