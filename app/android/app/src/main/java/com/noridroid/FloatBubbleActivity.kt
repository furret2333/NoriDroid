package com.noridroid

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.WindowInsets
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/** 普通 Activity 聊天窗口：独立拖动把手，只点击输入框才弹出键盘。 */
class FloatBubbleActivity : Activity() {

    private var webView: WebView? = null
    /** 当前窗口尺寸 */
    private var winW = 260
    private var winH = 200
    /** 屏幕可用区边界 (钳制用) */
    private var ux = 0
    private var uy = 0
    private var uw = 0
    private var usableBottom = 0
    private var screenBottom = 0
    private var frameBeforeIme: FloatingFrame? = null
    /** 模型脚底到悬浮窗底边的留白 (回复区可透过去显示的区域); 参与初始高度计算 */
    private var safeTop = 0
    /** JS 上报的拖动把手区域 (相对窗口左上角) */
    private var handleRect: IntArray? = null
    /** 锁定: 固定位置/大小 (拖动/缩放失效) */
    @Volatile private var locked = false
    private var modelHostToken: android.os.IBinder? = null
    private var modelHostActive = false

    // 手势状态 (原生处理, rawX/rawY 屏幕绝对坐标不受窗口移动影响)
    private var dragStartX = 0f
    private var dragStartY = 0f
    private var winStartX = 0
    private var winStartY = 0
    private var dragging = false
    private var dragCandidate = false
    private var touchSlop = 8
    /** 双指捏合按比例缩放，避免横竖分量分别变化导致窗口变形。 */
    private var pinchDist = 0f
    private var scaledByPinch = false

    companion object {
        private const val TAG = "FloatBubble"
        const val EXTRA_X = "x"
        const val EXTRA_Y = "y"
        const val EXTRA_W = "w"
        const val EXTRA_H = "h"
        const val EXTRA_MODEL_FEET = "feet"
        // 拖动/缩放钳制
        private const val MIN_W_DP = 280
        private const val MAX_W_DP = 600
        private const val MIN_H_DP = 160
        private const val MAX_H_DP = 700
        // 窗口位置记忆 (拖动/缩放后保存, 下次从原位置弹出)
        private const val PREFS = "float_bubble"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        private const val KEY_W = "w"
        private const val KEY_H = "h"
        private const val KEY_SAVED = "saved"
        private const val KEY_DENSITY = "density"
        // ES Module 需要 https Origin, 由 shouldInterceptRequest 兜底读 assets
        private const val ENTRY_URL = "https://appassets.androidplatform.net/assets/bubble.html"

        /** 气泡是否打开 (FloatService 据此防误触) */
        @Volatile
        var isOpen = false
    }

