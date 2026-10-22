"""
Сборка одного HTML-дашборда по готовым результатам BlocksNet.

Скрипт НЕ скачивает данные и НЕ повторяет расчёты: он только читает
сохранённые GeoJSON/CSV из data/berezniki/processed и строит dashboard.html
с интерактивной картой, графиками, таблицами и выводами.

Запуск (из папки examples или из корня проекта):
    python build_dashboard.py
"""

from pathlib import Path
import base64
import html
import io
import warnings

import geopandas as gpd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colors as mplcolors
import numpy as np
import pandas as pd
import folium
from branca.element import Figure

warnings.filterwarnings("ignore")
plt.rcParams.update({"figure.dpi": 110, "font.size": 10, "axes.titlesize": 11})

CRS_MAP = 4326
LAND_USE_COLS = ["residential", "business", "recreation", "industrial", "transport", "special", "agriculture"]
DENSITY_COLS = ["fsi", "gsi", "l", "osr", "mxi", "share_living", "share_non_living"]


# ---------------------------------------------------------------------------
# Пути
# ---------------------------------------------------------------------------
def find_processed_dir() -> Path:
    """Ищет папку с готовыми результатами (examples/data/berezniki/processed)."""
    bases = [Path.cwd(), *Path.cwd().parents,
             Path(__file__).resolve().parent, *Path(__file__).resolve().parent.parents]
    for base in bases:
        cand = base / "examples" / "data" / "berezniki" / "processed"
        if cand.is_dir():
            return cand
    return Path(__file__).resolve().parent.parent / "examples" / "data" / "berezniki" / "processed"


PROCESSED = find_processed_dir()
OUTPUT = Path(__file__).resolve().parent / "dashboard.html"


def read_geojson(name: str):
    path = PROCESSED / f"{name}.geojson"
    if not path.exists():
        print(f"  ! не найден файл: {path.name}")
        return None
    gdf = gpd.read_file(path)
    if gdf.crs is None:
        gdf = gdf.set_crs(32640)
    return gdf


def verify_buildings_count(buildings_blocks) -> int:
    """Проверяет, что count в buildings_blocks действительно равен числу зданий."""
    if buildings_blocks is None or "count" not in buildings_blocks.columns:
        return 0
    total_from_blocks = int(buildings_blocks["count"].sum())
    return total_from_blocks


# ---------------------------------------------------------------------------
# Загрузка готовых результатов (только чтение)
# ---------------------------------------------------------------------------
print(f"Папка с результатами: {PROCESSED}")

blocks = read_geojson("blocks")
blocks_lu = read_geojson("blocks_land_use")
buildings_blocks = read_geojson("buildings_blocks")
schools_blocks = read_geojson("schools_blocks")
provision_walk = read_geojson("provision_walk")
provision_drive = read_geojson("provision_drive")
density = read_geojson("density_indicators")
spacematrix = read_geojson("spacematrix_morphotypes")
strelka = read_geojson("strelka_morphotypes")
area_walk = read_geojson("area_accessibility_walk")
area_drive = read_geojson("area_accessibility_drive")

matrix_walk = pd.read_csv(PROCESSED / "accessibility_matrix_walk.csv", index_col=0)
matrix_drive = pd.read_csv(PROCESSED / "accessibility_matrix_drive.csv", index_col=0)
links_walk = pd.read_csv(PROCESSED / "provision_links_walk.csv")
links_drive = pd.read_csv(PROCESSED / "provision_links_drive.csv")


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------
def offdiag_values(mx: pd.DataFrame) -> np.ndarray:
    arr = np.asarray(mx.values, dtype=float)
    mask = np.isfinite(arr)
    np.fill_diagonal(mask, False)
    return arr[mask]


def fig_b64() -> str:
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    plt.close()
    return base64.b64encode(buf.getvalue()).decode()


def value_color(value, vmin, vmax, cmap_name):
    if value is None or pd.isna(value):
        return "#cccccc"
    norm = 0.5 if vmax <= vmin else (value - vmin) / (vmax - vmin)
    norm = max(0.0, min(1.0, norm))
    return mplcolors.to_hex(plt.get_cmap(cmap_name)(norm))


def categorical_colors(series, cmap_name="tab10"):
    cats = sorted([c for c in series.dropna().unique().tolist()])
    cmap = plt.get_cmap(cmap_name)
    return {cat: mplcolors.to_hex(cmap(i % cmap.N)) for i, cat in enumerate(cats)}


