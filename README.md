# Trains Now

[![CI](https://github.com/workflo17/trains-now/actions/workflows/ci.yml/badge.svg)](https://github.com/workflo17/trains-now/actions/workflows/ci.yml)

Every train the MTA is currently reporting, on the line it is running, moving between stations.
Live at [trains-now.vercel.app](https://trains-now.vercel.app).

No server, no API key, no build step. The page talks to the agency directly and works out the
geometry in the browser.

## The problem worth reading the code for

The MTA publishes where every train is, in realtime, with no key and open CORS, which is unusually
generous. It just does not publish it as a **position**.

A vehicle in the feed says `stopped at 42 St` or `in transit to 34 St`. There is no latitude
anywhere in it. A map needs a latitude.

Two things are needed to get from one to the other.

**Decode the feed.** It is GTFS-realtime, which is Protocol Buffers, across eight feeds split by
line group. Rather than ship a protobuf library to parse five message types, the page reads the
wire format directly. The reader and the generic field walker are 39 lines; the whole decoding
section, message parsers included, runs from line 16 to line 109:

```js
const varint = () => { /* ... */ };
return {
  key() { const k = varint(); return [k >>> 3, k & 7]; },
  varint,
  sub() { /* length-delimited submessage */ },
  str() { /* length-delimited string */ },
  skip(wire) { /* everything this page does not care about */ },
};
```

The `skip` path matters more than the parsing does. A protobuf reader that does not correctly
step over the fields it is ignoring walks off the end of the buffer and takes the whole feed with
it, and the failure looks like a decoding bug rather than a length bug.

**Reconstruct the position.** The static GTFS is a 42 MB zip. A Python step reduces it to the
113 KB the browser actually needs: station coordinates, one drawable shape per route, and the
stop order per route and direction. With the running order in hand, a train reported as in
transit is drawn along the segment between the stop it left and the stop it is heading for:

```js
const i = list.indexOf(bare);
const prev = station(list[i - 1]);
const t = v.status === 0 ? 0.85 : 0.55;   // INCOMING_AT sits closer to the platform
return [prev[0] + (here[0] - prev[0]) * t, prev[1] + (here[1] - prev[1]) * t, here[2]];
```

`INCOMING_AT` means the train is about to arrive, so it is placed most of the way along the
segment. `IN_TRANSIT_TO` puts it around the middle. Neither is a measurement, and the page does
not claim otherwise; it is an interpolation between two known points, which is the best anyone
can do from what is published.

The feed is polled every 25 seconds and the dots ease between positions, so the map moves the way
the system does rather than teleporting on each refresh.

## Rebuilding the static data

`data/subway.json` is checked in, so the page runs as it stands. To regenerate it from a fresh
GTFS release:

```bash
python tools/build_static.py gtfs_subway.zip data/subway.json
```

That reads `stops.txt`, `shapes.txt`, `trips.txt` and `stop_times.txt` and writes only what the
map needs. Platform ids end in `N` or `S`; the parent is the station and the only thing worth
plotting.

## Running it

```bash
python -m http.server 4860
```

Then open `http://localhost:4860`. The MTA's CORS headers are open, so there is no proxy to run.

## Files

```
index.html            the page
app.js                protobuf reader, position reconstruction, map and polling
app.css               the styling
data/subway.json      stations, route shapes and stop order, prebuilt
tools/build_static.py turns the 42 MB GTFS zip into that file
```

## Limits

A train between stations is drawn where the schedule says that segment runs, not where the train
physically is. Express trains skipping stops are placed on the segment they report, which is
correct, but the fraction along it is a guess. And a feed that goes quiet leaves its trains on the
map until the next poll clears them, which is the right tradeoff for a 25 second cycle and the
wrong one if you are trying to catch something.
