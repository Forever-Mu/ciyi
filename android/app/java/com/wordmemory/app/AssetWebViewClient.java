package com.wordmemory.app;

import android.net.Uri;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/** 把虚构的 https 源映射到 APK 内 assets，并挡掉一切外部跳转。顶层类，无内部类。 */
final class AssetWebViewClient extends WebViewClient {

    private final MainActivity activity;

    AssetWebViewClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !MainActivity.VIRTUAL_HOST.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
        return assetResponse(path.substring(1));
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri != null && MainActivity.VIRTUAL_HOST.equals(uri.getHost())) return false;
        MainActivity.log("拦截外部跳转：" + uri);
        return true;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!activity.isFallbackUsed() && request.isForMainFrame()) {
            activity.markFallbackUsed();
            MainActivity.log("虚拟源失败，回退 file://：" + error.getDescription());
            view.loadUrl(MainActivity.FALLBACK_URL);
        }
    }

    private WebResourceResponse assetResponse(String path) {
        try {
            InputStream is = activity.getAssets().open(path);
            String mime = guessMime(path);
            if (isTextual(mime)) return new WebResourceResponse(mime, "utf-8", is);
            return new WebResourceResponse(mime, null, is);
        } catch (IOException e) {
            MainActivity.log("assets 缺失：" + path);
            return new WebResourceResponse("text/plain", "utf-8",
                    new ByteArrayInputStream(("404 in assets: " + path).getBytes()));
        }
    }

    private static boolean isTextual(String mime) {
        return mime.startsWith("text/") || mime.contains("javascript")
                || mime.contains("json") || mime.contains("xml") || mime.contains("svg");
    }

    private static String guessMime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".gz")) return "application/gzip";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }
}
