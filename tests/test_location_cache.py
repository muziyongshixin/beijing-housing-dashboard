import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from app import save_community_location, load_community_locations
from scripts.export_pages_site import export_locations


class LocationCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'locations.json'
        self.item = dict(key='海淀|清河|测试', district='海淀', business_area='清河', community='测试')

    def test_negative_cache_and_valid_coordinate_preservation(self):
        r = save_community_location({**self.item, 'status': 'not_found'}, self.path)
        self.assertEqual(r['retry_after']-r['updated_at'], 7*86400000)
        point = {**self.item, 'name':'测试', 'lng':116.34, 'lat':40.03}
        save_community_location(point, self.path)
        save_community_location({**self.item, 'status':'error'}, self.path)
        self.assertEqual(load_community_locations(self.path)[self.item['key']]['lng'],116.34)

    def test_reject_bad_coordinates_and_mismatched_key(self):
        for patch in [{'lng':0}, {'lat':float('nan')}, {'key':'伪造'}]:
            with self.assertRaises(ValueError):
                save_community_location({**self.item, 'name':'测试', 'lng':116.34, 'lat':40.03, **patch}, self.path)

    def test_public_snapshot_contains_only_free_community_coordinates(self):
        values={'one':{**self.item, 'name':'测试', 'lng':116.34, 'lat':40.03,'unit_price':999999},
                'two':{**self.item, 'community':'仅新数据', 'name':'仅新数据','lng':116.35,'lat':40.04}}
        self.path.write_text(json.dumps(values))
        with sqlite3.connect(':memory:') as db:
            db.execute('create table transactions(district text,business_area text,community text)')
            db.execute('insert into transactions values(?,?,?)',('海淀','清河','测试'))
            dest=Path(self.temp.name)/'export.json';export_locations(db,dest,self.path)
        out=json.loads(dest.read_text())['locations']
        self.assertEqual(list(out),[self.item['key']]);self.assertNotIn('unit_price',out[self.item['key']])
