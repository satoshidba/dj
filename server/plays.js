// Local play history.
//
// Spotify only ever shows an app your last 50 plays, so dj keeps its own log:
// every POLL_MINUTES it asks each signed-in person's account "what played since
// last time?" and appends the answer here. Older history can be backfilled from
// Spotify's "Extended streaming history" privacy export.
//
// One append-only NDJSON file per person in DATA_DIR/plays, loaded into memory
// at boot (a decade of heavy listening is ~100k rows, a few tens of MB).
import fs from 'node:fs';
import path from 'node:path';
import { store } from './store.js';
import { spotifyFor } from './spotify.js';

const DIR = path.join(process.env.DATA_DIR || path.resolve('data'), 'plays');
const POLL_MINUTES = Math.max(2, Number(process.env.PLAY_POLL_MINUTES || 10));
fs.mkdirSync(DIR, { recursive: true });

const logs = new Map(); // userId -> { rows: Play[], keys: Set<string> }
const fileFor = (userId) => path.join(DIR, `${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.ndjson`);
const keyOf = (p) => `${p.at}|${p.uri ?? p.name}`;

/** @typedef {{at:number, uri:string|null, name:string, artists:{id:string|null,name:string}[], album:string, ms:number, ctx:string|null, src:'poll'|'import', image?:string|null}} Play */

function log(userId) {
  if (logs.has(userId)) return logs.get(userId);
  const rows = [];
  try {
    for (const line of fs.readFileSync(fileFor(userId), 'utf8').split('\n')) {
      if (line) rows.push(JSON.parse(line));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`plays: could not read log for ${userId}`, err.message);
  }
  rows.sort((a, b) => a.at - b.at);
  const entry = { rows, keys: new Set(rows.map(keyOf)) };
  logs.set(userId, entry);
  return entry;
}

/** Append plays, skipping any already logged. Returns how many were new. */
export function addPlays(userId, plays) {
  const l = log(userId);
  const fresh = plays.filter((p) => p && p.at && !l.keys.has(keyOf(p)));
  if (!fresh.length) return 0;
  for (const p of fresh) l.keys.add(keyOf(p));
  fs.appendFileSync(fileFor(userId), fresh.map((p) => JSON.stringify(p)).join('\n') + '\n');
  l.rows.push(...fresh);
  l.rows.sort((a, b) => a.at - b.at);
  return fresh.length;
}

export const playsFor = (userId) => log(userId).rows;

// ----------------------------------------------------------------- polling --

async function pollUser(userId) {
  const user = store.getUser(userId);
  if (!user?.tokens || user.tracking === false) return;
  const sp = spotifyFor(userId);
  const rows = playsFor(userId);
  const lastPolled = [...rows].reverse().find((r) => r.src === 'poll');
  const after = lastPolled ? lastPolled.at : undefined;
  try {
    const items = await sp.recentlyPlayed({ after });
    const plays = items.map((it) => ({
      at: Date.parse(it.played_at),
      uri: it.track?.uri ?? null,
      name: it.track?.name ?? 'Unknown',
      artists: (it.track?.artists ?? []).map((a) => ({ id: a.id ?? null, name: a.name })),
      album: it.track?.album?.name ?? '',
      ms: it.track?.duration_ms ?? 0,
      ctx: it.context?.uri ?? null,
      src: 'poll',
      image: it.track?.album?.images?.at(-1)?.url ?? null,
    }));
    const added = addPlays(userId, plays);
    // A full page after a known point means we may have missed some in between.
    const gap = after && items.length >= 50;
    store.putUser({ id: userId, trackingStatus: { at: Date.now(), ok: true, added, gap: gap || undefined } });
  } catch (err) {
    store.putUser({ id: userId, trackingStatus: { at: Date.now(), ok: false, error: err.message } });
    if (err.status !== 401) console.error(`plays: poll failed for ${userId}:`, err.message);
  }
}

export async function pollAll() {
  for (const u of store.allUsers()) await pollUser(u.id);
}

export function startTracking() {
  pollAll();
  setInterval(pollAll, POLL_MINUTES * 60 * 1000).unref();
  console.log(`plays: tracking every ${POLL_MINUTES} min`);
}

export { pollUser, POLL_MINUTES };

// ------------------------------------------------------------------ import --

