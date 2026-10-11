"""GCRS -> ITRS reference matrices from ERFA eraC2t06a (IAU 2006/2000A, CIO-based).

    python -I tools/fixtures/gen_earth_erfa.py > crates/sim-core/tests/fixtures/earth_c2t_erfa.csv

Inputs are explicit (TT, UT1, polar motion), so the test checks the precession,
nutation, sidereal-time and polar-motion chain independently of EOP interpolation.
Columns: tt_int, tt_frac (TT s past J2000), ut1_int, ut1_frac (UT1 s past
2000-01-01T12:00 UT1), xp, yp (rad), then the row-major 3x3 GCRS->ITRS matrix.
"""
import erfa

AS2R = erfa.DAS2R
cases = []
for k in range(24):
    tt = -7.5e8 + k * 1.6e8 + 12345.678        # 1976 … 2093
    ut1 = tt - 69.184 + 0.3 * ((k % 5) - 2)     # plausible UT1-TT
    xp = (0.05 + 0.02 * (k % 7)) * AS2R
    yp = (0.30 + 0.015 * (k % 5)) * AS2R
    cases.append((tt, ut1, xp, yp))

print("tt_int,tt_frac,ut1_int,ut1_frac,xp,yp,m00,m01,m02,m10,m11,m12,m20,m21,m22")
for tt, ut1, xp, yp in cases:
    ti, tf = int(tt // 1), tt - (tt // 1)
    ui, uf = int(ut1 // 1), ut1 - (ut1 // 1)
    m = erfa.c2t06a(2451545.0, (ti + tf) / 86400.0, 2451545.0, (ui + uf) / 86400.0, xp, yp)
    vals = [float(x) for x in m.flatten()]
    print(f"{ti},{tf!r},{ui},{uf!r},{xp!r},{yp!r}," + ",".join(repr(v) for v in vals))
