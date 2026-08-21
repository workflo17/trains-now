# -*- coding: utf-8 -*-
"""Turn the MTA's 42 MB static GTFS into the ~110 KB the browser actually needs:
station coordinates, one drawable shape per route, and the stop order per route and
direction so a train reported as "in transit to X" can be placed between stops."""
import csv, io, json, math, os, sys, zipfile
from collections import defaultdict

ZIP = sys.argv[1]
OUT = sys.argv[2]

z = zipfile.ZipFile(ZIP)
def rows(name):
    with z.open(name) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
            yield r

# ---------------------------------------------------------------- stations
# Platform ids end in N or S; the parent is the station and the only thing worth plotting.
stops = {}
for r in rows("stops.txt"):
    sid = r["stop_id"]
    if r.get("location_type") == "1" or (sid[-1] not in "NS"):
        stops[sid] = [round(float(r["stop_lat"]), 5), round(float(r["stop_lon"]), 5), r["stop_name"]]

# ---------------------------------------------------------------- routes
routes = {}
for r in rows("routes.txt"):
    routes[r["route_id"]] = {
        "n": r.get("route_short_name") or r["route_id"],
        "c": "#" + (r.get("route_color") or "6D6E71"),
        "t": r.get("route_long_name", ""),
    }

# ---------------------------------------------------------------- shapes
# One polyline per route: the longest shape used by that route, thinned to ~1 point per 60 m.
trip_shape = {}
route_of_trip = {}
dir_of_trip = {}
for r in rows("trips.txt"):
    trip_shape[r["trip_id"]] = r.get("shape_id", "")
    route_of_trip[r["trip_id"]] = r["route_id"]
    dir_of_trip[r["trip_id"]] = r.get("direction_id", "0")

shape_points = defaultdict(list)
for r in rows("shapes.txt"):
    shape_points[r["shape_id"]].append(
        (int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))

shapes_by_route = defaultdict(list)
for trip, shp in trip_shape.items():
    if shp:
        shapes_by_route[route_of_trip[trip]].append(shp)

def thin(points, metres=60.0):
    out = []
    for lon, lat in points:
        if not out:
            out.append((lon, lat)); continue
        dx = (lon - out[-1][0]) * 84000.0     # rough metres per degree at this latitude
        dy = (lat - out[-1][1]) * 111000.0
        if math.hypot(dx, dy) >= metres:
            out.append((lon, lat))
    if points and out[-1] != points[-1]:
        out.append(points[-1])
    return [[round(lon, 5), round(lat, 5)] for lon, lat in out]

shapes = {}
for route, shp_ids in shapes_by_route.items():
    best, best_len = None, -1
    for s in set(shp_ids):
        pts = shape_points.get(s) or []
        if len(pts) > best_len:
            best, best_len = s, len(pts)
    if best:
        pts = [(lon, lat) for _, lon, lat in sorted(shape_points[best])]
        shapes[route] = thin(pts)

# ---------------------------------------------------------------- stop order
# A representative trip per (route, direction) gives the running order of stations,
# which is what lets us drop a train between two stops instead of on top of one.
trip_stops = defaultdict(list)
wanted = {}
for trip, route in route_of_trip.items():
    key = (route, dir_of_trip[trip])
    wanted.setdefault(key, set()).add(trip)

# stop_times is the big file; stream it once and only keep candidate trips
candidates = set()
for key, trips in wanted.items():
    candidates.update(list(trips)[:6])       # a handful per key, longest wins later

for r in rows("stop_times.txt"):
    t = r["trip_id"]
    if t in candidates:
        trip_stops[t].append((int(r["stop_sequence"]), r["stop_id"]))

seq = {}
for (route, direction), trips in wanted.items():
    best, best_len = None, -1
    for t in trips:
        if t in trip_stops and len(trip_stops[t]) > best_len:
            best, best_len = t, len(trip_stops[t])
    if best:
        ordered = [s for _, s in sorted(trip_stops[best])]
        ordered = [s[:-1] if s[-1] in "NS" else s for s in ordered]
        seq.setdefault(route, {})[direction] = ordered

payload = {"stops": stops, "routes": routes, "shapes": shapes, "seq": seq}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(payload, f, separators=(",", ":"))

print(f"stops {len(stops)}  routes {len(routes)}  shapes {len(shapes)}  "
      f"seq {sum(len(v) for v in seq.values())}  bytes {os.path.getsize(OUT):,}")
