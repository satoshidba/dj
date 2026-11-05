// End to end: mock Spotify + the real server, then MCP, HTTP API and CLI with
// personal access tokens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MOCK = 9199;
const PORT = 8181;
const BASE = `http://localhost:${PORT}`;
const root = path.resolve(import.meta.dirname, '..');
const procs = [];
let full;
let ro;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error(`${url} never came up`);
}

before(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-agents-'));
  procs.push(spawn(process.execPath, ['test/mock-services.js'], { cwd: root, env: { ...process.env, MOCK_PORT: String(MOCK) }, stdio: 'ignore' }));
  await up(`http://127.0.0.1:${MOCK}/mock/player`);
  procs.push(
    spawn(process.execPath, ['server/index.js'], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(PORT), DATA_DIR: data, APP_URL: BASE, SPOTIFY_CLIENT_ID: 'x', SPOTIFY_CLIENT_SECRET: 'y', SPOTIFY_API_BASE: `http://127.0.0.1:${MOCK}/v1`, SPOTIFY_ACCOUNTS_BASE: `http://127.0.0.1:${MOCK}/accounts`, ANTHROPIC_API_KEY: '' },
    }),
  );
  await up(`${BASE}/api/session`);

  // Log in through the OAuth dance by hand, keeping cookies.
  const jar = new Map();
  const keep = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      jar.set(k, v);
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let url = `${BASE}/login`;
  for (let i = 0; i < 5 && url; i++) {
    const res = await fetch(url, { redirect: 'manual', headers: { cookie: cookie() } });
    keep(res);
    url = res.headers.get('location');
    if (url && url.startsWith('/')) url = null;
  }
  const mk = async (body) => (await fetch(`${BASE}/api/tokens`, { method: 'POST', headers: { cookie: cookie(), 'x-dj': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  full = (await mk({ name: 'full' })).token;
  ro = (await mk({ name: 'ro', readOnly: true })).token;
  assert.match(full, /^dj_/);
});

after(() => procs.forEach((p) => p.kill()));

async function mcp(token) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

test('MCP: full token lists every tool and can deal a playlist by name', async () => {
  const c = await mcp(full);
  const { tools } = await c.listTools();
  assert.ok(tools.length >= 19);
  const r = await c.callTool({ name: 'deal_playlist', arguments: { playlist: 'gym rock' } });
  assert.ok(!r.isError, r.content[0].text);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.after.backToBack, 0);
  await c.close();
});

test('MCP: read-only token only sees read tools', async () => {
  const c = await mcp(ro);
  const { tools } = await c.listTools();
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
  assert.ok(tools.some((t) => t.name === 'listening_stats'));
  await c.close();
});

test('MCP: bad token is refused', async () => {
  await assert.rejects(mcp('dj_nope'));
});

test('HTTP: read-only token cannot change things; bad args explained', async () => {
  const post = (name, body, token = ro) => fetch(`${BASE}/api/v1/actions/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('deal_playlist', { playlist: 'gym' })).status, 403);
  const bad = await post('listening_stats', { range: 'week' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /range/);
  assert.equal((await post('list_playlists', {})).status, 200);
});

test('a valid token still works after many bad attempts from the same address', async () => {
  for (let i = 0; i < 25; i++) await fetch(`${BASE}/api/v1/actions`, { headers: { Authorization: `Bearer dj_bad${i}` } });
  const bad = await fetch(`${BASE}/api/v1/actions`, { headers: { Authorization: 'Bearer dj_bad' } });
  assert.equal(bad.status, 429);
  const good = await fetch(`${BASE}/api/v1/actions`, { headers: { Authorization: `Bearer ${full}` } });
  assert.equal(good.status, 200);
});

const cli = (args, token = full) =>
  new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, 'cli', 'dj.mjs'), ...args], { env: { ...process.env, DJ_URL: BASE, DJ_TOKEN: token } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });

test('CLI: positional value, options and JSON output', async () => {
  const r = await cli(['set_auto_deal', 'Gym Rock', '--schedule', 'daily', '--time-zone', 'Europe/London', '--compact']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).schedule, 'daily');
});

test('CLI: read-only token gets a clear message', async () => {
  const r = await cli(['deal_playlist', 'Gym Rock'], ro);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /read-only/);
});

test('OpenAPI and skill are served', async () => {
  const o = await (await fetch(`${BASE}/api/v1/openapi.json`)).json();
  assert.ok(o.paths['/actions/deal_playlist']);
  assert.match(await (await fetch(`${BASE}/skill/SKILL.md`)).text(), /^---\nname: dj/);
});
