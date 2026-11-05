import { properShuffle, fisherYates, spreadStats, seededRandom } from '/shuffle.js';

// ------------------------------------------------------------------ utils --

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-dj': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    state.session.user = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, { error = false, link, ms = 5200 } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}` }, msg, link ? [' ', h('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label)] : null);
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtHours = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
};
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const artistNames = (t) => t.artists.map((a) => a.name).join(', ');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Artist colours for the spread strip: the most frequent artists get a colour,
// everyone else is neutral, so clumps are easy to spot.
const PALETTE = ['#FF4D1A', '#2F6BFF', '#E8B200', '#19A974', '#B14CFD', '#FF7AB6', '#00A7BD', '#9B6A44'];
function colourise(tracks) {
  const counts = new Map();
  for (const t of tracks) {
    const k = t.artists[0]?.id || t.artists[0]?.name || t.uri;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, PALETTE.length);
  const colour = new Map(top.map(([k], i) => [k, PALETTE[i]]));
  const legend = top.map(([k, c], i) => ({ colour: PALETTE[i], count: c, name: tracks.find((t) => (t.artists[0]?.id || t.artists[0]?.name || t.uri) === k)?.artists[0]?.name }));
  return { of: (t) => colour.get(t.artists[0]?.id || t.artists[0]?.name || t.uri) ?? null, legend };
}

// ------------------------------------------------------------------ strip --
// A canvas of thin bars, one per track, coloured by artist. Reordering animates
// each bar to its new slot with a staggered sweep, like a deck being dealt.

class Strip {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.pos = new Map();
    this.anim = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
  }
  set(order, colourOf) {
    this.colourOf = colourOf;
    this.items = order;
    this.pos = new Map(order.map((t, i) => [t, { from: i, to: i, lift: 0 }]));
    cancelAnimationFrame(this.raf);
    this.anim = null;
    this.draw();
  }
  animateTo(order, duration = 1400) {
    const n = order.length;
    order.forEach((t, i) => {
      const p = this.pos.get(t) ?? { from: i, to: i };
      p.from = p.cur ?? p.to;
      p.to = i;
      p.delay = reduced ? 0 : (i / n) * duration * 0.45;
    });
    this.items = order;
    this.anim = { start: performance.now(), duration: reduced ? 1 : duration * 0.55 };
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const done = this.draw();
      if (!done) this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  draw() {
    const { canvas, ctx } = this;
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w) return true;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const n = this.items.length;
    if (!n) return true;
    const slot = w / n;
    const bw = Math.max(1, slot - (slot > 4 ? Math.min(2, slot * 0.25) : 0));
    const faint = getComputedStyle(document.documentElement).getPropertyValue('--faint').trim();
    const now = performance.now();
    let done = true;
    for (const t of this.items) {
      const p = this.pos.get(t);
      let x = p.to;
      let lift = 0;
      if (this.anim) {
        const local = Math.min(1, Math.max(0, (now - this.anim.start - p.delay) / this.anim.duration));
        if (local < 1) done = false;
        const e = 1 - Math.pow(1 - local, 3);
        x = p.from + (p.to - p.from) * e;
        lift = Math.sin(local * Math.PI) * (p.from === p.to ? 0 : 1);
      }
      p.cur = x;
      const c = this.colourOf(t);
      ctx.fillStyle = c ?? faint;
      const barH = c ? hgt : hgt * 0.62;
      const y = (hgt - barH) / 2 - lift * hgt * 0.12;
      ctx.fillRect(x * slot, y, bw, barH);
    }
    if (done) this.anim = null;
    return done;
  }
}

// ------------------------------------------------------------------ state --

const state = {
  session: { user: null, ai: false },
  tab: 'deal',
  playlists: null,
  liked: null,
  filter: '',
  selected: null, // playlist id
  detail: null, // { playlist, tracks, stats, hasLocal, canRestore }
  order: null, // current displayed order (track objects)
  dealt: null, // { stats, plain, was }
  busy: false,
  taste: null,
  brief: { text: '', length: 25, fam: 0.5, running: false, steps: [], result: null, saved: null },
};

function route() {
  const [, tab, id] = location.hash.split('/');
  state.tab = tab === 'brief' ? 'brief' : 'deal';
  const nextSel = state.tab === 'deal' && id ? decodeURIComponent(id) : null;
  if (nextSel !== state.selected) {
    state.selected = nextSel;
    state.detail = null;
    state.order = null;
    state.dealt = null;
    if (nextSel) loadDetail(nextSel);
  }
  render();
}

