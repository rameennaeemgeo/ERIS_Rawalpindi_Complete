"""Serves the dashboard AND real road routes.   Run:  python server.py   then open http://localhost:8000"""
import json, functools, http.server, urllib.parse
from math import atan2, cos, degrees, inf, radians, sin
from itertools import islice
import networkx as nx, osmnx as ox
from scripts.common import load_graph, read_points

print("Loading road network (about 20 seconds)...")
G = load_graph()
ROUTE_GRAPH = None

def mapped_name(row):
    for key in ("name", "name:en", "name:ur"):
        value = row.get(key)
        if isinstance(value, str) and value.strip() and value.strip().casefold() != "unnamed":
            return value.strip()
    return None

def facilities(name):
    f = read_points(name)
    if f is None:
        return {}
    names = [mapped_name(row) for _, row in f.iterrows()]
    keep = [index for index, value in enumerate(names) if value]
    if name.endswith("fire_stations.geojson") and "amenity" in f.columns:
        keep = [index for index in keep if f.iloc[index]["amenity"] == "fire_station"]
    if not keep:
        return {}
    f = f.iloc[keep]
    names = [names[index] for index in keep]
    nd = ox.nearest_nodes(G, f.geometry.x.values, f.geometry.y.values)
    return {int(node): facility_name for node, facility_name in zip(nd, names)}
HOSP, FIRE = facilities("hospitals.geojson"), facilities("fire_stations.geojson")

def facility_records(name):
    frame = read_points(name)
    if frame is None:
        return []
    records = []
    for _, row in frame.iterrows():
        name = mapped_name(row) or "Unnamed"
        records.append({
            "index": len(records),
            "name": name,
            "lat": float(row.geometry.y),
            "lon": float(row.geometry.x),
            "node": int(ox.nearest_nodes(G, row.geometry.x, row.geometry.y)),
            "amenity": row.get("amenity"),
            "emergency": row.get("emergency"),
        })
    return records

FACILITIES = {
    "hospital": facility_records("hospitals.geojson"),
    "fire": facility_records("fire_stations.geojson"),
}

def bearing(start, end):
    first, second = G.nodes[start], G.nodes[end]
    lat1, lat2 = radians(first["y"]), radians(second["y"])
    delta_lon = radians(second["x"] - first["x"])
    y = sin(delta_lon) * cos(lat2)
    x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(delta_lon)
    return (degrees(atan2(y, x)) + 360) % 360

def route_directions(path, path_weight="travel_time"):
    segments = []
    distance_m = 0.0
    travel_seconds = 0.0
    for start, end in zip(path, path[1:]):
        choices = G.get_edge_data(start, end) or {}
        if not choices:
            continue
        edge = min(choices.values(), key=lambda item: item.get(path_weight, inf))
        road = edge.get("name") or edge.get("highway") or "unnamed road"
        if isinstance(road, (list, tuple)):
            road = ", ".join(str(part) for part in road)
        road = str(road)
        length = float(edge.get("length", 0))
        seconds = float(edge.get("travel_time", 0))
        current_bearing = bearing(start, end)
        turn = None
        if segments:
            change = (current_bearing - segments[-1]["bearing"] + 180) % 360 - 180
            if change >= 35:
                turn = "right"
            elif change <= -35:
                turn = "left"
        if not segments or road != segments[-1]["road"] or turn:
            segments.append({"road": road, "length": 0.0, "seconds": 0.0, "bearing": current_bearing, "turn": turn})
        segments[-1]["length"] += length
        segments[-1]["seconds"] += seconds
        segments[-1]["bearing"] = current_bearing
        distance_m += length
        travel_seconds += seconds
    directions = []
    for index, segment in enumerate(segments):
        instruction = "Start on" if index == 0 else f"Turn {segment['turn']} onto" if segment["turn"] else "Continue on"
        directions.append(
            f"{instruction} {segment['road']} for {segment['length'] / 1000:.2f} km "
            f"(about {segment['seconds'] / 60:.1f} min)"
        )
    return distance_m, travel_seconds, directions

def route_to_facility(origin, facility, path=None, path_weight="travel_time"):
    if path is None:
        origin_node = int(ox.nearest_nodes(G, origin["lon"], origin["lat"]))
        path = nx.shortest_path(G, origin_node, facility["node"], weight="travel_time")
    distance_m, seconds, directions = route_directions(path, path_weight)
    line = [[origin["lat"], origin["lon"]]]
    line.extend([[float(G.nodes[node]["y"]), float(G.nodes[node]["x"])] for node in path])
    line.append([facility["lat"], facility["lon"]])
    directions.insert(0, "Start from your current location and follow the mapped road network.")
    directions.append(f"Arrive at {facility['name']}.")
    return {
        "minutes": round(seconds / 60, 1),
        "distance_km": round(distance_m / 1000, 2),
        "directions": directions,
        "facility": facility["name"],
        "facility_ll": [facility["lat"], facility["lon"]],
        "line": line,
    }

