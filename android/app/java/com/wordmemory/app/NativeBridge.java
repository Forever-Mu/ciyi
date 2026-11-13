package com.wordmemory.app;

import android.os.Build;
import android.os.Environment;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 暴露给网页的 JS 桥：window.AndroidBridge
 *
 * WebView 不支持 <a download> + Blob 的下载，所以「导出数据库备份」需要走原生写文件。
 * 顶层类，无内部类。
 */
public final class NativeBridge {

    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String platform() {
        return "android";
    }

    @JavascriptInterface
    public int sdkInt() {
        return Build.VERSION.SDK_INT;
    }

    /** 保存文本文件（CSV / JSON 之类） */
    @JavascriptInterface
    public boolean saveText(String fileName, String mimeType, String content) {
        try {
            return write(sanitize(fileName),
                    mimeType == null || mimeType.length() == 0 ? "text/plain" : mimeType,
                    content.getBytes("UTF-8"));
        } catch (Exception e) {
            activity.toast("保存失败：" + e.getMessage());
            return false;
        }
    }

    /** 保存二进制文件（数据库备份），内容为 base64 */
    @JavascriptInterface
    public boolean saveBase64(String fileName, String mimeType, String base64) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            String mime = mimeType == null || mimeType.length() == 0
                    ? "application/octet-stream" : mimeType;
            MainActivity.log("准备保存 " + fileName + "，大小 " + bytes.length + " 字节");
            return write(sanitize(fileName), mime, bytes);
        } catch (Exception e) {
            activity.toast("保存失败：" + e.getMessage());
            return false;
        }
    }

    private boolean write(String name, String mime, byte[] bytes) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            return DownloadsApi29.write(activity, name, mime, bytes);
        }
        File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = activity.getFilesDir();
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录");
        File out = new File(dir, name);
        FileOutputStream fos = new FileOutputStream(out);
        try {
            fos.write(bytes);
            fos.flush();
        } finally {
            fos.close();
        }
        activity.toast("已保存：" + out.getAbsolutePath());
        return true;
    }

    private static String sanitize(String name) {
        String n = (name == null || name.trim().length() == 0) ? "backup.bin" : name.trim();
        return n.replace('\\', '_').replace('/', '_').replace(':', '_')
                .replace('*', '_').replace('?', '_').replace('"', '_')
                .replace('<', '_').replace('>', '_').replace('|', '_');
    }
}
