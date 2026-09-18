#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import math
import os
import sys
import tempfile
import threading
import time
import webbrowser
from http.cookies import SimpleCookie, CookieError
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse
from urllib.request import Request, urlopen

from scripts.build_database import build
from access_control import AccessStore, RateLimiter, COOKIE_NAME, VISITOR_COOKIE, TRIAL_LIMIT, FREE_THROUGH, PAID_FROM
from public_data import build_free_snapshot


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
AMAP_SERVICE_PREFIX = "/_AMapService"
LOCAL_AMAP_CONFIG = ROOT / "config" / "amap.local.json"
LOCAL_COMMUNITY_LOCATIONS = ROOT / "data" / "community_locations.local.json"
LOCATION_CACHE_LOCK = threading.Lock()


def load_amap_config(config_path=None):
    path = Path(config_path) if config_path else LOCAL_AMAP_CONFIG
    local = {}
    if path.exists():
        try:
            local = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"无法读取高德地图本地配置：{path}（{exc}）") from exc
    key = os.environ.get("AMAP_JS_KEY", "").strip() or str(local.get("amap_js_key", "")).strip()
    security_code = os.environ.get("AMAP_SECURITY_CODE", "").strip() or str(local.get("amap_security_code", "")).strip()
    return key, security_code


def load_community_locations(path=LOCAL_COMMUNITY_LOCATIONS):
    path = Path(path)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def save_community_location(item, path=LOCAL_COMMUNITY_LOCATIONS):
    status = item.get("status", "located")
    if status not in ("located", "not_found", "error"):
        raise ValueError("无效的定位状态")
    required = ["key", "district", "business_area", "community"]
    if status == "located":
        required += ["name", "lng", "lat"]
    if any(item.get(field) in (None, "") for field in required):
        raise ValueError("小区坐标信息不完整")
    cache_key = "|".join(str(item[x]) for x in ("district", "business_area", "community"))
    if item["key"] != cache_key or any(len(str(item.get(x, ""))) > 500 for x in required):
        raise ValueError("小区缓存标识无效")
    normalized = {
        "district": str(item["district"]),
        "business_area": str(item["business_area"]),
        "community": str(item["community"]),
        "status": status, "updated_at": int(time.time()*1000),
        "query": str(item.get("query") or "")[:500],
    }
    if status == "located":
        lng, lat = float(item["lng"]), float(item["lat"])
        if not (math.isfinite(lng) and math.isfinite(lat) and 115.4 <= lng <= 117.6 and 39.4 <= lat <= 41.1):
            raise ValueError("坐标不在北京合理范围内")
        normalized.update(name=str(item["name"])[:500], address=str(item.get("address") or "")[:500],
                          lng=lng, lat=lat, coordinate_system="GCJ-02")
    else:
        normalized["retry_after"] = normalized["updated_at"] + (7*86400 if status == "not_found" else 900)*1000
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with LOCATION_CACHE_LOCK:
        values = load_community_locations(path)
        existing = values.get(cache_key, {})
        if status != "located" and existing.get("lng") is not None and existing.get("lat") is not None:
            return existing  # A failed retry must never destroy a valid saved coordinate.
        values[cache_key] = normalized
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(values, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    return normalized


def ensure_data():
    print("检查本地数据缓存……", flush=True)
    meta = build()
    print(f"数据就绪：{meta['cleaning']['kept_rows']:,} 条有效成交记录", flush=True)


class DashboardHandler(SimpleHTTPRequestHandler):
    service = None
    free_service = None
    access_store = None
    # Legacy visitor/token sessions are test-only; never enable in main().
    legacy_access = False
    limiter = RateLimiter()
    secure_cookie = False
    public_origin = ""
    amap_js_key = ""
    amap_security_code = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):
        # Do not log query strings, headers, cookies, or request bodies.
        sys.stdout.write("[%s] %s %s\n" % (self.log_date_time_string(), self.command, urlparse(self.path).path))

    def session_id(self, name=COOKIE_NAME):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            return cookie[name].value if name in cookie else ""
        except CookieError:
            return ""

    def entitlement(self):
        session = self.access_store.resolve(self.session_id()) if self.access_store and self.legacy_access else None
        trials = self.access_store.trials(self.session_id(VISITOR_COOKIE)) if self.access_store and self.legacy_access else []
        return {"tier": "paid" if session else "free", "free_through": FREE_THROUGH,
                "paid_from": PAID_FROM, "expires_at": session["expires_at"] if session else None,
                "authentication_available": bool(self.access_store and self.legacy_access),
                "account_backend": "pending_supabase", "trial_limit": TRIAL_LIMIT,
                "trial_used": len(trials), "trial_communities": trials,
                "latest_available_month": self.service.meta["date_max"][:7] if self.service else None}

    def cookie_header(self, session="", seconds=0, name=COOKIE_NAME):
        value = f"{name}={session}; Path=/; Max-Age={seconds}; HttpOnly; SameSite=Strict"
        return value + ("; Secure" if self.secure_cookie else "")

    def same_origin(self):
        origin = self.headers.get("Origin")
        expected = self.public_origin or f"http://{self.headers.get('Host', '')}"
        return (not origin or origin == expected) and self.headers.get("Sec-Fetch-Site") != "cross-site"

    def send_json(self, payload, status=200, cookie=None):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Cookie")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()

    def proxy_amap_service(self, parsed):
        if not self.amap_security_code:
            return self.send_json({"error": "高德地图安全密钥尚未配置"}, status=503)
        upstream_path = parsed.path[len(AMAP_SERVICE_PREFIX):] or "/"
        query = parse_qsl(parsed.query, keep_blank_values=True)
        query.append(("jscode", self.amap_security_code))
        upstream = f"https://restapi.amap.com{upstream_path}?{urlencode(query)}"
        request = Request(upstream, headers={"User-Agent": "BeijingHouseDashboard/1.0"})
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read()
                status = response.status
                content_type = response.headers.get("Content-Type", "application/json; charset=utf-8")
        except HTTPError as exc:
            body = exc.read()
            status = exc.code
            content_type = exc.headers.get("Content-Type", "application/json; charset=utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith(("/api/", AMAP_SERVICE_PREFIX)):
                is_map = parsed.path.startswith(AMAP_SERVICE_PREFIX)
                if not self.limiter.allow(("map" if is_map else "api", self.client_address[0]), 1200 if is_map else 180):
                    return self.send_json({"error": "请求过于频繁，请稍后再试"}, 429)
            access = self.entitlement()
            service = self.service if access["tier"] == "paid" else self.free_service
            if parsed.path == "/api/access":
                cookie = None
                if self.legacy_access and self.access_store and not self.access_store.visitor_exists(self.session_id(VISITOR_COOKIE)):
                    cookie = self.cookie_header(self.access_store.new_visitor(), 365 * 86400, VISITOR_COOKIE)
                return self.send_json(access, cookie=cookie)
            # Never fall back to the full service for an unauthenticated request.
            if parsed.path.startswith("/api/") and service is None:
                return self.send_json({"error": "权限服务尚未就绪"}, 503)
            if parsed.path == AMAP_SERVICE_PREFIX or parsed.path.startswith(AMAP_SERVICE_PREFIX + "/"):
                return self.proxy_amap_service(parsed)
            if parsed.path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if parsed.path == "/api/meta":
                metadata = service.metadata()
                # Source paths, fingerprints and full cleaning diagnostics stay server-side.
                safe = {k: metadata[k] for k in ("date_min", "date_max", "default_end_month", "min_month", "max_month", "districts", "business_areas", "rooms", "district_count", "community_count", "business_area_count") if k in metadata}
                safe["cleaning"] = {"kept_rows": metadata["cleaning"]["kept_rows"]}
                return self.send_json({**safe, "access": access})
            if parsed.path == "/api/analyze":
                result = service.analyze(parsed.query)
                return self.send_json({**result, "access": access})
            if parsed.path == "/api/trend":
                return self.send_json({**service.trend(parsed.query), "access": access})
            if parsed.path == "/api/communities":
                results = service.search_communities(parsed.query)
                if access["tier"] != "paid":
                    # Search full catalog, but counts/dates are exclusively from the free snapshot.
                    catalog = self.service.search_communities(parsed.query)
                    public = {tuple(r[k] for k in ("district", "business_area", "community")): r for r in results["results"]}
                    results = {"query": catalog["query"], "results": [public.get(tuple(r[k] for k in ("district", "business_area", "community")),
                        {**{k:r[k] for k in ("district", "business_area", "community")}, "transaction_count": None, "first_date": None, "last_date": None}) for r in catalog["results"]]}
                return self.send_json({**results, "access": access})
            if parsed.path == "/api/community":
                if access["tier"] != "paid":
                    params = parse_qs(parsed.query)
                    community = {k: params.get(k, [""])[0] for k in ("district", "business_area", "community")}
                    if self.legacy_access and self.access_store and self.access_store.has_trial(self.session_id(VISITOR_COOKIE), community):
                        service = self.service
                        access = {**access, "scope": "trial_community"}
                    else:
                        # Public history is always available, never gated by a visitor quota.
                        access = {**access, "scope": "public_history"}
                return self.send_json({**service.community_detail(parsed.query), "access": access})
            if parsed.path == "/api/community-heatmap":
                return self.send_json({**service.community_heatmap(parsed.query), "access": access})
            if parsed.path == "/api/community-locations":
                locations = load_community_locations()
                if access["tier"] != "paid":
                    with self.free_service.connect() as db:
                        allowed = set(db.execute("SELECT DISTINCT district,business_area,community FROM transactions"))
                        allowed = {tuple(row) for row in allowed}
                    locations = {k:v for k,v in locations.items() if (v.get("district"),v.get("business_area"),v.get("community")) in allowed}
                return self.send_json({"locations": locations})
            if parsed.path == "/api/map-config":
                configured = bool(self.amap_js_key and self.amap_security_code)
                return self.send_json({
                    "provider": "amap",
                    "configured": configured,
                    "key": self.amap_js_key if configured else "",
                    "mode": "server_proxy" if configured else "browser_fallback",
                    "service_host": AMAP_SERVICE_PREFIX if configured else "",
                })
            if parsed.path == "/api/health":
                return self.send_json({"ok": True})
            if parsed.path == "/":
                self.path = "/index.html"
            if not self.allowed_static_path():
                return self.send_json({"error": "资源不存在"}, 404)
            return super().do_GET()
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, status=403)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
        except Exception:
            self.send_json({"error": "请求处理失败，请检查服务端配置"}, status=500)

    def allowed_static_path(self):
        resolved = Path(self.translate_path(self.path)).resolve()
        allowed = {"index.html", "app.js", "location-cache.js", "access.js", "analytics.js", "admin.html", "admin.js", "admin.css", "styles.css", "product.css", "product.js", "cloud.js", "beijing-districts.geojson"}
        return resolved.parent == STATIC.resolve() and resolved.name in allowed and not Path(self.translate_path(self.path)).is_symlink()

    def do_HEAD(self):
        if not self.allowed_static_path():
            return self.send_error(404)
        return super().do_HEAD()

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if not self.same_origin() or self.headers.get_content_type() != "application/json":
                return self.send_json({"error": "请求来源或格式不允许"}, 403)
            if parsed.path not in ("/api/community-location", "/api/access/unlock", "/api/access/logout", "/api/access/trial"):
                return self.send_json({"error": "接口不存在"}, status=404)
            is_unlock = parsed.path == "/api/access/unlock"
            if not self.limiter.allow(("unlock" if is_unlock else "post", self.client_address[0]), 10 if is_unlock else 180):
                return self.send_json({"error": "尝试过于频繁，请一分钟后再试"}, 429)
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64_000:
                return self.send_json({"error": "请求内容无效"}, status=400)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("请求必须为 JSON 对象")
            if parsed.path.startswith("/api/access/"):
                if not self.legacy_access or not self.access_store:
                    return self.send_json({"error": "邮箱账号服务尚未接通；截至 2025-08-31 的历史记录可直接查看", "code": "account_backend_not_ready"}, 503)
                if parsed.path == "/api/access/trial":
                    if self.entitlement()["tier"] == "paid":
                        return self.send_json({"ok": True, "access": self.entitlement()})
                    community = {k: str(payload.get(k, "")).strip() for k in ("district", "business_area", "community")}
                    with self.service.connect() as db:
                        exists = db.execute("SELECT 1 FROM transactions WHERE district=? AND business_area=? AND community=? LIMIT 1", tuple(community.values())).fetchone()
                    if not exists:
                        return self.send_json({"error": "小区不存在，不消耗试用额度"}, 404)
                    if not self.access_store.claim_trial(self.session_id(VISITOR_COOKIE), community):
                        return self.send_json({"error": "2 个小区试用额度已用完，查看其他小区请购买并输入 token", "code": "trial_exhausted"}, 402)
                    return self.send_json({"ok": True, "access": self.entitlement()})
                if is_unlock:
                    session = self.access_store.exchange(payload.get("token", ""))
                    if not session:
                        return self.send_json({"error": "token 无效、已过期或已撤销"}, 401)
                    self.access_store.logout(self.session_id())
                    import time
                    return self.send_json({"ok": True}, cookie=self.cookie_header(session["session"], max(1, int(session["expires_at"] - time.time()))))
                self.access_store.logout(self.session_id())
                return self.send_json({"ok": True}, cookie=self.cookie_header())
            local_owner = (not self.public_origin and self.client_address[0] in ("127.0.0.1", "::1")
                           and self.server.server_address[0] in ("127.0.0.1", "::1")
                           and urlparse("http://" + self.headers.get("Host", "")).hostname in ("127.0.0.1", "localhost", "::1"))
            if self.entitlement()["tier"] != "paid" and not local_owner:
                # Free viewers can geolocate in-browser, but cannot mutate the shared cache.
                return self.send_json({"saved": False, "location": payload})
            with self.service.connect() as db:
                exists = db.execute("SELECT 1 FROM transactions WHERE district=? AND business_area=? AND community=? LIMIT 1",
                                    tuple(str(payload.get(k, "")) for k in ("district", "business_area", "community"))).fetchone()
            if not exists:
                return self.send_json({"error": "小区不存在，未写入坐标缓存"}, 404)
            saved = save_community_location(payload)
            return self.send_json({"saved": True, "location": saved})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, status=400)
        except Exception:
            self.send_json({"error": "请求处理失败"}, status=500)


