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
import android.os.SystemClock
import android.provider.Settings
import android.util.AtomicFile
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference

/** 原生计时与持久事件为唯一来源；WebView 回调只负责刷新和播报。 */
object PomodoroEngine {
    private const val PREFS = "pomo_engine"
    private const val CHANNEL = "pomodoro"
    private const val NOTIF_ID = 46001
    private const val ALARM_REQ = 46002
    private val handler = Handler(Looper.getMainLooper())
    private val targets = java.util.Collections.synchronizedList(ArrayList<WeakReference<WebView>>())
    private var scheduledAt = -1L
    @Volatile var appCtx: Context? = null
        private set
    private fun p(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun clock(ctx: Context) = PomoClock(System.currentTimeMillis(), SystemClock.elapsedRealtime(),
        Settings.Global.getInt(ctx.contentResolver, Settings.Global.BOOT_COUNT, -1))

    fun ensure(ctx: Context) { appCtx = ctx.applicationContext }

    private fun load(ctx: Context, now: PomoClock): PomodoroTimeline {
        val sp = p(ctx)
        val raw = sp.getString("timeline", null)
        if (raw != null) {
            val o = JSONObject(raw)
            val days = linkedMapOf<String, Long>()
            val d = o.optJSONObject("days") ?: JSONObject()
            for (k in d.keys()) days[k] = d.getLong(k)
            return PomodoroTimeline(o.getString("phase"), o.getBoolean("paused"), o.getInt("focusMin"),
                o.getInt("breakMin"), o.getBoolean("autoBreak"), o.getLong("accumulated"),
                o.getLong("segmentWall"), o.getLong("segmentMono"), o.getInt("boot"), days)
        }
        // 旧版暂停信息不足以还原各段日期；安全继承当前有效时长，不再次扣暂停。
        val phase = sp.getString("phase", "idle") ?: "idle"
        val paused = sp.getBoolean("paused", false)
        val f = sp.getInt("focusMin", 25)
        val b = sp.getInt("breakMin", 5)
        val remain = sp.getLong("remainMs", 0)
        val rawElapsed = when (phase) {
            "countUp" -> if (paused) remain else (now.wall - sp.getLong("startedAt", now.wall)).coerceAtLeast(0)
            "focus", "break" -> ((if (phase == "focus") f else b) * 60000L -
                (if (paused) remain else sp.getLong("endAt", now.wall) - now.wall)).coerceAtLeast(0)
            else -> 0
        }
        val limit = (if (phase == "focus") f else b) * 60000L
        val elapsed = if (phase == "focus" || phase == "break") rawElapsed.coerceAtMost(limit) else rawElapsed
        val overdue = if (!paused) (rawElapsed - elapsed).coerceAtLeast(0) else 0
        val t = PomodoroTimeline(phase, paused, f, b, sp.getBoolean("autoBreak", true),
            elapsed, now.wall - overdue, now.mono - overdue, now.boot)
        if (phase == "focus" || phase == "countUp") PomodoroTimeline.splitDays(now.wall - overdue - elapsed, elapsed, t.days)
        persist(ctx, t)
        return t
    }

    /** 状态转移与事件追加同一次同步提交，避免进程被回收后只剩状态没有记录。 */
    private fun persist(ctx: Context, t: PomodoroTimeline, event: JSONObject? = null) {
        val o = JSONObject().put("phase", t.phase).put("paused", t.paused)
            .put("focusMin", t.focusMin).put("breakMin", t.breakMin).put("autoBreak", t.autoBreak)
            .put("accumulated", t.accumulated).put("segmentWall", t.segmentWall)
            .put("segmentMono", t.segmentMono).put("boot", t.boot).put("days", JSONObject(t.days as Map<*, *>))
        val sp = p(ctx)
        val edit = sp.edit().putString("timeline", o.toString())
        if (event != null) {
            val seq = sp.getLong("eventSeq", 0) + 1
            event.put("seq", seq)
            val events = JSONArray(sp.getString("events", "[]"))
            events.put(event)
            edit.putLong("eventSeq", seq).putString("events", events.toString())
        }
        check(edit.commit()) { "番茄钟状态保存失败" }
    }

    private fun event(t: PomodoroTimeline, now: PomoClock, reason: String, endedWall: Long = now.wall): JSONObject {
        t.checkpoint(now)
        return JSONObject().put("type", "end").put("phase", t.phase).put("reason", reason)
            .put("elapsedMs", t.accumulated).put("endedAt", endedWall)
            .put("endedDay", PomodoroTimeline.dayKey(endedWall)).put("days", JSONObject(t.days as Map<*, *>))
    }

    private fun snapshot(t: PomodoroTimeline, now: PomoClock): JSONObject {
        val elapsed = t.elapsed(now)
        val remaining = if (t.phase == "idle" || t.phase == "countUp") 0 else t.remaining(now)
        return JSONObject().put("phase", t.phase).put("paused", t.paused).put("elapsedMs", elapsed)
            .put("remainingMs", remaining).put("now", now.wall)
            .put("endAt", if (remaining > 0) now.wall + remaining else 0)
            .put("remainMs", if (t.phase == "countUp") elapsed else remaining)
            .put("startedAt", if (t.phase == "idle") 0 else now.wall - elapsed)
            .put("focusMin", t.focusMin).put("breakMin", t.breakMin).put("autoBreak", t.autoBreak)
    }

    @Synchronized fun state(ctx: Context): String {
        ensure(ctx)
        completeIfDue(ctx)
        val now = clock(ctx)
        val t = load(ctx, now)
        if (!t.paused && t.phase != "idle" && (t.boot != now.boot ||
                kotlin.math.abs(now.wall - t.segmentWall - (now.mono - t.segmentMono)) > 2000)) {
            t.checkpoint(now)
            persist(ctx, t)
            schedule(ctx, t, now)
        }
        return snapshot(t, now).toString()
    }

    @Synchronized fun start(ctx: Context, focusMin: Int, breakMin: Int, autoBreak: Boolean): String {
        finishForSwitch(ctx)
        val now = clock(ctx)
        val t = PomodoroTimeline("focus", false, focusMin.coerceIn(1, 240), breakMin.coerceIn(1, 60),
            autoBreak, 0, now.wall, now.mono, now.boot)
        persist(ctx, t)
        schedule(ctx, t, now)
        return snapshot(t, now).toString()
    }

    @Synchronized fun startCountUp(ctx: Context): String {
        finishForSwitch(ctx)
        val now = clock(ctx)
        val t = PomodoroTimeline("countUp", false, 0, 0, false, 0, now.wall, now.mono, now.boot)
        persist(ctx, t)
        return snapshot(t, now).toString()
    }

    private fun finishForSwitch(ctx: Context) {
        ensure(ctx)
        completeIfDue(ctx)
        val now = clock(ctx)
        val t = load(ctx, now)
        cancelTickAndAlarm(ctx)
        if (t.phase != "idle") {
            val e = event(t, now, "switch")
            t.phase = "idle"; t.paused = false
            persist(ctx, t, e)
        }
    }

    @Synchronized fun pause(ctx: Context): String {
        completeIfDue(ctx)
        val now = clock(ctx)
        val t = load(ctx, now)
        if (t.phase != "idle" && !t.paused) {
            t.pause(now)
            persist(ctx, t)
            cancelTickAndAlarm(ctx)
        }
        return snapshot(t, now).toString()
    }

    @Synchronized fun resume(ctx: Context): String {
        val now = clock(ctx)
        val t = load(ctx, now)
        if (t.phase != "idle" && t.paused) {
            t.resume(now)
            persist(ctx, t)
            schedule(ctx, t, now)
        }
        return snapshot(t, now).toString()
    }

    @Synchronized fun stop(ctx: Context): String {
        completeIfDue(ctx)
        val now = clock(ctx)
        val t = load(ctx, now)
        val ended = t.phase
        val e = if (ended != "idle") event(t, now, "stop") else null
        val elapsed = t.accumulated
        cancelTickAndAlarm(ctx)
        val idle = PomodoroTimeline(focusMin = t.focusMin, breakMin = t.breakMin, autoBreak = t.autoBreak)
        persist(ctx, idle, e)
        return snapshot(idle, now).put("endedPhase", ended).put("elapsedMs", elapsed).toString()
    }

    private val tickRunnable = Runnable { appCtx?.let { completeIfDue(it) } }
    private fun alarmIntent(ctx: Context) = PendingIntent.getBroadcast(ctx.applicationContext, ALARM_REQ,
        Intent(ctx.applicationContext, PomodoroAlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun schedule(ctx: Context, t: PomodoroTimeline, now: PomoClock) {
        if (t.paused || (t.phase != "focus" && t.phase != "break")) return
        val delay = t.remaining(now)
        val at = now.mono + delay
        if (scheduledAt == at) return
        scheduledAt = at
        handler.removeCallbacks(tickRunnable)
        handler.postDelayed(tickRunnable, delay)
        runCatching {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms())
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarmIntent(ctx))
            else am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarmIntent(ctx))
        }
    }

