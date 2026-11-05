// Logic shared by the web app's routes and the agent actions (MCP, HTTP API,
// CLI), so every way into dj behaves the same.
import { store } from './store.js';
import { properShuffle } from './shuffle.js';
import { playsFor } from './plays.js';
import { kidsContexts } from './curator.js';
import { blend, wrapped, wrappedPeriods } from './insights.js';
import { startSleep, cancelSleep, sleepStatus } from './sleep.js';

export class ServiceError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** A person's own plays, with Kids mode plays left out. */
export function grownRows(userId) {
  const kidsCtx = kidsContexts(userId);
  return playsFor(userId).filter((r) => !(r.ctx && kidsCtx.has(r.ctx)));
}

export const asTrack = (t) => ({ uri: t.uri, name: t.name, artists: t.artists ?? [{ id: null, name: t.artist }], album: { id: null, name: typeof t.album === 'string' ? t.album : t.album?.name ?? '' } });

export const sameTracks = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Create (or refresh, if dj made it before under `key`) a playlist in a dealt order. */
export async function saveDealt(user, sp, { key, name, description, tracks, deal = true }) {
  const order = (deal ? properShuffle(tracks.map(asTrack)) : tracks).map((t) => t.uri);
  const made = key ? store.getMade(user.id, key) : null;
  let id = made;
  if (id) {
    try {
      await sp.updatePlaylistDetails(id, { name, description });
    } catch (err) {
      if (err.status === 404 || err.status === 403) id = null;
      else throw err;
    }
  }
  if (!id) {
    id = (await sp.createPlaylist({ name, description })).id;
    if (key) store.setMade(user.id, key, id);
  }
  await sp.replacePlaylistItems(id, order);
  return { id, url: `https://open.spotify.com/playlist/${id}`, updated: !!made && made === id, tracks: order.length };
}

/** Put a playlist back to the order it had before dj last rewrote it. */
export async function restoreBackup(user, sp, id) {
  const backup = store.getBackup(user.id, id);
  if (!backup) throw new ServiceError(404, 'Nothing to restore');
  const current = await sp.playlistTracks(id);
  if (!sameTracks(current.map((t) => t.uri), backup.uris)) {
    throw new ServiceError(409, 'Tracks were added or removed since the shuffle, so the old order no longer fits.');
  }
  await sp.replacePlaylistItems(id, backup.uris);
  return { ok: true };
}

export function partnerOf(user) {
  return store.allUsers().find((u) => u.id !== user.id) ?? null;
}

export function blendFor(user, size = 50) {
  const partner = partnerOf(user);
  if (!partner) return null;
  const n = Math.min(100, Math.max(20, Number(size) || 50));
  return { partner, key: `blend:${[user.id, partner.id].sort().join('+')}`, ...blend(grownRows(user.id), grownRows(partner.id), { size: n }) };
}

export async function saveBlend(user, sp, size) {
  const b = blendFor(user, size);
  if (!b || b.tracks.length < 2) throw new ServiceError(400, 'Both of you need some play history first.');
  const names = [user.name, b.partner.name].map((n) => n.split(' ')[0]);
  return saveDealt(user, sp, { key: b.key, name: `${names[0]} + ${names[1]}`, description: 'Both of you, evenly: songs you both play, then each person’s favourites. Made by dj from your play histories.', tracks: b.tracks });
}

/** Wrapped for a period ("2026" / "2026-10"), defaulting to last full month. */
export function wrappedFor(user, period, tz = 'UTC') {
  const rows = grownRows(user.id);
  const periods = wrappedPeriods(rows, tz);
  const p = /^\d{4}(-\d{2})?$/.test(period ?? '') ? period : periods.months[1] ?? periods.months[0] ?? periods.years[0];
  if (!p) return { periods, wrapped: null };
  const w = wrapped(rows, p, tz);
  let prev;
  if (p.length === 4) prev = String(Number(p) - 1);
  else {
    const [y, m] = p.split('-').map(Number);
    prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  }
  const pw = wrapped(rows, prev, tz);
  return { periods, wrapped: w && { ...w, prevPlays: pw?.plays ?? null, prevLabel: pw?.label ?? null } };
}

/** Start a Kids mode button on the awake device, freshly dealt, with its sleep timer. */
export async function kidsPlay(user, sp, playlistId) {
  const entry = store.kidsPlaylists(user.id).find((p) => p.id === playlistId);
  if (!entry) throw new ServiceError(404, 'Not a Kids mode playlist');
  const openUrl = `https://open.spotify.com/playlist/${entry.id}`;
  if (entry.redeal) {
    const tracks = await sp.playlistTracks(entry.id);
    if (tracks.length > 1 && !tracks.some((t) => t.local)) {
      await sp.replacePlaylistItems(entry.id, properShuffle(tracks).map((t) => t.uri));
    }
  }
  const devices = await sp.devices();
  const device = devices.find((d) => d.is_active) ?? devices.find((d) => !d.is_restricted);
  if (!device) throw new ServiceError(409, 'No Spotify device is awake. Open Spotify on the phone or speaker, then try again.', { openUrl });
  await sp.setShuffle(false, device.id).catch(() => {});
  await sp.play(`spotify:playlist:${entry.id}`, device.id);
  const contextUri = `spotify:playlist:${entry.id}`;
  const sleep = entry.sleep ? startSleep(user.id, sp, { contextUri, minutes: entry.sleep, deviceId: device.id }) : (cancelSleep(user.id), null);
  return { ok: true, playing: entry.name, device: device.name, sleep };
}

export async function nowPlaying(user, sp) {
  const st = await sp.playerState();
  const t = st?.item;
  return {
    playing: !!st?.is_playing,
    device: st?.device?.name ?? null,
    context: st?.context?.uri ?? null,
    track: t ? { name: t.name, artists: (t.artists ?? []).map((a) => a.name).join(', '), image: t.album?.images?.[0]?.url ?? null } : null,
    sleep: sleepStatus(user.id),
  };
}
