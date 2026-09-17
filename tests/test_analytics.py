import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from analytics import AnalyticsService, QueryConfig, last_complete_month, metric_value, month_shift
from app import DashboardHandler, load_amap_config, load_community_locations, save_community_location
from scripts.build_database import declared_complete_month
import pandas as pd


class DateMathTests(unittest.TestCase):
    def test_month_shift_crosses_year(self):
        self.assertEqual(month_shift("2025-01", -1), "2024-12")
        self.assertEqual(month_shift("2024-12", 2), "2025-02")

    def test_last_complete_month(self):
        self.assertEqual(last_complete_month("2025-08-01"), "2025-07")
        self.assertEqual(last_complete_month("2024-02-29"), "2024-02")

    def test_enhanced_delivery_declares_august_complete(self):
        path = Path("北京成交数据_2018-2026地理增强完整版.csv.gz")
        self.assertEqual(declared_complete_month(path, "2026-08-29"), "2026-08")

    def test_query_config_uses_declared_complete_month(self):
        config = QueryConfig.from_params({}, {
            "date_min": "2018-04-04",
            "date_max": "2026-08-29",
            "default_end_month": "2026-08",
        })
        self.assertEqual(config.end_month, "2026-08")
        self.assertEqual(config.current_start, "2026-03")

    def test_metrics(self):
        values = pd.Series([1, 2, 3, 4, 5])
        self.assertEqual(metric_value(values, "median"), 3)
        self.assertEqual(metric_value(values, "mean"), 3)
        self.assertAlmostEqual(metric_value(values, "p30"), 2.2)
        self.assertAlmostEqual(metric_value(values, "p60"), 3.4)


class AnalyticsIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.db = root / "test.sqlite3"
        self.meta = root / "meta.json"
        connection = sqlite3.connect(self.db)
        connection.execute("""CREATE TABLE transactions (
            id INTEGER PRIMARY KEY, sale_date TEXT, sale_month TEXT, district TEXT,
            business_area TEXT, community TEXT, layout TEXT, rooms TEXT, orientation TEXT,
            floor TEXT, area REAL, listing_price REAL, sale_price REAL, unit_price REAL,
            cycle_days INTEGER, discount_rate REAL, url TEXT,
            source_name TEXT DEFAULT '测试来源', source_record_id TEXT,
            merge_status TEXT, area_fill_method TEXT DEFAULT '来源原值',
            business_fill_method TEXT DEFAULT '来源原值', location_confidence TEXT DEFAULT '来源原值')""")
        rows = []
        for month, base in [("2024-01", 100), ("2024-02", 100), ("2024-03", 100), ("2024-04", 90), ("2024-05", 90), ("2024-06", 90)]:
            for index in range(5):
                rows.append((month + "-01", month, "朝阳", "测试商圈", "甲小区", "2室1厅", "2室", "南", "中层", 80, 100, 90, base + index, 50, -.1, f"u-{month}-{index}"))
        rows.extend([
            ("2024-02-10", "2024-02", "海淀", "清河", "阳光南里", "2室1厅", "2室", "南", "中层", 73.6, 480, 460, 62500, 30, -.04, "sun-1"),
            ("2024-05-12", "2024-05", "海淀", "清河", "阳光南里", "2室1厅", "2室", "南", "高层", 73.6, None, 448, 60870, 45, -.05, "sun-2"),
        ])
        connection.executemany("INSERT INTO transactions (sale_date,sale_month,district,business_area,community,layout,rooms,orientation,floor,area,listing_price,sale_price,unit_price,cycle_days,discount_rate,url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        connection.commit()
        connection.close()
        self.meta.write_text(json.dumps({"date_min":"2024-01-01","date_max":"2024-06-30","cleaning":{},"source":{}}, ensure_ascii=False), encoding="utf-8")
        self.service = AnalyticsService(self.db, self.meta)

    def tearDown(self):
        self.temp.cleanup()

    def test_adjacent_windows_and_threshold(self):
        result = self.service.analyze("end_month=2024-06&window=3&level=community&min_current=10&min_base=10&min_total=20&min_active_months=3")
        self.assertEqual(result["config"]["current_start"], "2024-04")
        self.assertEqual(result["config"]["base_start"], "2024-01")
        self.assertEqual(result["summary"]["eligible_count"], 1)
        self.assertLess(result["rows"][0]["price_change"], 0)

    def test_threshold_removes_result(self):
        result = self.service.analyze("end_month=2024-06&window=3&level=community&min_current=16&min_base=10&min_total=20&min_active_months=3")
        self.assertEqual(result["summary"]["eligible_count"], 0)

    def test_community_heatmap_always_uses_community_dimension(self):
        result = self.service.community_heatmap(
            "end_month=2024-06&window=3&level=district&min_current=10&min_base=10&min_total=20&min_active_months=3"
        )
        self.assertEqual(result["summary"]["eligible_count"], 1)
        self.assertEqual(result["rows"][0]["community"], "甲小区")
        self.assertLess(result["rows"][0]["price_change"], 0)

    def test_community_search_is_independent_from_ranking_thresholds(self):
        search = self.service.search_communities("q=阳光南里")
        self.assertEqual(len(search["results"]), 1)
        self.assertEqual(search["results"][0]["community"], "阳光南里")
        self.assertEqual(search["results"][0]["transaction_count"], 2)

        ranked = self.service.analyze(
            "end_month=2024-06&window=3&level=community&min_current=10&min_base=10&min_total=25&min_active_months=3"
        )
        self.assertNotIn("阳光南里", [row.get("community") for row in ranked["rows"]])

    def test_community_detail_returns_complete_history(self):
        detail = self.service.community_detail(
            "district=海淀&business_area=清河&community=阳光南里&end_month=2024-06&window=3&metric=median"
        )
        self.assertEqual(detail["summary"]["transaction_count"], 2)
        self.assertEqual(len(detail["transactions"]), 2)
        self.assertEqual(len(detail["monthly"]), 4)
        self.assertEqual(sum(point["volume"] for point in detail["monthly"]), 2)
        self.assertEqual(detail["summary"]["current_volume"], 1)
        self.assertEqual(detail["summary"]["base_volume"], 1)

    def test_community_detail_returns_rolling_listing_unit_price(self):
        detail = self.service.community_detail(
            "district=海淀&business_area=清河&community=阳光南里&end_month=2024-06&window=3&metric=median"
        )
        february = next(point for point in detail["rolling"] if point["month"] == "2024-02")
        may = next(point for point in detail["rolling"] if point["month"] == "2024-05")
        self.assertAlmostEqual(february["listing_price"], 480 * 10000 / 73.6, places=5)
        self.assertEqual(february["listing_sample_count"], 1)
        self.assertIsNone(may["listing_price"])
        self.assertEqual(may["listing_sample_count"], 0)
        self.assertIsNone(detail["transactions"][0]["listing_unit_price"])
        self.assertAlmostEqual(detail["transactions"][1]["listing_unit_price"], 480 * 10000 / 73.6, places=5)

    def test_trend_separates_monthly_volume_from_window_sample_count(self):
        trend = self.service.trend(
            "end_month=2024-06&window=3&district=海淀&trend_level=community&trend_name=阳光南里"
        )
        may = next(point for point in trend["points"] if point["month"] == "2024-05")
        june = next(point for point in trend["points"] if point["month"] == "2024-06")
        self.assertEqual(may["volume"], 1)
        self.assertEqual(may["window_volume"], 1)
        self.assertEqual(june["volume"], 0)
        self.assertEqual(june["window_volume"], 1)


class MapConfigurationTests(unittest.TestCase):
    def test_map_configuration_defaults_to_disabled(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            key, security_code = load_amap_config(Path(tmp) / "missing.json")
        self.assertEqual(key, "")
        self.assertEqual(security_code, "")

    def test_map_configuration_loads_gitignored_local_file(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            path = Path(tmp) / "amap.local.json"
            path.write_text(json.dumps({
                "amap_js_key": "local-key",
                "amap_security_code": "local-secret",
            }), encoding="utf-8")
            key, security_code = load_amap_config(path)
        self.assertEqual(key, "local-key")
        self.assertEqual(security_code, "local-secret")

    def test_map_environment_variables_override_local_file(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            "AMAP_JS_KEY": "environment-key",
            "AMAP_SECURITY_CODE": "environment-secret",
        }, clear=True):
            path = Path(tmp) / "amap.local.json"
            path.write_text(json.dumps({
                "amap_js_key": "local-key",
                "amap_security_code": "local-secret",
            }), encoding="utf-8")
            key, security_code = load_amap_config(path)
        self.assertEqual(key, "environment-key")
        self.assertEqual(security_code, "environment-secret")

    def test_handler_has_separate_public_key_and_private_security_code(self):
        self.assertTrue(hasattr(DashboardHandler, "amap_js_key"))
        self.assertTrue(hasattr(DashboardHandler, "amap_security_code"))

    def test_community_location_cache_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "locations.json"
            saved = save_community_location({
                "key": "海淀|清河|阳光南里",
                "district": "海淀", "business_area": "清河", "community": "阳光南里",
                "name": "阳光南里", "address": "北京市海淀区清河",
                "lng": 116.338928, "lat": 40.033316,
            }, path)
            values = load_community_locations(path)
        self.assertEqual(saved["community"], "阳光南里")
        self.assertAlmostEqual(values["海淀|清河|阳光南里"]["lng"], 116.338928)


if __name__ == "__main__":
    unittest.main()
