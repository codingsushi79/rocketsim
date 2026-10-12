"""Build the Earth water mask and cloud-coverage textures for the globe and clouds.

Inputs (in <src_dir>, fetched by scripts/fetch-assets.sh):
  ne_10m_land.geojson, ne_10m_lakes.geojson   Natural Earth 5.1.2 (public domain)
  cloud_combined_8192.tif                      NASA Blue Marble: Clouds (Visible Earth 57747)

Outputs (in <out_dir>), equirectangular, longitude −180…180 left to right, north up:
  earth_water_<w>.png    8-bit, 255 = water (oceans and lakes), for ocean glint
  earth_clouds_<w>.jpg   8-bit grayscale cloud coverage

Usage: python3 -I tools/assets/prepare_earth_layers.py <src_dir> <out_dir> [--full]
(2048 px wide by default, committed; --full also writes 4096/8192 px versions.)
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


def polygons(geojson_path):
    with open(geojson_path, encoding="utf-8") as f:
        gj = json.load(f)
    for feat in gj["features"]:
        g = feat["geometry"]
        if g is None:
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            yield poly  # [outer ring, hole rings...]


def water_mask(src, width):
    """Rasterise land (minus lakes) at 4× and downsample, for antialiased coasts."""
    ss = 4
    w, h = width * ss, width * ss // 2
    img = Image.new("L", (w, h), 255)  # start as water
    draw = ImageDraw.Draw(img)

    def px(ring):
        return [((lon + 180.0) / 360.0 * w, (90.0 - lat) / 180.0 * h) for lon, lat in ring]

    for poly in polygons(src / "ne_10m_land.geojson"):
        draw.polygon(px(poly[0]), fill=0)
        for hole in poly[1:]:
            draw.polygon(px(hole), fill=255)
    for poly in polygons(src / "ne_10m_lakes.geojson"):
        draw.polygon(px(poly[0]), fill=255)
        for hole in poly[1:]:  # islands in lakes
            draw.polygon(px(hole), fill=0)
    return img.resize((width, width // 2), Image.Resampling.BOX)


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    full = "--full" in sys.argv
    out.mkdir(parents=True, exist_ok=True)
    widths_mask = [2048] + ([4096] if full else [])
    for w in widths_mask:
        p = out / f"earth_water_{w}.png"
        water_mask(src, w).save(p, optimize=True)
        print("wrote", p)
    clouds = Image.open(src / "cloud_combined_8192.tif").convert("L")
    for w in [2048] + ([8192] if full else []):
        im = clouds if clouds.width == w else clouds.resize((w, w // 2), Image.Resampling.LANCZOS)
        p = out / f"earth_clouds_{w}.jpg"
        im.save(p, quality=90)
        print("wrote", p)


if __name__ == "__main__":
    main()
