package com.noridroid

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicLong

/** 不抢焦点的桌宠窗口。WebView 保留完整画布，原生窗口裁到模型矩形，减少透明区挡手。 */
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
        private var activeService: WeakReference<FloatService>? = null
        private var activeChatToken: IBinder? = null
        private val modelGeneration = AtomicLong()
        private val frameTransitionGeneration = AtomicLong()

        fun beginModelGeometry(): Long {
            val generation = modelGeneration.incrementAndGet()
            activeService?.get()?.let { service -> service.mainHandler.post {
                if (generation != modelGeneration.get()) return@post
                service.geometryGeneration = generation
                service.geometryRevision = 0
                service.modelCropRect = null
                service.preciseCrop = false
                service.pendingGeometryAck = null
                modelRect = null
                modelFeetY = -1
                if (!service.gestureActive && !service.chatTransitionPending) service.updateCrop()
            } }
            return generation
        }

        fun reportVisibleGeometry(report: FloatingModelGeometry) {
            activeService?.get()?.let { service -> service.mainHandler.post {
                if (service.floatView == null || report.generation != modelGeneration.get() ||
                    !acceptsFloatingGeometry(report, service.geometryGeneration, service.geometryRevision, service.winW, service.winH)) return@post
                service.geometryRevision = report.revision
                service.modelCropRect = report.crop
                service.preciseCrop = report.precise
                modelRect = report.hit
                modelFeetY = report.feet
                service.pendingGeometryAck = report.generation to report.revision
                if (!service.gestureActive && !service.chatTransitionPending) { service.updateCrop(); service.acknowledgeGeometry() }
            } }
        }

        fun resetWindow(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_W).remove(KEY_H).remove(KEY_X).remove(KEY_Y).remove(KEY_DENSITY).apply()
            activeService?.get()?.let { service -> service.mainHandler.post { service.resetWindow() } }
        }

        fun reportFrameDrawn(request: Long) {
            activeService?.get()?.let { service -> service.mainHandler.post {
                if (request == service.chatTransitionId && service.chatTransitionPending && service.transitionCover != null) {
                    try {
                        service.webView?.postVisualStateCallback(request, object : WebView.VisualStateCallback() {
                            override fun onComplete(requestId: Long) { service.revealChatModel(requestId) }
                        })
                    } catch (_: Exception) { service.revealChatModel(request) }
                }
            } }
        }

        fun reportModelRect(rect: IntArray, canvasWidth: Int = 0, canvasHeight: Int = 0) {
            activeService?.get()?.let { service ->
                service.mainHandler.post {
                    if (service.floatView == null) return@post
                    if (service.geometryGeneration != 0L) return@post
                    // 丢弃缩放前排队的旧画布几何，避免迟到上报把新窗口裁错。
                    if (canvasWidth > 0 && (kotlin.math.abs(canvasWidth - service.winW) > 3 ||
                        kotlin.math.abs(canvasHeight - service.winH) > 3)) return@post
                    modelRect = rect
                    modelFeetY = rect[3]
                    if (!service.gestureActive) service.updateCrop()
                }
            }
        }

        /** 聊天期间把原模型窗口附到 Activity 下层，避免 SAW + NOT_TOUCHABLE 被系统降到 0.8 alpha。 */
        @androidx.annotation.MainThread
        fun attachChatWindow(token: IBinder) {
            activeChatToken = token
            activeService?.get()?.setChatWindow(token)
        }

        @androidx.annotation.MainThread
        fun detachChatWindow(token: IBinder) {
            if (activeChatToken != token) return
            activeChatToken = null
            // 必须在 Activity.onStop 内同步移走子窗口；post 会晚于父窗口销毁/closeAll。
            activeService?.get()?.let { service ->
                // A prepared close has already detached the child. Keep its desktop
                // cover until the new live frame is ready.
                if (service.attachedChatToken != null || service.pendingChatToken != null) service.setChatWindow(null)
            }
        }

        /** Called before finish(), while the Activity token can still be copied safely. */
        @androidx.annotation.MainThread
        fun prepareChatWindowClose(token: IBinder, ready: () -> Unit) {
            val service = activeService?.get()
            if (activeChatToken != token || service == null) ready()
            else service.setChatWindow(null, ready)
        }
        private const val DEFAULT_W_DP = 180
        private const val DEFAULT_H_DP = 236
        private const val MIN_W_DP = 100
        private const val MIN_H_DP = 140
        private const val MAX_W_DP = 420
        private const val MAX_H_DP = 580
        // 窗口尺寸/位置记忆
        private const val PREFS = "float_window"
        private const val KEY_W = "w"
        private const val KEY_H = "h"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        private const val KEY_DENSITY = "density"
        // 关闭气泡后短时间内不重复打开 (防误触)
        private const val BUBBLE_COOLDOWN_MS = 600L
        private const val MIN_VISIBLE_DP = 48
        private const val CROP_PADDING_DP = 20
        // ES Module 需要 https Origin (file:// 会被浏览器禁止),
        // 故用 appassets 虚拟域名, 再由 shouldInterceptRequest 兜底读取 assets
        private const val ENTRY_URL = "https://appassets.androidplatform.net/assets/float.html"

        // ---- 前台服务 (B3) ----
        // 常驻低优先级通知: 既是 Android 对前台服务的硬性要求, 也是"悬浮窗正在运行"的唯一
        // 可信指示 —— 之前悬浮窗被系统收走时用户完全无从察觉。
        // 注意: 46001/46002 已被 PomodoroEngine 用作通知 id 与 PendingIntent requestCode,
        // 这里另取一组, 避免与番茄钟互相覆盖。
        private const val FGS_NOTIF_ID = 46010
        private const val FGS_PI_REQ = 46011
        private const val FGS_CHANNEL = "float_overlay"

        /**
         * 让悬浮窗服务显示出来 —— **所有** ACTION_SHOW 的调用点都应走这里。
         *
         * 为什么用 startForegroundService (Android 8+): 后台 startService 在"应用空闲 (uid idle)
         * 或没有进程记录"时会被直接拒掉 —— startServiceLocked → getAppStartModeLOSP →
         * appRestrictedInBackgroundLOSP 对 targetSdk O+ 直接返回 DELAYED_RIGID, 于是返回
         * "?" 组件名, ContextImpl 抛 IllegalStateException。这正是悬浮窗"多数时候能出来、
         * 偶尔静默不出来"的来源, 而且 SYSTEM_ALERT_WINDOW 并不能豁免这条路径。
         * (进程还活着且不 idle 时普通 startService 是能过的, 所以问题是间歇性的。)
         *
         * 为什么我们有资格用: AOSP ActiveServices.shouldAllowFgsStartForegroundNoBindingCheckLocked
         * 明确把系统悬浮窗权限列为后台启动前台服务的豁免理由 (REASON_SYSTEM_ALERT_WINDOW_PERMISSION,
         * android14-release L7909-7914), 而本应用正是持有 SYSTEM_ALERT_WINDOW 且只在
         * canDrawOverlays() 通过后才启动悬浮窗。
         *
         * 代价: startForegroundService 要求在 ~5s 内调用 startForeground(), 否则
         * bringDownServiceLocked 会以 ForegroundServiceDidNotStartInTimeException 杀掉进程
         * (android14-release L5600)。所以 FloatService 在 ACTION_SHOW 分支里**第一件事**就是
         * startForeground (见 onStartCommand/promoteToForeground), 绝不拖延。
         */
        fun startShow(ctx: Context) {
            val intent = Intent(ctx, FloatService::class.java).setAction(ACTION_SHOW)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var wm: WindowManager? = null
    private var floatView: View? = null
    private var webView: WebView? = null
    private var floatParams: WindowManager.LayoutParams? = null
    private var cropLeft = 0
    private var cropTop = 0
    private var attachedChatToken: IBinder? = null
    private var chatTransitionId = 0L
    private var chatTransitionPending = false
    private var pendingChatToken: IBinder? = null
    private var transitionCover: FrameLayout? = null
    private var transitionImage: ImageView? = null
    private var transitionTimeout: Runnable? = null
    private var gestureActive = false

    // 窗口状态
    private var winW = 0
    private var winH = 0
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
    /** 按下点在模型身体矩形内 → 轻点弹聊天 */
    private var touchMode = false
    private var touchSlop = 8
    /** 已超过系统触摸容差，抬起不再按轻点处理 */
    private var touchMovedFar = false
    /** 已提升为前台服务 (避免重复 startForeground / 重复移除通知) */
    private var isForeground = false
    private var renderPaused = false
    private var geometryGeneration = 0L
    private var geometryRevision = 0L
    private var modelCropRect: IntArray? = null
    private var preciseCrop = false
    private var pendingGeometryAck: Pair<Long, Long>? = null

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
                else setRenderPaused(paused)
            }
            else -> {
                // 显示悬浮窗 (B3)。顺序是**被 AOSP 强制**的, 不能调换:
                //
                //  ① 先 startForeground()。ACTION_SHOW 现在由 startForegroundService 拉起,
                //     系统要求 ~5s 内进入前台, 否则 bringDownServiceLocked 会以
                //     ForegroundServiceDidNotStartInTimeException **崩掉整个进程**
                //     (android14-release ActiveServices.java L5600-5626)。所以第一件事就是它。
                //  ② 再 addView。万一失败, 此时 r.fgRequired 已被 startForeground 清掉
                //     (同文件 L2070-2078), stopSelf() 是安全的; 反过来先 addView 后
                //     startForeground 的话, addView 失败时的 stopSelf() 正好落进上面那个
                //     崩溃分支 —— 等于把"悬浮窗没显示"升级成"应用崩溃"。
                //
                // 这里 stopSelf() 之所以一定安全: setServiceForegroundInnerLocked 里可能抛异常的
                // 只有两处发生在清 r.fgRequired 的 L2070 **之前** —— L2025 enforcePermission(
                // FOREGROUND_SERVICE) 与 L2053 "请求类型必须是 manifest 类型的子集" 检查。
                // 这两条由 AndroidManifest.xml 保证满足 (已声明 FOREGROUND_SERVICE 且
                // requested type == manifest type), 而 verify-floatservice-fgs.mjs 会盯住它们。
                // 其余失败 (L2098 app op / L2297 bg 限制 / L2335 类型权限) 都在 L2070 之后,
                // 届时 fgRequired 已清、超时消息已撤, stopSelf() 不会触发崩溃判定。
                promoteToForeground()
                if (!showFloat()) {
                    Log.w(TAG, "showFloat failed → stopSelf (不留空转的前台服务)")
                    LifecycleLog.record(this, "floatShowFailed", "addView 失败, 服务已停止")
                    stopSelf()
                }
            }
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
        // 所有 stopSelf 路径都汇到这里 (ACTION_HIDE / onTaskRemoved / 没有窗口时的
        // ACTION_SET_PAUSED / showFloat 失败): 统一解除前台状态, 保证常驻通知不会变成
        // "通知还在, 悬浮窗早没了" 的残留。
        demoteFromForeground()
        super.onDestroy()
    }

    // ---------------- 窗口 ----------------

    /**
     * 显示悬浮窗。返回是否**真的**加上了窗口 —— 调用方据此决定要不要留在前台。
     *
     * 改动 (B3): 以前这里失败只 `Log.e` 一句就返回, 服务继续空转, 用户什么也看不到。
     * 现在把成功与否回传, 失败时由 onStartCommand 结束服务并解除前台状态, 不再留下
     * "前台通知挂着、屏幕上却没有 Nori" 的假象。
     */
    private fun showFloat(): Boolean {
        if (floatView != null) return true
        if (!android.provider.Settings.canDrawOverlays(this)) return false
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        activeService = WeakReference(this)
        modelRect = null
        modelFeetY = -1
        touchSlop = ViewConfiguration.get(this).scaledTouchSlop
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val density = resources.displayMetrics.density
        val oldDensity = prefs.getFloat(KEY_DENSITY, density).takeIf { it > 0f } ?: density
        val scale = density / oldDensity
        val bounds = safeFloatBounds()
        val requestedW = if (prefs.contains(KEY_W)) (prefs.getInt(KEY_W, 0) * scale).toInt() else dp(DEFAULT_W_DP)
        val requestedH = if (prefs.contains(KEY_H)) (prefs.getInt(KEY_H, 0) * scale).toInt() else dp(DEFAULT_H_DP)
        val restored = scaleFloatingSize(requestedW, requestedH, 1f, dp(MIN_W_DP), dp(MIN_H_DP),
            dp(MAX_W_DP), dp(MAX_H_DP))
        winW = restored.first
        winH = restored.second
        cropLeft = 0; cropTop = 0
        attachedChatToken = null
        val view = buildFloatView()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        val params = WindowManager.LayoutParams(
            winW, winH, type,
            // 永远不可聚焦: 不抢桌面焦点, 桌面操作不受影响
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setFitInsetsTypes(0)
            x = if (prefs.contains(KEY_X)) (prefs.getInt(KEY_X, 0) * scale).toInt() else bounds.left + dp(28)
            y = if (prefs.contains(KEY_Y)) (prefs.getInt(KEY_Y, 0) * scale).toInt() else bounds.top + dp(72)
            applyFloatWindowMode(this, null)
            val fitted = positionFloatingModel(x, y, width, height, null, bounds, dp(MIN_VISIBLE_DP))
            x = fitted.x; y = fitted.y
        }
        // 说明: 前台状态已由 onStartCommand 在调用本方法**之前**建立 (顺序不可调换, 见那里的
        // 注释)。这里只负责把窗口加上, 并把成败回传 —— 失败时调用方会 stopSelf(), 此时
        // startForeground 已清掉 r.fgRequired, 所以结束服务不会触发系统的崩溃判定。
        return try {
            wm?.addView(view, params)
            floatView = view
            floatParams = params
            view.setOnApplyWindowInsetsListener { v, insets ->
                updateCrop()
                v.onApplyWindowInsets(insets)
            }
            activeChatToken?.let { setChatWindow(it) }
            Log.d(TAG, "float view added ${winW}x$winH @(${params.x},${params.y})")
            true
        } catch (e: Exception) {
            Log.e(TAG, "addView failed", e)
            // 窗口没加上: 把刚创建的 WebView 一起释放, 否则它留着 JS 引擎和渲染循环
            try { webView?.let { destroyNoriWebView(it) } } catch (_: Exception) { /* 忽略 */ }
            webView = null
            false
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun safeFloatBounds(): FloatingBounds = floatingScreenBounds(this)

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        updateCrop(true)
    }

    /** 用最新矩形缩小 native 窗口；WebView 保留完整画布坐标，避免无变化时重复更新布局。 */
    private fun updateCrop(clampPosition: Boolean = false) {
        if (floatView == null) return
        if (chatTransitionPending) return
        if (gestureActive && !scaledByPinch) return
        val child = webView ?: return
        val params = floatParams ?: return
        val fullX = params.x - cropLeft
        val fullY = params.y - cropTop
        val bounds = safeFloatBounds()
        val crop = modelWindowCrop(winW, winH, if (geometryGeneration != 0L) modelCropRect else modelRect,
            dp(if (preciseCrop) CROP_PADDING_DP else 28))
        // Geometry updates change only the crop. Keep the complete canvas anchored on screen.
        val fitted = if (clampPosition) positionFloatingModel(fullX, fullY, winW, winH, modelRect, bounds, dp(MIN_VISIBLE_DP))
            else FloatingFrame(fullX, fullY, winW, winH)
        cropLeft = crop.x
        cropTop = crop.y
        val childParams = child.layoutParams as FrameLayout.LayoutParams
        if (childParams.width != winW || childParams.height != winH ||
            childParams.leftMargin != -cropLeft || childParams.topMargin != -cropTop) {
            childParams.width = winW
            childParams.height = winH
            childParams.leftMargin = -cropLeft
            childParams.topMargin = -cropTop
            child.layoutParams = childParams
        }
        val nextX = fitted.x + cropLeft
        val nextY = fitted.y + cropTop
        if (params.x == nextX && params.y == nextY && params.width == crop.width &&
            params.height == crop.height) return
        params.x = nextX
        params.y = nextY
        params.width = crop.width
        params.height = crop.height
        submitFloatLayout()
    }

    private fun acknowledgeGeometry() {
        if (chatTransitionPending) return
        val (generation, revision) = pendingGeometryAck ?: return
        if (!submitFloatLayout()) return
        pendingGeometryAck = null
        webView?.evaluateJavascript("window.__noriFloatGeometryApplied && window.__noriFloatGeometryApplied($generation,$revision)", null)
    }

    private fun resetWindow() {
        chatTransitionId = frameTransitionGeneration.incrementAndGet()
        finishChatTransition()
        val params = floatParams ?: return
        val bounds = safeFloatBounds()
        gestureActive = false
        dragging = false
        scaledByPinch = false
        scaleModelGeometry(dp(DEFAULT_W_DP), dp(DEFAULT_H_DP))
        params.x = bounds.left + dp(28) + cropLeft
        params.y = bounds.top + (bounds.height - winH) / 3 + cropTop
        updateCrop(true)
        acknowledgeGeometry()
        saveState()
    }

    private fun setRenderPaused(paused: Boolean) {
        renderPaused = paused
        webView?.let { view ->
            view.evaluateJavascript(
                "window.__noriFloatNativePaused = $paused; window.__noriSetPaused && window.__noriSetPaused($paused)", null)
            if (paused) view.onPause() else view.onResume()
        }
    }

    private fun setChatWindow(token: IBinder?, onDetached: (() -> Unit)? = null) {
        // onStop must cancel an unfinished close and detach synchronously, before token teardown.
        if (chatTransitionPending && pendingChatToken == token && token != null) return
        var notified = false
        val ready = {
            if (!notified) { notified = true; onDetached?.invoke() }
        }
        val request = frameTransitionGeneration.incrementAndGet().also { chatTransitionId = it }
        finishChatTransition()
        if (attachedChatToken == token) { ready(); return }
        val root = floatView as? FrameLayout ?: run { ready(); return }
        val params = floatParams ?: run { ready(); return }
        val sourceToken = attachedChatToken
        val opening = token != null && sourceToken == null
        val closing = token == null && sourceToken != null && onDetached != null
        if ((opening || closing) && !renderPaused && Build.VERSION.SDK_INT >= 34 && root.isAttachedToWindow) {
            chatTransitionPending = true
            pendingChatToken = token
            copyFloatingFrame(root, mainHandler) { bitmap ->
                val expectedToken = if (opening) token else sourceToken
                if (request != chatTransitionId || root !== floatView || activeChatToken != expectedToken) {
                    bitmap?.recycle()
                    ready()
                    return@copyFloatingFrame
                }
                if (bitmap == null || bitmap.width != params.width || bitmap.height != params.height) {
                    LifecycleLog.record(this, "floatChatFrameCopyUnavailable", "using direct window reattachment")
                    bitmap?.recycle()
                    chatTransitionPending = false
                    pendingChatToken = null
                    reattachChatWindow(token)
                    updateCrop(); acknowledgeGeometry()
                    ready()
                } else beginCoveredChatWindow(root, params, token, bitmap, request, ready)
            }
        } else { reattachChatWindow(token); ready() }
    }

    @android.annotation.TargetApi(34)
    private fun beginCoveredChatWindow(oldRoot: FrameLayout, previous: WindowManager.LayoutParams,
        token: IBinder?, bitmap: Bitmap, request: Long, ready: () -> Unit) {
        val manager = wm ?: run { bitmap.recycle(); chatTransitionPending = false; ready(); return }
        val child = webView ?: run { bitmap.recycle(); chatTransitionPending = false; ready(); return }
        val sourceToken = attachedChatToken
        // A closing transition needs its own desktop cover: the Activity's child window
        // cannot survive finish(). Opening can continue to use the original desktop root.
        val cover = if (token == null) FrameLayout(this) else oldRoot
        val image = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_XY
            setImageBitmap(bitmap)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        transitionCover = cover
        transitionImage = image
        cover.addView(image, FrameLayout.LayoutParams(-1, -1))
        val coverParams = if (cover !== oldRoot) WindowManager.LayoutParams().apply {
            copyFrom(previous)
            applyFloatWindowMode(this, null)
            alpha = 0f
        } else null
        if (coverParams != null) {
            try { manager.addView(cover, coverParams) }
            catch (error: Exception) {
                LifecycleLog.record(this, "floatChatFrameCopyUnavailable", "close cover: ${error.javaClass.simpleName}")
                finishChatTransition()
                reattachChatWindow(token)
                ready()
                return
            }
        } else child.alpha = 0f // Same root: replace live pixels rather than blend two copies.
        // Wait for the cover's actual hardware frame, rather than merely posting a delay.
        cover.viewTreeObserver.registerFrameCommitCallback {
            mainHandler.post {
                if (request != chatTransitionId || oldRoot !== floatView || !chatTransitionPending || transitionCover !== cover) return@post
                val childParams = child.layoutParams
                val nextRoot = FrameLayout(this).apply { clipChildren = true }
                val next = WindowManager.LayoutParams().apply {
                    copyFrom(previous)
                    applyFloatWindowMode(this, token)
                    alpha = 0f // The old window holds the visible frame while WebView reattaches.
                }
                try {
                    if (coverParams != null) {
                        coverParams.alpha = 1f
                        manager.updateViewLayout(cover, coverParams)
                    }
                    oldRoot.removeView(child)
                    child.alpha = 1f
                    nextRoot.addView(child, childParams)
                    manager.addView(nextRoot, next)
                    floatView = nextRoot
                    floatParams = next
                    attachedChatToken = token
                    if (cover !== oldRoot) {
                        manager.removeViewImmediate(oldRoot)
                    }
                    nextRoot.setOnApplyWindowInsetsListener { v, insets -> updateCrop(); v.onApplyWindowInsets(insets) }
                    child.evaluateJavascript("window.__noriFloatFrameRequest = $request", null)
                    ready()
                } catch (error: Exception) {
                    Log.w(TAG, "covered chat attach failed; keeping desktop window", error)
                    LifecycleLog.record(this, "floatChatAttachFailed", "covered switch: ${error.javaClass.simpleName}")
                    try { if (nextRoot.isAttachedToWindow) manager.removeViewImmediate(nextRoot) } catch (_: Exception) {}
                    nextRoot.removeView(child)
                    if (child.parent == null) oldRoot.addView(child, 0, childParams)
                    floatView = oldRoot
                    floatParams = previous
                    attachedChatToken = sourceToken
                    finishChatTransition()
                    if (token == null) reattachChatWindow(null)
                    ready()
                }
            }
        }
        cover.invalidate()
        transitionTimeout = Runnable {
            if (request == chatTransitionId && chatTransitionPending) {
                LifecycleLog.record(this, "floatChatTransitionTimeout", "new model frame not confirmed within 1800ms")
                if (floatView === oldRoot) {
                    finishChatTransition()
                    reattachChatWindow(token)
                } else revealChatModel(request)
                ready()
            }
        }.also { mainHandler.postDelayed(it, 1800) }
    }

    private fun revealChatModel(request: Long) {
        if (request != chatTransitionId || !chatTransitionPending) return
        val root = floatView ?: return
        val params = floatParams ?: return
        params.alpha = 1f
        if (!submitFloatLayout()) { finishChatTransition(); return }
        root.invalidate()
        root.postOnAnimation { root.postOnAnimation {
            if (request == chatTransitionId) finishChatTransition()
        } }
    }

    private fun finishChatTransition() {
        transitionTimeout?.let { mainHandler.removeCallbacks(it) }
        transitionTimeout = null
        val cover = transitionCover
        transitionCover = null
        if (cover != null && cover !== floatView) {
            try { wm?.removeViewImmediate(cover) } catch (_: Exception) {}
        } else transitionImage?.let { cover?.removeView(it) }
        transitionImage?.setImageDrawable(null)
        transitionImage = null
        webView?.alpha = 1f
        // HWUI may still retain a submitted display list; let it release the drawn bitmap.
        chatTransitionPending = false
        pendingChatToken = null
        floatParams?.let { if (it.alpha != 1f) { it.alpha = 1f; submitFloatLayout() } }
        updateCrop()
        acknowledgeGeometry()
    }

    private fun reattachChatWindow(token: IBinder?) {
        val root = floatView ?: return
        val manager = wm ?: return
        val previous = floatParams ?: return
        val next = WindowManager.LayoutParams().apply {
            copyFrom(previous)
            applyFloatWindowMode(this, token)
        }
        // WindowManager 不允许原地改窗口类型；只重挂 native 根视图，保留同一 WebView/模型实例。
        try {
            manager.removeViewImmediate(root)
        } catch (e: IllegalArgumentException) {
            // 父窗口被系统提前清理时，根视图已不在 WindowManager 中，仍尝试重新附着。
            Log.w(TAG, "model window was already detached", e)
        } catch (e: Exception) {
            Log.w(TAG, "detach model window failed", e)
            return
        }
        floatParams = next
        try {
            manager.addView(root, next)
            attachedChatToken = token
        } catch (e: Exception) {
            Log.w(TAG, "attach model window failed; restoring desktop overlay", e)
            LifecycleLog.record(this, "floatChatAttachFailed", "${e.javaClass.simpleName}: ${e.message}")
            applyFloatWindowMode(next, null)
            attachedChatToken = null
            try { manager.addView(root, next) }
            catch (fallback: Exception) {
                Log.e(TAG, "restore model overlay failed", fallback)
                removeFloat()
                stopSelf()
            }
        }
    }

    private fun submitFloatLayout(): Boolean {
        val root = floatView ?: return false
        val params = floatParams ?: return false
        val manager = wm ?: return false
        return try { manager.updateViewLayout(root, params); true }
        catch (e: Exception) { Log.w(TAG, "update float layout failed", e); false }
    }

    private fun scaleModelGeometry(width: Int, height: Int) {
        if (width == winW && height == winH) return
        val sy = height.toFloat() / winH
        modelRect = modelRect?.let { r ->
            val sx = width.toFloat() / winW
            intArrayOf((r[0] * sx).toInt(), (r[1] * sy).toInt(), (r[2] * sx).toInt(), (r[3] * sy).toInt())
        }
        modelCropRect = modelCropRect?.let { r ->
            val sx = width.toFloat() / winW
            intArrayOf((r[0] * sx).toInt(), (r[1] * sy).toInt(), (r[2] * sx).toInt(), (r[3] * sy).toInt())
        }
        if (modelFeetY > 0) modelFeetY = (modelFeetY * sy).toInt()
        winW = width
        winH = height
    }

    private fun applyFloatWindowMode(params: WindowManager.LayoutParams, chatToken: IBinder?) {
        val base = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        params.type = if (chatToken != null) WindowManager.LayoutParams.TYPE_APPLICATION_MEDIA
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        params.token = chatToken
        params.flags = if (chatToken != null) base or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else base
        params.alpha = 1f
    }

    /**
     * 提升为前台服务 (B3)。必须在处理 ACTION_SHOW 时**最优先**调用。
     *
     * 为什么不能吞异常: 本服务是被 startForegroundService 拉起的, 若不进入前台, 系统会在
     * ~5s 后主动杀掉进程 (ForegroundServiceDidNotStartInTimeException)。所以这里尽力成功 ——
     * 显式类型失败就退回 "按 Manifest 类型" 的旧重载再试一次, 并把原因记进 lifecycle.log。
     *
     * 已知无法从应用侧察觉的例外: 若系统的 OP_START_FOREGROUND app-op 被设为 IGNORED,
     * AOSP (ActiveServices L2091-2096) 会**静默忽略**这次 startForeground —— 既不抛异常也不
     * 真正进入前台。此时下面的 isForeground 会偏乐观。该 app-op 一般不由用户直接控制,
     * 概率很低; 这里选择不额外探测 (例如查 getActiveNotifications() 在时序上有竞态,
     * 会造成假告警), 代价仅是 demoteFromForeground() 多调一次无害的 stopForeground()。
     */
    private fun promoteToForeground() {
        if (isForeground) return
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
                // IMPORTANCE_LOW: 常驻但不发声、不弹横幅 (悬浮窗只是待在桌面上)
                nm.createNotificationChannel(
                    NotificationChannel(FGS_CHANNEL, "悬浮窗", NotificationManager.IMPORTANCE_LOW)
                )
            }
            val n = buildForegroundNotification()
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    // Android 14+: 显式给出与 Manifest 一致的类型
                    startForeground(FGS_NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                } else {
                    startForeground(FGS_NOTIF_ID, n)
                }
            } catch (e: Exception) {
                // 典型原因: 类型与 Manifest 不一致 (MissingForegroundServiceTypeException)。
                // 退回两参重载 = FOREGROUND_SERVICE_TYPE_MANIFEST, 直接用 Manifest 里声明的类型。
                Log.w(TAG, "startForeground(typed) failed, retry with manifest type", e)
                startForeground(FGS_NOTIF_ID, n)
            }
            isForeground = true
        } catch (e: Exception) {
            // 前台状态没建立起来 (权限被拒 / ROM 限制 / 渠道被禁)。这里**不** stopSelf, 原因是
            // 分两种情形, 两种都不该结束服务:
            //   · 异常发生在系统清 r.fgRequired (ActiveServices L2070) 之后 —— 绝大多数情况
            //     (L2098 app op 被拒 / L2297 后台限制 / L2335 specialUse 权限被拒): 此时
            //     前台契约已解除, 服务只是"没进前台"而不是"违约"。结束它等于把悬浮窗也一起
            //     关掉, 用户什么都没了; 留着至少在 Android 13 及以下仍能正常显示。
            //     (Android 14+ 系统会在稍后收走非前台服务的 OVERLAY 窗口, 这是系统的行为,
            //     不是我们能绕过的 —— 用户据此能看到"通知没了"从而知道没进前台。)
            //   · 异常发生在 L2070 之前 (只有两处: L2025 缺 FOREGROUND_SERVICE 权限、
            //     L2053 请求类型不是 manifest 类型的子集): 那种情况下 fgRequired 仍为 true,
            //     系统超时后**一定**会杀掉进程, 我们停不停都救不回来。这两处由
            //     AndroidManifest.xml 的声明保证不成立, 且 verify-floatservice-fgs.mjs 会盯住。
            // 无论哪种, 都把原因落盘 —— 这是"悬浮窗静默不出现"唯一可查的证据。
            Log.e(TAG, "startForeground failed", e)
            LifecycleLog.record(this, "floatForegroundFailed", "${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** 常驻通知: 点一下回到主界面 */
    private fun buildForegroundNotification(): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pi = launch?.let {
            PendingIntent.getActivity(
                this, FGS_PI_REQ, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, FGS_CHANNEL)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)
        val stop = PendingIntent.getService(
            this, FGS_PI_REQ + 1, Intent(this, FloatService::class.java).setAction(ACTION_HIDE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        b.setSmallIcon(R.drawable.ic_stat_nori)
            .setContentTitle("NoriDroid")
            .setContentText("悬浮窗运行中")
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "关闭悬浮窗", stop)
        pi?.let { b.setContentIntent(it) }
        return b.build()
    }

    /** 退出前台状态 (停服务前调用; 通知随之消失) */
    private fun demoteFromForeground() {
        if (!isForeground) return
        isForeground = false
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (e: Exception) {
            Log.e(TAG, "stopForeground failed", e)
        }
    }

    /** 记忆当前尺寸/位置, 下次启动悬浮窗时恢复 */
    private fun saveState() {
        try {
            val p = floatParams ?: return
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt(KEY_W, winW)
                .putInt(KEY_H, winH)
                .putInt(KEY_X, p.x - cropLeft)
                .putInt(KEY_Y, p.y - cropTop)
                .putFloat(KEY_DENSITY, resources.displayMetrics.density)
                .apply()
        } catch (_: Exception) { /* 忽略 */ }
    }

    /** 轻点模型打开聊天，传入完整画布原点，保持物理像素坐标一致。 */
    private fun launchFloatBubble() {
        if (FloatBubbleActivity.isOpen) return
        val now = SystemClock.uptimeMillis()
        if (now - lastBubbleAt < BUBBLE_COOLDOWN_MS) return
        lastBubbleAt = now
        try {
            val p = floatParams
            val intent = Intent(this, FloatBubbleActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(FloatBubbleActivity.EXTRA_X, (p?.x ?: 80) - cropLeft)
                putExtra(FloatBubbleActivity.EXTRA_Y, (p?.y ?: 200) - cropTop)
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
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
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
                setRenderPaused(renderPaused)
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
        return FrameLayout(this).apply {
            clipChildren = true
            addView(wv, FrameLayout.LayoutParams(winW, winH))
        }
    }

    // ---------------- 触摸手势 ----------------

    private fun handleFloatTouch(event: MotionEvent): Boolean {
        val params = floatParams ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                gestureActive = true
                dragging = false
                scaledByPinch = false
                touchMovedFar = false
                dragStartX = event.rawX
                dragStartY = event.rawY
                winStartX = params.x
                winStartY = params.y
                val r = modelRect
                touchMode = !FloatBubbleActivity.isOpen && r != null && isInModelRect(event, params, r)
                notifyTouchActive()
                // 首先交给 WebView，保留 Live2D 的轻点/抚摸；越过 touch slop 后转为原生拖动。
                return false
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    cancelWebTouch(event)
                    scaledByPinch = true
                    dragging = false
                    pinchDist = dist(event)
                    touchMode = false
                    touchMovedFar = true
                }
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (scaledByPinch && event.pointerCount >= 2) {
                    val d = dist(event)
                    if (pinchDist > 0) {
                        val ratio = (d / pinchDist).coerceIn(0.85f, 1.18f)
                        resizeFloat(ratio)
                        pinchDist = d.coerceAtLeast(1f)
                    }
                    return true
                }
                if (scaledByPinch) return true
                if (event.pointerCount == 1) {
                    val dx = event.rawX - dragStartX
                    val dy = event.rawY - dragStartY
                    val moved = dx * dx + dy * dy
                    if (!dragging && moved > touchSlop * touchSlop) {
                        dragging = true
                        touchMovedFar = true
                        cancelWebTouch(event)
                    }
                    if (dragging) {
                        val frame = positionFloatingModel(
                            winStartX - cropLeft + dx.toInt(), winStartY - cropTop + dy.toInt(),
                            winW, winH, modelRect, safeFloatBounds(), dp(MIN_VISIBLE_DP),
                        )
                        params.x = frame.x + cropLeft
                        params.y = frame.y + cropTop
                        submitFloatLayout()
                        return true
                    }
                }
                return false
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (event.pointerCount <= 2) {
                    // 保留缩放标记直到最后一指抬起，避免剩余手指跳位或触发聊天。
                    pinchDist = 0f
                    touchMode = false
                    touchMovedFar = true
                    saveState()
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                gestureActive = false
                updateCrop()
                acknowledgeGeometry()
                if (dragging || scaledByPinch) {
                    saveState()
                    notifyTouchActive()
                    dragging = false
                    scaledByPinch = false
                    touchMode = false
                    return true
                }
                if (touchMode && !touchMovedFar) {
                    launchFloatBubble()
                }
                notifyTouchActive()
                touchMode = false
                return false
            }
            MotionEvent.ACTION_CANCEL -> {
                val handled = dragging || scaledByPinch
                gestureActive = false
                updateCrop()
                acknowledgeGeometry()
                if (dragging || scaledByPinch) saveState()
                dragging = false
                scaledByPinch = false
                touchMode = false
                touchMovedFar = false
                return handled
            }
        }
        return true
    }

    private fun resizeFloat(ratio: Float) {
        val params = floatParams ?: return
        val oldW = winW
        val oldH = winH
        val (newW, newH) = scaleFloatingSize(
            winW, winH, ratio, dp(MIN_W_DP), dp(MIN_H_DP),
            dp(MAX_W_DP), dp(MAX_H_DP),
        )
        if (newW == oldW && newH == oldH) return
        val centerX = params.x - cropLeft + oldW / 2
        val centerY = params.y - cropTop + oldH / 2
        scaleModelGeometry(newW, newH)
        val frame = positionFloatingModel(centerX - winW / 2, centerY - winH / 2, winW, winH,
            modelRect, safeFloatBounds(), dp(MIN_VISIBLE_DP))
        params.x = frame.x + cropLeft
        params.y = frame.y + cropTop
        updateCrop()
    }

    private fun cancelWebTouch(event: MotionEvent) {
        val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
        try { webView?.onTouchEvent(cancel) } finally { cancel.recycle() }
    }

    private fun dist(e: MotionEvent): Float {
        val x = e.getX(0) - e.getX(1)
        val y = e.getY(0) - e.getY(1)
        return Math.sqrt((x * x + y * y).toDouble()).toFloat()
    }

    /** 按下的屏幕点是否落在模型矩形内 (矩形相对完整画布; 原生触摸点相对裁剪窗口)。 */
    private fun isInModelRect(event: MotionEvent, params: WindowManager.LayoutParams, r: IntArray): Boolean {
        val px = event.rawX - params.x + cropLeft
        val py = event.rawY - params.y + cropTop
        val margin = dp(12)
        return px >= r[0] - margin && px <= r[2] + margin && py >= r[1] - margin && py <= r[3] + margin
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
        chatTransitionId = frameTransitionGeneration.incrementAndGet()
        finishChatTransition()
        saveState() // 退出前记忆尺寸/位置
        try { floatView?.let { wm?.removeViewImmediate(it) } } catch (_: Exception) { /* 忽略 */ }
        try { webView?.let { destroyNoriWebView(it) } } catch (_: Exception) { /* 忽略 */ }
        webView = null
        floatView = null
        floatParams = null
        modelRect = null
        modelFeetY = -1
        modelCropRect = null
        preciseCrop = false
        pendingGeometryAck = null
        geometryGeneration = 0
        geometryRevision = 0
        attachedChatToken = null
        gestureActive = false
        mainHandler.removeCallbacksAndMessages(null)
        if (activeService?.get() === this) activeService = null
    }
}