    private fun cancelTickAndAlarm(ctx: Context) {
        scheduledAt = -1
        handler.removeCallbacks(tickRunnable)
        runCatching { (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(alarmIntent(ctx)) }
    }

    @Synchronized fun completeIfDue(ctx0: Context) {
        val ctx = ctx0.applicationContext
        ensure(ctx)
        val now = clock(ctx)
        var t = load(ctx, now)
        // 前台补偿可能同时跨过专注、休息；休息从原到点时间开始，不从重开页面时开始。
        repeat(2) {
            if (t.paused || (t.phase != "focus" && t.phase != "break")) return
            val remaining = t.remaining(now)
            if (remaining > 0) { schedule(ctx, t, now); return }
            val rawDelta = if (t.boot == now.boot && now.mono >= t.segmentMono) now.mono - t.segmentMono
                else (now.wall - t.segmentWall).coerceAtLeast(0)
            val overdue = (t.accumulated + rawDelta - t.duration).coerceAtLeast(0)
            val endedWall = t.segmentWall + (t.duration - t.accumulated).coerceAtLeast(0)
            val ended = PomoClock(endedWall, now.mono - overdue, now.boot)
            val e = event(t, ended, "complete", endedWall)
            val focus = t.phase == "focus"
            val next = if (focus && t.autoBreak) PomodoroTimeline("break", false, t.focusMin, t.breakMin,
                true, 0, endedWall, now.mono - overdue, now.boot)
                else PomodoroTimeline(focusMin = t.focusMin, breakMin = t.breakMin, autoBreak = t.autoBreak)
            persist(ctx, next, e)
            cancelTickAndAlarm(ctx)
            if (focus) notify(ctx, "番茄完成 🍅", "专注 ${t.focusMin} 分钟完成。")
            else notify(ctx, "休息结束", "回来继续吧，我陪着你。")
            push(e.toString())
            t = next
        }
    }

    /** 私有原子统计文件是权威副本；无法读取旧文件时保留延迟迁移机会。 */
    @Synchronized fun stats(ctx: Context, seed: String, milestone: String? = null, legacyAbsent: Boolean = false): String {
        completeIfDue(ctx)
        val file = AtomicFile(File(ctx.filesDir, "pomodoro-stats.json"))
        val raw = if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists())
            file.openRead().use { it.readBytes().toString(Charsets.UTF_8) } else ""
        val stats = if (raw.isBlank()) JSONObject().put("days", JSONObject()) else JSONObject(raw)
        if (!stats.optBoolean("legacyImported")) {
            if (seed.isNotBlank()) PomodoroLedger.importLegacy(stats, JSONObject(seed))
            else if (legacyAbsent) stats.put("legacyImported", true)
        }
        val sp = p(ctx)
        val events = JSONArray(sp.getString("events", "[]"))
        PomodoroLedger.apply(stats, events)
        if (!milestone.isNullOrBlank()) {
            val marks = stats.optJSONObject("celebrated") ?: JSONObject()
            stats.put("celebrated", marks.put(milestone, System.currentTimeMillis()))
        }
        val result = stats.toString()
        val out = file.startWrite()
        try { out.write(result.toByteArray(Charsets.UTF_8)); file.finishWrite(out) }
        catch (e: Exception) { file.failWrite(out); throw e }
        // 先保存统计与水位，再删事件；中途崩溃只会重放已处理事件，水位会跳过它们。
        val pending = JSONArray()
        for (i in 0 until events.length()) if (events.getJSONObject(i).getLong("seq") > stats.optLong("lastEventSeq")) pending.put(events.getJSONObject(i))
        sp.edit().putString("events", pending.toString()).commit()
        return result
    }

