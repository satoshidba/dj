// Everything an agent can do with dj, defined once.
//
// Each action has a name, a description written for a language model, a zod
// input schema, whether it only reads, and a handler. The same registry backs
// the MCP server (/mcp), the HTTP API (/api/v1) and the `dj` command line tool,
// so Claude, Hermes, Pi or a shell script all get identical behaviour.
import { z } from 'zod';
import { store } from './store.js';
import { properShuffle, spreadStats } from './shuffle.js';
import { playsFor, summarise, freshStart } from './plays.js';
import { kidsContexts, curate, resolve, aiEnabled } from './curator.js';
import { stalenessForUser, writeOrder } from './deal.js';
import { setSchedule } from './autodeal.js';
import { rediscover } from './insights.js';
import { simplifyTrack, SpotifyError } from './spotify.js';
import { ServiceError, grownRows, saveDealt, restoreBackup, blendFor, saveBlend, wrappedFor, kidsPlay, nowPlaying } from './services.js';

const DEFAULT_TZ = process.env.TZ || 'UTC';
const validTz = (tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
};
const songLine = (t) => `${t.artist ?? t.artists?.map((a) => a.name).join(', ')} — ${t.name}`;
const lower = (s) => String(s ?? '').trim().toLowerCase();

/** Find a playlist by id, exact name or partial name ("liked" for Liked Songs). */
async function findPlaylist(ctx, ref) {
  const r = lower(ref);
  if (['liked', 'liked songs', 'likes'].includes(r)) return { id: 'liked', name: 'Liked Songs', canEdit: true };
  const lists = await ctx.sp.playlists();
  const mine = lists.map((p) => ({ ...p, canEdit: p.ownerId === ctx.user.id || p.collaborative }));
  const hit = mine.find((p) => p.id === ref) ?? mine.find((p) => lower(p.name) === r);
  if (hit) return hit;
  const partial = mine.filter((p) => lower(p.name).includes(r));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new ServiceError(400, `“${ref}” matches several playlists: ${partial.map((p) => `“${p.name}” (${p.id})`).join(', ')}. Use the id.`);
  throw new ServiceError(404, `No playlist called “${ref}”. Use list_playlists to see them.`);
}

const loadTracks = (ctx, id) => (id === 'liked' ? ctx.sp.likedTracks() : ctx.sp.playlistTracks(id));

function trimStats(s) {
  const busiest = (() => {
    let best = { d: 0, h: 0, n: -1 };
    s.clock.forEach((row, d) => row.forEach((n, h) => n > best.n && (best = { d, h, n })));
    return best.n > 0 ? `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][best.d]} ${String(best.h).padStart(2, '0')}:00` : null;
  })();
  return {
    plays: s.plays,
    hours: Math.round(s.ms / 3_600_000),
    artists: s.artistCount,
    tracks: s.trackCount,
    longest_streak_days: s.longestStreak,
    busiest_slot: busiest,
    top_artists: s.topArtists.slice(0, 10).map((a) => ({ name: a.name, plays: a.plays })),
    top_tracks: s.topTracks.slice(0, 10).map((t) => ({ song: songLine(t), plays: t.plays, uri: t.uri })),
  };
}

const playlistRef = z.string().describe('Playlist id, exact name, or a unique part of the name. Use "liked" for Liked Songs.');

