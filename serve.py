# -*- coding: utf-8 -*-
"""
serve.py —— 本地静态服务（开发用）

比 python -m http.server 多做几件事：
  · 补全 .wasm / .gz / .docx 的 MIME 类型（sql.js 的 WASM 需要正确的 application/wasm）
  · 关闭缓存，改完刷新就能看到
  · 只监听 127.0.0.1
"""
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORT = 8899

EXTRA_TYPES = {
    ".wasm": "application/wasm",
    ".gz": "application/gzip",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        **EXTRA_TYPES,
    }

    def __init__(self, *a, **kw):
        kw["directory"] = ROOT
        super().__init__(*a, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def out(s=""):
    try:
        print(s, flush=True)
    except Exception:
        pass


def main():
    os.chdir(ROOT)
    port = PORT
    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex((HOST, port)) != 0:
                break
        port += 1

    httpd = Server((HOST, port), Handler)
    url = "http://%s:%d/index.html" % (HOST, port)

    out()
    out("  ============================================")
    out("     词忆 · 本地开发服务")
    out("  ============================================")
    out()
    out("  应用地址: %s" % url)
    out("  关闭窗口即停止服务")
    out()

    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        out("  已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
