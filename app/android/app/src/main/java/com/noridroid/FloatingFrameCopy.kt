package com.noridroid

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.view.PixelCopy
import android.view.View
import java.util.concurrent.Executor

/** One local window copy per chat opening; no screen capture or continuous readback. */
fun copyFloatingFrame(view: View, handler: Handler, result: (Bitmap?) -> Unit) {
    if (Build.VERSION.SDK_INT < 34 || !view.isAttachedToWindow || view.width <= 0 || view.height <= 0 ||
        view.width.toLong() * view.height > 4_000_000) {
        result(null)
        return
    }
    var completed = false
    val timeout = Runnable { if (!completed) { completed = true; result(null) } }
    try {
        val request = PixelCopy.Request.Builder.ofWindow(view)
            .setSourceRect(Rect(0, 0, view.width, view.height)).build()
        handler.postDelayed(timeout, 350)
        PixelCopy.request(request, Executor { handler.post(it) }) { copied ->
            val bitmap = if (copied.status == PixelCopy.SUCCESS) copied.bitmap else null
            handler.removeCallbacks(timeout)
            if (completed) bitmap?.recycle()
            else { completed = true; result(bitmap) }
        }
    } catch (_: Exception) {
        handler.removeCallbacks(timeout)
        if (!completed) { completed = true; result(null) }
    }
}
