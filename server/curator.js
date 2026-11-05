// The AI side: turn a brief ("5:00/km run, rock") plus someone's listening
// history into a real, playable Spotify tracklist.
//
// Flow: taste profile (top artists/tracks + recent plays) → Claude writes a
// tracklist with structured output → each suggestion is matched against
// Spotify search → misses are filled from Claude's alternates → the order is
// nudged so no artist plays back to back.
import Anthropic from '@anthropic-ai/sdk';
import { separateNeighbours } from './shuffle.js';
import { simplifyTrack } from './spotify.js';
import { playsFor, summarise } from './plays.js';
import { store } from './store.js';

export const kidsContexts = (userId) => new Set(store.kidsPlaylists(userId).map((p) => `spotify:playlist:${p.id}`));

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
let client = null;
export const aiEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const anthropic = () => (client ??= new Anthropic());

// ---------------------------------------------------------------- taste ----

const tasteCache = new Map(); // userId -> { at, profile }
const TASTE_TTL = 30 * 60 * 1000;

export async function tasteProfile(userId, sp) {
  const hit = tasteCache.get(userId);
  if (hit && Date.now() - hit.at < TASTE_TTL) return hit.profile;

  const settle = (p) => p.catch(() => []);
  const [aShort, aMed, aLong, tShort, tMed, recent] = await Promise.all([
    settle(sp.topArtists('short_term', 25)),
    settle(sp.topArtists('medium_term', 30)),
    settle(sp.topArtists('long_term', 30)),
    settle(sp.topTracks('short_term', 30)),
    settle(sp.topTracks('medium_term', 30)),
    settle(sp.recentlyPlayed()),
  ]);

  const artist = (a) => ({ name: a.name, genres: (a.genres ?? []).slice(0, 3), image: a.images?.at(-1)?.url ?? null });
  const track = (t) => `${(t.artists ?? []).map((a) => a.name).join(', ')} — ${t.name}`;
  const uniq = (xs) => [...new Set(xs)];

  const profile = {
    artistsNow: aShort.map(artist),
    artistsSixMonths: aMed.map(artist),
    artistsAllTime: aLong.map(artist),
    tracksNow: uniq(tShort.map(track)),
    tracksSixMonths: uniq(tMed.map(track)),
    recentlyPlayed: uniq(recent.map((r) => track(r.track))).slice(0, 40),
  };
  const genreCounts = new Map();
  for (const a of [...aShort, ...aMed, ...aLong]) for (const g of a.genres ?? []) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
  profile.topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g]) => g);
  // dj's own log is longer than Spotify's 50-play window; kids' plays are kept out.
  const rows = playsFor(userId);
  const kidsCtx = kidsContexts(userId);
  const ninety = summarise(rows, { from: Date.now() - 90 * 86_400_000, kidsCtx });
  const ever = summarise(rows, { kidsCtx });
  profile.logged = {
    since: rows[0]?.at ?? null,
    plays: ever.plays,
    artists90: ninety.topArtists.map((a) => `${a.name} (${a.plays})`),
    tracks90: ninety.topTracks.map((t) => `${t.artist} — ${t.name} (${t.plays})`),
    artistsEver: ever.topArtists.map((a) => `${a.name} (${a.plays})`),
  };
  profile.isEmpty = !aMed.length && !aLong.length && !tMed.length && !recent.length && !ever.plays;

  tasteCache.set(userId, { at: Date.now(), profile });
  return profile;
}

