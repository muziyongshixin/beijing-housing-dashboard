"""Physically separated free snapshot, with metadata computed only from public rows."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path

from access_control import FREE_THROUGH, PAID_FROM, PRIVATE_DIR


def public_metadata(db):
    count, first, last = db.execute("SELECT COUNT(*),MIN(sale_date),MAX(sale_date) FROM transactions").fetchone()
    if not count or last > FREE_THROUGH:
        raise ValueError("免费数据为空或超过免费日期边界")
    districts = [r[0] for r in db.execute("SELECT DISTINCT district FROM transactions ORDER BY district")]
    business = {}
    for district, area in db.execute("SELECT DISTINCT district,business_area FROM transactions ORDER BY district,business_area"):
        business.setdefault(district, []).append(area)
    return {
        "date_min": first, "date_max": last, "min_month": first[:7], "max_month": last[:7],
        "default_end_month": last[:7], "districts": districts, "business_areas": business,
        "rooms": [r[0] for r in db.execute("SELECT DISTINCT rooms FROM transactions ORDER BY rooms")],
        "district_count": len(districts), "business_area_count": sum(map(len, business.values())),
        "community_count": db.execute("SELECT COUNT(*) FROM (SELECT DISTINCT district,business_area,community FROM transactions)").fetchone()[0],
        "monthly_counts": dict(db.execute("SELECT sale_month,COUNT(*) FROM transactions GROUP BY sale_month ORDER BY sale_month")),
        "cleaning": {"kept_rows": count},
        "coverage_note": "免费快照仅包含清洗后的授权日期内成交；不披露私有源文件和全量清洗统计。",
        "access": {"tier": "free", "free_through": FREE_THROUGH, "paid_from": PAID_FROM},
    }


def build_free_snapshot(source: Path, destination=PRIVATE_DIR):
    """CREATE-AS-SELECT, never copy-then-delete (deleted pages can retain secrets)."""
    source, destination = Path(source).resolve(), Path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    target, meta_path = destination / "free.sqlite3", destination / "free.meta.json"
    fingerprint = {"size": source.stat().st_size, "mtime_ns": source.stat().st_mtime_ns, "cutoff": FREE_THROUGH, "version": 1}
    marker = destination / "free.fingerprint.json"
    if target.exists() and meta_path.exists() and marker.exists():
        if json.loads(marker.read_text()) == fingerprint:
            return target, meta_path
    with tempfile.TemporaryDirectory(prefix="free-build-", dir=destination) as stage:
        staged = Path(stage) / "free.sqlite3"
        with sqlite3.connect(staged) as db:
            db.execute("ATTACH DATABASE ? AS source", (source.as_uri() + "?mode=ro",))
            db.execute("CREATE TABLE transactions AS SELECT * FROM source.transactions WHERE sale_date<=?", (FREE_THROUGH,))
            db.executescript("""
                CREATE INDEX idx_free_month ON transactions(sale_month);
                CREATE INDEX idx_free_community ON transactions(district,business_area,community);
                CREATE INDEX idx_free_name ON transactions(community);
            """)
            metadata = public_metadata(db)
        os.chmod(staged, 0o600)
        os.replace(staged, target)
        for path, payload in ((meta_path, metadata), (marker, fingerprint)):
            temporary = Path(stage) / path.name
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
    return target, meta_path
