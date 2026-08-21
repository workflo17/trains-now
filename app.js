/* Trains Now.
   The MTA publishes GTFS-realtime protobuf with no key and open CORS, but it does NOT publish
   coordinates: a vehicle says "stopped at 42 St" or "in transit to 34 St". So the static GTFS
   (preprocessed into data/subway.json) supplies the station positions and the running order of
   each line, and a train in motion is drawn along the segment between the stop it left and the
   stop it is heading for. Between polls the dots ease toward their new positions, so the map
   moves the way the system does. */
'use strict';

const FEEDS = ['', '-ace', '-bdfm', '-g', '-jz', '-nqrw', '-l', '-si'].map(
  s => `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${s}`);
const POLL_MS = 25000;

const state = { data: null, trains: new Map(), filter: null, selected: null, lastFetch: 0, updates: new Map() };

/* ------------------------------------------------------------ protobuf, the 60 lines of it */
function reader(buf) {
  const u8 = new Uint8Array(buf);
  let p = 0;
  const varint = () => {
    let result = 0, shift = 0, b;
    do { b = u8[p++]; result += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
    return result;
  };
  return {
    get done() { return p >= u8.length; },
    key() { const k = varint(); return [k >>> 3, k & 7]; },
    varint,
    sub() { const len = varint(); const s = u8.buffer.slice(u8.byteOffset + p, u8.byteOffset + p + len); p += len; return s; },
    str() { const len = varint(); const s = new TextDecoder().decode(u8.subarray(p, p + len)); p += len; return s; },
    skip(wire) {
      /* `p += varint()` reads the old p before varint() advances it, which walks the whole
         reader one byte short on every skipped field. Read the length first. */
      if (wire === 0) varint();
      else if (wire === 1) p += 8;
      else if (wire === 2) { const len = varint(); p += len; }
      else if (wire === 5) p += 4;
    },
  };
}

function walk(buf, handlers) {
  const r = reader(buf);
  while (!r.done) {
    const [field, wire] = r.key();
    const h = handlers[field];
    if (!h) { r.skip(wire); continue; }
    if (h.t === 'msg') h.f(r.sub());
    else if (h.t === 'str') h.f(r.str());
    else if (h.t === 'int') h.f(r.varint());
    else r.skip(wire);
  }
}

function parseTrip(buf) {                       // TripDescriptor
  const t = {};
  walk(buf, { 1: { t: 'str', f: v => t.tripId = v }, 5: { t: 'str', f: v => t.routeId = v },
              6: { t: 'int', f: v => t.dir = v } });
  return t;
}

function parseVehicle(buf) {                    // VehiclePosition
  const v = { status: 2 };
  walk(buf, {
    1: { t: 'msg', f: b => Object.assign(v, parseTrip(b)) },
    3: { t: 'int', f: n => v.seq = n },
    4: { t: 'int', f: n => v.status = n },
    5: { t: 'int', f: n => v.ts = n },
    7: { t: 'str', f: s => v.stopId = s },
  });
  return v;
}

function parseStopTimeEvent(buf) {
  const e = {};
  walk(buf, { 1: { t: 'int', f: n => e.delay = n }, 2: { t: 'int', f: n => e.time = n } });
  return e;
}

function parseTripUpdate(buf) {                 // TripUpdate
  const u = { stops: [] };
  walk(buf, {
    1: { t: 'msg', f: b => Object.assign(u, parseTrip(b)) },
    2: { t: 'msg', f: b => {
      const s = {};
      walk(b, {
        2: { t: 'msg', f: x => s.arrival = parseStopTimeEvent(x) },
        3: { t: 'msg', f: x => s.departure = parseStopTimeEvent(x) },
        4: { t: 'str', f: v => s.stopId = v },
      });
      if (s.stopId) u.stops.push(s);
    } },
  });
  return u;
}

function parseFeed(buf) {
  const out = { vehicles: [], updates: [] };
  walk(buf, {
    2: { t: 'msg', f: entity => {
      walk(entity, {
        3: { t: 'msg', f: b => out.updates.push(parseTripUpdate(b)) },
        4: { t: 'msg', f: b => out.vehicles.push(parseVehicle(b)) },
      });
    } },
  });
  return out;
}

/* ------------------------------------------------------------ map */
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [-73.955, 40.735],
  zoom: 11.3,
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

/* ------------------------------------------------------------ placement */
function station(id) {
  const s = state.data.stops[id] || state.data.stops[id.slice(0, -1)];
  return s ? [s[1], s[0], s[2]] : null;       // [lon, lat, name]
}

/* The running order for a line, flipped for the northbound half, so "the stop before this one"
   means the stop this train actually came from. */
function order(routeId, stopId) {
  const byDir = state.data.seq[routeId];
  if (!byDir) return null;
  const base = byDir['0'] || byDir['1'];
  if (!base) return null;
  return stopId.endsWith('N') ? base.slice().reverse() : base;
}

function place(v) {
  if (!v.stopId) return null;
  const bare = v.stopId.replace(/[NS]$/, '');
  const here = station(bare);
  if (!here) return null;
  if (v.status === 1) return here;                       // STOPPED_AT
  const list = order(v.routeId, v.stopId);
  if (!list) return here;
  const i = list.indexOf(bare);
  if (i <= 0) return here;
  const prev = station(list[i - 1]);
  if (!prev) return here;
  const t = v.status === 0 ? 0.85 : 0.55;                // INCOMING_AT sits closer to the platform
  return [prev[0] + (here[0] - prev[0]) * t, prev[1] + (here[1] - prev[1]) * t, here[2]];
}

/* ------------------------------------------------------------ fetch */
async function poll() {
  const results = await Promise.allSettled(FEEDS.map(u =>
    fetch(u, { cache: 'no-store' }).then(r => r.arrayBuffer()).then(parseFeed)));
  const seen = new Set();
  let live = 0;

  state.updates.clear();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const u of r.value.updates) if (u.tripId) state.updates.set(u.tripId, u);
    for (const v of r.value.vehicles) {
      if (!v.tripId || !v.routeId) continue;
      const at = place(v);
      if (!at) continue;
      live++;
      seen.add(v.tripId);
      const prev = state.trains.get(v.tripId);
      state.trains.set(v.tripId, {
        id: v.tripId, route: v.routeId, status: v.status, stopName: at[2], stopId: v.stopId,
        target: [at[0], at[1]],
        now: prev ? prev.now : [at[0], at[1]],
      });
    }
  }
  for (const id of [...state.trains.keys()]) if (!seen.has(id)) state.trains.delete(id);

  state.lastFetch = Date.now();
  if (map.getSource('trains')) map.getSource('trains').setData(trainFeatures());
  document.getElementById('count').textContent = live.toLocaleString('en-US');
  document.getElementById('pip').classList.toggle('on', live > 0);
  chips();
  if (state.selected) detail(state.selected);
}