// ----------------------------------------------------------------- render --

const app = document.getElementById('app');
let strip = null;

function render() {
  strip?.ro.disconnect();
  strip = null;
  app.replaceChildren(state.session.user ? appShell() : landing());
}

// ---------------------------------------------------------------- landing --

function landing() {
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const label = h('span', { class: 'mono demo-label' }, '');
  const view = h(
    'div',
    { class: 'landing' },
    h('header', {}, h('a', { class: 'wordmark', href: '/' }, 'dj', h('i', {}, '.')), h('a', { class: 'linkish', href: '/login' }, 'Log in')),
    h(
      'section',
      { class: 'hero' },
      h('div', { class: 'eyebrow' }, 'For Spotify · Two people · Self-hosted'),
      h('h1', {}, h('span', { class: 'line' }, h('span', {}, 'Shuffle,')), h('span', { class: 'line' }, h('span', {}, h('em', {}, 'properly.')))),
      h(
        'div',
        { class: 'hero-row' },
        h('p', {}, 'Pick a playlist. dj ', h('b', {}, 'deals'), ' it into an order where the same artist never plays twice in a row and big artists are spread as far apart as the playlist allows. Then you just press play, in order.'),
        h('a', { class: 'btn accent big', href: '/login' }, 'Connect Spotify', h('span', { 'aria-hidden': 'true' }, '→')),
      ),
      h(
        'div',
        { class: 'demo' },
        h('div', { class: 'demo-head' }, label, h('span', { class: 'mono muted' }, '72 tracks · each colour is one artist')),
        canvas,
      ),
    ),
    h(
      'section',
      { class: 'points' },
      point('01', 'Dealt, not shuffled', 'Every artist’s songs are laid out evenly across the playlist, then a repair pass clears anything still too close, features and collabs included.'),
      point('02', 'Written back to Spotify', 'The new order is saved to the playlist itself, so it plays the same on your phone, car, or speaker. One tap puts the old order back.'),
      point('03', 'Briefs, with AI', 'Describe the moment, like a 5:00/km run or an hour of deep focus. A curator reads your listening history and builds a playlist to match.'),
    ),
    h('footer', {}, h('span', { class: 'mono muted' }, 'dj. Not affiliated with Spotify.'), h('span', { class: 'mono muted' }, 'Runs on your own box')),
  );
  requestAnimationFrame(() => runDemo(canvas, label));
  return view;
}

const point = (n, title, body) => h('div', {}, h('div', { class: 'n' }, n), h('h3', {}, title), h('p', {}, body));

