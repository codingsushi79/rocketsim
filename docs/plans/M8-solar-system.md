# M8 plan: the rest of the solar system (+ polish from the M7 review)

## Owner feedback folded in
- Camera drag felt inverted: flipped, with invert options. **Done.**
- Model missing a side: culled disks fixed. **Done.**
- Time warp now stops at the atmosphere's entry interface and stays ≤ 10× inside. **Done.**
- Hard ground contact is a crash with an explosion; a touchdown under the stage's limit is a
  landing; restart from the overlay. **Done.**
- Terrain from open data with Earth textures wrapped over it. OpenStreetMap has no
  elevation, so on the owner's follow-up this is **Cesium ion**:
  - Cesium World Terrain with Bing aerial imagery, or Google 3D Tiles via ion;
  - required credits shown (ion, Bing logo and providers, Google when used). **Done.**
- Overall polish: camera modes, cockpit placeholder, surface views. **Below.**

## Moon and Mars at high detail
- **Renderer.** A planet quadtree on the equirectangular grid:
  - two root tiles of 180° and 2×2 children, which is exactly the NASA Trek WMTS
    `default028mm` tile matrix;
  - a 33×33 vertex grid per tile, displaced by a global DEM sampled in JS, with skirts;
  - split by screen-space error; inside the floating origin, lit like everything else (U).
- **Imagery** streamed from NASA Solar System Treks (public, CORS-open, no key):
  - Moon: LRO WAC global mosaic (303 ppd);
  - Mars: Viking MDIM 2.1 colour mosaic (232 m).
  - Until a tile arrives, a bundled global texture (2k) shows.
- **Elevation**, bundled; the physics uses the same data for ground contact:
  - Moon: LOLA LDEM_16 (16 px/deg, ~1.9 km; PDS Geosciences Node);
  - Mars: MOLA MEGDR 16 px/deg (~3.7 km; PDS).
  - Stored as gzip'd int16 and decoded in the browser.
- **Core:** a `terrain` module (height grid per body, bilinear in body-fixed lat/lon). Impact
  becomes "altitude < terrain height". Earth uses a coarse bathymetry-free DEM from the same
  open sources (sea level for oceans). The visual Earth terrain (ion) is finer; the
  mismatch is documented.

## Remaining bodies
- Global albedo maps where public-domain mission mosaics exist, otherwise documented
  uniform albedo. Each is checked and recorded in CREDITS.md:
  - Mercury: MESSENGER MDIS, via Trek;
  - Ceres and Vesta: Dawn, via Trek;
  - Jupiter: Cassini global map, PIA07782;
  - Galilean and Saturnian moons: USGS mosaics;
  - Pluto: New Horizons.
  - Venus and Titan are rendered as their visible-light cloud and haze tops, which is what an
    eye would see.
- Gas giants: banded maps, rotation from the IAU models (already in the core).
- Saturn's rings: a measured radial profile (optical depth and reflectance), lit from both
  sides. The ring shadow on the planet and the planet's shadow on the rings are analytic in
  the shaders.

## Cameras (brief §3)
- Free orbit (existing).
- Chase, aligned with the velocity.
- Cockpit placeholder at the capsule window.
- Body-locked (rotates with the focus body).
- Surface-locked (a point on the ground under the spacecraft at that moment).
- C cycles; transitions are smoothed.

## Tests
- Terrain sampling against the source files at known points (e.g. Olympus Mons summit,
  Hellas floor, Moon south-pole basins).
- Impact on terrain at the DEM height.
- Quadtree visual checks (no cracks).
- Ring shadow geometry.
- Rendering screenshots per body.

## Open questions
- **Cesium ion in packaged builds.** Should CI bake the ion token into the nightly .exe/.app?
  That needs a GitHub Actions secret, which the owner sets. Otherwise players enter a
  token in Settings → Earth.
- **Moon terrain from ion.** Optional: add "Cesium Moon Terrain" to the ion account from the
  Asset Depot. The PDS LOLA path above works without it.

## Owner feedback, round 2 (realism and polish)
Each item names the method; "ray-traced" means analytic rays traced in shaders or on the
CPU (WebGL2 has no hardware ray tracing).
- **Sun.** The disk is the physical 0.53° at 1 au; the oversized aura came from a generic
  bloom. Replace it with an energy-conserving lens point-spread function: a small
  scattering fraction with a power-law falloff, plus aperture diffraction spikes. The
  Sun's visible fraction comes from rays against the body ellipsoids plus depth samples
  across the disk (the vehicle can occlude it).
- **Lens flare.** Ghosts are ray-traced through a real lens prescription: a double-Gauss
  50 mm with Fresnel reflections at single-layer MgF₂ quarter-wave AR coatings, at 3
  wavelengths with Abbe-number dispersion (Hullin et al. 2011, "Physically-Based Real-Time
  Lens Flare Rendering", SIGGRAPH). Rays are traced on the CPU per Sun field angle and
  cached; ghosts are drawn as aperture-shaped sprites.
- **Brightness.** The metering protects highlights: exposure ≤ the "sunny 16" limit for
  the local solar irradiance, so sunlit albedo-0.12 regolith reads dark grey, as in real
  photographs.
- **Orbit line:** map view only.
- **Clouds.** Coverage-map edges are eroded by 3D Perlin–Worley noise (Schneider 2015,
  "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn"), so edges are soft and
  billowed rather than texel polygons.
- **Re-entry.** A shock-layer glow scaled by the core's stagnation heat flux, ablation
  sparks, a plasma light on the vehicle, and buffeting.
- **Ring particles.** Within a few km of the ring plane, individual instanced rocks appear:
  - sizes from a power law n(a) ∝ a⁻³, 1 cm to 10 m (Zebker et al. 1985; Cuzzi et al.
    2009), with number density matched to the local optical depth;
  - in a co-rotating Keplerian frame; the ring texture fades out as they fade in.
- **Interior.** An RS-1 crew-module interior for the cockpit camera: seats, panels, live
  canvas displays, windows and cabin lighting.
- **UI.** A sober avionics look: square corners, thin rules, a bundled font, less chrome.
- **Release.** The CI release carries the Windows .exe.
