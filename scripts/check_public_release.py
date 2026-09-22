#!/usr/bin/env python3
"""Fail a release if public artifacts or tracked private paths violate the free boundary."""
import json
import hashlib
import gzip
import sqlite3
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def check_fast(directory, meta):
    """Verify every public shard against the audited SQLite, not just date labels."""
    directory = Path(directory)
    fast = meta["pages"]["fast"]
    source_hash = meta["pages"]["database_sha256"]
    assert fast["source_sha256"] == source_hash and fast["through"] == meta["date_max"]
    allowed = set()
    def read(ref):
        relative = ref["path"]
        assert relative.startswith("data/") and ".." not in Path(relative).parts
        assert relative not in allowed, "Duplicate public cache path"
        allowed.add(relative)
        data = (directory / relative).read_bytes()
        assert len(data) == ref["bytes"] and hashlib.sha256(data).hexdigest() == ref["sha256"]
        return gzip.decompress(data)
    assert read(meta["pages"]["database_gzip"]) == (directory / "data/transactions.sqlite3").read_bytes()
    catalog = json.loads(read(fast["catalog"]))
    with sqlite3.connect((directory / "data/transactions.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
        expected = db.execute("SELECT c.id,d.name,b.name,c.name,c.transaction_count,c.first_date,c.last_date FROM communities c JOIN business_areas b ON b.id=c.business_area_id JOIN districts d ON d.id=b.district_id ORDER BY c.id").fetchall()
        def date(v):
            s=str(v)
            return f"{s[:4]}-{s[4:6]}-{s[6:]}"
        actual = [dict(zip(("id","district","business_area","community","transaction_count","first_date","last_date"), [*r[:5],date(r[5]),date(r[6])]), shard=str((r[0]-1)//32)) for r in expected]
        assert catalog == actual, "Public catalog differs from free database"
        records = {}
        for row in db.execute("SELECT t.community_id,t.sale_date,t.sale_month,l.name,o.name,f.name,t.area/100.0,t.listing_price/100.0,t.sale_price/100.0,t.unit_price,t.cycle_days,t.source_code FROM transactions t JOIN layouts l ON l.id=t.layout_id JOIN orientations o ON o.id=t.orientation_id JOIN floors f ON f.id=t.floor_id ORDER BY t.community_id,t.sale_date"):
            records.setdefault(str(row[0]), []).append(list(row[1:]))
    seen = set()
    for shard, ref in fast["shards"].items():
        data = json.loads(read(ref))
        assert set(data) == {"columns", "communities"}
        assert data["columns"] == ["sale_date","sale_month","layout","orientation","floor","area","listing_price","sale_price","unit_price","cycle_days","source_code"]
        for identity, rows in data["communities"].items():
            assert identity not in seen and str((int(identity)-1)//32) == shard
            assert rows == records[identity], "Shard differs from free database"
            seen.add(identity)
    assert seen == set(records)
    def check_dates(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in ("month","end_month","current_end","base_end") and isinstance(item,str):
                    assert item <= "2025-08", "Public preset exceeds free cutoff"
                check_dates(item)
        elif isinstance(value,list):
            for item in value: check_dates(item)
    assert set(fast["presets"]) == {f"{w}-{c}" for w in (3,6,12) for c in ("adjacent","yoy")}
    for name, ref in fast["presets"].items():
        preset = json.loads(read(ref))
        assert set(preset) == {"source_sha256","through","district","community","trends"}
        assert preset["source_sha256"] == source_hash and preset["through"] == meta["date_max"]
        for level in ("district","community"):
            c = preset[level]["config"]
            assert f'{c["window"]}-{c["compare"]}' == name and c["metric"] == "median"
        check_dates(preset)
    return allowed


def check_history(directory, meta):
    """Every server input is compared with the public DB, not trusted by filename."""
    directory = Path(directory)
    manifest_path = directory / 'data/history/manifest.json'
    if not manifest_path.exists():
        return set()  # Legacy test fixture without server-side monthly inputs.
    manifest = json.loads(manifest_path.read_text())
    assert manifest['schema'] == 1 and manifest['through'] == '2025-08-31'
    assert manifest['source_sha256'] == meta['pages']['database_sha256']
    allowed = {'data/history/manifest.json'}
    def read(ref):
        path = ref['path']
        assert path.startswith('data/history/') and '..' not in Path(path).parts and path not in allowed
        allowed.add(path)
        compressed = (directory / path).read_bytes()
        assert len(compressed) == ref['bytes'] and hashlib.sha256(compressed).hexdigest() == ref['sha256']
        raw = gzip.decompress(compressed)
        assert len(raw) == ref['raw_bytes']
        return json.loads(raw)
    catalog = read(manifest['catalog'])
    with sqlite3.connect((directory / 'data/transactions.sqlite3').as_uri()+'?mode=ro', uri=True) as db:
        communities = db.execute('select c.id,d.name,b.name,c.name from communities c join business_areas b on b.id=c.business_area_id join districts d on d.id=b.district_id order by c.id').fetchall()
        assert catalog == [list(r[1:]) for r in communities]
        ids = {r[0]:i for i,r in enumerate(communities)}
        expected = {}
        for m,c,a,p,y,d,r in db.execute('select t.sale_month,t.community_id,t.area/100.0,t.unit_price,t.cycle_days,case when t.listing_price>0 then t.sale_price*1.0/t.listing_price-1 end,l.rooms from transactions t join layouts l on l.id=t.layout_id order by t.sale_month,t.community_id,t.sale_date'):
            month=f'{str(m)[:4]}-{str(m)[4:]}'
            expected.setdefault(month,[]).append([month,ids[c],a,p,y,d,r])
    assert set(expected) == set(manifest['months'])
    for month,ref in manifest['months'].items():
        assert month <= '2025-08' and read(ref) == expected[month], 'History differs from free database'
    return allowed


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
    assert meta['pages']['database_sha256'] == hashlib.sha256((root / 'docs/data/transactions.sqlite3').read_bytes()).hexdigest(), '公开数据库版本哈希不一致'
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
    allowed.update(check_fast(root / "docs", meta))
    allowed.update(check_history(root / 'docs', meta))
    for path in (root / "docs").rglob("*"):
        if path.is_symlink() or path.is_file() and path.relative_to(root / "docs").as_posix() not in allowed:
            raise ValueError("公开产物包含未审核文件：" + str(path))
    print(f"Public release guard passed: {count:,} rows, latest {last}")


if __name__ == "__main__": check()
