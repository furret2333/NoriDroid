package com.noridroid

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** 单次开机用单调时钟；设备重启后以墙钟恢复，暂停和已结算时间不重复扣减。 */
internal data class PomoClock(val wall: Long, val mono: Long, val boot: Int)

internal data class PomodoroTimeline(
    var phase: String = "idle",
    var paused: Boolean = false,
    var focusMin: Int = 25,
    var breakMin: Int = 5,
    var autoBreak: Boolean = true,
    var accumulated: Long = 0,
    var segmentWall: Long = 0,
    var segmentMono: Long = 0,
    var boot: Int = -1,
    val days: MutableMap<String, Long> = linkedMapOf(),
) {
    val duration: Long get() = (if (phase == "focus") focusMin else breakMin) * 60_000L
    fun elapsed(now: PomoClock): Long {
        val delta = if (paused || phase == "idle") 0 else if (boot == now.boot && now.mono >= segmentMono)
            now.mono - segmentMono else (now.wall - segmentWall).coerceAtLeast(0)
        val elapsed = accumulated + delta
        return if (phase == "countUp" || phase == "idle") elapsed else elapsed.coerceAtMost(duration)
    }
    fun remaining(now: PomoClock): Long = (duration - elapsed(now)).coerceAtLeast(0)
    fun checkpoint(now: PomoClock) {
        val total = elapsed(now)
        val delta = (total - accumulated).coerceAtLeast(0)
        if (phase == "focus" || phase == "countUp") splitDays(segmentWall, delta, days)
        accumulated = total
        segmentWall = now.wall
        segmentMono = now.mono
        boot = now.boot
    }
    fun pause(now: PomoClock) { checkpoint(now); paused = true }
    fun resume(now: PomoClock) {
        paused = false
        segmentWall = now.wall
        segmentMono = now.mono
        boot = now.boot
    }

    companion object {
        fun dayKey(wall: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(wall))
        /** 按本地午夜拆分实际运行区间，Calendar 同时处理夏令时的 23/25 小时日。 */
        fun splitDays(start: Long, duration: Long, out: MutableMap<String, Long>) {
            var cursor = start
            var left = duration
            while (left > 0) {
                val midnight = Calendar.getInstance().apply {
                    timeInMillis = cursor
                    add(Calendar.DATE, 1)
                    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
                    set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
                }.timeInMillis
                val part = minOf(left, (midnight - cursor).coerceAtLeast(1))
                val key = dayKey(cursor)
                out[key] = (out[key] ?: 0) + part
                cursor += part
                left -= part
            }
        }
    }
}
