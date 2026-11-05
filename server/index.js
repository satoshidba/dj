import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { store } from './store.js';
import { authorizeUrl, exchangeCode, spotifyFor, SpotifyError, SPOTIFY_API, PLAYBACK_SCOPES } from './spotify.js';
import { properShuffle, fisherYates, spreadStats } from './shuffle.js';
import { curate, tasteProfile, aiEnabled, kidsContexts } from './curator.js';
import * as passkeys from './passkeys.js';
import { writeOrder, DealError, stalenessForUser } from './deal.js';
import { setSchedule, startAutoDeal, runDue } from './autodeal.js';
import { rediscover, blend, wrapped, wrappedPeriods } from './insights.js';
import { startSleep, sleepStatus, cancelSleep } from './sleep.js';
import { startTracking, pollUser, playsFor, addPlays, fromExport, summarise, overlap, POLL_MINUTES, freshStart } from './plays.js';

for (const key of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'APP_URL']) {
  if (!process.env[key]) {
    console.error(`Missing ${key}. See README.md → Setup.`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 8080);
const APP_URL = process.env.APP_URL.replace(/\/$/, '');
const SECURE = APP_URL.startsWith('https://');
const ALLOWED = (process.env.ALLOWED_SPOTIFY_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const here = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use('/api/history/import', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '2mb' }));

// ------------------------------------------------------------- sessions ----

const SID = 'dj_sid';
const STATE = 'dj_oauth';

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function auth(req, res, next) {
  const user = store.sessionUser(cookies(req)[SID]);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  // Cheap CSRF guard: browsers won't add custom headers to cross-site form posts.
  if (req.method !== 'GET' && req.get('x-dj') !== '1') return res.status(403).json({ error: 'Bad request' });
  req.user = user;
  req.sp = spotifyFor(user.id);
  next();
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------------------------------------------------------------- oauth ----

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE, state, 600);
  res.redirect(authorizeUrl(state));
});

app.get(
  '/callback',
  wrap(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
    if (!code || !state || state !== cookies(req)[STATE]) return res.redirect('/?error=state_mismatch');
    setCookie(res, STATE, '', 0);

    const tokens = await exchangeCode(code);
    const me = await fetch(`${SPOTIFY_API}/me`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).then((r) => r.json());
    if (!me?.id) return res.redirect('/?error=profile');
    if (ALLOWED.length && !ALLOWED.includes(me.id)) return res.redirect('/?error=not_allowed');

    store.putUser({
      id: me.id,
      name: me.display_name || me.id,
      image: me.images?.at(-1)?.url ?? null,
      tokens,
    });
    startSession(res, me.id);
    pollUser(me.id); // start the play log straight away
    res.redirect('/');
  }),
);

app.post('/logout', (req, res) => {
  store.deleteSession(cookies(req)[SID]);
  setCookie(res, SID, '', 0);
  res.json({ ok: true });
});

// ------------------------------------------------------------- passkeys ----

const PKC = 'dj_pkc';

function startSession(res, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  store.createSession(sid, userId);
  setCookie(res, SID, sid, 60 * 60 * 24 * 180);
}

const passkeyRoute = (fn) => async (req, res, next) => {
  if (!passkeys.passkeysAvailable) return res.status(400).json({ error: passkeys.passkeysWhyNot });
  if (req.get('x-dj') !== '1') return res.status(403).json({ error: 'Bad request' });
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof passkeys.PasskeyError || err?.name === 'Error') {
      console.error('passkey:', err.message);
      return res.status(400).json({ error: err instanceof passkeys.PasskeyError ? err.message : 'The passkey couldn’t be verified. Try again.' });
    }
    next(err);
  }
};

// Sign in (no session yet).
app.post('/auth/passkey/options', passkeyRoute(async (req, res) => {
  const { options, challengeId } = await passkeys.authenticationOptions();
  setCookie(res, PKC, challengeId, 300);
  res.json(options);
}));

app.post('/auth/passkey/verify', passkeyRoute(async (req, res) => {
  const user = await passkeys.authenticate(cookies(req)[PKC], req.body?.response);
  setCookie(res, PKC, '', 0);
  startSession(res, user.id);
  res.json({ ok: true });
}));

