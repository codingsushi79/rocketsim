"""Global base textures (2048×1024 equirectangular) from NASA Solar System Treks WMTS
level-2 tiles (default028mm tile matrix: level L has 2^(L+1) × 2^L tiles of 256 px).

  python3 -I tools/assets/prepare_trek_base.py <out_dir>

Layers (NASA, public domain; credits in CREDITS.md):
  moon: LRO_WAC_Mosaic_Global_303ppd_v02 (NASA/GSFC/Arizona State University)
  mars: Mars_Viking_MDIM21_ClrMosaic_global_232m (NASA/JPL/USGS)
"""
import io
import sys
import urllib.request
from pathlib import Path

from PIL import Image

LAYERS = {
    "moon": "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
    "mars": "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
}


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    z = 2
    for name, tmpl in LAYERS.items():
        im = Image.new("RGB", (2 ** (z + 1) * 256, 2**z * 256))
        for y in range(2**z):
            for x in range(2 ** (z + 1)):
                url = tmpl.format(z=z, y=y, x=x)
                with urllib.request.urlopen(url, timeout=60) as r:
                    im.paste(Image.open(io.BytesIO(r.read())).convert("RGB"), (x * 256, y * 256))
        p = out / f"{name}_2048.jpg"
        im.save(p, quality=88)
        print("wrote", p)


if __name__ == "__main__":
    main()