export const actions = [
  // ------------------------------------------------------------------ read --
  {
    name: 'list_playlists',
    title: 'List playlists',
    description: 'List the user’s Spotify playlists with track counts, whether dj can rewrite them (only playlists they own or collaborate on), and any auto-deal schedule.',
    readOnly: true,
    input: {},
    async run(ctx) {
      const sched = store.schedulesFor(ctx.user.id);
      const lists = await ctx.sp.playlists();
      return {
        playlists: [
          { id: 'liked', name: 'Liked Songs', can_deal: true, note: 'Dealt into a separate “Liked Songs, dealt” playlist', auto_deal: sched.liked?.every ?? 'off' },
          ...lists.map((p) => ({ id: p.id, name: p.name, tracks: p.total, can_deal: p.ownerId === ctx.user.id || p.collaborative, auto_deal: sched[p.id]?.every ?? 'off' })),
        ],
      };
    },
  },
  {
    name: 'get_playlist',
    title: 'Look at a playlist',
    description: 'Show a playlist’s current order and how well spread it is: back-to-back repeats of the same artist, repeats within 3 tracks, the tightest gap between repeats, a 0–100 spread score, and (with play history) how much of the opening quarter is songs the user hasn’t played lately.',
    readOnly: true,
    input: { playlist: playlistRef, show_tracks: z.number().int().min(0).max(200).default(30).describe('How many tracks to list from the top') },
    async run(ctx, { playlist, show_tracks }) {
      const p = await findPlaylist(ctx, playlist);
      const tracks = await loadTracks(ctx, p.id);
      const st = stalenessForUser(ctx.user.id);
      return {
        id: p.id,
        name: p.name,
        tracks: tracks.length,
        can_deal: p.canEdit,
        spread: spreadStats(tracks),
        fresh_start_percent: st ? freshStart(tracks, st) : null,
        auto_deal: store.getSchedule(ctx.user.id, p.id)?.every ?? 'off',
        can_undo: !!store.getBackup(ctx.user.id, p.id),
        order: tracks.slice(0, show_tracks).map((t, i) => `${i + 1}. ${songLine(t)}`),
      };
    },
  },
  {
    name: 'listening_stats',
    title: 'Listening stats',
    description: 'Summarise the user’s listening from dj’s own play log (which keeps every play, not just Spotify’s last 50): totals, top artists and tracks, longest daily streak and busiest weekday/hour. Kids mode plays are separate (audience "kids").',
    readOnly: true,
    input: {
      range: z.enum(['7d', '30d', '90d', '365d', 'all']).default('30d'),
      audience: z.enum(['grown', 'kids']).default('grown'),
      time_zone: z.string().optional().describe('IANA zone for the busiest hour, e.g. Europe/London'),
    },
    async run(ctx, { range, audience, time_zone }) {
      const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[range];
      const s = summarise(playsFor(ctx.user.id), { from: days ? Date.now() - days * 86_400_000 : 0, kidsCtx: kidsContexts(ctx.user.id), audience, tz: validTz(time_zone ?? DEFAULT_TZ) });
      return { range, audience, ...trimStats(s) };
    },
  },
  {
    name: 'recent_plays',
    title: 'Recent plays',
    description: 'The most recent plays from dj’s play log, newest first.',
    readOnly: true,
    input: { limit: z.number().int().min(1).max(100).default(20) },
    async run(ctx, { limit }) {
      const rows = playsFor(ctx.user.id);
      return { plays: rows.slice(-limit).reverse().map((r) => ({ at: new Date(r.at).toISOString(), song: `${r.artists.map((a) => a.name).join(', ')} — ${r.name}`, uri: r.uri })) };
    },
  },
  {
    name: 'wrapped',
    title: 'Wrapped',
    description: 'A Wrapped-style recap for a month ("2026-10") or year ("2025"): minutes, top artist and song, top fives, artists new to the user, busiest hour and day, change on the previous period, and a listening personality. Omit period for last full month. Also lists which periods are available.',
    readOnly: true,
    input: { period: z.string().regex(/^\d{4}(-\d{2})?$/).optional(), time_zone: z.string().optional() },
    async run(ctx, { period, time_zone }) {
      const r = wrappedFor(ctx.user, period, validTz(time_zone ?? DEFAULT_TZ));
      return { available: r.periods, wrapped: r.wrapped };
    },
  },
  {
    name: 'rediscover_list',
    title: 'Rediscover sets',
    description: 'Playlists dj can build from the user’s own past: "forgotten" (songs played 5+ times then not for 6 months), "thisweek" (around today’s date in earlier years) and "year-YYYY" (top songs of each full year). Shows each set’s top songs, or why it isn’t available yet.',
    readOnly: true,
    input: {},
    async run(ctx) {
      return {
        sets: rediscover(grownRows(ctx.user.id)).map((s) => ({ id: s.id, title: s.title, about: s.blurb, songs: s.tracks.length, unavailable_because: s.needs, top: s.tracks.slice(0, 5).map((t) => `${songLine(t)} (${t.note})`) })),
      };
    },
  },
  {
    name: 'together_preview',
    title: 'Preview the two-person blend',
    description: 'Preview the playlist dj would make for both household members together: songs they both play first, then each person’s favourites in equal measure.',
    readOnly: true,
    input: { size: z.number().int().min(20).max(100).default(50) },
    async run(ctx, { size }) {
      const b = blendFor(ctx.user, size);
      if (!b) return { available: false, reason: 'Only one person has connected Spotify so far.' };
      return { partner: b.partner.name, counts: b.counts, songs: b.tracks.slice(0, 25).map((t) => `${songLine(t)} [${t.who === 'both' ? 'both' : t.who === 'a' ? ctx.user.name : b.partner.name}]`) };
    },
  },
  {
    name: 'kids_buttons',
    title: 'Kids mode buttons',
    description: 'The playlists set up as Kids mode buttons, with their sleep timers.',
    readOnly: true,
    input: {},
    async run(ctx) {
      return { buttons: store.kidsPlaylists(ctx.user.id).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, sleep_minutes: p.sleep || 0, redeal_each_play: p.redeal })) };
    },
  },
  {
    name: 'now_playing',
    title: 'Now playing',
    description: 'What’s playing on the user’s Spotify right now, on which device, and any Kids mode sleep timer.',
    readOnly: true,
    input: {},
    run: (ctx) => nowPlaying(ctx.user, ctx.sp),
  },
  {
    name: 'search_tracks',
    title: 'Search Spotify',
    description: 'Search Spotify for tracks (max 10 results). Supports field filters like track:"Everlong" artist:"Foo Fighters".',
    readOnly: true,
    input: { query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) },
    async run(ctx, { query, limit }) {
      const items = (await ctx.sp.search(query, limit)).map((t) => simplifyTrack(t)).filter(Boolean);
      return { tracks: items.map((t) => ({ uri: t.uri, song: songLine(t), album: t.album.name, minutes: Math.round((t.durationMs / 60000) * 10) / 10, explicit: t.explicit })) };
    },
  },

  // ----------------------------------------------------------------- write --
  {
    name: 'deal_playlist',
    title: 'Deal (properly shuffle) a playlist',
    description: 'Properly shuffle a playlist and write the new order back to Spotify, so it can be played in order with shuffle off. The same artist never plays twice in a row where avoidable, big artists are spread as far apart as possible, and with fresh=true songs the user has played a lot lately go later. The previous order is saved for undo_deal. Liked Songs is written to a “Liked Songs, dealt” playlist.',
    readOnly: false,
    input: { playlist: playlistRef, fresh: z.boolean().default(true).describe('Push recently over-played songs later (needs play history)') },
    async run(ctx, { playlist, fresh }) {
      const p = await findPlaylist(ctx, playlist);
      if (!p.canEdit) throw new ServiceError(403, `“${p.name}” isn’t the user’s, and Spotify only lets apps change playlists they own or collaborate on.`);
      const tracks = await loadTracks(ctx, p.id);
      if (tracks.length < 2) throw new ServiceError(400, 'That playlist has fewer than two tracks.');
      const st = fresh ? stalenessForUser(ctx.user.id) : null;
      const order = properShuffle(tracks, { staleness: st ?? undefined });
      const w = await writeOrder(ctx.user.id, ctx.sp, p.id, tracks, order.map((t) => t.uri));
      return {
        playlist: p.name,
        url: w.url,
        before: spreadStats(tracks),
        after: spreadStats(order),
        fresh: !!st,
        fresh_start_percent: st ? freshStart(order, st) : null,
        can_undo: w.canRestore,
        first_tracks: order.slice(0, 10).map((t, i) => `${i + 1}. ${songLine(t)}`),
      };
    },
  },
  {
    name: 'undo_deal',
    title: 'Undo the last deal',
    description: 'Put a playlist back in the order it had before dj last rewrote it.',
    readOnly: false,
    input: { playlist: playlistRef },
    async run(ctx, { playlist }) {
      const p = await findPlaylist(ctx, playlist);
      return { playlist: p.name, ...(await restoreBackup(ctx.user, ctx.sp, p.id)) };
    },
  },
  {
    name: 'set_auto_deal',
    title: 'Schedule automatic deals',
    description: 'Re-deal a playlist automatically at 05:00 local time every day ("daily") or every Monday ("weekly"), or turn it "off".',
    readOnly: false,
    input: { playlist: playlistRef, schedule: z.enum(['off', 'daily', 'weekly']), fresh: z.boolean().default(true), time_zone: z.string().optional().describe('IANA zone, e.g. Europe/London') },
    async run(ctx, { playlist, schedule, fresh, time_zone }) {
      const p = await findPlaylist(ctx, playlist);
      if (!p.canEdit) throw new ServiceError(403, `“${p.name}” can’t be rewritten by dj.`);
      const tz = validTz(time_zone ?? store.getSchedule(ctx.user.id, p.id)?.tz ?? DEFAULT_TZ);
      const s = setSchedule(ctx.user.id, p.id, { every: schedule, tz, fresh, name: p.name });
      return { playlist: p.name, schedule, next_run: s ? new Date(s.nextRun).toISOString() : null, time_zone: tz };
    },
  },
  {
    name: 'create_playlist',
    title: 'Create a playlist from a list of songs',
    description: 'Create a new Spotify playlist from songs you choose (artist + title, or Spotify URIs). Each song is matched on Spotify; ones that can’t be found are reported back. By default the order is dealt so no artist plays twice in a row; set deal=false to keep your order (e.g. for an energy arc). Use this to build playlists with your own judgement, without dj’s AI.',
    readOnly: false,
    input: {
      name: z.string().min(1).max(100),
      description: z.string().max(300).default(''),
      songs: z.array(z.union([z.object({ artist: z.string(), title: z.string() }), z.string().describe('A spotify:track: URI')])).min(1).max(200),
      deal: z.boolean().default(true),
      clean_only: z.boolean().default(false).describe('Skip explicit versions (for kids)'),
    },
    async run(ctx, { name, description, songs, deal, clean_only }) {
      const found = [];
      const missing = [];
      for (const s of songs) {
        if (typeof s === 'string') {
          if (s.startsWith('spotify:track:')) found.push({ uri: s, name: s, artists: [{ id: null, name: '' }], album: { id: null, name: '' } });
          else missing.push(s);
          continue;
        }
        const t = await resolve(ctx.sp, { artist: s.artist, title: s.title }, { clean: clean_only });
        if (t && !found.some((f) => f.uri === t.uri)) found.push(t);
        else if (!t) missing.push(`${s.artist} — ${s.title}`);
      }
      if (!found.length) throw new ServiceError(400, `None of those songs were found on Spotify: ${missing.join('; ')}`);
      const r = await saveDealt(ctx.user, ctx.sp, { name, description, tracks: found, deal });
      return { playlist: name, url: r.url, added: found.length, missing };
    },
  },
  {
    name: 'brief_playlist',
    title: 'Make a playlist from a brief (dj’s AI)',
    description: 'Have dj’s own curator (using the server’s OpenRouter key) build and save a playlist from a plain-English brief and the user’s listening history, e.g. "running at 5:00/km, rock". Set minutes to make it last that long. Takes 20–60 seconds. If you’d rather choose the songs yourself, use create_playlist.',
    readOnly: false,
    input: {
      brief: z.string().min(3).max(600),
      songs: z.number().int().min(8).max(80).default(25),
      minutes: z.number().int().min(10).max(300).optional().describe('Make it last this long instead of a song count'),
      familiarity: z.number().min(0).max(1).default(0.5).describe('0 = all new to them, 1 = all familiar'),
      save: z.boolean().default(true),
    },
    async run(ctx, { brief, songs, minutes, familiarity, save }) {
      if (!aiEnabled()) throw new ServiceError(503, 'dj has no OpenRouter key, so its curator is off. Use create_playlist with your own song choices instead.');
      const r = await curate({ userId: ctx.user.id, sp: ctx.sp, brief, length: songs, familiarity, minutes: minutes ?? null });
      const out = { title: r.title, description: r.description, tempo: r.tempoTarget || null, minutes: Math.round(r.tracks.reduce((s, t) => s + t.durationMs, 0) / 60000), songs: r.tracks.map((t) => `${songLine(t)}${t.estBpm ? ` (~${t.estBpm} bpm)` : ''}`), not_found: r.missing };
      if (!save) return out;
      const saved = await saveDealt(ctx.user, ctx.sp, { name: r.title, description: r.description, tracks: r.tracks, deal: false });
      return { ...out, url: saved.url };
    },
  },
  {
    name: 'save_rediscover',
    title: 'Save a Rediscover playlist',
    description: 'Save one of the rediscover_list sets ("forgotten", "thisweek", "year-2024", …) as a dealt Spotify playlist. Saving again refreshes the same playlist.',
    readOnly: false,
    input: { set: z.string() },
    async run(ctx, { set }) {
      const s = rediscover(grownRows(ctx.user.id)).find((x) => x.id === set);
      if (!s || s.tracks.length < 2) throw new ServiceError(404, s?.needs ?? `No set “${set}”. Use rediscover_list.`);
      const r = await saveDealt(ctx.user, ctx.sp, { key: `rediscover:${s.id}`, name: s.title, description: `${s.blurb} Made by dj from your play history.`, tracks: s.tracks });
      return { playlist: s.title, url: r.url, refreshed: r.updated, songs: r.tracks };
    },
  },
  {
    name: 'save_together',
    title: 'Save the two-person blend',
    description: 'Save (or refresh) the blend for both household members as a dealt Spotify playlist on this user’s account.',
    readOnly: false,
    input: { size: z.number().int().min(20).max(100).default(50) },
    async run(ctx, { size }) {
      const r = await saveBlend(ctx.user, ctx.sp, size);
      return { url: r.url, refreshed: r.updated, songs: r.tracks };
    },
  },
  {
    name: 'kids_play',
    title: 'Start a Kids mode button',
    description: 'Start one of the Kids mode buttons (see kids_buttons) on whichever Spotify device is awake, freshly dealt, with its sleep timer if it has one. Needs Spotify Premium.',
    readOnly: false,
    input: { button: z.string().describe('Button id or name') },
    async run(ctx, { button }) {
      const list = store.kidsPlaylists(ctx.user.id);
      const b = list.find((p) => p.id === button) ?? list.find((p) => lower(p.name) === lower(button)) ?? list.find((p) => lower(p.name).includes(lower(button)));
      if (!b) throw new ServiceError(404, `No Kids button “${button}”. Buttons: ${list.map((p) => p.name).join(', ') || 'none yet'}.`);
      return kidsPlay(ctx.user, ctx.sp, b.id);
    },
  },
  {
    name: 'player',
    title: 'Playback control',
    description: 'Pause, resume or skip to the next song on the user’s active Spotify device. Needs Spotify Premium.',
    readOnly: false,
    input: { action: z.enum(['pause', 'resume', 'next']) },
    async run(ctx, { action }) {
      await { pause: ctx.sp.pause, resume: ctx.sp.resume, next: ctx.sp.next }[action]();
      return { ok: true, action };
    },
  },
];

