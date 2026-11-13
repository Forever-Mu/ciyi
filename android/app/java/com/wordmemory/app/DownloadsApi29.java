package com.wordmemory.app;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.OutputStream;

/**
 * API 29+ 的文件写入：写进公共「下载」目录，无需任何运行时权限。
 * 单独成类是为了让旧系统不会在类校验阶段就碰到 MediaStore.Downloads 这个 API 29 符号。
 */
final class DownloadsApi29 {

    private DownloadsApi29() {
    }

    static boolean write(Context ctx, String name, String mime, byte[] bytes) throws Exception {
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        cv.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        if (uri == null) return false;
        try {
            OutputStream os = ctx.getContentResolver().openOutputStream(uri);
            if (os == null) return false;
            try {
                os.write(bytes);
                os.flush();
            } finally {
                os.close();
            }
            cv.clear();
            cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
            ctx.getContentResolver().update(uri, cv, null, null);
        } catch (Exception e) {
            ctx.getContentResolver().delete(uri, null, null);
            throw e;
        }
        if (ctx instanceof MainActivity) {
            ((MainActivity) ctx).toast("已保存到「下载」文件夹：" + name);
        }
        return true;
    }
}
