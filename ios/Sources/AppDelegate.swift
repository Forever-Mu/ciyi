import UIKit

/// 词忆 · iOS 宿主
///
/// 结构上和安卓那边一一对应：
///   安卓  -> 虚构 https 源 + shouldInterceptRequest 从 assets 读
///   iOS   -> 自定义 ciyi:// 源 + WKURLSchemeHandler 从 app bundle 读
///
/// 用自定义 scheme 而不是 file:// 是有原因的：
/// file:// 下 WKWebView 的 IndexedDB / localStorage 不可靠，
/// 而 App 的数据库（SQLite WASM）就存在 IndexedDB 里。
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
