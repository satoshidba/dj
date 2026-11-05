// Dealing a playlist and writing it back, shared by the Deal button and the
// overnight auto-deal.
import { store } from './store.js';
import { properShuffle } from './shuffle.js';
import { playsFor, stalenessFor } from './plays.js';
import { kidsContexts } from './curator.js';

/** Staleness function for a person's songs (or null if they have no log yet). */
export function stalenessForUser(userId) {
  const fn = stalenessFor(playsFor(userId), { kidsCtx: kidsContexts(userId) });
  return fn.known ? fn : null;
}

export class DealError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Write a dealt order back to Spotify. Liked Songs can't be reordered, so it
 * goes into a reusable "Liked Songs, dealt" playlist; everything else is
 * rewritten in place after saving the previous order for undo.
 */
export async function writeOrder(userId, sp, id, currentTracks, uris) {
  if (currentTracks.some((t) => t.local)) {
    throw new DealError(422, 'This playlist has local files, which Spotify won’t let apps write back. Save it as a new playlist instead (local files will be left out).');
  }
  if (id === 'liked') {
    let target = store.getLikedPlaylist(userId);
    const name = 'Liked Songs, dealt';
    const description = `Your Liked Songs, properly shuffled by dj on ${new Date().toDateString()}. Play in order.`;
    if (target) {
      try {
        await sp.updatePlaylistDetails(target, { name, description });
      } catch (err) {
        if (err.status === 404 || err.status === 403) target = null;
        else throw err;
      }
    }
    if (!target) {
      target = (await sp.createPlaylist({ name, description })).id;
      store.setLikedPlaylist(userId, target);
    }
    await sp.replacePlaylistItems(target, uris);
    return { url: `https://open.spotify.com/playlist/${target}`, canRestore: false };
  }
  store.putBackup(userId, id, currentTracks.map((t) => t.uri));
  await sp.replacePlaylistItems(id, uris);
  return { url: `https://open.spotify.com/playlist/${id}`, canRestore: true };
}

/** Fetch, deal and write in one go (used by auto-deal). */
export async function dealAndWrite(userId, sp, id, { fresh = true } = {}) {
  const tracks = id === 'liked' ? await sp.likedTracks() : await sp.playlistTracks(id);
  if (tracks.length < 2) return { skipped: 'fewer than two tracks' };
  const staleness = fresh ? stalenessForUser(userId) : null;
  const order = properShuffle(tracks, { staleness: staleness ?? undefined });
  return writeOrder(userId, sp, id, tracks, order.map((t) => t.uri));
}
