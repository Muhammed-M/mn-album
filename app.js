// Our Album — live photo table + album for the engagement party.
// Reads from the Cloudflare Worker (admin routes, unlocked with the ADMIN_KEY).

const WORKER = 'https://mn-cam-upload.mohamed-mahmoud9935.workers.dev';
const POLL_MS = 5000;          // how often we ask for new photos
const DROP_EVERY_MS = 1400;    // a burst of new photos lands one by one
const TABLE_MAX_WIDE = 36;      // photos kept on the live table (laptop / TV)
const TABLE_MAX_NARROW = 18;    // … on a phone
const KEY_STORE = 'mn-album.key';


// The couple's names live in ONE file, shared with the guest camera (same site).
// If it can't load, the placeholders stay.
const COUPLE = await Promise.race([
  import('../mn-cam/js/couple.js').then((m) => m.COUPLE),
  new Promise((_, no) => setTimeout(no, 3000)),
]).catch(() => ({ groom: 'Groom', bride: 'Bride' }));
document.querySelectorAll('[data-couple]').forEach((n) => { n.textContent = COUPLE[n.dataset.couple]; });
document.title = `Our Album · ${COUPLE.groom} & ${COUPLE.bride}`;
document.documentElement.classList.add('couple-ready');

const $ = (id) => document.getElementById(id);
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  key: ls.get(KEY_STORE),
  token: '',
  items: new Map(),      // key → item
  lastUploaded: 0,
  view: 'live',
  guest: 'all',          // album filter
  viewerList: [],
  viewerIndex: 0,
  pollTimer: null,
  dropQueue: [],
  dropping: false,
  newSinceScroll: 0,
};

// ───────── Item helpers ─────────
// key: "sara-ab12cd/20261127-213045_1764279045123-x7k2p9.jpg"
function toItem(raw) {
  const folder = raw.k.split('/')[0];
  const m = raw.k.match(/_(\d{13})-/);
  const name = folder.replace(/-[a-z0-9]{6}$/, '').split('-').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Guest';
  return { key: raw.k, size: raw.s, uploaded: raw.u, thumb: !!raw.t, taken: m ? Number(m[1]) : raw.u, guest: name };
}
const imgUrl = (key) => `${WORKER}/img/${encodeURI(key)}?t=${encodeURIComponent(state.token)}`;
const fullUrl = (it) => imgUrl(it.key);
const thumbUrl = (it) => (it.thumb ? imgUrl(`_thumbs/${it.key}`) : fullUrl(it));
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const hourFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', hour: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ───────── Unlock ─────────
$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('key').value.trim();
  if (!key) return;
  $('btn-unlock').disabled = true;
  $('unlock-err').hidden = true;
  const ok = await tryKey(key);
  $('btn-unlock').disabled = false;
  if (ok) { ls.set(KEY_STORE, key); state.key = key; $('key').value = ''; start(); }
});

