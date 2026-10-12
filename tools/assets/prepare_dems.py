"""Global height grids for terrain rendering and ground contact (M8).

Output: web/public/terrain/<body>.rsdem: gzip of
    b"RSDEM1" | u32 width | u32 height | f32 meters_per_unit | i16[height][width] (LE)
equirectangular, row 0 = north (+90°), column 0 = −180° longitude, pixel-centred
(lat_i = 90 − (i + 0.5)·180/h, lon_j = −180 + (j + 0.5)·360/w). Heights in metres:
  moon:  above the 1,737.4 km reference sphere (LOLA LDEM_16; PDS Geosciences Node,
         LRO-L-LOLA-4-GDR-V1; DN × 0.5 m)
  mars:  above the MOLA areoid (MEGDR megt90n000eb, 16 px/deg; PDS Geosciences Node)
  earth: above mean sea level, oceans clamped to 0 (contact on the sea surface), from the
         open Terrarium tiles (AWS Terrain Tiles: SRTM, GMTED2010, ETOPO1, ...), zoom 3

Usage: python3 -I tools/assets/prepare_dems.py <src_dir> <out_dir> [--ppd N]
(src_dir holds ldem_16.img and megt90n000eb.img; Earth tiles are downloaded here.)
"""

import gzip
import io
import math
import struct
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image


def write(path, grid, scale):
    h, w = grid.shape
    buf = io.BytesIO()
    buf.write(b"RSDEM1")
    buf.write(struct.pack("<IIf", w, h, scale))
    buf.write(np.ascontiguousarray(grid.astype("<i2")).tobytes())
    path.write_bytes(gzip.compress(buf.getvalue(), 9))
    print(f"wrote {path} ({w}×{h}, {path.stat().st_size / 1e6:.1f} MB)")


def downsample(a, factor):
    if factor == 1:
        return a
    h, w = a.shape
    return a.reshape(h // factor, factor, w // factor, factor).mean(axis=(1, 3))


def pds_grid(path, dtype, w, h):
    a = np.fromfile(path, dtype=dtype).reshape(h, w).astype(np.float64)
    # Columns start at 0° east; roll so column 0 is −180°.
    return np.roll(a, w // 2, axis=1)


def earth_grid(width):
    """Mosaic Terrarium zoom-3 tiles (Web Mercator) and resample to equirectangular."""
    z = 3
    n = 2**z
    mosaic = np.zeros((n * 256, n * 256), dtype=np.float64)
    for x in range(n):
        for y in range(n):
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
            with urllib.request.urlopen(url, timeout=60) as r:
                im = np.asarray(Image.open(io.BytesIO(r.read())).convert("RGB")).astype(np.float64)
            hgt = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
            mosaic[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = hgt
    h = width // 2
    lat = 90 - (np.arange(h) + 0.5) * 180 / h
    lon = -180 + (np.arange(width) + 0.5) * 360 / width
    # Web Mercator rows (clamped at ±85.05°: polar caps take the edge row).
    latc = np.clip(lat, -85.0511, 85.0511)
    ym = (1 - np.log(np.tan(np.radians(latc)) + 1 / np.cos(np.radians(latc))) / math.pi) / 2 * mosaic.shape[0]
    xm = (lon + 180) / 360 * mosaic.shape[1]
    yi = np.clip(ym.astype(int), 0, mosaic.shape[0] - 1)
    xi = np.clip(xm.astype(int), 0, mosaic.shape[1] - 1)
    out = mosaic[yi][:, xi]
    return np.maximum(out, 0.0)  # oceans: contact on the sea surface


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    ppd = 8
    if "--ppd" in sys.argv:
        ppd = int(sys.argv[sys.argv.index("--ppd") + 1])
    out.mkdir(parents=True, exist_ok=True)
    f = 16 // ppd
    moon = downsample(pds_grid(src / "ldem_16.img", "<i2", 5760, 2880), f)  # DN, 0.5 m
    write(out / "moon.rsdem", np.round(moon), 0.5)
    mars = downsample(pds_grid(src / "megt90n000eb.img", ">i2", 5760, 2880), f)
    write(out / "mars.rsdem", np.round(mars), 1.0)
    write(out / "earth.rsdem", np.round(earth_grid(2048)), 1.0)


if __name__ == "__main__":
    main()
