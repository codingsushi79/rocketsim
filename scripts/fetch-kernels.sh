#!/usr/bin/env bash
# Download the JPL/NAIF SPK kernels the ephemeris builder reads (decision D6).
# They are large and gitignored; data/kernels/SHA256SUMS (committed) pins them.
#   ./scripts/fetch-kernels.sh          download missing files, then verify
#   ./scripts/fetch-kernels.sh --record rewrite SHA256SUMS from local files
set -euo pipefail
cd "$(dirname "$0")/../data/kernels"

NAIF=https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk
SSD=https://ssd.jpl.nasa.gov/ftp/eph/small_bodies/asteroids_de441
FILES=(
  "$NAIF/planets/de440.bsp"            # Sun, planets/barycenters, Moon (Park et al. 2021)
  "$NAIF/satellites/jup365.bsp"        # Galilean satellites
  "$NAIF/satellites/sat441.bsp"        # Major Saturnian satellites
  "$NAIF/satellites/mar099.bsp"        # Phobos, Deimos
  "$NAIF/satellites/nep097.bsp"        # Triton
  "$NAIF/satellites/plu060.bsp"        # Pluto relative to Pluto barycenter
  "$SSD/sb441-n16.bsp"                 # Ceres, Vesta (DE441 small-body perturbers)
)

for url in "${FILES[@]}"; do
  f=$(basename "$url")
  if [[ ! -s "$f" ]]; then
    echo "fetching $f"
    curl -fL --retry 3 -C - -o "$f.part" "$url" && mv "$f.part" "$f"
  fi
done

if [[ "${1:-}" == "--record" || ! -f SHA256SUMS ]]; then
  shasum -a 256 *.bsp > SHA256SUMS
  echo "recorded SHA256SUMS"
else
  shasum -a 256 -c SHA256SUMS
fi
