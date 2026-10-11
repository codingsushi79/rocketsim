#!/usr/bin/env bash
# Download NASA source imagery and build the high-resolution web textures
# (web/public/assets/*_5400/8192/4096.*). The 2048-px versions are committed; these are
# optional and used by the "High" texture setting. Needs Python 3 with numpy, Pillow
# and OpenEXR (pip install numpy pillow OpenEXR).
set -euo pipefail
cd "$(dirname "$0")/.."
dl=$(mktemp -d)
trap 'rm -rf "$dl"' EXIT
B=https://eoimages.gsfc.nasa.gov/images/imagerecords
curl -fL -o "$dl/world.topo.bathy.200411.3x5400x2700.jpg" "$B/73000/73884/world.topo.bathy.200411.3x5400x2700.jpg"
curl -fL -o "$dl/BlackMarble_2016_3km.jpg" "$B/144000/144898/BlackMarble_2016_3km.jpg"
curl -fL -o "$dl/milkyway_2020_4k.exr" "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr"
python3 -I tools/assets/prepare_textures.py "$dl" web/public/assets --full
