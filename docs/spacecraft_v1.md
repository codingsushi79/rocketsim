# RS-1 Corvid: the v1 spacecraft

Definition: [`data/vehicles/rs1_corvid.json`](../data/vehicles/rs1_corvid.json). The core
reads only this file. There is no vehicle-specific code. The 3D model is generated from it by
`tools/models/build_vehicle_glb.mjs`, so geometry and physics can't disagree.

## Requirements (decision D5)
- Realistic: every number is in the range of flown hardware, with references below.
- Enough Δv for a lunar flyby from low Earth orbit, but no more. No landing or lunar orbit
  insertion in v1.
- Crewed, so it has a separate entry capsule with its own attitude control.

**Δv check.** TLI from a 400 km circular orbit to an apogee at lunar distance:
- v_circ = 7.669 km/s.
- Perigee speed of the transfer ellipse: v_p = √(μ(2/r − 1/a)) = 10.751 km/s, with
  r = 6,778 km and a = (6,778 + 384,400)/2 km.
- So the impulsive TLI is **3.08 km/s**.

The finite burn (13 min at 2.7–5 m/s²) adds an estimated 50–100 m/s of gravity loss. The rest
of the ~3.45 km/s budget (about 250 m/s) covers midcourse corrections and phasing. A free-return
flyby needs nothing more.

## Body frame
+X points forward along the stack (the main engine pushes +X), toward the docking port. The
origin is at the crew-module/service-module interface plane (the heat-shield face). At spawn the
vehicle points prograde with +Z toward nadir, so +Y points opposite the orbit normal.

## Mass breakdown

| Item | Stage | Mass (kg) | Notes |
|---|---|---|---|
| Heat shield (ablator + carrier) | CM | 850 | Apollo CM heat shield ≈ 850 kg class |
| Crew module structure, 3 crew, systems | CM | 3,560 | Solid-cone inertia model |
| Docking port | CM | 150 | |
| CM RCS hydrazine (2 tanks) | CM | 100 | Apollo CM RCS carried 123 kg |
| **Crew module total** | | **4,660** | Apollo CM ≈ 5,560 kg; this one is lighter and simpler |
| SM structure, avionics, tanks, radiators, wheels | SM | 2,780 | Thin-shell cylinder model |
| Main engine | SM | 300 | |
| Solar wings (2) | SM | 220 | |
| SM RCS propellant (MMH 113 + NTO 187) | SM | 300 | O/F 1.65 |
| Main propellant: MMH 2 × 3,150, NTO 2 × 5,200 | SM | 16,700 | O/F 1.651 |
| **Stack total** | | **24,960** | |

Mass properties computed by the core (body axes, about the CoM):

| State | Mass | CoM x | I_xx (roll) | I_yy | I_zz |
|---|---|---|---|---|---|
| Full | 24,960 kg | −1.510 m | 43,065 | 76,621 | 79,326 kg·m² |
| Main tanks empty | 8,260 kg | −0.519 m | 23,155 | 39,977 | 46,782 kg·m² |
| Crew module alone | 4,660 kg | +0.891 m | 5,775 | 5,880 | 5,961 kg·m² |

The CoM moves about 1 m forward as the main tanks drain. The gimbal trim follows it (thrust
line through the CoM), and SAS gains are scaled by the current inertia.

## Propulsion
**Main engine.** A pressure-fed, storable bipropellant engine of the Apollo SPS / AJ10 family,
scaled down:

| Parameter | Value | Rationale |
|---|---|---|
| Vacuum thrust | 66.7 kN (15,000 lbf) | Apollo SPS 91 kN for a 30 t CSM. Similar thrust-to-weight: 0.27 g full, 0.82 g empty |
| Vacuum Isp | 318 s | AJ10-190 (Shuttle OMS) 316 s, AJ10-137 (SPS) 314 s, modern MMH/NTO 320+ s |
| Mixture ratio (O/F) | 1.65 | Gives nearly equal tank volumes (MMH 875, NTO 1,440 kg/m³) |
| Exit area | 1.54 m² (Ø 1.4 m) | Vacuum nozzle. Thrust = F_vac − p_a·A_e, so it can't fire at sea level (−89 kN) |
| Throttle | 40–100 % | Pintle injector, as on the LM descent engine (10–100 %) |
| Ignitions | 50 | SPS was qualified for 50 starts |
| Minimum on-time | 0.4 s | SPS minimum impulse burn ≈ 0.4 s |
| Gimbal | ±6°, 10°/s | SPS gimbal ±6° class |

**Δv** (Tsiolkovsky, full stack): 318 × 9.80665 × ln(24,960 / 8,260) = **3,447 m/s**, with
780 s of burn time at full throttle. The core reports the same figure (`flight.rs` test
`rs1_has_the_designed_mass_and_delta_v`).

**Service module RCS.** 16 × 445 N (100 lbf), Isp 290 s, MMH/NTO from their own tanks. These are
Aerojet R-4D class, the Apollo SM RCS thruster. They sit in four quads at x = −0.5 m on a
2.1 m radius at ±Y and ±Z, as on Apollo. Each quad fires ±X and ±tangential, which gives
6-DOF control: axial thrusters make pitch and yaw couples, tangential thrusters make roll and
lateral translation.