def main():
    ensure_data()
    from analytics import AnalyticsService, DATABASE

    DashboardHandler.service = AnalyticsService()
    free_db, free_meta = build_free_snapshot(DATABASE)
    DashboardHandler.free_service = AnalyticsService(free_db, free_meta)
    DashboardHandler.access_store = AccessStore()
    DashboardHandler.public_origin = os.environ.get("BEIJING_PUBLIC_ORIGIN", "").rstrip("/")
    DashboardHandler.secure_cookie = DashboardHandler.public_origin.startswith("https://")
    DashboardHandler.amap_js_key, DashboardHandler.amap_security_code = load_amap_config()
    host = os.environ.get("BEIJING_HOUSE_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost", "::1") and not DashboardHandler.secure_cookie:
        raise RuntimeError("公网监听必须设置 BEIJING_PUBLIC_ORIGIN=https://你的域名，并配置 HTTPS 反向代理")
    port = int(os.environ.get("BEIJING_HOUSE_PORT", "8876"))
    server = ThreadingHTTPServer((host, port), DashboardHandler)
    url = f"http://{host}:{port}"
    print(f"北京房价看板已启动：{url}", flush=True)
    print("按 Ctrl+C 停止服务。", flush=True)
    if "--no-browser" not in sys.argv and os.environ.get("BEIJING_HOUSE_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
