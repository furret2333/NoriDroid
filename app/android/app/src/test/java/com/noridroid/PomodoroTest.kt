package com.noridroid

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.TimeZone

class PomodoroTest {
    @Test fun rebootCompletionWithinGraceIsNeverFreshEvenAfterCheckpoint() {
        val t = timer("focus").copy(autoFocus = true)
        val completion = t.completion(c(25, 2))
        t.checkpoint(completion.ended)
        assertEquals(2, t.boot)
        assertFalse(completion.fresh)
        val rest = t.nextAfterCompletion(completion.ended, completion.fresh)
        assertEquals("break", rest.phase)
        assertFalse(rest.completion(c(30, 3)).fresh)
        assertEquals("idle", rest.nextAfterCompletion(c(30, 3), false).phase)
    }

    @Test fun completionGraceUsesOriginalBootAndDeadline() {
        val t = timer("focus")
        assertTrue(t.completion(c(25)).fresh)
        assertTrue(t.completion(c(25).copy(mono = c(25).mono + 15000)).fresh)
        assertFalse(t.completion(c(25).copy(mono = c(25).mono + 15001)).fresh)
        assertEquals(c(25).wall, t.completion(c(30)).ended.wall)
    }

    @Test fun lateStopCannotEndSuccessorOrCompletedIdleSession() {
        val t = timer("focus")
        t.requireSession(t.sessionId)
        val rest = t.nextAfterCompletion(c(25), true)
        assertTrue(runCatching { rest.requireSession(t.sessionId) }.isFailure)
        rest.requireSession(rest.sessionId)
        val idle = rest.nextAfterCompletion(c(30), false)
        assertTrue(runCatching { idle.requireSession(idle.sessionId) }.isFailure)
        idle.requireSession(null)
    }

    @Test fun fourthCompletedFocusGetsLongBreakAndNewIdentity() {
        val t = timer("focus").copy(rounds = 3, cycleEnabled = true, longEvery = 4, longBreakMin = 20)
        val next = t.nextAfterCompletion(c(25), true)
        assertEquals("break", next.phase)
        assertEquals(4, next.rounds)
        assertTrue(next.isLongBreak)
        assertEquals(20 * 60000L, next.duration)
        assertNotEquals(t.sessionId, next.sessionId)
        assertEquals(0, next.days.size)
    }

    @Test fun autoFocusRequiresFreshCompletionAndNeverAddsRoundForRest() {
        val rest = timer("break").copy(rounds = 4, autoFocus = true)
        assertEquals("focus", rest.nextAfterCompletion(c(5), true).phase)
        val late = rest.nextAfterCompletion(c(5), false)
        assertEquals("idle", late.phase)
        assertEquals(4, late.rounds)
        assertEquals("idle", rest.copy(autoFocus = false).nextAfterCompletion(c(5), true).phase)
    }

    @Test fun liveProjectionDoesNotMutateSavedTimelineOrCountPausedTime() {
        val t = timer()
        val projection = t.liveDays(c(5))
        assertEquals(300000L, projection.values.sum())
        assertEquals(0L, t.accumulated)
        assertTrue(t.days.isEmpty())
        t.pause(c(5))
        assertEquals(300000L, t.liveDays(c(100)).values.sum())
    }

    @Test fun replaySortsOutOfOrderEventsAndKeepsSwitchSeparate() {
        val stats = PomodoroLedger.apply(JSONObject(), JSONArray()
            .put(e(3, "focus", "stop", 60000)).put(e(1, "focus", "complete", 1500000))
            .put(e(2, "focus", "switch", 120000)).put(e(2, "focus", "switch", 120000)))
        val d = stats.getJSONObject("days").getJSONObject("2026-10-07")
        assertEquals(28.0, d.getDouble("focusMin"), 0.00001)
        assertEquals(1, d.getInt("switched"))
        assertEquals(1, d.getInt("stopped"))
        assertEquals(2, d.getInt("abort"))
        assertEquals(1, d.getInt("done"))
        assertEquals(3, stats.getInt("lastEventSeq"))
    }

    @Test fun backupValidationRejectsBadDatesNegativeAndFractionalCounts() {
        for (raw in listOf(
            """{"v":2,"days":{"2026-02-30":{"focusMin":25}}}""",
            """{"v":2,"days":{"2026-10-07":{"focusMin":-1}}}""",
            """{"v":2,"days":{"2026-10-07":{"done":0.5}}}""",
            """{"v":3,"days":{}}""")) {
            assertTrue(runCatching { PomodoroLedger.validate(JSONObject(raw)) }.isFailure)
        }
    }

    @Test fun validHistoryOlderThanTenYearsSurvivesReplay() {
        val stats = PomodoroLedger.validate(JSONObject("""{"v":2,"days":{"2001-01-01":{"focusMin":25,"done":1}}}"""))
        PomodoroLedger.apply(stats, JSONArray())
        assertEquals(25.0, stats.getJSONObject("total").getDouble("focusMin"), 0.00001)
        assertTrue(stats.getJSONObject("days").has("2001-01-01"))
    }
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
