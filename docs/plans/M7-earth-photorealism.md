# M7 plan: Earth photorealism

Brief §3 (Earth) and milestone 7: Google 3D Tiles integrated within the policy, altitude
blending, clouds and night lights. Plus the M4 leftovers: multiple scattering and ocean glint.

## Google Map Tiles policy (read 2026-10-12; page last updated 2026-10-08)
Summary of what binds us, and what changed against the brief's wording:
- **Logo.** It is now the **"Google Maps" logo**, not "Google".
  - Use the official asset package, unmodified, with the aspect ratio kept.
  - Height 16–19 dp, with clear space of 10 dp left/right/top and 5 dp below.
  - The outlined variant goes on busy backgrounds (ours: imagery).
  - It needs the accessibility label "Google Maps".
  - No other logo may overlap it or the data attribution.
- **Data attribution.** Show the `asset.copyright` of every displayed tile, aggregated and
  sorted, on one line, usually at the bottom of the view. It must be fetched, never hardcoded.
  If space is short, a "Data sources" control may open it.
- **Hybrid scenes.** The UI must make clear which parts are Google data and which are ours.
- **Caching.** No pre-fetching, indexing, storing or caching outside the agreement.
  Honour `Cache-Control` (max-age, stale-while-revalidate, must-revalidate, private) and
  revalidate with ETags. We stream through the browser's HTTP cache only, with no service
  worker and no disk store of our own.
- **Forbidden uses.** Offline use; image analysis, machine interpretation, object detection,
  geodata extraction. Own 3D objects may be overlaid only if they are not derived from the
  tiles (D7: no collision with the tiles).
- **Sessions.** A root tileset request covers at least 3 hours of tile requests, then needs a
  new root request. The renderer plugin refreshes it.
- **Promotional videos** (if we ever make one): at most 30 s, marked "for promotional purposes
  only", attribution visible.
- **EEA billing addresses** fall under separate terms, and some content may be missing.

## API key
- Development: `VITE_GOOGLE_MAPS_API_KEY` in `web/.env.local` (gitignored), read at build time.
- Packaged builds carry **no key**. The player enters their own in Settings → Earth; it is
  stored only in that browser's local storage.
- Without a key, tiles are off and no request goes to Google.

## Rendering work
1. **Atmosphere: multiple scattering.** Hillaire, "A Scalable and Production Ready Sky and
   Atmosphere Rendering Technique" (EGSR 2020).
   - A transmittance LUT (256×64) and a multiple-scattering LUT (32×32) are computed on the
     GPU at start-up with the same Bruneton constants.
   - The existing ray-marched pass looks them up for sun transmittance and adds σ_s·Ψ_ms.
   - Twilight and shadowed-sky brightness become physical, not single-scattering dark.
2. **Volumetric clouds**, ray-marched in a depth-aware pass before the atmosphere:
   - Coverage from NASA Blue Marble: Clouds (8k), eroded with tiling 3D Perlin–Worley noise.
   - Height profile 1.5–12 km scaled by coverage.
   - Lighting:
     - Beer–Lambert sun transmittance through the cloud, via a light march;
     - atmospheric transmittance to the Sun from the LUT, so sunsets redden;
     - dual-lobe Henyey–Greenstein phase;
     - Wrenninge-style multiple-scattering octaves;
     - a sky ambient term.
   - Shadows on the ground; night lights dimmed under cloud.
   - The cloud depth is passed to the atmosphere for correct aerial perspective.
   - Quality presets: off / low / high / max.
3. **Ocean glint.** A water mask rasterised from Natural Earth land and lake polygons, GGX
   microfacet specular (roughness ~ Cox–Munk wind slope) and Schlick Fresnel, F₀ = 0.02.
4. **Google Photorealistic 3D Tiles**: `3d-tiles-renderer` with `GoogleCloudAuthPlugin`.
   - The ECEF tiles sit in the IERS body-fixed frame the physics uses, inside the floating
     origin.
   - Lit by the same Sun and night model; aerial perspective and clouds applied on top.
   - Altitude blend with the global imagery sphere: full below 600 km camera altitude, gone
     (and no requests) above 1,200 km.
   - Attribution bar: logo, aggregated tile copyrights, and the hybrid disclosure ("Earth
     surface near the camera: Google Maps · everything else: RocketSim").

## Tests
- The fixture tileset is served by Playwright route interception in place of
  `tile.googleapis.com`:
  - the attribution shows the fixture tile's copyright;
  - the logo is 16–19 px tall, unobscured, and has its accessibility label;
  - the hybrid disclosure is shown.
- Without a key there are zero requests to Google.
- Screenshots and frame times: orbit, terminator with clouds, low altitude; Max-preset
  performance logged.

## Open question for the owner
- To verify the real tiles end to end I need a Map Tiles API key with billing enabled. Put it
  in `web/.env.local` as `VITE_GOOGLE_MAPS_API_KEY=…`, never in chat or git.
