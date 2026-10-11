"""Fetch JPL Horizons state vectors used to validate the ephemeris (spec §6).

Run once; outputs are committed as fixtures:
    python3 -I tools/fixtures/fetch_horizons.py

Writes
  crates/sim-core/tests/fixtures/horizons_vectors.csv   body, JD TDB, x y z [km], vx vy vz [km/s]
  tools/fixtures/horizons_epochs.txt                    the epochs as TDB seconds past J2000
                                                        (input to `ephem-build fixture`)
Query: ICRF axes (REF_SYSTEM=ICRF, REF_PLANE=FRAME), centered on the solar-system
barycenter (CENTER='500@0'), geometric states (no light time), TDB, km and km/s.
API docs: https://ssd-api.jpl.nasa.gov/doc/horizons.html
"""
import datetime
import json
import time
import urllib.parse
import urllib.request

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
J2000 = 2451545.0

# Epochs land on whole 3-hour multiples so the JD → seconds conversion is exact.
PLANET_JDS = [2433282.5 + 100.375 + k * 2738.75 for k in range(20)]   # 1950-04 … 2092
MOON_JDS = [J2000 + 400.25 + k * 8800.25 for k in range(5)]            # 2001 … 2097

# (Horizons COMMAND, our NAIF id, epochs)
PLANETS = ["10", "199", "299", "399", "301", "4", "499", "5", "599", "6", "699",
           "7", "8", "899", "9", "999"]
MOONS = ["401", "402", "501", "502", "503", "504", "601", "602", "603", "604",
         "605", "606", "608", "801"]
SMALL = [("1;", 2000001), ("4;", 2000004)]  # asteroid numbers: Ceres, Vesta

def query(command, jds):
    params = {
        "format": "json",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS",
        "CENTER": "'500@0'",
        "REF_SYSTEM": "ICRF",
        "REF_PLANE": "FRAME",
        "VEC_TABLE": "2",
        "VEC_CORR": "NONE",
        "OUT_UNITS": "KM-S",
        "TIME_TYPE": "TDB",
        "CSV_FORMAT": "YES",
        "VEC_LABELS": "NO",
        "TLIST_TYPE": "JD",
        "TLIST": " ".join(f"'{jd:.6f}'" for jd in jds),
    }
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=120) as r:
        text = json.load(r)["result"]
    if "$$SOE" not in text:
        raise RuntimeError(f"Horizons error for {command}:\n{text[:2000]}")
    body = text.split("$$SOE")[1].split("$$EOE")[0]
    source = [l.strip() for l in text.splitlines() if "Target body name" in l or "EPHEMERIS" in l.upper() and "SOURCE" in l.upper()]
    rows = []
    for line in body.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        rows.append((float(f[0]), *map(float, f[2:8])))
    return rows, source

def main():
    today = datetime.date.today().isoformat()
    out = [
        f"# JPL Horizons vectors, retrieved {today} from {API}",
        "# ICRF axes, center = solar-system barycenter (500@0), geometric, TDB; km, km/s",
        "naif,jd_tdb,x,y,z,vx,vy,vz",
    ]
    jobs = [(c, int(c), PLANET_JDS + MOON_JDS) for c in PLANETS] + [(c, int(c), MOON_JDS) for c in MOONS] + [(c, n, MOON_JDS) for c, n in SMALL]
    for command, naif, jds in jobs:
        rows, source = query(command, jds)
        assert len(rows) == len(jds), (command, len(rows))
        out.insert(2, f"# {naif}: " + " | ".join(source)[:300])
        for r in rows:
            out.append(f"{naif},{r[0]:.6f}," + ",".join(repr(x) for x in r[1:]))
        print(f"{command:>6} -> {naif}: {len(rows)} epochs")
        time.sleep(1.0)
    with open("crates/sim-core/tests/fixtures/horizons_vectors.csv", "w") as fh:
        fh.write("\n".join(out) + "\n")
    secs = sorted({round((jd - J2000) * 86400.0) for jd in PLANET_JDS + MOON_JDS})
    with open("tools/fixtures/horizons_epochs.txt", "w") as fh:
        fh.write("# TDB seconds past J2000 of the Horizons fixture epochs\n")
        fh.write("\n".join(str(s) for s in secs) + "\n")

if __name__ == "__main__":
    main()
