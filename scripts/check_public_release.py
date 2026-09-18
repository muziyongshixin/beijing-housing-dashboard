#!/usr/bin/env python3
"""Fail a release if public artifacts or tracked private paths violate the free boundary."""
import json
import sqlite3
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check(root=ROOT):
    root = Path(root)
    paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    forbidden = (".private/", "outputs/", "config/amap.local.json", "data/transactions.sqlite3", "data/build_meta.local.json", "data/community_locations.local.json", ".env", "supabase/.temp/", "supabase/.branches/", "node_modules/")
    leaked = [p for p in paths if p and (p.startswith(forbidden) or p.endswith((".csv.gz", ".enc")))]
    if leaked:
        raise ValueError("私有文件被 Git 跟踪：" + ", ".join(leaked))
    with sqlite3.connect((root / "docs/data/transactions.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
        count, last = db.execute("SELECT COUNT(*),MAX(sale_date) FROM transactions").fetchone()
        assert count > 0 and last <= 20250831, "公开数据库超过免费日期边界"
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "公开数据库损坏"
        assert db.execute("SELECT COUNT(*) FROM communities WHERE last_date>20250831").fetchone()[0] == 0
    meta = json.loads((root / "docs/data/meta.json").read_text())
    assert meta["date_max"] <= "2025-08-31" and meta["cleaning"]["kept_rows"] == count
    assert all(month <= "2025-08" for month in meta.get("monthly_counts", {}))
    assert not {"source", "source_counts", "merge_status_counts"} & meta.keys(), "包含私有源元数据"
    with sqlite3.connect((root / "docs/data/transactions.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
        identities = set(db.execute("SELECT d.name,b.name,c.name FROM communities c JOIN business_areas b ON b.id=c.business_area_id JOIN districts d ON d.id=b.district_id"))
    positions = json.loads((root / "docs/data/community-locations.json").read_text())["locations"]
    for key, value in positions.items():
        identity = tuple(value.get(k) for k in ("district", "business_area", "community"))
        assert identity in identities and key == "|".join(identity), "公开坐标包含非免费小区"
        assert set(value) <= {"district", "business_area", "community", "name", "address", "lng", "lat", "coordinate_system", "status"}, "公开坐标包含未审核字段"
        assert 115.4 <= value["lng"] <= 117.6 and 39.4 <= value["lat"] <= 41.1
    allowed = {"index.html", "app.js", "location-cache.js", "access.js", "analytics.js", "admin.html", "admin.js", "admin.css", "pages-data.js", "pages-client.js", "pages-worker.js", "styles.css", "product.css", "product.js", "cloud.js", "beijing-districts.geojson", ".nojekyll", "CNAME", "data/meta.json", "data/community-locations.json", "data/transactions.sqlite3", "vendor/sql-wasm.js", "vendor/sql-wasm.wasm"}
    for path in (root / "docs").rglob("*"):
        if path.is_symlink() or path.is_file() and path.relative_to(root / "docs").as_posix() not in allowed:
            raise ValueError("公开产物包含未审核文件：" + str(path))
    print(f"Public release guard passed: {count:,} rows, latest {last}")


if __name__ == "__main__": check()