// Manage passkeys (signed in).
app.get('/api/passkeys', auth, (req, res) => res.json({ passkeys: passkeys.listPasskeys(req.user) }));

app.post('/api/passkeys/options', auth, passkeyRoute(async (req, res) => {
  const { options, challengeId } = await passkeys.registrationOptions(req.user);
  setCookie(res, PKC, challengeId, 300);
  res.json(options);
}));

app.post('/api/passkeys', auth, passkeyRoute(async (req, res) => {
  const list = await passkeys.registerPasskey(req.user, cookies(req)[PKC], req.body?.response, req.body?.name);
  setCookie(res, PKC, '', 0);
  res.json({ passkeys: list });
}));

app.delete('/api/passkeys/:id', auth, (req, res) => res.json({ passkeys: passkeys.removePasskey(req.user, req.params.id) }));

// ------------------------------------------------------------------ api ----

app.get('/api/session', (req, res) => {
  const user = store.sessionUser(cookies(req)[SID]);
  const scopes = (user?.tokens?.scope || '').split(' ');
  res.json({
    user: user ? { id: user.id, name: user.name, image: user.image } : null,
    ai: aiEnabled(),
    playback: !!user && PLAYBACK_SCOPES.every((s) => scopes.includes(s)),
    passkeys: { available: passkeys.passkeysAvailable, whyNot: passkeys.passkeysWhyNot, count: user?.passkeys?.length ?? 0 },
    others: user ? store.allUsers().filter((u) => u.id !== user.id).map((u) => ({ id: u.id, name: u.name, image: u.image })) : [],
  });
});

// Track lists are cached briefly so "deal again" doesn't refetch thousands of tracks.
const trackCache = new Map();
async function loadTracks(req, id, { fresh = false } = {}) {
  const key = `${req.user.id}:${id}`;
  const hit = trackCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.tracks;
  const tracks = id === 'liked' ? await req.sp.likedTracks() : await req.sp.playlistTracks(id);
  trackCache.set(key, { at: Date.now(), tracks });
  return tracks;
}

app.get(
  '/api/playlists',
  auth,
  wrap(async (req, res) => {
    const [lists, likedTotal] = await Promise.all([req.sp.playlists(), req.sp.likedTotal().catch(() => null)]);
    const likedTarget = store.getLikedPlaylist(req.user.id);
    const sched = store.schedulesFor(req.user.id);
    res.json({
      liked: { total: likedTotal, auto: sched.liked?.every ?? null },
      playlists: lists
        .filter((p) => p.id !== likedTarget)
        .map((p) => ({ ...p, canEdit: p.ownerId === req.user.id || p.collaborative, auto: sched[p.id]?.every ?? null })),
    });
  }),
);

app.get(
  '/api/playlists/:id',
  auth,
  wrap(async (req, res) => {
    const { id } = req.params;
    const tracks = await loadTracks(req, id, { fresh: true });
    const meta =
      id === 'liked'
        ? { id: 'liked', name: 'Liked Songs', total: tracks.length, canEdit: false, image: null }
        : await req.sp.playlist(id).then((p) => ({ ...p, canEdit: p.ownerId === req.user.id || p.collaborative }));
    const staleness = stalenessForUser(req.user.id);
    res.json({
      playlist: meta,
      tracks,
      stats: { ...spreadStats(tracks), ...(staleness ? { freshStart: freshStart(tracks, staleness) } : {}) },
      freshAvailable: !!staleness,
      // 0–1 per track, so the list can show which songs are on heavy rotation.
      tired: staleness ? tracks.map((t) => Math.round(staleness(t) * 100) / 100) : null,
      schedule: store.getSchedule(req.user.id, id),
      hasLocal: tracks.some((t) => t.local),
      canRestore: !!store.getBackup(req.user.id, id),
      likedTarget: id === 'liked' ? store.getLikedPlaylist(req.user.id) : null,
    });
  }),
);

