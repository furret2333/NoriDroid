package com.noridroid

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
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
    /** 已提升为前台服务 (避免重复 startForeground / 重复移除通知) */
    private var isForeground = false

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
        // 说明: 前台状态已由 onStartCommand 在调用本方法**之前**建立 (顺序不可调换, 见那里的
        // 注释)。这里只负责把窗口加上, 并把成败回传 —— 失败时调用方会 stopSelf(), 此时
        // startForeground 已清掉 r.fgRequired, 所以结束服务不会触发系统的崩溃判定。
        return try {
            wm?.addView(view, params)
            floatView = view
            floatParams = params
            Log.d(TAG, "float view added ${winW}x$winH @(${params.x},${params.y})")
            true
        } catch (e: Exception) {
            Log.e(TAG, "addView failed", e)
            // 窗口没加上: 把刚创建的 WebView 一起释放, 否则它留着 JS 引擎和渲染循环
            try { webView?.destroy() } catch (_: Exception) { /* 忽略 */ }
            webView = null
            false
        }
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
        b.setSmallIcon(R.drawable.ic_stat_nori)
            .setContentTitle("NoriDroid")
            .setContentText("悬浮窗运行中")
            .setOngoing(true)
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
                if (!WebAssets.isAllowedUrl(url) && !url.startsWith("data:") && !url.startsWith("blob:")) {
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