function describeTaste(p) {
  if (p.isEmpty) return 'No listening history is available for this person yet. Lean on the brief alone.';
  const names = (xs) => xs.map((a) => (a.genres.length ? `${a.name} (${a.genres.join(', ')})` : a.name)).join('; ');
  return [
    p.topGenres.length && `Recurring genres: ${p.topGenres.join(', ')}`,
    p.artistsNow.length && `Top artists, last 4 weeks: ${names(p.artistsNow)}`,
    p.artistsSixMonths.length && `Top artists, last 6 months: ${names(p.artistsSixMonths)}`,
    p.artistsAllTime.length && `Top artists, all time: ${names(p.artistsAllTime)}`,
    p.tracksNow.length && `Top tracks, last 4 weeks:\n${p.tracksNow.join('\n')}`,
    p.tracksSixMonths.length && `Top tracks, last 6 months:\n${p.tracksSixMonths.join('\n')}`,
    p.recentlyPlayed.length && `Recently played:\n${p.recentlyPlayed.join('\n')}`,
    p.logged?.plays > 0 && `From their own play log (${p.logged.plays} plays since ${new Date(p.logged.since).toDateString()}), with play counts:`,
    p.logged?.artists90.length && `Most played artists, last 90 days: ${p.logged.artists90.join('; ')}`,
    p.logged?.tracks90.length && `Most played tracks, last 90 days:\n${p.logged.tracks90.join('\n')}`,
    p.logged?.artistsEver.length && `Most played artists, whole log: ${p.logged.artistsEver.join('; ')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// --------------------------------------------------------------- claude ----

const SYSTEM = `You are a music curator building a playlist for one specific person. You get their brief and a summary of their Spotify listening history.

What makes a good result:
- It fits the brief first. If the brief implies a physical activity or pace, work out a sensible tempo target (for running, think about stride cadence, and remember half-time feels work too) and pick tracks that sit in that range. Put your reasoning in one short line in tempo_target. For non-activity briefs, set tempo_target to an empty string.
- It sounds like them. Use the history to infer taste: eras, sub-genres, how mainstream or deep their listening goes. The familiarity setting says what share of tracks should be songs or artists they already know versus discoveries close to their taste.
- It has a shape. Order the tracks deliberately (e.g. warm-up, sustained middle, cool-down for a run; a steady, low-distraction flow for focus).
- No artist appears more than twice unless the brief asks for it, and never twice in a row.
- Every track must be a real, released recording that is very likely on Spotify. Give the title and primary artist exactly as Spotify lists them; prefer the original studio version. For classical music, give the performer or ensemble of a well-known recording as the artist where you can, and the work title in the form Spotify uses (e.g. "Goldberg Variations, BWV 988: Aria"). Never invent tracks.
- est_bpm is your best estimate of the tempo, or 0 if you genuinely have no idea. Spotify no longer exposes tempo data, so this is shown to the person as an estimate.
- why is one short, specific line (under 12 words) the person will read next to the track. No filler.

Also return alternates: extra tracks that fit just as well, used to fill gaps if a main pick can't be found on Spotify.
The title should be short and specific, not generic; the description one sentence.`;

const KIDS_SYSTEM = `${SYSTEM}

This playlist is for children, often in the car or at home with grown-ups in earshot.
- Everything must be suitable for the youngest child listed: no explicit lyrics, no sexual content, no drug or violence themes, nothing scary for little ones. When a song has a clean edit, that's fine, but prefer songs that are clean as written.
- Fit their ages: very young children like simple, singable, repetitive songs and familiar characters; older kids like current pop, film and TV soundtracks, and songs their friends know.
- Use their favourites and avoid anything the grown-ups listed under "avoid".
- The grown-up tolerance setting says how much the grown-ups need to enjoy it too: high means lean on songs that work for everyone (classic singalongs, upbeat pop, soundtracks with real songwriting) rather than nursery tracks.
- The listening history provided is what the kids have actually played in Kids mode; lean on it the way you'd lean on a grown-up's history. "known" means it appears there.
- For calm or bedtime briefs, keep tempo and energy low and steady all the way through.`;

const TRACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['artist', 'title', 'est_bpm', 'why', 'known'],
  properties: {
    artist: { type: 'string' },
    title: { type: 'string' },
    est_bpm: { type: 'integer' },
    why: { type: 'string' },
    known: { type: 'boolean', description: 'true if this track or artist appears in their history' },
  },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'tempo_target', 'tracks', 'alternates'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    tempo_target: { type: 'string' },
    tracks: { type: 'array', items: TRACK_SCHEMA },
    alternates: { type: 'array', items: TRACK_SCHEMA },
  },
};

async function askClaude({ brief, length, familiarity, taste, kids, minutes }) {
  const familiarPct = Math.round(familiarity * 100);
  const kidsBlock = kids
    ? `For: ${kids.profiles.map((k) => `${k.name || 'a child'}, age ${k.age || 'unknown'}${k.likes ? `; loves ${k.likes}` : ''}${k.avoid ? `; avoid ${k.avoid}` : ''}`).join(' | ') || 'children (ages not given)'}
Grown-up tolerance: ${Math.round(kids.tolerance * 100)}% (0 = purely for the kids, 100 = must work for the grown-ups too).

`
    : '';
  const user = `${kidsBlock}Brief: ${brief}

${minutes ? `Running time: it must last about ${minutes} minutes in total. Give roughly ${length} tracks in "tracks" (typical song lengths), plus ${Math.max(10, Math.ceil(length * 0.5))} alternates of varied lengths; the app trims or tops up the middle to hit the time, so keep the opening and closing tracks the ones you most want there.` : `Length: ${length} tracks in "tracks", plus ${Math.max(6, Math.ceil(length * 0.4))} alternates.`}
Familiarity: about ${familiarPct}% familiar, ${100 - familiarPct}% discovery.

${kids ? 'What the kids have been playing' : 'Their listening history'}:
${kids ? kids.history : describeTaste(taste)}`;

  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: kids ? KIDS_SYSTEM : SYSTEM,
    messages: [{ role: 'user', content: user }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') throw new Error("The curator declined that brief. Try wording it differently.");
  if (msg.stop_reason === 'max_tokens') throw new Error('The curator ran out of room. Try a shorter playlist.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The curator returned something unreadable. Try again.');
  }
}

// ------------------------------------------------------------- matching ----

const clean = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/i, '')
    .replace(/\((?:feat|ft|with)[^)]*\)|\[[^\]]*\]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function tokenOverlap(a, b) {
  const A = new Set(clean(a).split(' ').filter(Boolean));
  const B = new Set(clean(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

function score(candidate, want) {
  const title = clean(candidate.name) === clean(want.title) ? 1 : tokenOverlap(candidate.name, want.title);
  const artist = Math.max(
    0,
    ...candidate.artists.map((a) => (clean(a.name) === clean(want.artist) ? 1 : tokenOverlap(a.name, want.artist))),
  );
  return title * 0.6 + artist * 0.4;
}

export async function resolve(sp, want, { clean = false } = {}) {
  const strip = (s) => s.replace(/"/g, '');
  const queries = [`track:"${strip(want.title)}" artist:"${strip(want.artist)}"`, `${want.title} ${want.artist}`];
  let best = null;
  for (const q of queries) {
    const results = (await sp.search(q, 10).catch(() => []))
      .map((t) => simplifyTrack(t))
      .filter((t) => t && !(clean && t.explicit));
    for (const c of results) {
      const s = score(c, want);
      if (!best || s > best.s) best = { s, c };
    }
    if (best && best.s >= 0.85) break;
  }
  return best && best.s >= 0.6 ? best.c : null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ----------------------------------------------------------------- main ----

/**
 * Build a playlist. `progress(event)` receives stage updates for the UI.
 * Returns { title, description, tempoTarget, tracks: [...], missing: [...] }.
 */
export async function curate({ userId, sp, brief, length, familiarity, kids = null, minutes = null }, progress = () => {}) {
  if (minutes) length = Math.min(80, Math.max(6, Math.round(minutes / 3.6)));
  progress({ stage: 'taste' });
  let taste = null;
  if (kids) {
    const s = summarise(playsFor(userId), { kidsCtx: kidsContexts(userId), audience: 'kids' });
    kids.history = s.plays
      ? `Most played in Kids mode:\n${s.topTracks.map((t) => `${t.artist} — ${t.name} (${t.plays})`).join('\n')}`
      : 'Nothing yet: this is their first Kids mode playlist. Go by the profiles.';
  } else {
    taste = await tasteProfile(userId, sp);
  }

  progress({ stage: 'curating' });
  const plan = await askClaude({ brief, length, familiarity, taste, kids, minutes });
  const clean = !!kids;

  const picks = plan.tracks.slice(0, length);
  const alternates = plan.alternates ?? [];
  const total = picks.length + alternates.length;
  let done = 0;
  progress({ stage: 'matching', done, total });
  const tick = () => progress({ stage: 'matching', done: ++done, total });

  const seen = new Set();
  const accept = (track, want) => {
    if (!track || seen.has(track.uri)) return null;
    seen.add(track.uri);
    return { ...track, why: want.why, estBpm: want.est_bpm || null, known: !!want.known };
  };

  const resolvedPicks = await mapLimit(picks, 4, async (w) => {
    const r = await resolve(sp, w, { clean });
    tick();
    return { want: w, track: r };
  });
  const resolvedAlts = await mapLimit(alternates, 4, async (w) => {
    const r = await resolve(sp, w, { clean });
    tick();
    return { want: w, track: r };
  });

  // Keep the curated order; fill each miss with the next usable alternate.
  const altQueue = resolvedAlts.filter((a) => a.track);
  const missing = [];
  const tracks = [];
  for (const { want, track } of resolvedPicks) {
    let got = accept(track, want);
    if (!got) {
      if (!track) missing.push(`${want.artist} — ${want.title}`);
      while (!got && altQueue.length) {
        const alt = altQueue.shift();
        got = accept(alt.track, alt.want);
      }
    }
    if (got) tracks.push(got);
  }

  let fitted = tracks;
  if (minutes) {
    const spare = altQueue.map((a) => accept(a.track, a.want)).filter(Boolean);
    fitted = fitToDuration(tracks, spare, minutes * 60_000);
  }

  return {
    title: plan.title,
    description: plan.description,
    tempoTarget: plan.tempo_target || '',
    tracks: separateNeighbours(fitted, { maxMove: 3 }),
    missing,
    targetMinutes: minutes || null,
  };
}

/**
 * Make an ordered tracklist last `targetMs` (± about 45 s) by removing,
 * adding or swapping songs in the middle, so the opening and the ending the
 * curator chose stay put.
 */
export function fitToDuration(tracks, pool, targetMs, tol = 45_000) {
  const list = tracks.slice();
  const spare = pool.slice();
  const total = () => list.reduce((s, t) => s + (t.durationMs || 0), 0);
  const middle = () => {
    const n = list.length;
    const a = Math.min(n - 1, Math.floor(n * 0.2));
    const b = Math.max(a + 1, Math.ceil(n * 0.8));
    return Array.from({ length: b - a }, (_, i) => a + i);
  };
  const closest = (items, want, dur) => items.reduce((best, x) => (!best || Math.abs(want - dur(x)) < Math.abs(want - dur(best)) ? x : best), null);

  while (total() > targetMs + tol && list.length > 2) {
    const over = total() - targetMs;
    const i = closest(middle(), over, (k) => list[k].durationMs);
    spare.push(list.splice(i, 1)[0]);
  }
  while (total() < targetMs - tol && spare.length) {
    const under = targetMs - total();
    const t = closest(spare, under, (x) => x.durationMs);
    spare.splice(spare.indexOf(t), 1);
    list.splice(Math.floor(list.length * 0.7), 0, t);
  }
  // Fine-tune with single swaps between the middle and the spares.
  for (let pass = 0; pass < 4; pass++) {
    const gap = targetMs - total();
    if (Math.abs(gap) <= 15_000) break;
    let best = null;
    for (const i of middle()) {
      for (const t of spare) {
        const err = Math.abs(gap - (t.durationMs - list[i].durationMs));
        if (err < Math.abs(gap) && (!best || err < best.err)) best = { i, t, err };
      }
    }
    if (!best) break;
    spare.splice(spare.indexOf(best.t), 1, list[best.i]);
    list[best.i] = best.t;
  }
  return list;
}