app.post(
  '/api/playlists/:id/shuffle',
  auth,
  wrap(async (req, res) => {
    const tracks = await loadTracks(req, req.params.id);
    const staleness = req.body?.fresh === false ? null : stalenessForUser(req.user.id);
    const shuffled = properShuffle(tracks, { staleness: staleness ?? undefined });
    const plain = fisherYates(tracks);
    res.json({
      order: shuffled.map((t) => t.uri),
      stats: { ...spreadStats(shuffled), ...(staleness ? { freshStart: freshStart(shuffled, staleness) } : {}) },
      // What a plain random shuffle would typically have done, for comparison.
      plain: { ...spreadStats(plain), ...(staleness ? { freshStart: freshStart(plain, staleness) } : {}) },
      fresh: !!staleness,
    });
  }),
);

const sameTracks = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

app.post(
  '/api/playlists/:id/apply',
  auth,
  wrap(async (req, res) => {
    const { id } = req.params;
    const uris = req.body?.uris;
    if (!Array.isArray(uris) || !uris.length) return res.status(400).json({ error: 'No tracks' });

    const current = await loadTracks(req, id, { fresh: true });
    if (!sameTracks(current.map((t) => t.uri), uris)) {
      return res.status(409).json({ error: 'The playlist changed since you opened it. Reload and deal again.' });
    }
    try {
      const r = await writeOrder(req.user.id, req.sp, id, current, uris);
      trackCache.delete(`${req.user.id}:${id}`);
      res.json({ ok: true, ...r });
    } catch (err) {
      if (err instanceof DealError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }),
);

app.put('/api/playlists/:id/schedule', auth, (req, res) => {
  const tz = isValidTz(req.body?.tz) ? req.body.tz : 'UTC';
  res.json({ schedule: setSchedule(req.user.id, req.params.id, { every: req.body?.every, tz, fresh: req.body?.fresh !== false, name: String(req.body?.name ?? '').slice(0, 100) }) });
});

app.get('/api/schedules', auth, (req, res) => res.json({ schedules: store.schedulesFor(req.user.id) }));

// Lets the test suite (and an impatient human) trigger due auto-deals now.
app.post('/api/schedules/run-due', auth, wrap(async (req, res) => {
  const later = process.env.DJ_TEST === '1' && req.body?.pretendLater;
  await runDue(Date.now() + (later ? 9 * 86_400_000 : 0));
  res.json({ schedules: store.schedulesFor(req.user.id) });
}));

app.post(
  '/api/playlists/:id/restore',
  auth,
  wrap(async (req, res) => {
    const backup = store.getBackup(req.user.id, req.params.id);
    if (!backup) return res.status(404).json({ error: 'Nothing to restore' });
    const current = await loadTracks(req, req.params.id, { fresh: true });
    if (!sameTracks(current.map((t) => t.uri), backup.uris)) {
      return res.status(409).json({ error: 'Tracks were added or removed since the shuffle, so the old order no longer fits.' });
    }
    await req.sp.replacePlaylistItems(req.params.id, backup.uris);
    trackCache.delete(`${req.user.id}:${req.params.id}`);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/save-as',
  auth,
  wrap(async (req, res) => {
    const { name, description = '', uris } = req.body ?? {};
    const playable = (uris ?? []).filter((u) => typeof u === 'string' && !u.startsWith('spotify:local:'));
    if (!name || !playable.length) return res.status(400).json({ error: 'Need a name and some tracks' });
    const p = await req.sp.createPlaylist({ name: String(name).slice(0, 100), description: String(description).slice(0, 300) });
    await req.sp.replacePlaylistItems(p.id, playable);
    res.json({ ok: true, id: p.id, url: `https://open.spotify.com/playlist/${p.id}` });
  }),
);

app.get(
  '/api/taste',
  auth,
  wrap(async (req, res) => {
    const t = await tasteProfile(req.user.id, req.sp);
    res.json({
      empty: t.isEmpty,
      genres: t.topGenres,
      artists: (t.artistsNow.length ? t.artistsNow : t.artistsSixMonths).slice(0, 12),
    });
  }),
);

app.post('/api/brief', auth, async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: 'Set ANTHROPIC_API_KEY to use briefs.' });
  const brief = String(req.body?.brief ?? '').trim().slice(0, 600);
  const length = Math.min(80, Math.max(8, Number(req.body?.length) || 25));
  const familiarity = Math.min(1, Math.max(0, Number(req.body?.familiarity ?? 0.5)));
  if (!brief) return res.status(400).json({ error: 'Say what the playlist is for.' });

  // Newline-delimited JSON so the UI can show real progress.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  try {
    const result = await curate({ userId: req.user.id, sp: req.sp, brief, length, familiarity, minutes: minutesFrom(req) }, send);
    send({ stage: 'done', result });
  } catch (err) {
    console.error('brief failed:', err);
    send({ stage: 'error', message: friendly(err) });
  }
  res.end();
});