/* ------------------------------------------------------------ draw */
function trainFeatures() {
  const feats = [];
  for (const t of state.trains.values()) {
    if (state.filter && t.route !== state.filter) continue;
    const route = state.data.routes[t.route];
    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: t.now },
      properties: {
        id: t.id, route: t.route, label: route ? route.n : t.route,
        color: route ? route.c : '#8A8D93',
        moving: t.status === 1 ? 0 : 1,
      },
    });
  }
  return { type: 'FeatureCollection', features: feats };
}

function frame() {
  let moved = false;
  for (const t of state.trains.values()) {
    const dx = t.target[0] - t.now[0], dy = t.target[1] - t.now[1];
    if (Math.abs(dx) > 1e-7 || Math.abs(dy) > 1e-7) {
      t.now = [t.now[0] + dx * 0.06, t.now[1] + dy * 0.06];
      moved = true;
    }
  }
  if (moved && map.getSource('trains')) map.getSource('trains').setData(trainFeatures());
  requestAnimationFrame(frame);
}

function drawLines() {
  const feats = [];
  for (const [routeId, pts] of Object.entries(state.data.shapes)) {
    const r = state.data.routes[routeId];
    feats.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts },
      properties: { color: r ? r.c : '#6D6E71', route: routeId },
    });
  }
  map.addSource('lines', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
  map.addLayer({
    id: 'lines', type: 'line', source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 3.4, 17, 6],
      'line-opacity': 0.55,
    },
  });

  const stops = Object.entries(state.data.stops).map(([id, s]) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s[1], s[0]] },
    properties: { name: s[2] },
  }));
  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: stops } });
  map.addLayer({
    id: 'stations', type: 'circle', source: 'stations', minzoom: 12,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.6, 16, 4],
             'circle-color': '#0A0A0B', 'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(242,243,245,.5)' },
  });
  map.addLayer({
    id: 'station-labels', type: 'symbol', source: 'stations', minzoom: 14.2,
    layout: { 'text-field': ['get', 'name'], 'text-size': 10.5, 'text-offset': [0, 1.1], 'text-optional': true },
    paint: { 'text-color': '#9195A0', 'text-halo-color': '#0A0A0B', 'text-halo-width': 1.2 },
  });
}

