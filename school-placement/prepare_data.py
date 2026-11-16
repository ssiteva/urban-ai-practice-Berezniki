"""
Подготовка исходных данных для приложения «Размещение школ» (Практика 3).

Читает ГОТОВЫЕ результаты Практики 2 (ничего в них не меняет, ничего не скачивает)
и сохраняет их в school-placement/data/:
  * base_data.js   — данные для браузерного приложения (кварталы, население, места,
                     разреженные матрицы времени ≤ 15 мин);
  * source_blocks.csv — таблица исходных данных по кварталам (для проверки);
  * check_baseline.txt — сверка с provision_walk/drive.geojson Практики 2.

Запуск из корня проекта (нужны только numpy и pandas, они уже есть в .venv):
    python school-placement/prepare_data.py
"""
from __future__ import annotations

import base64
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "examples" / "data" / "berezniki"
PROCESSED = DATA / "processed"
RAW = DATA / "raw"
OUT = HERE / "data"

# Параметры BlocksNet 1.0.0a9: service_types_config['school'] (config/service_types/common/default.json)
DEMAND_PER_1000 = 120   # школьников на 1000 жителей
ACCESSIBILITY_MIN = 15  # нормативная доступность школы, мин
UTM_ZONE = 40           # EPSG:32640 — CRS кварталов Практики 2

REQUIRED = {
    "Кварталы и население (Практика 2, § 7)": PROCESSED / "buildings_blocks.geojson",
    "Вместимость школ по кварталам (Практика 2, § 8)": PROCESSED / "schools_blocks.geojson",
    "Матрица времени пешком (Практика 2, § 6)": PROCESSED / "accessibility_matrix_walk.csv",
    "Матрица времени на машине (Практика 2, § 6)": PROCESSED / "accessibility_matrix_drive.csv",
    "Обеспеченность пешком — эталон (Практика 2, § 9)": PROCESSED / "provision_walk.geojson",
    "Обеспеченность на машине — эталон (Практика 2, § 9)": PROCESSED / "provision_drive.geojson",
    "Школы OSM (Практика 2, § 2)": RAW / "schools.geojson",
    "Численность учеников (Практика 2, § 8)": RAW / "schools_capacity.csv",
}


def utm_to_lonlat(e: float, n: float, zone: int = UTM_ZONE) -> tuple[float, float]:
    """UTM (WGS84, северное полушарие) -> lon, lat. Без pyproj, точность ~ мм."""
    a = 6378137.0
    f = 1 / 298.257223563
    k0 = 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x = e - 500000.0
    m = n / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
            + (151 * e1**3 / 96) * math.sin(6 * mu) + (1097 * e1**4 / 512) * math.sin(8 * mu))
    c1 = ep2 * math.cos(phi1) ** 2
    t1 = math.tan(phi1) ** 2
    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d**3 / 6
           + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / math.cos(phi1)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    return round(math.degrees(lon0 + lon), 6), round(math.degrees(lat), 6)


def geom_to_wgs(geom: dict) -> dict:
    def ring(r):
        return [list(utm_to_lonlat(x, y)) for x, y in r]
    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": [ring(r) for r in geom["coordinates"]]}
    if geom["type"] == "MultiPolygon":
        return {"type": "MultiPolygon", "coordinates": [[ring(r) for r in p] for p in geom["coordinates"]]}
    raise ValueError(geom["type"])


def b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


def school_key(name):
    # та же функция, что в berezniki_pipeline.ipynb, § 8
    if not isinstance(name, str):
        return None
    match = re.search(r"№\s*(\d+)", name)
    if not match:
        return None
    lower = name.lower()
    kind = "лицей" if "лицей" in lower else ("гимназия" if "гимназ" in lower else "школа")
    return f"{kind} {match.group(1)}"


