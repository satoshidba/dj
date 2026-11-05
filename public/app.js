import { properShuffle, fisherYates, spreadStats, seededRandom } from '/shuffle.js';

// ------------------------------------------------------------------ utils --

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (val == null) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
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
// Checked for colour-blind separation against both surfaces (dataviz validator).
const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const darkMq = matchMedia('(prefers-color-scheme: dark)');
let PALETTE = darkMq.matches ? PALETTE_DARK : PALETTE_LIGHT;
darkMq.addEventListener('change', () => {
  PALETTE = darkMq.matches ? PALETTE_DARK : PALETTE_LIGHT;
  render();
});
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
  freshDeal: true,
  taste: null,
  brief: { text: '', length: 25, fam: 0.5, running: false, steps: [], result: null, saved: null },
};

function route() {
  const [, tab, id] = location.hash.split('/');
  state.tab = ['brief', 'plays', 'kids'].includes(tab) ? tab : 'deal';
  state.kidsScreen = tab === 'kids' && id === 'play';
  if (state.kidsScreen) {
    setKidsDevice(true);
  } else if (kidsDevice() && state.session.user) {
    // This device lives in Kids mode; only the hold-to-exit button leaves it.
    location.replace('#/kids/play');
    return;
  }
  const nextSel = state.tab === 'deal' && id ? decodeURIComponent(id) : null;
  if (state.tab === 'plays') {
    state.history = null;
    state.playsSub = ['rediscover', 'together', 'wrapped'].includes(id) ? id : 'stats';
  }
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
  stopPlayerPoll();
  if (!state.session.user) return app.replaceChildren(landing());
  app.replaceChildren(state.kidsScreen ? kidsScreen() : appShell());
}

// ---------------------------------------------------------------- landing --