function drawTrains() {
  map.addSource('trains', { type: 'geojson', data: trainFeatures() });
  map.addLayer({
    id: 'trains', type: 'circle', source: 'trains',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.6, 13, 6.5, 16, 11],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': ['case', ['==', ['get', 'moving'], 0], 2.4, 1],
      'circle-stroke-color': ['case', ['==', ['get', 'moving'], 0], '#F2F3F5', 'rgba(10,10,11,.7)'],
    },
  });
  map.addLayer({
    id: 'train-labels', type: 'symbol', source: 'trains', minzoom: 13.5,
    layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-allow-overlap': true },
    paint: { 'text-color': '#0A0A0B', 'text-halo-color': 'rgba(242,243,245,.85)', 'text-halo-width': 1 },
  });
  map.on('click', 'trains', e => { state.selected = e.features[0].properties.id; detail(state.selected); });
  map.on('mouseenter', 'trains', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'trains', () => { map.getCanvas().style.cursor = ''; });
}

/* ------------------------------------------------------------ rail */
const LIGHT_BULLETS = new Set(['N', 'Q', 'R', 'W', 'GS', 'FS', 'SI', 'SIR']);

function chips() {
  const counts = new Map();
  for (const t of state.trains.values()) counts.set(t.route, (counts.get(t.route) || 0) + 1);
  const rows = [...counts.entries()].sort((a, b) => {
    const an = state.data.routes[a[0]], bn = state.data.routes[b[0]];
    return (an ? an.n : a[0]).localeCompare(bn ? bn.n : b[0], 'en', { numeric: true });
  });
  document.getElementById('lines').innerHTML = rows.map(([route, n]) => {
    const r = state.data.routes[route] || { n: route, c: '#8A8D93' };
    const dark = LIGHT_BULLETS.has(r.n) ? ' dark' : '';
    return `<button type="button" class="chip${dark}${state.filter === route ? ' on' : ''}" data-route="${route}">
      <i style="background:${r.c}">${r.n}</i>${n}</button>`;
  }).join('');
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    state.filter = state.filter === c.dataset.route ? null : c.dataset.route;
    chips();
    map.getSource('trains').setData(trainFeatures());
  }));
}

function detail(tripId) {
  const t = state.trains.get(tripId);
  const box = document.getElementById('detail');
  if (!t) { box.innerHTML = '<p class="hint">That train has finished its run.</p>'; return; }
  const r = state.data.routes[t.route] || { n: t.route, c: '#8A8D93', t: '' };
  const upd = state.updates.get(tripId);
  const now = Date.now() / 1000;
  const stops = (upd ? upd.stops : []).slice(0, 6).map(s => {
    const st = station(s.stopId.replace(/[NS]$/, ''));
    const at = (s.arrival && s.arrival.time) || (s.departure && s.departure.time);
    const mins = at ? Math.round((at - now) / 60) : null;
    return `<li><em>${st ? esc(st[2]) : esc(s.stopId)}</em>
      <b>${mins === null ? '--' : (mins <= 0 ? 'now' : mins + ' min')}</b></li>`;
  }).join('');
  box.innerHTML = `
    <div class="trainHead">
      <i style="background:${r.c};color:${LIGHT_BULLETS.has(r.n) ? '#111' : '#fff'}">${r.n}</i>
      <div><b>${t.status === 1 ? 'Stopped at' : 'Heading for'} ${esc(t.stopName || 'the next station')}</b>
        <span>${esc(r.t || 'subway')}</span></div>
    </div>
    ${stops ? `<ul class="stopList">${stops}</ul>` : '<p class="hint">The feed has no upcoming stops for this train, which usually means it is about to finish its run.</p>'}`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

setInterval(() => {
  if (!state.lastFetch) return;
  const s = Math.round((Date.now() - state.lastFetch) / 1000);
  document.getElementById('age').textContent = s < 2 ? 'just now' : s + 's ago';
}, 1000);

/* ------------------------------------------------------------ go */
(async function start() {
  state.data = await (await fetch('data/subway.json')).json();
  await map.once('load');
  drawLines();
  drawTrains();
  requestAnimationFrame(frame);
  try {
    await poll();
  } catch (err) {
    console.error(err);
    document.getElementById('age').textContent = 'feed unreachable';
  }
  setInterval(() => poll().catch(e => console.error(e)), POLL_MS);
})();