async function tryKey(key) {
  try {
    const res = await fetch(`${WORKER}/admin/list?since=${Date.now()}`, { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' });
    if (res.status === 401) return unlockError('That key didn’t work. Try again.');
    if (!res.ok) return unlockError('The album isn’t reachable right now. Try again in a moment.');
    return true;
  } catch {
    return unlockError('No connection. Check your internet and try again.');
  }
}
function unlockError(msg) { $('unlock-err').textContent = msg; $('unlock-err').hidden = false; return false; }

function showUnlock(msg) {
  stopPolling();
  $('shell').hidden = true;
  $('unlock').hidden = false;
  if (msg) unlockError(msg);
}

$('btn-lock').addEventListener('click', () => {
  ls.del(KEY_STORE); state.key = null;
  state.items.clear(); state.lastUploaded = 0; state.dropQueue = [];
  $('pile').replaceChildren(); $('sections').replaceChildren(); tiles.clear();
  showUnlock();
});

// ───────── Start + polling ─────────
async function start() {
  $('unlock').hidden = true;
  $('shell').hidden = false;
  setView(location.hash === '#album' ? 'album' : 'live');
  await poll(true);
  schedulePoll();
}

function schedulePoll() {
  stopPolling();
  state.pollTimer = setTimeout(async () => { await poll(false); schedulePoll(); }, POLL_MS);
}
function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }

document.addEventListener('visibilitychange', () => {
  if (!state.key || $('shell').hidden) return;
  if (document.hidden) stopPolling();
  else { poll(false).then(schedulePoll); }
});

async function poll(initial) {
  // Ask a little further back than strictly needed so previews that land a moment
  // after their photo are picked up too.
  const since = initial ? 0 : Math.max(0, state.lastUploaded - 15000);
  try {
    const res = await fetch(`${WORKER}/admin/list${since ? `?since=${since}` : ''}`, {
      headers: { Authorization: `Bearer ${state.key}` }, cache: 'no-store',
    });
    if (res.status === 401) { ls.del(KEY_STORE); state.key = null; showUnlock('The album key changed. Enter the new one.'); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.token = data.token;
    setLive('live');

    const fresh = [];
    for (const raw of data.items) {
      const known = state.items.get(raw.k);
      if (known) { if (raw.t && !known.thumb) known.thumb = true; continue; }
      const it = toItem(raw);
      state.items.set(it.key, it);
      fresh.push(it);
      state.lastUploaded = Math.max(state.lastUploaded, it.uploaded);
    }
    if (initial) seedPile();
    else if (fresh.length) {
      fresh.sort((a, b) => a.uploaded - b.uploaded).forEach((it) => state.dropQueue.push(it));
      runDrops();
    }
    if (initial || fresh.length) { renderStats(); renderAlbum(initial ? [] : fresh); }
  } catch (err) {
    console.warn('poll failed', err);
    setLive('offline');
  }
}

function setLive(s) {
  $('live-pill').dataset.state = s;
  $('live-text').textContent = s === 'live' ? 'Live' : s === 'offline' ? 'Reconnecting…' : 'Connecting';
}

function sorted(list = [...state.items.values()]) { return list.sort((a, b) => b.taken - a.taken); }

function renderStats() {
  const all = [...state.items.values()];
  const guests = new Set(all.map((i) => i.guest)).size;
  $('stat-photos').textContent = all.length;
  $('stat-photos').nextElementSibling.textContent = all.length === 1 ? 'moment' : 'moments';
  $('stat-guests').textContent = guests;
  $('stat-guests').nextElementSibling.textContent = guests === 1 ? 'guest' : 'guests';
  $('live-empty').hidden = all.length > 0;
}

// ───────── Views ─────────
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
function setView(v) {
  state.view = v;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $('view-live').hidden = v !== 'live';
  $('view-album').hidden = v !== 'album';
  history.replaceState(null, '', v === 'album' ? '#album' : '#live');
  if (v === 'album') { state.newSinceScroll = 0; $('new-pill').hidden = true; }
}

$('btn-full').hidden = !document.fullscreenEnabled;
$('btn-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

// ───────── Live: photos land on the pile ─────────
async function seedPile() {
  // Start with the latest few already lying on the table (oldest first, no animation).
  const n = window.innerWidth < 640 ? 5 : 9;
  const latest = [...state.items.values()].sort((a, b) => b.uploaded - a.uploaded).slice(0, n).reverse();
  // Load them all at once, but lay them down strictly in order so the newest ends on top.
  const ready = latest.map((it) => loadImage(it));
  for (let i = 0; i < latest.length; i++) placeCard(latest[i], false, await ready[i]);
}

function loadImage(it) {
  const img = new Image();
  img.alt = `Photo by ${it.guest}`;
  img.src = fullUrl(it);
  // Never let one slow or broken photo hold up the ones behind it.
  return Promise.race([img.decode().catch(() => {}), wait(4000)]).then(() => img);
}

async function runDrops() {
  if (state.dropping) return;
  state.dropping = true;
  while (state.dropQueue.length) {
    const it = state.dropQueue.shift();
    await placeCard(it, true);
    if (state.dropQueue.length) await wait(DROP_EVERY_MS);
  }
  state.dropping = false;
}

// The whole Live area is a table: each photo is thrown to its own random spot,
// choosing the spot that covers the last few photos the least, so the newest
// 2–3 always stay visible while older ones slowly get buried underneath.
function chooseSpot(table, card) {
  const W = table.clientWidth, H = table.clientHeight;
  const w = card.offsetWidth, h = card.offsetHeight;
  const m = 16; // keep tilted corners on screen
  const minX = w / 2 + m, maxX = Math.max(minX, W - w / 2 - m);
  const minY = h / 2 + m, maxY = Math.max(minY, H - h / 2 - m);
  const recent = [...table.children]
    .filter((c) => c !== card && !c.dataset.leaving && c.dataset.cx)
    .slice(-3)
    .map((c, i) => ({ x: c.dataset.cx * W, y: c.dataset.cy * H, f: 1 - 0.15 * i })); // newest last → smallest f → kept clearest
  let best = null, bestScore = -1;
  for (let i = 0; i < 24; i++) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    // Distance to the recent photos; the very latest counts most.
    const score = recent.length
      ? Math.min(...recent.map((p) => Math.hypot(p.x - x, p.y - y) * p.f))
      : Math.random();
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  return { fx: best.x / W, fy: best.y / H };
}

async function placeCard(it, animate, preloaded) {
  const img = preloaded || await loadImage(it);

  const card = document.createElement('figure');
  card.className = 'polaroid';
  const cap = document.createElement('figcaption');
  const who = document.createElement('b'); who.textContent = it.guest;
  const when = document.createElement('span'); when.textContent = timeFmt.format(it.taken);
  cap.append(who, when);
  card.append(img, cap);
  card.addEventListener('click', () => openViewer(sorted(), it.key));

  const table = $('pile');
  card.style.visibility = 'hidden';
  table.append(card);                       // measure its real size first
  const spot = chooseSpot(table, card);
  card.dataset.cx = spot.fx; card.dataset.cy = spot.fy;
  card.style.left = `${spot.fx * 100}%`;
  card.style.top = `${spot.fy * 100}%`;
  const narrow = window.innerWidth < 640;
  const r = (Math.random() * 2 - 1) * (narrow ? 9 : 14);
  const rest = `translate(-50%, -50%) rotate(${r.toFixed(2)}deg)`;
  card.style.transform = rest;
  card.style.visibility = '';
  $('live-empty').hidden = true;

  if (animate) {
    // Top-down view of the table, like dropping a print from your hand: it starts
    // a little closer to you, falls with gravity (speeding up), touches down and
    // glides a few pixels as it settles flat — light, quick, no springy bounce.
    const tilt = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 4);
    const slideX = Math.round(Math.random() * 12 - 6), slideY = Math.round(Math.random() * 12 - 6);
    const at = (dx, dy, rot, sc) => `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${sc})`;
    await card.animate([
      { transform: at(-slideX * 2, -slideY * 2, r + tilt, 1.42), opacity: 0, boxShadow: '18px 36px 50px rgba(0,0,0,.08)', easing: 'cubic-bezier(.4,0,.8,.55)' },
      { opacity: 1, offset: 0.12 },
      { transform: at(-slideX, -slideY, r + tilt * 0.2, 1), boxShadow: '1px 2px 8px rgba(0,0,0,.26)', offset: 0.62, easing: 'cubic-bezier(.2,.75,.25,1)' },
      { transform: rest, opacity: 1, boxShadow: '3px 5px 30px rgba(0,0,0,.22)' },
    ], { duration: 680 }).finished.catch(() => {});
  }

  // The table keeps a few dozen photos; the oldest (buried at the bottom) quietly leave.
  const max = narrow ? TABLE_MAX_NARROW : TABLE_MAX_WIDE;
  const cards = [...table.children].filter((c) => !c.dataset.leaving);
  cards.slice(0, Math.max(0, cards.length - max)).forEach((old) => {
    old.dataset.leaving = '1';
    old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, fill: 'forwards' });
    setTimeout(() => old.remove(), 550);
  });
}

