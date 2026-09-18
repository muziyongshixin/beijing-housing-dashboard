import json
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

from access_control import AccessStore, RateLimiter
from analytics import AnalyticsService
from app import DashboardHandler
from public_data import build_free_snapshot


class AccessStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 1000
        self.store = AccessStore(Path(self.temp.name) / "access.sqlite3", session_seconds=60, clock=lambda: self.now)

    def tearDown(self):
        self.temp.cleanup()

    def test_token_session_expiry_revoke_and_hashes(self):
        token = self.store.issue("test", 1)
        self.assertIsNone(self.store.exchange("invalid"))
        session = self.store.exchange(token["token"])
        self.assertTrue(self.store.resolve(session["session"]))
        self.assertNotIn(token["token"].encode(), self.store.path.read_bytes())
        self.assertNotIn(session["session"].encode(), self.store.path.read_bytes())
        self.now += 61
        self.assertIsNone(self.store.resolve(session["session"]))
        session = self.store.exchange(token["token"])
        self.store.revoke(token["id"])
        self.assertIsNone(self.store.resolve(session["session"]))
        self.assertIsNone(self.store.exchange(token["token"]))
        short = self.store.issue("short", .001)
        self.now += 100
        self.assertIsNone(self.store.exchange(short["token"]))

    def test_one_session_and_logout(self):
        token = self.store.issue("test")
        first = self.store.exchange(token["token"])
        second = self.store.exchange(token["token"])
        self.assertIsNone(self.store.resolve(first["session"]))
        self.store.logout(second["session"])
        self.assertIsNone(self.store.resolve(second["session"]))

    def test_two_unique_trials_atomic(self):
        visitor = self.store.new_visitor()
        communities = [{"district":"朝阳", "business_area":"测试", "community":str(i)} for i in range(12)]
        with ThreadPoolExecutor(max_workers=12) as executor:
            results = list(executor.map(lambda c: self.store.claim_trial(visitor, c), communities))
        self.assertEqual(sum(results), 2)
        unlocked = self.store.trials(visitor)
        self.assertTrue(self.store.claim_trial(visitor, unlocked[0]))
        self.assertEqual(len(self.store.trials(visitor)), 2)
        self.assertFalse(self.store.claim_trial("forged-visitor", communities[0]))

    def test_rate_limiter(self):
        limiter = RateLimiter(clock=lambda:self.now)
        self.assertTrue(limiter.allow("a", 1))
        self.assertFalse(limiter.allow("a", 1))
        self.now += 61
        self.assertTrue(limiter.allow("a", 1))


class HTTPAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        cls.db = root / "transactions.sqlite3"
        with sqlite3.connect(cls.db) as db:
            db.execute("""CREATE TABLE transactions (id INTEGER PRIMARY KEY, sale_date TEXT, sale_month TEXT,
                district TEXT,business_area TEXT,community TEXT,layout TEXT,rooms TEXT,orientation TEXT,floor TEXT,
                area REAL,listing_price REAL,sale_price REAL,unit_price REAL,cycle_days INTEGER,discount_rate REAL,
                url TEXT,source_name TEXT,source_record_id TEXT,location_confidence TEXT)""")
            for name in ("甲", "乙", "丙"):
                for day in ("2025-07-31", "2025-08-31", "2025-09-01", "2026-08-29"):
                    db.execute("INSERT INTO transactions VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (day,day[:7],"朝阳","测试",name,"2室","2室","南","中",80,500,450,56250,30,-.1,"","测试",name+day,"高"))
        meta = root / "meta.json"
        meta.write_text(json.dumps({"date_min":"2025-07-31","date_max":"2026-08-29","default_end_month":"2026-08","source":{"secret":"private-source"},"cleaning":{"kept_rows":12}}))
        cls.free_db, cls.free_meta = build_free_snapshot(cls.db, root / "free")
        cls.store = AccessStore(root / "auth.sqlite3")
        class Handler(DashboardHandler):
            service = AnalyticsService(cls.db, meta)
            free_service = AnalyticsService(cls.free_db, cls.free_meta)
            access_store = cls.store
            legacy_access = True  # Exercise deprecated helpers; production main never enables these.
            limiter = RateLimiter()
            def log_message(self, *args): pass
        cls.server = ThreadingHTTPServer(("127.0.0.1",0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.temp.cleanup()

    def setUp(self):
        self.cookies = {}

    def test_optional_analytics_asset_is_served_but_private_paths_stay_blocked(self):
        conn = HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            conn.request("GET", "/analytics.js")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn(b"DASHBOARD_STATIC_BUILD", response.read())
            conn.request("GET", "/../config/amap.local.json")
            response = conn.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
        finally:
            conn.close()

    def test_admin_shell_assets_are_public_but_have_no_private_content_or_tracking(self):
        for path in ('/admin.html','/admin.js','/admin.css'):
            conn=HTTPConnection("127.0.0.1",self.server.server_port)
            try:
                conn.request('GET',path)
                response=conn.getresponse(); body=response.read()
                self.assertEqual(response.status,200)
                self.assertNotIn(b'sb_secret_',body)
                self.assertNotIn(b'@qq.com',body)
                if path=='/admin.html':
                    self.assertIn(b'id="adminPanel" hidden',body)
                    self.assertNotIn(b'analytics.js',body)
            finally: conn.close()

    def test_loopback_owner_can_save_coordinates_but_public_visitors_cannot(self):
        item = dict(key='朝阳|测试|甲',district='朝阳',business_area='测试',community='甲',
                    name='甲',lng=116.4,lat=39.9)
        with patch('app.save_community_location',return_value=item) as save:
            status, data = self.request('/api/community-location',item)
            self.assertEqual(status,200);self.assertTrue(data['saved']);save.assert_called_once()
        with patch.object(self.server.RequestHandlerClass,'public_origin','https://housing.example'), patch('app.save_community_location') as save:
            status, data = self.request('/api/community-location',item,{'Origin':'https://housing.example'})
            self.assertEqual(status,200);self.assertFalse(data['saved']);save.assert_not_called()
        status,_ = self.request('/api/community-location',item,{'Origin':'https://evil.example'})
        self.assertEqual(status,403)

    def test_location_cache_rejects_unknown_community(self):
        status,_=self.request('/api/community-location',dict(key='朝阳|测试|不存在',district='朝阳',business_area='测试',community='不存在',status='not_found'))
        self.assertEqual(status,404)

    def request(self, path, payload=None, extra_headers=None):
        conn = HTTPConnection("127.0.0.1", self.server.server_port)
        headers = {"Cookie":"; ".join(f"{k}={v}" for k,v in self.cookies.items())}
        if payload is not None: headers["Content-Type"] = "application/json"
        headers.update(extra_headers or {})
        conn.request("POST" if payload is not None else "GET", path, json.dumps(payload) if payload is not None else None, headers)
        response = conn.getresponse()
        for key,value in response.getheaders():
            if key.lower() == "set-cookie":
                name,val = value.split(";",1)[0].split("=",1); self.cookies[name]=val
        data = response.read()
        status = response.status
        conn.close()
        return status, json.loads(data)

    def detail_path(self, name):
        return "/api/community?" + urlencode({"district":"朝阳","business_area":"测试","community":name})

    def test_date_snapshot_and_bypass(self):
        with sqlite3.connect(self.free_db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*),MAX(sale_date) FROM transactions").fetchone(), (6,"2025-08-31"))
        self.assertNotIn(b"2026-08-29", self.free_db.read_bytes())
        status, meta = self.request("/api/meta")
        self.assertEqual(status,200); self.assertEqual(meta["date_max"],"2025-08-31")
        self.assertNotIn("source",meta)
        for endpoint in ("analyze","trend","community-heatmap"):
            status,result = self.request(f"/api/{endpoint}?end_month=2025-09")
            self.assertEqual(status,403)
        self.assertEqual(self.request("/api/analyze?end_month=2025-08&base_end=2026-08")[0],403)
        for path in ("/data/transactions.sqlite3","/../.private/access.sqlite3","/config/amap.local.json","/pages-data.js"):
            self.assertEqual(self.request(path)[0],404)

    def test_trial_search_and_third_locked(self):
        self.request("/api/access")
        status, detail = self.request(self.detail_path("甲"))
        self.assertEqual(status,200)
        self.assertEqual(detail["summary"]["last_date"],"2025-08-31")
        for name in ("甲","甲","乙"):
            status,result = self.request("/api/access/trial", {"district":"朝阳","business_area":"测试","community":name})
            self.assertEqual(status,200)
            status, detail = self.request(self.detail_path(name))
            self.assertEqual(status,200); self.assertEqual(detail["summary"]["last_date"],"2026-08-29")
        self.assertEqual(self.request("/api/access")[1]["trial_used"],2)
        self.assertEqual(self.request("/api/access/trial", {"district":"朝阳","business_area":"测试","community":"丙"})[0],402)
        self.assertEqual(self.request(self.detail_path("丙"))[1]["summary"]["last_date"],"2025-08-31")
        self.assertEqual(self.request("/api/meta")[1]["date_max"],"2025-08-31")
        status,result=self.request("/api/communities?"+urlencode({"q":"丙"}))
        self.assertEqual(result["results"][0]["transaction_count"],2)
        self.assertEqual(result["results"][0]["last_date"],"2025-08-31")

    def test_paid_free_cache_separation_revoke_csrf(self):
        self.request("/api/access")
        issued=self.store.issue("HTTP test")
        self.assertEqual(self.request("/api/access/unlock", {"token":issued["token"]}, {"Origin":"https://evil.example"})[0],403)
        self.assertEqual(self.request("/api/access/unlock", {"token":"invalid"})[0],401)
        self.assertEqual(self.request("/api/access/unlock", {"token":issued["token"]})[0],200)
        self.assertEqual(self.request("/api/meta")[1]["date_max"],"2026-08-29")
        self.assertEqual(self.request(self.detail_path("丙"))[0],200)
        self.store.revoke(issued["id"])
        self.assertEqual(self.request("/api/meta")[1]["date_max"],"2025-08-31")
        self.assertEqual(self.request(self.detail_path("丙"))[1]["summary"]["last_date"],"2025-08-31")
        self.assertEqual(self.request("/api/access/logout", {})[0],200)
        self.assertEqual(self.request("/api/access")[1]["tier"],"free")

    def test_production_mode_never_grants_legacy_visitor_or_token_access(self):
        handler = self.server.RequestHandlerClass
        handler.legacy_access = False
        try:
            issued = self.store.issue("disabled legacy test")
            old_session = self.store.exchange(issued["token"])
            from access_control import COOKIE_NAME, VISITOR_COOKIE
            self.cookies[COOKIE_NAME] = old_session["session"]
            status, state = self.request("/api/access")
            self.assertEqual(status,200)
            self.assertFalse(state["authentication_available"])
            self.assertEqual(state["tier"],"free")
            self.assertNotIn(VISITOR_COOKIE,self.cookies)
            for name in ("甲","乙","丙"):
                detail = self.request(self.detail_path(name))[1]
                self.assertEqual(detail["summary"]["last_date"],"2025-08-31")
                self.assertTrue(all(x["sale_date"] <= "2025-08-31" for x in detail["transactions"]))
            self.assertEqual(self.request("/api/access/trial", {"district":"朝阳","business_area":"测试","community":"甲"})[0],503)
            self.assertEqual(self.request("/api/access/unlock", {"token":issued["token"]})[0],503)
            self.assertEqual(self.request("/api/access")[1]["trial_used"],0)
        finally:
            handler.legacy_access = True


if __name__ == "__main__": unittest.main()
