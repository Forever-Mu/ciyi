package com.wordmemory.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * 词忆 · Android 宿主
 *
 * 页面加载方式：虚构一个 https 源，用 shouldInterceptRequest 把请求就地映射到
 * APK 内的 assets。这样页面拥有稳定的安全源，IndexedDB / DOM Storage 可靠，
 * 且不会产生任何真实网络流量。
 *
 * 注意：本工程刻意不使用内部类和匿名类，也不实现泛型父接口。
 * build-tools 34 自带的 R8(8.2.2-dev) 在 JDK 21 下处理这两类结构会内部崩溃。
 */
public class MainActivity extends Activity {

    static final String TAG = "WordMemory";
    static final String VIRTUAL_HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + VIRTUAL_HOST + "/index.html";
    static final String FALLBACK_URL = "file:///android_asset/index.html";
    static final int REQ_PICK_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> pendingFileCallback;
    private boolean usedFallback = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage
        s.setDatabaseEnabled(true);            // IndexedDB 依赖
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new AssetWebViewClient(this));
        web.setWebChromeClient(new PickerChromeClient(this));
        web.addJavascriptInterface(new NativeBridge(this), "AndroidBridge");
        web.setBackgroundColor(0xFFF5F6FA);

        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        if (web.getUrl() == null) web.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    WebView getWebView() { return web; }
    boolean isFallbackUsed() { return usedFallback; }
    void markFallbackUsed() { usedFallback = true; }

    void setPendingFileCallback(ValueCallback<Uri[]> cb) { pendingFileCallback = cb; }

    ValueCallback<Uri[]> takePendingFileCallback() {
        ValueCallback<Uri[]> cb = pendingFileCallback;
        pendingFileCallback = null;
        return cb;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            ValueCallback<Uri[]> cb = takePendingFileCallback();
            if (cb != null) cb.onReceiveValue(result);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private static final String BACK_JS =
            "(function(){try{"
                    + "var s=document.querySelector('.scrim');"
                    + "if(s){var b=s.querySelector('.sheet-head button');"
                    + "if(b){b.click();return 'modal';}}"
                    + "return 'none';}catch(e){return 'none';}})()";

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null) {
            web.evaluateJavascript(BACK_JS, new BackCallback(this));
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    void handleBackResult(String value) {
        if (value != null && value.contains("modal")) return;
        if (web != null && web.canGoBack()) web.goBack();
        else finish();
    }

    void toast(String msg) {
        runOnUiThread(new UiToast(this, msg));
    }

    static void log(String msg) {
        Log.i(TAG, msg);
    }
}
