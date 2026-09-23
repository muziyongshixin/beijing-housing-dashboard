#!/usr/bin/env python3
"""One-shot administrator market report test; never prints credentials or report rows."""
from __future__ import annotations

import json
import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
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


def login(email):
    _, link = request('/auth/v1/admin/generate_link', body={'type': 'magiclink', 'email': email})
    hashed = link.get('hashed_token') or link.get('properties', {}).get('hashed_token')
    assert hashed, 'No token hash'
    return request('/auth/v1/verify', body={'type': 'magiclink', 'token_hash': hashed})[1]['access_token']


def market(token, params, request_id=None):
    return request('/functions/v1/market-report', body={'params': params, 'request_id': request_id or str(uuid.uuid4())}, token=token)[1]


def paid_acceptance(admin_token, params):
    # Optional isolated account provisioned/cleaned by the operator. Never use a
    # customer account: the address must have this generated QA-only prefix.
    email = os.environ.get('HOUSING_QA_EMAIL', '')
    if not email:
        return
    assert email.startswith('housing-refactor-qa-') and email.endswith('@example.invalid')
    _, qa_user = request('/auth/v1/admin/users', body={'email': email, 'email_confirm': True})
    buyer = None
    try:
        buyer = login(email)
        code = 'bj_' + secrets.token_urlsafe(32)
        _, issued = request('/rest/v1/rpc/housing_admin_issue', token=admin_token, body={
            'p_email': email, 'p_token': code, 'p_order_ref': email,
            'p_duration_days': 1, 'p_redeem_days': 1, 'p_max_views': 3})
        assert issued['ok'] is True
        _, redeemed = request('/rest/v1/rpc/housing_redeem', token=buyer, body={'p_token': code})
        assert redeemed['ok'] is True
        # Invalid calculations never charge a new view.
        try:
            market(buyer, {'window': 25})
            raise AssertionError('invalid query unexpectedly succeeded')
        except RuntimeError as error:
            assert 'invalid_parameters' in str(error)
        _, before = request('/rest/v1/rpc/housing_access', body={}, token=buyer)
        assert before['remaining_views'] == 3
        rid = str(uuid.uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            reports = list(pool.map(lambda _: market(buyer, params, rid), range(2)))
        assert sum(r['charged'] for r in reports) == 1
        assert all(r['access']['remaining_views'] == 2 for r in reports)
        community = next(r for r in reports[0]['report']['communities'] if r['current_volume'] > 0)
        crid = str(uuid.uuid4())
        body = {'p_district': community['district'], 'p_business_area': community['business_area'],
                'p_community': community['community'], 'p_request_id': crid}
        _, detail = request('/rest/v1/rpc/housing_view_community', body=body, token=buyer)
        assert detail['charged'] is True and detail['access']['remaining_views'] == 1
        _, repeat = request('/rest/v1/rpc/housing_view_community', body=body, token=buyer)
        assert repeat['charged'] is False and repeat['access']['remaining_views'] == 1
        # Two distinct reports competing for the final credit: exactly one wins.
        def final_view(_):
            try:
                return market(buyer, params)
            except RuntimeError as error:
                assert 'view_quota_exhausted' in str(error)
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(final_view, range(2)))
        assert sum(r is not None for r in results) == 1
        assert next(r for r in results if r)['access']['remaining_views'] == 0
        assert market(buyer, params, rid)['charged'] is False
        _, valid = request('/rest/v1/rpc/housing_validate_views', token=buyer,
                           body={'p_market': rid, 'p_community': crid})
        assert valid == {'market_valid': True, 'community_valid': True}
        print('Paid acceptance passed: invalid query free, concurrent retry charged once, community/report share balance, final-credit race safe', flush=True)
    finally:
        if buyer:
            request('/auth/v1/logout?scope=local', token=buyer, body=None)
        # Receipts/tokens are retained for SQL audit and removed by the operator.
        print('Disposable QA account created; remove its receipts, tokens and account after audit', flush=True)


def main():
    access_token = None
    try:
        access_token = login(EMAIL)

        _, before = request("/rest/v1/rpc/housing_access", body={}, token=access_token)
        assert before["is_admin"] is True and before["tier"] == "admin", "administrator bypass missing"

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
        print("Administrator latest-market smoke passed: 2026-08-29, retry idempotent, no charge", flush=True)
        try:
            request('/functions/v1/market-compute', token=access_token, body={})
            raise AssertionError('internal worker accepted a user token')
        except RuntimeError as error:
            assert 'HTTP 401' in str(error)
        for extra in [
            {'window': 24, 'compare': 'custom', 'base_start': '2018-01', 'base_end': '2026-08', 'metric': 'mean'},
            {'window': 24, 'compare': 'yoy'},
            {'compare': 'custom', 'base_start': '2018-04', 'base_end': '2018-09'},
            {'metric': 'p60', 'district': '海淀', 'business_area': '中关村', 'rooms': '2室', 'area_min': 50, 'area_max': 100},
        ]:
            started = time.monotonic()
            result = market(access_token, extra)
            assert result['report']['data_through'] == '2026-08-29' and result['charged'] is False
            assert len(result['report']['trends']['全部']['points']) == 48
            print(f"Administrator scenario passed: {extra}, {time.monotonic()-started:.2f}s", flush=True)

        paid_acceptance(access_token, params)
    finally:
        if access_token:
            try:
                request("/auth/v1/logout?scope=local", body=None, token=access_token)
            except Exception:
                pass


if __name__ == "__main__":
    main()
