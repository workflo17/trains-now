/* /api/count: how many subway trains the MTA is reporting right now, as one small JSON for
   pages that frame or quote Trains Now (workflohq.com shows the number under its hero). The
   eight feeds are read here with the same sixty-line decoder as the page, the vehicle entities
   are counted, and the answer is cached at the edge for 25 seconds, the feed's own cadence, so
   a burst of readers costs the MTA one fetch. */
'use strict';

const FEEDS = ['', '-ace', '-bdfm', '-g', '-jz', '-nqrw', '-l', '-si'].map(
  s => `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${s}`);

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

/* A train is a FeedEntity (field 2) carrying a VehiclePosition (field 4) whose trip names both
   a trip and a route, the test the page applies before it tries to place a dot. The page also
   drops the few it cannot place on a known station, so this runs two or three percent high. */
function countVehicles(buf) {
  let n = 0;
  walk(buf, {
    2: { t: 'msg', f: entity => {
      walk(entity, {
        4: { t: 'msg', f: vehicle => {
          let tripId = null, routeId = null;
          walk(vehicle, { 1: { t: 'msg', f: trip => walk(trip, {
            1: { t: 'str', f: v => tripId = v },
            5: { t: 'str', f: v => routeId = v },
          }) } });
          if (tripId && routeId) n++;
        } },
      });
    } },
  });
  return n;
}

async function count() {
  const results = await Promise.allSettled(FEEDS.map(u =>
    fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error('feed ' + r.status)))));
  let trains = 0, feeds = 0;
  for (const r of results) if (r.status === 'fulfilled') { trains += countVehicles(r.value); feeds++; }
  return { trains, feeds, of: FEEDS.length, at: new Date().toISOString() };
}

module.exports = async function handler(req, res) {
  const out = await count();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=25, stale-while-revalidate=60');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(out.feeds ? 200 : 503).end(JSON.stringify(out));
};
module.exports.count = count;
