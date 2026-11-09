"""Export the drive graph as a simplified, map-ready GeoJSON road layer."""
import geopandas as gpd
import osmnx as ox

from common import load_graph

G = load_graph()
edges = ox.graph_to_gdfs(G, nodes=False).reset_index()
seen = set()
rows = []

for _, edge in edges.iterrows():
    u, v = str(edge["u"]), str(edge["v"])
    osmid = edge.get("osmid")
    if isinstance(osmid, (list, tuple, set)):
        osmid = ",".join(sorted(map(str, osmid)))
    pair = (min(u, v), max(u, v), str(osmid))
    if pair in seen:
        continue
    seen.add(pair)
    geometry = edge.geometry
    if geometry is None or geometry.is_empty:
        continue
    highway = edge.get("highway")
    if isinstance(highway, (list, tuple, set)):
        highway = "; ".join(map(str, highway))
    name = edge.get("name")
    if isinstance(name, (list, tuple, set)):
        name = "; ".join(map(str, name))
    oneway = edge.get("oneway")
    rows.append({
        "name": None if name is None else str(name),
        "highway": None if highway is None else str(highway),
        "oneway": None if oneway is None else str(oneway),
        "geometry": geometry,
    })

roads = gpd.GeoDataFrame(rows, geometry="geometry", crs=edges.crs)
roads = roads.to_crs(32643)
roads.geometry = roads.geometry.simplify(4, preserve_topology=True)
roads = roads.to_crs(4326)
out = "dashboard/data/road_network.geojson"
roads.to_file(out, driver="GeoJSON")
print(f"Saved {len(roads)} simplified road segments to {out}")
