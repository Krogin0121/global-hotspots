# -*- coding: utf-8 -*-
"""
server.py — 全球实时热点事件 · 可选本地代理服务器
====================================================
用途:
  1. 静态托管当前目录 (index.html / css / js)
  2. 提供 /proxy?url=<远程地址> 端点: 服务端转发请求, 绕过浏览器 CORS/限流
     —— 适用于自部署场景 (内网/本地), GitHub Pages 部署时无需运行本文件

零依赖, 仅用 Python 标准库。用法:
  python server.py            # 默认 http://127.0.0.1:8765
  python server.py 9000       # 自定义端口

启用代理后, 编辑 js/config.js:
  proxy: 'http://127.0.0.1:8765/proxy?url='
然后浏览器访问 http://127.0.0.1:8765/ 即可 (前端会自动把远程请求经本代理转发)。
"""

import sys, os, json, urllib.request, urllib.parse, urllib.error, ssl
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))

# 放行跨域 + 常见请求头透传
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120 Safari/537.36')
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    # ---- 静态文件: 注入宽松 CORS + 禁缓存(便于本地调试时立即生效) ----
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- /proxy?url=... 服务端转发 ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/proxy':
            return self._proxy(urllib.parse.parse_qs(parsed.query).get('url', [None])[0])
        return super().do_GET()

    def _proxy(self, target):
        if not target:
            self._json(400, {'error': '缺少 url 参数'})
            return
        try:
            req = urllib.request.Request(target, headers={
                'User-Agent': UA,
                'Accept': 'application/json, text/html, application/xml, */*',
            })
            with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
                raw = r.read()
                ctype = r.headers.get('Content-Type', 'application/octet-stream')
                # rss2json / hn / vvhan 等多为 JSON, 尽量以 JSON 返回便于前端 parse
                if 'json' in ctype.lower() or target.rstrip('/').endswith('.json'):
                    try:
                        data = json.loads(raw.decode('utf-8'))
                        return self._json(200, data)
                    except Exception:
                        pass
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.end_headers()
                self.wfile.write(raw)
        except urllib.error.HTTPError as e:
            self._json(e.code, {'error': '上游 HTTP %d' % e.code, 'url': target})
        except Exception as e:
            self._json(502, {'error': str(e), 'url': target})

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print('=' * 56)
    print(' 全球实时热点事件 · 本地服务已启动')
    print(' 访问地址 : http://127.0.0.1:%d/' % PORT)
    print(' 代理端点 : http://127.0.0.1:%d/proxy?url=<远程地址>' % PORT)
    print(' 按 Ctrl+C 停止')
    print('=' * 56)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
        srv.server_close()


if __name__ == '__main__':
    main()