    @Synchronized fun setNotify(ctx: Context, enabled: Boolean) { p(ctx).edit().putBoolean("notifyEnabled", enabled).commit() }

    fun attach(v: WebView) {
        synchronized(targets) {
            targets.removeAll { it.get() == null || it.get() === v }
            targets.add(WeakReference(v))
        }
    }
    private fun push(json: String) {
        handler.post {
            synchronized(targets) {
                val it = targets.iterator()
                while (it.hasNext()) {
                    val v = it.next().get()
                    if (v == null) { it.remove(); continue }
                    runCatching { v.evaluateJavascript("window.__noriPomoEvent && window.__noriPomoEvent(${JSONObject.quote(json)})", null) }
                }
            }
        }
    }

    private fun notify(ctx: Context, title: String, text: String) {
        if (!p(ctx).getBoolean("notifyEnabled", true)) return
        if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (!nm.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "番茄钟", NotificationManager.IMPORTANCE_DEFAULT))
        val pi = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
            PendingIntent.getActivity(ctx, NOTIF_ID, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(R.drawable.ic_stat_nori).setContentTitle(title).setContentText(text).setAutoCancel(true)
        pi?.let { b.setContentIntent(it) }
        runCatching { nm.notify(NOTIF_ID, b.build()) }
    }
}