// ───────── Album ─────────
const tiles = new Map(); // key → <button class="tile">

function tileFor(it, fresh) {
  let t = tiles.get(it.key);
  if (!t) {
    t = document.createElement('button');
    t.className = 'tile';
    t.type = 'button';
    t.dataset.key = it.key;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = `Photo by ${it.guest}, ${timeFmt.format(it.taken)}`;
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.src = thumbUrl(it);
    t.append(img);
    if (fresh) t.classList.add('fresh');
    tiles.set(it.key, t);
  } else if (it.thumb && !t.firstChild.classList.contains('loaded')) {
    t.firstChild.src = thumbUrl(it); // preview arrived after the photo
  }
  return t;
}

function renderAlbum(fresh = []) {
  const freshKeys = new Set(fresh.map((f) => f.key));
  const all = sorted();

  // Guest chips
  const counts = new Map();
  all.forEach((it) => counts.set(it.guest, (counts.get(it.guest) || 0) + 1));
  if (state.guest !== 'all' && !counts.has(state.guest)) state.guest = 'all';
  const chips = [['all', 'Everyone', all.length], ...[...counts].sort((a, b) => b[1] - a[1]).map(([g, n]) => [g, g, n])];
  $('chips').replaceChildren(...chips.map(([id, label, n]) => {
    const c = document.createElement('button');
    c.className = 'chip'; c.type = 'button';
    c.setAttribute('aria-pressed', String(state.guest === id));
    c.append(label, Object.assign(document.createElement('small'), { textContent: n }));
    c.addEventListener('click', () => { state.guest = id; renderAlbum(); window.scrollTo({ top: 0 }); });
    return c;
  }));

  // Sections by hour (tiles are reused, so images never reload)
  const shown = state.guest === 'all' ? all : all.filter((it) => it.guest === state.guest);
  const groups = new Map();
  shown.forEach((it) => {
    const d = new Date(it.taken); d.setMinutes(0, 0, 0);
    const k = d.getTime();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  });
  const sections = [...groups].map(([hour, list]) => {
    const sec = document.createElement('section');
    sec.className = 'hour';
    const h = document.createElement('h2');
    h.append(hourFmt.format(hour), Object.assign(document.createElement('small'), { textContent: plural(list.length, 'photo') }));
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.append(...list.map((it) => {
      const t = tileFor(it, freshKeys.has(it.key) && fresh.length < 30);
      t.onclick = () => openViewer(shown, it.key);
      return t;
    }));
    sec.append(h, grid);
    return sec;
  });
  $('sections').replaceChildren(...sections);
  $('album-empty').hidden = shown.length > 0;

  // New photos while scrolled down → a pill to jump back up
  if (fresh.length && state.view === 'album' && window.scrollY > 300 && tiles.size > fresh.length) {
    state.newSinceScroll += fresh.length;
    $('new-pill').textContent = `↑ ${plural(state.newSinceScroll, 'new photo')}`;
    $('new-pill').hidden = false;
  }
}
$('new-pill').addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); });
window.addEventListener('scroll', () => {
  if (window.scrollY < 120 && !$('new-pill').hidden) { $('new-pill').hidden = true; state.newSinceScroll = 0; }
}, { passive: true });

