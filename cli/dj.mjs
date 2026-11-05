#!/usr/bin/env node
// dj — command line for your dj server. Works for people, scripts, and any
// agent that can run shell commands (Pi, Hermes, Claude Code, …).
//
//   dj login https://dj.example.ts.net dj_xxxxx    save where dj is and your token
//   dj actions                                     list what you can do
//   dj help deal_playlist                          details and options for one
//   dj deal_playlist "Gym Rock"                    run one (first argument fills the main option)
//   dj listening_stats --range 7d
//   dj create_playlist --json '{"name":"x","songs":[{"artist":"a","title":"b"}]}'
//
// Config: DJ_URL / DJ_TOKEN env vars, or ~/.config/dj/config.json (written by `dj login`).
// Output is JSON on stdout; errors go to stderr with a non-zero exit code.
// No dependencies; needs Node 18+.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dj', 'config.json');

function readConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    /* no config yet */
  }
  return { url: (process.env.DJ_URL || file.url || '').replace(/\/$/, ''), token: process.env.DJ_TOKEN || file.token || '' };
}

function die(msg, code = 1) {
  process.stderr.write(`dj: ${msg}\n`);
  process.exit(code);
}

async function call(cfg, method, p, body) {
  if (!cfg.url || !cfg.token) die('not set up. Run: dj login <your dj url> <token>  (make a token in dj: avatar menu → Agents & API)', 2);
  let res;
  try {
    res = await fetch(`${cfg.url}${p}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    die(`can't reach ${cfg.url} (${err.cause?.code || err.message}). Is it running, and are you on the tailnet?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `HTTP ${res.status}`, res.status === 401 || res.status === 403 ? 3 : 1);
  return data;
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, flags.compact ? 0 : 2)}\n`);

// ---------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
const flags = { compact: false };
const positional = [];
const opts = {};
const raw = {}; // the original strings, in case the schema wants text
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--compact') flags.compact = true;
  else if (a === '--json') Object.assign(opts, parseJson(argv[++i]));
  else if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const key = k.replace(/-/g, '_');
    const v = inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    raw[key] = v;
    opts[key] = coerce(v);
  } else positional.push(a);
}

function parseJson(s) {
  try {
    return JSON.parse(s ?? '');
  } catch {
    die('--json needs valid JSON');
  }
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{]/.test(v)) return parseJson(v);
  return v;
}

// ------------------------------------------------------------ commands ----

const [cmd, ...rest] = positional;
const cfg = readConfig();

if (!cmd || cmd === 'help' && !rest[0]) {
  process.stdout.write(`dj — your dj server from the command line

  dj login <url> <token>       save your dj address and access token
  dj whoami                    check the connection
  dj actions                   list actions (read-only tokens see fewer)
  dj help <action>             what an action does and its options
  dj <action> [value] [--option value ...] [--json '{...}'] [--compact]

Examples:
  dj listening_stats --range 7d
  dj deal_playlist "Gym Rock"
  dj set_auto_deal "Gym Rock" --schedule daily
  dj brief_playlist "45 minute run, rock, 5:00/km" --minutes 45
`);
  process.exit(0);
}

if (cmd === 'login') {
  const [url, token] = rest;
  if (!url || !token) die('usage: dj login <url> <token>');
  const test = { url: url.replace(/\/$/, ''), token };
  const me = await call(test, 'GET', '/api/v1/actions');
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(test, null, 2), { mode: 0o600 });
  out({ ok: true, saved: CONFIG, user: me.user.name, read_only: me.read_only });
  process.exit(0);
}

if (cmd === 'whoami') {
  const me = await call(cfg, 'GET', '/api/v1/actions');
  out({ url: cfg.url, user: me.user.name, read_only: me.read_only, actions: me.actions.length });
  process.exit(0);
}

if (cmd === 'actions') {
  const { actions } = await call(cfg, 'GET', '/api/v1/actions');
  if (flags.compact) out(actions.map((a) => a.name));
  else for (const a of actions) process.stdout.write(`${a.name.padEnd(18)} ${a.read_only ? '     ' : '[set]'} ${a.title}\n`);
  process.exit(0);
}

const { actions, hidden_by_read_only: hidden = [] } = await call(cfg, 'GET', '/api/v1/actions');
const name = (cmd === 'help' ? rest[0] : cmd).replace(/-/g, '_');
const action = actions.find((a) => a.name === name);
if (!action && hidden.includes(name)) die(`${name} changes things, and this token is read-only. Make a full token in dj to use it.`, 3);
if (!action) die(`unknown action "${name}". Run: dj actions`);

if (cmd === 'help') {
  const props = action.input.properties ?? {};
  const req = new Set(action.input.required ?? []);
  process.stdout.write(`${action.name}${action.read_only ? '' : '  (changes things)'}\n\n${action.description}\n\nOptions:\n`);
  for (const [k, s] of Object.entries(props)) {
    const type = s.enum ? s.enum.join('|') : s.type ?? (s.anyOf ? 'value' : 'json');
    process.stdout.write(`  --${k.replace(/_/g, '-')} <${type}>${req.has(k) ? '  required' : ''}${s.default !== undefined ? `  default ${JSON.stringify(s.default)}` : ''}${s.description ? `\n      ${s.description}` : ''}\n`);
  }
  if (!Object.keys(props).length) process.stdout.write('  (none)\n');
  process.exit(0);
}

// A bare value fills the action's first required option: dj deal_playlist "Gym Rock"
const value = rest.join(' ');
if (value) {
  const first = (action.input.required ?? [])[0] ?? Object.keys(action.input.properties ?? {})[0];
  if (!first) die(`${name} takes no value`);
  if (opts[first] === undefined) {
    raw[first] = value;
    opts[first] = coerce(value);
  }
}
// Respect the schema: a playlist called "2024" stays text.
for (const [k, s] of Object.entries(action.input.properties ?? {})) {
  if (s.type === 'string' && raw[k] !== undefined) opts[k] = raw[k];
}

const r = await call(cfg, 'POST', `/api/v1/actions/${name}`, opts);
out(r.result);
