#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "北京成交数据.xlsx"
DATA_DIR = ROOT / "data"
DATABASE = DATA_DIR / "transactions.sqlite3"
META = DATA_DIR / "build_meta.json"

EXPECTED_HEADERS = [
    "成交日期", "城市", "区域", "商圈", "小区", "户型", "朝向", "楼层",
    "面积（m²）", "挂牌价（万元）", "成交价（万元）", "成交单价（元）", "成交周期", "网页链接",
]


def source_signature(path: Path) -> dict:
    stat = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": digest.hexdigest()}


def cache_is_current() -> bool:
    if not DATABASE.exists() or not META.exists() or not SOURCE.exists():
        return False
    try:
        meta = json.loads(META.read_text(encoding="utf-8"))
        stat = SOURCE.stat()
        saved = meta.get("source", {})
        return saved.get("size") == stat.st_size and saved.get("mtime_ns") == stat.st_mtime_ns
    except (OSError, ValueError):
        return False


def parse_cycle(value) -> int | None:
    if value is None:
        return None
    match = re.search(r"(\d+)", str(value))
    return int(match.group(1)) if match else None


def parse_rooms(value) -> str:
    text = str(value or "").strip()
    match = re.match(r"(\d+)室", text)
    if match:
        rooms = int(match.group(1))
        return "4室及以上" if rooms >= 4 else f"{rooms}室"
    if "开间" in text:
        return "开间"
    return "其他"


def build(force: bool = False) -> dict:
    if not SOURCE.exists():
        raise FileNotFoundError(f"未找到数据源：{SOURCE}")
    if not force and cache_is_current():
        return json.loads(META.read_text(encoding="utf-8"))

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_db = DATABASE.with_suffix(".sqlite3.tmp")
    if temp_db.exists():
        temp_db.unlink()

    started = time.time()
    source = source_signature(SOURCE)
    workbook = load_workbook(SOURCE, read_only=True, data_only=True)
    sheet = workbook[workbook.sheetnames[0]]
    rows = sheet.iter_rows(values_only=True)
    headers = list(next(rows))
    if headers != EXPECTED_HEADERS:
        raise ValueError(f"Excel 字段与预期不一致：{headers}")

    connection = sqlite3.connect(temp_db)
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.execute("PRAGMA temp_store=MEMORY")
    connection.execute(
        """
        CREATE TABLE transactions (
            id INTEGER PRIMARY KEY,
            sale_date TEXT NOT NULL,
            sale_month TEXT NOT NULL,
            district TEXT NOT NULL,
            business_area TEXT NOT NULL,
            community TEXT NOT NULL,
            layout TEXT NOT NULL,
            rooms TEXT NOT NULL,
            orientation TEXT NOT NULL,
            floor TEXT NOT NULL,
            area REAL NOT NULL,
            listing_price REAL,
            sale_price REAL NOT NULL,
            unit_price REAL NOT NULL,
            cycle_days INTEGER,
            discount_rate REAL,
            url TEXT NOT NULL
        )
        """
    )

    insert_sql = """
        INSERT INTO transactions (
            sale_date, sale_month, district, business_area, community, layout, rooms,
            orientation, floor, area, listing_price, sale_price, unit_price,
            cycle_days, discount_rate, url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    seen_urls: set[str] = set()
    buffer = []
    stats = {
        "source_rows": 0,
        "kept_rows": 0,
        "excluded_duplicate": 0,
        "excluded_missing_location": 0,
        "excluded_unknown_district": 0,
        "excluded_outlier": 0,
        "missing_listing_price": 0,
    }
    min_date = None
    max_date = None
    districts: set[str] = set()
    business_areas: set[str] = set()
    communities: set[str] = set()

    for row in rows:
        stats["source_rows"] += 1
        (
            sale_date, _city, district, business_area, community, layout, orientation, floor,
            area, listing_price, sale_price, unit_price, cycle, url,
        ) = row
        district = str(district or "").strip()
        business_area = str(business_area or "").strip()
        community = str(community or "").strip()
        url = str(url or "").strip()

        if not district or not business_area or not community:
            stats["excluded_missing_location"] += 1
            continue
        if district == "-":
            stats["excluded_unknown_district"] += 1
            continue
        if url in seen_urls:
            stats["excluded_duplicate"] += 1
            continue
        seen_urls.add(url)

        try:
            area = float(area)
            sale_price = float(sale_price)
            unit_price = float(unit_price)
            listing_price = float(listing_price) if listing_price is not None else None
        except (TypeError, ValueError):
            stats["excluded_outlier"] += 1
            continue

        if not (10 <= area <= 500 and 10 <= sale_price <= 10000 and 3000 <= unit_price <= 200000):
            stats["excluded_outlier"] += 1
            continue
        if listing_price is None or listing_price <= 0:
            stats["missing_listing_price"] += 1
            discount_rate = None
        else:
            discount_rate = sale_price / listing_price - 1

        date_text = str(sale_date).strip().replace(".", "-").replace("/", "-")
        month = date_text[:7]
        min_date = date_text if min_date is None or date_text < min_date else min_date
        max_date = date_text if max_date is None or date_text > max_date else max_date
        districts.add(district)
        business_areas.add(f"{district}\t{business_area}")
        communities.add(f"{district}\t{business_area}\t{community}")
        buffer.append((
            date_text, month, district, business_area, community, str(layout or ""), parse_rooms(layout),
            str(orientation or ""), str(floor or ""), area, listing_price, sale_price, unit_price,
            parse_cycle(cycle), discount_rate, url,
        ))
        stats["kept_rows"] += 1
        if len(buffer) >= 5000:
            connection.executemany(insert_sql, buffer)
            buffer.clear()

    if buffer:
        connection.executemany(insert_sql, buffer)

    connection.executescript(
        """
        CREATE INDEX idx_transactions_month ON transactions(sale_month);
        CREATE INDEX idx_transactions_district_month ON transactions(district, sale_month);
        CREATE INDEX idx_transactions_community_month ON transactions(community, sale_month);
        CREATE INDEX idx_transactions_business_month ON transactions(business_area, sale_month);
        CREATE INDEX idx_transactions_rooms_month ON transactions(rooms, sale_month);
        ANALYZE;
        """
    )
    connection.commit()
    connection.close()
    workbook.close()

    if DATABASE.exists():
        DATABASE.unlink()
    temp_db.replace(DATABASE)
    meta = {
        "source": source,
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "elapsed_seconds": round(time.time() - started, 1),
        "date_min": min_date,
        "date_max": max_date,
        "district_count": len(districts),
        "business_area_count": len(business_areas),
        "community_count": len(communities),
        "cleaning": stats,
        "rules": {
            "area": [10, 500],
            "unit_price": [3000, 200000],
            "sale_price": [10, 10000],
        },
    }
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


if __name__ == "__main__":
    force = "--force" in sys.argv
    result = build(force=force)
    print(json.dumps(result, ensure_ascii=False, indent=2))
