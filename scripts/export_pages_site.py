#!/usr/bin/env python3
"""Build the self-contained GitHub Pages edition of the housing dashboard.

The source database is intentionally not copied as-is: repeated text is moved to
small dimension tables and source URLs are stored as their 12-character record
codes.  This keeps the browser database comfortably below GitHub's file limit.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from access_control import PAID_FROM
from public_data import build_free_snapshot, public_metadata


SOURCE_DB = Path(os.environ.get("PAGES_SOURCE_DB", ROOT / "data" / "transactions.sqlite3")).expanduser().resolve()
OUTPUT = ROOT / "docs"
OUTPUT_DB = OUTPUT / "data" / "transactions.sqlite3"
SOURCE_META = Path(os.environ.get("PAGES_SOURCE_META", ROOT / "data" / "build_meta.json")).expanduser().resolve()
PUBLIC_CUTOFF_DATE = PAID_FROM  # No environment override may publish paid records.
SQLJS_VERSION = "1.14.2"
SQLJS_FILES = {
    "sql-wasm.js": "f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7",
    "sql-wasm.wasm": "38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a",
}


def reset_output() -> None:
    OUTPUT.mkdir(exist_ok=True)
    for name in ("index.html", "app.js", "location-cache.js", "access.js", "analytics.js", "admin.html", "admin.js", "admin.css", "pages-data.js", "pages-client.js", "pages-worker.js", "styles.css", "product.css", "product.js", "cloud.js", "beijing-districts.geojson"):
        shutil.copy2(ROOT / "static" / name, OUTPUT / name)
    index = (OUTPUT / "index.html").read_text(encoding="utf-8")
    index = index.replace(
        'window.DASHBOARD_STATIC_BUILD=false',
        "window.DASHBOARD_STATIC_BUILD=true",
    )
    index = index.replace(
        '<script src="./app.js"></script>',
        '<script src="./pages-client.js"></script><script src="./app.js"></script>',
    )
    (OUTPUT / "index.html").write_text(index, encoding="utf-8")
    (OUTPUT / "data").mkdir(exist_ok=True)
    (OUTPUT / "vendor").mkdir(exist_ok=True)
    (OUTPUT / ".nojekyll").write_text("", encoding="utf-8")


def ensure_sqljs() -> None:
    import hashlib

    for name, expected in SQLJS_FILES.items():
        destination = OUTPUT / "vendor" / name
        if not destination.exists():
            url = f"https://cdn.jsdelivr.net/npm/sql.js@{SQLJS_VERSION}/dist/{name}"
            urllib.request.urlretrieve(url, destination)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if digest != expected:
            raise RuntimeError(f"sql.js checksum mismatch: {name}")


def _create_target_schema(target: sqlite3.Connection) -> None:
    target.executescript(
        """
        CREATE TABLE districts(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, map_name TEXT NOT NULL);
        CREATE TABLE business_areas(id INTEGER PRIMARY KEY, district_id INTEGER NOT NULL, name TEXT NOT NULL);
        CREATE TABLE communities(
            id INTEGER PRIMARY KEY, business_area_id INTEGER NOT NULL, name TEXT NOT NULL,
            transaction_count INTEGER NOT NULL, first_date INTEGER NOT NULL, last_date INTEGER NOT NULL
        );
        CREATE TABLE layouts(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, rooms TEXT NOT NULL);
        CREATE TABLE orientations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE floors(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE transactions(
            sale_date INTEGER NOT NULL, sale_month INTEGER NOT NULL, community_id INTEGER NOT NULL,
            layout_id INTEGER NOT NULL, orientation_id INTEGER NOT NULL, floor_id INTEGER NOT NULL,
            area INTEGER NOT NULL, listing_price INTEGER, sale_price INTEGER NOT NULL,
            unit_price INTEGER NOT NULL, cycle_days INTEGER, source_code
        );
        """
    )


def copy_full_source(source: sqlite3.Connection, target: sqlite3.Connection) -> None:
    """Build the compact public database from the current full local cache."""
    source.execute("DROP TABLE IF EXISTS temp.public_transactions")
    source.execute(
        "CREATE TEMP TABLE public_transactions AS SELECT * FROM transactions WHERE sale_date < ?",
        (PUBLIC_CUTOFF_DATE,),
    )
    source_table = "public_transactions"
    _create_target_schema(target)

    districts = [r[0] for r in source.execute(f"SELECT DISTINCT district FROM {source_table} ORDER BY district")]
    district_ids = {name: i + 1 for i, name in enumerate(districts)}
    target.executemany(
        "INSERT INTO districts VALUES (?, ?, ?)",
        [(i, name, "大兴" if name == "北京经济技术开发区" else name) for name, i in district_ids.items()],
    )
    areas = list(source.execute(f"SELECT DISTINCT district, business_area FROM {source_table} ORDER BY district, business_area"))
    area_ids = {(district, area): i + 1 for i, (district, area) in enumerate(areas)}
    target.executemany(
        "INSERT INTO business_areas VALUES (?, ?, ?)",
        [(i, district_ids[district], area) for (district, area), i in area_ids.items()],
    )
    communities = list(source.execute(f"""
        SELECT district, business_area, community, COUNT(*),
               CAST(REPLACE(MIN(sale_date), '-', '') AS INTEGER),
               CAST(REPLACE(MAX(sale_date), '-', '') AS INTEGER)
        FROM {source_table} GROUP BY district, business_area, community
        ORDER BY district, business_area, community
    """))
    community_ids = {(d, b, c): i + 1 for i, (d, b, c, *_rest) in enumerate(communities)}
    target.executemany(
        "INSERT INTO communities VALUES (?, ?, ?, ?, ?, ?)",
        [(i, area_ids[(d, b)], c, count, first_date, last_date)
         for (d, b, c, count, first_date, last_date), i in zip(communities, community_ids.values())],
    )
    layouts = list(source.execute(f"SELECT DISTINCT layout, rooms FROM {source_table} ORDER BY layout"))
    layout_ids = {name: i + 1 for i, (name, _rooms) in enumerate(layouts)}
    target.executemany("INSERT INTO layouts VALUES (?, ?, ?)", [(layout_ids[name], name, rooms) for name, rooms in layouts])
    orientations = [r[0] for r in source.execute(f"SELECT DISTINCT orientation FROM {source_table} ORDER BY orientation")]
    orientation_ids = {name: i + 1 for i, name in enumerate(orientations)}
    target.executemany("INSERT INTO orientations VALUES (?, ?)", [(i, name) for name, i in orientation_ids.items()])
    floors = [r[0] for r in source.execute(f"SELECT DISTINCT floor FROM {source_table} ORDER BY floor")]
    floor_ids = {name: i + 1 for i, name in enumerate(floors)}
    target.executemany("INSERT INTO floors VALUES (?, ?)", [(i, name) for name, i in floor_ids.items()])

    query = f"""
        SELECT sale_date, sale_month, district, business_area, community, layout, orientation, floor,
               area, listing_price, sale_price, unit_price, cycle_days, url
        FROM {source_table} ORDER BY id
    """
    insert = "INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    batch = []
    for row in source.execute(query):
        sale_date, sale_month, district, area_name, community, layout, orientation, floor, area, listing, sale, unit, cycle, url = row
        code = str(url or "").rsplit("/", 1)[-1].removesuffix(".html")
        code_value = int(code) if code.isdigit() else code
        batch.append((
            int(str(sale_date).replace("-", "")), int(str(sale_month).replace("-", "")),
            community_ids[(district, area_name, community)], layout_ids[layout],
            orientation_ids[orientation], floor_ids[floor], round(area * 100),
            None if listing is None else round(listing * 100), round(sale * 100), round(unit), cycle, code_value,
        ))
        if len(batch) >= 10_000:
            target.executemany(insert, batch)
            batch.clear()
    if batch:
        target.executemany(insert, batch)
    target.executescript(
        """
        CREATE INDEX idx_transactions_month ON transactions(sale_month);
        CREATE INDEX idx_transactions_community ON transactions(community_id);
        CREATE INDEX idx_communities_name ON communities(name);
        ANALYZE;
        """
    )


def export_locations(source, destination, cache_path=ROOT / "data/community_locations.local.json"):
    """Export only free-community POIs and allowlisted fields; no transaction data."""
    from app import load_community_locations
    allowed = set(source.execute("SELECT DISTINCT district,business_area,community FROM transactions"))
    result = {}
    for value in load_community_locations(cache_path).values():
        identity = tuple(value.get(k) for k in ("district", "business_area", "community"))
        if identity not in allowed:
            continue
        try:
            lng, lat = float(value["lng"]), float(value["lat"])
        except (ValueError, TypeError, KeyError):
            continue
        if not (115.4 <= lng <= 117.6 and 39.4 <= lat <= 41.1):
            continue
        result["|".join(identity)] = {**dict(zip(("district", "business_area", "community"), identity)),
                                   "name": value.get("name", identity[2]), "address": value.get("address", ""),
                                   "lng": lng, "lat": lat, "coordinate_system": "GCJ-02", "status": "located"}
    destination.write_text(json.dumps({"locations": result}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def validate_public_artifact(directory: Path) -> None:
    metadata = json.loads((directory / "data/meta.json").read_text())
    with sqlite3.connect((directory / "data/transactions.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
        count, last = db.execute("SELECT COUNT(*), MAX(sale_date) FROM transactions").fetchone()
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("公开数据库完整性校验失败")
        if not count or last >= 20250901:
            raise ValueError("拒绝发布：数据库包含受限日期")
        if db.execute("SELECT COUNT(*) FROM communities WHERE last_date >= 20250901").fetchone()[0]:
            raise ValueError("拒绝发布：小区统计包含受限日期")
        if metadata["cleaning"]["kept_rows"] != count:
            raise ValueError("公开元数据与数据行数不一致")
    if metadata["date_max"] > "2025-08-31" or any(m > "2025-08" for m in metadata["monthly_counts"]):
        raise ValueError("拒绝发布：元数据超出免费边界")
    if any(k in metadata for k in ("source", "source_counts", "merge_status_counts")):
        raise ValueError("拒绝发布：发现私有元数据")


def version_assets(directory: Path) -> None:
    """Version the full entrypoint/worker chain so returning users cannot mix releases."""
    def version(name):
        return hashlib.sha256((directory / name).read_bytes()).hexdigest()[:16]
    worker = directory / "pages-worker.js"
    worker.write_text(worker.read_text().replace("'./pages-data.js'", f"'./pages-data.js?v={version('pages-data.js')}'"))
    client = directory / "pages-client.js"
    client.write_text(client.read_text().replace("'./pages-worker.js'", f"'./pages-worker.js?v={version('pages-worker.js')}'"))
    for name in ("index.html", "admin.html"):
        path = directory / name
        path.write_text(re.sub(r'((?:src|href)="\./)([^"?]+\.(?:js|css))(")',
            lambda m: f'{m[1]}{m[2]}?v={version(m[2])}{m[3]}', path.read_text()))


def main() -> None:
    global OUTPUT, OUTPUT_DB
    if os.environ.get("PAGES_CUTOFF_DATE", PAID_FROM) != PAID_FROM or os.environ.get("ALLOW_PRIVATE_PAGES_EXPORT"):
        raise ValueError("免费发布边界固定为 2025-09-01 之前，不接受私有导出覆盖")
    final = OUTPUT
    with tempfile.TemporaryDirectory(prefix="pages-stage-", dir=ROOT / ".private") as stage:
        free_db, _ = build_free_snapshot(SOURCE_DB, Path(stage) / "filtered")
        with sqlite3.connect(free_db.as_uri() + "?mode=ro", uri=True) as source:
            metadata = public_metadata(source)
        OUTPUT = Path(stage) / "docs"
        OUTPUT_DB = OUTPUT / "data/transactions.sqlite3"
        try:
            reset_output()
            for name in SQLJS_FILES:
                existing = final / "vendor" / name
                if existing.exists():
                    shutil.copy2(existing, OUTPUT / "vendor" / name)
            ensure_sqljs()
            with sqlite3.connect(free_db.as_uri() + "?mode=ro", uri=True) as source, sqlite3.connect(OUTPUT_DB) as target:
                copy_full_source(source, target)
                export_locations(source, OUTPUT / "data/community-locations.json")
                target.commit()
                target.execute("VACUUM")
            metadata["pages"] = {"edition": "static-wasm", "database": "data/transactions.sqlite3", "database_bytes": OUTPUT_DB.stat().st_size,
                                 "database_sha256": hashlib.sha256(OUTPUT_DB.read_bytes()).hexdigest()}
            metadata["public_snapshot"] = {"cutoff_exclusive": PAID_FROM, "note": "免费快照含整个 2025 年 8 月；静态站点不能强制试用额度。"}
            (OUTPUT / "data/meta.json").write_text(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            validate_public_artifact(OUTPUT)
            version_assets(OUTPUT)
            # Preserve domain settings. All generated files are validated before replacing any.
            for source_path in OUTPUT.rglob("*"):
                if source_path.is_file():
                    destination = final / source_path.relative_to(OUTPUT)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(source_path, destination)
        finally:
            OUTPUT, OUTPUT_DB = final, final / "data/transactions.sqlite3"
    print(f"Verified free Pages snapshot: {metadata['cleaning']['kept_rows']:,} rows through {metadata['date_max']}")


if __name__ == "__main__":
    (ROOT / ".private").mkdir(exist_ok=True, mode=0o700)
    main()
