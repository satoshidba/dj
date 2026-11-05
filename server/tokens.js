// Personal access tokens for agents and scripts (MCP, HTTP API, CLI).
//
// A token acts as one person. Only a SHA-256 hash is stored; the token itself
// is shown once when it's created. Tokens can be read-only and revoked.
import crypto from 'node:crypto';
import { store } from './store.js';

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createToken(user, { name, readOnly = false }) {
  const token = `dj_${crypto.randomBytes(32).toString('base64url')}`;
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name || 'Agent').slice(0, 60),
    hash: hash(token),
    hint: `${token.slice(0, 7)}…${token.slice(-4)}`,
    readOnly: !!readOnly,
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  store.putUser({ id: user.id, apiTokens: [...(store.getUser(user.id).apiTokens ?? []), entry] });
  return { token, entry: publicEntry(entry) };
}

const publicEntry = ({ hash: _h, ...e }) => e;

export const listTokens = (user) => (store.getUser(user.id).apiTokens ?? []).map(publicEntry);

export function revokeToken(user, id) {
  store.putUser({ id: user.id, apiTokens: (store.getUser(user.id).apiTokens ?? []).filter((t) => t.id !== id) });
  return listTokens(user);
}

/** Look a token up. Returns { user, entry } or null. */
export function findToken(token) {
  if (typeof token !== 'string' || !token.startsWith('dj_') || token.length > 100) return null;
  const h = hash(token);
  for (const user of store.allUsers()) {
    const entry = (user.apiTokens ?? []).find((t) => crypto.timingSafeEqual(Buffer.from(t.hash), Buffer.from(h)));
    if (entry) {
      // Don't rewrite the store on every request: once a minute is plenty.
      if (!entry.lastUsedAt || Date.now() - entry.lastUsedAt > 60_000) {
        store.putUser({ id: user.id, apiTokens: user.apiTokens.map((t) => (t.id === entry.id ? { ...t, lastUsedAt: Date.now() } : t)) });
      }
      return { user: store.getUser(user.id), entry };
    }
  }
  return null;
}

// ---------------------------------------------------------- rate limiting --
// Failed sign-ins (bad tokens, failed passkeys) per client address: after 20
// in 10 minutes, that address is told to wait.

const failures = new Map();
const WINDOW = 10 * 60 * 1000;
const LIMIT = 20;

export function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() > f.resetAt) return false;
  return f.count >= LIMIT;
}

export function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() > f.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + WINDOW });
  else f.count++;
  if (failures.size > 5000) for (const [k, v] of failures) if (Date.now() > v.resetAt) failures.delete(k);
}
