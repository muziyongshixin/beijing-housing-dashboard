from __future__ import annotations

import calendar
import json
import math
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "data" / "transactions.sqlite3"
LOCAL_META_FILE = ROOT / "data" / "build_meta.local.json"
META_FILE = LOCAL_META_FILE if LOCAL_META_FILE.exists() else ROOT / "data" / "build_meta.json"

DISTRICT_ALIASES = {"北京经济技术开发区": "大兴"}
ALLOWED_METRICS = {"median", "mean", "p30", "p60", "min", "max"}
ALLOWED_LEVELS = {"district", "community"}
ROOM_OPTIONS = {"全部", "1室", "2室", "3室", "4室及以上", "开间", "其他"}


def month_shift(month: str, delta: int) -> str:
    year, mon = map(int, month.split("-"))
    absolute = year * 12 + mon - 1 + delta
    return f"{absolute // 12:04d}-{absolute % 12 + 1:02d}"


def month_range(start: str, end: str) -> list[str]:
    result = []
    current = start
    while current <= end:
        result.append(current)
        current = month_shift(current, 1)
    return result


def last_complete_month(max_date: str) -> str:
    parsed = date.fromisoformat(max_date)
    last_day = calendar.monthrange(parsed.year, parsed.month)[1]
    return f"{parsed.year:04d}-{parsed.month:02d}" if parsed.day == last_day else month_shift(f"{parsed.year:04d}-{parsed.month:02d}", -1)


def metric_value(series: pd.Series, metric: str) -> float:
    values = series.dropna().to_numpy(dtype=float)
    if not len(values):
        return math.nan
    if metric == "mean":
        return float(np.mean(values))
    if metric == "p30":
        return float(np.percentile(values, 30))
    if metric == "p60":
        return float(np.percentile(values, 60))
    if metric == "min":
        return float(np.min(values))
    if metric == "max":
        return float(np.max(values))
    return float(np.median(values))


def get_text(params: dict, key: str, default: str = "") -> str:
    value = params.get(key, [default])
    return str(value[0] if isinstance(value, list) else value).strip()


