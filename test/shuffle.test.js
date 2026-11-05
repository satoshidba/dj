import { test } from 'node:test';
import assert from 'node:assert/strict';
import { properShuffle, separateNeighbours, spreadStats, fisherYates, seededRandom } from '../server/shuffle.js';

let uid = 0;
function make(artistCounts, { albumsPerArtist = 2, feat = {} } = {}) {
  const out = [];
  for (const [artist, count] of Object.entries(artistCounts)) {
    for (let i = 0; i < count; i++) {
      const artists = [{ id: artist, name: artist }];
      if (feat[artist] && i === 0) artists.push({ id: feat[artist], name: feat[artist] });
      out.push({ uri: `spotify:track:${uid++}`, artists, album: { id: `${artist}-al${i % albumsPerArtist}` } });
    }
  }
  return out;
}

const sameMultiset = (a, b) => assert.deepEqual(a.map((t) => t.uri).sort(), b.map((t) => t.uri).sort());

test('keeps every track exactly once', () => {
  const tracks = make({ a: 10, b: 7, c: 3, d: 1, e: 1 });
  sameMultiset(properShuffle(tracks, { rng: seededRandom(1) }), tracks);
});

test('no back-to-back artists when avoidable (many seeds)', () => {
  const tracks = make({ a: 12, b: 9, c: 8, d: 6, e: 5, f: 4, g: 3, h: 2, i: 1, j: 1, k: 1 });
  for (let s = 0; s < 50; s++) {
    const st = spreadStats(properShuffle(tracks, { rng: seededRandom(s) }));
    assert.equal(st.backToBack, 0, `seed ${s}`);
  }
});

test('dominant artist gets near-ideal spacing in a big playlist', () => {
  const counts = { big: 20 };
  for (let i = 0; i < 180; i++) counts[`x${i}`] = 1;
  const tracks = make(counts);
  const out = properShuffle(tracks, { rng: seededRandom(7) });
  const pos = out.map((t, i) => (t.artists[0].id === 'big' ? i : -1)).filter((i) => i >= 0);
  const gaps = pos.slice(1).map((p, i) => p - pos[i]);
  assert.ok(Math.min(...gaps) >= 7, `min gap ${Math.min(...gaps)} (ideal 10)`);
});

test('beats a plain random shuffle by a wide margin', () => {
  const tracks = make({ a: 15, b: 12, c: 10, d: 8, e: 8, f: 6, g: 5, h: 4, i: 3, j: 3, k: 2, l: 2, m: 1, n: 1 });
  let plain = 0, proper = 0;
  for (let s = 0; s < 20; s++) {
    plain += spreadStats(fisherYates(tracks, seededRandom(s))).spread;
    proper += spreadStats(properShuffle(tracks, { rng: seededRandom(s) })).spread;
  }
  assert.ok(proper / 20 > plain / 20 + 30, `proper ${proper / 20} vs plain ${plain / 20}`);
});

test('featured artists count as the same artist', () => {
  const tracks = make({ a: 5, b: 5, c: 5, d: 5 }, { feat: { a: 'b', c: 'd' } });
  for (let s = 0; s < 20; s++) {
    assert.equal(spreadStats(properShuffle(tracks, { rng: seededRandom(s) })).backToBack, 0);
  }
});

test('degrades gracefully when one artist is most of the playlist', () => {
  const tracks = make({ a: 8, b: 2 });
  const out = properShuffle(tracks, { rng: seededRandom(3) });
  sameMultiset(out, tracks);
  // 8 of 10 can't avoid adjacency, but the 2 others must split the run.
  const st = spreadStats(out);
  assert.ok(st.backToBack <= 6, `backToBack ${st.backToBack}`);
});

test('separateNeighbours keeps the arc roughly in place', () => {
  const tracks = make({ a: 3, b: 3, c: 3, d: 3, e: 3 });
  const clumped = [...tracks]; // a a a b b b ...
  const out = separateNeighbours(clumped, { maxMove: 4 });
  sameMultiset(out, tracks);
  assert.equal(spreadStats(out).backToBack, 0);
  out.forEach((t, i) => assert.ok(Math.abs(clumped.indexOf(t) - i) <= 8));
});