    /** 屏幕可用区 (排除状态栏 + 导航栏/任务栏): 气泡窗口不能压到系统栏区域
     *  (否则点击被系统栏吃掉、渲染发黑) */
    private fun usableArea(): IntArray {
        val b = floatingScreenBounds(this)
        return intArrayOf(b.left, b.top, b.right - b.left, b.bottom - b.top)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isOpen = true

        // 屏幕可用区 (排除状态栏 + 导航栏/任务栏)
        val a = usableArea()
        ux = a[0]; uy = a[1]; uw = a[2]
        val uh = a[3]
        usableBottom = uy + uh
        screenBottom = usableBottom
        touchSlop = ViewConfiguration.get(this).scaledTouchSlop

        // 宽度: 悬浮窗宽度的合理值 (与悬浮窗基本同宽, 封顶 600)
        val maxW = (uw - dp(8)).coerceAtLeast(1)
        val minW = dp(MIN_W_DP).coerceAtMost(maxW)
        winW = intent.getIntExtra(EXTRA_W, dp(320)).coerceIn(minW, minOf(maxW, dp(MAX_W_DP)).coerceAtLeast(minW))

        // 首次生成优先放在模型下方，空间不足时向上放置；用户拖过的位置优先。
        val fx = intent.getIntExtra(EXTRA_X, 80)
        val fy = intent.getIntExtra(EXTRA_Y, 200)
        val fw = intent.getIntExtra(EXTRA_W, 260)
        val fh = intent.getIntExtra(EXTRA_H, 340)
        // 模型底边: 页面按**物理像素**上报 (与 rawX/窗口坐标同一单位); <= 0 = 还没上报
        val feet = intent.getIntExtra(EXTRA_MODEL_FEET, -1)
        var px = (fx + (fw - winW) / 2).coerceIn(ux, (ux + uw - winW).coerceAtLeast(ux))
        var py: Int
        var totalH: Int
        // 记忆的位置: 用户拖过/缩放过对话框 → 下次从原位置弹出 (用户自己摆的优先, 不再自动算)
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val hasSaved = prefs.getBoolean(KEY_SAVED, false)
        val savedDensity = prefs.getFloat(KEY_DENSITY, resources.displayMetrics.density).takeIf { it > 0f } ?: resources.displayMetrics.density
        val restoreScale = resources.displayMetrics.density / savedDensity
        if (hasSaved) {
            val sx = (prefs.getInt(KEY_X, px) * restoreScale).toInt()
            val sy = (prefs.getInt(KEY_Y, 0) * restoreScale).toInt()
            // 恢复记忆尺寸 (钳制到当前屏幕可用范围)
            val savedW = (prefs.getInt(KEY_W, 0) * restoreScale).toInt()
            val savedH = (prefs.getInt(KEY_H, 0) * restoreScale).toInt()
            val minH = dp(MIN_H_DP).coerceAtMost((usableBottom - uy).coerceAtLeast(1))
            val restored = scaleFloatingSize(savedW, savedH, 1f, minW, minH,
                minOf(dp(MAX_W_DP), maxW), minOf(dp(MAX_H_DP), (usableBottom - uy - dp(8)).coerceAtLeast(1)))
            winW = restored.first
            winH = restored.second
            px = sx.coerceIn(ux, (ux + uw - winW).coerceAtLeast(ux))
            py = sy.coerceIn(uy, (usableBottom - winH).coerceAtLeast(uy))
            totalH = winH
            safeTop = 0
            Log.d(TAG, "bubble restored: pos=($px,$py) size=${winW}x$winH")
        } else {
            // 首次生成 (用户报的那个场景): 模型下方 GAP 像素; 模型底未知则退化成悬浮窗底边下方
            val layout = placeBubble(
                floatX = fx, floatY = fy, floatW = fw, floatH = fh,
                modelBottom = feet, winW = winW,
                screenLeft = ux, screenTop = uy, screenRight = ux + uw, screenBottom = usableBottom,
                density = resources.displayMetrics.density,
            )
            px = layout.x
            py = layout.y
            totalH = layout.h
            safeTop = layout.safeTop
            Log.d(TAG, "bubble placed belowModel=${layout.belowModel} modelBottom=$feet")
        }
        savedInstanceState?.let {
            winW = it.getInt(KEY_W, winW)
            totalH = it.getInt(KEY_H, totalH)
            px = it.getInt(KEY_X, px)
            py = it.getInt(KEY_Y, py)
            locked = it.getBoolean("locked", false)
        }
        val initial = fitFloatingWindow(px, py, winW, totalH, FloatingBounds(ux, uy, ux + uw, usableBottom))
        px = initial.x; py = initial.y
        winW = initial.width
        winH = initial.height
        Log.d(TAG, "bubble window: float=($fx,$fy,${fw}x$fh) feet=$feet size=${winW}x$winH " +
            "pos=($px,$py) safeTop=$safeTop usable=($ux,$uy,${uw}x$uh)")

        window.setBackgroundDrawableResource(android.R.color.transparent)
        // 防止气泡窗口对底层内容变暗/混合 (悬浮窗 Nori 保持清晰不透明)
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
            else WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        window.attributes = window.attributes.apply {
            gravity = Gravity.TOP or Gravity.LEFT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setFitInsetsTypes(0)
            this.x = px
            this.y = py
            width = winW
            height = winH
            format = PixelFormat.TRANSLUCENT
        }

        val wv = WebView(this)
        wv.setBackgroundColor(0x00000000)
        val settings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.setAllowFileAccessFromFileURLs(true)
        settings.setAllowUniversalAccessFromFileURLs(true)
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportZoom(false)
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.textZoom = 100
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            wv.setOnApplyWindowInsetsListener { view, insets ->
                // WindowMetrics 的 Insets 相对屏幕/task；不能用小窗口的局部 bottom 再减一次导航栏。
                updateImeArea(insets.isVisible(WindowInsets.Type.ime()))
                view.onApplyWindowInsets(insets)
            }
        }

