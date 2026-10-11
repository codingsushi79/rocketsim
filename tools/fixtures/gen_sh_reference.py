"""Independent reference for spherical-harmonic gravity (EGM2008).

    python -I tools/fixtures/gen_sh_reference.py > crates/sim-core/tests/fixtures/egm2008_accel_reference.csv

Method (deliberately different from the Cunningham recursion in gravity.rs): the
potential V = GM/r Σ_n (R/r)^n Σ_m P_nm(sin φ)(C_nm cos mλ + S_nm sin mλ) is summed directly,
with unnormalized associated Legendre functions (no Condon–Shortley phase) built in
50-digit mpmath arithmetic. The acceleration is its gradient by central differences
(h = 1 cm). Coefficients are EGM2008 with the zero-tide C20 (IERS 2010 eq. 6.14),
GM = DE440 Earth GM, R = 6378136.3 m. Columns: degree, x, y, z [m], ax, ay, az [m/s^2].
"""
import mpmath as mp

mp.mp.dps = 50
GM = mp.mpf("398600.43550702266") * 10**9
R = mp.mpf("6378136.3")
NMAX = 70

C, S = {}, {}
for line in open("data/gravity/EGM2008_to90.gfc"):
    f = line.split()
    if f and f[0] == "gfc":
        n, m = int(f[1]), int(f[2])
        if n <= NMAX:
            C[(n, m)] = mp.mpf(f[3].replace("d", "e").replace("D", "e"))
            S[(n, m)] = mp.mpf(f[4].replace("d", "e").replace("D", "e"))
C[(2, 0)] += mp.mpf("4.4228e-8") * mp.mpf("-0.31460") * mp.mpf("0.30190")
# Unnormalize: N = sqrt((2-δ)(2n+1)(n-m)!/(n+m)!)
for (n, m) in list(C):
    k = mp.sqrt((1 if m == 0 else 2) * (2 * n + 1) * mp.factorial(n - m) / mp.factorial(n + m))
    C[(n, m)] *= k
    S[(n, m)] *= k

def potential(x, y, z, N):
    r = mp.sqrt(x * x + y * y + z * z)
    s = z / r  # sin(latitude)
    c = mp.sqrt(1 - s * s)
    lam = mp.atan2(y, x)
    P = {}
    for m in range(N + 1):
        P[(m, m)] = mp.fprod([2 * k - 1 for k in range(1, m + 1)]) * c**m if m else mp.mpf(1)
        if m + 1 <= N:
            P[(m + 1, m)] = (2 * m + 1) * s * P[(m, m)]
        for n in range(m + 2, N + 1):
            P[(n, m)] = ((2 * n - 1) * s * P[(n - 1, m)] - (n + m - 1) * P[(n - 2, m)]) / (n - m)
    total = mp.mpf(0)
    for n in range(N + 1):
        inner = mp.mpf(0)
        for m in range(n + 1):
            cnm, snm = C.get((n, m), 0), S.get((n, m), 0)
            if cnm == 0 and snm == 0:
                continue
            inner += P[(n, m)] * (cnm * mp.cos(m * lam) + snm * mp.sin(m * lam))
        total += (R / r) ** n * inner
    return GM / r * total

h = mp.mpf("0.01")
points = [("6778137", "1200", "-35000"), ("-4100000.5", "3300000.25", "4800000"), ("1500000", "-6900000", "-900000")]
print("degree,x,y,z,ax,ay,az")
for N in (8, 20, 70):
    for (xs, ys, zs) in points:
        x, y, z = mp.mpf(xs), mp.mpf(ys), mp.mpf(zs)
        ax = (potential(x + h, y, z, N) - potential(x - h, y, z, N)) / (2 * h)
        ay = (potential(x, y + h, z, N) - potential(x, y - h, z, N)) / (2 * h)
        az = (potential(x, y, z + h, N) - potential(x, y, z - h, N)) / (2 * h)
        print(f"{N},{xs},{ys},{zs}," + ",".join(mp.nstr(a, 20) for a in (ax, ay, az)))