test('separateNeighbours leaves an already-fine order untouched', () => {
  const tracks = make({ a: 1, b: 1, c: 1, d: 1 });
  const order = [tracks[0], tracks[1], tracks[2], tracks[3]];
  // a, b, a-like? no: all different, plus a distance-2 repeat which is allowed
  const withRepeat = [...order, make({ a: 1 })[0]].map((t) => t);
  withRepeat[4].artists = order[2].artists;
  assert.deepEqual(separateNeighbours(withRepeat), withRepeat);
});

test('dealing again does not get noticeably worse', () => {
  const tracks = make({ a: 13, b: 9, c: 8, d: 7, e: 6, f: 6, g: 5, h: 4, i: 4, j: 3, k: 3, l: 2, m: 2, n: 1, o: 1, p: 1, q: 1, r: 1 });
  const scores = Array.from({ length: 15 }, (_, s) => spreadStats(properShuffle(tracks, { rng: seededRandom(100 + s) })).spread);
  assert.ok(Math.min(...scores) >= 80, `scores ${scores}`);
});

test('handles tiny and empty inputs', () => {
  assert.deepEqual(properShuffle([]), []);
  const one = make({ a: 1 });
  assert.deepEqual(properShuffle(one), one);
});

test('scales to a 10k-track playlist quickly', () => {
  const counts = {};
  for (let i = 0; i < 1500; i++) counts[`ar${i}`] = 1 + (i % 13);
  const tracks = make(counts);
  const t0 = performance.now();
  const out = properShuffle(tracks, { rng: seededRandom(9) });
  const ms = performance.now() - t0;
  sameMultiset(out, tracks);
  assert.equal(spreadStats(out).backToBack, 0);
  assert.ok(ms < 5000, `${ms}ms`);
});

test('fresh deal moves heavily played tracks later without breaking spacing', () => {
  const tracks = make({ a: 10, b: 9, c: 8, d: 7, e: 6, f: 6, g: 5, h: 5, i: 4, j: 4, k: 3, l: 3, m: 2, n: 2, o: 1, p: 1 });
  const tired = new Set(tracks.filter((_, i) => i % 4 === 0).map((t) => t.uri)); // a quarter are "hammered"
  const staleness = (t) => (tired.has(t.uri) ? 0.9 : 0);
  let firstQuarterTired = 0, plainFirstQuarterTired = 0;
  for (let s = 0; s < 10; s++) {
    const out = properShuffle(tracks, { rng: seededRandom(s), staleness });
    assert.equal(spreadStats(out).backToBack, 0, `seed ${s}`);
    sameMultiset(out, tracks);
    firstQuarterTired += out.slice(0, out.length / 4).filter((t) => tired.has(t.uri)).length;
    plainFirstQuarterTired += properShuffle(tracks, { rng: seededRandom(s) }).slice(0, out.length / 4).filter((t) => tired.has(t.uri)).length;
  }
  assert.ok(firstQuarterTired < plainFirstQuarterTired * 0.4, `fresh ${firstQuarterTired} vs plain ${plainFirstQuarterTired}`);
});

test('fresh deals still differ each time', () => {
  const tracks = make({ a: 6, b: 6, c: 6, d: 6, e: 6 });
  const staleness = (t) => (Number(t.uri.split(':').pop()) % 3 === 0 ? 0.8 : 0);
  const a = properShuffle(tracks, { rng: seededRandom(1), staleness }).map((t) => t.uri).join();
  const b = properShuffle(tracks, { rng: seededRandom(2), staleness }).map((t) => t.uri).join();
  assert.notEqual(a, b);
});

test('fitToDuration lands within a minute and keeps the ends', async () => {
  process.env.DATA_DIR ??= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'dj-fit-'));
  const { fitToDuration } = await import('../server/curator.js');
  const rng = seededRandom(4);
  const mk = (n, p) => Array.from({ length: n }, (_, i) => ({ uri: `${p}${i}`, durationMs: 150_000 + Math.floor(rng() * 150_000) }));
  for (const target of [20, 45, 63, 135]) {
    const tracks = mk(Math.round(target / 3.6), 't');
    const pool = mk(20, 'p');
    const out = fitToDuration(tracks, pool, target * 60_000);
    const total = out.reduce((s, t) => s + t.durationMs, 0);
    assert.ok(Math.abs(total - target * 60_000) <= 60_000, `${target} min → ${(total / 60000).toFixed(1)}`);
    assert.equal(out[0], tracks[0]);
    assert.equal(out.at(-1), tracks.at(-1));
  }
});