function runDemo(canvas, label) {
  // Fake playlist: a few heavy artists plus singles.
  const counts = [12, 10, 9, 8, 7, 6, 5, 5];
  const tracks = [];
  counts.forEach((c, a) => {
    for (let i = 0; i < c; i++) tracks.push({ uri: `d${a}-${i}`, artists: [{ id: `a${a}`, name: `a${a}` }], album: { id: `a${a}-${i % 2}` } });
  });
  for (let i = 0; i < 10; i++) tracks.push({ uri: `s${i}`, artists: [{ id: `s${i}`, name: `s${i}` }], album: { id: `s${i}` } });
  const { of } = colourise(tracks);
  const s = new Strip(canvas);
  let seed = 1;
  const clumpy = () => {
    let best = null;
    for (let i = 0; i < 12; i++) {
      const o = fisherYates(tracks, seededRandom(seed++));
      const b = spreadStats(o).backToBack;
      if (!best || b > best.b) best = { o, b };
    }
    return best;
  };
  let first = clumpy();
  s.set(first.o, of);
  const say = (txt, hot) => {
    label.textContent = txt;
    label.style.color = hot ? 'var(--accent)' : '';
  };
  say(`Plain random · ${first.b} back-to-backs`, true);
  const loop = async () => {
    if (!canvas.isConnected) return;
    const dealt = properShuffle(tracks, { rng: seededRandom(seed++) });
    s.animateTo(dealt, 1800);
    say(`Dealt · ${spreadStats(dealt).backToBack} back-to-backs`, false);
    await wait(3600);
    if (!canvas.isConnected) return;
    first = clumpy();
    s.animateTo(first.o, 1400);
    say(`Plain random · ${first.b} back-to-backs`, true);
    await wait(2800);
    loop();
  };
  setTimeout(loop, 1600);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ shell --

let closeMenu = null;
document.addEventListener('click', (e) => closeMenu?.(e));

function appShell() {
  const u = state.session.user;
  let menuOpen = false;
  const menuHost = h('div', { class: 'who' });
  const toggle = () => {
    menuOpen = !menuOpen;
    menuHost.querySelector('.menu')?.remove();
    if (menuOpen) {
      menuHost.append(
        h(
          'div',
          { class: 'menu', role: 'menu' },
          h('div', { class: 'hint' }, `Signed in as ${u.name}. To switch to the other account, log out and Spotify will ask who you are.`),
          h('button', { role: 'menuitem', onClick: () => logout(true) }, 'Switch account'),
          h('button', { role: 'menuitem', onClick: () => logout(false) }, 'Log out'),
        ),
      );
    }
  };
  menuHost.append(
    h('button', { 'aria-haspopup': 'menu', onClick: toggle }, h('span', { class: 'who-name' }, u.name), avatar(u.image, u.name)),
  );
  closeMenu = (e) => {
    if (menuOpen && !menuHost.contains(e.target)) toggle();
  };

  const tab = (id, label) =>
    h('button', { role: 'tab', 'aria-selected': String(state.tab === id), onClick: () => (location.hash = id === 'deal' && state.selected ? `#/deal/${state.selected}` : `#/${id}`) }, label);

  return h(
    'div',
    {},
    h('header', { class: 'top' }, h('a', { class: 'wordmark', href: '#/deal' }, 'dj', h('i', {}, '.')), h('nav', { class: 'tabs', role: 'tablist' }, tab('deal', 'Deal'), tab('brief', 'Brief')), menuHost),
    state.tab === 'brief' ? briefView() : dealView(),
  );
}

const avatar = (img, name) =>
  h('span', { class: 'avatar', style: img ? { backgroundImage: `url("${img}")` } : null }, img ? '' : (name || '?')[0].toUpperCase());

async function logout(thenLogin) {
  await fetch('/logout', { method: 'POST' });
  if (thenLogin) location.href = '/login';
  else {
    state.session.user = null;
    location.hash = '';
    render();
  }
}

// ------------------------------------------------------------------- deal --

async function loadPlaylists() {
  try {
    const data = await api('/api/playlists');
    state.playlists = data.playlists;
    state.liked = data.liked;
  } catch (err) {
    toast(err.message, { error: true });
    state.playlists = [];
  }
  if (state.tab === 'deal') render();
}

async function loadDetail(id) {
  try {
    const d = await api(`/api/playlists/${encodeURIComponent(id)}`);
    if (state.selected !== id) return;
    state.detail = d;
    state.order = d.tracks;
  } catch (err) {
    toast(err.message, { error: true });
    if (state.selected === id) location.hash = '#/deal';
  }
  if (state.tab === 'deal') render();
}

function dealView() {
  if (!state.playlists) loadPlaylists();
  return h('main', { class: `deal${state.selected ? ' has-selection' : ''}` }, crate(), h('section', { class: 'stage' }, stage()));
}

function crate() {
  const list = h('div', {});
  const fill = () => {
    list.replaceChildren();
    if (!state.playlists) {
      for (let i = 0; i < 8; i++) list.append(h('div', { class: 'pl' }, h('div', { class: 'cover skeleton', style: { width: '46px', height: '46px' } }), h('div', { class: 'skeleton', style: { height: '14px', width: `${50 + ((i * 37) % 40)}%` } })));
      return;
    }
    const q = state.filter.toLowerCase();
    const items = state.playlists.filter((p) => !q || p.name.toLowerCase().includes(q));
    if (!q || 'liked songs'.includes(q)) {
      list.append(plRow({ id: 'liked', name: 'Liked Songs', total: state.liked?.total, canEdit: true, ownerName: 'Writes to “Liked Songs, dealt”' }, 0, true));
    }
    items.forEach((p, i) => list.append(plRow(p, i + 1)));
  };
  fill();
  return h(
    'aside',
    { class: 'crate' },
    h('h2', { class: 'eyebrow' }, 'Your playlists'),
    h('input', {
      class: 'crate-filter',
      type: 'search',
      placeholder: 'Filter',
      value: state.filter,
      'aria-label': 'Filter playlists',
      onInput: (e) => {
        state.filter = e.target.value;
        fill();
      },
    }),
    list,
    state.playlists?.some((p) => !p.canEdit)
      ? h('p', { class: 'crate-note' }, 'Faded playlists belong to someone else. Spotify only lets apps read playlists you own or collaborate on. Copy one into your own playlist in Spotify and it’ll show up here.')
      : null,
  );
}

function plRow(p, i, liked = false) {
  return h(
    'button',
    {
      class: `pl${p.canEdit ? '' : ' locked'}`,
      'aria-current': String(state.selected === p.id),
      style: { animationDelay: `${Math.min(i, 20) * 25}ms` },
      onClick: () => {
        if (!p.canEdit) return toast('Spotify doesn’t let apps read playlists you don’t own. Copy it into your own playlist first.');
        location.hash = `#/deal/${p.id}`;
      },
    },
    liked ? h('div', { class: 'cover liked' }, '♥') : h('div', { class: `cover${p.image ? '' : ' blank'}`, style: p.image ? { backgroundImage: `url("${p.image}")` } : null }),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, p.name), h('div', { class: 'sub' }, liked ? p.ownerName : p.canEdit ? (p.collaborative ? 'Collaborative' : 'Yours') : `by ${p.ownerName}`)),
    h('span', { class: 'count' }, p.total ?? ''),
  );
}

