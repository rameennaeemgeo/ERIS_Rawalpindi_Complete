"""Phase 4: Maximal Coverage Location Problem (greedy) - best sites for new facilities.
Demand = road nodes (equal weight). Replace with population data later for better results."""
import json, numpy as np, geopandas as gpd, osmnx as ox, networkx as nx
from common import *

G = load_graph()
nodes = ox.graph_to_gdfs(G, edges=False)
COVER_MIN, COVER_S, K, N_DEMAND, N_CAND = 5, 300, 3, 4000, 300
hospital_times = times_from(G, snap(G, "hospitals.geojson"))
fire_times = times_from(G, snap(G, "fire_stations.geojson"))
nodes["hosp_min"] = nodes.index.map(lambda node: hospital_times.get(node, np.nan) / 60)
nodes["fire_min"] = nodes.index.map(lambda node: fire_times.get(node, np.nan) / 60)
nodes = nodes.dropna(subset=["hosp_min", "fire_min"], how="all").copy()
demand_nodes = nodes.sample(min(N_DEMAND, len(nodes)), random_state=1)
demand = set(demand_nodes.index)
candidate_pool = np.setdiff1d(nodes.index.to_numpy(), demand_nodes.index.to_numpy())
cands = np.random.default_rng(1).choice(candidate_pool, min(N_CAND, len(candidate_pool)), replace=False)
cover = {
    candidate: {
        node for node, seconds in nx.single_source_dijkstra_path_length(
            G, candidate, cutoff=COVER_S + 0.3, weight="travel_time"
        ).items()
        if node in demand and round(seconds / 60, 2) <= COVER_MIN
    }
    for candidate in cands
}

feats, summary = [], {}
for kind, file in [("Hospital", "hospitals.geojson"), ("Fire station", "fire_stations.geojson")]:
    existing = times_from(G, snap(G, file))
    covered = {
        n for n in demand
        if n in existing and round(existing[n] / 60, 2) <= COVER_MIN
    }
    before = len(covered) / len(demand) * 100
    for rank in range(1, K + 1):
        best = max(cover, key=lambda c: len(cover[c] - covered))
        gain = len(cover[best] - covered)
        if gain == 0: break
        covered |= cover[best]
        p = nodes.loc[best]
        feats.append({"type": kind, "rank": rank, "gain_pct": round(gain / len(demand) * 100, 1),
                      "geometry": p.geometry})
    summary[kind] = {"coverage_before_pct": round(before, 1), "coverage_after_pct": round(len(covered) / len(demand) * 100, 1)}
gpd.GeoDataFrame(feats, crs=4326).to_file(D + "recommended_sites.geojson", driver="GeoJSON")
json.dump(summary, open(D + "optimization.json", "w"), indent=1)
print(summary)
