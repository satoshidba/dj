// A stand-in for Spotify (accounts + Web API) and the Anthropic Messages API,
// so the whole app can be driven end to end without real accounts or keys.
// Run: node test/mock-services.js  (listens on MOCK_PORT, default 9099)
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 9099);
const BASE = `http://127.0.0.1:${PORT}`;

const ARTISTS = {
  'Foo Fighters': ['Everlong', 'The Pretender', 'Best of You', 'My Hero', 'Times Like These', 'Learn to Fly', 'All My Life', 'Monkey Wrench', 'Walk', 'Rope', 'Run', 'These Days'],
  'Queens of the Stone Age': ['No One Knows', 'Go With the Flow', 'Little Sister', 'Make It Wit Chu', 'Sick, Sick, Sick', 'The Way You Used to Do', 'Smooth Sailing', 'My God Is the Sun', 'Burn the Witch'],
  'Arctic Monkeys': ['Do I Wanna Know?', 'R U Mine?', 'Brianstorm', 'Fluorescent Adolescent', 'Teddy Picker', 'Crying Lightning', 'Arabella', 'Snap Out of It'],
  'The White Stripes': ['Seven Nation Army', 'Fell in Love with a Girl', 'Icky Thump', 'Hardest Button to Button', 'Blue Orchid', 'Dead Leaves and the Dirty Ground', 'My Doorbell'],
  'Royal Blood': ['Figure It Out', 'Out of the Black', 'Little Monster', 'Trouble’s Coming', 'Lights Out', 'Come On Over'],
  'The Strokes': ['Last Nite', 'Reptilia', 'Someday', 'Hard to Explain', 'You Only Live Once', 'The Adults Are Talking'],
  'Muse': ['Hysteria', 'Plug In Baby', 'Knights of Cydonia', 'Uprising', 'Supermassive Black Hole'],
  'Pixies': ['Where Is My Mind?', 'Debaser', 'Here Comes Your Man', 'Monkey Gone to Heaven'],
  'Nirvana': ['Breed', 'Lithium', 'In Bloom', 'Territorial Pissings'],
  'Rage Against the Machine': ['Killing in the Name', 'Bulls on Parade', 'Guerrilla Radio'],
  'Pearl Jam': ['Alive', 'Even Flow', 'Corduroy'],
  'Wolfmother': ['Woman', 'Joker & the Thief'],
  'The Hives': ['Hate to Say I Told You So', 'Tick Tick Boom'],
  'Jet': ['Are You Gonna Be My Girl'],
  'Kings of Leon': ['Molly’s Chambers', 'Sex on Fire'],
  'Biffy Clyro': ['Bubbles', 'Mountains'],
  'Idles': ['Never Fight a Man with a Perm'],
  'Fontaines D.C.': ['Boys in the Better Land', 'Jackie Down the Line'],
  'Johann Sebastian Bach': ['Goldberg Variations, BWV 988: Aria', 'Cello Suite No. 1 in G Major, BWV 1007: I. Prélude'],
  'Erik Satie': ['Gymnopédie No. 1'],
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const artistObj = (name) => ({ id: `ar_${slug(name)}`, name, genres: name.includes('Bach') || name.includes('Satie') ? ['classical'] : ['rock', 'alternative rock'], images: [{ url: img(name, 160), width: 160 }] });
function img(seed, w) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"><rect width="100%" height="100%" fill="hsl(${[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 45% 55%)"/></svg>`)}`;
}

const ALL = [];
for (const [artist, songs] of Object.entries(ARTISTS)) {
  songs.forEach((title, i) => {
    const id = `tr_${slug(artist)}_${i}`;
    ALL.push({
      id,
      uri: `spotify:track:${id}`,
      type: 'track',
      name: title,
      duration_ms: 150000 + ((i * 37013) % 120000),
      artists: [artistObj(artist)].map(({ id, name }) => ({ id, name })),
      album: { id: `al_${slug(artist)}_${i % 3}`, name: `${artist} Album ${(i % 3) + 1}`, images: [{ url: img(artist + (i % 3), 64), width: 64 }] },
    });
  });
}
// A feature, to prove collaborators count.
ALL.push({ id: 'tr_feat', uri: 'spotify:track:tr_feat', type: 'track', name: 'Collab Track', duration_ms: 200000, artists: [{ id: 'ar_foofighters', name: 'Foo Fighters' }, { id: 'ar_royalblood', name: 'Royal Blood' }], album: { id: 'al_feat', name: 'Collabs', images: [] } });

const me = { id: 'alex', display_name: 'Alex', images: [] };
const playlists = {
  gym: { id: 'gym', name: 'Gym Rock', owner: { id: 'alex', display_name: 'Alex' }, collaborative: false, images: [{ url: img('gym', 300), width: 300 }], uris: ALL.filter((t) => !t.name.includes('Gymno') && !t.artists[0].name.includes('Bach')).map((t) => t.uri) },
  road: { id: 'road', name: 'Road Trip 2026', owner: { id: 'alex', display_name: 'Alex' }, collaborative: true, images: [], uris: ALL.slice(10, 70).map((t) => t.uri) },
  editorial: { id: 'editorial', name: 'Rock This', owner: { id: 'spotify', display_name: 'Spotify' }, collaborative: false, images: [{ url: img('ed', 300), width: 300 }], uris: [] },
};
const byUri = new Map(ALL.map((t) => [t.uri, t]));
let created = 0;

export const mockState = { playlists };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const readBody = (req) =>
  new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });

