"""Reference IAU body orientations from CSPICE (via SpiceyPy) for the v1 bodies.

    python -I tools/fixtures/gen_iau_rotation_spice.py > crates/sim-core/tests/fixtures/iau_rotation_spice.csv

Requires `spiceypy` (tested with CSPICE N0067). Loads the committed data/pck/pck00011.tpc
and calls tisbod('J2000', body, et), the 6x6 state transform to the body-fixed frame.
Columns: naif, et (TDB s past J2000), R (row-major 3x3, J2000 -> body-fixed),
omega_bf (rad/s; body-fixed components of the frame's angular velocity, from dR/dt).
SPICE's J2000 frame is used as ICRF (the ~20 mas frame bias is ignored by SPICE PCK frames too).
"""
import numpy as np
import spiceypy as sp

sp.furnsh("data/pck/pck00011.tpc")
BODIES = [10, 199, 299, 399, 301, 499, 401, 402, 599, 501, 502, 503, 504, 699, 601,
          602, 603, 604, 605, 606, 608, 799, 899, 801, 999, 2000001, 2000004]
ETS = [-1.5e9, -6.0e8, 1.0e5, 8.4e8, 3.1e9]  # 1952 … 2098

print("naif,et,r00,r01,r02,r10,r11,r12,r20,r21,r22,w0,w1,w2")
for b in BODIES:
    for et in ETS:
        m = np.array(sp.tisbod("J2000", b, et))
        r, dr = m[:3, :3], m[3:, :3]
        # dR/dt = -[w]x R  =>  [w]x = -dR R^T
        wx = -dr @ r.T
        w = [wx[2, 1], wx[0, 2], wx[1, 0]]
        vals = list(r.flatten()) + w
        print(f"{b},{et!r}," + ",".join(repr(float(x)) for x in vals))