function stage() {
  if (!state.selected) {
    return h('div', { class: 'stage-empty' }, h('div', {}, h('div', { class: 'serif' }, 'Pick a crate.'), h('p', {}, 'Choose a playlist on the left to see how it’s spread, then deal it.')));
  }
  const d = state.detail;
  if (!d) {
    return h('div', {}, h('div', { class: 'skeleton', style: { height: '160px', width: '160px', marginBottom: '24px' } }), h('div', { class: 'skeleton', style: { height: '64px', width: '60%', marginBottom: '28px' } }), h('div', { class: 'skeleton', style: { height: '200px' } }));
  }
  const p = d.playlist;
  const tracks = state.order;
  const artists = new Set(tracks.map((t) => t.artists[0]?.id || t.artists[0]?.name)).size;
  const duration = tracks.reduce((s, t) => s + t.durationMs, 0);
  const { of, legend } = colourise(d.tracks);
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Each bar is a track, coloured by artist' });
  const st = state.dealt ? state.dealt.stats : d.stats;

  queueMicrotask(() => {
    strip = new Strip(canvas);
    strip.set(state.dealt?.prevOrder ?? tracks, of);
    if (state.dealt?.prevOrder) {
      strip.animateTo(tracks);
      state.dealt.prevOrder = null;
    }
  });

  return h(
    'div',
    {},
    h('a', { class: 'btn ghost small back', href: '#/deal' }, '← Playlists'),
    h(
      'div',
      { class: 'pl-head' },
      p.id === 'liked' ? h('div', { class: 'cover liked', style: { fontSize: '64px' } }, '♥') : h('div', { class: `cover${p.image ? '' : ' blank'}`, style: p.image ? { backgroundImage: `url("${p.image}")` } : null }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'eyebrow' }, state.dealt ? 'Dealt · not saved yet' : 'Current order'), h('h1', {}, p.name), h('div', { class: 'mono muted' }, `${plural(tracks.length, 'track')} · ${plural(artists, 'artist')} · ${fmtHours(duration)}`)),
    ),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'strip-wrap' }, canvas),
      h('div', { class: 'strip-axis mono muted' }, h('span', {}, 'First track'), h('span', {}, 'Last track')),
      legend.length
        ? h('div', { class: 'demo-legend' }, legend.map((l) => h('span', { class: 'mono muted' }, h('span', { class: 'dot', style: { background: l.colour, display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', marginRight: '6px' } }), `${l.name} ×${l.count}`)))
        : null,
      statsRow(st, state.dealt?.was),
      state.dealt
        ? h('p', { class: 'compare' }, 'A plain random shuffle of this playlist typically scores ', h('b', {}, `${state.dealt.plain.spread}`), ' on spread with ', h('b', {}, plural(state.dealt.plain.backToBack, 'back-to-back')), '.')
        : null,
      d.hasLocal ? h('div', { class: 'callout' }, 'This playlist has local files. Spotify doesn’t let apps write those back, so you can only save the dealt order as a new playlist (without them).') : null,
      p.id === 'liked' ? h('div', { class: 'callout' }, 'Liked Songs can’t be reordered by apps, so the dealt order is written to a playlist called “Liked Songs, dealt”, reused each time.') : null,
      actions(),
    ),
    trackList(tracks, of),
  );
}

function statsRow(s, was) {
  const stat = (v, k, wasV, betterLow) => {
    const improved = was && wasV != null && v != null && (betterLow ? v < wasV : v > wasV);
    return h('div', { class: `stat${improved ? ' good' : ''}` }, h('div', { class: 'v' }, v ?? '—', was && wasV !== v ? h('span', { class: 'was' }, wasV ?? '—') : null), h('div', { class: 'k' }, k));
  };
  return h(
    'div',
    { class: 'stats' },
    stat(s.backToBack, 'Same artist back to back', was?.backToBack, true),
    stat(s.nearRepeats, 'Repeats within 3 tracks', was?.nearRepeats, true),
    stat(s.tightestGap, 'Tightest gap between repeats', was?.tightestGap, false),
    stat(s.spread, 'Spread score / 100', was?.spread, false),
  );
}

function actions() {
  const d = state.detail;
  const p = d.playlist;
  const wrap = h('div', { class: 'actions' });
  const dealBtn = h('button', { class: `btn ${state.dealt ? 'ghost' : 'accent big'}`, disabled: state.busy || state.order.length < 2, onClick: deal }, state.dealt ? 'Deal again' : 'Deal', h('span', { class: 'kbd' }, 'D'));
  wrap.append(dealBtn);
  if (state.dealt) {
    const canWrite = !d.hasLocal;
    wrap.append(
      h('button', { class: 'btn accent', disabled: state.busy || !canWrite, onClick: write }, p.id === 'liked' ? 'Write to “Liked Songs, dealt”' : 'Write order to Spotify'),
      h('button', { class: 'btn ghost', disabled: state.busy, onClick: () => saveAsForm(wrap) }, 'Save as new playlist'),
    );
  }
  wrap.append(h('span', { class: 'spacer' }));
  if (d.canRestore && p.id !== 'liked') wrap.append(h('button', { class: 'linkish', disabled: state.busy, onClick: restore }, 'Undo last write'));
  return wrap;
}

function saveAsForm(wrap) {
  const input = h('input', { class: 'crate-filter', style: { margin: 0, width: 'min(320px, 100%)', height: '46px', borderRadius: '999px', padding: '0 18px' }, value: `${state.detail.playlist.name}, dealt`, 'aria-label': 'New playlist name' });
  const go = async () => {
    state.busy = true;
    try {
      const r = await api('/api/save-as', { method: 'POST', body: { name: input.value.trim() || 'Dealt', description: 'Properly shuffled by dj. Play in order.', uris: state.order.map((t) => t.uri) } });
      toast('Saved as a new playlist.', { link: { href: r.url, label: 'Open in Spotify' } });
      state.playlists = null;
    } catch (err) {
      toast(err.message, { error: true });
    }
    state.busy = false;
    render();
  };
  wrap.replaceChildren(input, h('button', { class: 'btn accent', onClick: go }, 'Save'), h('button', { class: 'linkish', onClick: () => render() }, 'Cancel'));
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
}

async function deal() {
  if (state.busy) return;
  state.busy = true;
  const id = state.selected;
  try {
    const r = await api(`/api/playlists/${encodeURIComponent(id)}/shuffle`, { method: 'POST' });
    if (state.selected !== id) return;
    // Map URIs back to track objects (a playlist may contain the same URI twice).
    const pool = new Map();
    for (const t of state.detail.tracks) {
      if (!pool.has(t.uri)) pool.set(t.uri, []);
      pool.get(t.uri).push(t);
    }
    const prevOrder = state.order;
    const prevRects = rowRects();
    state.order = r.order.map((u) => pool.get(u).shift());
    state.dealt = { stats: r.stats, plain: r.plain, was: state.detail.stats, prevOrder };
    state.busy = false;
    render();
    flipRows(prevRects);
  } catch (err) {
    state.busy = false;
    toast(err.message, { error: true });
  }
}

async function write() {
  state.busy = true;
  render();
  try {
    const r = await api(`/api/playlists/${encodeURIComponent(state.selected)}/apply`, { method: 'POST', body: { uris: state.order.map((t) => t.uri) } });
    toast('Order written. Press play, shuffle off.', { link: { href: r.url, label: 'Open in Spotify' } });
    state.detail.stats = state.dealt.stats;
    state.detail.tracks = state.order;
    state.detail.canRestore = r.canRestore ?? state.detail.canRestore;
    state.dealt = null;
  } catch (err) {
    toast(err.message, { error: true });
  }
  state.busy = false;
  render();
}

async function restore() {
  state.busy = true;
  render();
  try {
    await api(`/api/playlists/${encodeURIComponent(state.selected)}/restore`, { method: 'POST' });
    toast('Previous order restored.');
    state.detail = null;
    state.dealt = null;
    loadDetail(state.selected);
  } catch (err) {
    toast(err.message, { error: true });
  }
  state.busy = false;
  render();
}

const ROW_LIMIT = 400;

function trackList(tracks, of) {
  const shown = tracks.slice(0, ROW_LIMIT);
  return h(
    'section',
    { class: 'tracks' },
    h('div', { class: 'tracks-head' }, h('span', { class: 'eyebrow' }, state.dealt ? 'Dealt order' : 'Order now'), h('span', { class: 'mono muted' }, plural(tracks.length, 'track'))),
    h(
      'div',
      { id: 'rows' },
      shown.map((t, i) => {
        const c = of(t);
        const row = h(
          'div',
          { class: `row${t.local ? ' local' : ''}` },
          h('span', { class: 'idx' }, i + 1),
          h('div', { class: `cover art${t.image ? '' : ' blank'}`, style: t.image ? { backgroundImage: `url("${t.image}")` } : null }),
          h('div', { class: 't' }, h('div', { class: 'name' }, t.name), h('div', { class: 'by' }, c ? h('span', { class: 'dot', style: { background: c } }) : null, artistNames(t))),
          h('div', { class: 'alb' }, t.album.name),
          h('span', { class: 'dur' }, fmtDur(t.durationMs)),
        );
        row.__track = t;
        return row;
      }),
    ),
    tracks.length > ROW_LIMIT ? h('div', { class: 'more mono' }, `+ ${(tracks.length - ROW_LIMIT).toLocaleString()} more`) : null,
  );
}

function rowRects() {
  const m = new Map();
  for (const el of document.querySelectorAll('#rows .row')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > -200 && r.top < innerHeight + 200) m.set(el.__track, r.top);
  }
  return m;
}

function flipRows(prev) {
  if (reduced) return;
  const rows = [...document.querySelectorAll('#rows .row')];
  let k = 0;
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    if (r.top > innerHeight + 200 || r.bottom < -200) continue;
    const before = prev.get(el.__track);
    const delay = Math.min(k++, 30) * 14;
    if (before != null) {
      el.animate([{ transform: `translateY(${before - r.top}px)` }, { transform: 'none' }], { duration: 700, delay, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    } else {
      el.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 500, delay, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    }
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (state.tab === 'deal' && state.detail && !state.busy) deal();
});

// ------------------------------------------------------------------ brief --

const EXAMPLES = [
  'Going for a run at 5:00/km. Good rock that keeps me on pace.',
  'I need to concentrate. Classical, nothing with words.',
  'Sunday morning, coffee, windows open.',
  'Getting ready to go out with friends. 2000s indie.',
  'Long drive at night on empty roads.',
  'Cooking dinner, something with groove.',
];

async function loadTaste() {
  try {
    state.taste = await api('/api/taste');
  } catch {
    state.taste = { empty: true, genres: [], artists: [] };
  }
  if (state.tab === 'brief' && !state.brief.running) render();
}

function briefView() {
  const b = state.brief;
  if (!state.taste) loadTaste();

  const ta = h('textarea', {
    placeholder: EXAMPLES[Math.floor(Date.now() / 8000) % EXAMPLES.length],
    'aria-label': 'What is the playlist for?',
    disabled: b.running,
    onInput: (e) => (b.text = e.target.value),
    onKeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runBrief();
    },
  });
  ta.value = b.text;

  const lenOut = h('output', {}, b.length);
  const famOut = h('output', {}, famLabel(b.fam));

  const form = h(
    'div',
    { class: 'prompt' },
    ta,
    h(
      'div',
      { class: 'prompt-foot' },
      h('label', { class: 'knob' }, h('span', { class: 'lbl' }, h('span', { class: 'eyebrow' }, 'Length'), lenOut), h('input', { type: 'range', min: 10, max: 60, step: 1, value: b.length, disabled: b.running, onInput: (e) => { b.length = +e.target.value; lenOut.textContent = b.length; } })),
      h('label', { class: 'knob' }, h('span', { class: 'lbl' }, h('span', { class: 'eyebrow' }, 'Familiar ↔ New'), famOut), h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1 - b.fam, disabled: b.running, onInput: (e) => { b.fam = 1 - +e.target.value; famOut.textContent = famLabel(b.fam); } })),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn accent', disabled: b.running || !state.session.ai, onClick: runBrief }, b.running ? 'Working…' : 'Brief the curator', h('span', { class: 'kbd' }, '⌘↵')),
    ),
  );

  return h(
    'main',
    { class: 'brief' },
    h(
      'div',
      { class: 'brief-grid' },
      h(
        'div',
        {},
        h('div', { class: 'eyebrow' }, 'Brief'),
        h('h1', {}, 'What’s it ', h('em', {}, 'for?')),
        form,
        h('div', { class: 'chips' }, EXAMPLES.map((ex, i) => h('button', { class: 'chip', style: { animationDelay: `${i * 40}ms` }, disabled: b.running, onClick: () => { b.text = ex; ta.value = ex; ta.focus(); } }, ex))),
        !state.session.ai
          ? h('div', { class: 'setup' }, h('b', {}, 'Briefs need an Anthropic API key. '), 'Set ', h('code', {}, 'ANTHROPIC_API_KEY'), ' in your ', h('code', {}, '.env'), ' and restart the container. Dealing works without it.')
          : null,
        b.steps.length ? progressView(b.steps) : null,
        b.result ? resultView(b) : null,
      ),
      knowsView(),
    ),
  );
}

