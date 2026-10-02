package com.noridroid

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
import java.io.File

/**
 * 悬浮窗服务: 应用退出后小尺寸 Live2D 留在桌面. 单击 Nori → 弹出聊天气泡
 * (FloatBubbleActivity, 普通窗口承载输入, 弹键盘 100% 可靠).
 *
 * 关键设计 (Android 12+ 官方机制):
 * - 本窗口永远不可聚焦 (FLAG_NOT_FOCUSABLE): 不抢桌面焦点.
 * - **气泡打开期间加 FLAG_NOT_TOUCHABLE**: Android 12+ 会拦截"被 OVERLAY 遮挡窗口"
 *   的触摸 (untrusted touch), 悬浮窗不穿透的话气泡所有按钮都会点不到.
 *   加 NOT_TOUCHABLE 后触摸穿透悬浮窗直达气泡 → 气泡必定可点 (官方解法).
 *   NOT_TOUCHABLE 不影响渲染 (之前的"Nori 透明"实为气泡窗口的 DIM 变暗, 已清除).
 * - 气泡窗口定位在悬浮窗正下方 (不重叠): Nori 的点击穿过悬浮窗落到桌面,
 *   不会碰到气泡 → 点 Nori 不会弹键盘.
 * - 拖动阈值 25px; 气泡关闭后 600ms 防误触 (点 ✕ 不会立刻又弹出).
 */
class FloatService : Service() {

