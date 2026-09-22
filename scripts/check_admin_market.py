#!/usr/bin/env python3
"""One-shot administrator market report test; never prints credentials or report rows."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid


URL = "https://mehbviiakjcbfckonzqk.supabase.co"
SERVICE = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
EMAIL = os.environ["HOUSING_ADMIN_EMAIL"]


def request(path, *, method="POST", body=None, token=None, timeout=240):
    payload = None if body is None else json.dumps(body).encode()
    headers = {"apikey": SERVICE, "Authorization": "Bearer " + (token or SERVICE)}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(URL + path, data=payload, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {error.code} on {path}: {detail}") from None
    raw = response.read()
    return response.status, json.loads(raw) if raw else None


def main():
    access_token = None
    try:
        _, link = request("/auth/v1/admin/generate_link", body={"type": "magiclink", "email": EMAIL})
        token_hash = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
        assert token_hash, "generate_link did not return a token hash"
        _, session = request("/auth/v1/verify", body={"type": "magiclink", "token_hash": token_hash})
        access_token = session["access_token"]

        _, before = request("/rest/v1/rpc/housing_access", body={}, token=access_token)
        assert before["is_admin"] is True and before["tier"] == "paid", "administrator bypass missing"

        request_id = str(uuid.uuid4())
        params = {"end_month": "2026-08", "window": 6, "compare": "adjacent", "metric": "median"}
        _, first = request(
            "/functions/v1/market-report",
            body={"params": params, "request_id": request_id},
            token=access_token,
        )
        report = first["report"]
        assert report["data_through"] == "2026-08-29"
        assert report["benchmark"]["current_volume"] > 0
        assert first["charged"] is False and first["access"]["is_admin"] is True

        _, retry = request(
            "/functions/v1/market-report",
            body={"params": params, "request_id": request_id},
            token=access_token,
        )
        assert retry["charged"] is False and retry["report"]["data_through"] == "2026-08-29"
        _, after = request("/rest/v1/rpc/housing_access", body={}, token=access_token)
        assert after["is_admin"] is True
        assert before.get("remaining_views") == after.get("remaining_views")
        print("Administrator latest-market smoke passed: 2026-08-29, retry idempotent, no charge")
    finally:
        if access_token:
            try:
                request("/auth/v1/logout?scope=local", body=None, token=access_token)
            except Exception:
                pass


if __name__ == "__main__":
    main()
