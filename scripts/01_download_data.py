"""Phase 1: download Rawalpindi roads, hospitals, fire stations from OpenStreetMap.
Study area = 8 km circle around Rawalpindi city centre.
Robust version: retries on broken connections, rotates between free OSM servers,
and skips the road download if it already finished."""
import time, pathlib
import json
import osmnx as ox, geopandas as gpd, pandas as pd
from shapely.geometry import Point

OUT = pathlib.Path("dashboard/data"); OUT.mkdir(parents=True, exist_ok=True)
pathlib.Path("data").mkdir(exist_ok=True)

LON, LAT, RADIUS_M = 73.0479, 33.5973, 8000
SERVERS = ["https://overpass-api.de/api",
           "https://overpass.kumi.systems/api",
           "https://maps.mail.ru/osm/tools/overpass/api"]
ox.settings.use_cache = True
ox.settings.requests_timeout = 180

def retry(fn, what, tries=9):
    """Run fn(); on any network error wait, switch server, try again."""
    for i in range(tries):
        ox.settings.overpass_url = SERVERS[i % len(SERVERS)]
        try:
            return fn()
        except Exception as e:
            msg = str(e).lower()
            if "no matching features" in msg or "insufficientresponse" in type(e).__name__.lower():
                return None                       # genuinely nothing there
            wait = 5 * (i + 1)
            print(f"  [{what}] network problem ({type(e).__name__}). Retry {i+1}/{tries} in {wait}s on {ox.settings.overpass_url}")
            time.sleep(wait)
    raise SystemExit(f"Could not download {what} after {tries} tries. Check your internet and run again.")

circle = (gpd.GeoSeries([Point(LON, LAT)], crs=4326).to_crs(32643).buffer(RADIUS_M).to_crs(4326))
boundary = gpd.GeoDataFrame({"name": ["Rawalpindi 8 km study area"]}, geometry=circle, crs=4326)
boundary.to_file(OUT / "boundary.geojson", driver="GeoJSON")
poly = boundary.geometry.iloc[0]
print("Study area: 8 km circle around Rawalpindi city centre")

def empty():
    return gpd.GeoDataFrame({"name": []}, geometry=[], crs=4326)

def serializable(value):
    if pd.api.types.is_scalar(value) and pd.isna(value):
        return None
    if isinstance(value, (list, tuple, set, dict)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return value

def best_name(row):
    for field in ("name", "name:en", "name:ur"):
        value = row.get(field)
        if pd.notna(value) and str(value).strip() and str(value).strip().casefold() != "unnamed":
            return str(value).strip()
    return "Unnamed"

def search(tags, what):
    g = retry(lambda: ox.features_from_polygon(poly, tags=tags), what)
    if g is None or len(g) == 0:
        return empty()
    g = g.reset_index()
    g["geometry"] = g.geometry.representative_point()
    if "name" not in g.columns:
        g["name"] = None
    g["name"] = g.apply(best_name, axis=1)
    if "osmid" not in g.columns and "id" in g.columns:
        g["osmid"] = g["id"]
    if "element_type" not in g.columns and "element" in g.columns:
        g["element_type"] = g["element"]
    structural = {"geometry", "nodes", "members"}
    fields = [field for field in g.columns if field not in structural]
    result = g[fields + ["geometry"]].copy()
    for field in fields:
        result[field] = result[field].map(serializable)
    result["data_source"] = "OpenStreetMap"
    return result.set_crs(4326, allow_override=True)

def combine(*frames):
    frames = [f for f in frames if len(f)]
    if not frames:
        return empty()
    out = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=4326)
    out["_k"] = out.apply(
        lambda row: (
            str(row.get("name", "")).strip().casefold(),
            round(row.geometry.x, 5),
            round(row.geometry.y, 5),
        ),
        axis=1,
    )
    merged = []
    for _, group in out.groupby("_k", sort=False, dropna=False):
        record = {"geometry": group.geometry.iloc[0]}
        for column in out.columns:
            if column in {"geometry", "_k"}:
                continue
            values = group[column].dropna().astype(str).drop_duplicates().tolist()
            record[column] = "; ".join(values) if values else None
        merged.append(record)
    return gpd.GeoDataFrame(merged, crs=4326).reset_index(drop=True)

def manual(path):
    """Optional list in data/<file>.csv with name,lat,lon and facility fields."""
    p = pathlib.Path(path)
    if not p.exists():
        return empty()
    df = pd.read_csv(p)
    fields = [field for field in df.columns if field not in {"lat", "lon"}]
    if "name" not in fields:
        raise ValueError(f"{path} must include a name column")
    manual = gpd.GeoDataFrame(df[fields],
        geometry=gpd.points_from_xy(df["lon"], df["lat"]), crs=4326)
    manual["data_source"] = "User-supplied"
    return manual

print("Downloading hospitals...")
hospitals = combine(search({"amenity": "hospital"}, "hospitals"),
                    search({"healthcare": "hospital"}, "hospitals (2)"),
                    manual("data/hospitals_manual.csv"))
hospitals.to_file(OUT / "hospitals.geojson", driver="GeoJSON")

print("Downloading fire stations...")
fire = combine(search({"amenity": "fire_station"}, "fire stations"),
               search({"emergency": ["fire_station", "ambulance_station"]}, "fire stations (2)"),
               manual("data/fire_stations_manual.csv"))
fire.to_file(OUT / "fire_stations.geojson", driver="GeoJSON")
print("Hospitals:", len(hospitals), "| Fire stations:", len(fire))
if len(fire) == 0:
    print("WARNING: no fire stations found. Create data/fire_stations_manual.csv (name,lat,lon) and run again.")

GRAPH = pathlib.Path("data/rawalpindi_drive.graphml")
if GRAPH.exists():
    print("Road graph already downloaded - skipping.")
else:
    print("Downloading road network (this is the slow part)...")
    G = retry(lambda: ox.graph_from_point((LAT, LON), dist=RADIUS_M, network_type="drive", dist_type="bbox"), "roads")
    G = ox.truncate.largest_component(G, strongly=True)
    ox.save_graphml(G, GRAPH)
    print("Road graph:", len(G.nodes), "nodes,", len(G.edges), "edges")