/**
 * Convert rows from Spotify's Extended Streaming History export
 * (Streaming_History_Audio_*.json) into plays. Spotify counts a stream after
 * 30 seconds, so shorter ones (skips) are dropped. Podcasts are skipped.
 */
export function fromExport(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const name = r.master_metadata_track_name;
    if (!name || !r.ts || (r.ms_played ?? 0) < 30_000) continue;
    out.push({
      at: Date.parse(r.ts),
      uri: r.spotify_track_uri ?? null,
      name,
      artists: [{ id: null, name: r.master_metadata_album_artist_name ?? 'Unknown' }],
      album: r.master_metadata_album_album_name ?? '',
      ms: r.ms_played,
      ctx: null,
      src: 'import',
    });
  }
  return out;
}

// ------------------------------------------------------------------- stats --

const artistKey = (a) => a.name.trim().toLowerCase();

/**
 * Aggregate plays for display.
 *   kidsCtx — playlist URIs that belong to Kids mode; plays from them are
 *             reported separately and kept out of the grown-up numbers.
 *   tz      — IANA zone for the hour/weekday clock.
 */
export function summarise(rows, { from = 0, to = Infinity, kidsCtx = new Set(), tz = 'UTC', audience = 'grown' } = {}) {
  const inRange = rows.filter((r) => r.at >= from && r.at < to);
  const isKids = (r) => r.ctx && kidsCtx.has(r.ctx);
  const sel = inRange.filter((r) => (audience === 'kids' ? isKids(r) : !isKids(r)));

  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const clock = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const days = new Map();
  const artists = new Map();
  const tracks = new Map();
  let ms = 0;

  for (const r of sel) {
    ms += r.ms || 0;
    const parts = Object.fromEntries(fmt.formatToParts(new Date(r.at)).map((p) => [p.type, p.value]));
    clock[WD[parts.weekday]][Number(parts.hour) % 24]++;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    days.set(day, (days.get(day) ?? 0) + 1);

    const seen = new Set();
    for (const a of r.artists) {
      const k = artistKey(a);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = artists.get(k) ?? { name: a.name, plays: 0, ms: 0 };
      cur.plays++;
      cur.ms += r.ms || 0;
      artists.set(k, cur);
    }
    const tk = r.uri ?? `${r.name}|${r.artists[0]?.name}`;
    const t = tracks.get(tk) ?? { uri: r.uri, name: r.name, artist: r.artists.map((a) => a.name).join(', '), image: r.image ?? null, plays: 0 };
    t.plays++;
    t.image ||= r.image ?? null;
    tracks.set(tk, t);
  }

  // Longest run of consecutive days with at least one play, and the current one.
  const sortedDays = [...days.keys()].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sortedDays) {
    const cur = Date.parse(`${d}T00:00:00Z`);
    run = prev !== null && cur - prev === 86_400_000 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = cur;
  }

  return {
    plays: sel.length,
    ms,
    artistCount: artists.size,
    trackCount: tracks.size,
    longestStreak: best,
    topArtists: [...artists.values()].sort((a, b) => b.plays - a.plays).slice(0, 15),
    topTracks: [...tracks.values()].sort((a, b) => b.plays - a.plays).slice(0, 15),
    clock,
    days: sortedDays.map((d) => ({ day: d, plays: days.get(d) })),
    recent: sel.slice(-30).reverse().map((r) => ({ at: r.at, name: r.name, artist: r.artists.map((a) => a.name).join(', '), image: r.image ?? null, uri: r.uri })),
    kidsPlays: audience === 'kids' ? sel.length : inRange.filter(isKids).length,
  };
}

/** Artists both people play, ranked by the smaller of their two counts. */
export function overlap(a, b, limit = 12) {
  const count = (rows) => {
    const m = new Map();
    for (const r of rows) for (const ar of r.artists) {
      const k = artistKey(ar);
      const cur = m.get(k) ?? { name: ar.name, plays: 0 };
      cur.plays++;
      m.set(k, cur);
    }
    return m;
  };
  const A = count(a);
  const B = count(b);
  const out = [];
  for (const [k, va] of A) {
    const vb = B.get(k);
    if (vb) out.push({ name: va.name, a: va.plays, b: vb.plays, score: Math.min(va.plays, vb.plays) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}
