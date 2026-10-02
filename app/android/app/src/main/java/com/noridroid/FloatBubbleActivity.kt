package com.noridroid

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * 悬浮窗聊天气泡 Activity: 半透明小窗口, 首次生成时定位在 **Nori 模型下方** (不重叠),
 * 承载输入框 + 回复. 位置算法见 BubblePlacement.kt 的 placeBubble (纯函数, 可单测).
 *
 * 为什么这样设计 (对应 Android 12+ 官方机制):
 * - 气泡是普通 Activity 窗口 → 弹键盘 100% 可靠.
 * - 落在模型下方 → 输入行 (窗口底部) 在悬浮窗 OVERLAY 覆盖区之外 →
 *   不会触发 untrusted touch 拦截, 点击必定生效.
 * - 点 Nori (悬浮窗, 穿透) → 触摸落到桌面, 不会碰到气泡 → 不会弹键盘.
 * - 点气泡空白处/输入框 → 聚焦输入框 → 键盘弹出 (系统标准行为).
 * - 关闭: 点 ✕ / 按返回 (点 Nori 不会关闭气泡, 防误触).
 * - 窗口高度随内容增长 (初始只有输入框, 随文字生成向下长), 键盘弹出时不超过键盘顶.
 */
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
    /** 模型脚底到悬浮窗底边的留白 (回复区可透过去显示的区域); 参与初始高度计算 */
    private var safeTop = 0
    /** JS 上报的拖动把手区域 (相对窗口左上角) */
    private var handleRect: IntArray? = null
    /** 锁定: 固定位置/大小 (拖动/缩放失效) */
    private var locked = false

    // 手势状态 (原生处理, rawX/rawY 屏幕绝对坐标不受窗口移动影响)
    private var dragStartX = 0f
    private var dragStartY = 0f
    private var winStartX = 0
    private var winStartY = 0
    private var dragging = false
    /** 双指捏合: X/Y 分量独立缩放 (横向拉宽 / 纵向拉高) */
    private var pinchX = 0f
    private var pinchY = 0f
    private var scaledByPinch = false

    companion object {
        private const val TAG = "FloatBubble"
        const val EXTRA_X = "x"
        const val EXTRA_Y = "y"
        const val EXTRA_W = "w"
        const val EXTRA_H = "h"
        const val EXTRA_MODEL_FEET = "feet"
        // 拖动/缩放钳制
        private const val MIN_W = 260
        private const val MAX_W = 1200
        private const val MIN_H = 320
        private const val MAX_H = 1400
        // 窗口位置记忆 (拖动/缩放后保存, 下次从原位置弹出)
        private const val PREFS = "float_bubble"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        private const val KEY_W = "w"
        private const val KEY_H = "h"
        private const val KEY_SAVED = "saved"
        // ES Module 需要 https Origin, 由 shouldInterceptRequest 兜底读 assets
        private const val ENTRY_URL = "https://appassets.androidplatform.net/assets/bubble.html"

        /** 气泡是否打开 (FloatService 据此防误触) */
        @Volatile
        var isOpen = false
    }

    /** 屏幕可用区 (排除状态栏 + 导航栏/任务栏): 气泡窗口不能压到系统栏区域
     *  (否则点击被系统栏吃掉、渲染发黑) */
    private fun usableArea(): IntArray {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val metrics = wm.currentWindowMetrics
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
                android.view.WindowInsets.Type.systemBars()
            )
            intArrayOf(
                insets.left, insets.top,
                metrics.bounds.width() - insets.left - insets.right,
                metrics.bounds.height() - insets.top - insets.bottom
            )
        } else {
            val dm = resources.displayMetrics
            intArrayOf(0, 0, dm.widthPixels, dm.heightPixels)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isOpen = true

        // 屏幕可用区 (排除状态栏 + 导航栏/任务栏)
        val a = usableArea()
        ux = a[0]; uy = a[1]; uw = a[2]
        val uh = a[3]
        usableBottom = uy + uh

        // 宽度: 悬浮窗宽度的合理值 (与悬浮窗基本同宽, 封顶 600)
        val maxW = (uw - 8).coerceAtLeast(180)
        winW = intent.getIntExtra(EXTRA_W, 260).coerceIn(180, minOf(maxW, 600))

        // 布局 (2026-10-02 用户报「对话框嵌在 Nori 里面」后修): 首次生成时对话框顶边落在
        // **模型底边下方** (不重叠, 一眼可见、随手能拖); 输入行在悬浮窗底边之下 (OVERLAY 上层的
        // 悬浮窗压住输入行会影响点击). 落点算法抽在纯函数 placeBubble() 里 —— 单位与边界都在那,
        // 便于在 JVM 上真跑单测 (tmp-memcheck/probe-bubble-place.mjs).
        // 悬浮窗零改动 → Nori 永不透明.
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
        if (hasSaved) {
            val sx = prefs.getInt(KEY_X, px)
            val sy = prefs.getInt(KEY_Y, 0)
            // 恢复记忆尺寸 (钳制到当前屏幕可用范围)
            val savedW = prefs.getInt(KEY_W, 0)
            val savedH = prefs.getInt(KEY_H, 0)
            winW = savedW.coerceIn(MIN_W, (uw - 8).coerceAtLeast(MIN_W))
            winH = savedH.coerceIn(MIN_H, (usableBottom - uy - 8).coerceAtLeast(MIN_H))
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
            )
            px = layout.x
            py = layout.y
            totalH = layout.h
            safeTop = layout.safeTop
            Log.d(TAG, "bubble placed belowModel=${layout.belowModel} modelBottom=$feet")
        }
        winH = totalH
        Log.d(TAG, "bubble window: float=($fx,$fy,${fw}x$fh) feet=$feet size=${winW}x$winH " +
            "pos=($px,$py) safeTop=$safeTop usable=($ux,$uy,${uw}x$uh)")

        window.setBackgroundDrawableResource(android.R.color.transparent)
        // 防止气泡窗口对底层内容变暗/混合 (悬浮窗 Nori 保持清晰不透明)
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.attributes = window.attributes.apply {
            gravity = Gravity.TOP or Gravity.START
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
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.setSupportZoom(false)
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.textZoom = 100
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true

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
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url?.toString() ?: return null
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
    }

    /** JS 桥: 上报拖动把手区域 + 锁定状态 (窗口移动/缩放由原生触摸处理) */
    inner class BubbleWindowControl {
        @android.webkit.JavascriptInterface
        fun setHandleRect(l: Int, t: Int, r: Int, b: Int) {
            handleRect = intArrayOf(l, t, r, b)
            Log.d(TAG, "handle rect=$l,$t,$r,$b")
        }

        @android.webkit.JavascriptInterface
        fun setLocked(l: Boolean) {
            locked = l
            Log.d(TAG, "locked=$l")
        }
    }

    /** 触摸处理: 把手拖动 + 双指缩放 (rawX/rawY 屏幕绝对坐标, 窗口移动不影响) */
    private fun handleBubbleTouch(event: MotionEvent): Boolean {
        if (locked) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = false
                scaledByPinch = false
                dragStartX = event.rawX
                dragStartY = event.rawY
                val a = window.attributes
                winStartX = a.x
                winStartY = a.y
                // 按下点在把手区域内 → 启动拖动 (±20px 容差, 防坐标取整偏差)
                val hr = handleRect
                if (hr != null) {
                    val px = event.rawX - a.x
                    val py = event.rawY - a.y
                    if (px >= hr[0] - 20 && px <= hr[2] + 20 && py >= hr[1] - 20 && py <= hr[3] + 20) {
                        dragging = true
                    }
                }
                return dragging
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    scaledByPinch = true
                    dragging = false
                    pinchX = Math.abs(event.getX(0) - event.getX(1))
                    pinchY = Math.abs(event.getY(0) - event.getY(1))
                }
                return scaledByPinch
            }
            MotionEvent.ACTION_MOVE -> {
                if (scaledByPinch && event.pointerCount >= 2) {
                    val nx = Math.abs(event.getX(0) - event.getX(1))
                    val ny = Math.abs(event.getY(0) - event.getY(1))
                    // X/Y 分量独立缩放: 横向拉开只调宽, 纵向拉开只调高
                    var sx = 1f
                    var sy = 1f
                    if (pinchX > 0f) sx = nx / pinchX
                    if (pinchY > 0f) sy = ny / pinchY
                    resizeWindow(sx, sy)
                    pinchX = nx
                    pinchY = ny
                    return true
                }
                if (dragging && event.pointerCount == 1) {
                    // 12px 阈值: 轻触/长按微动不算拖动
                    val dx = event.rawX - dragStartX
                    val dy = event.rawY - dragStartY
                    if (dx * dx + dy * dy < 144) return true
                    moveWindow(
                        winStartX + dx.toInt(),
                        winStartY + dy.toInt()
                    )
                    return true
                }
                return false
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (event.pointerCount <= 2) {
                    scaledByPinch = false
                    dragging = false
                }
                return scaledByPinch
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val wasHandled = dragging || scaledByPinch
                if (dragging || scaledByPinch) saveWindowState()
                dragging = false
                scaledByPinch = false
                return wasHandled
            }
        }
        return false
    }

    /** 记忆窗口位置/尺寸 (下次从原位置弹出) */
    private fun saveWindowState() {
        try {
            val a = window.attributes
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_SAVED, true)
                .putInt(KEY_X, a.x)
                .putInt(KEY_Y, a.y)
                .putInt(KEY_W, winW)
                .putInt(KEY_H, winH)
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

    /** 缩放窗口: 宽/高独立缩放 (横向拉宽 / 纵向拉高), 以窗口中心为锚, 钳制尺寸与屏幕边界 */
    private fun resizeWindow(sx: Float, sy: Float) {
        if (sx <= 0f || sy <= 0f) return
        val a = window.attributes
        val cx = a.x + winW / 2
        val cy = a.y + winH / 2
        val maxH = (usableBottom - uy - 8).coerceAtLeast(MIN_H)
        val maxW = (uw - 8).coerceAtLeast(MIN_W)
        val nw = (winW * sx).toInt().coerceIn(MIN_W, minOf(maxW, MAX_W))
        val nh = (winH * sy).toInt().coerceIn(MIN_H, minOf(maxH, MAX_H))
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
        try { webView?.destroy() } catch (_: Exception) { /* 忽略 */ }
        webView = null
        isOpen = false
        super.onDestroy()
    }
}