    companion object {
        private const val TAG = "FloatService"
        const val ACTION_SHOW = "com.noridroid.FLOAT_SHOW"
        const val ACTION_HIDE = "com.noridroid.FLOAT_HIDE"
        const val ACTION_RENDER_SCALE = "com.noridroid.FLOAT_RENDER_SCALE"
        const val ACTION_PLAY_MARKER = "com.noridroid.FLOAT_PLAY_MARKER"
        const val ACTION_PLAY_BY_TEXT = "com.noridroid.FLOAT_PLAY_BY_TEXT"
        /** 暂停/恢复悬浮窗**渲染** (主 App 回到前台时立刻停画; 见 onStartCommand 里那一段说明) */
        const val ACTION_SET_PAUSED = "com.noridroid.FLOAT_SET_PAUSED"
        const val EXTRA_PAUSED = "paused"
        /** 悬浮窗页面上报的模型脚底 Y (相对悬浮窗窗口, **物理像素**; 与 modelRect 同一单位);
         *  -1 = 未知。只用于对话框初始落点 (BubblePlacement.placeBubble) */
        @Volatile
        var modelFeetY = -1
        /** 悬浮窗页面上报的模型身体矩形 (相对悬浮窗窗口, 物理像素); null = 未知.
         *  只有按在模型身上才弹聊天气泡 (透明区不误触) */
        @Volatile
        var modelRect: IntArray? = null
        private const val MIN_W = 160
        private const val MIN_H = 200
        private const val MAX_W = 1000
        private const val MAX_H = 1400
        // 窗口尺寸/位置记忆
        private const val PREFS = "float_window"
        private const val KEY_W = "w"
        private const val KEY_H = "h"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        // 关闭气泡后短时间内不重复打开 (防误触)
        private const val BUBBLE_COOLDOWN_MS = 600L
        // 长按: 0.8s 内移动不算拖动 (防误拖); 到点解锁拖动 + 触发抚摸
        private const val STROKE_LONG_PRESS_MS = 800L
        // 轻微滑动判定: 位移超过 12px 视为"轻微滑动"(= 抚摸); 超过 40px 视为"快速滑出"(不弹气泡)
        private const val STROKE_CANCEL_THRESHOLD = 12f
        private const val STROKE_SLIDE_LIMIT = 40f
        // 拖动阈值: 0.8s 后位移超过 25px → 开始拖动窗口
        private const val DRAG_THRESHOLD = 25f
        // ES Module 需要 https Origin (file:// 会被浏览器禁止),
        // 故用 appassets 虚拟域名, 再由 shouldInterceptRequest 兜底读取 assets
        private const val ENTRY_URL = "https://appassets.androidplatform.net/assets/float.html"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var wm: WindowManager? = null
    private var floatView: View? = null
    private var webView: WebView? = null
    private var floatParams: WindowManager.LayoutParams? = null

    // 窗口状态
    private var winW = 260
    private var winH = 340
    /** 上次启动气泡的时间戳 (防误触) */
    private var lastBubbleAt = 0L

    // 手势状态
    private var dragStartX = 0f
    private var dragStartY = 0f
    private var winStartX = 0
    private var winStartY = 0
    private var dragging = false
    private var pinchDist = 0f
    private var scaledByPinch = false
    /** 按下点在模型身体矩形内 → 轻点弹气泡 / 轻微滑动抚摸 */
    private var touchMode = false
    /** 抚摸进行中 (仅由轻微滑动触发) */
    private var stroking = false
    /** 0.8s 计时 (到点解锁拖动; 不触发抚摸) */
    private var strokeTimer: Runnable? = null
    /** 0.8s 计时是否已到 (到点才允许拖动, 防误拖) */
    private var dragArmed = false
    /** 触摸模式下的累计位移 */
    private var touchMoveX = 0f
    private var touchMoveY = 0f
    /** 快速滑出: 大幅快速滑动后抬起不弹气泡 (防误触) */
    private var touchMovedFar = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_HIDE -> {
                removeFloat()
                stopSelf()
            }
            ACTION_RENDER_SCALE -> {
                val scale = intent.getDoubleExtra("scale", 2.0)
                webView?.evaluateJavascript("window.__noriSetRenderScale && window.__noriSetRenderScale($scale)", null)
            }
            ACTION_PLAY_MARKER -> {
                // 聊天气泡 → 悬浮窗 Nori 表演 (表情/动作标记驱动)
                val emotion = intent.getStringExtra("emotion") ?: ""
                val motion = intent.getStringExtra("motion") ?: ""
                if (emotion.isNotEmpty() || motion.isNotEmpty()) {
                    // 表演也算互动 → 重置待机, 避免待机动作打断刚播的表演
                    notifyTouchActive()
                    webView?.evaluateJavascript(
                        "window.__noriPlayMarker && window.__noriPlayMarker(" +
                            "${jsonStr(emotion)}, ${jsonStr(motion)})", null)
                }
            }
            ACTION_PLAY_BY_TEXT -> {
                // 聊天气泡 → 悬浮窗 Nori: 正文关键词兜底表演 (标记缺失时用)
                val text = intent.getStringExtra("text") ?: ""
                if (text.isNotEmpty()) {
                    notifyTouchActive()
                    webView?.evaluateJavascript(
                        "window.__noriPlayByText && window.__noriPlayByText(${jsonStr(text)})", null)
                }
            }
            /**
             * 暂停/恢复**渲染**（主 App 回到前台 / 离开前台时由 MainActivity 发）。
             *
             * 为什么需要这条指令: MainActivity.onResume 里的 `stopService` 是**延迟 400ms** 的，
             * 而主 WebView 的渲染循环在 onResume 那一刻就恢复了 —— 这 400ms 里两个 Live2D 实例
             * 同时抢 GPU/CPU（实测主界面帧率 29 → 9.5，见 tmp-memcheck/probe-main-fps.mjs）。
             * 先把悬浮窗"停画"，那段时间就只剩主界面在画。
             *
             * 没有窗口时 stopSelf(): "暂停"这种指令不该把服务拉起来常驻（此前 playFloatMarker /
             * setFloatRenderScale 这类 startService 会留下一个没有窗口的服务，直到下次 onResume 才被收走）。
             */
            ACTION_SET_PAUSED -> {
                val paused = intent.getBooleanExtra(EXTRA_PAUSED, true)
                if (floatView == null) stopSelf()
                else webView?.evaluateJavascript(
                    "window.__noriSetPaused && window.__noriSetPaused($paused)", null)
            }
            else -> showFloat()
        }
        // 不自动重启: 用户从最近任务划掉应用时悬浮窗应随之消失
        return START_NOT_STICKY
    }

    /** 用户从最近任务划掉应用: 移除悬浮窗并停止服务 */
    override fun onTaskRemoved(rootIntent: Intent?) {
        removeFloat()
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        removeFloat()
        super.onDestroy()
    }

    // ---------------- 窗口 ----------------

    private fun showFloat() {
        if (floatView != null) return
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val view = buildFloatView()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        // 恢复上次的尺寸/位置记忆
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        winW = prefs.getInt(KEY_W, winW)
        winH = prefs.getInt(KEY_H, winH)
        val params = WindowManager.LayoutParams(
            winW, winH, type,
            // 永远不可聚焦: 不抢桌面焦点, 桌面操作不受影响
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = prefs.getInt(KEY_X, 80)
            y = prefs.getInt(KEY_Y, 200)
        }
        try {
            wm?.addView(view, params)
            floatView = view
            floatParams = params
            Log.d(TAG, "float view added ${winW}x$winH @(${params.x},${params.y})")
        } catch (e: Exception) {
            Log.e(TAG, "addView failed", e)
        }
    }

    /** 记忆当前尺寸/位置, 下次启动悬浮窗时恢复 */
    private fun saveState() {
        try {
            val p = floatParams
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt(KEY_W, winW)
                .putInt(KEY_H, winH)
                .putInt(KEY_X, p?.x ?: 80)
                .putInt(KEY_Y, p?.y ?: 200)
                .apply()
        } catch (_: Exception) { /* 忽略 */ }
    }

    /** 单击 Nori → 弹出聊天气泡.
     *  悬浮窗**零改动**: 改 flags 会弄坏渲染 (Nori 透明), 绝不触碰.
     *  对话框顶部伸进悬浮窗底部留白 (显示回复文字, 无需点击), 输入框在悬浮窗下方可点. */
    private fun launchFloatBubble() {
        if (FloatBubbleActivity.isOpen) return
        val now = System.currentTimeMillis()
        if (now - lastBubbleAt < BUBBLE_COOLDOWN_MS) return
        lastBubbleAt = now
        try {
            val p = floatParams
            val intent = Intent(this, FloatBubbleActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(FloatBubbleActivity.EXTRA_X, p?.x ?: 80)
                putExtra(FloatBubbleActivity.EXTRA_Y, p?.y ?: 200)
                putExtra(FloatBubbleActivity.EXTRA_W, winW)
                putExtra(FloatBubbleActivity.EXTRA_H, winH)
                putExtra(FloatBubbleActivity.EXTRA_MODEL_FEET, modelFeetY)
            }
            startActivity(intent)
            Log.d(TAG, "bubble launched (${p?.x},${p?.y}) ${winW}x$winH")
        } catch (e: Exception) {
            Log.e(TAG, "launch bubble failed", e)
        }
    }

    // ---------------- 悬浮窗视图 ----------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildFloatView(): View {
        val wv = WebView(applicationContext)
        wv.setBackgroundColor(0x00000000) // 纯透明: 只显示 Live2D
        val settings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.setAllowFileAccessFromFileURLs(true)
        settings.setAllowUniversalAccessFromFileURLs(true)
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.setSupportZoom(false)
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.textZoom = 100

        // 桥: 模型/对话/记忆/设置 —— 悬浮窗复用主 App 的同一份数据
        val modelBridge = ModelBridge(applicationContext)
        val chatBridge = ChatBridge(applicationContext)
        wv.addJavascriptInterface(modelBridge, "NoriBridge")
        modelBridge.attach(wv)
        wv.addJavascriptInterface(chatBridge, "NoriChat")
        chatBridge.attach(wv)

        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url?.toString() ?: return null
                serveModelFile(url, modelBridge)?.let { return it }
                return WebAssets.serve(assets, url)
            }
            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: android.webkit.WebResourceError?
            ) {
                Log.e(TAG, "load error: ${error?.errorCode} ${error?.description} url=${request?.url}")
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

        // 拖动 + 双指缩放; 返回 true = 消费手势, false = 放行给 WebView
        wv.setOnTouchListener { _, event -> handleFloatTouch(event) }
        webView = wv
        wv.loadUrl(ENTRY_URL)
        return wv
    }

    // ---------------- 触摸手势 ----------------

    private fun handleFloatTouch(event: MotionEvent): Boolean {
        val params = floatParams ?: return false
        // 气泡打开期间悬浮窗是穿透的 (NOT_TOUCHABLE), 这里不会收到触摸; 防御保留
        if (FloatBubbleActivity.isOpen) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = false
                scaledByPinch = false
                stroking = false
                dragArmed = false
                touchMovedFar = false
                touchMoveX = 0f
                touchMoveY = 0f
                dragStartX = event.rawX
                dragStartY = event.rawY
                winStartX = params.x
                winStartY = params.y
                // 按下即算互动 → 重置待机计时
                notifyTouchActive()
                // 模型上按下 → 启动 0.8s 计时 (到点只解锁拖动, 不触发抚摸)
                val r = modelRect
                touchMode = r != null && isInModelRect(event, params, r)
                val runnable = Runnable {
                    dragArmed = true // 0.8s 后允许拖动 (抚摸只由轻微滑动触发)
                }
                strokeTimer = runnable
                mainHandler.postDelayed(runnable, STROKE_LONG_PRESS_MS)
                return false
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    scaledByPinch = true
                    dragging = false
                    // 双指缩放开始 → 取消长按计时, 直接可缩放
                    cancelStrokeTimer()
                    stroking = false
                    dragArmed = true
                    pinchDist = dist(event)
                }
                return scaledByPinch
            }
            MotionEvent.ACTION_MOVE -> {
                if (scaledByPinch && event.pointerCount >= 2) {
                    val d = dist(event)
                    if (pinchDist > 0) {
                        val ratio = d / pinchDist
                        winW = (winW * ratio).toInt().coerceIn(MIN_W, MAX_W)
                        winH = (winH * ratio).toInt().coerceIn(MIN_H, MAX_H)
                        params.width = winW
                        params.height = winH
                        wm?.updateViewLayout(floatView!!, params)
                        pinchDist = d
                    }
                    return true
                }
                if (event.pointerCount == 1) {
                    val dx = event.rawX - dragStartX
                    val dy = event.rawY - dragStartY
                    val moved = dx * dx + dy * dy
                    if (!dragArmed) {
                        // 0.8s 内: 移动不拖动
                        if (touchMode) {
                            if (moved > STROKE_SLIDE_LIMIT * STROKE_SLIDE_LIMIT) {
                                // 大幅快速滑出: 不弹气泡 (不算抚摸)
                                touchMovedFar = true
                            } else if (moved > STROKE_CANCEL_THRESHOLD * STROKE_CANCEL_THRESHOLD && !stroking) {
                                // 轻微滑动 = 抚摸 (立即反馈, 不等 0.8s)
                                stroking = true
                                triggerFloatStroke()
                            }
                        } else {
                            // 模型外 0.8s 内: 移动也算"快速滑出" (抬起不弹)
                            if (moved > STROKE_SLIDE_LIMIT * STROKE_SLIDE_LIMIT) touchMovedFar = true
                        }
                        return false
                    }
                    // 0.8s 后: 允许拖动 (抚摸转拖动)
                    if (!dragging && moved > DRAG_THRESHOLD * DRAG_THRESHOLD) {
                        dragging = true
                        if (stroking) stroking = false
                        cancelStrokeTimer()
                    }
                    if (dragging) {
                        params.x = winStartX + dx.toInt()
                        params.y = winStartY + dy.toInt()
                        wm?.updateViewLayout(floatView!!, params)
                        return true
                    }
                }
                return false
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (event.pointerCount <= 2) {
                    scaledByPinch = false
                    // 缩放结束: 剩余手指不再是"轻点模型"语义 → 退出触摸模式, 防误弹气泡
                    touchMode = false
                    touchMovedFar = false
                    // 重置拖动起点, 防止缩放手势结束后拖动跳位
                    dragStartX = event.rawX
                    dragStartY = event.rawY
                    winStartX = params.x
                    winStartY = params.y
                    saveState() // 缩放结束: 记忆尺寸
                }
                return scaledByPinch
            }
            MotionEvent.ACTION_UP -> {
                cancelStrokeTimer()
                if (dragging || scaledByPinch) {
                    saveState() // 拖动/缩放结束: 记忆位置与尺寸
                    notifyTouchActive() // 拖动/缩放也算互动 → 重置待机
                    stroking = false
                    return true
                }
                if (stroking) {
                    // 抚摸结束: 不弹气泡, 只结束抚摸表现
                    stroking = false
                    notifyTouchActive()
                    return true
                }
                if (touchMode && !touchMovedFar && !dragArmed) {
                    // 轻点模型 (0.8s 内抬起、几乎没动) → 弹气泡
                    launchFloatBubble()
                }
                // 按住超 0.8s 未拖动 (想拖没拖) / 模型外点按 / 快速滑动 → 不弹气泡 (防误触)
                notifyTouchActive()
                return false
            }
            MotionEvent.ACTION_CANCEL -> {
                cancelStrokeTimer()
                stroking = false
                // 系统打断/手指滑出: 只处理手势, 不触发弹气泡
                return dragging || scaledByPinch
            }
        }
        return dragging || scaledByPinch
    }

    /** 取消长按抚摸计时 */
    private fun cancelStrokeTimer() {
        strokeTimer?.let { mainHandler.removeCallbacks(it) }
        strokeTimer = null
    }

    /** 触发抚摸反馈: 通知悬浮窗页面播抚摸表情 + 轻蹭动作 */
    private fun triggerFloatStroke() {
        try {
            webView?.evaluateJavascript(
                "window.__noriStroke && window.__noriStroke()", null)
        } catch (_: Exception) { /* 忽略 */ }
    }

    private fun dist(e: MotionEvent): Float {
        val x = e.getX(0) - e.getX(1)
        val y = e.getY(0) - e.getY(1)
        return Math.sqrt((x * x + y * y).toDouble()).toFloat()
    }

    /** 按下的屏幕点是否落在模型身体矩形内 (矩形相对窗口, ±20px 容差) */
    private fun isInModelRect(event: MotionEvent, params: WindowManager.LayoutParams, r: IntArray): Boolean {
        val px = event.rawX - params.x
        val py = event.rawY - params.y
        return px >= r[0] - 20 && px <= r[2] + 20 && py >= r[1] - 20 && py <= r[3] + 20
    }

    /** 通知悬浮窗页面: 用户互动了 → 重置待机计时 */
    private fun notifyTouchActive() {
        try {
            webView?.evaluateJavascript("window.__noriTouchActive && window.__noriTouchActive()", null)
        } catch (_: Exception) { /* 忽略 */ }
    }

    /** JS 字符串字面量 (转义引号/反斜杠, 防注入) */
    private fun jsonStr(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""

    // ---------------- 资源拦截 ----------------

    /** 拦截 /live2d/ 路径, 从模型目录读文件 */
    private fun serveModelFile(url: String, modelBridge: ModelBridge): WebResourceResponse? {
        val marker = "/live2d/"
        val idx = url.indexOf(marker)
        if (idx < 0) return null
        val rel = url.substring(idx + marker.length)
        if (rel.isBlank()) return null
        val file = File(modelBridge.modelsDir, rel)
        if (!file.exists() || !file.isFile) return null
        val stream = try { file.inputStream() } catch (_: Exception) { return null }
        return WebResourceResponse(WebAssets.mimeFor(rel), null, stream)
    }

    private fun removeFloat() {
        cancelStrokeTimer() // 清理长按抚摸计时
        stroking = false
        saveState() // 退出前记忆尺寸/位置
        try { floatView?.let { wm?.removeView(it) } } catch (_: Exception) { /* 忽略 */ }
        try { webView?.destroy() } catch (_: Exception) { /* 忽略 */ }
        webView = null
        floatView = null
        floatParams = null
    }
}
