# 词忆 · iOS 版（未签名 ipa 流水线）

## 先说清楚：为什么本机出不了 ipa

`.ipa` 里装的是 **用 Xcode 编出来的 Mach-O 二进制**（`Payload/词忆.app/词忆`，arm64）。签名是编译之后的步骤，而**编译本身就必须在 macOS + Xcode 上进行**。

本机环境查过了：

```
xcodebuild   未安装
xcrun        未安装
actool       未安装
swiftc       未安装
clang        未安装
iOS SDK      未发现
OS           Windows NT 10.0.22621
```

所以这里能交付的是**一套完整的 iOS 工程 + 一条能在 macOS 上跑通的构建流水线**，而不是一个现成的 ipa。任何声称在 Windows 上"直接打包出 ipa"的做法，要么是空壳，要么是假的。

---

## 两条出 ipa 的路

### 路线 A：GitHub Actions（不需要 Mac，推荐）

仓库里已经放好 `.github/workflows/ios.yml`，用的是 GitHub 免费的 `macos-14` runner。

```bash
# 在仓库根目录
git init
git add .
git commit -m "词忆 iOS"
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

推上去之后：

1. 打开仓库页面 → **Actions** 标签
2. 左边选 **Build unsigned IPA** → 右边 **Run workflow**
3. 等 3~6 分钟
4. 进入这次运行 → 页面底部 **Artifacts** → 下载 `CiYi-unsigned-ipa`
5. 解压得到 `CiYi-unsigned.ipa`

> `.gitignore` 已经排除了 `data/_raw/`（63MB 的 ECDICT 原始 csv），仓库推上去只有几 MB。

### 路线 B：自己的 Mac

```bash
brew install xcodegen
./ios/scripts/prepare-www.sh
cd ios && xcodegen generate
open CiYi.xcodeproj      # 然后在 Xcode 里选真机，Build
```

---

## 拿到 ipa 之后怎么装

ipa 是**未签名**的，iOS 不会直接接受。三种签法：

| 方式 | 费用 | 有效期 | 说明 |
|---|---|---|---|
| **Sideloadly / AltStore**（用你自己的 Apple ID） | 免费 | 7 天，到期重签 | 需要一台电脑配合，最省事 |
| **Apple 开发者账号 + 自签** | $99/年 | 1 年 | 可注册设备清单，适合长期用 |
| **TestFlight** | $99/年 | 90 天/版 | 需要上传到 App Store Connect |

用 Sideloadly 的流程：把 `CiYi-unsigned.ipa` 拖进去 → 填自己的 Apple ID → 手机连电脑 → Start → 手机上到「设置 → 通用 → VPN与设备管理」信任证书。

---

## 工程结构

```
ios/
├─ project.yml                  XcodeGen 工程定义（不手写 pbxproj，避免 UUID 出错）
├─ Resources/Info.plist
├─ Sources/
│  ├─ AppDelegate.swift         入口，无 storyboard
│  ├─ WebViewController.swift   全屏 WKWebView
│  └─ AssetSchemeHandler.swift  ciyi:// -> app bundle
├─ scripts/
│  ├─ prepare-www.sh            复制网页资源到 ios/www
│  └─ verify_ios.py             静态校验（70 项，无需 macOS）
└─ www/                         ← 构建时生成，不进仓库
```

### 为什么用自定义 scheme 而不是 `file://`

App 的数据库是 SQLite(WASM)，落在浏览器的 IndexedDB 里。`file://` 下 WKWebView 对 IndexedDB / localStorage 支持很不可靠，所以这里照搬 Capacitor 的做法：注册一个 `ciyi://` scheme，用 `WKURLSchemeHandler` 从 app bundle 读文件。这样页面有稳定的 origin，存储才能持久化。

### 两个必须守住的细节

1. **`.gz` 文件必须原样返回**，绝对不能加 `Content-Encoding: gzip` 响应头 —— 否则 WebKit 会自动解压一次，页面里的 `fflate.gunzipSync` 再解一次就炸了。所以 `Content-Type` 是 `application/gzip`，但**没有** `Content-Encoding`。
2. **MIME 必须正确**：`application/wasm`（流式编译 WASM）、`application/javascript`（ES module）缺一不可，否则启动即白屏。

---

## 静态校验

```bash
python ios/scripts/verify_ios.py
```

跑的是**不需要 Xcode 也能查**的东西，最近一次 **70 / 70 通过**：

- `Info.plist` 能被 `plistlib` 解析，含 `UILaunchScreen`（iOS 14+ 必需），无 Scene 清单
- `project.yml` / `ios.yml` 是合法 YAML；target 类型、folder reference、签名开关都正确
- 3 个 Swift 文件里 `@main`、`WKURLSchemeHandler`、scheme 名、起始地址、MIME 表都在
- `index.html` 没有外部依赖，引用的 4 个资源都存在
- `web/app.js` 的 9 个 `../core/*.js` 导入全部可解析，`core/` 内部导入也自洽
- 模拟 `prepare-www.sh` 的打包结果：文件数、关键文件、无 csv、无 `_raw`
- 模拟 scheme handler 的路径解析，5 个关键路径都能命中

**这些证明的是"工程结构和资源是对的"，证明不了"能编译通过、能装能跑"。** 后者只有真跑一次 macOS 构建才知道。

---

## 已知风险（跑失败时优先查这几条）

1. **XcodeGen 版本差异** —— `project.yml` 的字段在不同版本可能略有出入。失败先看 `xcodegen generate` 的输出。
2. **IndexedDB 在自定义 scheme 下是否可用** —— Capacitor 用同样方案是能用的，但这是本项目在 iOS 上最大的不确定点。如果启动后数据库打不开，控制台会报错，需要改成在 app 内起一个本地 HTTP 服务。
3. **Swift 语法** —— 三个文件都是我凭经验写的，没经过 `swiftc` 检查。拼写错误会在编译阶段一次暴露。
4. **`www` folder reference** —— 如果 XcodeGen 生成的项目里 `www` 不是蓝色文件夹（folder reference）而是普通 group，资源会被打散，路径就断了。`prepare-www.sh` 里有 `find` 结果可以对照。

---

## 一句话总结

安卓那条路已经彻底走通了（APK 2.6MB，41 项静态校验通过，能装）。
iOS 这条路我给了完整的工程和流水线，但**第一次构建大概率还要调试一两轮** —— 因为我没有 Mac 可以试。

如果你只是想立刻在 iPhone 上用到这个 App，PWA（Safari → 添加到主屏幕）是零成本的替代方案，那个我验证过能跑。
