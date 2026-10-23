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
    private var scheduleError = ""
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
            val t = PomodoroTimeline(o.getString("phase"), o.getBoolean("paused"), o.getInt("focusMin"),
                o.getInt("breakMin"), o.getBoolean("autoBreak"), o.getLong("accumulated"),
                o.getLong("segmentWall"), o.getLong("segmentMono"), o.getInt("boot"), days)
            t.sessionId = o.optString("sessionId").ifBlank { "legacy-${t.segmentWall}" }
            t.autoFocus = o.optBoolean("autoFocus")
            t.cycleEnabled = o.optBoolean("cycleEnabled")
            t.longEvery = o.optInt("longEvery", 4).coerceIn(2, 12)
            t.longBreakMin = o.optInt("longBreakMin", 15).coerceIn(1, 60)
            t.rounds = o.optInt("rounds").coerceAtLeast(0)
            t.isLongBreak = o.optBoolean("isLongBreak")
            t.goal = o.optString("goal").take(100)
            t.rebootPending = o.optBoolean("rebootPending")
            return t
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
            .put("sessionId", t.sessionId).put("autoFocus", t.autoFocus).put("cycleEnabled", t.cycleEnabled)
            .put("longEvery", t.longEvery).put("longBreakMin", t.longBreakMin).put("rounds", t.rounds)
            .put("isLongBreak", t.isLongBreak).put("goal", t.goal).put("rebootPending", t.rebootPending)
        val sp = p(ctx)
        val edit = sp.edit().putString("timeline", o.toString()).putLong("revision", sp.getLong("revision", 0) + 1)
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
            .put("elapsedMs", t.accumulated).put("endedAt", endedWall).put("sessionId", t.sessionId).put("goal", t.goal)
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
            .put("sessionId", t.sessionId).put("autoFocus", t.autoFocus).put("cycleEnabled", t.cycleEnabled)
            .put("longEvery", t.longEvery).put("longBreakMin", t.longBreakMin).put("rounds", t.rounds)
            .put("isLongBreak", t.isLongBreak).put("goal", t.goal).put("rebootPending", t.rebootPending)
            .put("durationMs", t.duration).put("days", JSONObject(t.liveDays(now)))
            .put("revision", appCtx?.let { p(it).getLong("revision", 0) } ?: 0)
            .put("eventSeq", appCtx?.let { p(it).getLong("eventSeq", 0) } ?: 0)
    }

    @Synchronized fun state(ctx: Context): String {
        ensure(ctx)
        completeIfDue(ctx)
        val now = clock(ctx)
        val t = load(ctx, now)
        if (!t.paused && t.phase != "idle" && (t.phase == "countUp" && now.mono - t.segmentMono >= 10000 || t.boot != now.boot ||
                kotlin.math.abs(now.wall - t.segmentWall - (now.mono - t.segmentMono)) > 2000)) {
            t.checkpoint(now)
            persist(ctx, t)
            schedule(ctx, t, now)
            updateRunningNotification(ctx, t)
        }
        return snapshot(t, now).toString()
    }

    @Synchronized fun start(ctx: Context, focusMin: Int, breakMin: Int, autoBreak: Boolean): String {
        return startPlan(ctx, JSONObject().put("focusMin", focusMin).put("breakMin", breakMin).put("autoBreak", autoBreak))
    }

    @Synchronized fun startPlan(ctx: Context, options: JSONObject): String {
        finishForSwitch(ctx)
        val now = clock(ctx)
        val previous = load(ctx, now)
        val t = PomodoroTimeline("focus", false, options.optInt("focusMin", 25).coerceIn(5, 120), options.optInt("breakMin", 5).coerceIn(1, 30),
            options.optBoolean("autoBreak", true), 0, now.wall, now.mono, now.boot,
            autoFocus = options.optBoolean("autoFocus"), cycleEnabled = options.optBoolean("cycleEnabled"),
            longEvery = options.optInt("longEvery", 4).coerceIn(2, 12), longBreakMin = options.optInt("longBreakMin", 15).coerceIn(1, 60),
            rounds = previous.rounds, goal = options.optString("goal").take(100))
        persist(ctx, t)
        schedule(ctx, t, now)
        updateRunningNotification(ctx, t)
        return snapshot(t, now).toString()
    }

    @Synchronized fun startCountUp(ctx: Context, goal: String = ""): String {
        finishForSwitch(ctx)
        val now = clock(ctx)
        val t = PomodoroTimeline("countUp", false, 0, 0, false, 0, now.wall, now.mono, now.boot, goal = goal.take(100))
        persist(ctx, t)
        updateRunningNotification(ctx, t)
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

    @Synchronized fun pause(ctx: Context, expectedSession: String? = null): String {
        completeIfDue(ctx)
        val now = clock(ctx)
        val t = load(ctx, now)
        t.requireSession(expectedSession)
        if (t.phase != "idle" && !t.paused) {
            t.pause(now)
            persist(ctx, t)
            cancelTickAndAlarm(ctx)
            updateRunningNotification(ctx, t)
        }
        return snapshot(t, now).toString()
    }

    @Synchronized fun resume(ctx: Context): String {
        val now = clock(ctx)
        val t = load(ctx, now)
        require(!t.rebootPending) { "请先选择是否计入离线时段" }
        if (t.phase != "idle" && t.paused) {
            t.resume(now)
            persist(ctx, t)
            schedule(ctx, t, now)
            updateRunningNotification(ctx, t)
        }
        return snapshot(t, now).toString()
    }

    @Synchronized fun stop(ctx: Context, expectedSession: String? = null): String {
        completeIfDue(ctx)
        val now = clock(ctx)
        val t = load(ctx, now)
        t.requireSession(expectedSession)
        val ended = t.phase
        val e = if (ended != "idle") event(t, now, "stop") else null
        val elapsed = t.accumulated
        cancelTickAndAlarm(ctx)
        val idle = t.copy(phase = "idle", paused = false, accumulated = 0, days = linkedMapOf(), rebootPending = false)
        persist(ctx, idle, e)
        updateRunningNotification(ctx, idle)
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
        push(JSONObject().put("type", "state").toString())
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
        handler.removeCallbacks(tickRunnable)
        handler.postDelayed(tickRunnable, delay)
        runCatching {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms())
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarmIntent(ctx))
            else am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarmIntent(ctx))
        }.onSuccess { scheduledAt = at; scheduleError = "" }.onFailure { scheduledAt = -1; scheduleError = it.message ?: "提醒安排失败" }
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
        // 正向计时跨开机无法证明真实专注：保留已确认段，暂停等待用户选择。
        if (t.phase == "countUp" && !t.paused && t.boot != now.boot) {
            t.paused = true; t.rebootPending = true
            persist(ctx, t)
            updateRunningNotification(ctx, t)
            return
        }
        // 前台补偿可能同时跨过专注、休息；休息从原到点时间开始，不从重开页面时开始。
        repeat(2) {
            if (t.paused || (t.phase != "focus" && t.phase != "break")) return
            val remaining = t.remaining(now)
            if (remaining > 0) { schedule(ctx, t, now); return }
            val completion = t.completion(now)
            val ended = completion.ended
            val e = event(t, ended, "complete", ended.wall)
            val focus = t.phase == "focus"
            // 延迟或跨开机只补已有专注/休息，不替用户虚构下一轮专注。
            val fresh = completion.fresh
            val next = t.nextAfterCompletion(ended, fresh)
            persist(ctx, next, e)
            cancelTickAndAlarm(ctx)
            if (fresh) {
                if (focus) notify(ctx, "番茄完成 🍅", "专注 ${t.focusMin} 分钟完成。")
                else notify(ctx, "休息结束", "回来继续吧，我陪着你。")
            }
            updateRunningNotification(ctx, next)
            push(e.toString())
            t = next
        }
        schedule(ctx, t, now)
    }

    /** 私有原子统计文件是权威副本；无法读取旧文件时保留延迟迁移机会。 */
    @Synchronized fun stats(ctx: Context, seed: String, milestone: String? = null, legacyAbsent: Boolean = false): String {
        completeIfDue(ctx)
        val file = AtomicFile(File(ctx.filesDir, "pomodoro-stats.json"))
        val exists = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()
        val raw = if (exists)
            file.openRead().use { it.readBytes().toString(Charsets.UTF_8) } else ""
        require(!exists || raw.isNotBlank()) { "专注记录文件为空，请保留原文件并重试" }
        val stats = if (!exists) JSONObject().put("days", JSONObject()) else PomodoroLedger.validate(JSONObject(raw))
        if (!stats.optBoolean("legacyImported")) {
            if (seed.isNotBlank()) PomodoroLedger.importLegacy(stats, PomodoroLedger.validate(JSONObject(seed)))
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
        if (result != raw) writeAtomic(file, result)
        // 先保存统计与水位，再删事件；中途崩溃只会重放已处理事件，水位会跳过它们。
        val pending = JSONArray()
        for (i in 0 until events.length()) if (events.getJSONObject(i).getLong("seq") > stats.optLong("lastEventSeq")) pending.put(events.getJSONObject(i))
        if (pending.length() != events.length()) check(sp.edit().putString("events", pending.toString()).commit())
        return result
    }

    private fun writeAtomic(file: AtomicFile, raw: String) {
        val out = file.startWrite()
        try { out.write(raw.toByteArray(Charsets.UTF_8)); file.finishWrite(out) }
        catch (e: Exception) { file.failWrite(out); throw e }
    }

    @Synchronized fun dashboard(ctx: Context, seed: String, absent: Boolean): JSONObject {
        state(ctx) // 同步时钟校正及正向已确认检查点。
        val data = JSONObject(stats(ctx, seed, legacyAbsent = absent))
        val now = clock(ctx)
        return JSONObject().put("ok", true).put("stats", data).put("state", snapshot(load(ctx, now), now))
            .put("reminder", reminderStatus(ctx))
    }

    @Synchronized fun restore(ctx: Context, raw: String): String {
        completeIfDue(ctx)
        require(load(ctx, clock(ctx)).phase == "idle") { "请先结束当前计时再恢复记录" }
        val input = JSONObject(raw)
        require(input.optString("kind") == "nori-pomodoro" && input.optInt("version") == 1) { "请选择番茄钟 JSON 备份" }
        val candidate = PomodoroLedger.validate(input.getJSONObject("stats"))
        // 先保留当前有效账本，候选文件校验失败不改变运行数据。
        val old = stats(ctx, "")
        writeAtomic(AtomicFile(File(ctx.filesDir, "pomodoro-before-restore.json")), old)
        candidate.put("lastEventSeq", p(ctx).getLong("eventSeq", 0)).put("legacyImported", true)
        PomodoroLedger.apply(candidate, JSONArray())
        writeAtomic(AtomicFile(File(ctx.filesDir, "pomodoro-stats.json")), candidate.toString())
        return candidate.toString()
    }

    @Synchronized fun resolveReboot(ctx: Context, include: Boolean): String {
        val now = clock(ctx)
        val t = load(ctx, now)
        if (t.rebootPending) {
            if (include) { t.paused = false; t.checkpoint(now) }
            t.rebootPending = false
            t.resume(now)
            persist(ctx, t)
            updateRunningNotification(ctx, t)
        }
        return snapshot(t, now).toString()
    }

    @Synchronized fun recover(ctx: Context) {
        scheduledAt = -1
        completeIfDue(ctx)
        updateRunningNotification(ctx, load(ctx, clock(ctx)))
    }

    @Synchronized fun notificationAction(ctx: Context, session: String, revision: Long, action: String) {
        completeIfDue(ctx)
        val t = load(ctx, clock(ctx))
        if (session != t.sessionId || revision != p(ctx).getLong("revision", 0)) return
        when (action) { "pause" -> pause(ctx, session); "resume" -> if (!t.rebootPending) resume(ctx); "stop" -> stop(ctx, session) }
        push(JSONObject().put("type", "state").toString())
    }

    fun reminderStatus(ctx: Context): JSONObject {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(nm)
        val permission = Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val channel = Build.VERSION.SDK_INT < 26 || (nm.getNotificationChannel(CHANNEL)?.importance ?: 0) != NotificationManager.IMPORTANCE_NONE
        val controlChannel = Build.VERSION.SDK_INT < 26 || (nm.getNotificationChannel("pomodoro-running")?.importance ?: 0) != NotificationManager.IMPORTANCE_NONE
        val exact = Build.VERSION.SDK_INT < 31 || (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms()
        return JSONObject().put("permission", permission && nm.areNotificationsEnabled()).put("channel", channel)
            .put("controlChannel", controlChannel).put("exact", exact).put("scheduleError", scheduleError)
    }

    fun openReminderSettings(ctx: Context, kind: String) {
        val intent = if (kind == "exact" && Build.VERSION.SDK_INT >= 31)
            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.parse("package:${ctx.packageName}"))
        else if ((kind == "channel" || kind == "controlChannel") && Build.VERSION.SDK_INT >= 26)
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, if (kind == "controlChannel") "pomodoro-running" else CHANNEL)
        else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun ensureChannel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "番茄钟", NotificationManager.IMPORTANCE_DEFAULT))
            nm.createNotificationChannel(NotificationChannel("pomodoro-running", "专注计时控制", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun updateRunningNotification(ctx: Context, t: PomodoroTimeline) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (t.phase == "idle") { nm.cancel(NOTIF_ID + 2); return }
        if (!p(ctx).getBoolean("notifyEnabled", true) || !reminderStatus(ctx).optBoolean("permission")) { nm.cancel(NOTIF_ID + 2); return }
        runCatching {
            val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, "pomodoro-running") else @Suppress("DEPRECATION") Notification.Builder(ctx)
            val title = when(t.phase) { "focus" -> "专注中"; "break" -> if (t.isLongBreak) "长休息" else "休息中"; else -> "正向计时" }
            b.setSmallIcon(R.drawable.ic_stat_nori).setContentTitle(if(t.paused) "已暂停 · $title" else title)
                .setContentText(t.goal.ifBlank { "Nori 陪你，慢慢来" }).setOnlyAlertOnce(true).setOngoing(true)
            ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
                it.putExtra("nori_pomo", true)
                b.setContentIntent(PendingIntent.getActivity(ctx, NOTIF_ID, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            }
            val revision = p(ctx).getLong("revision", 0)
            for ((index, action) in listOf(if(t.paused) "resume" else "pause", "stop").withIndex()) {
                val intent = Intent(ctx, PomodoroAlarmReceiver::class.java).setAction("com.noridroid.POMO_CONTROL")
                    .setData(android.net.Uri.parse("nori://pomo/${t.sessionId}/$revision/$action"))
                    .putExtra("session", t.sessionId).putExtra("revision", revision).putExtra("command", action)
                val pi = PendingIntent.getBroadcast(ctx, 46030 + index, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                b.addAction(Notification.Action.Builder(null, if(action == "pause") "暂停" else if(action == "resume") "继续" else "结束并保存", pi).build())
            }
            nm.notify(NOTIF_ID + 2, b.build())
        }
    }

    @Synchronized fun setNotify(ctx: Context, enabled: Boolean) {
        check(p(ctx).edit().putBoolean("notifyEnabled", enabled).commit())
        updateRunningNotification(ctx, load(ctx, clock(ctx)))
    }

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
        ensureChannel(nm)
        val pi = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
            it.putExtra("nori_pomo", true)
            PendingIntent.getActivity(ctx, NOTIF_ID, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
        b.setSmallIcon(R.drawable.ic_stat_nori).setContentTitle(title).setContentText(text).setAutoCancel(true)
        pi?.let { b.setContentIntent(it) }
        runCatching { nm.notify(NOTIF_ID, b.build()) }
    }
}
