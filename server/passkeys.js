// Passkeys: sign in to dj with Face ID / Touch ID / a fingerprint instead of
// going through Spotify on every device.
//
// Spotify is still how a person *links* their account the first time (dj needs
// their Spotify tokens), but after that any device can sign in to dj with a
// passkey. Passkeys need HTTPS on a stable hostname — e.g. Tailscale's
// https://<machine>.<tailnet>.ts.net — because each passkey is bound to it.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { store } from './store.js';

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const ORIGIN = APP_URL ? new URL(APP_URL).origin : '';
const HOST = APP_URL ? new URL(APP_URL).hostname : '';
const RP_ID = process.env.PASSKEY_RP_ID || HOST;

// WebAuthn needs a secure context and a domain name: https://anything, or
// http://localhost. IP addresses (127.0.0.1, 100.x Tailscale IPs) can't be an RP ID.
const isIp = /^[\d.]+$|:/.test(HOST);
export const passkeysAvailable = !!HOST && !isIp && (APP_URL.startsWith('https://') || HOST === 'localhost');
export const passkeysWhyNot = passkeysAvailable
  ? null
  : isIp
    ? 'Passkeys need a hostname, not an IP address. Use your https://…ts.net Tailscale address as APP_URL.'
    : 'Passkeys need HTTPS. Use your https://…ts.net Tailscale address as APP_URL.';

// Challenges live for 5 minutes, keyed by a random id held in a cookie.
const challenges = new Map();
const CHALLENGE_TTL = 5 * 60 * 1000;
function putChallenge(data) {
  const id = crypto.randomBytes(16).toString('hex');
  challenges.set(id, { ...data, at: Date.now() });
  for (const [k, v] of challenges) if (Date.now() - v.at > CHALLENGE_TTL) challenges.delete(k);
  return id;
}
function takeChallenge(id) {
  const c = id && challenges.get(id);
  challenges.delete(id);
  return c && Date.now() - c.at <= CHALLENGE_TTL ? c : null;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

export function listPasskeys(user) {
  return (user.passkeys ?? []).map(({ id, name, createdAt, lastUsedAt, backedUp }) => ({ id, name, createdAt, lastUsedAt, backedUp }));
}

// ------------------------------------------------------------- register ----

export async function registrationOptions(user) {
  const options = await generateRegistrationOptions({
    rpName: 'dj',
    rpID: RP_ID,
    userName: user.name || user.id,
    userDisplayName: user.name || user.id,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: (user.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = putChallenge({ kind: 'reg', userId: user.id, challenge: options.challenge });
  return { options, challengeId };
}

export async function registerPasskey(user, challengeId, response, name) {
  const c = takeChallenge(challengeId);
  if (!c || c.kind !== 'reg' || c.userId !== user.id) throw new PasskeyError('That took too long. Try again.');
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: false,
  });
  if (!v.verified || !v.registrationInfo) throw new PasskeyError('The passkey couldn’t be verified.');
  const { credential, credentialBackedUp } = v.registrationInfo;
  const fresh = store.getUser(user.id);
  const passkeys = (fresh.passkeys ?? []).filter((p) => p.id !== credential.id);
  passkeys.push({
    id: credential.id,
    publicKey: b64(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? response.response?.transports ?? [],
    name: String(name || 'Passkey').slice(0, 60),
    backedUp: !!credentialBackedUp,
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  store.putUser({ id: user.id, passkeys });
  return listPasskeys(store.getUser(user.id));
}

export function removePasskey(user, id) {
  store.putUser({ id: user.id, passkeys: (user.passkeys ?? []).filter((p) => p.id !== id) });
  return listPasskeys(store.getUser(user.id));
}

// --------------------------------------------------------- authenticate ----

export async function authenticationOptions() {
  // No allowCredentials: the device offers whichever dj passkeys it holds,
  // so nobody has to type a username.
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred' });
  const challengeId = putChallenge({ kind: 'auth', challenge: options.challenge });
  return { options, challengeId };
}

/** Returns the user the passkey belongs to, or throws. */
export async function authenticate(challengeId, response) {
  const c = takeChallenge(challengeId);
  if (!c || c.kind !== 'auth') throw new PasskeyError('That took too long. Try again.');
  const owner = store.allUsers().find((u) => (u.passkeys ?? []).some((p) => p.id === response?.id));
  if (!owner) throw new PasskeyError('This passkey isn’t registered with dj any more. Connect Spotify to sign in, then add a new one.');
  const pk = owner.passkeys.find((p) => p.id === response.id);
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: { id: pk.id, publicKey: unb64(pk.publicKey), counter: pk.counter, transports: pk.transports },
    requireUserVerification: false,
  });
  if (!v.verified) throw new PasskeyError('The passkey couldn’t be verified.');
  store.putUser({
    id: owner.id,
    passkeys: owner.passkeys.map((p) => (p.id === pk.id ? { ...p, counter: v.authenticationInfo.newCounter, lastUsedAt: Date.now() } : p)),
  });
  return owner;
}

export class PasskeyError extends Error {}