// ------------------------------------------- rediscover, blend, wrapped ----

/** A person's own plays, with Kids mode plays left out. */
function grownRows(userId) {
  const kidsCtx = kidsContexts(userId);
  return playsFor(userId).filter((r) => !(r.ctx && kidsCtx.has(r.ctx)));
}

const asTrack = (t) => ({ uri: t.uri, name: t.name, artists: t.artists ?? [{ id: null, name: t.artist }], album: { id: null, name: t.album ?? '' } });

/** Create (or refresh, if we made it before) a playlist with a dealt order. */
async function saveDealt(req, { key, name, description, tracks }) {
  const order = properShuffle(tracks.map(asTrack)).map((t) => t.uri);
  const made = store.getMade(req.user.id, key);
  let id = made;
  if (id) {
    try {
      await req.sp.updatePlaylistDetails(id, { name, description });
    } catch (err) {
      if (err.status === 404 || err.status === 403) id = null;
      else throw err;
    }
  }
  if (!id) {
    id = (await req.sp.createPlaylist({ name, description })).id;
    store.setMade(req.user.id, key, id);
  }
  await req.sp.replacePlaylistItems(id, order);
  return { url: `https://open.spotify.com/playlist/${id}`, updated: !!made && made === id };
}

app.get('/api/rediscover', auth, (req, res) => {
  const rows = grownRows(req.user.id);
  res.json({ since: rows[0]?.at ?? null, sets: rediscover(rows).map((s) => ({ ...s, made: !!store.getMade(req.user.id, `rediscover:${s.id}`) })) });
});

app.post(
  '/api/rediscover/:set/save',
  auth,
  wrap(async (req, res) => {
    const set = rediscover(grownRows(req.user.id)).find((s) => s.id === req.params.set);
    if (!set || set.tracks.length < 2) return res.status(404).json({ error: 'Not enough songs for that one yet.' });
    res.json(await saveDealt(req, { key: `rediscover:${set.id}`, name: set.title, description: `${set.blurb} Made by dj from your play history.`, tracks: set.tracks }));
  }),
);

function blendFor(req) {
  const partner = store.allUsers().find((u) => u.id !== req.user.id);
  if (!partner) return null;
  const size = Math.min(100, Math.max(20, Number(req.query.size || req.body?.size) || 50));
  return { partner, ...blend(grownRows(req.user.id), grownRows(partner.id), { size }) };
}

app.get('/api/blend', auth, (req, res) => {
  const b = blendFor(req);
  if (!b) return res.json({ partner: null });
  const key = `blend:${[req.user.id, b.partner.id].sort().join('+')}`;
  res.json({ partner: { id: b.partner.id, name: b.partner.name, image: b.partner.image }, tracks: b.tracks, counts: b.counts, shared: b.shared, made: !!store.getMade(req.user.id, key) });
});

app.post(
  '/api/blend/save',
  auth,
  wrap(async (req, res) => {
    const b = blendFor(req);
    if (!b || b.tracks.length < 2) return res.status(400).json({ error: 'Both of you need some play history first.' });
    const names = [req.user.name, b.partner.name].map((n) => n.split(' ')[0]);
    const key = `blend:${[req.user.id, b.partner.id].sort().join('+')}`;
    res.json(await saveDealt(req, { key, name: `${names[0]} + ${names[1]}`, description: `Both of you, evenly: songs you both play, then each person’s favourites. Made by dj from your play histories.`, tracks: b.tracks }));
  }),
);

