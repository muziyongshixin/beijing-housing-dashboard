"""Loopback-only visual fixture. Synthetic admin/RPC, no network/auth/real issuance."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / 'static'
MOCK = b"""window.HousingCloud={client:{auth:{getSession:async()=>({data:{session:{user:{email:'admin@example.test'}}}}),onAuthStateChange:()=>{},signOut:async()=>{}}},rpc:async(name,p)=>name==='housing_admin_access'?{is_admin:true}:{ok:true,email:p.p_email,order_ref:p.p_order_ref,duration_days:p.p_duration_days,max_views:p.p_max_views,redeem_before:'2026-10-18T12:00:00Z'}};"""

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        path=self.path.split('?')[0]
        if path=='/mock-cloud.js': body=MOCK; mime='text/javascript'
        elif path=='/mobile':
            body=b'''<!doctype html><meta charset="utf-8"><title>390px admin QA - mock only</title><style>body{margin:0;background:#ddd}iframe{width:390px;height:844px;border:0;background:white}</style><iframe src="/admin.html"></iframe>''';mime='text/html'
        elif path in ('/admin.html','/admin.js','/admin.css'):
            body=(STATIC/path[1:]).read_bytes()
            mime='text/html' if path.endswith('.html') else 'text/css' if path.endswith('.css') else 'text/javascript'
            if path.endswith('.html'):body=body.replace(b'./cloud.js',b'./mock-cloud.js').replace(b'ADMIN CONSOLE',b'QA MOCK - NO REAL DATA')
        else:self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type',mime+'; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

if __name__=='__main__': HTTPServer(('127.0.0.1',18879),Handler).serve_forever()
