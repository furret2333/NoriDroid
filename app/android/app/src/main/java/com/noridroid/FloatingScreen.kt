package com.noridroid

import android.content.Context
import android.os.Build
import android.view.WindowInsets
import android.view.WindowManager

/** maximumWindowMetrics 避免小聊天 Activity 的尺寸被误当成整块屏幕。 */
fun floatingScreenBounds(context: Context): FloatingBounds {
    val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val metrics = wm.maximumWindowMetrics
        val bars = metrics.windowInsets.getInsetsIgnoringVisibility(
            WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
        )
        val b = metrics.bounds
        return FloatingBounds(b.left + bars.left, b.top + bars.top, b.right - bars.right, b.bottom - bars.bottom)
    }
    @Suppress("DEPRECATION")
    val dm = android.util.DisplayMetrics().also { wm.defaultDisplay.getRealMetrics(it) }
    val statusId = context.resources.getIdentifier("status_bar_height", "dimen", "android")
    val navId = context.resources.getIdentifier("navigation_bar_height", "dimen", "android")
    val top = if (statusId > 0) context.resources.getDimensionPixelSize(statusId) else 0
    val bottom = if (navId > 0) context.resources.getDimensionPixelSize(navId) else 0
    return FloatingBounds(0, top, dm.widthPixels, (dm.heightPixels - bottom).coerceAtLeast(top + 1))
}