        // 对话/记忆/TTS/设置桥: 复用主 App 同一份数据
        val chatBridge = ChatBridge(this)
        wv.addJavascriptInterface(chatBridge, "NoriChat")
        chatBridge.attach(wv)
        // 窗口控制桥: JS 上报把手区域 + 锁定状态
        wv.addJavascriptInterface(BubbleWindowControl(), "BubbleWindow")
        // 原生触摸: 把手拖动 + 双指缩放 (rawX/rawY 屏幕绝对坐标, 窗口移动不受影响)
        // 非把手区域返回 false → WebView 正常处理点击/输入/键盘
        wv.setOnTouchListener { _, event -> handleBubbleTouch(event) }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return true
                if (!WebAssets.isAllowedUrl(uri.toString())) {
                    view?.stopLoading()
                    Log.w(TAG, "blocked navigation to $uri")
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                if (url != null && !WebAssets.isAllowedUrl(url)) {
                    view?.stopLoading()
                    Log.w(TAG, "blocked page start to $url")
                    return
                }
                super.onPageStarted(view, url, favicon)
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url?.toString() ?: return null
                if (!WebAssets.isAllowedSubresource(url) && !url.startsWith("data:") && !url.startsWith("blob:")) {
                    return WebAssets.blockedResponse()
                }
                return WebAssets.serve(assets, url)
            }
            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: android.webkit.WebResourceError?
            ) {
                Log.e(TAG, "load error: ${error?.errorCode} ${error?.description}")
                super.onReceivedError(view, request, error)
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                Log.d(TAG, "page finished: $url")
                super.onPageFinished(view, url)
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: android.webkit.ConsoleMessage?): Boolean {
                message?.message()?.takeIf { it.isNotBlank() }?.let {
                    Log.d(TAG, "$it [${message.sourceId()}:${message.lineNumber()}]")
                }
                return super.onConsoleMessage(message)
            }
        }

        setContentView(wv)
        webView = wv
        wv.loadUrl(ENTRY_URL)
        wv.requestApplyInsets()
    }

    /** JS 桥: 上报拖动把手区域 + 锁定状态 (窗口移动/缩放由原生触摸处理) */
    inner class BubbleWindowControl {
        @android.webkit.JavascriptInterface
        fun setHandleRect(l: Int, t: Int, r: Int, b: Int) {
            runOnUiThread { handleRect = intArrayOf(l, t, r, b) }
        }

        @android.webkit.JavascriptInterface
        fun setLocked(l: Boolean) {
            runOnUiThread { locked = l }
        }

        @android.webkit.JavascriptInterface
        fun isLocked(): Boolean = locked
    }

    /** 触摸处理: 把手拖动 + 双指缩放 (rawX/rawY 屏幕绝对坐标, 窗口移动不影响) */
    private fun handleBubbleTouch(event: MotionEvent): Boolean {
        if (locked) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = false
                dragCandidate = false
                scaledByPinch = false
                dragStartX = event.rawX
                dragStartY = event.rawY
                val a = window.attributes
                winStartX = a.x
                winStartY = a.y
                val hr = handleRect
                if (hr != null) {
                    val px = event.x
                    val py = event.y
                    val margin = 0
                    dragCandidate = px >= hr[0] - margin && px <= hr[2] + margin &&
                        py >= hr[1] - margin && py <= hr[3] + margin
                }
                return dragCandidate
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
                    try { webView?.onTouchEvent(cancel) } finally { cancel.recycle() }
                    scaledByPinch = true
                    dragging = false
                    dragCandidate = false
                    pinchDist = pointerDistance(event)
                }
                return scaledByPinch
            }
            MotionEvent.ACTION_MOVE -> {
                if (scaledByPinch && event.pointerCount >= 2) {
                    val next = pointerDistance(event)
                    if (pinchDist > 0f) resizeWindow((next / pinchDist).coerceIn(0.85f, 1.18f))
                    pinchDist = next.coerceAtLeast(1f)
                    return true
                }
                if (scaledByPinch) return true
                if (dragCandidate && event.pointerCount == 1) {
                    val dx = event.rawX - dragStartX
                    val dy = event.rawY - dragStartY
                    if (!dragging && dx * dx + dy * dy <= touchSlop * touchSlop) return true
                    dragging = true
                    moveWindow(winStartX + dx.toInt(), winStartY + dy.toInt())
                    return true
                }
                return false
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (event.pointerCount <= 2) {
                    if (scaledByPinch) saveWindowState()
                    dragging = false
                    dragCandidate = false
                    pinchDist = 0f
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                val handled = dragCandidate || dragging || scaledByPinch
                if (dragging) snapToNearestEdge()
                if (handled) saveWindowState()
                dragging = false
                dragCandidate = false
                scaledByPinch = false
                return handled
            }
            MotionEvent.ACTION_CANCEL -> {
                val handled = dragging || scaledByPinch || dragCandidate
                if (dragging || scaledByPinch) saveWindowState()
                dragging = false
                dragCandidate = false
                scaledByPinch = false
                return handled
            }
        }
        return false
    }

    private fun saveWindowState() {
        try {
            val a = window.attributes
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_SAVED, true)
                .putInt(KEY_X, frameBeforeIme?.x ?: a.x)
                .putInt(KEY_Y, frameBeforeIme?.y ?: a.y)
                .putInt(KEY_W, frameBeforeIme?.width ?: winW)
                .putInt(KEY_H, frameBeforeIme?.height ?: winH)
                .putFloat(KEY_DENSITY, resources.displayMetrics.density)
                .apply()
            Log.d(TAG, "bubble state saved: (${a.x},${a.y}) ${winW}x$winH")
        } catch (_: Exception) { /* 忽略 */ }
    }

    /** 移动窗口到绝对位置, 钳制在屏幕可用区内 */
    private fun moveWindow(nx: Int, ny: Int) {
        val a = window.attributes
        val cx = nx.coerceIn(ux, (ux + uw - winW).coerceAtLeast(ux))
        val cy = ny.coerceIn(uy, (usableBottom - winH).coerceAtLeast(uy))
        if (cx == a.x && cy == a.y) return
        a.x = cx
        a.y = cy
        window.attributes = a
    }

    /** 以窗口中心等比缩放，同时限制大小和屏幕边界。 */
    private fun resizeWindow(scale: Float) {
        if (!scale.isFinite() || scale <= 0f) return
        val a = window.attributes
        val cx = a.x + winW / 2
        val cy = a.y + winH / 2
        val maxH = (usableBottom - uy - dp(8)).coerceAtLeast(1)
        val maxW = (uw - dp(8)).coerceAtLeast(1)
        val minW = dp(MIN_W_DP).coerceAtMost(maxW)
        val minH = dp(MIN_H_DP).coerceAtMost(maxH)
        val (nw, nh) = scaleFloatingSize(winW, winH, scale, minW, minH,
            minOf(maxW, dp(MAX_W_DP)), minOf(maxH, dp(MAX_H_DP)))
        if (nw == winW && nh == winH) return
        winW = nw
        winH = nh
        a.width = nw
        a.height = nh
        a.x = (cx - nw / 2).coerceIn(ux, (ux + uw - nw).coerceAtLeast(ux))
        a.y = (cy - nh / 2).coerceIn(uy, (usableBottom - nh).coerceAtLeast(uy))
        window.attributes = a
    }

    override fun onBackPressed() {
        finish()
    }

    override fun onDestroy() {
        releaseModelWindow()
        try { webView?.destroy() } catch (_: Exception) { /* 忽略 */ }
        webView = null
        super.onDestroy()
    }

    private fun pointerDistance(event: MotionEvent): Float {
        val dx = event.getX(0) - event.getX(1)
        val dy = event.getY(0) - event.getY(1)
        return Math.sqrt((dx * dx + dy * dy).toDouble()).toFloat()
    }

    private fun snapToNearestEdge() {
        val a = window.attributes
        applyFrame(fitFloatingWindow(a.x, a.y, winW, winH,
            FloatingBounds(ux, uy, ux + uw, usableBottom), dp(28)))
    }

    private fun applyFrame(frame: FloatingFrame) {
        val a = window.attributes
        if (a.x == frame.x && a.y == frame.y && a.width == frame.width && a.height == frame.height) return
        winW = frame.width; winH = frame.height
        a.x = frame.x; a.y = frame.y
        a.width = winW; a.height = winH
        window.attributes = a
    }

    private fun updateImeArea(imeVisible: Boolean) {
        val previousBottom = usableBottom
        val bounds = floatingScreenBounds(this)
        ux = bounds.left; uy = bounds.top; uw = bounds.width
        screenBottom = bounds.bottom
        usableBottom = screenBottom
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && imeVisible) {
            val metrics = (getSystemService(Context.WINDOW_SERVICE) as WindowManager).currentWindowMetrics
            val imeBottom = metrics.windowInsets.getInsets(WindowInsets.Type.ime()).bottom
            if (imeBottom > 0) usableBottom = minOf(screenBottom, metrics.bounds.bottom - imeBottom).coerceAtLeast(uy + 1)
            if (frameBeforeIme != null && previousBottom == usableBottom) return
            if (frameBeforeIme == null) {
                val a = window.attributes
                frameBeforeIme = FloatingFrame(a.x, a.y, winW, winH)
            }
        }
        val a = window.attributes
        val desired = frameBeforeIme ?: FloatingFrame(a.x, a.y, winW, winH)
        // 先上移，只有可用区整体容纳不下时才缩短，收键盘后恢复原窗口。
        applyFrame(fitFloatingWindow(desired.x, desired.y, desired.width, desired.height,
            FloatingBounds(ux, uy, ux + uw, usableBottom)))
        if (!imeVisible) frameBeforeIme = null
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        updateImeArea(false)
        webView?.requestApplyInsets()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        val a = window.attributes
        val frame = frameBeforeIme ?: FloatingFrame(a.x, a.y, winW, winH)
        outState.putInt(KEY_X, frame.x); outState.putInt(KEY_Y, frame.y)
        outState.putInt(KEY_W, frame.width); outState.putInt(KEY_H, frame.height)
        outState.putBoolean("locked", locked)
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        isOpen = true
        modelHostActive = true
        // onResume 时 DecorView 可能尚未加到 WindowManager，等父窗口 token 可用再附着模型。
        window.decorView.post {
            if (!modelHostActive || isFinishing || isDestroyed) return@post
            val token = window.decorView.windowToken ?: return@post
            modelHostToken = token
            FloatService.attachChatWindow(token)
        }
    }

    override fun onStop() {
        isOpen = false
        releaseModelWindow()
        super.onStop()
    }

    private fun releaseModelWindow() {
        modelHostActive = false
        modelHostToken?.let { FloatService.detachChatWindow(it) }
        modelHostToken = null
    }
}
