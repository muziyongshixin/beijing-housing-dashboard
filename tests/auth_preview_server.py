"""Loopback QA only: production bundles with a synthetic auth endpoint, no emails.

Run after syncing docs: python3 tests/auth_preview_server.py
Never deployed. Use only @example.test and code 12345678 in this fixture.
"""
import base64
import json
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'docs'
ORIGIN = b'https://mehbviiakjcbfckonzqk.supabase.co'
MOCK = b'http://127.0.0.1:18881/mock'
COUNTS = {'otp': 0, 'verify': 0, 'refresh': 0, 'logout': 0}


def session():
    def b64(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip('=')
    exp = int(time.time()) + 3600
    token = b64({'alg': 'none'}) + '.' + b64({'sub': 'qa-user', 'session_id': 'qa-session', 'exp': exp}) + '.synthetic'
    return {'access_token': token, 'refresh_token': 'qa-refresh-not-real', 'token_type': 'bearer',
            'expires_at': exp, 'expires_in': 3600, 'user': {'id': 'qa-user', 'email': 'qa@example.test'}}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass  # Never log auth bodies.

    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        path = self.path.split('?')[0]
        if path.endswith('/otp') or path.endswith('/verify'):
            if not payload.get('email', '').endswith('@example.test'):
                return self.reply({'message': 'QA only: use @example.test'}, 400)
        if path == '/mock/auth/v1/otp':
            COUNTS['otp'] += 1
            return self.reply({})
        if path == '/mock/auth/v1/verify':
            if payload.get('token') != '12345678':
                return self.reply({'message': 'QA code is 12345678'}, 400)
            COUNTS['verify'] += 1
            return self.reply(session())
        if path == '/mock/auth/v1/token':
            COUNTS['refresh'] += 1
            return self.reply(session())
        if path == '/mock/auth/v1/logout':
            COUNTS['logout'] += 1
            return self.reply({'message': 'QA simulated offline logout'}, 503)
        if path == '/mock/rest/v1/rpc/housing_access':
            return self.reply({'tier': 'registered', 'trial_communities': [], 'trial_limit': 2})
        return self.reply({'message': 'QA route unavailable'}, 404)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/qa-stats':
            return self.reply(COUNTS)
        if path.startswith('/mock/'):
            return self.reply({'message': 'QA: external integrations disabled'}, 404)
        if path in ('/', '/index.html', '/app.js', '/cloud.js'):
            name = 'index.html' if path == '/' else path[1:]
            body = (ROOT / name).read_bytes().replace(ORIGIN, MOCK)
            if name == 'index.html':
                body = body.replace(b'<body>', '<body><p style="background:#fff0bf;padding:8px;margin:0">QA 模拟登录 · 无真实数据权限 / 不发送邮件 · qa@example.test / 12345678</p>'.encode())
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if name.endswith('html') else 'text/javascript')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18881), Handler).serve_forever()
