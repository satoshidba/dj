// The shuffle. Pure functions, no I/O, so it can be tested and reasoned about.
//
// Goal: an order that *feels* random to a human, which is not the same as one
// that *is* random. A uniform shuffle happily plays three Foo Fighters songs in
// a row; people hear that as "broken". So:
//
//   1. Spread: every artist's tracks are laid out at evenly spaced positions
//      across the whole playlist (n / count apart), from a random start point
//      with a little jitter. Big artists get the widest gaps the length allows.
//      Within an artist, albums are spread the same way.
//   2. Repair: a local search swaps tracks to remove anything still too close,
//      including tracks that share *any* artist (features, collabs), with a
//      penalty that falls off steeply with distance. Same-album neighbours are
//      penalised too, more gently.
//
// Inspired by Martin Fiedler's "balanced shuffle" and Spotify's own 2014 write-up
// of the idea, then pushed further with the repair pass.

/** Mulberry32 — tiny seeded PRNG for reproducible tests. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Stable artist keys for a track: Spotify ids where present, names otherwise. */
export function artistKeys(track) {
  const keys = (track.artists ?? [])
    .map((a) => (a.id ? `id:${a.id}` : a.name ? `n:${norm(a.name)}` : null))
    .filter(Boolean);
  return keys.length ? keys : [`u:${track.uri}`];
}

const albumKey = (t) => (t.album?.id ? `id:${t.album.id}` : t.album?.name ? `n:${norm(t.album.name)}` : null);

