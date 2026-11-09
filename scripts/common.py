import osmnx as ox, networkx as nx, geopandas as gpd, pandas as pd, numpy as np
D = "dashboard/data/"

def load_graph():
    G = ox.load_graphml("data/rawalpindi_drive.graphml")
    G = ox.add_edge_speeds(G, fallback=40)   # km/h when OSM has no speed tag
    return ox.add_edge_travel_times(G)          # seconds

def read_points(name):
    try:
        f = gpd.read_file(D + name)
    except Exception:
        return None
    return f if len(f) else None

def snap(G, name):
    f = read_points(name)
    if f is None:
        return []
    return list(set(ox.nearest_nodes(G, f.geometry.x.values, f.geometry.y.values)))

def times_from(G, sources, cutoff=None):
    """Seconds from the nearest facility to every node (facility -> incident direction)."""
    if not sources:
        return {}
    return nx.multi_source_dijkstra_path_length(G, sources, cutoff=cutoff, weight="travel_time")