def route_graph():
    global ROUTE_GRAPH
    if ROUTE_GRAPH is None:
        graph = nx.DiGraph()
        graph.add_nodes_from(G.nodes(data=True))
        for start, end, edge in G.edges(data=True):
            travel_time = float(edge.get("travel_time", inf))
            current = graph.get_edge_data(start, end)
            if current is None or travel_time < current["travel_time"]:
                graph.add_edge(start, end, travel_time=travel_time)
        ROUTE_GRAPH = graph
    return ROUTE_GRAPH

def route_options(origin, facility, limit=3):
    origin_node = int(ox.nearest_nodes(G, origin["lon"], origin["lat"]))
    paths = nx.shortest_simple_paths(
        route_graph(), origin_node, facility["node"], weight="travel_time"
    )
    routes = []
    for index, path in enumerate(islice(paths, limit), start=1):
        route = route_to_facility(origin, facility, path)
        route["route_number"] = index
        routes.append(route)
    return routes

def nearby_facility_routes(lat, lon):
    origin = {"lat": lat, "lon": lon}
    origin_node = int(ox.nearest_nodes(G, lon, lat))
    distances, paths = nx.single_source_dijkstra(G, origin_node, weight="length")
    result = {"hospital": [], "fire": []}
    for kind, records in FACILITIES.items():
        candidates = [record for record in records if record["name"].casefold() != "unnamed"]
        if kind == "fire":
            candidates = [record for record in candidates if record["amenity"] == "fire_station"]
        reachable = [
            (distances.get(record["node"], inf), record)
            for record in candidates
            if distances.get(record["node"], inf) < inf
        ]
        reachable.sort(key=lambda candidate: candidate[0])
        result[kind] = [
            route_to_facility(origin, record, paths[record["node"]], path_weight="length")
            | {"index": record["index"]}
            for _, record in reachable
        ]
    return result

def route(lat, lon, fac):
    if not fac: return None
    tgt = int(ox.nearest_nodes(G, lon, lat))
    try:
        t, path = nx.multi_source_dijkstra(G, list(fac), target=tgt, weight="travel_time")
    except nx.NetworkXNoPath:
        return None
    ll = lambda n: [G.nodes[n]["y"], G.nodes[n]["x"]]
    return {"minutes": round(t / 60, 1), "facility": fac[int(path[0])], "facility_ll": ll(path[0]), "line": [ll(n) for n in path]}

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/dispatch":
            q = urllib.parse.parse_qs(u.query)
            lat, lon = float(q["lat"][0]), float(q["lon"][0])
            body = json.dumps({"hospital": route(lat, lon, HOSP), "fire": route(lat, lon, FIRE)}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif u.path in ("/api/nearby", "/api/route"):
            try:
                q = urllib.parse.parse_qs(u.query)
                lat, lon = float(q["lat"][0]), float(q["lon"][0])
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    raise ValueError("Coordinates are outside valid latitude/longitude ranges.")
                origin = {"lat": lat, "lon": lon}
                if u.path == "/api/nearby":
                    self.send_json(200, nearby_facility_routes(lat, lon))
                    return
                kind = q["type"][0]
                if kind not in FACILITIES:
                    raise ValueError("Facility type must be hospital or fire.")
                index = int(q["index"][0])
                records = FACILITIES[kind]
                if index < 0 or index >= len(records):
                    raise ValueError("Selected facility is not in the loaded dataset.")
                facility = records[index]
                if facility["name"].casefold() == "unnamed":
                    raise ValueError("The selected facility has no mapped name.")
                if kind == "fire" and facility["amenity"] != "fire_station":
                    raise ValueError("Select a mapped fire station.")
                routes = route_options(origin, facility)
                if not routes:
                    raise nx.NetworkXNoPath
                response = dict(routes[0])
                response["alternatives"] = routes
                self.send_json(200, response)
            except (KeyError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            except nx.NetworkXNoPath:
                self.send_json(404, {"error": "No road route is available for this facility."})
        else:
            super().do_GET()

if __name__ == "__main__":
    print("Ready ->  open http://localhost:8000   (stop with Ctrl+C)")
    http.server.ThreadingHTTPServer(("", 8000), functools.partial(H, directory="dashboard")).serve_forever()
