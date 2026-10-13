# Vehicle data notes

Derivations for values in the vehicle files that are not taken directly from a
published engine sheet.

## Nozzle exit pressure and Mach number (`exit_pressure`, `exit_mach`)

Used only to shape the rendered exhaust plume (its expansion with ambient pressure,
`web/src/render/plume.ts`); the physics uses `exit_area` (thrust loss p·Aₑ).

Ideal nozzle with γ = 1.2 for hot combustion products (Sutton & Biblarz, *Rocket
Propulsion Elements*, 9th ed., §3.3 and table 5-5). Exit Mach number from the area
ratio ε = (1/M)·[(2/(γ+1))(1 + (γ−1)M²/2)]^((γ+1)/(2(γ−1))), then
pₑ/p_c = (1 + (γ−1)M²/2)^(−γ/(γ−1)).

| Engine | Class | ε | p_c | Mₑ | pₑ |
|---|---|---|---|---|---|
| RS-1 `main` | AJ10-class MMH/NTO (AJ10-190: ε ≈ 55, p_c ≈ 0.86 MPa) | 55 | 0.86 MPa | 4.45 | 1.2 kPa |
| MDS `mds_main` | RL10C-1-class LOX/LH₂ (ε ≈ 130, p_c ≈ 4.4 MPa) | 130 | 4.4 MPa | 5.1 | 2.0 kPa |

Check for the RS-1 engine: the pressure-thrust share pₑAₑ/F_vac = 1200 × 1.54 / 66 723 ≈ 2.8 %,
typical of high-expansion upper-stage nozzles. Without these fields the renderer
assumes 2.5 % of vacuum thrust over the exit area and Mₑ = 4.
