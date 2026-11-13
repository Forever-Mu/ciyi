package com.wordmemory.app;

import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

/** 处理 <input type="file">：Word 文档导入靠它。顶层类，无内部类。 */
final class PickerChromeClient extends WebChromeClient {

    private final MainActivity activity;

    PickerChromeClient(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                     FileChooserParams params) {
        ValueCallback<Uri[]> stale = activity.takePendingFileCallback();
        if (stale != null) stale.onReceiveValue(null);
        activity.setPendingFileCallback(callback);

        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/msword", "*/*"
        });
        try {
            activity.startActivityForResult(
                    Intent.createChooser(intent, "选择 Word 文档"), MainActivity.REQ_PICK_FILE);
            return true;
        } catch (Exception e) {
            MainActivity.log("打开文件选择器失败：" + e);
            activity.takePendingFileCallback();
            return false;
        }
    }
}