def main() -> int:
    missing = [f"  - {k}: {p.relative_to(ROOT)}" for k, p in REQUIRED.items() if not p.exists()]
    if missing:
        print("Не хватает файлов Практики 2:\n" + "\n".join(missing))
        print("Восстановите их, выполнив examples/berezniki_pipeline.ipynb (разделы 2, 6–9). "
              "Подставные данные не создаются.")
        return 1

    bb = json.loads((PROCESSED / "buildings_blocks.geojson").read_text(encoding="utf-8"))["features"]
    sb = json.loads((PROCESSED / "schools_blocks.geojson").read_text(encoding="utf-8"))["features"]
    pw = json.loads((PROCESSED / "provision_walk.geojson").read_text(encoding="utf-8"))["features"]
    pd_ = json.loads((PROCESSED / "provision_drive.geojson").read_text(encoding="utf-8"))["features"]
    n = len(bb)

    mats = {}
    for mode in ("walk", "drive"):
        m = pd.read_csv(PROCESSED / f"accessibility_matrix_{mode}.csv", index_col=0)
        ids_r = [int(x) for x in m.index]
        ids_c = [int(x) for x in m.columns]
        if ids_r != list(range(n)) or ids_c != list(range(n)):
            print(f"ОШИБКА: id кварталов не совпадают со строками/столбцами матрицы {mode}")
            return 1
        if m.isna().any().any():
            print(f"ОШИБКА: в матрице {mode} есть пропуски")
            return 1
        mats[mode] = m.to_numpy(dtype=float)
    if not (len(sb) == len(pw) == len(pd_) == n):
        print("ОШИБКА: разное число кварталов в файлах Практики 2")
        return 1

    population = np.array([f["properties"]["population"] for f in bb], dtype=float)
    population_model = np.array([f["properties"].get("population_model") or 0 for f in bb], dtype=float)
    capacity_raw = np.array([f["properties"]["capacity"] for f in sb], dtype=float)
    capacity = capacity_raw.astype(int)  # BlocksSchema приводит capacity к int (отбрасывает дробную часть)
    demand = np.array([math.ceil(p / 1000 * DEMAND_PER_1000) for p in population], dtype=int)
    land_use = [f["properties"].get("land_use") for f in pw]

    # Школы: точки для карты, вместимость — как в ноутбуке (§ 8)
    schools = json.loads((RAW / "schools.geojson").read_text(encoding="utf-8"))["features"]
    students = pd.read_csv(RAW / "schools_capacity.csv").set_index("key")["students"]
    keys = [school_key(f["properties"].get("name")) for f in schools]
    counts = pd.Series(keys).value_counts()
    school_points = []
    for f, key in zip(schools, keys):
        g = f["geometry"]
        pts = np.array(g["coordinates"] if g["type"] == "Point" else g["coordinates"][0] if g["type"] == "Polygon"
                       else g["coordinates"][0][0])
        lon, lat = (pts if pts.ndim == 1 else pts[:-1].mean(axis=0)).tolist()
        cap = float(students[key]) / counts[key] if key in students.index else 250.0
        src = "численность учеников (schoolotzyv.ru)" if key in students.index else "по умолчанию BlocksNet: 250 мест"
        school_points.append({"name": f["properties"].get("name"), "lon": round(lon, 6), "lat": round(lat, 6),
                              "capacity": round(cap, 1), "source": src})

    # Разреженные матрицы: только пары с временем ≤ 15 мин — других метод не использует
    sparse = {}
    for mode, m in mats.items():
        row_ptr = [0]
        cols, vals = [], []
        for i in range(n):
            js = np.where(m[i] <= ACCESSIBILITY_MIN)[0]
            cols.extend(js.tolist())
            vals.extend(np.round(m[i, js] * 10000).astype(np.int64).tolist())  # значения CSV имеют 4 знака
            row_ptr.append(len(cols))
        assert np.allclose(np.array(vals) / 10000, np.concatenate([m[i][m[i] <= ACCESSIBILITY_MIN] for i in range(n)]), atol=1e-12)
        sparse[mode] = {
            "rowPtr": b64(np.array(row_ptr, dtype=np.uint32)),
            "cols": b64(np.array(cols, dtype=np.uint16)),
            "vals": b64(np.array(vals, dtype=np.uint32)),
            "scale": 10000,
            "pairs": len(cols),
            "medianMin": round(float(np.median(m)), 2),
        }

    baseline = {}
    for mode, feats in (("walk", pw), ("drive", pd_)):
        baseline[mode] = {
            "demand_within": [int(f["properties"]["demand_within"]) for f in feats],
            "demand_left": [int(f["properties"]["demand_left"]) for f in feats],
            "provision_strong": [f["properties"]["provision_strong"] for f in feats],
        }

    features = []
    for i, f in enumerate(bb):
        features.append({"type": "Feature", "properties": {"id": i}, "geometry": geom_to_wgs(f["geometry"])})

    data = {
        "city": "Березники (Пермский край)",
        "n": n,
        "params": {"demand_per_1000": DEMAND_PER_1000, "accessibility_min": ACCESSIBILITY_MIN,
                   "blocksnet": "1.0.0a9", "method": "competitive_provision (self_supply=True, max_depth=1)"},
        "population": [round(float(p), 2) for p in population],
        "population_model": population_model.astype(int).tolist(),
        "demand": demand.tolist(),
        "capacity": capacity.tolist(),
        "capacity_raw": capacity_raw.tolist(),
        "land_use": land_use,
        "schools": school_points,
        "matrices": sparse,
        "practice2": baseline,
        "geojson": {"type": "FeatureCollection", "features": features},
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "base_data.js").write_text(
        "// Сгенерировано prepare_data.py из файлов Практики 2. Не редактировать вручную.\n"
        "window.BASE_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8")

    pd.DataFrame({
        "block_id": range(n), "land_use": land_use,
        "population_p2": population.round(1), "population_model_p2": population_model.astype(int),
        "demand_seats": demand, "capacity_seats_p2": capacity,
        "provision_walk_p2": [f["properties"]["provision_strong"] for f in pw],
        "provision_drive_p2": [f["properties"]["provision_strong"] for f in pd_],
    }).to_csv(OUT / "source_blocks.csv", index=False, encoding="utf-8-sig")

    print(f"Кварталов: {n} | население: {population.sum():.0f} | спрос: {demand.sum()} мест | "
          f"места: {capacity.sum()} | пар ≤ {ACCESSIBILITY_MIN} мин: walk {sparse['walk']['pairs']}, "
          f"drive {sparse['drive']['pairs']}")
    print("Сохранено:", (OUT / "base_data.js").relative_to(ROOT), "и", (OUT / "source_blocks.csv").relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