const famLabel = (f) => (f >= 0.75 ? 'mostly familiar' : f >= 0.45 ? 'a mix' : f >= 0.2 ? 'mostly new' : 'all new');

function knowsView() {
  const t = state.taste;
  return h(
    'aside',
    { class: 'knows' },
    h('div', { class: 'eyebrow' }, 'What it knows about you'),
    !t
      ? h('div', {}, h('div', { class: 'skeleton', style: { height: '44px', margin: '14px 0' } }), h('div', { class: 'skeleton', style: { height: '60px' } }))
      : t.empty
        ? h('p', { class: 'muted' }, 'Not much yet. Spotify hasn’t got enough listening history for this account, so briefs will lean on what you write.')
        : [
            h('h3', {}, 'On heavy rotation'),
            h('div', { class: 'faces' }, t.artists.map((a, i) => h('span', { class: 'avatar', title: a.name, style: { backgroundImage: a.image ? `url("${a.image}")` : null, animationDelay: `${i * 35}ms` } }, a.image ? '' : a.name[0]))),
            h('div', { class: 'mono muted', style: { marginTop: '6px' } }, t.artists.slice(0, 4).map((a) => a.name).join(', '), t.artists.length > 4 ? ' …' : ''),
            t.genres.length ? h('div', { class: 'genres' }, t.genres.slice(0, 10).map((g) => h('span', {}, g))) : null,
          ],
    h('p', { class: 'note' }, 'Built from your top artists and tracks (last month, six months, all time) and your last 50 plays. Spotify doesn’t share tempo data any more, so BPMs are the curator’s estimates.'),
  );
}

