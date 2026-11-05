// Things only a long play log can tell you: Rediscover, the two-person blend,
// and a Wrapped for any month or year. Pure functions over play rows.

const DAY = 86_400_000;
const lower = (s) => String(s ?? '').trim().toLowerCase();
const trackKey = (r) => r.uri ?? `${lower(r.name)}|${lower(r.artists[0]?.name)}`;

/** Per-track aggregate: plays, first/last played, and per-year counts. */
function aggregate(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = trackKey(r);
    let a = m.get(k);
    if (!a) {
      a = { uri: r.uri, name: r.name, artist: r.artists.map((x) => x.name).join(', '), artists: r.artists, album: r.album, image: r.image ?? null, plays: 0, first: r.at, last: r.at, times: [] };
      m.set(k, a);
    }
    a.plays++;
    a.first = Math.min(a.first, r.at);
    a.last = Math.max(a.last, r.at);
    a.image ||= r.image ?? null;
    a.uri ||= r.uri;
    a.times.push(r.at);
  }
  return [...m.values()];
}

const pub = ({ times, artists, ...t }) => t;

/** The same song can have several Spotify IDs (album vs single, re-releases). */
const songKey = (t) => `${lower(t.name).replace(/\s+-\s+.*$|\s*\(.*?\)\s*/g, '')}|${lower(t.artist ?? t.artists?.[0]?.name).split(',')[0]}`;
function dedupeSongs(list) {
  const seen = new Set();
  return list.filter((t) => {
    const k = songKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --------------------------------------------------------------- rediscover --

/**
 * Playlists built from your own past:
 *   forgotten — songs you played a lot, then stopped (nothing in 6 months)
 *   thisweek  — what you played around this date in earlier years
 *   year-YYYY — your most played songs of each full year
 */
export function rediscover(rows, { now = Date.now(), limit = 40 } = {}) {
  const span = rows.length ? now - rows[0].at : 0;
  const tracks = aggregate(rows).filter((t) => t.uri);
  const sets = [];

  const forgotten = dedupeSongs(tracks.filter((t) => t.plays >= 5 && now - t.last > 180 * DAY).sort((a, b) => b.plays - a.plays)).slice(0, limit);
  sets.push({
    id: 'forgotten',
    title: 'Forgotten favourites',
    blurb: 'Songs you played over and over, then haven’t touched in six months or more.',
    tracks: forgotten.map((t) => ({ ...pub(t), note: `${t.plays} plays · last ${new Date(t.last).getFullYear()}` })),
    needs: span < 240 * DAY
      ? 'Needs at least eight months of history. Import your Spotify data to unlock it.'
      : !forgotten.length
        ? 'Nothing has gone quiet yet: every song you’ve played five or more times has had a play in the last six months.'
        : null,
  });

  // ±4 days around today's date, in every earlier year.
  const today = new Date(now);
  const windows = [];
  const firstYear = rows.length ? new Date(rows[0].at).getUTCFullYear() : today.getUTCFullYear();
  for (let y = today.getUTCFullYear() - 1; y >= firstYear; y--) {
    const mid = Date.UTC(y, today.getUTCMonth(), today.getUTCDate());
    windows.push([mid - 4 * DAY, mid + 4 * DAY, y]);
  }
  const twMap = new Map();
  for (const t of tracks) {
    if (now - t.last < 30 * DAY) continue; // skip what you're playing anyway
    for (const at of t.times) {
      const w = windows.find(([a, b]) => at >= a && at <= b);
      if (!w) continue;
      const cur = twMap.get(t) ?? { n: 0, years: new Set() };
      cur.n++;
      cur.years.add(w[2]);
      twMap.set(t, cur);
    }
  }
  const twSeen = new Set();
  const thisWeek = [...twMap.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .filter(([t]) => !twSeen.has(songKey(t)) && twSeen.add(songKey(t)))
    .slice(0, limit);
  sets.push({
    id: 'thisweek',
    title: 'This week, years ago',
    blurb: `What you were playing around ${today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} in earlier years.`,
    tracks: thisWeek.map(([t, v]) => ({ ...pub(t), note: [...v.years].sort().join(', ') })),
    needs: windows.length && thisWeek.length ? null : 'Needs history from this time last year. Import your Spotify data to unlock it.',
  });

  // Full calendar years (the current year is still going).
  const years = new Map();
  for (const t of tracks) {
    for (const at of t.times) {
      const y = new Date(at).getUTCFullYear();
      if (y === today.getUTCFullYear()) continue;
      const ym = years.get(y) ?? new Map();
      ym.set(t, (ym.get(t) ?? 0) + 1);
      years.set(y, ym);
    }
  }
  for (const [y, ym] of [...years.entries()].sort((a, b) => b[0] - a[0])) {
    const ySeen = new Set();
    const top = [...ym.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .filter(([t]) => !ySeen.has(songKey(t)) && ySeen.add(songKey(t)))
      .slice(0, limit);
    if (top.length < 10) continue;
    sets.push({
      id: `year-${y}`,
      title: `Your ${y}`,
      blurb: `The songs you played most in ${y}.`,
      tracks: top.map(([t, n]) => ({ ...pub(t), note: `${n} plays in ${y}` })),
      needs: null,
    });
  }
  return sets;
}

// -------------------------------------------------------------------- blend --

/**
 * A playlist for two: songs by artists you both play, then each person's own
 * favourites in equal measure. Recent plays count more than old ones.
 */
export function blend(rowsA, rowsB, { now = Date.now(), size = 50 } = {}) {
  const score = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!r.uri) continue;
      const age = (now - r.at) / DAY;
      if (age > 365) continue;
      const w = Math.exp(-age / 90);
      const cur = m.get(r.uri) ?? { uri: r.uri, name: r.name, artist: r.artists.map((x) => x.name).join(', '), artists: r.artists, album: r.album, image: r.image ?? null, s: 0 };
      cur.s += w;
      cur.image ||= r.image ?? null;
      m.set(r.uri, cur);
    }
    return m;
  };
  const A = score(rowsA);
  const B = score(rowsB);
  const artistsOf = (m) => {
    const out = new Map();
    for (const t of m.values()) for (const a of t.artists) out.set(lower(a.name), (out.get(lower(a.name)) ?? 0) + t.s);
    return out;
  };
  const aa = artistsOf(A);
  const ba = artistsOf(B);
  const sharedArtists = new Set([...aa.keys()].filter((k) => ba.has(k)));

  const picked = new Map(); // by song, not by Spotify ID
  const take = (t, who) => {
    const k = songKey(t);
    if (picked.has(k)) {
      if (picked.get(k).who !== who) picked.get(k).who = 'both';
      return false;
    }
    picked.set(k, { ...t, who });
    return true;
  };
  const isShared = (t) => t.artists.some((a) => sharedArtists.has(lower(a.name)));
  const byScore = (m) => [...m.values()].sort((x, y) => y.s - x.s);

  // Songs you both actually play go in first.
  const bSongs = new Set([...B.values()].map(songKey));
  for (const t of byScore(A)) if (bSongs.has(songKey(t))) take(t, 'both');
  // Then shared artists, alternating whose favourite.
  const sa = byScore(A).filter(isShared);
  const sb = byScore(B).filter(isShared);
  const sharedTarget = Math.round(size * 0.4);
  for (let i = 0; picked.size < sharedTarget && (i < sa.length || i < sb.length); i++) {
    if (sa[i]) take(sa[i], 'a');
    if (sb[i] && picked.size < sharedTarget) take(sb[i], 'b');
  }
  // Then each person's own favourites, strictly alternating so it stays even.
  const oa = byScore(A).filter((t) => !isShared(t));
  const ob = byScore(B).filter((t) => !isShared(t));
  for (let i = 0, j = 0; picked.size < size && (i < oa.length || j < ob.length); ) {
    while (i < oa.length && !take(oa[i++], 'a'));
    if (picked.size >= size) break;
    while (j < ob.length && !take(ob[j++], 'b'));
  }
  const tracks = [...picked.values()].map(({ s, ...t }) => t);
  return {
    tracks,
    shared: [...sharedArtists].length,
    counts: { both: tracks.filter((t) => t.who === 'both').length, a: tracks.filter((t) => t.who === 'a').length, b: tracks.filter((t) => t.who === 'b').length },
  };
}

// ------------------------------------------------------------------ wrapped --

/** Which months and years have enough plays for a Wrapped. */
export function wrappedPeriods(rows, tz = 'UTC') {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' });
  const months = new Map();
  for (const r of rows) {
    const k = fmt.format(new Date(r.at)).slice(0, 7);
    months.set(k, (months.get(k) ?? 0) + 1);
  }
  const years = new Map();
  for (const [k, n] of months) years.set(k.slice(0, 4), (years.get(k.slice(0, 4)) ?? 0) + n);
  return {
    months: [...months.entries()].filter(([, n]) => n >= 20).map(([k]) => k).sort().reverse(),
    years: [...years.entries()].filter(([, n]) => n >= 100).map(([k]) => k).sort().reverse(),
  };
}

/**
 * A recap of one period ("2026" or "2026-10"): the numbers, the top five,
 * what was new, when you listened, and a one-line listening personality.
 */
export function wrapped(rows, period, tz = 'UTC') {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const parts = (at) => Object.fromEntries(fmt.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const inPeriod = (p) => (period.length === 4 ? p.year === period : `${p.year}-${p.month}` === period);

  const sel = [];
  const before = new Set(); // artists heard before this period
  let started = false;
  for (const r of rows) {
    const p = parts(r.at);
    if (inPeriod(p)) {
      started = true;
      sel.push({ r, p });
    } else if (!started) {
      for (const a of r.artists) before.add(lower(a.name));
    }
  }
  if (!sel.length) return null;

  const ms = sel.reduce((s, x) => s + (x.r.ms || 0), 0);
  const artists = new Map();
  const tracks = new Map();
  const days = new Map();
  const hours = new Array(24).fill(0);
  let weekend = 0;
  for (const { r, p } of sel) {
    const seen = new Set();
    for (const a of r.artists) {
      const k = lower(a.name);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = artists.get(k) ?? { name: a.name, plays: 0, firstEver: before.size > 0 && !before.has(k) };
      cur.plays++;
      artists.set(k, cur);
    }
    const tk = trackKey(r);
    const t = tracks.get(tk) ?? { name: r.name, artist: r.artists.map((a) => a.name).join(', '), image: r.image ?? null, plays: 0 };
    t.plays++;
    t.image ||= r.image ?? null;
    tracks.set(tk, t);
    const day = `${p.year}-${p.month}-${p.day}`;
    days.set(day, (days.get(day) ?? 0) + 1);
    hours[Number(p.hour) % 24]++;
    if (p.weekday === 'Sat' || p.weekday === 'Sun') weekend++;
  }
  const topArtists = [...artists.values()].sort((a, b) => b.plays - a.plays);
  const topTracks = [...tracks.values()].sort((a, b) => b.plays - a.plays);
  const newArtists = topArtists.filter((a) => a.firstEver);
  const [bigDay, bigDayPlays] = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
  const peakHour = hours.indexOf(Math.max(...hours));
  const n = sel.length;
  const top5Share = topArtists.slice(0, 5).reduce((s, a) => s + a.plays, 0) / n;
  const night = (hours.slice(22).reduce((a, b) => a + b, 0) + hours.slice(0, 4).reduce((a, b) => a + b, 0)) / n;
  const morning = hours.slice(5, 9).reduce((a, b) => a + b, 0) / n;
  const newShare = newArtists.reduce((s, a) => s + a.plays, 0) / n;

  // One headline personality, picked by whichever trait stands out most.
  const traits = [
    { name: 'The Loyalist', line: `Your top five artists took ${Math.round(top5Share * 100)}% of your plays.`, score: top5Share - 0.45 },
    ...(before.size ? [{ name: 'The Explorer', line: `${newArtists.length} artists were brand new to you.`, score: newShare - 0.2 }] : []),
    { name: 'The Night Owl', line: `${Math.round(night * 100)}% of your listening happened after 10pm.`, score: night - 0.2 },
    { name: 'The Early Bird', line: `${Math.round(morning * 100)}% of your listening happened before 9am.`, score: morning - 0.2 },
    { name: 'The Weekender', line: `${Math.round((weekend / n) * 100)}% of your plays were on a Saturday or Sunday.`, score: weekend / n - 0.4 },
  ].sort((a, b) => b.score - a.score);
  const personality = traits[0].score > 0 ? traits[0] : { name: 'The All-Rounder', line: 'No single habit dominates: you listen to a bit of everything, all week.' };

  return {
    period,
    label: period.length === 4 ? period : new Date(`${period}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    plays: n,
    minutes: Math.round(ms / 60000),
    days: days.size,
    artistCount: artists.size,
    trackCount: tracks.size,
    topArtist: topArtists[0] && { ...topArtists[0], share: Math.round((topArtists[0].plays / n) * 100) },
    topArtists: topArtists.slice(0, 5),
    topTrack: topTracks[0],
    topTracks: topTracks.slice(0, 5),
    newArtists: newArtists.slice(0, 5).map((a) => a.name),
    newArtistCount: before.size ? newArtists.length : null,
    bigDay: { day: bigDay, plays: bigDayPlays },
    peakHour,
    personality,
  };
}
