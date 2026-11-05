// Tiny JSON-file store. Two users don't need a database; a Docker volume
// mounted at DATA_DIR keeps logins, sessions and shuffle backups across restarts.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const FILE = path.join(DATA_DIR, 'store.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let state = { users: {}, sessions: {}, backups: {}, likedPlaylist: {} };
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
};