const STEP_TEXT = {
  taste: 'Reading your listening history',
  curating: 'Curating. Usually 20 to 60 seconds',
  matching: 'Finding each track on Spotify',
};

function progressView(steps) {
  return h(
    'div',
    { class: 'progress' },
    steps.map((s) => h('div', { class: `step ${s.status}` }, h('span', { class: 'mark' }), h('span', {}, STEP_TEXT[s.stage]), h('span', { class: 'mono muted' }, s.detail ?? ''))),
  );
}

async function runBrief() {
  const b = state.brief;
  if (b.running || !b.text.trim()) {
    if (!b.text.trim()) toast('Say what the playlist is for.');
    return;
  }
  b.running = true;
  b.result = null;
  b.saved = null;
  b.steps = [];
  render();

  const setStage = (stage, detail) => {
    for (const s of b.steps) if (s.stage !== stage) s.status = 'done';
    let s = b.steps.find((x) => x.stage === stage);
    if (!s) b.steps.push((s = { stage }));
    s.status = 'on';
    s.detail = detail;
    const host = document.querySelector('.progress');
    if (host) host.replaceWith(progressView(b.steps));
    else render();
  };

  try {
    const res = await fetch('/api/brief', {
      method: 'POST',
      headers: { 'x-dj': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: b.text, length: b.length, familiarity: b.fam }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.stage === 'matching') setStage('matching', `${ev.done} / ${ev.total}`);
        else if (ev.stage === 'taste' || ev.stage === 'curating') setStage(ev.stage);
        else if (ev.stage === 'error') throw new Error(ev.message);
        else if (ev.stage === 'done') {
          b.steps.forEach((s) => (s.status = 'done'));
          b.result = ev.result;
        }
      }
    }
    if (!b.result) throw new Error('The connection dropped. Try again.');
  } catch (err) {
    toast(err.message, { error: true, ms: 8000 });
    b.steps = [];
  }
  b.running = false;
  render();
  if (b.result) document.querySelector('.result')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}

