// Bedtime fade for Kids mode: after a set time, the volume eases down over the
// last few minutes and the music pauses. Runs on the server, so it keeps
// going when the phone screen locks. Timers are in memory: a restart cancels them.

// SLEEP_MINUTE_MS only exists so tests can run a "20 minute" timer in seconds.
const MINUTE = Number(process.env.SLEEP_MINUTE_MS ?? 60_000);
const FADE_MS = 10 * MINUTE; // fade over the last 10 minutes
const STEPS = 10;
const timers = new Map(); // userId -> { endsAt, fading, cancel }

export function sleepStatus(userId) {
  const t = timers.get(userId);
  return t ? { endsAt: t.endsAt, fading: t.fading } : null;
}

export function cancelSleep(userId) {
  timers.get(userId)?.cancel();
  timers.delete(userId);
}

/**
 * Start a sleep timer for whatever `contextUri` is now playing. If someone
 * switches to other music, the timer quietly stands down.
 */
export function startSleep(userId, sp, { contextUri, minutes, deviceId }) {
  cancelSleep(userId);
  const total = minutes * MINUTE;
  const fadeLen = Math.min(FADE_MS, total);
  const endsAt = Date.now() + total;
  const handles = [];
  const entry = { endsAt, fading: false, cancel: () => handles.forEach(clearTimeout) };
  timers.set(userId, entry);
  const later = (ms, fn) => handles.push(setTimeout(() => fn().catch((err) => console.error('sleep:', err.message)), Math.max(0, ms)));

  const stillOurs = async () => {
    const st = await sp.playerState();
    return st && st.context?.uri === contextUri ? st : null;
  };

  later(total - fadeLen, async () => {
    const st = await stillOurs();
    if (!st?.is_playing) return cancelSleep(userId);
    entry.fading = true;
    const startVol = st.device?.volume_percent ?? null;
    const canFade = st.device?.supports_volume !== false && startVol != null;
    if (canFade) {
      for (let k = 1; k <= STEPS; k++) {
        later((fadeLen / STEPS) * (k - 1), async () => {
          if (!timers.has(userId) || !(await stillOurs())) return cancelSleep(userId);
          await sp.setVolume(Math.max(4, Math.round(startVol * (1 - k / (STEPS + 1)))), deviceId);
        });
      }
    }
    later(fadeLen, async () => {
      if (!timers.has(userId)) return;
      if (await stillOurs()) await sp.pause();
      // Put the volume back for next time, once it's quiet.
      if (canFade) later(3000, () => sp.setVolume(startVol, deviceId));
      timers.delete(userId);
    });
  });
  return { endsAt };
}
