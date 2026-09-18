#!/usr/bin/env python3
"""Explicit, resumable import into the user-confirmed private project; no public export."""
import argparse
import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'mehbviiakjcbfckonzqk'

def quote(value):
    if value is None: return 'NULL'
    if isinstance(value, (float, int)): return repr(value)
    return "'" + str(value).replace("'", "''") + "'"

def execute(sql):
    # Private SQL batches never appear in argv, stdout or a public build.
    with tempfile.NamedTemporaryFile(mode='w', suffix='.sql', dir=ROOT/'.private', encoding='utf-8') as f:
        os.chmod(f.name, 0o600)
        f.write(sql); f.flush()
        r = subprocess.run(['npx','--yes','supabase@2.117.0','db','query','--linked','--project-ref',PROJECT,'--file',f.name],
                           cwd=ROOT, capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise RuntimeError('Private import query failed; data not printed. Check project/network and retry.')
        return json.loads(r.stdout).get('rows', [])

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--confirm-project', required=True, choices=[PROJECT])
    parser.add_argument('--batch-size', type=int, default=2000)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 5000: parser.error('batch size must be 1..5000')
    with sqlite3.connect((ROOT/'data/transactions.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
        communities = list(db.execute("select distinct district,business_area,community from transactions where sale_date >= '2025-09-01' order by 1,2,3"))
        for i in range(0,len(communities),args.batch_size):
            values=','.join('('+','.join(map(quote,row))+')' for row in communities[i:i+args.batch_size])
            execute('insert into housing_private.communities(district,business_area,community) values '+values+' on conflict (district,business_area,community) do nothing;')
        mapping=execute('select id,district,business_area,community from housing_private.communities;')
        ids={(r['district'],r['business_area'],r['community']):r['id'] for r in mapping}
        cursor=db.execute("select id,district,business_area,community,sale_date,area,unit_price,sale_price,listing_price,layout,rooms,orientation,floor,cycle_days,discount_rate from transactions where sale_date >= '2025-09-01' order by id")
        count=0
        while True:
            rows=cursor.fetchmany(args.batch_size)
            if not rows: break
            values=','.join('('+','.join(map(quote,(r[0],ids[tuple(r[1:4])],*r[4:])))+')' for r in rows)
            execute('insert into housing_private.transactions(id,community_id,sale_date,area,unit_price,sale_price,listing_price,layout,rooms,orientation,floor,cycle_days,discount_rate) values '+values+' on conflict (id) do nothing;')
            count+=len(rows)
            print(f'Imported/verified {count:,} new records',flush=True)
        expected=db.execute("select count(*),min(sale_date),max(sale_date) from transactions where sale_date >= '2025-09-01'").fetchone()
        result=execute('select count(*) as count,min(sale_date)::text as first,max(sale_date)::text as last from housing_private.transactions;')[0]
        assert (result['count'],result['first'],result['last']) == expected, 'Cloud/source count or date mismatch'
        print('Private import verified:',result,flush=True)

if __name__=='__main__': main()
