"""Generate UTC -> TAI/TT/TDB reference values with ERFA (the open SOFA port).

Run once; the CSV output is committed as a test fixture:
    python -I tools/fixtures/gen_time_erfa.py > crates/sim-core/tests/fixtures/time_erfa.csv

Requires `pyerfa` (tested with pyerfa 2.0.1.5 / ERFA 2.0.1). Columns:
  utc            input UTC (ISO, 'T' separated)
  tai_minus_utc  erfa.dat, s
  tai_sec        TAI seconds past 2000-01-01T12:00:00 TAI
  tt_sec         TT seconds past J2000.0
  tdb_sec        TDB seconds past J2000.0 TDB (geocentric: eraDtdb with u=v=0)
Seconds are printed as integer part and fraction separately to keep full precision.
"""
import sys
import erfa

EPOCHS = [
    (1972, 1, 1, 0, 0, 0.0), (1972, 6, 30, 23, 59, 59.5), (1972, 7, 1, 0, 0, 0.0),
    (1977, 3, 14, 6, 30, 0.0), (1980, 1, 6, 0, 0, 0.0), (1985, 7, 4, 12, 0, 0.0),
    (1990, 10, 31, 18, 45, 30.25), (1995, 2, 1, 3, 3, 3.0), (1998, 12, 31, 23, 59, 60.5),
    (1999, 1, 1, 0, 0, 0.0), (2000, 1, 1, 11, 58, 55.816), (2000, 1, 1, 12, 0, 0.0),
    (2004, 8, 18, 9, 10, 11.5), (2008, 12, 31, 23, 59, 59.999), (2012, 6, 30, 23, 59, 60.0),
    (2015, 7, 1, 0, 0, 0.0), (2016, 12, 31, 23, 59, 60.9), (2017, 1, 1, 0, 0, 0.0),
    (2020, 3, 20, 3, 50, 0.0), (2024, 2, 29, 12, 0, 0.0), (2026, 11, 1, 0, 0, 0.0),
    # Beyond today's table ERFA holds the last value; so do we (flagged provisional).
    (2030, 6, 21, 15, 0, 0.0), (2050, 1, 1, 0, 0, 0.0), (2075, 9, 9, 9, 9, 9.0),
    (2099, 12, 31, 23, 59, 59.0),
]

def split(d1, d2, j0):
    """Seconds past JD j0 from a two-part JD, as (int seconds, fraction)."""
    days = (d1 - j0) + d2
    whole_days = int(days // 1)
    rem_days = (d1 - j0 - whole_days) + d2
    sec = rem_days * 86400.0
    isec = int(sec // 1)
    return whole_days * 86400 + isec, sec - isec

def fmt(pair):
    i, f = pair
    return f"{int(i)},{float(f)!r}"

print("utc,tai_minus_utc,tai_sec_int,tai_sec_frac,tt_sec_int,tt_sec_frac,tdb_sec_int,tdb_sec_frac")
import warnings
warnings.simplefilter("ignore")  # "dubious year" warnings for future dates are expected
for (y, mo, d, h, mi, s) in EPOCHS:
    u1, u2 = erfa.dtf2d("UTC", y, mo, d, h, mi, s)
    a1, a2 = erfa.utctai(u1, u2)
    t1, t2 = erfa.taitt(a1, a2)
    ut_frac = (h * 3600 + mi * 60 + s) / 86400.0  # UT1 ~ UTC is fine for the geocentric case
    dtdb = erfa.dtdb(t1, t2, ut_frac, 0.0, 0.0, 0.0)
    b1, b2 = erfa.tttdb(t1, t2, dtdb)
    dat = erfa.dat(y, mo, d, (h * 3600 + mi * 60 + min(s, 59.999)) / 86400.0)
    iso = f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:06.3f}"
    print(f"{iso},{float(dat)!r},{fmt(split(a1, a2, 2451545.0))},{fmt(split(t1, t2, 2451545.0))},{fmt(split(b1, b2, 2451545.0))}")
