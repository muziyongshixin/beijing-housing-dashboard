#!/usr/bin/env python3
"""Versioned monthly public inputs for trusted server-side exact calculations.

Reads only the audited, cutoff-limited Pages database. No private source access.
"""
import gzip
import hashlib
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def build(directory=ROOT / 'docs'):
    directory = Path(directory)
    with sqlite3.connect((directory / 'data/transactions.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
        assert db.execute('select max(sale_date) from transactions').fetchone()[0] <= 20250831
        communities = db.execute('select c.id,d.name,b.name,c.name from communities c join business_areas b on b.id=c.business_area_id join districts d on d.id=b.district_id order by c.id').fetchall()
        ids = {r[0]: i for i, r in enumerate(communities)}
        history = {}
        for month, cid, area, price, cycle, discount, rooms in db.execute('select t.sale_month,t.community_id,t.area/100.0,t.unit_price,t.cycle_days,case when t.listing_price>0 then t.sale_price*1.0/t.listing_price-1 end,l.rooms from transactions t join layouts l on l.id=t.layout_id order by t.sale_month,t.community_id,t.sale_date'):
            month = f'{str(month)[:4]}-{str(month)[4:]}'
            history.setdefault(month, []).append([month, ids[cid], area, price, cycle, discount, rooms])
    dest = directory / 'data/history'
    dest.mkdir(exist_ok=True)
    def save(name, data):
        raw = json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        path = f'data/history/{name}.json.gz'
        (directory / path).write_bytes(compressed)
        return {'path': path, 'sha256': hashlib.sha256(compressed).hexdigest(), 'bytes': len(compressed), 'raw_bytes': len(raw)}
    years = {}
    for month, rows in history.items():
        years.setdefault(month[:4], []).extend(rows)
    manifest = {'schema': 1, 'through': '2025-08-31', 'source_sha256': hashlib.sha256((directory / 'data/transactions.sqlite3').read_bytes()).hexdigest(),
                'catalog': save('catalog', [r[1:] for r in communities]),
                'months': {month: save(month, rows) for month, rows in history.items()},
                'years': {year: save(f'year-{year}', rows) for year, rows in years.items()}}
    payload = json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))
    (directory / 'data/history/manifest.json').write_text(payload)
    # This manifest is deployment-trusted code, never supplied by a browser.
    target = ROOT / 'supabase/functions/market-report/public-history-manifest.json'
    target.parent.mkdir(exist_ok=True, parents=True)
    target.write_text(payload)
    print(f'Public-only history: {sum(map(len,history.values())):,} rows, {len(history)} monthly shards, {len(years)} annual edge shards')

if __name__ == '__main__':
    build()
