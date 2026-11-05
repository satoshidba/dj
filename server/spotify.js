// Spotify Web API client, written against the post-February-2026 API:
//   - playlist contents live under /playlists/{id}/items (not /tracks),
//     and each entry's object is `item` (older responses used `track`)
//   - playlists are created with POST /me/playlists
//   - /search returns at most 10 results per page
//   - apps in Development Mode can only read the contents of playlists the
//     user owns or collaborates on
// Audio features and recommendations were withdrawn from new apps in 2024, so
// there is no tempo/energy data; the AI side estimates those instead.
import { store } from './store.js';

// Overridable only so the test suite can point at a mock server.
const API = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1';
const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com';

export const SPOTIFY_API = API;

export const SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-top-read',
  'user-read-recently-played',
  // Kids mode starts and skips music on whatever device is playing.
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

export const PLAYBACK_SCOPES = ['user-read-playback-state', 'user-modify-playback-state'];

const cfg = () => ({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: `${process.env.APP_URL.replace(/\/$/, '')}/callback`,
});

export function authorizeUrl(state) {
  const { clientId, redirectUri } = cfg();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    show_dialog: 'true', // lets the second person pick their own account on a shared device
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = cfg();
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new SpotifyError(res.status, body.error_description || body.error || 'token request failed');
  return {
    scope: body.scope,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

export const exchangeCode = (code) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: cfg().redirectUri });

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A per-user API client that refreshes its token and backs off on 429s. */
export function spotifyFor(userId) {
  async function token() {
    const user = store.getUser(userId);
    if (!user?.tokens) throw new SpotifyError(401, 'not logged in');
    if (user.tokens.expiresAt - Date.now() > 60_000) return user.tokens.accessToken;
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: user.tokens.refreshToken });
    // Spotify may or may not rotate the refresh token.
    fresh.refreshToken ||= user.tokens.refreshToken;
    fresh.scope ||= user.tokens.scope;
    store.putUser({ id: userId, tokens: fresh });
    return fresh.accessToken;
  }

  async function call(method, pathOrUrl, { query, body } = {}, attempt = 0) {
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') || 1);
      await sleep(Math.min(wait, 30) * 1000 + 100);
      return call(method, pathOrUrl, { query, body }, attempt + 1);
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(500 * (attempt + 1));
      return call(method, pathOrUrl, { query, body }, attempt + 1);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new SpotifyError(res.status, data?.error?.message || `Spotify ${res.status}`);
    return data;
  }

  /** Follow `next` links until exhausted (or `max` items). */
  async function pages(path, query, max = Infinity) {
    const out = [];
    let page = await call('GET', path, { query });
    while (page) {
      out.push(...(page.items ?? []));
      if (!page.next || out.length >= max) break;
      page = await call('GET', page.next);
    }
    return out.slice(0, max);
  }

  return {
    me: () => call('GET', '/me'),

    async playlists() {
      const items = await pages('/me/playlists', { limit: 50 });
      return items.filter(Boolean).map(simplifyPlaylist);
    },

    playlist: async (id) => simplifyPlaylist(await call('GET', `/playlists/${id}`)),

    async playlistTracks(id) {
      const items = await pages(`/playlists/${id}/items`, { limit: 50, additional_types: 'track,episode' });
      return items.map((entry) => simplifyTrack(entry.item ?? entry.track, entry)).filter(Boolean);
    },

    async likedTracks() {
      const items = await pages('/me/tracks', { limit: 50 });
      return items.map((entry) => simplifyTrack(entry.track ?? entry.item, entry)).filter(Boolean);
    },

    likedTotal: () => call('GET', '/me/tracks', { query: { limit: 1 } }).then((r) => r?.total ?? null),

    /** Replace a playlist's contents in order. PUT takes 100, then POST appends. */
    async replacePlaylistItems(id, uris) {
      const chunks = [];
      for (let i = 0; i < uris.length; i += 100) chunks.push(uris.slice(i, i + 100));
      await call('PUT', `/playlists/${id}/items`, { body: { uris: chunks[0] ?? [] } });
      for (const chunk of chunks.slice(1)) {
        await call('POST', `/playlists/${id}/items`, { body: { uris: chunk } });
      }
    },

    async createPlaylist({ name, description, isPublic = false }) {
      const p = await call('POST', '/me/playlists', { body: { name, description, public: isPublic } });
      return simplifyPlaylist(p);
    },

    updatePlaylistDetails: (id, { name, description }) =>
      call('PUT', `/playlists/${id}`, { body: { name, description } }),

    topArtists: (range, limit = 30) =>
      call('GET', '/me/top/artists', { query: { time_range: range, limit } }).then((r) => r?.items ?? []),
    topTracks: (range, limit = 30) =>
      call('GET', '/me/top/tracks', { query: { time_range: range, limit } }).then((r) => r?.items ?? []),
    recentlyPlayed: ({ after } = {}) =>
      call('GET', '/me/player/recently-played', { query: { limit: 50, after } }).then((r) => r?.items ?? []),

    // Playback (needs Premium on the listening account).
    playerState: () => call('GET', '/me/player'),
    devices: () => call('GET', '/me/player/devices').then((r) => r?.devices ?? []),
    play: (contextUri, deviceId) =>
      call('PUT', '/me/player/play', { query: { device_id: deviceId }, body: { context_uri: contextUri, offset: { position: 0 } } }),
    resume: () => call('PUT', '/me/player/play'),
    pause: () => call('PUT', '/me/player/pause'),
    next: () => call('POST', '/me/player/next'),
    setVolume: (percent, deviceId) => call('PUT', '/me/player/volume', { query: { volume_percent: Math.round(percent), device_id: deviceId } }),
    setShuffle: (on, deviceId) => call('PUT', '/me/player/shuffle', { query: { state: String(on), device_id: deviceId } }),

    search: (q, limit = 10) =>
      call('GET', '/search', { query: { q, type: 'track', limit } }).then((r) => r?.tracks?.items ?? []),
  };
}

export function simplifyPlaylist(p) {
  const total = p.items?.total ?? p.tracks?.total ?? null;
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    ownerId: p.owner?.id,
    ownerName: p.owner?.display_name ?? p.owner?.id,
    collaborative: !!p.collaborative,
    image: pickImage(p.images, 300),
    total,
    snapshotId: p.snapshot_id,
    url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
  };
}

export function simplifyTrack(t, entry = {}) {
  if (!t || !t.uri) return null;
  const isEpisode = t.type === 'episode';
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    local: !!(entry.is_local || t.is_local || t.uri.startsWith('spotify:local:')),
    artists: isEpisode
      ? [{ id: t.show?.id ?? null, name: t.show?.name ?? 'Podcast' }]
      : (t.artists ?? []).map((a) => ({ id: a.id ?? null, name: a.name })),
    album: isEpisode
      ? { id: t.show?.id ?? null, name: t.show?.name ?? '' }
      : { id: t.album?.id ?? null, name: t.album?.name ?? '' },
    image: pickImage(isEpisode ? t.images : t.album?.images, 64),
    durationMs: t.duration_ms ?? 0,
    explicit: !!t.explicit,
  };
}

function pickImage(images, target) {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= target) ?? sorted.at(-1)).url;
}
