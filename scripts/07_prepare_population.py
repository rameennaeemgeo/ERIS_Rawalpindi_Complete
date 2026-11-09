"""Download and clip the WorldPop 2025 population estimate to the study area."""
import json
import struct
import tempfile
import zlib
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
import requests
from rasterio.mask import mask

ROOT = Path(__file__).resolve().parents[1]
BOUNDARY = ROOT / "dashboard" / "data" / "boundary.geojson"
OUTPUT = ROOT / "dashboard" / "data"
API = "https://www.worldpop.org/rest/data/pop/G2_CN_POP_R25A_100m"
YEAR = "2025"


def png_chunk(kind, payload):
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def write_population_png(path, values):
    positive = values[np.isfinite(values) & (values > 0)]
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    if positive.size:
        scale = np.percentile(positive, 98)
        intensity = np.clip(np.log1p(np.maximum(values, 0)) / np.log1p(scale), 0, 1)
        stops = np.array([[23, 59, 112], [24, 180, 164], [255, 200, 87]], dtype=np.float32)
        segment = np.minimum((intensity * 2).astype(np.int32), 1)
        fraction = intensity * 2 - segment
        colors = stops[segment] * (1 - fraction[..., None]) + stops[segment + 1] * fraction[..., None]
        active = np.isfinite(values) & (values > 0)
        rgba[..., :3] = colors.astype(np.uint8)
        rgba[..., 3] = np.where(active, 165, 0).astype(np.uint8)

    height, width = values.shape
    raw = b"".join(b"\0" + rgba[row].tobytes() for row in range(height))
    data = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(raw, 9))
        + png_chunk(b"IEND", b"")
    )
    path.write_bytes(data)


def main():
    if not BOUNDARY.is_file():
        raise FileNotFoundError(f"Study-area boundary not found: {BOUNDARY}")

    response = requests.get(API, timeout=60)
    response.raise_for_status()
    records = response.json().get("data", [])
    matches = [
        record for record in records
        if record.get("iso3") == "PAK" and str(record.get("popyear")) == YEAR
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one Pakistan WorldPop record for {YEAR}; found {len(matches)}.")

    metadata_response = requests.get(f"{API}?id={matches[0]['id']}", timeout=60)
    metadata_response.raise_for_status()
    metadata = metadata_response.json().get("data")
    if not metadata or not metadata.get("files"):
        raise RuntimeError("WorldPop API returned no download file for the selected dataset.")

    raster_url = metadata["files"][0]
    with tempfile.TemporaryDirectory(prefix="eris-worldpop-") as temp_dir:
        source_path = Path(temp_dir) / "pak_population.tif"
        with requests.get(raster_url, stream=True, timeout=(30, 180)) as download:
            download.raise_for_status()
            with source_path.open("wb") as target:
                for chunk in download.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        target.write(chunk)

        boundary = gpd.read_file(BOUNDARY)
        if boundary.empty:
            raise RuntimeError("Study-area boundary file contains no geometry.")
        with rasterio.open(source_path) as source:
            clipped_boundary = boundary.to_crs(source.crs)
            clipped, transform = mask(
                source, clipped_boundary.geometry, crop=True, filled=True, nodata=0
            )
            profile = source.profile.copy()
            profile.update(
                driver="GTiff",
                height=clipped.shape[1],
                width=clipped.shape[2],
                transform=transform,
                nodata=0,
                compress="deflate",
                predictor=2,
            )
            OUTPUT.mkdir(parents=True, exist_ok=True)
            raster_path = OUTPUT / "population_2025.tif"
            with rasterio.open(raster_path, "w", **profile) as destination:
                destination.write(clipped)

            bounds = rasterio.transform.array_bounds(
                clipped.shape[1], clipped.shape[2], transform
            )
            png_path = OUTPUT / "population_2025.png"
            write_population_png(png_path, clipped[0])

    details = {
        "year": YEAR,
        "dataset": metadata.get("title"),
        "release": "R2025A v1 (alpha)",
        "source": "WorldPop, University of Southampton",
        "source_url": metadata.get("url_summary"),
        "raster_url": raster_url,
        "citation": metadata.get("citation"),
        "doi": metadata.get("doi"),
        "license": metadata.get("license"),
        "description": metadata.get("desc"),
        "resolution": "3 arc-seconds (approximately 100 m at the equator)",
        "units": "Estimated people per grid cell",
        "image": "population_2025.png",
        "raster": "population_2025.tif",
        "bounds": [[bounds[1], bounds[0]], [bounds[3], bounds[2]]],
        "study_area": "Clipped to the project's approximately 8 km city-centre boundary",
    }
    (OUTPUT / "population_metadata.json").write_text(
        json.dumps(details, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Saved clipped WorldPop raster: {raster_path}")
    print(f"Saved Leaflet overlay: {OUTPUT / 'population_2025.png'}")
    print(f"Source: {metadata.get('url_summary')} (R2025A alpha; estimates, not census)")


if __name__ == "__main__":
    main()
