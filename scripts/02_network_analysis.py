"""Phase 2: travel time to nearest hospital / fire station, coverage KPIs, priority index."""
import json, numpy as np, pandas as pd, geopandas as gpd, osmnx as ox
from common import *
from shapely.geometry import box

G = load_graph()
th = times_from(G, snap(G, "hospitals.geojson"))
tf = times_from(G, snap(G, "fire_stations.geojson"))
nodes = ox.graph_to_gdfs(G, edges=False)
nodes["hosp_min"] = nodes.index.map(lambda n: th.get(n, np.nan) / 60)
nodes["fire_min"] = nodes.index.map(lambda n: tf.get(n, np.nan) / 60)
nodes = nodes.dropna(subset=["hosp_min", "fire_min"], how="all").copy()
# Transparent priority index (NOT an AI model): the worse of the available access times
nodes["score"] = nodes[["hosp_min", "fire_min"]].max(axis=1)
nodes["priority"] = pd.qcut(nodes["score"].rank(method="first"), 4,
                            labels=["Low", "Moderate", "High", "Very High"]).astype(str)

def pct(col, m):
    return round(float((nodes[col] <= m).sum() / len(nodes) * 100), 1)
def avg(col):
    return round(float(nodes[col].mean()), 1) if nodes[col].notna().any() else None

kpi = {"hospitals": len(read_points("hospitals.geojson") if read_points("hospitals.geojson") is not None else []),
       "fire_stations": len(read_points("fire_stations.geojson") if read_points("fire_stations.geojson") is not None else []),
       "road_nodes_analysed": int(len(nodes)),
       "mean_hosp_min": avg("hosp_min"), "mean_fire_min": avg("fire_min"),
       "hosp_within_10": pct("hosp_min", 10), "fire_within_10": pct("fire_min", 10)}
json.dump(kpi, open(D + "kpis.json", "w"), indent=1)

if len(nodes) > 4000:
    nodes = nodes.sample(4000, random_state=1)
out = nodes[["hosp_min", "fire_min", "score", "priority", "geometry"]].round(2)
out.to_file(D + "demand_points.geojson", driver="GeoJSON")

projected = out.to_crs("EPSG:32643")
projected["grid_x"] = np.floor(projected.geometry.x / 500).astype(int)
projected["grid_y"] = np.floor(projected.geometry.y / 500).astype(int)
zones = projected.groupby(["grid_x", "grid_y"], as_index=False).agg(
    sample_count=("score", "size"),
    hospital_mean_min=("hosp_min", "mean"),
    fire_mean_min=("fire_min", "mean"),
    slow_mean_min=("score", "mean")
)
zones["geometry"] = zones.apply(
    lambda row: box(row.grid_x * 500, row.grid_y * 500,
                    (row.grid_x + 1) * 500, (row.grid_y + 1) * 500),
    axis=1
)
zones = gpd.GeoDataFrame(zones, geometry="geometry", crs="EPSG:32643").to_crs("EPSG:4326")
zones[["sample_count", "hospital_mean_min", "fire_mean_min", "slow_mean_min"]] = (
    zones[["sample_count", "hospital_mean_min", "fire_mean_min", "slow_mean_min"]].round(2)
)
zones.to_file(D + "priority_zones.geojson", driver="GeoJSON")
print(kpi)
