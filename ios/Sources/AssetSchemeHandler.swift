import WebKit

/// 把 ciyi://localhost/<path> 映射到 app bundle 里的 www/<path>
///
/// 注意几个坑：
///   · .gz 文件必须原样返回，绝不能加 Content-Encoding: gzip，
///     否则 WebKit 会自动解压，页面的 fflate.gunzipSync 再解一次就炸了
///   · 必须给正确的 MIME，WASM 要 application/wasm，
///     JS 模块要 application/javascript，否则 ES module 加载失败
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {

    static let scheme = "ciyi"

    private let root: URL

    init(root: URL) {
        self.root = root
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            finish(urlSchemeTask, status: 400, body: Data())
            return
        }

        var path = url.path
        if path.isEmpty || path == "/" {
            path = "/index.html"
        }

        // 防目录穿越
        let relative = String(path.dropFirst())
        guard !relative.contains("..") else {
            finish(urlSchemeTask, status: 403, body: Data())
            return
        }

        let fileURL = root.appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            finish(urlSchemeTask, status: 404,
                   body: Data("404 \(path)".utf8),
                   mime: "text/plain; charset=utf-8")
            return
        }

        let mime = AssetSchemeHandler.mime(for: fileURL.pathExtension)
        if let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime,
                "Content-Length": "\(data.count)",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache",
            ]
        ) {
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } else {
            finish(urlSchemeTask, status: 500, body: Data())
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // 没有长连接，无需处理
    }

    private func finish(_ task: WKURLSchemeTask, status: Int, body: Data,
                        mime: String = "text/plain; charset=utf-8") {
        guard let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: status,
                                             httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": mime])
        else { return }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "application/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "wasm":        return "application/wasm"
        case "gz":          return "application/gzip"
        case "png":         return "image/png"
        case "svg":         return "image/svg+xml"
        case "ico":         return "image/x-icon"
        case "txt":         return "text/plain; charset=utf-8"
        default:            return "application/octet-stream"
        }
    }
}
