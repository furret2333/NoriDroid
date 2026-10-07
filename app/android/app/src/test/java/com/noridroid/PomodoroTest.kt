package com.noridroid

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.TimeZone

class PomodoroTest {
    private fun c(minutes: Long, boot: Int = 1) = PomoClock(1_800_000_000_000 + minutes * 60000, 1000 + minutes * 60000, boot)
    private fun timer(phase: String = "countUp") = PomodoroTimeline(phase, segmentWall = c(0).wall, segmentMono = c(0).mono, boot = 1)

    @Test fun pauseResumeUsesOnlyActiveTime() {
        val t = timer()
        t.pause(c(5))
        assertEquals(300000L, t.elapsed(c(7)))
        t.resume(c(7))
        assertEquals(480000L, t.elapsed(c(10)))
        t.pause(c(10)); t.resume(c(110)); t.checkpoint(c(112))
        assertEquals(600000L, t.accumulated)
        assertEquals(t.accumulated, t.days.values.sum())
    }

    @Test fun stopWhilePausedAndRestoreDoNotCountPause() {
        val t = timer()
        t.pause(c(5))
        val restored = t.copy(days = LinkedHashMap(t.days))
        restored.checkpoint(c(100))
        assertEquals(300000L, restored.accumulated)
        assertEquals(300000L, restored.days.values.sum())
    }

    @Test fun countdownClampsAtItsTargetAndIgnoresClockChanges() {
        val t = timer("focus")
        t.pause(c(5)); t.resume(c(7))
        assertEquals(17 * 60000L, t.remaining(c(10)))
        val corrected = c(10).copy(wall = c(10).wall + 86400000)
        assertEquals(8 * 60000L, t.elapsed(corrected))
        assertEquals(25 * 60000L, t.elapsed(c(100)))
        assertEquals(0L, t.remaining(c(100)))
    }

    @Test fun processRestoreUsesMonotonicClockAndRebootUsesWallClock() {
        val restored = timer().copy()
        assertEquals(10 * 60000L, restored.elapsed(c(10)))
        assertEquals(10 * 60000L, restored.elapsed(c(10, 2).copy(mono = 100)))
        assertEquals(0L, restored.elapsed(c(0, 2).copy(wall = c(0).wall - 60000, mono = 100)))
    }