app.get('/api/wrapped', auth, (req, res) => {
  const tz = isValidTz(req.query.tz) ? req.query.tz : 'UTC';
  const rows = grownRows(req.user.id);
  const periods = wrappedPeriods(rows, tz);
  const period = /^\d{4}(-\d{2})?$/.test(req.query.period ?? '') ? req.query.period : periods.months[1] ?? periods.months[0] ?? periods.years[0];
  if (!period) return res.json({ periods, wrapped: null });
  const w = wrapped(rows, period, tz);
  // Compare with the period before.
  let prev = null;
  if (period.length === 4) prev = String(Number(period) - 1);
  else {
    const [y, m] = period.split('-').map(Number);
    prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  }
  const pw = wrapped(rows, prev, tz);
  res.json({ periods, wrapped: w && { ...w, prevPlays: pw?.plays ?? null, prevLabel: pw?.label ?? null } });
});

// -------------------------------------------------------------- history ----

const RANGES = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

app.get('/api/history', auth, (req, res) => {
  const days = RANGES[req.query.range];
  const from = days ? Date.now() - days * 86_400_000 : 0;
  const tz = isValidTz(req.query.tz) ? req.query.tz : 'UTC';
  const audience = req.query.audience === 'kids' ? 'kids' : 'grown';
  const me = req.user;
  const mine = playsFor(me.id);
  const opts = { from, tz, audience };

  const status = me.trackingStatus ?? null;
  const base = {
    tracking: { on: me.tracking !== false, every: POLL_MINUTES, since: mine[0]?.at ?? null, last: status, imported: mine.some((r) => r.src === 'import') },
  };

  if (req.query.who === 'both') {
    const others = store.allUsers().filter((u) => u.id !== me.id);
    const people = [me, ...others].map((u) => ({ id: u.id, name: u.name, rows: playsFor(u.id), kidsCtx: kidsContexts(u.id) }));
    // Kids playlists may live on either account, so pool the kids contexts.
    const kidsCtx = new Set(people.flatMap((p) => [...p.kidsCtx]));
    const all = people.flatMap((p) => p.rows).sort((a, b) => a.at - b.at);
    const filt = (rows) => rows.filter((r) => r.at >= from && (audience === 'kids') === !!(r.ctx && kidsCtx.has(r.ctx)));
    return res.json({
      ...base,
      who: 'both',
      summary: summarise(all, { ...opts, kidsCtx }),
      people: people.map((p) => ({ id: p.id, name: p.name, plays: filt(p.rows).length })),
      shared: people.length > 1 ? overlap(filt(people[0].rows), filt(people[1].rows)) : [],
    });
  }
  res.json({ ...base, who: 'me', summary: summarise(mine, { ...opts, kidsCtx: kidsContexts(me.id) }) });
});

/** Optional "make it last N minutes" (10 min to 5 hours). */
function minutesFrom(req) {
  const m = Number(req.body?.minutes);
  return Number.isFinite(m) && m >= 10 ? Math.min(300, Math.round(m)) : null;
}

function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

app.post(
  '/api/history/poll',
  auth,
  wrap(async (req, res) => {
    await pollUser(req.user.id);
    res.json({ ok: true, status: store.getUser(req.user.id).trackingStatus });
  }),
);

app.put('/api/history/tracking', auth, (req, res) => {
  store.putUser({ id: req.user.id, tracking: !!req.body?.on });
  res.json({ ok: true });
});

// Rows from Spotify's Extended Streaming History export, sent in batches.
app.post('/api/history/import', auth, (req, res) => {
  const plays = fromExport(req.body?.rows);
  // Don't double count the period dj was already logging (timestamps in the
  // export and the live API don't line up exactly).
  const firstPolled = playsFor(req.user.id).find((r) => r.src === 'poll')?.at ?? Infinity;
  const added = addPlays(req.user.id, plays.filter((p) => p.at < firstPolled));
  res.json({ ok: true, added, skipped: plays.length - added });
});

// ----------------------------------------------------------------- kids ----

const KID_COLOURS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#e34948', '#008300'];