**Crew module RCS.** 12 × 440 N, Isp 230 s, hydrazine monopropellant (MR-104 class), as six
pure couples (pitch ±, yaw ±, roll ±). The group is **inhibited while the SM is attached**
(`inhibited_while_attached`), as on Apollo, where the CM RCS was pressurized only for
separation and entry.

**Allocation.** Thruster duty cycles come from a bounded least-squares fit to the commanded
wrench (FNNLS; `rcs_alloc.rs`), with torques taken about the current CoM. A pure-torque command
gives zero net force, and translation produces no torque even though the CoM is 1 m from the
quads. Duty is applied as average thrust over each 20 ms tick: pulse-width modulation, with
single pulses not resolved.

## Reaction wheels
Three orthogonal wheels, 0.2 N·m and 100 N·m·s each (Honeywell HR16 class: 50–150 N·m·s,
≤ 0.2 N·m). They are too weak to slew a 25 t stack quickly; at full mass the wheels alone give
α ≈ 3·10⁻⁶ rad/s². They hold attitude against gravity-gradient torque (≈ 0.1 N·m in LEO) and
absorb small corrections without spending propellant. Larger torque requests overflow to the
RCS.

**Saturation and desaturation.** Wheel momentum is clamped at the capacity. Above 90 % the SAS
spins the wheels down at half torque while holding attitude with RCS, and stops below 5 %.
Tested: from 95 N·m·s to < 5 N·m·s with < 0.5° pointing excursion.

## Attitude control (SAS)
Modes: Hold, Prograde/Retrograde, Normal/Anti-normal, Radial out/in, Target/Anti-target and
Maneuver. The direction modes use the selected speed reference (orbit, surface or target).

The control law is a cascade:
1. **Attitude loop.** Eigenaxis error angle θ from the quaternion error. The commanded rate is
   min(k·θ, ω_max, √(2·½α·θ)): linear near the target, and a braking curve that stops using
   half the available angular acceleration α about the eigenaxis.
2. **Rate loop.** τ = I·4k·(ω_cmd − ω) + ω × H, scaled by the current inertia tensor with
   gyroscopic compensation. With the rate loop 4× the attitude loop, the linearized response is
   critically damped (double pole at −2k).
3. **Allocation.** The gimbal takes pitch/yaw while the engine burns; the wheels take what they
   can; the RCS takes the rest.

Tuning in the JSON: k = 0.4 s⁻¹, ω_max = 3°/s, manual rate command 3°/s at full stick.

Measured (`tests/flight.rs`) for a 30° slew about an off-axis (pitch + yaw) direction:

| Mass state | Settled (< 0.05°, < 0.01°/s) | Overshoot | RCS propellant |
|---|---|---|---|
| Full, 24,960 kg | 16.3 s | 0.000 % | 1.92 kg |
| Empty, 8,260 kg | 16.0 s | 0.000 % | 1.09 kg |

## Aerodynamics, heating and structural limits

| Stage block | C_D · A | C_R · A_SRP | Nose radius | q limit | Heat-flux limit |
|---|---|---|---|---|---|
| Stack (SM attached) | 2.2 × 30 m² | 1.3 × 30 m² | 1.95 m | 35 kPa | 150 kW/m² |
| Crew module alone | 1.3 × 11.95 m² | 1.3 × 8.86 m² | 4.69 m | 120 kPa | 6 MW/m² |

- **Stack:** C_D 2.2 is the free-molecular value. A = 30 m² is ¼ of the hull surface
  (Cauchy: the mean projected area of a convex body is S/4), for attitude-averaged drag in
  orbit. The SM limits are design choices: it has no thermal protection, and 35 kPa is a
  typical ascent max-q design value.
- **Crew module:** C_D 1.3 is the Apollo hypersonic value, heat shield forward, on the 3.9 m
  diameter. The 4.69 m nose radius is the Apollo heat shield's spherical radius. Apollo
  lunar-return entries peaked at roughly 4–5 MW/m² at the stagnation point, so the 6 MW/m²
  limit leaves about 25 % margin. This is an approximate figure, flagged for review when entry
  is validated.
- **Heating model:** Sutton–Graves stagnation-point convective heating (NASA TR R-376). The
  limits are the minimum over attached stages, and exceeding one is a terminal event.
- **Not modelled yet:** attitude-dependent aerodynamics (lift, trim angle, aero torque). Entry
  guidance needs them; they are planned, not yet scheduled to a milestone.

## Known simplifications
- **Propellant** is rigid and settled aft: no slosh, and no ullage requirement for ignition
  (PMDs/bladders assumed).
- **Jet damping** is neglected: ≈ ṁ·l²·ω ≈ 21 kg/s × (4.5 m)² × 0.05 rad/s ≈ 20 N·m, 0.1 % of
  the gimbal authority.
- **RCS thrust** is independent of ambient pressure. RCS minimum impulse bits are averaged per
  tick.
- **Power, thermal and life support** are not modelled in v1. The solar wings are structure and
  visuals.
