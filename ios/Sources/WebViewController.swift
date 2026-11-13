import UIKit
import WebKit

/// 全屏 WKWebView，加载 bundle 内的 www/index.html
final class WebViewController: UIViewController {

    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = UIColor(red: 0.961, green: 0.965, blue: 0.980, alpha: 1.0)

        guard let wwwRoot = Bundle.main.url(forResource: "www", withExtension: nil) else {
            showFatal("打包时缺少 www 目录")
            return
        }

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AssetSchemeHandler(root: wwwRoot),
                                   forURLScheme: AssetSchemeHandler.scheme)
        // 数据存在默认 store 里，SQLite(WASM) 的 IndexedDB 就落在这
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.bounces = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self

        view.addSubview(webView)

        if let url = URL(string: "ciyi://localhost/index.html") {
            webView.load(URLRequest(url: url))
        } else {
            showFatal("起始地址无效")
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .default }
    override var prefersStatusBarHidden: Bool { false }

    private func showFatal(_ message: String) {
        let label = UILabel()
        label.text = "启动失败：\n\(message)"
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .darkGray
        label.frame = view.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
    }
}

extension WebViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        NSLog("[CiYi] 加载失败：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("[CiYi] 页面加载完成")
    }
}
