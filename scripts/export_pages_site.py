#!/usr/bin/env python3
"""Build the self-contained GitHub Pages edition of the housing dashboard.

The source database is intentionally not copied as-is: repeated text is moved to
small dimension tables and source URLs are stored as their 12-character record
codes.  This keeps the browser database comfortably below GitHub's file limit.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analytics import AnalyticsService  # noqa: E402


SOURCE_DB = ROOT / "data" / "transactions.sqlite3"
OUTPUT = ROOT / "docs"
OUTPUT_DB = OUTPUT / "data" / "transactions.sqlite3"
SQLJS_VERSION = "1.14.2"
SQLJS_FILES = {
    "sql-wasm.js": "f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7",
    "sql-wasm.wasm": "38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a",
}


def reset_output() -> None:
    OUTPUT.mkdir(exist_ok=True)
    for name in ("index.html", "app.js", "pages-data.js", "styles.css", "beijing-districts.geojson"):
        shutil.copy2(ROOT / "static" / name, OUTPUT / name)
    index = (OUTPUT / "index.html").read_text(encoding="utf-8")
    index = index.replace(
        'window.DASHBOARD_STATIC_BUILD=location.protocol!=="file:"&&!(location.hostname==="127.0.0.1"||location.hostname==="localhost")',
        "window.DASHBOARD_STATIC_BUILD=true",
    )
    index = index.replace(
        '<script src="./app.js"></script>',
        '<script src="./vendor/sql-wasm.js"></script><script src="./pages-data.js"></script><script src="./app.js"></script>',
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


def copy_dimensions(source: sqlite3.Connection, target: sqlite3.Connection) -> None:
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

    districts = [r[0] for r in source.execute("SELECT DISTINCT district FROM transactions ORDER BY district")]
    district_ids = {name: i + 1 for i, name in enumerate(districts)}
    target.executemany(
        "INSERT INTO districts VALUES (?, ?, ?)",
        [(i, name, "大兴" if name == "北京经济技术开发区" else name) for name, i in district_ids.items()],
    )

    areas = list(source.execute("SELECT DISTINCT district, business_area FROM transactions ORDER BY district, business_area"))
    area_ids = {(district, area): i + 1 for i, (district, area) in enumerate(areas)}
    target.executemany(
        "INSERT INTO business_areas VALUES (?, ?, ?)",
        [(i, district_ids[district], area) for (district, area), i in area_ids.items()],
    )

    communities = list(
        source.execute(
            """
            SELECT district, business_area, community, COUNT(*),
                   CAST(REPLACE(MIN(sale_date), '-', '') AS INTEGER),
                   CAST(REPLACE(MAX(sale_date), '-', '') AS INTEGER)
            FROM transactions GROUP BY district, business_area, community
            ORDER BY district, business_area, community
            """
        )
    )
    community_ids = {(d, b, c): i + 1 for i, (d, b, c, *_rest) in enumerate(communities)}
    target.executemany(
        "INSERT INTO communities VALUES (?, ?, ?, ?, ?, ?)",
        [(i, area_ids[(d, b)], c, count, first_date, last_date) for (d, b, c, count, first_date, last_date), i in zip(communities, community_ids.values())],
    )

    layouts = list(source.execute("SELECT DISTINCT layout, rooms FROM transactions ORDER BY layout"))
    layout_ids = {name: i + 1 for i, (name, _rooms) in enumerate(layouts)}
    target.executemany("INSERT INTO layouts VALUES (?, ?, ?)", [(layout_ids[name], name, rooms) for name, rooms in layouts])
    orientations = [r[0] for r in source.execute("SELECT DISTINCT orientation FROM transactions ORDER BY orientation")]
    orientation_ids = {name: i + 1 for i, name in enumerate(orientations)}
    target.executemany("INSERT INTO orientations VALUES (?, ?)", [(i, name) for name, i in orientation_ids.items()])
    floors = [r[0] for r in source.execute("SELECT DISTINCT floor FROM transactions ORDER BY floor")]
    floor_ids = {name: i + 1 for i, name in enumerate(floors)}
    target.executemany("INSERT INTO floors VALUES (?, ?)", [(i, name) for name, i in floor_ids.items()])

    query = """
        SELECT sale_date, sale_month, district, business_area, community, layout, orientation, floor,
               area, listing_price, sale_price, unit_price, cycle_days, url
        FROM transactions ORDER BY id
    """
    insert = "INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    batch = []
    for row in source.execute(query):
        sale_date, sale_month, district, area_name, community, layout, orientation, floor, area, listing, sale, unit, cycle, url = row
        code = url.rsplit("/", 1)[-1].removesuffix(".html")
        code_value = int(code) if code.isdigit() else code
        batch.append(
            (
                int(sale_date.replace("-", "")), int(sale_month.replace("-", "")),
                community_ids[(district, area_name, community)], layout_ids[layout],
                orientation_ids[orientation], floor_ids[floor], round(area * 100),
                None if listing is None else round(listing * 100), round(sale * 100),
                round(unit), cycle, code_value,
            )
        )
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


def write_metadata() -> None:
    metadata = AnalyticsService().metadata()
    metadata["pages"] = {
        "edition": "static-wasm",
        "database": "data/transactions.sqlite3",
        "database_bytes": OUTPUT_DB.stat().st_size,
    }
    (OUTPUT / "data" / "meta.json").write_text(
        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )


def main() -> None:
    reset_output()
    ensure_sqljs()
    OUTPUT_DB.unlink(missing_ok=True)
    with sqlite3.connect(SOURCE_DB) as source, sqlite3.connect(OUTPUT_DB) as target:
        target.execute("PRAGMA journal_mode=OFF")
        target.execute("PRAGMA synchronous=OFF")
        target.execute("PRAGMA page_size=4096")
        copy_dimensions(source, target)
        target.commit()
        target.execute("VACUUM")
    write_metadata()
    print(f"Pages database: {OUTPUT_DB.stat().st_size / 1024 / 1024:.1f} MiB")


if __name__ == "__main__":
    main()