def get_int(params: dict, key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(get_text(params, key, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def get_float(params: dict, key: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(get_text(params, key, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


@dataclass(frozen=True)
class QueryConfig:
    end_month: str
    window: int
    compare: str
    base_start: str
    base_end: str
    current_start: str
    current_end: str
    metric: str
    level: str
    district: str
    business_area: str
    rooms: str
    area_min: float
    area_max: float
    min_current: int
    min_base: int
    min_total: int
    min_active_months: int
    sort: str
    direction: str
    limit: int

    @classmethod
    def from_params(cls, params: dict, meta: dict) -> "QueryConfig":
        for key in ("end_month", "base_start", "base_end"):
            value = get_text(params, key)
            if value:
                try:
                    parsed = date.fromisoformat(value + "-01")
                    if parsed.strftime("%Y-%m") != value:
                        raise ValueError()
                except ValueError:
                    raise ValueError("月份格式必须为 YYYY-MM") from None
                if value > meta["date_max"][:7]:
                    raise PermissionError("所选月份超出当前权限可查看的数据范围，请先解锁新数据")
        end_month = get_text(params, "end_month", meta.get("default_end_month") or last_complete_month(meta["date_max"]))
        window = get_int(params, "window", 6, 1, 24)
        compare = get_text(params, "compare", "adjacent")
        if compare not in {"adjacent", "yoy", "custom"}:
            compare = "adjacent"
        current_end = end_month
        current_start = month_shift(current_end, -(window - 1))
        if compare == "yoy":
            base_end = month_shift(current_end, -12)
            base_start = month_shift(current_start, -12)
        elif compare == "custom":
            base_start = get_text(params, "base_start", month_shift(current_start, -window))
            base_end = get_text(params, "base_end", month_shift(current_start, -1))
            if base_start > base_end:
                base_start, base_end = base_end, base_start
        else:
            base_end = month_shift(current_start, -1)
            base_start = month_shift(base_end, -(window - 1))
        metric = get_text(params, "metric", "median")
        level = get_text(params, "level", "district")
        rooms = get_text(params, "rooms", "全部")
        return cls(
            end_month=end_month,
            window=window,
            compare=compare,
            base_start=base_start,
            base_end=base_end,
            current_start=current_start,
            current_end=current_end,
            metric=metric if metric in ALLOWED_METRICS else "median",
            level=level if level in ALLOWED_LEVELS else "district",
            district=get_text(params, "district", "全部"),
            business_area=get_text(params, "business_area", "全部"),
            rooms=rooms if rooms in ROOM_OPTIONS else "全部",
            area_min=get_float(params, "area_min", 10, 10, 500),
            area_max=get_float(params, "area_max", 500, 10, 500),
            min_current=get_int(params, "min_current", 10, 0, 10000),
            min_base=get_int(params, "min_base", 10, 0, 10000),
            min_total=get_int(params, "min_total", 25, 0, 20000),
            min_active_months=get_int(params, "min_active_months", 3, 0, 24),
            sort=get_text(params, "sort", "price_change"),
            direction=get_text(params, "direction", "asc"),
            limit=get_int(params, "limit", 100, 10, 500),
        )


class ResultCache:
    def __init__(self, max_size: int = 64):
        self.max_size = max_size
        self.values: OrderedDict[str, dict] = OrderedDict()
        self.lock = Lock()

    def get(self, key: str):
        with self.lock:
            if key not in self.values:
                return None
            self.values.move_to_end(key)
            return self.values[key]

    def put(self, key: str, value: dict):
        with self.lock:
            self.values[key] = value
            self.values.move_to_end(key)
            while len(self.values) > self.max_size:
                self.values.popitem(last=False)


class AnalyticsService:
    def __init__(self, database: Path = DATABASE, meta_file: Path = META_FILE):
        self.database = Path(database)
        self.meta = json.loads(Path(meta_file).read_text(encoding="utf-8"))
        self.cache = ResultCache()

    def connect(self):
        connection = sqlite3.connect(f"file:{self.database}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        return connection

    def metadata(self) -> dict:
        cached = self.cache.get("meta")
        if cached:
            return cached
        with self.connect() as conn:
            districts = [row[0] for row in conn.execute("SELECT district FROM transactions GROUP BY district ORDER BY district")]
            business = {}
            for district, name in conn.execute("SELECT district, business_area FROM transactions GROUP BY district, business_area ORDER BY district, business_area"):
                business.setdefault(district, []).append(name)
            rooms = [row[0] for row in conn.execute("SELECT rooms FROM transactions GROUP BY rooms ORDER BY rooms")]
        result = {
            **self.meta,
            "default_end_month": self.meta.get("default_end_month") or last_complete_month(self.meta["date_max"]),
            "min_month": self.meta["date_min"][:7],
            "max_month": self.meta["date_max"][:7],
            "districts": districts,
            "business_areas": business,
            "rooms": rooms,
        }
        self.cache.put("meta", result)
        return result

    def search_communities(self, raw_query: str | dict) -> dict:
        params = parse_qs(raw_query) if isinstance(raw_query, str) else raw_query
        query_text = get_text(params, "q").strip()
        limit = get_int(params, "limit", 12, 1, 30)
        if not query_text:
            return {"query": "", "results": []}
        escaped = query_text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        contains = f"%{escaped}%"
        prefix = f"{escaped}%"
        sql = """
            SELECT district, business_area, community, COUNT(*) AS transaction_count,
                   MIN(sale_date) AS first_date, MAX(sale_date) AS last_date
            FROM transactions
            WHERE community LIKE ? ESCAPE '\\'
            GROUP BY district, business_area, community
            ORDER BY CASE WHEN community = ? THEN 0 WHEN community LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                     transaction_count DESC, last_date DESC
            LIMIT ?
        """
        with self.connect() as conn:
            rows = conn.execute(sql, (contains, query_text, prefix, limit)).fetchall()
        return {
            "query": query_text,
            "results": [
                {
                    "district": row["district"],
                    "business_area": row["business_area"],
                    "community": row["community"],
                    "transaction_count": int(row["transaction_count"]),
                    "first_date": row["first_date"],
                    "last_date": row["last_date"],
                }
                for row in rows
            ],
        }

    def community_detail(self, raw_query: str | dict) -> dict:
        params = parse_qs(raw_query) if isinstance(raw_query, str) else raw_query
        district = get_text(params, "district")
        business_area = get_text(params, "business_area")
        community = get_text(params, "community")
        if not district or not business_area or not community:
            raise ValueError("缺少小区定位信息")
        config = QueryConfig.from_params(params, self.meta)
        key = "community:" + json.dumps({
            "district": district, "business_area": business_area, "community": community,
            "end_month": config.end_month, "window": config.window, "compare": config.compare,
            "base_start": config.base_start, "base_end": config.base_end, "metric": config.metric,
        }, sort_keys=True, ensure_ascii=False)
        cached = self.cache.get(key)
        if cached:
            return cached
        sql = """
            SELECT sale_date, sale_month, layout, rooms, orientation, floor, area,
                   listing_price, sale_price, unit_price, cycle_days, discount_rate, url,
                   source_name, source_record_id, location_confidence
            FROM transactions
            WHERE district = ? AND business_area = ? AND community = ?
            ORDER BY sale_date ASC, id ASC
        """
        with self.connect() as conn:
            frame = pd.read_sql_query(sql, conn, params=[district, business_area, community])
        if frame.empty:
            raise ValueError("未找到该小区的成交记录")
        valid_listing = (frame["listing_price"] > 0) & (frame["area"] > 0)
        frame["listing_unit_price"] = np.where(
            valid_listing,
            frame["listing_price"] * 10000 / frame["area"],
            np.nan,
        )

        monthly = []
        rolling = []
        for month in month_range(frame["sale_month"].min(), frame["sale_month"].max()):
            month_sample = frame[frame["sale_month"] == month]
            monthly.append({
                "month": month,
                "volume": int(len(month_sample)),
                "median_price": self._json_number(month_sample["unit_price"].median()) if not month_sample.empty else None,
                "mean_price": self._json_number(month_sample["unit_price"].mean()) if not month_sample.empty else None,
                "median_area": self._json_number(month_sample["area"].median()) if not month_sample.empty else None,
            })
            window_start = month_shift(month, -(config.window - 1))
            rolling_sample = frame[(frame["sale_month"] >= window_start) & (frame["sale_month"] <= month)]
            listing_sample = rolling_sample[rolling_sample["listing_unit_price"].notna()]
            rolling.append({
                "month": month,
                "price": self._json_number(metric_value(rolling_sample["unit_price"], config.metric)) if not rolling_sample.empty else None,
                "listing_price": self._json_number(metric_value(listing_sample["listing_unit_price"], config.metric)) if not listing_sample.empty else None,
                "sample_count": int(len(rolling_sample)),
                "listing_sample_count": int(len(listing_sample)),
            })

        current = frame[(frame["sale_month"] >= config.current_start) & (frame["sale_month"] <= config.current_end)]
        base = frame[(frame["sale_month"] >= config.base_start) & (frame["sale_month"] <= config.base_end)]
        current_price = metric_value(current["unit_price"], config.metric) if not current.empty else math.nan
        base_price = metric_value(base["unit_price"], config.metric) if not base.empty else math.nan
        result = {
            "community": community,
            "district": district,
            "business_area": business_area,
            "config": config.__dict__,
            "summary": {
                "transaction_count": int(len(frame)),
                "first_date": frame["sale_date"].min(),
                "last_date": frame["sale_date"].max(),
                "overall_median_price": self._json_number(frame["unit_price"].median()),
                "overall_median_area": self._json_number(frame["area"].median()),
                "average_monthly_volume": self._json_number(len(frame) / max(1, frame["sale_month"].nunique())),
                "current_price": self._json_number(current_price),
                "base_price": self._json_number(base_price),
                "price_change": self._json_number(self._safe_change(current_price, base_price)),
                "current_volume": int(len(current)),
                "base_volume": int(len(base)),
                "current_monthly_average": self._json_number(len(current) / max(1, len(month_range(config.current_start, config.current_end)))),
                "base_monthly_average": self._json_number(len(base) / max(1, len(month_range(config.base_start, config.base_end)))),
            },
            "monthly": monthly,
            "rolling": rolling,
            "transactions": [
                {
                    "sale_date": row.sale_date, "layout": row.layout, "orientation": row.orientation,
                    "floor": row.floor, "area": self._json_number(row.area),
                    "listing_price": self._json_number(row.listing_price), "sale_price": self._json_number(row.sale_price),
                    "listing_unit_price": self._json_number(row.listing_unit_price),
                    "unit_price": self._json_number(row.unit_price),
                    "cycle_days": int(row.cycle_days) if pd.notna(row.cycle_days) else None,
                    "discount_rate": self._json_number(row.discount_rate), "url": row.url,
                    "source_name": row.source_name, "source_record_id": row.source_record_id,
                    "location_confidence": row.location_confidence,
                }
                for row in frame.sort_values("sale_date", ascending=False).itertuples(index=False)
            ],
        }
        self.cache.put(key, result)
        return result

    def _where(self, config: QueryConfig, start: str, end: str, include_location=True):
        clauses = ["sale_month BETWEEN ? AND ?", "area BETWEEN ? AND ?"]
        args: list = [start, end, min(config.area_min, config.area_max), max(config.area_min, config.area_max)]
        if include_location and config.district != "全部":
            clauses.append("district = ?")
            args.append(config.district)
        if include_location and config.business_area != "全部":
            clauses.append("business_area = ?")
            args.append(config.business_area)
        if config.rooms != "全部":
            clauses.append("rooms = ?")
            args.append(config.rooms)
        return " AND ".join(clauses), args

    def _load_period(self, config: QueryConfig, start: str, end: str, include_location=True) -> pd.DataFrame:
        where, args = self._where(config, start, end, include_location)
        query = f"""
            SELECT sale_month, district, business_area, community, unit_price, area,
                   cycle_days, discount_rate
            FROM transactions WHERE {where}
        """
        with self.connect() as conn:
            frame = pd.read_sql_query(query, conn, params=args)
        if not frame.empty:
            frame["map_district"] = frame["district"].replace(DISTRICT_ALIASES)
        return frame

    def _aggregate(self, frame: pd.DataFrame, group_cols: list[str], metric: str, prefix: str) -> pd.DataFrame:
        output_cols = group_cols + [
            f"{prefix}_price", f"{prefix}_volume", f"{prefix}_months", f"{prefix}_area",
            f"{prefix}_cycle", f"{prefix}_discount",
        ]
        if frame.empty:
            return pd.DataFrame(columns=output_cols)

        def summarize(group):
            return pd.Series({
                f"{prefix}_price": metric_value(group["unit_price"], metric),
                f"{prefix}_volume": int(len(group)),
                f"{prefix}_months": int(group["sale_month"].nunique()),
                f"{prefix}_area": float(group["area"].median()),
                f"{prefix}_cycle": float(group["cycle_days"].median()) if group["cycle_days"].notna().any() else math.nan,
                f"{prefix}_discount": float(group["discount_rate"].median()) if group["discount_rate"].notna().any() else math.nan,
            })

        return frame.groupby(group_cols, dropna=False, observed=True).apply(summarize, include_groups=False).reset_index()

    @staticmethod
    def _safe_change(current, base):
        return current / base - 1 if pd.notna(current) and pd.notna(base) and base != 0 else math.nan

    def analyze(self, raw_query: str | dict) -> dict:
        params = parse_qs(raw_query) if isinstance(raw_query, str) else raw_query
        key = "analysis:" + (raw_query if isinstance(raw_query, str) else json.dumps(params, sort_keys=True, ensure_ascii=False))
        cached = self.cache.get(key)
        if cached:
            return cached
        config = QueryConfig.from_params(params, self.meta)
        current = self._load_period(config, config.current_start, config.current_end)
        base = self._load_period(config, config.base_start, config.base_end)

        benchmark_current = self._load_period(config, config.current_start, config.current_end, include_location=False)
        benchmark_base = self._load_period(config, config.base_start, config.base_end, include_location=False)
        city_current_price = metric_value(benchmark_current["unit_price"], config.metric) if not benchmark_current.empty else math.nan
        city_base_price = metric_value(benchmark_base["unit_price"], config.metric) if not benchmark_base.empty else math.nan
        city_change = self._safe_change(city_current_price, city_base_price)

        group_cols = ["district"] if config.level == "district" else ["district", "business_area", "community"]
        current_agg = self._aggregate(current, group_cols, config.metric, "current")
        base_agg = self._aggregate(base, group_cols, config.metric, "base")
        merged = current_agg.merge(base_agg, on=group_cols, how="outer")
        if merged.empty:
            rows = []
        else:
            merged["price_change"] = merged.apply(lambda r: self._safe_change(r.current_price, r.base_price), axis=1)
            merged["volume_change"] = merged.apply(lambda r: self._safe_change(r.current_volume, r.base_volume), axis=1)
            merged["area_change"] = merged.apply(lambda r: self._safe_change(r.current_area, r.base_area), axis=1)
            merged["cycle_change"] = merged.apply(lambda r: self._safe_change(r.current_cycle, r.base_cycle), axis=1)
            merged["discount_change"] = merged["current_discount"] - merged["base_discount"]
            merged["relative_beijing"] = merged["price_change"] - city_change
            merged["total_volume"] = merged["current_volume"].fillna(0) + merged["base_volume"].fillna(0)
            merged["eligible"] = (
                (merged["current_volume"].fillna(0) >= config.min_current)
                & (merged["base_volume"].fillna(0) >= config.min_base)
                & (merged["total_volume"] >= config.min_total)
                & (merged["current_months"].fillna(0) >= config.min_active_months)
                & (merged["base_months"].fillna(0) >= config.min_active_months)
                & merged["price_change"].notna()
            )
            if config.level == "district":
                community_current = self._aggregate(current, ["district", "business_area", "community"], config.metric, "current")
                community_base = self._aggregate(base, ["district", "business_area", "community"], config.metric, "base")
                community = community_current.merge(community_base, on=["district", "business_area", "community"], how="outer")
                if not community.empty:
                    community["price_change"] = community.apply(lambda r: self._safe_change(r.current_price, r.base_price), axis=1)
                    community["total_volume"] = community["current_volume"].fillna(0) + community["base_volume"].fillna(0)
                    community["eligible"] = (
                        (community["current_volume"].fillna(0) >= config.min_current)
                        & (community["base_volume"].fillna(0) >= config.min_base)
                        & (community["total_volume"] >= config.min_total)
                        & (community["current_months"].fillna(0) >= config.min_active_months)
                        & (community["base_months"].fillna(0) >= config.min_active_months)
                        & community["price_change"].notna()
                    )
                    qualified = community[community["eligible"]].copy()
                    qualified["resilient"] = qualified["price_change"] > city_change
                    resilience = qualified.groupby("district").agg(
                        resilient_ratio=("resilient", "mean"),
                        eligible_community_count=("community", "count"),
                    ).reset_index()
                    merged = merged.merge(resilience, on="district", how="left")
                else:
                    merged["resilient_ratio"] = math.nan
                    merged["eligible_community_count"] = 0
            eligible = merged[merged["eligible"]].copy()
            sort_column = config.sort if config.sort in eligible.columns else "price_change"
            ascending = config.direction != "desc"
            eligible = eligible.sort_values(sort_column, ascending=ascending, na_position="last").head(config.limit)
            rows = self._records(eligible)

        map_rows = []
        map_config = QueryConfig(**{**config.__dict__, "level": "district", "district": "全部", "business_area": "全部"})
        map_current = self._load_period(map_config, config.current_start, config.current_end)
        map_base = self._load_period(map_config, config.base_start, config.base_end)
        mc = self._aggregate(map_current, ["map_district"], config.metric, "current")
        mb = self._aggregate(map_base, ["map_district"], config.metric, "base")
        map_frame = mc.merge(mb, on="map_district", how="outer")
        if not map_frame.empty:
            map_frame["district"] = map_frame["map_district"]
            map_frame["price_change"] = map_frame.apply(lambda r: self._safe_change(r.current_price, r.base_price), axis=1)
            map_frame["total_volume"] = map_frame["current_volume"].fillna(0) + map_frame["base_volume"].fillna(0)
            map_frame["eligible"] = (
                (map_frame["current_volume"].fillna(0) >= config.min_current)
                & (map_frame["base_volume"].fillna(0) >= config.min_base)
                & (map_frame["total_volume"] >= config.min_total)
            )
        if not map_frame.empty:
            if "map_district" not in map_frame:
                map_frame["map_district"] = map_frame["district"].replace(DISTRICT_ALIASES)
            consolidated = []
            for map_name, group in map_frame.groupby("map_district"):
                consolidated.append({
                    "district": map_name,
                    "price_change": self._json_number(group["price_change"].mean()),
                    "current_volume": int(group["current_volume"].fillna(0).sum()),
                    "base_volume": int(group["base_volume"].fillna(0).sum()),
                    "eligible": bool(group["eligible"].any()),
                })
            map_rows = consolidated

        result = {
            "config": config.__dict__,
            "benchmark": {
                "current_price": self._json_number(city_current_price),
                "base_price": self._json_number(city_base_price),
                "price_change": self._json_number(city_change),
                "current_volume": int(len(benchmark_current)),
                "base_volume": int(len(benchmark_base)),
                "volume_change": self._json_number(self._safe_change(len(benchmark_current), len(benchmark_base))),
                "current_area": self._json_number(benchmark_current["area"].median() if not benchmark_current.empty else math.nan),
                "base_area": self._json_number(benchmark_base["area"].median() if not benchmark_base.empty else math.nan),
            },
            "summary": {
                "candidate_count": int(len(merged)),
                "eligible_count": int(merged["eligible"].sum()) if not merged.empty else 0,
                "returned_count": len(rows),
            },
            "rows": rows,
            "map": map_rows,
        }
        self.cache.put(key, result)
        return result

    def community_heatmap(self, raw_query: str | dict) -> dict:
        params = parse_qs(raw_query) if isinstance(raw_query, str) else raw_query
        key = "community-heatmap:" + (raw_query if isinstance(raw_query, str) else json.dumps(params, sort_keys=True, ensure_ascii=False))
        cached = self.cache.get(key)
        if cached:
            return cached
        config = QueryConfig.from_params(params, self.meta)
        current = self._load_period(config, config.current_start, config.current_end)
        base = self._load_period(config, config.base_start, config.base_end)
        group_cols = ["district", "business_area", "community"]
        current_agg = self._aggregate(current, group_cols, config.metric, "current")
        base_agg = self._aggregate(base, group_cols, config.metric, "base")
        merged = current_agg.merge(base_agg, on=group_cols, how="outer")
        if merged.empty:
            eligible = merged
        else:
            merged["price_change"] = merged.apply(lambda r: self._safe_change(r.current_price, r.base_price), axis=1)
            merged["total_volume"] = merged["current_volume"].fillna(0) + merged["base_volume"].fillna(0)
            merged["eligible"] = (
                (merged["current_volume"].fillna(0) >= config.min_current)
                & (merged["base_volume"].fillna(0) >= config.min_base)
                & (merged["total_volume"] >= config.min_total)
                & (merged["current_months"].fillna(0) >= config.min_active_months)
                & (merged["base_months"].fillna(0) >= config.min_active_months)
                & merged["price_change"].notna()
            )
            eligible = merged[merged["eligible"]].sort_values(
                ["total_volume", "community"], ascending=[False, True]
            )
        keep = [
            "district", "business_area", "community", "current_price", "base_price",
            "price_change", "current_volume", "base_volume", "total_volume",
        ]
        rows = self._records(eligible[keep]) if not eligible.empty else []
        result = {
            "config": config.__dict__,
            "summary": {"eligible_count": len(rows)},
            "rows": rows,
        }
        self.cache.put(key, result)
        return result

    def trend(self, raw_query: str | dict) -> dict:
        params = parse_qs(raw_query) if isinstance(raw_query, str) else raw_query
        key = "trend:" + (raw_query if isinstance(raw_query, str) else json.dumps(params, sort_keys=True, ensure_ascii=False))
        cached = self.cache.get(key)
        if cached:
            return cached
        config = QueryConfig.from_params(params, self.meta)
        start = max(self.meta["date_min"][:7], month_shift(config.end_month, -47))
        # The first visible rolling point needs its preceding window, too.
        history_start = month_shift(start, -(config.window - 1))
        where, args = self._where(config, history_start, config.end_month)
        level = get_text(params, "trend_level", "city")
        name = get_text(params, "trend_name", "北京")
        if level == "district" and name:
            where += " AND district = ?"
            args.append(name)
        elif level == "community" and name:
            where += " AND community = ?"
            args.append(name)
        query = f"SELECT sale_month, unit_price, area FROM transactions WHERE {where}"
        with self.connect() as conn:
            frame = pd.read_sql_query(query, conn, params=args)
        points = []
        for month in month_range(start, config.end_month):
            window_start = month_shift(month, -(config.window - 1))
            sample = frame[(frame.sale_month >= window_start) & (frame.sale_month <= month)]
            month_sample = frame[frame.sale_month == month]
            points.append({
                "month": month,
                "price": self._json_number(metric_value(sample["unit_price"], config.metric)) if not sample.empty else None,
                "volume": int(len(month_sample)),
                "window_volume": int(len(sample)),
                "area": self._json_number(sample["area"].median()) if not sample.empty else None,
            })
        result = {"name": name, "level": level, "points": points}
        self.cache.put(key, result)
        return result

    @staticmethod
    def _json_number(value):
        if value is None or pd.isna(value) or math.isinf(float(value)):
            return None
        return round(float(value), 6)

    def _records(self, frame: pd.DataFrame) -> list[dict]:
        records = []
        for _, row in frame.iterrows():
            item = {}
            for key, value in row.items():
                if key == "eligible":
                    item[key] = bool(value)
                elif isinstance(value, (np.integer,)):
                    item[key] = int(value)
                elif isinstance(value, (int, str, bool)):
                    item[key] = value
                elif pd.isna(value):
                    item[key] = None
                elif isinstance(value, (float, np.floating)):
                    item[key] = round(float(value), 6)
                else:
                    item[key] = value
            records.append(item)
        return records
