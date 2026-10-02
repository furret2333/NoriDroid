package com.noridroid

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * 番茄钟引擎 (进程级单例): 计时本体, 与 WebView 生命周期解耦.
 *
 * - 状态唯一来源是 SharedPreferences(pomo_engine): 引擎/接收器/桥多入口读写一致,
 *   WebView 崩溃重载后 pomoState() 照常恢复
 * - Handler 负责进程存活时的准点触发; AlarmManager(setAndAllowWhileIdle)兜底——
 *   进程被杀时由 PomodoroAlarmReceiver 唤起并补发系统通知 (通知始终会发)
 * - 推送: attach 的所有 WebView 都会收到 window.__noriPomoEvent("end"), 页面无 handler 则 no-op
 * - 正向计时 (countUp) 无到点语义, 不安排 Handler/闹钟
 */
object PomodoroEngine {
    private const val PREFS = "pomo_engine"
    private const val CHANNEL = "pomodoro"
    private const val NOTIF_ID = 46001
    private const val ALARM_REQ = 46002

    private val handler = Handler(Looper.getMainLooper())
    private val targets = java.util.Collections.synchronizedList(ArrayList<WeakReference<WebView>>())

    // ---- prefs 读写 (所有状态的唯一来源) ----
    private fun p(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun save(ctx: Context, phase: String, paused: Boolean, endAt: Long, remainMs: Long,
                     startedAt: Long, pausedAccum: Long, pausedAt: Long,
                     focusMin: Int, breakMin: Int, autoBreak: Boolean) {
        p(ctx).edit()
            .putString("phase", phase).putBoolean("paused", paused)
            .putLong("endAt", endAt).putLong("remainMs", remainMs)
            .putLong("startedAt", startedAt).putLong("pausedAccum", pausedAccum).putLong("pausedAt", pausedAt)
            .putInt("focusMin", focusMin).putInt("breakMin", breakMin).putBoolean("autoBreak", autoBreak)
            .apply()
    }

    /** state(): 返回给 WebView 的完整状态快照 */
    fun state(ctx: Context): String {
        val sp = p(ctx)
        val o = JSONObject()
        o.put("phase", sp.getString("phase", "idle"))
        o.put("paused", sp.getBoolean("paused", false))
        o.put("endAt", sp.getLong("endAt", 0))
        o.put("remainMs", sp.getLong("remainMs", 0))
        o.put("startedAt", sp.getLong("startedAt", 0))
        o.put("focusMin", sp.getInt("focusMin", 25))
        o.put("breakMin", sp.getInt("breakMin", 5))
        o.put("autoBreak", sp.getBoolean("autoBreak", true))
        o.put("now", System.currentTimeMillis())
        return o.toString()
    }

    @Synchronized
    fun start(ctx: Context, focusMin: Int, breakMin: Int, autoBreak: Boolean): String {
        val now = System.currentTimeMillis()
        val f = focusMin.coerceIn(1, 240)
        val b = breakMin.coerceIn(1, 60)
        save(ctx, "focus", false, now + f * 60_000L, 0, now, 0, 0, f, b, autoBreak)
        schedule(ctx)
        return state(ctx)
    }

    @Synchronized
    fun startCountUp(ctx: Context): String {
        val now = System.currentTimeMillis()
        save(ctx, "countUp", false, 0, 0, now, 0, 0, 0, 0, false)
        return state(ctx)
    }

    @Synchronized
    fun pause(ctx: Context): String {
        val sp = p(ctx)
        val phase = sp.getString("phase", "idle") ?: "idle"
        if (phase == "idle" || sp.getBoolean("paused", false)) return state(ctx)
        val now = System.currentTimeMillis()
        val remain = if (phase == "countUp") now - sp.getLong("startedAt", now)
        else (sp.getLong("endAt", now) - now).coerceAtLeast(0)
        sp.edit().putBoolean("paused", true).putLong("remainMs", remain)
            .putLong("pausedAt", now).apply()
        cancelTickAndAlarm(ctx)
        return state(ctx)
    }

    @Synchronized
    fun resume(ctx: Context): String {
        val sp = p(ctx)
        val phase = sp.getString("phase", "idle") ?: "idle"
        if (phase == "idle" || !sp.getBoolean("paused", false)) return state(ctx)
        val now = System.currentTimeMillis()
        val remain = sp.getLong("remainMs", 0)
        val accum = sp.getLong("pausedAccum", 0) + (now - sp.getLong("pausedAt", now))
        if (phase == "countUp") {
            sp.edit().putBoolean("paused", false).putLong("startedAt", now - remain)
                .putLong("pausedAccum", accum).apply()
        } else {
            sp.edit().putBoolean("paused", false).putLong("endAt", now + remain)
                .putLong("pausedAccum", accum).apply()
            schedule(ctx)
        }
        return state(ctx)
    }

    /** 放弃/结束: 返回 endedPhase + elapsedMs (分钟统计用), 引擎回 idle */
    @Synchronized
    fun stop(ctx: Context): String {
        val sp = p(ctx)
        val phase = sp.getString("phase", "idle") ?: "idle"
        val now = System.currentTimeMillis()
        var elapsedMs = 0L
        if (phase != "idle") {
            val startedAt = sp.getLong("startedAt", now)
            val accum = sp.getLong("pausedAccum", 0) +
                (if (sp.getBoolean("paused", false)) now - sp.getLong("pausedAt", now) else 0)
            elapsedMs = (now - startedAt - accum).coerceAtLeast(0)
        }
        cancelTickAndAlarm(ctx)
        save(ctx, "idle", false, 0, 0, 0, 0, 0, sp.getInt("focusMin", 25), sp.getInt("breakMin", 5), sp.getBoolean("autoBreak", true))
        val o = JSONObject(state(ctx))
        o.put("endedPhase", phase)
        o.put("elapsedMs", elapsedMs)
        return o.toString()
    }

    // ---- 到点 ----
    private val tickRunnable = Runnable { tick() }

    private fun schedule(ctx: Context) {
        val sp = p(ctx)
        if (sp.getBoolean("paused", false)) return
        val phase = sp.getString("phase", "idle") ?: return
        if (phase != "focus" && phase != "break") return
        val endAt = sp.getLong("endAt", 0)
        val delay = (endAt - System.currentTimeMillis()).coerceAtLeast(0)
        handler.removeCallbacks(tickRunnable)
        handler.postDelayed(tickRunnable, delay)
        // 闹钟兜底: 进程被杀后由接收器补发通知
        runCatching {
            val am = ctx.applicationContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            val pi = PendingIntent.getBroadcast(
                ctx.applicationContext, ALARM_REQ,
                Intent(ctx.applicationContext, PomodoroAlarmReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endAt, pi)
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, endAt, pi)
            }
        }
    }