// ───────── Viewer ─────────
function openViewer(list, key) {
  state.viewerList = list;
  state.viewerIndex = Math.max(0, list.findIndex((i) => i.key === key));
  $('viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  showInViewer();
  $('viewer').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
}
function closeViewer() {
  $('viewer').hidden = true;
  document.body.style.overflow = '';
  $('v-img').removeAttribute('src');
  $('v-low').removeAttribute('src');
}
function showInViewer() {
  const list = state.viewerList, i = state.viewerIndex, it = list[i];
  if (!it) return closeViewer();
  $('v-who').textContent = it.guest;
  $('v-when').textContent = timeFmt.format(it.taken);
  $('v-count').textContent = `${i + 1} of ${list.length}`;
  $('v-prev').disabled = i === 0;
  $('v-next').disabled = i === list.length - 1;
  const low = $('v-low'), img = $('v-img');
  low.src = thumbUrl(it);            // instant, then the full photo fades in on top
  img.classList.remove('loaded');
  img.alt = `Photo by ${it.guest}`;
  img.onload = () => img.classList.add('loaded');
  img.src = fullUrl(it);
  // Warm up the neighbours for instant swiping
  [list[i - 1], list[i + 1]].forEach((n) => { if (n) new Image().src = fullUrl(n); });
}
function step(d) {
  const n = state.viewerIndex + d;
  if (n < 0 || n >= state.viewerList.length) return;
  state.viewerIndex = n;
  showInViewer();
}
$('v-close').addEventListener('click', closeViewer);
$('v-prev').addEventListener('click', () => step(-1));
$('v-next').addEventListener('click', () => step(1));
document.addEventListener('keydown', (e) => {
  if ($('viewer').hidden) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
// Swipe between photos
let swipeX = null;
$('v-stage').addEventListener('pointerdown', (e) => { swipeX = e.clientX; });
$('v-stage').addEventListener('pointerup', (e) => {
  if (swipeX === null) return;
  const dx = e.clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
});

// Save: share sheet on phones ("Save Image"), download on computers
$('v-save').addEventListener('click', async () => {
  const it = state.viewerList[state.viewerIndex];
  if (!it) return;
  try {
    const blob = await (await fetch(fullUrl(it))).blob();
    const name = `${it.guest.replace(/\s+/g, '-')}-${new Date(it.taken).toISOString().slice(11, 19).replace(/:/g, '')}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ files: [file] });
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Saved to Downloads');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // closed the share sheet
    toast('Couldn’t save that photo');
  }
});

// ───────── Misc ─────────
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── Boot ─────────
if (state.key) start(); else showUnlock();