function page(items, url, limit) {
  const offset = Number(url.searchParams.get('offset') || 0);
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? (() => { const u = new URL(url); u.searchParams.set('offset', offset + limit); u.searchParams.set('limit', limit); return `${BASE}${u.pathname}${u.search}`; })() : null;
  return { items: slice, total: items.length, limit, offset, next };
}
const plSummary = (p) => ({ id: p.id, name: p.name, description: '', owner: p.owner, collaborative: p.collaborative, images: p.images, snapshot_id: 'snap', items: { total: p.uris.length }, external_urls: { spotify: `https://open.spotify.com/playlist/${p.id}` } });

// Canned curator answer.
function curatorAnswer() {
  const pick = (artist, title, bpm, why, known) => ({ artist, title, est_bpm: bpm, why, known });
  return {
    title: 'Ten-Minute Kilometres, Halved',
    description: 'Driving rock in the 160s to lock a 5:00/km stride, with a warm-up and a cool-down.',
    tempo_target: '5:00/km ≈ 165–172 spm, so 160–175 BPM or half-time 80–88',
    tracks: [
      pick('Foo Fighters', 'All My Life', 170, 'Starts quiet, then the floor drops out.', true),
      pick('The White Stripes', 'Hardest Button to Button', 128, 'Metronomic stomp to settle into stride.', true),
      pick('Arctic Monkeys', 'Brianstorm', 168, 'Pure forward motion.', true),
      pick('Foo Fighters', 'Monkey Wrench', 174, 'Classic tempo-run fuel.', true),
      pick('Royal Blood', 'Figure It Out', 82, 'Half-time groove sits right on cadence.', false),
      pick('The Hives', 'Hate to Say I Told You So', 160, 'Short, sharp, no wasted bars.', false),
      pick('Made Up Band', 'Not a Real Song', 165, 'Should be swapped for an alternate.', false),
      pick('Queens of the Stone Age', 'No One Knows', 85, 'Half-time swagger for the long middle.', true),
      pick('Jet', 'Are You Gonna Be My Girl', 105, 'Let the legs loosen for the cool-down.', false),
    ],
    alternates: [pick('Wolfmother', 'Woman', 136, 'Riff-first, relentless.', false), pick('Idles', 'Never Fight a Man with a Perm', 170, 'Shouty energy for the last push.', false)],
  };
}