export function fisherYates(items, rng = Math.random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Lay items out so each group (by keyFn) is evenly spaced across the length.
 * Returns a new array. `inner` optionally orders the items inside a group.
 */
function spread(items, keyFn, rng, inner) {
  const n = items.length;
  if (n < 2) return items.slice();
  const groups = new Map();
  for (const it of items) {
    const k = keyFn(it) ?? `solo:${groups.size}:${Math.random()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const placed = [];
  for (const group of groups.values()) {
    const ordered = inner ? inner(group) : fisherYates(group, rng);
    const k = ordered.length;
    const step = n / k;
    const offset = rng() * step;
    ordered.forEach((it, i) => {
      const jitter = (rng() - 0.5) * step * 0.2;
      placed.push({ it, pos: offset + i * step + jitter, tie: rng() });
    });
  }
  placed.sort((a, b) => a.pos - b.pos || a.tie - b.tie);
  return placed.map((p) => p.it);
}

// Penalty for two tracks d apart that share an artist / an album.
const WINDOW = 10;
const ARTIST_PENALTY = Array.from({ length: WINDOW + 1 }, (_, d) => (d === 0 ? 0 : 1000 / d ** 3));
const ALBUM_PENALTY = [0, 40, 6, 1];

function prepare(tracks) {
  return tracks.map((t) => ({ t, artists: new Set(artistKeys(t)), album: albumKey(t) }));
}

function shares(a, b) {
  if (a.artists.size > b.artists.size) [a, b] = [b, a];
  for (const k of a.artists) if (b.artists.has(k)) return true;
  return false;
}

function pairPenalty(a, b, d) {
  let p = 0;
  if (d <= WINDOW && shares(a, b)) p += ARTIST_PENALTY[d];
  if (d < ALBUM_PENALTY.length && a.album && a.album === b.album) p += ALBUM_PENALTY[d];
  return p;
}

/** Penalty attributable to position i (all pairs within the window). */
function localCost(arr, i) {
  let c = 0;
  const lo = Math.max(0, i - WINDOW);
  const hi = Math.min(arr.length - 1, i + WINDOW);
  for (let j = lo; j <= hi; j++) if (j !== i) c += pairPenalty(arr[i], arr[j], Math.abs(i - j));
  return c;
}

/**
 * Local search that swaps tracks to lower the total penalty.
 * maxMove limits how far a track may travel (used to keep an AI-curated arc).
 */
function repair(arr, rng, { maxMove = Infinity, passes = 12, tries = 24 } = {}) {
  const n = arr.length;
  if (n < 3) return arr;
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      const ci = localCost(arr, i);
      if (ci < 1) continue;
      let best = null;
      for (let t = 0; t < tries; t++) {
        let j;
        if (Number.isFinite(maxMove)) {
          const lo = Math.max(0, i - maxMove);
          const hi = Math.min(n - 1, i + maxMove);
          j = lo + Math.floor(rng() * (hi - lo + 1));
        } else {
          j = Math.floor(rng() * n);
        }
        if (j === i) continue;
        const before = ci + localCost(arr, j);
        [arr[i], arr[j]] = [arr[j], arr[i]];
        const after = localCost(arr, i) + localCost(arr, j);
        [arr[i], arr[j]] = [arr[j], arr[i]];
        const delta = after - before;
        if (delta < -1e-9 && (!best || delta < best.delta)) best = { j, delta };
      }
      if (best) {
        [arr[i], arr[best.j]] = [arr[best.j], arr[i]];
        improved = true;
      }
    }
    if (!improved) break;
  }
  return arr;
}

function score(order) {
  const st = spreadStats(order);
  return st.backToBack * 1e6 + st.nearRepeats * 1e3 - st.spread;
}

/**
 * The main event. Returns a new array of the same track objects.
 * Deals several candidates and keeps the best spread, so pressing "deal again"
 * never gives a noticeably worse result than last time.
 */
export function properShuffle(tracks, { rng = Math.random, candidates } = {}) {
  if (tracks.length < 2) return tracks.slice();
  const k = candidates ?? (tracks.length <= 500 ? 8 : tracks.length <= 3000 ? 3 : 1);
  const primary = (t) => artistKeys(t)[0];
  let best = null;
  for (let c = 0; c < k; c++) {
    const order = spread(tracks, primary, rng, (group) => spread(group, albumKey, rng));
    const out = repair(prepare(order), rng).map((x) => x.t);
    const s = k > 1 ? score(out) : 0;
    if (!best || s < best.s) best = { s, out };
  }
  return best.out;
}

/**
 * Keep an existing order (e.g. an AI-built energy arc) and only fix tracks
 * that sit right next to the same artist, by swapping in the nearest track
 * (within maxMove places) that doesn't create a new clash.
 */
export function separateNeighbours(tracks, { maxMove = 4 } = {}) {
  const arr = prepare(tracks);
  const n = arr.length;
  const clashAt = (i) => (i > 0 && shares(arr[i], arr[i - 1])) || (i < n - 1 && shares(arr[i], arr[i + 1]));
  for (let i = 1; i < n; i++) {
    if (!shares(arr[i], arr[i - 1])) continue;
    for (let d = 1; d <= maxMove; d++) {
      let fixed = false;
      for (const j of [i + d, i - d]) {
        if (j < 0 || j >= n || j === i - 1) continue;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        if (!clashAt(i) && !clashAt(j)) {
          fixed = true;
          break;
        }
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      if (fixed) break;
    }
  }
  return arr.map((x) => x.t);
}

/**
 * How well spread an order is.
 *   backToBack   — adjacent pairs sharing an artist
 *   nearRepeats  — pairs sharing an artist within 3 tracks of each other
 *   tightestGap  — smallest distance between two tracks by the same artist
 *   spread       — 0–100: how close each repeated artist's tightest gap gets
 *                  to the ideal (n / count), averaged over those artists
 */
export function spreadStats(tracks) {
  const n = tracks.length;
  const prep = prepare(tracks);
  let backToBack = 0;
  let nearRepeats = 0;
  for (let i = 0; i < n; i++) {
    for (let d = 1; d <= 3 && i + d < n; d++) {
      if (shares(prep[i], prep[i + d])) {
        nearRepeats++;
        if (d === 1) backToBack++;
      }
    }
  }
  const positions = new Map();
  prep.forEach((p, i) => {
    for (const k of p.artists) {
      if (!positions.has(k)) positions.set(k, []);
      positions.get(k).push(i);
    }
  });
  let tightestGap = null;
  let scoreSum = 0;
  let scored = 0;
  for (const pos of positions.values()) {
    if (pos.length < 2) continue;
    let min = Infinity;
    for (let i = 1; i < pos.length; i++) min = Math.min(min, pos[i] - pos[i - 1]);
    tightestGap = tightestGap === null ? min : Math.min(tightestGap, min);
    const ideal = Math.max(1, Math.floor(n / pos.length));
    scoreSum += Math.min(1, min / ideal);
    scored++;
  }
  return {
    tracks: n,
    repeatedArtists: scored,
    backToBack,
    nearRepeats,
    tightestGap,
    spread: scored ? Math.round((scoreSum / scored) * 100) : 100,
  };
}
