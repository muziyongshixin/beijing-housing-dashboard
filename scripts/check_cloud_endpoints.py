#!/usr/bin/env python3
"""Public cloud smoke test: no account, private payload, or secret is used."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request


FUNCTIONS = "https://mehbviiakjcbfckonzqk.supabase.co/functions/v1"
ORIGIN = "https://liyongzhi.xyz"


def fetch(path: str, *, method: str = "GET", origin: str = ORIGIN, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Origin": origin}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(FUNCTIONS + path, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    content = response.read()
    return response.status, response.headers, content


def main():
    status, _, raw = fetch("/amap-proxy/config")
    assert status == 200, status
    config = json.loads(raw)
    assert config["configured"] is True and config["mode"] == "server_proxy"
    assert config["key"] and config["service_host"].startswith(FUNCTIONS + "/amap-proxy/")
    assert set(config) == {"provider", "configured", "key", "mode", "service_host", "auto_geocode"}

    callback = "housing_cloud_smoke"
    path = "/amap-proxy/_AMapService/v3/log/init?" + urllib.parse.urlencode(
        {"key": config["key"], "callback": callback, "eventId": "cloud.smoke", "product": "JsInit"}
    )
    status, headers, raw = fetch(path)
    assert status == 200, status
    assert headers.get_content_type() == "application/javascript", headers.get("Content-Type")
    assert raw and len(raw) < 2 * 1024 * 1024

    status, _, raw = fetch("/amap-proxy/config", origin="https://evil.example")
    assert status == 403 and json.loads(raw)["error"] == "origin_not_allowed"

    status, _, raw = fetch(
        "/market-report",
        method="POST",
        body={"params": {}, "request_id": "11111111-1111-4111-8111-111111111111"},
    )
    assert status == 401 and json.loads(raw)["error"] == "verified_email_required"
    print("Cloud endpoint smoke passed: map config, JSONP MIME, origin guard, market auth boundary")


if __name__ == "__main__":
    main()