app.get('/api/kids', auth, (req, res) => {
  res.json({ profiles: store.kids(), playlists: store.kidsPlaylists(req.user.id) });
});

app.put('/api/kids/profiles', auth, (req, res) => {
  const profiles = (Array.isArray(req.body?.profiles) ? req.body.profiles : []).slice(0, 8).map((k) => ({
    id: String(k.id || crypto.randomUUID()),
    name: String(k.name ?? '').slice(0, 40),
    age: Math.min(17, Math.max(0, Number(k.age) || 0)) || null,
    likes: String(k.likes ?? '').slice(0, 300),
    avoid: String(k.avoid ?? '').slice(0, 300),
  }));
  store.setKids(profiles);
  res.json({ profiles });
});

function registerKidsPlaylist(userId, p, extra = {}) {
  const list = store.kidsPlaylists(userId).filter((x) => x.id !== p.id);
  list.push({
    id: p.id,
    name: p.name,
    emoji: extra.emoji || '🎵',
    colour: extra.colour || KID_COLOURS[list.length % KID_COLOURS.length],
    redeal: extra.redeal ?? true,
    total: p.total ?? extra.total ?? null,
    createdAt: Date.now(),
  });
  store.setKidsPlaylists(userId, list);
  return list;
}

app.post(
  '/api/kids/playlists',
  auth,
  wrap(async (req, res) => {
    const { name, description = '', uris, emoji, colour, existingId } = req.body ?? {};
    if (existingId) {
      const p = await req.sp.playlist(existingId);
      if (p.ownerId !== req.user.id && !p.collaborative) return res.status(403).json({ error: 'Only playlists you own can go in Kids mode.' });
      return res.json({ playlists: registerKidsPlaylist(req.user.id, p, { emoji, colour }) });
    }
    const playable = (uris ?? []).filter((u) => typeof u === 'string' && !u.startsWith('spotify:local:'));
    if (!name || !playable.length) return res.status(400).json({ error: 'Need a name and some tracks' });
    const p = await req.sp.createPlaylist({ name: String(name).slice(0, 100), description: String(description).slice(0, 300) });
    await req.sp.replacePlaylistItems(p.id, playable);
    res.json({ playlists: registerKidsPlaylist(req.user.id, p, { emoji, colour, total: playable.length }), url: p.url });
  }),
);

app.patch('/api/kids/playlists/:id', auth, (req, res) => {
  const list = store.kidsPlaylists(req.user.id).map((p) =>
    p.id === req.params.id
      ? {
          ...p,
          ...(req.body.emoji ? { emoji: String(req.body.emoji).slice(0, 8) } : {}),
          ...(req.body.colour && KID_COLOURS.includes(req.body.colour) ? { colour: req.body.colour } : {}),
          ...(typeof req.body.redeal === 'boolean' ? { redeal: req.body.redeal } : {}),
          ...([0, 20, 30, 45, 60].includes(req.body.sleep) ? { sleep: req.body.sleep } : {}),
        }
      : p,
  );
  store.setKidsPlaylists(req.user.id, list);
  res.json({ playlists: list });
});

app.delete('/api/kids/playlists/:id', auth, (req, res) => {
  store.setKidsPlaylists(req.user.id, store.kidsPlaylists(req.user.id).filter((p) => p.id !== req.params.id));
  res.json({ playlists: store.kidsPlaylists(req.user.id) });
});

app.post('/api/kids/brief', auth, async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: 'Set ANTHROPIC_API_KEY to make playlists with AI.' });
  const brief = String(req.body?.brief ?? '').trim().slice(0, 600);
  const length = Math.min(60, Math.max(8, Number(req.body?.length) || 20));
  const tolerance = Math.min(1, Math.max(0, Number(req.body?.tolerance ?? 0.5)));
  const ids = new Set(req.body?.kidIds ?? []);
  const profiles = store.kids().filter((k) => !ids.size || ids.has(k.id));
  if (!brief) return res.status(400).json({ error: 'Say what the playlist is for.' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  try {
    const result = await curate({ userId: req.user.id, sp: req.sp, brief, length, familiarity: 0.5, kids: { profiles, tolerance }, minutes: minutesFrom(req) }, send);
    send({ stage: 'done', result });
  } catch (err) {
    console.error('kids brief failed:', err);
    send({ stage: 'error', message: friendly(err) });
  }
  res.end();
});