    @Test fun midnightAndPausedIntervalsSplitExactly() {
        val previous = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"))
            val start = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").parse("2026-10-07 23:58:00")!!.time
            val t = PomodoroTimeline("countUp", segmentWall = start, segmentMono = 1000, boot = 1)
            t.pause(PomoClock(start + 60000, 61000, 1))
            t.resume(PomoClock(start + 180000, 181000, 1))
            t.checkpoint(PomoClock(start + 300000, 301000, 1))
            assertEquals(60000L, t.days["2026-10-07"])
            assertEquals(120000L, t.days["2026-10-08"])
        } finally { TimeZone.setDefault(previous) }
    }

    @Test fun dstDayDoesNotAssume24Hours() {
        val previous = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
            val start = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").parse("2026-03-08 00:00:00")!!.time
            val parts = linkedMapOf<String, Long>()
            PomodoroTimeline.splitDays(start, 24 * 3600000L, parts)
            assertEquals(23 * 3600000L, parts["2026-03-08"])
            assertEquals(3600000L, parts["2026-03-09"])
        } finally { TimeZone.setDefault(previous) }
    }

    private fun e(seq: Int, phase: String, reason: String, ms: Long, days: JSONObject = JSONObject().put("2026-10-07", ms)) =
        JSONObject().put("seq", seq).put("phase", phase).put("reason", reason).put("elapsedMs", ms)
            .put("endedDay", "2026-10-07").put("days", days)

    @Test fun replayAfterCrashIsIdempotentAndPreservesOldRecords() {
        val old = JSONObject("""{"days":{"2026-10-06":{"focusMin":25,"done":1,"abort":0,"countUpMin":0}},"celebrated":{"streak3":123}}""")
        val events = JSONArray().put(e(1, "focus", "complete", 1500000)).put(e(2, "countUp", "stop", 20000))
        val result = PomodoroLedger.apply(old, events)
        val saved = result.toString()
        assertEquals(saved, PomodoroLedger.apply(JSONObject(saved), events).toString())
        assertEquals(50.0, result.getJSONObject("total").getDouble("focusMin"), 0.00001)
        assertEquals(2, result.getJSONObject("total").getInt("done"))
        assertEquals(123, result.getJSONObject("celebrated").getInt("streak3"))
        assertEquals(2, result.getInt("lastEventSeq"))
    }

    @Test fun incompleteSegmentsAreSavedButExcludedFromCompletedAverage() {
        val events = JSONArray().put(e(1, "focus", "complete", 1500000)).put(e(2, "focus", "switch", 1200000))
        val stats = PomodoroLedger.apply(JSONObject(), events)
        val d = stats.getJSONObject("days").getJSONObject("2026-10-07")
        assertEquals(45.0, d.getDouble("focusMin"), 0.00001)
        assertEquals(25.0, d.getDouble("completedFocusMin"), 0.00001)
        assertEquals(1, d.getInt("completedCount"))
        assertEquals(1, d.getInt("abort"))
    }

    @Test fun smallSegmentsAccumulateBeforeRoundingAndCompletionBelongsToEndDay() {
        val events = JSONArray()
        for (seq in 1..3) events.put(e(seq, "countUp", "stop", 20000))
        events.put(e(4, "focus", "complete", 120000, JSONObject().put("2026-10-06", 60000).put("2026-10-07", 60000)))
        val stats = PomodoroLedger.apply(JSONObject(), events)
        val days = stats.getJSONObject("days")
        assertEquals(1.0, days.getJSONObject("2026-10-07").getDouble("countUpMin"), 0.00001)
        assertEquals(0, days.getJSONObject("2026-10-06").getInt("done"))
        assertEquals(1, days.getJSONObject("2026-10-07").getInt("done"))
        assertEquals(2.0, days.getJSONObject("2026-10-07").getDouble("completedFocusMin"), 0.00001)
    }

    @Test fun legacyImportDoesNotReuseAnotherInstallEventWatermark() {
        val legacy = JSONObject("""{"lastEventSeq":900,"days":{"2026-10-07":{"focusMin":25,"done":1,"abort":0,"countUpMin":0}}}""")
        val stats = JSONObject()
        PomodoroLedger.importLegacy(stats, legacy)
        PomodoroLedger.apply(stats, JSONArray().put(e(1, "focus", "complete", 1500000)))
        assertEquals(1, stats.getInt("lastEventSeq"))
        assertEquals(2, stats.getJSONObject("total").getInt("done"))
        assertEquals(50.0, stats.getJSONObject("total").getDouble("focusMin"), 0.00001)
    }

    @Test fun delayedPermissionImportKeepsNewRecordsAndKnownCompletedSegments() {
        val stats = PomodoroLedger.apply(JSONObject(), JSONArray().put(e(1, "countUp", "stop", 60000)))
        val legacy = JSONObject("""{"days":{"2026-10-07":{"focusMin":25,"done":1,"abort":0,"countUpMin":2}},"celebrated":{"streak3":123}}""")
        PomodoroLedger.importLegacy(stats, legacy)
        PomodoroLedger.apply(stats, JSONArray().put(e(2, "focus", "switch", 1200000)).put(e(3, "focus", "complete", 1500000)))
        val d = stats.getJSONObject("days").getJSONObject("2026-10-07")
        assertEquals(70.0, d.getDouble("focusMin"), 0.00001)
        assertEquals(50.0, d.getDouble("completedFocusMin"), 0.00001)
        assertEquals(2, d.getInt("completedCount"))
        assertEquals(3.0, d.getDouble("countUpMin"), 0.00001)
        assertEquals(123, stats.getJSONObject("celebrated").getInt("streak3"))
    }
}
