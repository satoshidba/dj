import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { store } from './store.js';
import { authorizeUrl, exchangeCode, spotifyFor, SpotifyError, SPOTIFY_API } from './spotify.js';
import { properShuffle, fisherYates, spreadStats } from './shuffle.js';
import { curate, tasteProfile, aiEnabled } from './curator.js';

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
    const sid = crypto.randomBytes(32).toString('hex');
    store.createSession(sid, me.id);
    setCookie(res, SID, sid, 60 * 60 * 24 * 180);
    res.redirect('/');
  }),
);

app.post('/logout', (req, res) => {
  store.deleteSession(cookies(req)[SID]);
  setCookie(res, SID, '', 0);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ api ----

app.get('/api/session', (req, res) => {
  const user = store.sessionUser(cookies(req)[SID]);
  res.json({
    user: user ? { id: user.id, name: user.name, image: user.image } : null,
    ai: aiEnabled(),
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
    res.json({
      liked: { total: likedTotal },
      playlists: lists
        .filter((p) => p.id !== likedTarget)
        .map((p) => ({ ...p, canEdit: p.ownerId === req.user.id || p.collaborative })),
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
    res.json({
      playlist: meta,
      tracks,
      stats: spreadStats(tracks),
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
    const shuffled = properShuffle(tracks);
    res.json({
      order: shuffled.map((t) => t.uri),
      stats: spreadStats(shuffled),
      // What a plain random shuffle would typically have done, for comparison.
      plain: spreadStats(fisherYates(tracks)),
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
    if (current.some((t) => t.local)) {
      return res.status(422).json({
        error: 'This playlist has local files, which Spotify won’t let apps write back. Save it as a new playlist instead (local files will be left out).',
      });
    }

    if (id === 'liked') {
      // Liked Songs can't be reordered, so write into a dedicated playlist we reuse.
      let target = store.getLikedPlaylist(req.user.id);
      const name = 'Liked Songs, dealt';
      const description = `Your Liked Songs, properly shuffled by dj on ${new Date().toDateString()}. Play in order.`;
      if (target) {
        try {
          await req.sp.updatePlaylistDetails(target, { name, description });
        } catch (err) {
          if (err.status === 404 || err.status === 403) target = null;
          else throw err;
        }
      }
      if (!target) {
        target = (await req.sp.createPlaylist({ name, description })).id;
        store.setLikedPlaylist(req.user.id, target);
      }
      await req.sp.replacePlaylistItems(target, uris);
      return res.json({ ok: true, url: `https://open.spotify.com/playlist/${target}` });
    }

    store.putBackup(req.user.id, id, current.map((t) => t.uri));
    await req.sp.replacePlaylistItems(id, uris);
    trackCache.delete(`${req.user.id}:${id}`);
    res.json({ ok: true, url: `https://open.spotify.com/playlist/${id}`, canRestore: true });
  }),
);

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
    const result = await curate({ userId: req.user.id, sp: req.sp, brief, length, familiarity }, send);
    send({ stage: 'done', result });
  } catch (err) {
    console.error('brief failed:', err);
    send({ stage: 'error', message: friendly(err) });
  }
  res.end();
});

// --------------------------------------------------------------- static ----

// The shuffle is pure ESM with no dependencies, so the landing-page demo runs the real thing.
app.get('/shuffle.js', (req, res) => res.type('text/javascript').sendFile(path.join(here, 'shuffle.js')));
app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));

function friendly(err) {
  if (err instanceof SpotifyError) {
    if (err.status === 401) return 'Your Spotify login expired. Log in again.';
    if (err.status === 403) return 'Spotify refused that. In Development Mode apps can only read and change playlists you own or collaborate on, and each user must be added to the app in the Spotify dashboard.';
    return `Spotify said: ${err.message}`;
  }
  return err?.message || 'Something went wrong';
}

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err instanceof SpotifyError && err.status < 500 ? err.status : 500).json({ error: friendly(err) });
});

app.listen(PORT, () => console.log(`dj listening on :${PORT} (${APP_URL})`));