    private fun cancelTickAndAlarm(ctx: Context) {
        handler.removeCallbacks(tickRunnable)
        runCatching {
            val am = ctx.applicationContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            val pi = PendingIntent.getBroadcast(
                ctx.applicationContext, ALARM_REQ,
                Intent(ctx.applicationContext, PomodoroAlarmReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            am.cancel(pi)
        }
    }

    /** Handler 准点触发 */
    private fun tick() {
        val ctx = appCtx ?: return
        completeIfDue(ctx)
    }

    /** 引擎持有的 application context (ChatBridge 首次调用时注入) */
    @Volatile
    var appCtx: Context? = null
        private set

    fun ensure(ctx: Context) {
        if (appCtx == null) appCtx = ctx.applicationContext
    }

    /** 到点判定: Handler 与闹钟接收器共用; prefs.phase 已是 idle 说明另一条路已完成, 幂等跳过 */
    @Synchronized
    fun completeIfDue(ctx0: Context) {
        val ctx = ctx0.applicationContext
        ensure(ctx)
        val sp = p(ctx)
        val phase = sp.getString("phase", "idle") ?: "idle"
        if (phase != "focus" && phase != "break") return
        if (sp.getBoolean("paused", false)) return
        val endAt = sp.getLong("endAt", 0)
        if (System.currentTimeMillis() < endAt - 1000) {
            // 被闹钟过早唤起 (进程重启后重排): 重新排一次
            schedule(ctx)
            return
        }
        val focusMin = sp.getInt("focusMin", 25)
        val breakMin = sp.getInt("breakMin", 5)
        val autoBreak = sp.getBoolean("autoBreak", true)
        if (phase == "focus") {
            notify(ctx, "番茄完成 🍅", "专注 $focusMin 分钟完成" + (if (autoBreak) "，休息 $breakMin 分钟吧" else "") + "。")
            push("{\"type\":\"end\",\"phase\":\"focus\"}")
            if (autoBreak) {
                val now = System.currentTimeMillis()
                save(ctx, "break", false, now + breakMin * 60_000L, 0, now, 0, 0, focusMin, breakMin, true)
                schedule(ctx)
            } else {
                cancelTickAndAlarm(ctx)
                save(ctx, "idle", false, 0, 0, 0, 0, 0, focusMin, breakMin, autoBreak)
            }
        } else {
            notify(ctx, "休息结束", "回来继续吧，我陪着你。")
            push("{\"type\":\"end\",\"phase\":\"break\"}")
            cancelTickAndAlarm(ctx)
            save(ctx, "idle", false, 0, 0, 0, 0, 0, focusMin, breakMin, autoBreak)
        }
    }

    // ---- 推送 ----
    fun attach(v: WebView) {
        targets.add(WeakReference(v))
    }

    private fun push(json: String) {
        handler.post {
            synchronized(targets) {
                val it = targets.iterator()
                while (it.hasNext()) {
                    val v = it.next().get()
                    if (v == null) { it.remove(); continue }
                    runCatching {
                        v.evaluateJavascript("window.__noriPomoEvent && window.__noriPomoEvent(${JSONObject.quote(json)})", null)
                    }
                }
            }
        }
    }

    // ---- 通知 ----
    private fun notify(ctx0: Context, title: String, text: String) {
        val ctx = ctx0.applicationContext
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "番茄钟", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val pi = launch?.let {
            PendingIntent.getActivity(ctx, NOTIF_ID, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(text)
            .setAutoCancel(true)
        pi?.let { b.setContentIntent(it) }
        runCatching { nm.notify(NOTIF_ID, b.build()) }
    }
}