function sse(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 200) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 200) } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } });
  ev('message_stop', {});
  res.end();
}

export function startMock(port = PORT) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    const p = url.pathname;
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw.startsWith('{') ? raw : '{}') : {};

    // ---- accounts
    if (p === '/accounts/authorize') {
      const to = new URL(url.searchParams.get('redirect_uri'));
      to.searchParams.set('code', 'mockcode');
      to.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: to.toString() });
      return res.end();
    }
    if (p === '/accounts/api/token') return send(res, 200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });

    // ---- anthropic
    if (p === '/anthropic/v1/messages') {
      await new Promise((r) => setTimeout(r, 900));
      return sse(res, JSON.stringify(curatorAnswer()));
    }

    // ---- web api
    if (!p.startsWith('/v1')) return send(res, 404, { error: { message: 'nope' } });
    const path = p.slice(3);
    let m;
    if (path === '/me') return send(res, 200, me);
    if (path === '/me/playlists' && req.method === 'GET') return send(res, 200, page(Object.values(playlists).map(plSummary), url, 50));
    if (path === '/me/playlists' && req.method === 'POST') {
      const id = `new${++created}`;
      playlists[id] = { id, name: body.name, owner: { id: 'alex', display_name: 'Alex' }, collaborative: false, images: [], uris: [] };
      return send(res, 201, plSummary(playlists[id]));
    }
    if ((m = path.match(/^\/playlists\/([^/]+)$/))) {
      const pl = playlists[m[1]];
      if (!pl) return send(res, 404, { error: { message: 'Not found' } });
      if (req.method === 'PUT') {
        Object.assign(pl, { name: body.name ?? pl.name });
        return send(res, 200, {});
      }
      return send(res, 200, plSummary(pl));
    }
    if ((m = path.match(/^\/playlists\/([^/]+)\/items$/))) {
      const pl = playlists[m[1]];
      if (!pl) return send(res, 404, { error: { message: 'Not found' } });
      if (pl.owner.id !== 'alex' && !pl.collaborative) return send(res, 403, { error: { message: 'Forbidden' } });
      if (req.method === 'GET') {
        const limit = Math.min(50, Number(url.searchParams.get('limit') || 50));
        const pg = page(pl.uris.map((u) => ({ added_at: '2026-01-01', is_local: false, item: byUri.get(u) })), url, limit);
        return send(res, 200, pg);
      }
      if (body.uris?.length > 100) return send(res, 400, { error: { message: 'Too many' } });
      if (req.method === 'PUT') pl.uris = [...body.uris];
      if (req.method === 'POST') pl.uris.push(...body.uris);
      return send(res, 201, { snapshot_id: 'snap2' });
    }
    if (path === '/me/tracks') {
      const liked = ALL.slice(0, 80).map((t) => ({ added_at: '2026-01-01', track: t }));
      return send(res, 200, page(liked, url, Number(url.searchParams.get('limit') || 20)));
    }
    if (path === '/me/top/artists') return send(res, 200, { items: Object.keys(ARTISTS).slice(0, 12).map(artistObj) });
    if (path === '/me/top/tracks') return send(res, 200, { items: ALL.slice(0, 20) });
    if (path === '/me/player/recently-played') return send(res, 200, { items: ALL.slice(5, 30).map((t) => ({ track: t })) });
    if (path === '/search') {
      const q = url.searchParams.get('q').toLowerCase().replace(/track:|artist:|"/g, ' ');
      const words = q.split(/\s+/).filter(Boolean);
      const hits = ALL.filter((t) => words.every((w) => `${t.name} ${t.artists.map((a) => a.name).join(' ')}`.toLowerCase().includes(w)));
      return send(res, 200, { tracks: { items: hits.slice(0, Number(url.searchParams.get('limit') || 5)) } });
    }
    send(res, 404, { error: { message: `mock: no route ${req.method} ${path}` } });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock().then(() => console.log(`mock services on ${BASE}`));
}