function landing() {
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const label = h('span', { class: 'mono demo-label' }, '');
  const view = h(
    'div',
    { class: 'landing' },
    h('header', {}, h('a', { class: 'wordmark', href: '/' }, 'dj', h('i', {}, '.')), state.session.passkeys?.available ? h('button', { class: 'linkish', onClick: passkeySignIn }, 'Sign in') : h('a', { class: 'linkish', href: '/login' }, 'Log in')),
    h(
      'section',
      { class: 'hero' },
      h('div', { class: 'eyebrow' }, 'For Spotify · Two people · Self-hosted'),
      h('h1', {}, h('span', { class: 'line' }, h('span', {}, 'Shuffle,')), h('span', { class: 'line' }, h('span', {}, h('em', {}, 'properly.')))),
      h(
        'div',
        { class: 'hero-row' },
        h('p', {}, 'Pick a playlist. dj ', h('b', {}, 'deals'), ' it into an order where the same artist never plays twice in a row and big artists are spread as far apart as the playlist allows. Then you just press play, in order.'),
        state.session.passkeys?.available
          ? h(
              'div',
              { class: 'signin' },
              h('button', { class: 'btn accent big', onClick: passkeySignIn }, keyIcon(), 'Sign in with passkey'),
              h('span', { class: 'muted small' }, 'First time here? ', h('a', { href: '/login' }, 'Connect Spotify'), '.'),
            )
          : h('a', { class: 'btn accent big', href: '/login' }, 'Connect Spotify', h('span', { 'aria-hidden': 'true' }, '→')),
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
          h('div', { class: 'hint' }, state.session.passkeys?.available ? `Signed in as ${u.name}. To switch, sign out and use the other person’s passkey.` : `Signed in as ${u.name}. To switch to the other account, log out and Spotify will ask who you are.`),
          state.session.passkeys?.available ? h('button', { role: 'menuitem', onClick: () => { toggle(); openPasskeys(); } }, 'Passkeys') : null,
          h('button', { role: 'menuitem', onClick: () => { toggle(); openAgents(); } }, 'Agents & API'),
          h('button', { role: 'menuitem', onClick: () => logout(!state.session.passkeys?.available) }, 'Switch account'),
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
    h('header', { class: 'top' }, h('a', { class: 'wordmark', href: '#/deal' }, 'dj', h('i', {}, '.')), h('nav', { class: 'tabs', role: 'tablist' }, tab('deal', 'Deal'), tab('brief', 'Brief'), tab('plays', 'Plays'), tab('kids', 'Kids')), menuHost),
    passkeyNudge(),
    { brief: briefView, plays: playsView, kids: kidsView }[state.tab]?.() ?? dealView(),
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
  if (state.tab === 'deal' || state.tab === 'kids') render();
}

async function loadDetail(id) {
  try {
    const d = await api(`/api/playlists/${encodeURIComponent(id)}`);
    if (state.selected !== id) return;
    state.detail = d;
    state.order = d.tracks;
    state.tiredOf = new Map(d.tracks.map((t, i) => [t, d.tired?.[i] ?? 0]));
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
      list.append(plRow({ id: 'liked', name: 'Liked Songs', total: state.liked?.total, auto: state.liked?.auto, canEdit: true, ownerName: 'Writes to “Liked Songs, dealt”' }, 0, true));
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
    h('span', { class: 'count' }, p.auto ? h('span', { class: 'auto-badge', title: p.auto === 'daily' ? 'Auto-dealt every morning' : 'Auto-dealt every Monday' }, '↻') : null, p.total ?? ''),
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
        ? h(
            'p',
            { class: 'compare' },
            'A plain random shuffle of this playlist typically scores ', h('b', {}, `${state.dealt.plain.spread}`), ' on spread with ', h('b', {}, plural(state.dealt.plain.backToBack, 'back-to-back')), '.',
            state.dealt.stats.freshStart != null
              ? [' The opening quarter is ', h('b', {}, `${state.dealt.stats.freshStart}%`), ' songs you haven’t played lately (a plain shuffle: ', `${state.dealt.plain.freshStart}%`, ').']
              : null,
          )
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
  return h('div', {}, wrap, dealOptions());
}

function dealOptions() {
  const d = state.detail;
  const p = d.playlist;
  const sched = d.schedule;
  const canAuto = (p.canEdit || p.id === 'liked') && !d.hasLocal;
  const setAuto = async (every) => {
    try {
      const r = await api(`/api/playlists/${encodeURIComponent(p.id)}/schedule`, { method: 'PUT', body: { every, tz, fresh: state.freshDeal, name: p.name } });
      d.schedule = r.schedule;
      const pl = p.id === 'liked' ? state.liked : state.playlists?.find((x) => x.id === p.id);
      if (pl) pl.auto = r.schedule?.every ?? null;
      toast(r.schedule ? `Auto-deal on. Next: ${whenLocal(r.schedule.nextRun)}.` : 'Auto-deal off.');
    } catch (err) {
      toast(err.message, { error: true });
    }
    render();
  };
  return h(
    'div',
    { class: 'deal-opts' },
    d.freshAvailable
      ? h('label', { class: 'check', title: 'Uses your play log' }, h('input', { type: 'checkbox', checked: state.freshDeal, onChange: (e) => (state.freshDeal = e.target.checked) }), h('span', {}, h('b', {}, 'Fresh deal'), ' · songs you’ve played a lot lately go later'))
      : h('span', { class: 'muted small' }, 'Fresh deals switch on once dj has some of your play history.'),
    canAuto
      ? h(
          'div',
          { class: 'auto' },
          h('span', { class: 'eyebrow' }, 'Auto-deal'),
          segmented([['off', 'Off'], ['daily', 'Every morning'], ['weekly', 'Mondays']], sched?.every ?? 'off', setAuto, 'Auto-deal'),
          sched
            ? h('span', { class: 'muted small' }, `Next ${whenLocal(sched.nextRun)}`, sched.lastRun ? ` · last ${ago(sched.lastRun)}` : '', sched.lastError ? h('span', { class: 'err' }, ` · ${sched.lastError}`) : null)
            : h('span', { class: 'muted small' }, 'Re-deals itself at 5am so it’s fresh when you wake up.'),
        )
      : null,
  );
}

function whenLocal(t) {
  const d = new Date(t);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
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
    const r = await api(`/api/playlists/${encodeURIComponent(id)}/shuffle`, { method: 'POST', body: { fresh: state.freshDeal } });
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
          h('div', { class: 't' }, h('div', { class: 'name' }, t.name, (state.tiredOf?.get(t) ?? 0) >= 0.5 ? h('span', { class: 'tag known', title: 'You’ve played this a lot lately' }, 'on repeat') : null), h('div', { class: 'by' }, c ? h('span', { class: 'dot', style: { background: c } }) : null, artistNames(t))),
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

  const famOut = h('output', {}, famLabel(b.fam));

  const form = h(
    'div',
    { class: 'prompt' },
    ta,
    h(
      'div',
      { class: 'prompt-foot' },
      lengthKnob(b, { songs: [10, 60], label: 'Length' }),
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
  taste: 'Reading listening history',
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

const runBrief = () => streamBrief(state.brief, '/api/brief', () => ({ brief: state.brief.text, length: state.brief.length, familiarity: state.brief.fam, minutes: state.brief.byTime ? state.brief.minutes : null }));

const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

/** Length as a number of songs, or as a running time ("make it last 2 h 15"). */
function lengthKnob(b, { songs: [lo, hi], label }) {
  b.minutes ??= 45;
  const out = h('output', {}, b.byTime ? fmtMins(b.minutes) : `${b.length} songs`);
  const slider = h('input', {
    type: 'range',
    min: b.byTime ? 15 : lo,
    max: b.byTime ? 240 : hi,
    step: b.byTime ? 5 : 1,
    value: b.byTime ? b.minutes : b.length,
    disabled: b.running,
    'aria-label': label,
    onInput: (e) => {
      if (b.byTime) b.minutes = +e.target.value;
      else b.length = +e.target.value;
      out.textContent = b.byTime ? fmtMins(b.minutes) : `${b.length} songs`;
    },
  });
  return h(
    'div',
    { class: 'knob' },
    h('span', { class: 'lbl' }, h('span', { class: 'mini-seg' }, ...[['songs', 'Songs'], ['time', 'Time']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String((v === 'time') === !!b.byTime), disabled: b.running, onClick: () => { b.byTime = v === 'time'; render(); } }, l))), out),
    slider,
  );
}

/** Run a brief against an NDJSON endpoint, updating `b.steps` / `b.result`. */
async function streamBrief(b, url, makeBody) {
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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-dj': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(makeBody()),
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
    r.targetMinutes ? h('span', { class: 'pill', style: { marginLeft: '8px' } }, h('b', {}, 'Time'), `${fmtHours(r.tracks.reduce((x, t) => x + t.durationMs, 0))} (asked for ${fmtMins(r.targetMinutes)})`) : null,
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


// ------------------------------------------------------------------ plays --

const RANGE_LABELS = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', 'Year'], ['all', 'All time']];
state.plays = { range: '30d', who: 'me', audience: 'grown' };
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function loadHistory() {
  const q = new URLSearchParams({ ...state.plays, tz });
  const key = q.toString();
  state.historyKey = key;
  try {
    const data = await api(`/api/history?${q}`);
    if (state.historyKey !== key) return;
    state.history = data;
  } catch (err) {
    toast(err.message, { error: true });
    state.history = { error: true };
  }
  if (state.tab === 'plays') render();
}

function segmented(options, value, onPick, label) {
  return h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': label },
    options.map(([v, l]) => h('button', { role: 'radio', 'aria-checked': String(v === value), onClick: () => onPick(v) }, l)),
  );
}

function playsView() {
  const sub = state.playsSub ?? 'stats';
  const others = state.session.others ?? [];
  const nav = h(
    'nav',
    { class: 'subnav', 'aria-label': 'Plays sections' },
    [['stats', 'Stats'], ['rediscover', 'Rediscover'], ...(others.length ? [['together', 'Together']] : []), ['wrapped', 'Wrapped']].map(([id, label]) =>
      h('a', { href: id === 'stats' ? '#/plays' : `#/plays/${id}`, 'aria-current': String(sub === id) }, label),
    ),
  );
  const body = { rediscover: rediscoverView, together: togetherView, wrapped: wrappedView }[sub]?.() ?? statsView();
  return h('main', { class: 'plays' }, nav, body);
}

function statsView() {
  if (!state.history) loadHistory();
  const H = state.history;
  const set = (k) => (v) => {
    state.plays[k] = v;
    state.history = null;
    render();
  };
  const others = state.session.others ?? [];

  return h(
    'div',
    {},
    h('h1', { class: 'page-title' }, state.plays.audience === 'kids' ? 'What the kids ' : 'What you’ve been ', h('em', {}, 'playing.')),
    h(
      'div',
      { class: 'filters' },
      segmented(RANGE_LABELS, state.plays.range, set('range'), 'Time range'),
      others.length ? segmented([['me', 'Me'], ['both', `Both of us`]], state.plays.who, set('who'), 'Whose plays') : null,
      segmented([['grown', 'Grown-ups'], ['kids', 'Kids']], state.plays.audience, set('audience'), 'Audience'),
    ),
    !H ? h('div', { class: 'skeleton', style: { height: '320px', marginTop: '28px' } }) : H.error ? null : historyBody(H),
    H && !H.error ? trackingPanel(H.tracking) : null,
  );
}

function historyBody(H) {
  const S = H.summary;
  if (!S.plays) {
    return h(
      'div',
      { class: 'empty-plays' },
      h('div', { class: 'serif' }, state.plays.audience === 'kids' ? 'No Kids mode plays here yet.' : 'Nothing logged in this range yet.'),
      h('p', { class: 'muted' }, state.plays.audience === 'kids' ? 'Plays from Kids mode playlists show up here, kept apart from your own.' : `dj checks Spotify every ${H.tracking.every} minutes and keeps every play. Import your Spotify data below to fill in the years before.`),
    );
  }
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'tiles' },
      tile(S.plays.toLocaleString(), 'plays'),
      tile(Math.round(S.ms / 3_600_000).toLocaleString(), 'hours'),
      tile(S.artistCount.toLocaleString(), 'artists'),
      tile(S.longestStreak, `day${S.longestStreak === 1 ? '' : 's'} in a row, best run`),
    ),
    H.who === 'both' && H.people ? h('p', { class: 'muted split' }, H.people.map((p) => `${p.name}: ${p.plays.toLocaleString()}`).join(' · ')) : null,
    h('section', { class: 'chart-card panel' }, h('div', { class: 'chart-head' }, h('h2', {}, 'Plays over time'), h('span', { class: 'mono muted' }, bucketLabel(S.days))), dayChart(S.days)),
    h(
      'div',
      { class: 'two-col' },
      h('section', { class: 'panel' }, h('h2', {}, 'Top artists'), barList(S.topArtists.slice(0, 10).map((a) => ({ label: a.name, value: a.plays })))),
      h('section', { class: 'panel' }, h('h2', {}, 'Top tracks'), trackRank(S.topTracks.slice(0, 10))),
    ),
    H.who === 'both' && H.shared?.length
      ? h('section', { class: 'panel', style: { marginTop: '20px' } }, h('h2', {}, 'You both play'), sharedList(H.shared, H.people))
      : null,
    h('section', { class: 'panel', style: { marginTop: '20px' } }, h('div', { class: 'chart-head' }, h('h2', {}, 'When you listen'), h('span', { class: 'mono muted' }, tz.replace(/_/g, ' '))), heatmap(S.clock)),
    h('section', { class: 'recent' }, h('h2', { class: 'eyebrow' }, 'Latest'), S.recent.slice(0, 15).map((r) => h('div', { class: 'rrow' }, h('div', { class: `cover art${r.image ? '' : ' blank'}`, style: r.image ? { backgroundImage: `url("${r.image}")` } : null }), h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, r.name), h('div', { class: 'by' }, r.artist)), h('span', { class: 'mono muted' }, ago(r.at))))),
  );
}

const tile = (v, k) => h('div', { class: 'tile' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));

function ago(at) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.round(hr / 24);
  return d < 30 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(at).toLocaleDateString();
}