export const actionByName = new Map(actions.map((a) => [a.name, a]));

/** Validate args and run an action. Throws ServiceError on bad input or denied writes. */
export async function runAction(ctx, name, rawArgs = {}) {
  const action = actionByName.get(name);
  if (!action) throw new ServiceError(404, `Unknown action “${name}”.`);
  if (!action.readOnly && ctx.readOnly) throw new ServiceError(403, `This token is read-only, so it can’t run ${name}.`);
  const parsed = z.object(action.input).strict().safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ServiceError(400, `Bad arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  try {
    return await action.run(ctx, parsed.data);
  } catch (err) {
    if (!(err instanceof SpotifyError)) throw err;
    // Spotify's own messages are terse; say what to do about it.
    const msg =
      err.status === 401
        ? 'Spotify sign-in for this person has expired. Open dj in a browser and connect Spotify again.'
        : err.status === 403 && /premium/i.test(err.message)
          ? 'Controlling playback needs Spotify Premium on this account.'
          : err.status === 404 && /device/i.test(err.message)
            ? 'No Spotify device is awake. Open Spotify on a phone, computer or speaker first.'
            : err.status === 403
              ? `Spotify refused that (${err.message}). Apps can only read or change playlists the person owns or collaborates on.`
              : `Spotify error ${err.status}: ${err.message}`;
    throw new ServiceError(err.status === 401 ? 401 : err.status >= 500 ? 502 : err.status, msg);
  }
}

/** JSON Schema for an action's input (for the HTTP API, OpenAPI and the CLI). */
export const inputSchema = (action) => {
  const { $schema, ...rest } = z.toJSONSchema(z.object(action.input), { io: 'input' });
  return rest;
};