function resultView(b) {
  const r = b.result;
  const title = h('input', { class: 'result-title', value: r.title, 'aria-label': 'Playlist name', onInput: (e) => (r.title = e.target.value) });
  const total = r.tracks.reduce((s, t) => s + t.durationMs, 0);
  const list = h(
    'div',
    {},
    r.tracks.map((t, i) => {
      const row = h(
        'div',
        { class: 'brow', style: { animationDelay: `${Math.min(i, 40) * 30}ms` } },
        h('span', { class: 'idx' }, i + 1),
        h('div', { class: `cover art${t.image ? '' : ' blank'}`, style: t.image ? { backgroundImage: `url("${t.image}")` } : null }),
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { class: 'name' }, t.name, h('span', { class: `tag ${t.known ? 'known' : 'new'}` }, t.known ? 'yours' : 'new')),
          h('div', { class: 'by' }, artistNames(t), ' · ', fmtDur(t.durationMs)),
          t.why ? h('div', { class: 'why' }, t.why) : null,
        ),
        h('span', { class: 'bpm' }, t.estBpm ? [h('b', {}, `~${t.estBpm}`), h('br'), 'bpm'] : ''),
        h('button', {
          class: 'x',
          'aria-label': `Remove ${t.name}`,
          onClick: () => {
            row.classList.add('removing');
            setTimeout(() => {
              r.tracks = r.tracks.filter((x) => x !== t);
              render();
            }, 280);
          },
        }, '×'),
      );
      return row;
    }),
  );

  const save = async () => {
    try {
      const res = await api('/api/save-as', { method: 'POST', body: { name: r.title || 'dj brief', description: r.description, uris: r.tracks.map((t) => t.uri) } });
      b.saved = res.url;
      state.playlists = null;
      render();
      toast('Saved to Spotify.', { link: { href: res.url, label: 'Open' } });
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  return h(
    'section',
    { class: 'result' },
    h('div', { class: 'eyebrow' }, 'The playlist'),
    title,
    h('p', { class: 'result-desc' }, r.description),
    r.tempoTarget ? h('span', { class: 'pill' }, h('b', {}, 'Tempo'), r.tempoTarget) : null,
    h('div', { style: { marginTop: '22px' } }, list),
    r.missing?.length
      ? h('details', { class: 'missing' }, h('summary', {}, `${plural(r.missing.length, 'pick')} couldn’t be found on Spotify and ${r.missing.length === 1 ? 'was' : 'were'} swapped for alternates`), h('ul', {}, r.missing.map((m) => h('li', {}, m))))
      : null,
    h(
      'div',
      { class: 'sticky-save' },
      h('span', { class: 'mono' }, `${plural(r.tracks.length, 'track')} · ${fmtHours(total)}`),
      h(
        'span',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn ghost small', onClick: runBrief }, 'Try again'),
        b.saved ? h('a', { class: 'btn small', href: b.saved, target: '_blank', rel: 'noopener' }, 'Open in Spotify ↗') : h('button', { class: 'btn accent small', disabled: !r.tracks.length, onClick: save }, 'Save to Spotify'),
      ),
    ),
  );
}

// ------------------------------------------------------------------- boot --

(async () => {
  const params = new URLSearchParams(location.search);
  const err = params.get('error');
  if (err) {
    const msg = {
      not_allowed: 'That Spotify account isn’t on this app’s allow-list.',
      access_denied: 'Spotify login was cancelled.',
      state_mismatch: 'Login expired. Try again.',
    }[err] ?? `Login failed (${err}).`;
    toast(msg, { error: true, ms: 8000 });
    history.replaceState(null, '', '/');
  }
  try {
    state.session = await fetch('/api/session').then((r) => r.json());
  } catch {
    /* offline: show landing */
  }
  addEventListener('hashchange', route);
  route();
})();