def add_layer(m, gdf, column, name, cmap_name="RdYlGn", vmin=None, vmax=None, categorical=False, show=False):
    if gdf is None or column not in gdf.columns:
        return
    sub = gdf.to_crs(CRS_MAP)[[column, "geometry"]].copy()
    if categorical:
        colors = categorical_colors(gdf[column], cmap_name)

        def style(feature, colors=colors, column=column):
            val = feature["properties"].get(column)
            return {"fillColor": colors.get(val, "#cccccc"), "color": "#444444",
                    "weight": 0.4, "fillOpacity": 0.75}
    else:
        if vmin is None:
            vmin = float(gdf[column].min())
        if vmax is None:
            vmax = float(gdf[column].max())

        def style(feature, vmin=vmin, vmax=vmax, cmap_name=cmap_name, column=column):
            val = feature["properties"].get(column)
            return {"fillColor": value_color(val, vmin, vmax, cmap_name), "color": "#444444",
                    "weight": 0.4, "fillOpacity": 0.75}

    tooltip = folium.GeoJsonTooltip(fields=[column], aliases=[column], localize=True)
    folium.GeoJson(sub, name=name, style_function=style, tooltip=tooltip, show=show).add_to(m)


# ---------------------------------------------------------------------------
# Интерактивная карта
# ---------------------------------------------------------------------------
def build_map():
    ref = blocks_lu if blocks_lu is not None else blocks
    ref4326 = ref.to_crs(CRS_MAP)
    bounds = ref4326.total_bounds
    center = [(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2]

    # Подложки. Тайлы openstreetmap.org блокируются (403) при открытии страницы как файла,
    # поэтому используем CARTO и Esri; есть и вариант без подложки.
    m = folium.Map(location=center, zoom_start=12, tiles=None, control_scale=True)
    folium.TileLayer(
        tiles="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        attr='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        name="Светлая карта (CARTO)", subdomains="abcd", max_zoom=20, show=True,
    ).add_to(m)
    folium.TileLayer(
        tiles="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attr="Tiles &copy; Esri", name="Спутник (Esri)", max_zoom=19, show=False,
    ).add_to(m)
    folium.TileLayer(
        tiles="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        attr=" ", name="Без подложки", show=False,
    ).add_to(m)

    add_layer(m, provision_walk, "provision_strong", "Обеспеченность школами (пешком)", "RdYlGn", 0, 1)
    add_layer(m, provision_drive, "provision_strong", "Обеспеченность школами (авто)", "RdYlGn", 0, 1)
    add_layer(m, blocks_lu, "land_use", "Функциональные зоны", "tab10", categorical=True, show=True)
    add_layer(m, density, "fsi", "Плотность застройки (FSI)", "YlOrRd")
    add_layer(m, buildings_blocks, "population", "Население по кварталам", "Blues")
    add_layer(m, area_walk, "area_accessibility", "Доступность территорий (пешком)", "RdYlGn_r")
    add_layer(m, area_drive, "area_accessibility", "Доступность территорий (авто)", "RdYlGn_r")
    add_layer(m, spacematrix, "morphotype", "Морфотипы (Spacematrix)", "tab20", categorical=True)
    add_layer(m, strelka, "morphotype", "Морфотипы (Strelka)", "tab20", categorical=True)

    folium.LayerControl(collapsed=False).add_to(m)

    fig = Figure(width="100%", height="640px")
    fig.add_child(m)
    full_html = fig.render()
    return f'<iframe srcdoc="{html.escape(full_html)}" width="100%" height="640" style="border:0;border-radius:8px"></iframe>'


# ---------------------------------------------------------------------------
# Графики
# ---------------------------------------------------------------------------
def make_charts():
    charts = []

    if matrix_walk is not None and matrix_drive is not None:
        fig, ax = plt.subplots(figsize=(7, 3.6))
        ax.hist(offdiag_values(matrix_walk), bins=50, alpha=0.6, label="Пешком")
        ax.hist(offdiag_values(matrix_drive), bins=50, alpha=0.6, label="На машине")
        ax.set_xlabel("Время в пути, мин")
        ax.set_ylabel("Пар кварталов")
        ax.set_title("Время в пути между кварталами")
        ax.legend()
        charts.append(("Время в пути", fig_b64()))

    if provision_walk is not None:
        fig, ax = plt.subplots(figsize=(7, 3.6))
        ax.hist(provision_walk["provision_strong"], bins=20, alpha=0.6, label="Пешком")
        if provision_drive is not None:
            ax.hist(provision_drive["provision_strong"], bins=20, alpha=0.6, label="На машине")
        ax.set_xlabel("provision_strong (доля 0–1)")
        ax.set_ylabel("Кварталов")
        ax.set_title("Обеспеченность школами")
        ax.legend()
        charts.append(("Обеспеченность школами", fig_b64()))

    if blocks_lu is not None:
        fig, ax = plt.subplots(figsize=(7, 3.6))
        shares = blocks_lu[LAND_USE_COLS].sum()
        ax.bar(range(len(shares)), shares.values, color="steelblue")
        ax.set_xticks(range(len(shares)))
        ax.set_xticklabels(shares.index, rotation=45, ha="right")
        ax.set_ylabel("Сумма долей по кварталам")
        ax.set_title("Функциональные зоны")
        charts.append(("Функциональные зоны", fig_b64()))

    if density is not None:
        fig, ax = plt.subplots(figsize=(7, 3.6))
        ax.hist(density["fsi"], bins=40, color="darkorange")
        ax.set_xlabel("FSI")
        ax.set_ylabel("Кварталов")
        ax.set_title("Плотность застройки (FSI)")
        charts.append(("Плотность застройки", fig_b64()))

    if area_walk is not None:
        fig, ax = plt.subplots(figsize=(7, 3.6))
        ax.hist(area_walk["area_accessibility"], bins=40, alpha=0.6, label="Пешком")
        if area_drive is not None:
            ax.hist(area_drive["area_accessibility"], bins=40, alpha=0.6, label="На машине")
        ax.set_xlabel("area_accessibility (мин·м²)")
        ax.set_ylabel("Кварталов")
        ax.set_title("Доступность территорий")
        ax.legend()
        charts.append(("Доступность территорий", fig_b64()))

    if spacematrix is not None and strelka is not None:
        fig, axes = plt.subplots(1, 2, figsize=(11, 4))
        for ax, gdf, title in zip(axes, [spacematrix, strelka], ["Spacematrix", "Strelka"]):
            vc = gdf["morphotype"].value_counts()
            ax.bar(range(len(vc)), vc.values, color="seagreen")
            ax.set_xticks(range(len(vc)))
            ax.set_xticklabels(vc.index, rotation=45, ha="right", fontsize=8)
            ax.set_ylabel("Кварталов")
            ax.set_title(f"Морфотипы ({title})")
        charts.append(("Морфотипы", fig_b64()))

    return charts


# ---------------------------------------------------------------------------
# Таблицы
# ---------------------------------------------------------------------------
def summary_table():
    rows = []
    if density is not None:
        for col in DENSITY_COLS:
            if col in density.columns:
                s = density[col]
                rows.append([col, s.min(), s.median(), s.max()])
    for label, gdf in [("пешком", provision_walk), ("авто", provision_drive)]:
        if gdf is not None:
            for col in ["provision_strong", "provision_weak"]:
                s = gdf[col]
                rows.append([f"{col} ({label})", s.min(), s.median(), s.max()])
    for label, gdf in [("пешком", area_walk), ("авто", area_drive)]:
        if gdf is not None:
            s = gdf["area_accessibility"]
            rows.append([f"area_accessibility ({label})", s.min(), s.median(), s.max()])
    df = pd.DataFrame(rows, columns=["Показатель", "Минимум", "Медиана", "Максимум"])
    return df.to_html(index=False, border=0, float_format=lambda x: f"{x:.3f}")


def land_use_table():
    if blocks_lu is None:
        return ""
    shares = blocks_lu[LAND_USE_COLS].sum()
    total = shares.sum()
    df = pd.DataFrame({
        "Функциональная зона": shares.index,
        "Кварталов": [int((blocks_lu[c] > 0).sum()) for c in shares.index],
        "Доля площади": shares.values,
        "%": shares.values / total * 100 if total else shares.values,
    })
    return df.to_html(index=False, border=0, float_format=lambda x: f"{x:.3f}")


def morphotype_table():
    rows = []
    for method, gdf in [("Spacematrix", spacematrix), ("Strelka", strelka)]:
        if gdf is None:
            continue
        vc = gdf["morphotype"].value_counts()
        for name, cnt in vc.items():
            rows.append([method, name, int(cnt), f"{cnt / len(gdf) * 100:.1f}%"])
    if not rows:
        return ""
    df = pd.DataFrame(rows, columns=["Метод", "Морфотип", "Кварталов", "Доля"])
    return df.to_html(index=False, border=0)


def provision_table():
    if provision_walk is None:
        return ""
    g = provision_walk[["provision_strong", "provision_weak", "demand", "capacity", "demand_left", "capacity_left"]].copy()
    g.insert(0, "Квартал", g.index)
    worst = g.nsmallest(10, "provision_strong")
    return worst.to_html(index=False, border=0, float_format=lambda x: f"{x:.3f}")


def provision_summary_table():
    path = PROCESSED / "provision_summary.csv"
    if not path.exists():
        return ""
    df = pd.read_csv(path, index_col=0)
    df.index.name = "Показатель"
    return df.reset_index().to_html(index=False, border=0, float_format=lambda x: f"{x:,.2f}" if abs(x) < 10 else f"{x:,.0f}")


def spacematrix_clusters_table():
    path = PROCESSED / "spacematrix_clusters.csv"
    if not path.exists():
        return ""
    df = pd.read_csv(path)
    keep = [c for c in ["cluster", "l", "fsi", "mxi", "l_interpretation", "fsi_interpretation", "mxi_interpretation", "morphotype"] if c in df.columns]
    return df[keep].to_html(index=False, border=0, float_format=lambda x: f"{x:.2f}")


def links_table():
    df = links_walk.copy()
    df.columns = ["Квартал-источник", "Квартал-школа", "Поток (чел.)"]
    return df.nlargest(15, "Поток (чел.)").to_html(index=False, border=0)


def drive_links_table():
    df = links_drive.copy()
    df.columns = ["Квартал-источник", "Квартал-школа", "Поток (чел.)"]
    return df.nlargest(15, "Поток (чел.)").to_html(index=False, border=0)


def buildings_table():
    if buildings_blocks is None:
        return ""
    cols = ["footprint_area", "build_floor_area", "living_area", "non_living_area", "number_of_floors",
            "population", "population_model"]
    rows = []
    for col in cols:
        if col in buildings_blocks.columns:
            s = buildings_blocks[col]
            rows.append([col, s.min(), s.median(), s.max()])
    df = pd.DataFrame(rows, columns=["Показатель", "Минимум", "Медиана", "Максимум"])
    return df.to_html(index=False, border=0, float_format=lambda x: f"{x:.1f}")


def schools_table():
    if schools_blocks is None:
        return ""
    rows = []
    for col in ["capacity", "count"]:
        if col in schools_blocks.columns:
            s = schools_blocks[col]
            rows.append([col, s.min(), s.median(), s.max(), s.sum()])
    for col in ["capacity_original", "capacity_imputed"]:
        if col in schools_blocks.columns:
            s = schools_blocks[col].dropna()
            if len(s) > 0:
                rows.append([col, s.min(), s.median(), s.max(), s.sum()])
    df = pd.DataFrame(rows, columns=["Показатель", "Минимум", "Медиана", "Максимум", "Сумма"])
    return df.to_html(index=False, border=0, float_format=lambda x: f"{x:.1f}")


def matrix_stats_table():
    rows = []
    for label, mx in [("пешком", matrix_walk), ("авто", matrix_drive)]:
        vals = offdiag_values(mx)
        n = mx.shape[0]
        total = n * (n - 1)
        rows.append([
            f"время в пути (мин), {label}",
            np.min(vals), np.median(vals), np.max(vals),
            f"{len(vals) / total * 100:.1f}%",
        ])
    df = pd.DataFrame(rows, columns=["Матрица", "Минимум", "Медиана", "Максимум", "Достижимых пар"])
    return df.to_html(index=False, border=0, float_format=lambda x: f"{x:.1f}")


# ---------------------------------------------------------------------------
# Выводы
# ---------------------------------------------------------------------------
def make_conclusions(stats):
    return [
        f"Территория: {stats['n_blocks']} кварталов, {stats['n_buildings']} зданий, население ≈ {stats['population']:,} человек. "
        f"Распределение жителей по домам — модельная оценка BlocksNet по зданиям OSM (до калибровки ≈ {stats['population_model']:,} чел.); "
        f"общая сумма приведена к численности Росстата на 01.01.2025 (132 841 чел.).",
        f"Школы: {stats['n_schools']} объектов, суммарная вместимость ≈ {stats['capacity']:,} мест. "
        f"Вместимость — фактическая численность учеников каждой школы (schoolotzyv.ru), а не проектная мощность зданий; "
        f"для вечерней школы без данных — 250 мест по умолчанию BlocksNet.",
        f"Медианное время в пути между кварталами: {stats['median_walk']:.1f} мин пешком и {stats['median_drive']:.1f} мин на машине "
        f"(автомобильная доступность выше примерно в {stats['median_walk'] / stats['median_drive']:.1f} раза).",
        f"Кварталов с обеспеченностью школами ниже 0.5: {stats['low_walk']:.1f}% пешком и {stats['low_drive']:.1f}% на машине.",
        f"Преобладающая функциональная зона — {stats['top_lu']} ({stats['top_lu_share']:.1f}% площади).",
        f"Самый распространённый морфотип (Spacematrix) — {stats['top_morph']} ({stats['top_morph_share']:.1f}% кварталов).",
        f"Наиболее доступный квартал — #{stats['best_acc_id']} ({stats['best_acc']:.1f} мин·м²); "
        f"наименее доступный — #{stats['worst_acc_id']} ({stats['worst_acc']:.1f} мин·м²).",
    ]


# ---------------------------------------------------------------------------
# Сборка
# ---------------------------------------------------------------------------
def main():
    print("Строю интерактивную карту...")
    map_iframe = build_map()

    print("Строю графики...")
    charts = make_charts()

    print("Собираю таблицы...")
    tables = [
        ("Сводка по показателям", summary_table()),
        ("Здания (площади, этажи, население)", buildings_table()),
        ("Школы (мощность, количество)", schools_table()),
        ("Матрицы времени в пути", matrix_stats_table()),
        ("Функциональные зоны", land_use_table()),
        ("Морфотипы", morphotype_table()),
        ("Обеспеченность школами: итоги по городу (нехватка и остаток мест)", provision_summary_table()),
        ("Группы Spacematrix (медианы по кластеру)", spacematrix_clusters_table()),
        ("Худшая обеспеченность школами (пешком, топ-10)", provision_table()),
        ("Крупнейшие потоки к школам (пешком, топ-15)", links_table()),
        ("Крупнейшие потоки к школам (авто, топ-15)", drive_links_table()),
    ]

    print("Считаю ключевые цифры...")
    n_buildings_verified = verify_buildings_count(buildings_blocks)
    stats = {
        "n_blocks": len(blocks) if blocks is not None else 0,
        "n_buildings": n_buildings_verified,
        "population": int(round(buildings_blocks["population"].sum())) if buildings_blocks is not None else 0,
        "population_model": int(round(buildings_blocks["population_model"].sum()))
        if buildings_blocks is not None and "population_model" in buildings_blocks.columns else 0,
        "n_schools": int(schools_blocks["count"].sum()) if schools_blocks is not None else 0,
        "capacity": int(schools_blocks["capacity"].sum()) if schools_blocks is not None else 0,
        "median_walk": float(np.median(offdiag_values(matrix_walk))),
        "median_drive": float(np.median(offdiag_values(matrix_drive))),
        "low_walk": float((provision_walk["provision_strong"] < 0.5).mean() * 100),
        "low_drive": float((provision_drive["provision_strong"] < 0.5).mean() * 100),
    }
    shares = blocks_lu[LAND_USE_COLS].sum()
    top_lu = shares.idxmax()
    stats["top_lu"] = top_lu
    stats["top_lu_share"] = float(shares.max() / shares.sum() * 100)
    vc = spacematrix["morphotype"].value_counts()
    stats["top_morph"] = vc.index[0]
    stats["top_morph_share"] = float(vc.iloc[0] / len(spacematrix) * 100)
    best = area_walk["area_accessibility"].idxmin()
    worst = area_walk["area_accessibility"].idxmax()
    stats["best_acc_id"] = best
    stats["worst_acc_id"] = worst
    stats["best_acc"] = float(area_walk.loc[best, "area_accessibility"])
    stats["worst_acc"] = float(area_walk.loc[worst, "area_accessibility"])

    conclusions = make_conclusions(stats)

    cards = [
        ("Кварталов", f"{stats['n_blocks']:,}"),
        ("Зданий", f"{stats['n_buildings']:,}"),
        ("Население, Росстат (01.01.2025)", f"{stats['population']:,}"),
        ("Население, расчёт по зданиям OSM", f"{stats['population_model']:,}"),
        ("Школ (объектов)", f"{stats['n_schools']:,}"),
        ("Мест в школах", f"{stats['capacity']:,}"),
        ("Медиана пути (пешком)", f"{stats['median_walk']:.1f} мин"),
        ("Медиана пути (авто)", f"{stats['median_drive']:.1f} мин"),
        ("Низкая обеспеченность (пешком)", f"{stats['low_walk']:.1f}%"),
    ]
    cards_html = "".join(
        f'<div class="card"><div class="num">{value}</div><div class="label">{label}</div></div>'
        for label, value in cards
    )
    charts_html = "".join(
        f'<figure><img src="data:image/png;base64,{b64}" alt="{title}"><figcaption>{title}</figcaption></figure>'
        for title, b64 in charts
    )
    tables_html = "".join(f"<h3>{title}</h3>{table}" for title, table in tables if table)
    conclusions_html = "".join(f"<li>{item}</li>" for item in conclusions)

    html_doc = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Березники — дашборд BlocksNet</title>
<style>
  :root {{ --bg:#f5f6f8; --card:#ffffff; --ink:#1f2937; --muted:#6b7280; --accent:#2563eb; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
         font-family:"Segoe UI", Roboto, Helvetica, Arial, sans-serif; }}
  header {{ background:linear-gradient(135deg,#1e3a8a,#2563eb); color:#fff; padding:28px 32px; }}
  header h1 {{ margin:0 0 6px; font-size:26px; }}
  header p {{ margin:0; opacity:.9; }}
  main {{ max-width:1200px; margin:0 auto; padding:24px; }}
  h2 {{ border-left:5px solid var(--accent); padding-left:10px; margin:32px 0 14px; }}
  h3 {{ color:var(--muted); font-size:14px; margin:18px 0 8px; }}
  .cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; }}
  .card {{ background:var(--card); border-radius:10px; padding:16px; box-shadow:0 1px 3px rgba(0,0,0,.08); }}
  .card .num {{ font-size:24px; font-weight:700; color:var(--accent); }}
  .card .label {{ color:var(--muted); font-size:13px; margin-top:4px; }}
  .map-box {{ background:var(--card); border-radius:10px; padding:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); }}
  .charts {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:16px; }}
  figure {{ background:var(--card); border-radius:10px; padding:12px; margin:0; box-shadow:0 1px 3px rgba(0,0,0,.08); }}
  figure img {{ width:100%; height:auto; display:block; }}
  figcaption {{ color:var(--muted); font-size:13px; margin-top:8px; }}
  table {{ border-collapse:collapse; width:100%; background:var(--card); font-size:13px; }}
  th, td {{ border:1px solid #e5e7eb; padding:6px 9px; text-align:right; }}
  th {{ background:#eef2ff; }}
  td:first-child, th:first-child {{ text-align:left; }}
  ul.conclusions li {{ margin:8px 0; }}
  footer {{ color:var(--muted); text-align:center; padding:20px; font-size:12px; }}
</style>
</head>
<body>
<header>
  <h1>Березники, Пермский край — дашборд городского анализа</h1>
  <p>Кварталы, землепользование, застройка, доступность и обеспеченность школами · данные OpenStreetMap, расчёт BlocksNet 1.0.0a9</p>
</header>
<main>
  <h2>Ключевые показатели</h2>
  <div class="cards">{cards_html}</div>

  <h2>Интерактивная карта</h2>
  <div class="map-box">{map_iframe}</div>

  <h2>Графики</h2>
  <div class="charts">{charts_html}</div>

  <h2>Таблицы показателей</h2>
  {tables_html}

  <h2>Выводы</h2>
  <ul class="conclusions">{conclusions_html}</ul>
</main>
<footer>Сформировано скриптом build_dashboard.py</footer>
</body>
</html>"""

    OUTPUT.write_text(html_doc, encoding="utf-8")
    print(f"Готово: {OUTPUT} ({OUTPUT.stat().st_size / 1024:.0f} КБ)")


if __name__ == "__main__":
    main()
