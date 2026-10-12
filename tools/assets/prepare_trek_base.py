"""Global base textures from NASA Solar System Treks WMTS tiles (default028mm tile
matrix: level L has 2^(L+1) × 2^L tiles of 256 px), plus an albedo calibration.

  python3 -I tools/assets/prepare_trek_base.py <out_dir>

Writes <out_dir>/<body>_<w>.jpg and <out_dir>/surfaces.json:
  { naif: { layer, url, maxLevel, base, gain, attribution } }
gain = geometric albedo / mean linear image value. Trek mosaics are contrast-stretched,
so this rescales them to the body's real brightness. Geometric albedos: NASA GSFC
planetary fact sheets (Mercury, Moon, Mars; satellites from the Planetary Satellite
Physical Parameters table, JPL SSD), and Ceres/Vesta from Dawn (Li et al. 2016; Reddy
et al. 2012).
"""
import io
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

T = "https://trek.nasa.gov/tiles"
# naif: (name, Trek body, layer, ext, base level, max level, geometric albedo, credit)
BODIES = {
    301: ("moon", "Moon", "LRO_WAC_Mosaic_Global_303ppd_v02", "jpg", 2, 8, 0.12, "NASA/GSFC/Arizona State University (LRO WAC)"),
    499: ("mars", "Mars", "Mars_Viking_MDIM21_ClrMosaic_global_232m", "jpg", 2, 7, 0.17, "NASA/JPL/USGS (Viking MDIM 2.1)"),
    199: ("mercury", "Mercury", "Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m", "jpg", 2, 7, 0.142, "NASA/JHU APL/Carnegie Institution of Washington (MESSENGER MDIS)"),
    2000001: ("ceres", "Ceres", "CE_LAMO_G_00N_180E_EQU_CLR_scale.eq", "jpg", 1, 7, 0.09, "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA (Dawn FC)"),
    2000004: ("vesta", "Vesta", "VestaHAMOLAMOBlend.eq", "png", 1, 7, 0.42, "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA (Dawn FC)"),
    606: ("titan", "Titan", "TitanISS2018June.proj.scale", "jpg", 1, 3, 0.22, "NASA/JPL-Caltech/Space Science Institute (Cassini ISS)"),
    502: ("europa", "Europa", "20150218_europa_global_map_20000x10000", "png", 1, 5, 0.67, "NASA/JPL/USGS (Galileo SSI, Voyager)"),
    503: ("ganymede", "Ganymede", "Ganymede_Voyager_GalileoSSI_global_mosaic_1km", "png", 1, 5, 0.43, "NASA/JPL/USGS (Voyager, Galileo SSI)"),
    501: ("io", "Io", "Io_GalileoSSI_Voyager_Global_Mosaic_ClrMerge_1km", "png", 1, 4, 0.63, "NASA/JPL/USGS (Galileo SSI, Voyager)"),
    602: ("enceladus", "Enceladus", "Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF", "png", 1, 5, 1.0, "NASA/JPL-Caltech/Space Science Institute/LPI (Cassini ISS)"),
    601: ("mimas", "Mimas", "MI_170630_DLR_basemap", "jpg", 1, 4, 0.96, "NASA/JPL-Caltech/SSI/DLR (Cassini ISS)"),
    604: ("dione", "Dione", "Dione_Cassini_Voyageglobal_154m", "jpg", 1, 5, 0.998, "NASA/JPL-Caltech/SSI/LPI (Cassini ISS, Voyager)"),
    605: ("rhea", "Rhea", "RH_120803_DLR_basemap", "jpg", 1, 4, 0.949, "NASA/JPL-Caltech/SSI/DLR (Cassini ISS)"),
    603: ("tethys", "Tethys", "Tethys_Cassini_mosaic_global_293m", "jpg", 1, 4, 1.0, "NASA/JPL-Caltech/SSI/LPI (Cassini ISS)"),
    608: ("iapetus", "Iapetus", "Iapetus_Cassini_Voyager_mosaic_global_783m", "jpg", 1, 3, 0.25, "NASA/JPL-Caltech/SSI/LPI (Cassini ISS, Voyager)"),
    401: ("phobos", "Phobos", "Phobos_Viking_Mosaic_40ppd_DLRcontrol", "jpg", 1, 5, 0.071, "NASA/JPL/DLR (Viking)"),
}


def srgb_to_linear(x):
    x = x / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    table = {}
    for naif, (name, body, layer, ext, z, max_level, albedo, credit) in BODIES.items():
        url = f"{T}/{body}/EQ/{layer}/1.0.0/default/default028mm/{{z}}/{{y}}/{{x}}.{ext}"
        w = 2 ** (z + 1) * 256
        im = Image.new("RGB", (w, w // 2))
        for y in range(2**z):
            for x in range(2 ** (z + 1)):
                with urllib.request.urlopen(url.format(z=z, y=y, x=x), timeout=60) as r:
                    im.paste(Image.open(io.BytesIO(r.read())).convert("RGB"), (x * 256, y * 256))
        p = out / f"{name}_{w}.jpg"
        im.save(p, quality=88)
        lin = srgb_to_linear(np.asarray(im).astype(np.float64)).mean()
        # Clamp the gain: no-data areas (black) would otherwise inflate it.
        gain = float(min(albedo / max(lin, 1e-3), 6.0))
        table[naif] = {"name": name, "url": url.replace("{z}", "{z}"), "maxLevel": max_level, "base": f"assets/{p.name}", "gain": round(gain, 4), "attribution": f"{body} imagery: {credit} via NASA Trek"}
        print(f"{name}: {p.name}, mean {lin:.3f}, gain {gain:.3f}")
    (out / "surfaces.json").write_text(json.dumps(table, indent=1) + "\n")


if __name__ == "__main__":
    main()