// Long ranges get grouped into weeks or months so bars stay readable.
function bucketDays(days) {
  if (days.length <= 120) return { unit: 'day', rows: fillDays(days) };
  const unit = days.length <= 730 ? 'week' : 'month';
  const m = new Map();
  for (const d of days) {
    const dt = new Date(`${d.day}T00:00:00Z`);
    let key;
    if (unit === 'week') {
      const monday = new Date(dt);
      monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    } else key = d.day.slice(0, 7);
    m.set(key, (m.get(key) ?? 0) + d.plays);
  }
  return { unit, rows: [...m.entries()].map(([day, plays]) => ({ day, plays })) };
}
function fillDays(days) {
  if (!days.length) return [];
  const out = [];
  const have = new Map(days.map((d) => [d.day, d.plays]));
  const start = new Date(`${days[0].day}T00:00:00Z`);
  const end = new Date(`${days.at(-1).day}T00:00:00Z`);
  for (let t = start; t <= end; t = new Date(t.getTime() + 86_400_000)) {
    const k = t.toISOString().slice(0, 10);
    out.push({ day: k, plays: have.get(k) ?? 0 });
  }
  return out;
}
const bucketLabel = (days) => `per ${bucketDays(days).unit}`;

let tip = null;
function showTip(e, html) {
  tip ??= document.body.appendChild(h('div', { class: 'tip', role: 'tooltip' }));
  tip.innerHTML = html;
  tip.style.opacity = '1';
  const r = tip.getBoundingClientRect();
  const x = Math.min(innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2));
  const y = e.clientY - r.height - 14;
  tip.style.transform = `translate(${x}px, ${y < 8 ? e.clientY + 18 : y}px)`;
}
const hideTip = () => tip && (tip.style.opacity = '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function dayChart(days) {
  const { unit, rows } = bucketDays(days);
  const max = Math.max(1, ...rows.map((r) => r.plays));
  const nice = niceMax(max);
  const fmt = (d) => (unit === 'month' ? new Date(`${d}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }) : new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }));
  return h(
    'div',
    { class: 'cols-wrap' },
    h('div', { class: 'y-axis mono' }, h('span', {}, nice), h('span', {}, Math.round(nice / 2)), h('span', {}, 0)),
    h(
      'div',
      { class: 'cols', role: 'img', 'aria-label': `Plays per ${unit}` },
      h('div', { class: 'grid' }, h('i'), h('i'), h('i')),
      rows.map((r, i) =>
        h(
          'div',
          {
            class: 'col',
            onPointerMove: (e) => showTip(e, `<b>${r.plays.toLocaleString()}</b> plays<br><span>${unit === 'week' ? 'Week of ' : ''}${fmt(r.day)}</span>`),
            onPointerLeave: hideTip,
          },
          h('span', { class: 'bar', style: { height: `${(r.plays / nice) * 100}%`, animationDelay: `${Math.min(i, 60) * 8}ms` } }),
        ),
      ),
    ),
    h('div', { class: 'x-axis mono muted' }, h('span', {}, rows[0] ? fmt(rows[0].day) : ''), h('span', {}, rows.at(-1) ? fmt(rows.at(-1).day) : '')),
  );
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function barList(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h(
    'ol',
    { class: 'barlist' },
    items.map((it, i) =>
      h(
        'li',
        {},
        h('span', { class: 'rank mono' }, i + 1),
        h('div', { class: 'bl-body' }, h('div', { class: 'bl-label' }, h('span', {}, it.label), h('span', { class: 'mono' }, it.value.toLocaleString())), h('div', { class: 'bl-track' }, h('span', { style: { width: `${(it.value / max) * 100}%`, animationDelay: `${i * 40}ms` } }))),
      ),
    ),
  );
}

function trackRank(tracks) {
  return h(
    'ol',
    { class: 'trank' },
    tracks.map((t, i) => h('li', {}, h('span', { class: 'rank mono' }, i + 1), h('div', { class: `cover art${t.image ? '' : ' blank'}`, style: t.image ? { backgroundImage: `url("${t.image}")` } : null }), h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, t.name), h('div', { class: 'by' }, t.artist)), h('span', { class: 'mono muted' }, `×${t.plays}`))),
  );
}

function sharedList(shared, people) {
  const [a, b] = people;
  return h(
    'table',
    { class: 'shared' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Artist'), h('th', { class: 'num' }, a.name), h('th', { class: 'num' }, b.name))),
    h('tbody', {}, shared.map((s) => h('tr', {}, h('td', {}, s.name), h('td', { class: 'num mono' }, s.a), h('td', { class: 'num mono' }, s.b)))),
  );
}

function heatmap(clock) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const max = Math.max(1, ...clock.flat());
  return h(
    'div',
    { class: 'heat-wrap' },
    h(
      'div',
      { class: 'heat', role: 'img', 'aria-label': 'Plays by weekday and hour' },
      clock.map((row, d) => [
        h('span', { class: 'heat-day mono muted' }, days[d][0]),
        row.map((v, hr) =>
          h('span', {
            class: 'cell',
            style: { '--a': v ? 0.12 + 0.88 * (v / max) : 0 },
            onPointerMove: (e) => showTip(e, `<b>${v}</b> plays<br><span>${days[d]} ${String(hr).padStart(2, '0')}:00</span>`),
            onPointerLeave: hideTip,
          }),
        ),
      ]),
      h('span'),
      Array.from({ length: 24 }, (_, hr) => h('span', { class: 'heat-hr mono muted' }, hr % 6 === 0 ? String(hr).padStart(2, '0') : '')),
    ),
    h('div', { class: 'heat-legend mono muted' }, 'Fewer', h('span', { class: 'ramp' }), 'More'),
  );
}

function trackingPanel(t) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, class: 'sr', onChange: (e) => importFiles([...e.target.files]) });
  const last = t.last;
  return h(
    'section',
    { class: 'tracking' },
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Play log'),
      h(
        'p',
        {},
        t.on ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : null,
        t.on ? `Checking Spotify every ${t.every} minutes` : 'Paused',
        t.since ? `, logging since ${new Date(t.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.` : '.',
        last ? h('span', { class: 'muted' }, ` Last check ${ago(last.at)}${last.ok ? (last.added ? `, ${last.added} new` : ', nothing new') : `, failed: ${last.error}`}.`) : null,
      ),
      last?.gap ? h('p', { class: 'callout' }, 'More than 50 plays happened between two checks, so a few may be missing. Spotify only lets apps see the last 50.') : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn ghost small', onClick: async (e) => { e.target.disabled = true; await api('/api/history/poll', { method: 'POST' }).catch((err) => toast(err.message, { error: true })); state.history = null; render(); } }, 'Check now'),
        h('button', { class: 'linkish', onClick: async () => { await api('/api/history/tracking', { method: 'PUT', body: { on: !t.on } }); state.history = null; render(); } }, t.on ? 'Pause logging' : 'Resume logging'),
      ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, t.imported ? 'Import more history' : 'Fill in the years before'),
      h('p', {}, 'Spotify will send you your entire listening history if you ask:'),
      h(
        'ol',
        { class: 'steps-list' },
        h('li', {}, 'Open ', h('a', { href: 'https://www.spotify.com/account/privacy/', target: '_blank', rel: 'noopener' }, 'spotify.com → Account → Privacy'), '.'),
        h('li', {}, 'Tick ', h('b', {}, 'Extended streaming history'), ' and request it. Spotify emails a link, usually within a few days (they say up to 30).'),
        h('li', {}, 'Unzip it and pick the ', h('code', {}, 'Streaming_History_Audio_*.json'), ' files here.'),
      ),
      h('label', { class: 'btn small' }, 'Choose files', fileInput),
      h('div', { id: 'import-status', class: 'mono muted', style: { marginTop: '10px' } }),
    ),
  );
}

async function importFiles(files) {
  const status = document.getElementById('import-status');
  let added = 0;
  let skipped = 0;
  for (const [i, f] of files.entries()) {
    status.textContent = `Reading ${f.name} (${i + 1} of ${files.length})…`;
    let rows;
    try {
      rows = JSON.parse(await f.text());
      if (!Array.isArray(rows)) throw new Error();
    } catch {
      toast(`${f.name} isn’t a streaming history file.`, { error: true });
      continue;
    }
    // Only send the fields the server reads; the export has dozens.
    const slim = rows.map((r) => ({ ts: r.ts, ms_played: r.ms_played, master_metadata_track_name: r.master_metadata_track_name, master_metadata_album_artist_name: r.master_metadata_album_artist_name, master_metadata_album_album_name: r.master_metadata_album_album_name, spotify_track_uri: r.spotify_track_uri }));
    for (let j = 0; j < slim.length; j += 20000) {
      const r = await api('/api/history/import', { method: 'POST', body: { rows: slim.slice(j, j + 20000) } });
      added += r.added;
      skipped += r.skipped;
      status.textContent = `${f.name}: ${added.toLocaleString()} plays added so far`;
    }
  }
  status.textContent = `Done. ${added.toLocaleString()} plays added${skipped ? `, ${skipped.toLocaleString()} already logged or overlapping` : ''}.`;
  toast(`Imported ${added.toLocaleString()} plays.`);
  state.history = null;
  setTimeout(render, 1200);
}


// ------------------------------------------------------------- rediscover --

state.rediscover = null;
async function loadRediscover() {
  try {
    state.rediscover = await api('/api/rediscover');
  } catch (err) {
    toast(err.message, { error: true });
    state.rediscover = { sets: [] };
  }
  if (state.tab === 'plays') render();
}

function collage(tracks) {
  const imgs = tracks.map((t) => t.image).filter(Boolean).slice(0, 4);
  return h('div', { class: `collage n${imgs.length}` }, imgs.length ? imgs.map((src) => h('span', { style: { backgroundImage: `url("${src}")` } })) : h('span', { class: 'blank' }));
}

async function saveSet(btn, url, okText) {
  btn.disabled = true;
  try {
    const r = await api(url, { method: 'POST', body: {} });
    toast(r.updated ? 'Refreshed with a new deal.' : okText, { link: { href: r.url, label: 'Open in Spotify' } });
    return r;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  } finally {
    btn.disabled = false;
  }
}

function rediscoverView() {
  if (!state.rediscover) loadRediscover();
  const R = state.rediscover;
  return h(
    'div',
    {},
    h('h1', { class: 'page-title' }, 'Rediscover ', h('em', {}, 'yourself.')),
    h('p', { class: 'lead-muted' }, 'Playlists built from your own past, not from an algorithm’s guess. Each one is dealt, so the same artist never plays twice in a row. Making one again refreshes the same playlist.'),
    !R
      ? h('div', { class: 'skeleton', style: { height: '260px' } })
      : h(
          'div',
          { class: 'sets' },
          R.sets.map((set, i) => {
            const locked = set.needs || set.tracks.length < 2;
            const btn = h('button', { class: `btn ${set.made ? 'ghost' : 'accent'} small`, disabled: !!locked }, set.made ? 'Refresh playlist' : 'Make it a playlist');
            btn.addEventListener('click', async () => {
              if (await saveSet(btn, `/api/rediscover/${set.id}/save`, `“${set.title}” is in your Spotify.`)) {
                set.made = true;
                btn.textContent = 'Refresh playlist';
                btn.className = 'btn ghost small';
              }
            });
            return h(
              'article',
              { class: `set panel${locked ? ' locked' : ''}`, style: { animationDelay: `${i * 50}ms` } },
              collage(set.tracks),
              h('div', { class: 'set-body' }, h('h2', { class: 'serif' }, set.title), h('p', { class: 'muted' }, set.blurb)),
              locked
                ? h('p', { class: 'set-need' }, set.needs ?? 'Not enough songs yet.')
                : h('ol', { class: 'set-list' }, set.tracks.slice(0, 5).map((t) => h('li', {}, h('span', { class: 'name' }, t.name), h('span', { class: 'by' }, ` · ${t.artist}`), h('span', { class: 'mono muted note' }, t.note)))),
              h('div', { class: 'set-foot' }, h('span', { class: 'mono muted' }, locked ? '' : plural(set.tracks.length, 'song')), btn),
            );
          }),
        ),
  );
}

// --------------------------------------------------------------- together --

state.together = null;
state.togetherSize = 50;
async function loadTogether() {
  try {
    state.together = await api(`/api/blend?size=${state.togetherSize}`);
    // Preview in a dealt order, like the playlist it'll make.
    if (state.together.tracks) state.together.tracks = properShuffle(state.together.tracks.map((t) => ({ ...t, album: { id: null, name: t.album ?? '' } })));
  } catch (err) {
    toast(err.message, { error: true });
    state.together = { partner: null };
  }
  if (state.tab === 'plays') render();
}

function togetherView() {
  if (!state.together) loadTogether();
  const T = state.together;
  const me = state.session.user;
  if (T && !T.partner) return h('div', {}, h('h1', { class: 'page-title' }, 'Together'), h('p', { class: 'muted' }, 'Once the second person has connected their Spotify, a playlist for both of you appears here.'));
  const first = (n) => (n || '').split(' ')[0];
  const btn = h('button', { class: `btn ${T?.made ? 'ghost' : 'accent'}`, disabled: !T?.tracks?.length }, T?.made ? 'Refresh our playlist' : 'Make our playlist');
  btn.addEventListener('click', async () => {
    if (await saveSet(btn, '/api/blend/save', 'Saved to your Spotify. Share it with a tap from Spotify.')) {
      T.made = true;
      btn.textContent = 'Refresh our playlist';
    }
  });
  const colours = { both: 'var(--ink)', a: PALETTE[0], b: PALETTE[1] };
  return h(
    'div',
    {},
    h('h1', { class: 'page-title' }, first(me.name), ' ', h('em', {}, '+'), ' ', first(T?.partner?.name ?? '…')),
    h('p', { class: 'lead-muted' }, 'One playlist that’s genuinely both of you: songs you both play first, then each person’s favourites in equal measure, weighted towards what you’ve played lately. Dealt, so no artist plays twice in a row.'),
    !T
      ? h('div', { class: 'skeleton', style: { height: '260px' } })
      : !T.tracks.length
        ? h('p', { class: 'muted' }, 'You both need some play history first. Give it a day or import your Spotify data.')
        : [
            h(
              'div',
              { class: 'panel balance' },
              h('div', { class: 'balance-bar', role: 'img', 'aria-label': `${T.counts.both} shared, ${T.counts.a} ${first(me.name)}, ${T.counts.b} ${first(T.partner.name)}` }, [['both', T.counts.both], ['a', T.counts.a], ['b', T.counts.b]].filter(([, n]) => n).map(([k, n]) => h('span', { style: { flex: n, background: colours[k] } }))),
              h(
                'div',
                { class: 'legend' },
                h('span', {}, h('i', { style: { background: colours.both } }), `You both play · ${T.counts.both}`),
                h('span', {}, h('i', { style: { background: colours.a } }), `${first(me.name)}’s · ${T.counts.a}`),
                h('span', {}, h('i', { style: { background: colours.b } }), `${first(T.partner.name)}’s · ${T.counts.b}`),
              ),
              h('div', { class: 'actions' }, segmented([['30', '30 songs'], ['50', '50'], ['80', '80']], String(state.togetherSize), (v) => { state.togetherSize = Number(v); state.together = null; render(); }, 'Size'), h('span', { class: 'spacer' }), btn),
            ),
            h(
              'div',
              { class: 'tlist' },
              T.tracks.map((t, i) => h('div', { class: 'rrow' }, h('div', { class: `cover art${t.image ? '' : ' blank'}`, style: t.image ? { backgroundImage: `url("${t.image}")` } : null }), h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, t.name), h('div', { class: 'by' }, t.artist)), h('span', { class: 'who-tag', style: { '--c': colours[t.who] } }, t.who === 'both' ? 'both' : first(t.who === 'a' ? me.name : T.partner.name)))),
            ),
          ],
  );
}

// ---------------------------------------------------------------- wrapped --

state.wrapped = null;
state.wrappedPeriod = null;
async function loadWrapped() {
  const q = new URLSearchParams({ tz, ...(state.wrappedPeriod ? { period: state.wrappedPeriod } : {}) });
  try {
    state.wrapped = await api(`/api/wrapped?${q}`);
    state.wrappedPeriod = state.wrapped.wrapped?.period ?? null;
  } catch (err) {
    toast(err.message, { error: true });
    state.wrapped = { periods: { months: [], years: [] }, wrapped: null };
  }
  if (state.tab === 'plays') render();
}

const hourLabel = (hr) => new Date(Date.UTC(2020, 0, 1, hr)).toLocaleTimeString(undefined, { hour: 'numeric', timeZone: 'UTC' });

function wrappedView() {
  if (!state.wrapped) loadWrapped();
  const W = state.wrapped;
  const w = W?.wrapped;
  const picker = W
    ? h(
        'select',
        { class: 'select', 'aria-label': 'Period', onChange: (e) => { state.wrappedPeriod = e.target.value; state.wrapped = null; render(); } },
        W.periods.years.length ? h('optgroup', { label: 'Years' }, W.periods.years.map((y) => h('option', { value: y, selected: y === state.wrappedPeriod }, y))) : null,
        W.periods.months.length ? h('optgroup', { label: 'Months' }, W.periods.months.map((m) => h('option', { value: m, selected: m === state.wrappedPeriod }, new Date(`${m}-15T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })))) : null,
      )
    : null;
  if (W && !w) return h('div', {}, h('h1', { class: 'page-title' }, 'Wrapped'), h('p', { class: 'muted' }, 'Wrapped needs at least a few weeks of plays. Import your Spotify data to see past years straight away.'));
  const change = w?.prevPlays ? Math.round(((w.plays - w.prevPlays) / w.prevPlays) * 100) : null;
  const card = (cls, ...kids) => h('section', { class: `wcard ${cls}` }, ...kids);
  return h(
    'div',
    {},
    h('div', { class: 'wrapped-head' }, h('h1', { class: 'page-title' }, 'Your ', h('em', {}, w?.label ?? '…')), picker),
    !w
      ? h('div', { class: 'skeleton', style: { height: '420px' } })
      : h(
          'div',
          { class: 'wdeck' },
          card('c-ink', h('div', { class: 'eyebrow' }, w.label), h('div', { class: 'w-huge' }, w.minutes.toLocaleString()), h('div', { class: 'w-sub' }, 'minutes of music'), h('p', {}, `${w.plays.toLocaleString()} plays across ${w.days} days.`, change != null ? ` That’s ${change >= 0 ? `${change}% more` : `${-change}% less`} than ${w.prevLabel}.` : '')),
          card('c-accent', h('div', { class: 'eyebrow' }, 'Your artist'), h('div', { class: 'w-big' }, w.topArtist.name), h('p', {}, `${w.topArtist.plays.toLocaleString()} plays: ${w.topArtist.share}% of everything you listened to.`)),
          card('c-paper', h('div', { class: 'eyebrow' }, 'Top five'), h('ol', { class: 'w-list' }, w.topArtists.map((a) => h('li', {}, h('span', {}, a.name), h('span', { class: 'mono' }, a.plays))))),
          card('c-blue', h('div', { class: 'eyebrow' }, 'Your song'), w.topTrack.image ? h('div', { class: 'w-art', style: { backgroundImage: `url("${w.topTrack.image}")` } }) : null, h('div', { class: 'w-big' }, w.topTrack.name), h('p', {}, `${w.topTrack.artist} · played ${w.topTrack.plays} times`)),
          card('c-paper', h('div', { class: 'eyebrow' }, 'Top songs'), h('ol', { class: 'w-list' }, w.topTracks.map((t) => h('li', {}, h('span', {}, t.name, h('small', {}, t.artist)), h('span', { class: 'mono' }, t.plays))))),
          w.newArtistCount != null
            ? card('c-green', h('div', { class: 'eyebrow' }, 'New to you'), h('div', { class: 'w-huge' }, w.newArtistCount), h('div', { class: 'w-sub' }, `artist${w.newArtistCount === 1 ? '' : 's'} you’d never played before`), w.newArtists.length ? h('p', {}, w.newArtists.join(', ')) : null)
            : null,
          card('c-ink', h('div', { class: 'eyebrow' }, 'When'), h('div', { class: 'w-big' }, hourLabel(w.peakHour)), h('div', { class: 'w-sub' }, 'was your hour'), h('p', {}, `Your biggest day was ${new Date(`${w.bigDay.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, with ${w.bigDay.plays} plays.`)),
          card('c-accent', h('div', { class: 'eyebrow' }, 'You are'), h('div', { class: 'w-big serif-italic' }, w.personality.name), h('p', {}, w.personality.line)),
        ),
    w ? h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Swipe through. Each card is sized for a screenshot.') : null,
  );
}

// ------------------------------------------------------- kids: setup page --

const KIDS_KEY = 'dj_kids_device';
const kidsDevice = () => {
  try {
    return localStorage.getItem(KIDS_KEY) === '1';
  } catch {
    return false;
  }
};
const setKidsDevice = (on) => {
  try {
    on ? localStorage.setItem(KIDS_KEY, '1') : localStorage.removeItem(KIDS_KEY);
  } catch {
    /* private mode: kids mode just won't stick */
  }
};

const KID_PRESETS = [
  ['🚗', 'Car singalong', 'Songs the whole car can sing along to on a drive.'],
  ['🌙', 'Bedtime', 'Calm, gentle wind-down songs for bedtime. Soft and slow all the way through.'],
  ['💃', 'Kitchen disco', 'Dance party in the kitchen. Upbeat, silly, impossible not to move to.'],
  ['☀️', 'Wake up', 'Bright, happy songs for getting ready in the morning.'],
  ['🎬', 'Films & TV', 'The best songs from films and TV shows they’d know.'],
  ['🧩', 'Quiet play', 'Low-key background music for drawing, Lego and quiet play.'],
];
const KID_EMOJI = ['🎵', '🚗', '🌙', '💃', '☀️', '🎬', '🧩', '🦖', '🚀', '🦄', '🐠', '⚽', '🌈', '🐶'];

state.kids = null;
state.kidsBrief = { text: '', length: 20, tolerance: 0.5, kidIds: [], emoji: '🎵', running: false, steps: [], result: null };

async function loadKids() {
  try {
    state.kids = await api('/api/kids');
  } catch (err) {
    toast(err.message, { error: true });
    state.kids = { profiles: [], playlists: [] };
  }
  if (state.tab === 'kids' || state.kidsScreen) render();
}

function kidsView() {
  if (!state.kids) loadKids();
  const K = state.kids;
  const b = state.kidsBrief;
  return h(
    'main',
    { class: 'kidsadmin' },
    h('div', { class: 'eyebrow' }, 'Kids'),
    h('h1', { class: 'page-title' }, 'Kids ', h('em', {}, 'mode.')),
    h(
      'div',
      { class: 'kids-hero panel' },
      h('div', {}, h('p', { class: 'lead' }, 'Turns this phone or tablet into big picture buttons that start their music on the car stereo or the speaker. Every tap is a fresh deal. No menus, no search, and they can’t wander into your stuff: getting out needs a long press.'), h('p', { class: 'muted small' }, 'Kids plays are logged separately and kept out of your own stats and AI picks. In Spotify, you can also turn on “Exclude from your Taste Profile” for these playlists so Spotify’s own recommendations stay yours.')),
      h('button', { class: 'btn accent big', disabled: !K?.playlists.length, onClick: () => (location.hash = '#/kids/play') }, 'Start Kids mode', h('span', { 'aria-hidden': 'true' }, '→')),
    ),
    !state.session.playback
      ? h('div', { class: 'callout' }, 'dj needs one more permission to start music for you. ', h('button', { class: 'linkish', onClick: () => logout(true) }, 'Log in again to allow it'), '. Starting music also needs Spotify Premium.')
      : null,
    !K
      ? h('div', { class: 'skeleton', style: { height: '200px', marginTop: '24px' } })
      : [
          h('h2', { class: 'section-h' }, 'Their buttons'),
          kidsTiles(K.playlists),
          addExisting(K.playlists),
          h('h2', { class: 'section-h' }, 'Who’s listening'),
          kidProfiles(K.profiles),
          h('h2', { class: 'section-h' }, 'Make a new one'),
          kidsMaker(b, K.profiles),
        ],
  );
}

function kidsTiles(list) {
  if (!list.length) return h('p', { class: 'muted' }, 'No buttons yet. Make one below, or add a playlist you already have.');
  return h(
    'div',
    { class: 'ktiles admin' },
    list.map((p) =>
      h(
        'div',
        { class: 'ktile', style: { '--c': p.colour } },
        h('button', { class: 'kemoji', title: 'Change picture', onClick: () => patchKids(p.id, { emoji: KID_EMOJI[(KID_EMOJI.indexOf(p.emoji) + 1) % KID_EMOJI.length] }) }, p.emoji),
        h('div', { class: 'kname' }, p.name),
        h(
          'div',
          { class: 'kctl' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.redeal, onChange: (e) => patchKids(p.id, { redeal: e.target.checked }) }), 'Re-deal each play'),
          h('label', { class: 'sleepsel', title: 'Fade out and stop after this long' }, '🌙', h('select', { 'aria-label': 'Sleep timer', onChange: (e) => patchKids(p.id, { sleep: Number(e.target.value) }) }, [[0, 'No sleep timer'], [20, '20 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour']].map(([v, l]) => h('option', { value: v, selected: (p.sleep ?? 0) === v }, l)))),
          h('button', { class: 'linkish', onClick: () => removeKids(p.id) }, 'Remove'),
        ),
      ),
    ),
  );
}

async function patchKids(id, body) {
  const r = await api(`/api/kids/playlists/${id}`, { method: 'PATCH', body });
  state.kids.playlists = r.playlists;
  render();
}
async function removeKids(id) {
  const r = await api(`/api/kids/playlists/${id}`, { method: 'DELETE' });
  state.kids.playlists = r.playlists;
  render();
}

function addExisting(list) {
  if (!state.playlists) {
    loadPlaylists();
    return null;
  }
  const ids = new Set(list.map((p) => p.id));
  const options = state.playlists.filter((p) => p.canEdit && !ids.has(p.id));
  if (!options.length) return null;
  const sel = h('select', { class: 'select', 'aria-label': 'Add one of your playlists' }, h('option', { value: '' }, 'Add one of your playlists…'), options.map((p) => h('option', { value: p.id }, p.name)));
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      const r = await api('/api/kids/playlists', { method: 'POST', body: { existingId: sel.value } });
      state.kids.playlists = r.playlists;
      render();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  return h('div', { style: { marginTop: '14px' } }, sel);
}

function kidProfiles(profiles) {
  const list = profiles.length ? profiles : [];
  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const r = await api('/api/kids/profiles', { method: 'PUT', body: { profiles: state.kids.profiles } }).catch((e) => toast(e.message, { error: true }));
      if (r) state.kids.profiles = r.profiles;
    }, 500);
  };
  const field = (k, key, label, attrs = {}) =>
    h('label', { class: 'kfield' }, h('span', { class: 'eyebrow' }, label), h('input', { value: k[key] ?? '', ...attrs, onInput: (e) => { k[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; save(); } }));
  return h(
    'div',
    { class: 'kprofiles' },
    list.map((k) =>
      h(
        'div',
        { class: 'kprofile panel' },
        h('div', { class: 'kp-row' }, field(k, 'name', 'Name', { placeholder: 'Mia' }), field(k, 'age', 'Age', { type: 'number', min: 0, max: 17, inputmode: 'numeric', style: { width: '80px' } })),
        field(k, 'likes', 'Loves', { placeholder: 'Frozen, Bluey, Taylor Swift, anything with dinosaurs' }),
        field(k, 'avoid', 'Please avoid', { placeholder: 'Baby Shark (for our sanity)' }),
        h('button', { class: 'linkish', onClick: () => { state.kids.profiles = state.kids.profiles.filter((x) => x !== k); save(); render(); } }, 'Remove'),
      ),
    ),
    h('button', { class: 'btn ghost small', onClick: () => { state.kids.profiles.push({ id: crypto.randomUUID(), name: '', age: null, likes: '', avoid: '' }); render(); } }, '+ Add a kid'),
  );
}

function kidsMaker(b, profiles) {
  const ta = h('textarea', { placeholder: 'Songs for a long drive to Grandma’s', 'aria-label': 'What is it for?', disabled: b.running, onInput: (e) => (b.text = e.target.value) });
  ta.value = b.text;
  const tolOut = h('output', {}, tolLabel(b.tolerance));
  return h(
    'div',
    {},
    h('div', { class: 'chips' }, KID_PRESETS.map(([emo, name, text], i) => h('button', { class: `chip${b.emoji === emo && b.text === text ? ' on' : ''}`, style: { animationDelay: `${i * 40}ms` }, disabled: b.running, onClick: () => { b.text = text; b.emoji = emo; b.name = name; render(); } }, `${emo} ${name}`))),
    h(
      'div',
      { class: 'prompt', style: { marginTop: '14px' } },
      ta,
      h(
        'div',
        { class: 'prompt-foot' },
        profiles.length > 1 ? h('div', { class: 'kidpick' }, profiles.map((k) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !b.kidIds.length || b.kidIds.includes(k.id), onChange: (e) => { const all = b.kidIds.length ? b.kidIds : profiles.map((p) => p.id); b.kidIds = e.target.checked ? [...new Set([...all, k.id])] : all.filter((x) => x !== k.id); } }), k.name || 'Unnamed'))) : null,
        lengthKnob(b, { songs: [8, 50], label: 'Length' }),
        h('label', { class: 'knob' }, h('span', { class: 'lbl' }, h('span', { class: 'eyebrow' }, 'Them ↔ Everyone'), tolOut), h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: b.tolerance, disabled: b.running, onInput: (e) => { b.tolerance = +e.target.value; tolOut.textContent = tolLabel(b.tolerance); } })),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn accent', disabled: b.running || !state.session.ai, onClick: () => streamBrief(b, '/api/kids/brief', () => ({ brief: b.text, length: b.length, tolerance: b.tolerance, kidIds: b.kidIds, minutes: b.byTime ? b.minutes : null })) }, b.running ? 'Working…' : 'Make it'),
      ),
    ),
    !profiles.length ? h('p', { class: 'muted small' }, 'Tip: add the kids above first, with ages, so the picks fit them.') : null,
    !state.session.ai ? h('div', { class: 'setup' }, 'Making playlists needs ', h('code', {}, 'ANTHROPIC_API_KEY'), '. You can still add playlists you already have.') : null,
    b.steps.length ? progressView(b.steps) : null,
    b.result ? kidsResult(b) : null,
  );
}

const tolLabel = (t) => (t >= 0.7 ? 'fun for everyone' : t >= 0.35 ? 'mostly them' : 'all theirs');

function kidsResult(b) {
  const r = b.result;
  const name = h('input', { class: 'result-title', value: b.name ? `${b.name}` : r.title, 'aria-label': 'Button name', onInput: (e) => (b.name = e.target.value) });
  return h(
    'section',
    { class: 'result' },
    h('div', { class: 'eyebrow' }, 'New button'),
    h('div', { class: 'kr-head' }, h('button', { class: 'kemoji solo', style: { '--c': '#eb6834' }, title: 'Change picture', onClick: () => { b.emoji = KID_EMOJI[(KID_EMOJI.indexOf(b.emoji) + 1) % KID_EMOJI.length]; render(); } }, b.emoji), name),
    h('p', { class: 'result-desc' }, r.description),
    h(
      'div',
      {},
      r.tracks.map((t, i) =>
        h(
          'div',
          { class: 'brow' },
          h('span', { class: 'idx' }, i + 1),
          h('div', { class: `cover art${t.image ? '' : ' blank'}`, style: t.image ? { backgroundImage: `url("${t.image}")` } : null }),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, t.name, t.known ? h('span', { class: 'tag known' }, 'a favourite') : null), h('div', { class: 'by' }, artistNames(t)), t.why ? h('div', { class: 'why' }, t.why) : null),
          h('span'),
          h('button', { class: 'x', 'aria-label': `Remove ${t.name}`, onClick: () => { r.tracks = r.tracks.filter((x) => x !== t); render(); } }, '×'),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, 'Explicit tracks are filtered out automatically. Give it a listen-through anyway: you know your kids.'),
    h(
      'div',
      { class: 'sticky-save' },
      h('span', { class: 'mono' }, plural(r.tracks.length, 'track')),
      h(
        'span',
        { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn ghost small', onClick: () => streamBrief(b, '/api/kids/brief', () => ({ brief: b.text, length: b.length, tolerance: b.tolerance, kidIds: b.kidIds, minutes: b.byTime ? b.minutes : null })) }, 'Try again'),
        h('button', {
          class: 'btn accent small',
          disabled: !r.tracks.length,
          onClick: async (e) => {
            e.target.disabled = true;
            try {
              const res = await api('/api/kids/playlists', { method: 'POST', body: { name: b.name || r.title, description: `${r.description} Made for Kids mode by dj.`, uris: r.tracks.map((t) => t.uri), emoji: b.emoji } });
              state.kids.playlists = res.playlists;
              b.result = null;
              b.steps = [];
              b.text = '';
              b.name = '';
              state.playlists = null;
              toast('Added to Kids mode.');
              render();
              scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
            } catch (err) {
              e.target.disabled = false;
              toast(err.message, { error: true });
            }
          },
        }, 'Add to Kids mode'),
      ),
    ),
  );
}

// ------------------------------------------------------ kids: the screen --

let playerTimer = null;
let wakeLock = null;
function stopPlayerPoll() {
  clearInterval(playerTimer);
  playerTimer = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

function kidsScreen() {
  if (!state.kids) loadKids();
  const list = state.kids?.playlists ?? [];
  const now = h('div', { class: 'know' });
  const msg = h('div', { class: 'kmsg', hidden: true });

  const refresh = async () => {
    try {
      const p = await api('/api/player');
      renderNow(now, p);
    } catch {
      /* offline or no player: leave as is */
    }
  };
  refresh();
  playerTimer = setInterval(refresh, 5000);
  // Keep the screen on in the car.
  navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});

  const tap = async (p, el) => {
    if (el.classList.contains('starting')) return;
    el.classList.add('starting');
    msg.hidden = true;
    try {
      await api(`/api/kids/play/${p.id}`, { method: 'POST' });
      el.classList.add('go');
      setTimeout(refresh, 1200);
    } catch (err) {
      msg.hidden = false;
      msg.replaceChildren(h('div', { class: 'kmsg-emoji' }, '😴'), h('p', {}, err.message), h('a', { class: 'btn big', href: `https://open.spotify.com/playlist/${p.id}`, target: '_blank', rel: 'noopener' }, 'Open Spotify'), h('button', { class: 'linkish', onClick: () => (msg.hidden = true) }, 'Close'));
    }
    setTimeout(() => el.classList.remove('starting', 'go'), 900);
  };

  return h(
    'div',
    { class: 'kscreen' },
    h('header', { class: 'kbar' }, h('span', { class: 'wordmark' }, 'dj', h('i', {}, '.'), h('span', { class: 'kids-word' }, 'kids')), holdToExit()),
    !state.kids
      ? h('div', { class: 'ktiles' }, [0, 1, 2, 3].map(() => h('div', { class: 'ktile skeleton' })))
      : list.length
        ? h('div', { class: 'ktiles' }, list.map((p, i) => {
            const el = h('button', { class: 'ktile', style: { '--c': p.colour, animationDelay: `${i * 60}ms` }, onClick: () => tap(p, el) }, h('span', { class: 'kemoji' }, p.emoji), h('span', { class: 'kname' }, p.name));
            return el;
          }))
        : h('div', { class: 'kmsg' }, h('p', {}, 'No buttons yet. Hold the corner to go back and add some.')),
    now,
    msg,
  );
}

function renderNow(host, p) {
  if (!p.track) {
    host.replaceChildren();
    return;
  }
  host.replaceChildren(
    h(
      'div',
      { class: 'know-inner' },
      h('div', { class: 'cover', style: p.track.image ? { backgroundImage: `url("${p.track.image}")` } : null }),
      h('div', { class: 'know-t' }, h('div', { class: 'name' }, p.track.name), h('div', { class: 'by' }, p.sleep ? h('span', { class: 'zz' }, p.sleep.fading ? '🌙 Getting sleepy…' : `🌙 ${Math.max(1, Math.round((p.sleep.endsAt - Date.now()) / 60000))} min left`) : p.track.artists)),
      h('button', { class: 'kbtn', 'aria-label': p.playing ? 'Pause' : 'Play', onClick: async () => { await api(`/api/player/${p.playing ? 'pause' : 'resume'}`, { method: 'POST' }).catch((e) => toast(e.message, { error: true })); p.playing = !p.playing; renderNow(host, p); } }, p.playing ? icon('pause') : icon('play')),
      h('button', { class: 'kbtn', 'aria-label': 'Next song', onClick: async () => { await api('/api/player/next', { method: 'POST' }).catch((e) => toast(e.message, { error: true })); setTimeout(async () => renderNow(host, await api('/api/player')), 700); } }, icon('next')),
    ),
  );
}

function icon(name) {
  const paths = {
    play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
    pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
    next: 'M5 5.6v12.8a1 1 0 0 0 1.53.85L15 13.6V18a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v4.4L6.53 4.75A1 1 0 0 0 5 5.6z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

// A grown-up gate: press and hold for 2 seconds.
function holdToExit() {
  const HOLD = 2000;
  let raf = null;
  let start = 0;
  const ring = h('span', { class: 'hold-ring' });
  const btn = h('button', { class: 'hold', 'aria-label': 'Grown-ups: press and hold to leave Kids mode' }, ring, h('span', { class: 'hold-label' }, 'Hold'));
  const stop = () => {
    cancelAnimationFrame(raf);
    btn.style.setProperty('--p', 0);
    btn.classList.remove('holding');
  };
  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / HOLD);
    btn.style.setProperty('--p', p);
    if (p >= 1) {
      stop();
      setKidsDevice(false);
      location.hash = '#/kids';
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    start = performance.now();
    btn.classList.add('holding');
    raf = requestAnimationFrame(tick);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return btn;
}


// --------------------------------------------------------------- passkeys --
// Spotify links your account once; after that, devices sign in to dj with a
// passkey (Face ID, Touch ID, fingerprint).

const webauthn = () => import('/vendor/simplewebauthn/index.js');
const NUDGE_KEY = 'dj_passkey_nudge_dismissed';

function keyIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11.2 11.2 20 20m-3.5-3.5 2-2m-4.5-.5 2-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return svg;
}

function deviceName() {
  const ua = navigator.userAgent;
  const device = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'This device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}

const cancelled = (err) => err?.name === 'NotAllowedError' || err?.name === 'AbortError';

async function passkeySignIn() {
  try {
    const { startAuthentication, browserSupportsWebAuthn } = await webauthn();
    if (!browserSupportsWebAuthn()) return toast('This browser doesn’t support passkeys. Use Connect Spotify instead.', { error: true });
    const optionsJSON = await api('/auth/passkey/options', { method: 'POST', body: {} });
    const response = await startAuthentication({ optionsJSON });
    await api('/auth/passkey/verify', { method: 'POST', body: { response } });
    state.session = await fetch('/api/session').then((r) => r.json());
    route();
  } catch (err) {
    if (cancelled(err)) return;
    toast(err.message || 'Sign-in failed.', { error: true, ms: 8000 });
  }
}

async function addPasskey() {
  try {
    const { startRegistration, browserSupportsWebAuthn } = await webauthn();
    if (!browserSupportsWebAuthn()) throw new Error('This browser doesn’t support passkeys.');
    const optionsJSON = await api('/api/passkeys/options', { method: 'POST', body: {} });
    const response = await startRegistration({ optionsJSON });
    const r = await api('/api/passkeys', { method: 'POST', body: { response, name: deviceName() } });
    state.session.passkeys.count = r.passkeys.length;
    toast('Passkey saved. Next time, sign in with it.');
    return r.passkeys;
  } catch (err) {
    if (err?.name === 'InvalidStateError') toast('This device already has a dj passkey for you.');
    else if (!cancelled(err)) toast(err.message || 'Couldn’t create a passkey.', { error: true, ms: 8000 });
    return null;
  }
}

function passkeyNudge() {
  const pk = state.session.passkeys;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(NUDGE_KEY) === '1';
  } catch {
    /* ignore */
  }
  if (!pk?.available || pk.count > 0 || dismissed) return null;
  const el = h(
    'div',
    { class: 'nudge' },
    h('span', { class: 'nudge-icon' }, keyIcon()),
    h('div', { class: 'nudge-text' }, h('b', {}, 'Skip Spotify next time. '), 'Add a passkey and sign in to dj with Face ID or your fingerprint, on this device and any other.'),
    h('button', { class: 'btn accent small', onClick: async () => { if (await addPasskey()) el.remove(); } }, 'Add a passkey'),
    h('button', { class: 'linkish', onClick: () => { try { localStorage.setItem(NUDGE_KEY, '1'); } catch { /* ignore */ } el.remove(); } }, 'Not now'),
  );
  return el;
}

async function openPasskeys() {
  const list = h('div', { class: 'pk-list' }, h('div', { class: 'skeleton', style: { height: '56px' } }));
  const dlg = h(
    'dialog',
    { class: 'sheet', 'aria-label': 'Passkeys' },
    h('div', { class: 'sheet-head' }, h('h2', { class: 'serif' }, 'Passkeys'), h('button', { class: 'x', 'aria-label': 'Close', onClick: () => dlg.close() }, '×')),
    h('p', { class: 'muted' }, 'Each passkey signs you in to dj on the devices it syncs to (iCloud Keychain, Google Password Manager and so on). Removing one here stops it working.'),
    list,
    h('div', { class: 'actions' }, h('button', { class: 'btn accent', onClick: async () => { const r = await addPasskey(); if (r) fill(r); } }, keyIcon(), 'Add a passkey on this device')),
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  document.body.append(dlg);
  dlg.showModal();

  function fill(passkeys) {
    state.session.passkeys.count = passkeys.length;
    list.replaceChildren(
      ...(passkeys.length
        ? passkeys.map((p) =>
            h(
              'div',
              { class: 'pk' },
              h('span', { class: 'pk-icon' }, keyIcon()),
              h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, p.name), h('div', { class: 'mono muted' }, `Added ${new Date(p.createdAt).toLocaleDateString()}`, p.lastUsedAt ? ` · last used ${ago(p.lastUsedAt)}` : ' · not used yet', p.backedUp ? ' · synced' : '')),
              h('button', {
                class: 'linkish',
                onClick: async () => {
                  if (!confirm(`Remove “${p.name}”? It will stop signing you in.`)) return;
                  fill((await api(`/api/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' })).passkeys);
                },
              }, 'Remove'),
            ),
          )
        : [h('p', { class: 'muted' }, 'No passkeys yet.')]),
    );
  }
  try {
    fill((await api('/api/passkeys')).passkeys);
  } catch (err) {
    toast(err.message, { error: true });
  }
}


// ---------------------------------------------------------- agents & api --
// Personal access tokens, plus copy-paste setup for MCP clients (Hermes,
// Claude, …), the `dj` CLI + skill (Pi and any shell-capable agent) and HTTP.

function copyBtn(getText, label = 'Copy') {
  const b = h('button', { class: 'btn ghost small copy', type: 'button' }, label);
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select and copy';
    }
    setTimeout(() => (b.textContent = label), 1600);
  });
  return b;
}

function snippet(title, text, note) {
  return h('div', { class: 'snip' }, h('div', { class: 'snip-head' }, h('b', {}, title), copyBtn(() => text)), note ? h('p', { class: 'muted small' }, note) : null, h('pre', {}, h('code', {}, text)));
}

function setupGuides(info, token) {
  const T = token || '<your token>';
  const mcp = info.mcpUrl;
  const app = info.appUrl;
  const guides = {
    hermes: [
      snippet('Add to ~/.hermes/config.yaml', `mcp_servers:\n  dj:\n    url: "${mcp}"\n    headers:\n      Authorization: "Bearer ${T}"`, 'Then run /reload-mcp in Hermes.'),
    ],
    pi: [
      snippet('1. Install the dj command (needs Node 18+)', `mkdir -p ~/.local/bin && curl -fsSL ${app}/cli/dj -o ~/.local/bin/dj && chmod +x ~/.local/bin/dj`),
      snippet('2. Connect it', `dj login ${app} ${T}`),
      snippet('3. Teach Pi to use it', `mkdir -p ~/.pi/agent/skills/dj && curl -fsSL ${app}/skill/SKILL.md -o ~/.pi/agent/skills/dj/SKILL.md`, 'Other agents that read Agent Skills: use ~/.agents/skills/dj instead.'),
    ],
    claude: [
      snippet('Claude Code', `claude mcp add --transport http dj ${mcp} --header "Authorization: Bearer ${T}"`),
      h('p', { class: 'muted small' }, 'Claude Desktop and other MCP apps: add a remote MCP server with the URL and header below. Claude on the web and phone connect from Anthropic’s servers, so they can only reach dj if it’s public (e.g. Tailscale Funnel).'),
    ],
    other: [
      snippet('MCP server', `URL:    ${mcp}\nHeader: Authorization: Bearer ${T}`, 'Streamable HTTP, stateless. Works with any MCP client that can send a header.'),
      snippet('HTTP API', `curl -s -X POST ${info.apiUrl}/actions/listening_stats \\\n  -H "Authorization: Bearer ${T}" -H "Content-Type: application/json" \\\n  -d '{"range":"7d"}'`, `Every action is POST ${info.apiUrl}/actions/<name>. OpenAPI: ${info.apiUrl}/openapi.json`),
    ],
  };
  let current = 'hermes';
  const body = h('div', { class: 'guide-body' });
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const show = (k) => {
    current = k;
    body.replaceChildren(...guides[k]);
    for (const b of tabs.children) b.setAttribute('aria-checked', String(b.dataset.k === current));
  };
  for (const [k, l] of [['hermes', 'Hermes'], ['pi', 'Pi & CLI'], ['claude', 'Claude'], ['other', 'Other']]) {
    const b = h('button', { role: 'tab', 'data-k': k, onClick: () => show(k) }, l);
    tabs.append(b);
  }
  show(current);
  return h('div', { class: 'guides' }, tabs, body);
}

async function openAgents() {
  const list = h('div', { class: 'pk-list' }, h('div', { class: 'skeleton', style: { height: '56px' } }));
  const reveal = h('div', {});
  const guideHost = h('div', {});
  let info = null;
  const name = h('input', { class: 'kfield-input', placeholder: 'e.g. Hermes on laptop', 'aria-label': 'Token name', maxlength: 60 });
  const ro = h('input', { type: 'checkbox' });

  const dlg = h(
    'dialog',
    { class: 'sheet wide', 'aria-label': 'Agents & API' },
    h('div', { class: 'sheet-head' }, h('h2', { class: 'serif' }, 'Agents & API'), h('button', { class: 'x', 'aria-label': 'Close', onClick: () => dlg.close() }, '×')),
    h('p', { class: 'muted' }, 'Let an AI agent or script use dj as you: Hermes, Pi, Claude, or anything that speaks MCP, runs commands or calls HTTP. Each token acts as you only, and can be read-only.'),
    h(
      'div',
      { class: 'tok-new' },
      name,
      h('label', { class: 'check' }, ro, 'Read-only'),
      h('button', {
        class: 'btn accent small',
        onClick: async () => {
          try {
            const r = await api('/api/tokens', { method: 'POST', body: { name: name.value.trim() || 'Agent', readOnly: ro.checked } });
            name.value = '';
            reveal.replaceChildren(
              h(
                'div',
                { class: 'tok-reveal' },
                h('b', {}, `Your token for “${r.entry.name}”`),
                h('p', { class: 'small' }, 'Copy it now: dj only keeps a fingerprint and can’t show it again. The setup below already has it filled in.'),
                h('div', { class: 'tok-row' }, h('code', {}, r.token), copyBtn(() => r.token)),
              ),
            );
            guideHost.replaceChildren(setupGuides(info, r.token));
            await refresh();
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      }, 'Create token'),
    ),
    reveal,
    h('h3', { class: 'eyebrow', style: { margin: '20px 0 6px' } }, 'Set up'),
    guideHost,
    h('h3', { class: 'eyebrow', style: { margin: '22px 0 6px' } }, 'Your tokens'),
    list,
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  document.body.append(dlg);
  dlg.showModal();

  async function refresh() {
    const r = await api('/api/tokens');
    info = r;
    if (!guideHost.children.length) guideHost.replaceChildren(setupGuides(info, null));
    list.replaceChildren(
      ...(r.tokens.length
        ? r.tokens.map((t) =>
            h(
              'div',
              { class: 'pk' },
              h('span', { class: 'pk-icon' }, keyIcon()),
              h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, t.name, t.readOnly ? h('span', { class: 'tag known' }, 'read-only') : null), h('div', { class: 'mono muted' }, `${t.hint} · made ${new Date(t.createdAt).toLocaleDateString()}`, t.lastUsedAt ? ` · used ${ago(t.lastUsedAt)}` : ' · not used yet')),
              h('button', {
                class: 'linkish',
                onClick: async () => {
                  if (!confirm(`Revoke “${t.name}”? Anything using it stops working.`)) return;
                  await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
                  refresh();
                },
              }, 'Revoke'),
            ),
          )
        : [h('p', { class: 'muted' }, 'No tokens yet.')]),
    );
  }
  try {
    await refresh();
  } catch (err) {
    toast(err.message, { error: true });
  }
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
