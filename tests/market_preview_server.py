"""Local rendered QA with production UI and exact local reports; no real auth."""
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
from auth_preview_server import Handler as Base, COUNTS

PRIVATE = Path(__file__).resolve().parents[1] / '.private/market-preview'
ACCESS = {'tier': 'admin', 'is_admin': True, 'trial_communities': [], 'trial_limit': 2, 'remaining_views': None}

class Handler(Base):
    def do_GET(self):
        if self.path.split('?')[0] in ('/', '/index.html'):
            from auth_preview_server import ROOT, ORIGIN, MOCK
            body = (ROOT / 'index.html').read_bytes().replace(ORIGIN, MOCK)
            body = body.replace(b'<body>', '<body><p style="background:#fff0bf;padding:8px;margin:0">仅本机验收 · 合成账号 + 本地真实报告 · 不发送邮件 · qa@example.test / 12345678</p>'.encode())
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        if path in ('/mock/rest/v1/rpc/housing_access', '/mock/functions/v1/market-report', '/mock/rest/v1/rpc/housing_validate_views'):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            if path.endswith('housing_access'):
                return self.reply(ACCESS)
            if path.endswith('housing_validate_views'):
                return self.reply({'market_valid': True, 'community_valid': True})
            name = 'long' if str(body.get('params', {}).get('window')) == '24' else 'default'
            COUNTS['market'] = COUNTS.get('market', 0) + 1
            return self.reply({'report': json.loads((PRIVATE / (name + '.json')).read_text()), 'access': ACCESS, 'charged': False, 'request_id': body.get('request_id')})
        super().do_POST()

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18881), Handler).serve_forever()
