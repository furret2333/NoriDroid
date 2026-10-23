package com.noridroid

import android.view.ViewGroup
import android.webkit.WebView
import androidx.annotation.MainThread

/** WebView.destroy requires removal from the view hierarchy first. Window
 * reattachment does not remove the WebView from its FrameLayout parent. */
@MainThread
fun destroyNoriWebView(view: WebView) {
    view.onPause()
    view.stopLoading()
    (view.parent as? ViewGroup)?.removeView(view)
    view.removeJavascriptInterface("NoriChat")
    view.removeJavascriptInterface("NoriBridge")
    view.removeJavascriptInterface("BubbleWindow")
    view.destroy()
}
