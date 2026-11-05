// Tiny JSON-file store. Two users don't need a database; a Docker volume
// mounted at DATA_DIR keeps logins, sessions and shuffle backups across restarts.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const FILE = path.join(DATA_DIR, 'store.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let state = { users: {}, sessions: {}, backups: {}, likedPlaylist: {}, kids: [], kidsPlaylists: {}, schedules: {}, made: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (err) {
  if (err.code !== 'ENOENT') console.error('store: could not read, starting fresh', err.message);
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }, 50);
}

export const store = {
  getUser: (id) => state.users[id] ?? null,
  putUser(user) {
    state.users[user.id] = { ...state.users[user.id], ...user };
    save();
    return state.users[user.id];
  },
  allUsers: () => Object.values(state.users),

  sessionUser: (sid) => (sid && state.sessions[sid] ? state.users[state.sessions[sid].userId] ?? null : null),
  createSession(sid, userId) {
    state.sessions[sid] = { userId, createdAt: Date.now() };
    save();
  },
  deleteSession(sid) {
    delete state.sessions[sid];
    save();
  },

  // One backup per (user, playlist): the order before the last time we rewrote it.
  getBackup: (userId, playlistId) => state.backups[`${userId}:${playlistId}`] ?? null,
  putBackup(userId, playlistId, uris) {
    state.backups[`${userId}:${playlistId}`] = { uris, at: Date.now() };
    save();
  },

  // The playlist we write "Liked Songs, shuffled" into, so it's reused each time.
  getLikedPlaylist: (userId) => state.likedPlaylist[userId] ?? null,
  setLikedPlaylist(userId, playlistId) {
    state.likedPlaylist[userId] = playlistId;
    save();
  },

  // Kids profiles are shared by the household; their playlists live on
  // whichever grown-up's Spotify account made them.
  kids: () => state.kids,
  setKids(kids) {
    state.kids = kids;
    save();
  },
  // Auto-deal: { [userId]: { [playlistId]: { every, tz, fresh, name, nextRun, lastRun, lastError } } }
  getSchedule: (userId, playlistId) => state.schedules[userId]?.[playlistId] ?? null,
  schedulesFor: (userId) => state.schedules[userId] ?? {},
  allSchedules: () => Object.entries(state.schedules).flatMap(([userId, m]) => Object.entries(m).map(([playlistId, s]) => ({ userId, playlistId, ...s }))),
  setSchedule(userId, playlistId, sched) {
    state.schedules[userId] ??= {};
    if (sched) state.schedules[userId][playlistId] = sched;
    else delete state.schedules[userId][playlistId];
    save();
  },

  // Playlists dj generated and refreshes in place (rediscover sets, the blend).
  getMade: (userId, key) => state.made[userId]?.[key] ?? null,
  setMade(userId, key, playlistId) {
    state.made[userId] ??= {};
    state.made[userId][key] = playlistId;
    save();
  },

  kidsPlaylists: (userId) => state.kidsPlaylists[userId] ?? [],
  setKidsPlaylists(userId, list) {
    state.kidsPlaylists[userId] = list;
    save();
  },
};