// Start a kids playlist on whatever device is around (the phone in the car,
// the speaker at home), freshly dealt so it's never the same order twice.
app.post(
  '/api/kids/play/:id',
  auth,
  wrap(async (req, res) => {
    const entry = store.kidsPlaylists(req.user.id).find((p) => p.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not a Kids mode playlist' });
    const openUrl = `https://open.spotify.com/playlist/${entry.id}`;

    if (entry.redeal) {
      const tracks = await req.sp.playlistTracks(entry.id);
      if (tracks.length > 1 && !tracks.some((t) => t.local)) {
        await req.sp.replacePlaylistItems(entry.id, properShuffle(tracks).map((t) => t.uri));
      }
    }

    const devices = await req.sp.devices();
    const device = devices.find((d) => d.is_active) ?? devices.find((d) => !d.is_restricted);
    if (!device) {
      return res.status(409).json({ error: 'No Spotify device is awake. Open Spotify on the phone or speaker, then tap again.', openUrl });
    }
    await req.sp.setShuffle(false, device.id).catch(() => {});
    await req.sp.play(`spotify:playlist:${entry.id}`, device.id);
    const sleep = entry.sleep ? startSleep(req.user.id, req.sp, { contextUri: `spotify:playlist:${entry.id}`, minutes: entry.sleep, deviceId: device.id }) : (cancelSleep(req.user.id), null);
    res.json({ ok: true, device: device.name, sleep });
  }),
);

app.get(
  '/api/player',
  auth,
  wrap(async (req, res) => {
    const st = await req.sp.playerState();
    const t = st?.item;
    res.json({
      playing: !!st?.is_playing,
      device: st?.device?.name ?? null,
      context: st?.context?.uri ?? null,
      track: t ? { name: t.name, artists: (t.artists ?? []).map((a) => a.name).join(', '), image: t.album?.images?.[0]?.url ?? null } : null,
      sleep: sleepStatus(req.user.id),
    });
  }),
);

app.post(
  '/api/player/:action',
  auth,
  wrap(async (req, res) => {
    const fn = { pause: req.sp.pause, resume: req.sp.resume, next: req.sp.next }[req.params.action];
    if (!fn) return res.status(404).json({ error: 'Unknown action' });
    await fn();
    res.json({ ok: true });
  }),
);

// --------------------------------------------------------------- static ----

// The shuffle is pure ESM with no dependencies, so the landing-page demo runs the real thing.
app.get('/shuffle.js', (req, res) => res.type('text/javascript').sendFile(path.join(here, 'shuffle.js')));
// The passkey browser helper is plain ES modules; serve it as-is (no build step).
app.use('/vendor/simplewebauthn', express.static(path.join(here, '..', 'node_modules', '@simplewebauthn', 'browser', 'esm')));
app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));

function friendly(err) {
  if (err instanceof SpotifyError) {
    if (err.status === 401) return 'Your Spotify login expired. Log in again.';
    if (err.status === 403 && /premium/i.test(err.message)) return 'Starting music from dj needs Spotify Premium on this account.';
    if (err.status === 403 && /scope/i.test(err.message)) return 'dj needs permission to control playback. Log out and back in to grant it.';
    if (err.status === 404 && /device/i.test(err.message)) return 'No Spotify device is awake. Open Spotify on the phone or speaker, then try again.';
    if (err.status === 403) return 'Spotify refused that. In Development Mode apps can only read and change playlists you own or collaborate on, and each user must be added to the app in the Spotify dashboard.';
    return `Spotify said: ${err.message}`;
  }
  return err?.message || 'Something went wrong';
}

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err instanceof SpotifyError && err.status < 500 ? err.status : 500).json({ error: friendly(err) });
});

app.listen(PORT, () => {
  console.log(`dj listening on :${PORT} (${APP_URL})`);
  startTracking();
  startAutoDeal();
});
