"""Prepare web textures from NASA source images (see CREDITS.md).

    python -I tools/assets/prepare_textures.py <download_dir> <out_dir> [--full]

Inputs (download_dir):
  world.topo.bathy.200411.3x5400x2700.jpg   Blue Marble NG, November 2004
  BlackMarble_2016_3km.jpg                  Black Marble 2016 night lights (color)
  milkyway_2020_4k.exr                      NASA SVS Deep Star Maps 2020, Milky Way without stars
Outputs (out_dir):
  earth_day_{2048,5400}.jpg, earth_night_{2048,8192}.jpg, milkyway_{2048,4096}.jpg
  milkyway.json: linear scale of the 8-bit Milky Way encoding and the map orientation check
Only the 2048-wide versions are needed for tests; --full also writes the large ones.
"""
import json
import sys

import numpy as np
import OpenEXR
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
full = "--full" in sys.argv
Image.MAX_IMAGE_PIXELS = None

def save(img, name, q=90):
    img.save(f"{out}/{name}", quality=q, optimize=True, progressive=True)
    print("wrote", name, img.size)

day = Image.open(f"{src}/world.topo.bathy.200411.3x5400x2700.jpg").convert("RGB")
save(day.resize((2048, 1024), Image.LANCZOS), "earth_day_2048.jpg")
if full:
    save(day, "earth_day_5400.jpg", 92)

night = Image.open(f"{src}/BlackMarble_2016_3km.jpg").convert("RGB")
save(night.resize((2048, 1024), Image.LANCZOS), "earth_night_2048.jpg")
if full:
    save(night.resize((8192, 4096), Image.LANCZOS), "earth_night_8192.jpg", 88)

# Milky Way: linear float RGB → sRGB 8-bit with a recorded scale.
f = OpenEXR.File(f"{src}/milkyway_2020_4k.exr")
ch = f.channels()
if "RGB" in ch:
    rgb = np.asarray(ch["RGB"].pixels, dtype=np.float64)
else:
    rgb = np.stack([np.asarray(ch[c].pixels, dtype=np.float64) for c in ("R", "G", "B")], axis=-1)
rgb = np.clip(rgb, 0, None)
lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
scale = 1.0 / float(np.percentile(lum, 99.95))
x = np.clip(rgb * scale, 0, 1)
srgb = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
mw = Image.fromarray((srgb * 255 + 0.5).astype(np.uint8), "RGB")
save(mw.resize((2048, 1024), Image.LANCZOS), "milkyway_2048.jpg", 92)
if full:
    save(mw, "milkyway_4096.jpg", 92)

# Orientation check: the galactic center (RA 266.4°, Dec −28.9°) should be the
# brightest region. Report where the smoothed maximum falls in (u, v).
h, w = lum.shape
small = lum.reshape(h // 16, 16, w // 16, 16).mean(axis=(1, 3))
iy, ix = np.unravel_index(np.argmax(small), small.shape)
u, v = (ix + 0.5) / small.shape[1], (iy + 0.5) / small.shape[0]
# Landmark check of the RA convention: diffuse light of the Magellanic Clouds must be
# bright under u = 0.5 − RA/360 (RA increasing to the left, RA 0h at the center).
def mean_at(ra, dec, r=6):
    uu, vv = (0.5 - ra / 360.0) % 1.0, (90.0 - dec) / 180.0
    x, y = int(uu * w), int(vv * h)
    return float(lum[max(0, y - r):y + r, max(0, x - r):x + r].mean())
bg = float(np.median(lum))
landmarks = {"LMC": mean_at(80.9, -69.7) / bg, "SMC": mean_at(13.2, -72.8) / bg}
assert landmarks["LMC"] > 5 and landmarks["SMC"] > 5, landmarks
meta = {
    "mapping": "u = (0.5 - RA/360) mod 1, v = (90 - Dec)/180 from the top (ICRS/J2000)",
    "landmark_brightness_vs_median": landmarks,
    "source": "NASA SVS Deep Star Maps 2020, milkyway_2020_4k.exr (celestial, equirectangular)",
    "linear_from_srgb_scale": 1.0 / scale,
    "note": "linear EXR value = srgb_to_linear(pixel) * linear_from_srgb_scale",
    "brightest_region_uv": [u, v],
    "galactic_center_radec_deg": [266.405, -28.936],
}
json.dump(meta, open(f"{out}/milkyway.json", "w"), indent=2)
print(json.dumps(meta, indent=2))
