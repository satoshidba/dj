// Auto-deal: re-deal chosen playlists overnight so they're fresh every
// morning (or every Monday) without opening dj.
import { store } from './store.js';
import { spotifyFor } from './spotify.js';
import { dealAndWrite } from './deal.js';

export const AUTO_HOUR = Number(process.env.AUTODEAL_HOUR ?? 5); // local time
const TICK_MS = 5 * 60 * 1000;

/** Next time it's AUTO_HOUR:00 in `tz` (and a Monday, for weekly). DST-safe. */
export function nextRunAt(every, tz, from = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  let t = Math.floor(from / 3_600_000) * 3_600_000 + 3_600_000; // next whole hour (UTC)
  for (let i = 0; i < 24 * 9; i++, t += 3_600_000) {
    // Half-hour zones: test the half hour too.
    for (const cand of [t, t + 1_800_000]) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(cand)).map((x) => [x.type, x.value]));
      const minute = new Date(cand).toLocaleString('en-GB', { timeZone: tz, minute: '2-digit' });
      if (Number(p.hour) === AUTO_HOUR && Number(minute) === 0 && (every === 'daily' || p.weekday === 'Mon')) return cand;
    }
  }
  return from + 24 * 3_600_000;
}

export function setSchedule(userId, playlistId, { every, tz, fresh = true, name }) {
  if (!['daily', 'weekly'].includes(every)) {
    store.setSchedule(userId, playlistId, null);
    return null;
  }
  const prev = store.getSchedule(userId, playlistId);
  const sched = { ...prev, every, tz, fresh: !!fresh, name: name ?? prev?.name ?? '', nextRun: nextRunAt(every, tz) };
  store.setSchedule(userId, playlistId, sched);
  return sched;
}

let running = false;
export async function runDue(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    for (const s of store.allSchedules()) {
      if (!s.nextRun || s.nextRun > now) continue;
      const user = store.getUser(s.userId);
      if (!user?.tokens) continue;
      let lastError = null;
      try {
        const r = await dealAndWrite(s.userId, spotifyFor(s.userId), s.playlistId, { fresh: s.fresh });
        if (r.skipped) lastError = `Skipped: ${r.skipped}`;
      } catch (err) {
        lastError = err.message;
        console.error(`autodeal: ${s.userId}/${s.playlistId}:`, err.message);
        // Gone or no longer ours: stop trying.
        if (err.status === 404 || err.status === 403) {
          store.setSchedule(s.userId, s.playlistId, null);
          continue;
        }
      }
      const { userId, playlistId, ...rest } = s;
      store.setSchedule(userId, playlistId, { ...rest, lastRun: Date.now(), lastError, nextRun: nextRunAt(s.every, s.tz, Math.max(now, s.nextRun) + 60_000) });
    }
  } finally {
    running = false;
  }
}

export function startAutoDeal() {
  runDue();
  setInterval(runDue, TICK_MS).unref();
}
