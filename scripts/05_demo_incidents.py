"""Phase 5: incidents, hotspot data, demand forecast, estimated-vs-actual response time.
REAL data: put data/incidents.csv with columns  lat,lon,type,datetime,response_min
NO file:   a clearly-labelled SIMULATED demo set is generated (accuracy numbers are NOT real)."""
import json, pathlib, numpy as np, pandas as pd, geopandas as gpd, osmnx as ox
from common import *

G = load_graph()
nodes = ox.graph_to_gdfs(G, edges=False)
th = times_from(G, snap(G, "hospitals.geojson"))
tf = times_from(G, snap(G, "fire_stations.geojson"))
rng = np.random.default_rng(7)
real = pathlib.Path("data/incidents.csv").exists()

if real:
    df = pd.read_csv("data/incidents.csv"); df["datetime"] = pd.to_datetime(df["datetime"])
    nd = ox.nearest_nodes(G, df["lon"].values, df["lat"].values)
    df["node"] = nd; df["actual"] = df["response_min"].astype(float)
else:
    n = 600
    deg = np.array([G.degree(i) for i in nodes.index], float)
    pick = rng.choice(len(nodes), n, p=deg / deg.sum())          # busier road areas = more incidents
    ids = nodes.index.values[pick]
    hours = np.clip(rng.normal(15, 5, n), 0, 23).astype(int)
    dt = pd.Timestamp("2026-09-01") + pd.to_timedelta(rng.integers(0, 60, n), unit="D") + pd.to_timedelta(hours, unit="h")
    df = pd.DataFrame({"node": ids, "type": rng.choice(["Medical", "Fire", "Accident", "Rescue"], n, p=[.45, .15, .3, .1]),
                       "datetime": dt, "lat": nodes.loc[ids].geometry.y.values, "lon": nodes.loc[ids].geometry.x.values})

df["est"] = [((tf if t == "Fire" else th).get(int(nd), np.nan)) / 60 for nd, t in zip(df["node"], df["type"])]
if not real:   # simulated 'actual' = network estimate x traffic factor + dispatch delay
    df["actual"] = df["est"] * rng.lognormal(0.35, 0.25, len(df)) + rng.uniform(1, 3, len(df))
df = df.dropna(subset=["est", "actual"]).copy()
df["hour"] = df["datetime"].dt.hour

gpd.GeoDataFrame(df[["type", "hour"]].assign(est=df["est"].round(1), actual=df["actual"].round(1)),
                 geometry=gpd.points_from_xy(df["lon"], df["lat"]), crs=4326).to_file(D + "incidents.geojson", driver="GeoJSON")

daily = df.groupby(df["datetime"].dt.normalize()).size()
wk = daily.groupby(daily.index.dayofweek).mean()                  # seasonal-average forecast
start = daily.index.max() + pd.Timedelta(days=1)
fc = [{"date": str((start + pd.Timedelta(days=i)).date()), "expected": round(float(wk.get((start + pd.Timedelta(days=i)).dayofweek, 0)), 1)} for i in range(7)]
corr = float(np.corrcoef(df["est"], df["actual"])[0, 1])
stats = {"demo": not real, "n": int(len(df)),
         "mae": round(float((df["est"] - df["actual"]).abs().mean()), 2), "r2": round(corr ** 2, 3),
         "hourly": [int((df["hour"] == h).sum()) for h in range(24)],
         "by_type": df["type"].value_counts().to_dict(), "forecast": fc,
         "pairs": df[["est", "actual"]].round(1).head(300).values.tolist()}
json.dump(stats, open(D + "incident_stats.json", "w"))
print("Incidents:", len(df), "| REAL data" if real else "| SIMULATED demo data", "| MAE", stats["mae"], "min | R2", stats["r2"])
