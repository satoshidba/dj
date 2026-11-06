import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { authorizeUrl, exchangeCode } from '../server/spotify.js';

test('Spotify authorization and token exchange use PKCE without a client secret', async () => {
  process.env.SPOTIFY_CLIENT_ID = 'client';
  process.env.APP_URL = 'https://dj.example';
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const auth = new URL(authorizeUrl('state', challenge));
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('code_challenge'), challenge);
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body.get('client_id'), 'client');
    assert.equal(options.body.get('code_verifier'), verifier);
    assert.equal(options.body.get('redirect_uri'), 'https://dj.example/callback');
    return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }) };
  };
  try { assert.equal((await exchangeCode('code', verifier)).refreshToken, 'refresh'); }
  finally { globalThis.fetch = original; }
});
