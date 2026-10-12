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
curl -fL -o "$dl/world.200411.3x5400x2700.jpg" "$B/74000/74192/world.200411.3x5400x2700.jpg"
curl -fL -o "$dl/BlackMarble_2016_3km.jpg" "$B/144000/144898/BlackMarble_2016_3km.jpg"
curl -fL -o "$dl/milkyway_2020_4k.exr" "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr"
python3 -I tools/assets/prepare_textures.py "$dl" web/public/assets --full
# Clouds (NASA Blue Marble: Clouds) and the water mask (Natural Earth 5.1.2 land + lakes).
curl -fL -o "$dl/cloud_combined_8192.tif" "$B/57000/57747/cloud_combined_8192.tif"
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson
curl -fL -o "$dl/ne_10m_land.geojson" "$NE/ne_10m_land.geojson"
curl -fL -o "$dl/ne_10m_lakes.geojson" "$NE/ne_10m_lakes.geojson"
python3 -I tools/assets/prepare_earth_layers.py "$dl" web/public/assets --full
