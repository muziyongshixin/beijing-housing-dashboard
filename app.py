#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import sys
import tempfile
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode, urlparse
from urllib.request import Request, urlopen

from scripts.build_database import build


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
    required = ["key", "district", "business_area", "community", "name", "lng", "lat"]
    if any(item.get(field) in (None, "") for field in required):
        raise ValueError("小区坐标信息不完整")
    normalized = {
        "district": str(item["district"]),
        "business_area": str(item["business_area"]),
        "community": str(item["community"]),
        "name": str(item["name"]),
        "address": str(item.get("address") or ""),
        "lng": float(item["lng"]),
        "lat": float(item["lat"]),
        "query": str(item.get("query") or ""),
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with LOCATION_CACHE_LOCK:
        values = load_community_locations(path)
        values[str(item["key"])] = normalized
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
    amap_js_key = ""
    amap_security_code = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
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
            if parsed.path == AMAP_SERVICE_PREFIX or parsed.path.startswith(AMAP_SERVICE_PREFIX + "/"):
                return self.proxy_amap_service(parsed)
            if parsed.path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if parsed.path == "/api/meta":
                return self.send_json(self.service.metadata())
            if parsed.path == "/api/analyze":
                return self.send_json(self.service.analyze(parsed.query))
            if parsed.path == "/api/trend":
                return self.send_json(self.service.trend(parsed.query))
            if parsed.path == "/api/communities":
                return self.send_json(self.service.search_communities(parsed.query))
            if parsed.path == "/api/community":
                return self.send_json(self.service.community_detail(parsed.query))
            if parsed.path == "/api/community-heatmap":
                return self.send_json(self.service.community_heatmap(parsed.query))
            if parsed.path == "/api/community-locations":
                return self.send_json({"locations": load_community_locations()})
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
            return super().do_GET()
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path != "/api/community-location":
                return self.send_json({"error": "接口不存在"}, status=404)
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64_000:
                return self.send_json({"error": "请求内容无效"}, status=400)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            saved = save_community_location(payload)
            return self.send_json({"saved": True, "location": saved})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)


def main():
    ensure_data()
    from analytics import AnalyticsService

    DashboardHandler.service = AnalyticsService()
    DashboardHandler.amap_js_key, DashboardHandler.amap_security_code = load_amap_config()
    host = os.environ.get("BEIJING_HOUSE_HOST", "127.0.0.1")
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
