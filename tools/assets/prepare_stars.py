"""Hipparcos stars (V < 8) → compact binary for the starfield.

    python3 -I tools/assets/prepare_stars.py hip_v8.tsv web/public/assets/stars_hip_v8.bin

Input: VizieR TSV of I/239/hip_main with columns HIP, RAICRS, DEICRS, Vmag, B-V, pmRA, pmDE, Plx
(query in CREDITS.md). Positions are ICRS at the Hipparcos epoch J1991.25.
Output: little-endian; u32 count, then per star 6 × f32: RA [deg], Dec [deg], Vmag,
B−V (0.65 if missing), pmRA* [mas/yr] (μα cos δ), pmDE [mas/yr] (0 if missing).
The app applies proper motion to the simulation epoch.
"""
import struct
import sys

rows = []
for line in open(sys.argv[1]):
    if line.startswith("#") or not line.strip():
        continue
    f = line.rstrip("\n").split("\t")
    if len(f) < 8 or not f[0].strip().isdigit():
        continue
    try:
        ra, de, v = float(f[1]), float(f[2]), float(f[3])
    except ValueError:
        continue
    num = lambda x, d: float(x) if x.strip() else d
    rows.append((ra, de, v, num(f[4], 0.65), num(f[5], 0.0), num(f[6], 0.0)))
rows.sort(key=lambda r: r[2])  # brightest first: a magnitude limit is a prefix
with open(sys.argv[2], "wb") as out:
    out.write(struct.pack("<I", len(rows)))
    for r in rows:
        out.write(struct.pack("<6f", *r))
print(f"{len(rows)} stars, brightest V = {rows[0][2]}, faintest V = {rows[-1][2]}")
