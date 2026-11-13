package com.wordmemory.app;

import android.webkit.ValueCallback;
import android.widget.Toast;

/**
 * 小型顶层辅助类。
 *
 * 刻意不写成匿名类：build-tools 34 的 R8 在 JDK 21 下 dex 匿名类/内部类会内部崩溃。
 */

/** 返回键的 JS 回调（裸类型 ValueCallback，避免泛型父接口触发 R8 的另一个 bug） */
final class BackCallback implements ValueCallback {

    private final MainActivity activity;

    BackCallback(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public void onReceiveValue(Object value) {
        activity.handleBackResult(value == null ? null : value.toString());
    }
}

/** 在主线程弹 Toast */
final class UiToast implements Runnable {

    private final MainActivity activity;
    private final String message;

    UiToast(MainActivity activity, String message) {
        this.activity = activity;
        this.message = message;
    }

    @Override
    public void run() {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
    }
}
