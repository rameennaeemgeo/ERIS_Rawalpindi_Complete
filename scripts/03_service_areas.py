"""Phase 3: service-area polygons (5/10/15/20/30 minutes) for hospitals and fire stations."""
import pandas as pd, geopandas as gpd, osmnx as ox
from common import *

G = load_graph()
nodes = ox.graph_to_gdfs(G, edges=False)
MINUTES = [30, 20, 15, 10, 5]

def build(src_file, out_file):
    src = snap(G, src_file)
    if not src:
        print("Skipped", src_file, "(no facilities)"); return
    t = pd.Series(times_from(G, src, cutoff=max(MINUTES) * 60)) / 60
    rows = []
    for m in MINUTES:
        ids = t[t <= m].index
        geom = nodes.loc[ids].to_crs(32643).geometry.buffer(250).union_all()
        rows.append({"minutes": m, "geometry": gpd.GeoSeries([geom], crs=32643).to_crs(4326).iloc[0]})
    gpd.GeoDataFrame(rows, crs=4326).to_file(D + out_file, driver="GeoJSON")
    print("Saved", out_file)

build("hospitals.geojson", "service_hospitals.geojson")
build("fire_stations.geojson", "service_fire.geojson")
