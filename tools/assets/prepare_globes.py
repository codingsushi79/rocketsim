"""Whole-globe textures for bodies without a NASA Trek layer (gas giants, Venus's cloud deck),
plus an albedo calibration like prepare_trek_base.py.

  python3 -I tools/assets/prepare_globes.py <src_dir> <out_dir>

src_dir holds the downloads:
  PIA07782.jpg   Cassini ISS true-colour cylindrical map of Jupiter (3601 × 1801, 10 px/deg),
                 https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia07/pia07782/PIA07782.jpg
  pluto.tif      New Horizons LORRI/MVIC global mosaic, 300 m/px, panchromatic (USGS Astrogeology),
                 https://planetarymaps.usgs.gov/mosaic/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif
                 Simple cylindrical, 0–360°E with 180°E at the centre (Sputnik Planitia).
  2k_saturn.jpg, 2k_uranus.jpg, 2k_neptune.jpg, 2k_venus_atmosphere.jpg
                 Solar System Scope (CC BY 4.0), https://www.solarsystemscope.com/textures/
                 (artist composites from NASA imagery: Saturn has no public global Cassini map).

Writes <out_dir>/<name>_<w>.jpg and <out_dir>/globes.json:
  { naif: { name, base, gain, attribution, shell } }
`shell` is the height (m) of the rendered surface above the body's reference radius: the
visible cloud deck of Venus, Titan's haze (a solid colour, no source file). Gas giants' reference radii are already at the 1 bar level.

Longitudes: all maps are simple cylindrical with east to the right. Jupiter's and Saturn's
cloud features drift relative to System III, so the longitude offset is cosmetic (the
rotation pole and rate come from the IAU model in the core).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # the Pluto mosaic is 24888 × 12444
PLUTO_TINT = (1.0, 0.86, 0.72)

# naif: (name, source file, output width, geometric albedo, shell height m, attribution)
# Geometric albedos: NASA GSFC planetary fact sheets (V band).
GLOBES = {
    599: ("jupiter", "PIA07782.jpg", 2048, 0.538, 0.0, "Jupiter: NASA/JPL/Space Science Institute (Cassini ISS, PIA07782)"),
    699: ("saturn", "2k_saturn.jpg", 2048, 0.499, 0.0, "Saturn: Solar System Scope (CC BY 4.0), from NASA imagery"),
    799: ("uranus", "2k_uranus.jpg", 1024, 0.488, 0.0, "Uranus: Solar System Scope (CC BY 4.0), from NASA imagery"),
    899: ("neptune", "2k_neptune.jpg", 1024, 0.442, 0.0, "Neptune: Solar System Scope (CC BY 4.0), from NASA imagery"),
    # Pluto: the south (below ~30°S) was in polar night during the 2015 flyby: no data there,
    # filled with the observed mean. Tinted (approximate tan, the map is panchromatic).
    999: ("pluto", "pluto.tif", 2048, 0.52, 0.0, "Pluto: NASA/JHU APL/SwRI (New Horizons LORRI, MVIC), via USGS Astrogeology"),
    # Titan: the photochemical haze hides the surface at visible wavelengths. The rendered
    # shell sits where the nadir haze optical depth at ~0.5 µm reaches ≈1, roughly 100 km
    # (approximate; Tomasko et al. 2008, Planet. Space Sci. 56:669, Huygens DISR). Colour:
    # a uniform orange (None = solid colour); albedo 0.22 (JPL SSD satellite parameters).
    606: ("titan_haze", None, 8, 0.22, 100e3, "Titan haze: uniform colour (no map)"),
    # Venus: the visible cloud tops are near 70 km altitude (Titov et al. 2018, Space Sci. Rev.
    # 214:126, "Clouds and hazes of Venus": upper cloud top 65-70 km at low latitudes).
    299: ("venus_clouds", "2k_venus_atmosphere.jpg", 1024, 0.689, 70e3, "Venus clouds: Solar System Scope (CC BY 4.0), from NASA imagery"),
}


def srgb_to_linear(x):
    x = x / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    table = {}
    for naif, (name, f, w, albedo, shell, credit) in GLOBES.items():
        im = Image.new("RGB", (w, w // 2), (214, 160, 92)) if f is None else Image.open(src / f).convert("RGB")
        if im.size == (3601, 1801):  # PIA07782: drop the duplicated 360° column and pole row
            im = im.crop((0, 0, 3600, 1800))
        im = im.resize((w, w // 2), Image.LANCZOS)
        valid = None
        if naif == 999:
            # USGS 8-bit mosaics are linear stretches of I/F (not sRGB): treat DN/255 as
            # linear, then encode to sRGB so the renderer's decode gives back the linear value.
            a = np.asarray(im).astype(np.float64) / 255.0
            a = np.roll(a, w // 2, axis=1)  # 0–360°E → column 0 at −180°
            valid = a[..., 0] > 2 / 255  # no-data is black
            a[~valid] = a[valid].mean(axis=0)
            a = np.clip(a * np.array(PLUTO_TINT), 0.0, 1.0)
            enc = np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)
            im = Image.fromarray(np.round(enc * 255).astype(np.uint8))
        p = out / f"{name}_{w}.jpg"
        im.save(p, quality=90)
        lin_px = srgb_to_linear(np.asarray(im).astype(np.float64))
        lin = (lin_px[valid] if valid is not None else lin_px).mean()
        gain = float(min(albedo / max(lin, 1e-3), 6.0))
        table[naif] = {"name": name, "base": f"assets/{p.name}", "gain": round(gain, 4), "attribution": credit, "shell": shell}
        print(f"{name}: {p.name}, mean {lin:.3f}, gain {gain:.3f}")
    (out / "globes.json").write_text(json.dumps(table, indent=1) + "\n")


if __name__ == "__main__":
    main()
