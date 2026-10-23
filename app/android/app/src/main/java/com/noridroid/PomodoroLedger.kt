package com.noridroid

import org.json.JSONArray
import org.json.JSONObject

/** 完成事件重放到统计：水位与数据一同原子落盘，崩溃后重放不会重复累计。 */
internal object PomodoroLedger {
    /** 旧公共文件可能来自另一次安装；只迁入统计，不能继承那次安装的事件水位。 */
    fun importLegacy(stats: JSONObject, legacy: JSONObject) {
        apply(stats, JSONArray())
        apply(legacy, JSONArray())
        val days = stats.getJSONObject("days")
        val oldDays = legacy.getJSONObject("days")
        for (date in oldDays.keys()) {
            val old = oldDays.getJSONObject(date)
            val d = days.optJSONObject(date) ?: newDay().also { days.put(date, it) }
            preserveCompleted(d)
            preserveCompleted(old)
            for (key in listOf("focus", "countUp")) {
                val msKey = key + "Ms"
                val minKey = key + "Min"
                val ms = d.optLong(msKey, (d.optDouble(minKey, 0.0) * 60000).toLong()) +
                    old.optLong(msKey, (old.optDouble(minKey, 0.0) * 60000).toLong())
                d.put(msKey, ms).put(minKey, ms / 60000.0)
            }
            for (key in listOf("done", "abort", "completedCount")) d.put(key, d.optInt(key) + old.optInt(key))
            d.put("completedFocusMin", d.optDouble("completedFocusMin") + old.optDouble("completedFocusMin"))
        }
        val total = stats.getJSONObject("total")
        val oldTotal = legacy.getJSONObject("total")
        for (key in listOf("focusMin", "countUpMin", "done")) total.put(key, total.optDouble(key) + oldTotal.optDouble(key))
        val best = stats.getJSONObject("best")
        val oldBest = legacy.getJSONObject("best")
        best.put("dayMin", maxOf(best.optDouble("dayMin"), oldBest.optDouble("dayMin")))
        best.put("streak", maxOf(best.optInt("streak"), oldBest.optInt("streak")))
        val marks = stats.optJSONObject("celebrated") ?: JSONObject().also { stats.put("celebrated", it) }
        legacy.optJSONObject("celebrated")?.let { old ->
            for (key in old.keys()) if (!marks.has(key)) marks.put(key, old.get(key))
        }
        stats.put("legacyImported", true)
    }

    private fun preserveCompleted(d: JSONObject) {
        if (d.has("completedCount")) return
        d.put("completedCount", if (d.optInt("abort") == 0) d.optInt("done") else 0)
        d.put("completedFocusMin", if (d.optInt("abort") == 0) d.optDouble("focusMin", 0.0) else 0.0)
    }

    fun apply(stats: JSONObject, events: JSONArray): JSONObject {
        val days = stats.optJSONObject("days") ?: JSONObject().also { stats.put("days", it) }
        val total = stats.optJSONObject("total") ?: JSONObject().also { t ->
            for (key in listOf("focusMin", "countUpMin", "done")) {
                t.put(key, days.keys().asSequence().sumOf { days.getJSONObject(it).optDouble(key, 0.0) })
            }
            stats.put("total", t)
        }
        var watermark = stats.optLong("lastEventSeq", 0)
        for (e in (0 until events.length()).map { events.getJSONObject(it) }.sortedBy { it.getLong("seq") }) {
            val seq = e.getLong("seq")
            if (seq <= watermark) continue
            val phase = e.getString("phase")
            if (phase == "focus" || phase == "countUp") {
                val key = if (phase == "focus") "focusMin" else "countUpMin"
                val msKey = if (phase == "focus") "focusMs" else "countUpMs"
                val parts = e.getJSONObject("days")
                for (date in parts.keys()) {
                    val d = days.optJSONObject(date) ?: newDay().also { days.put(date, it) }
                    preserveCompleted(d)
                    val ms = d.optLong(msKey, (d.optDouble(key, 0.0) * 60000).toLong()) + parts.getLong(date)
                    d.put(msKey, ms).put(key, ms / 60000.0)
                }
                total.put(key, total.optDouble(key, 0.0) + e.getLong("elapsedMs") / 60000.0)
                if (phase == "focus") {
                    val date = e.getString("endedDay")
                    val d = days.optJSONObject(date) ?: newDay().also { days.put(date, it) }
                    if (e.getString("reason") == "complete") {
                        preserveCompleted(d)
                        val knownCount = d.optInt("completedCount")
                        val knownMin = d.optDouble("completedFocusMin", 0.0)
                        d.put("completedCount", knownCount + 1)
                        d.put("completedFocusMin", knownMin + e.getLong("elapsedMs") / 60000.0)
                        d.put("done", d.optInt("done") + 1)
                        total.put("done", total.optInt("done") + 1)
                    } else {
                        d.put("abort", d.optInt("abort") + 1)
                        val reasonKey = if (e.getString("reason") == "switch") "switched" else "stopped"
                        d.put(reasonKey, d.optInt(reasonKey) + 1)
                    }
                }
            }
            watermark = seq
        }
        stats.put("lastEventSeq", watermark).put("v", 2)
        val best = stats.optJSONObject("best") ?: JSONObject()
        var bestDay = best.optDouble("dayMin", 0.0)
        val active = days.keys().asSequence().filter { k ->
            val d = days.getJSONObject(k)
            val min = d.optDouble("focusMin", 0.0) + d.optDouble("countUpMin", 0.0)
            bestDay = maxOf(bestDay, min)
            min > 0 || d.optInt("done") > 0
        }.sorted().toList()
        var run = 0
        var streak = best.optInt("streak", 0)
        var prev: String? = null
        for (date in active) {
            val cal = java.util.Calendar.getInstance().apply {
                time = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).parse(date)!!
                add(java.util.Calendar.DATE, -1)
            }
            run = if (prev == PomodoroTimeline.dayKey(cal.timeInMillis)) run + 1 else 1
            streak = maxOf(streak, run)
            prev = date
        }
        stats.put("best", best.put("dayMin", bestDay).put("streak", streak))
        return stats
    }

    private fun newDay() = JSONObject().put("focusMin", 0).put("countUpMin", 0).put("done", 0).put("abort", 0)

    /** 不接受不支持版本、负数、无穷数或无效日期，失败不触碰账本。 */
    fun validate(input: JSONObject): JSONObject {
        require(input.optInt("v", 1) in 1..2) { "不支持的记录版本" }
        val days = input.getJSONObject("days")
        require(days.length() <= 100000) { "记录数量超过限制" }
        val format = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).apply { isLenient = false }
        for (date in days.keys()) {
            require(Regex("\\d{4}-\\d{2}-\\d{2}").matches(date) && format.format(format.parse(date)!!) == date) { "记录日期无效" }
            val day = days.getJSONObject(date)
            for (key in listOf("focusMin", "countUpMin", "done", "abort", "focusMs", "countUpMs", "completedCount", "completedFocusMin", "switched", "stopped")) {
                if (!day.has(key)) continue
                val n = day.getDouble(key)
                require(n.isFinite() && n >= 0 && n <= 1e15) { "记录数值无效：$key" }
                if (key in listOf("done", "abort", "completedCount", "switched", "stopped", "focusMs", "countUpMs"))
                    require(n == kotlin.math.floor(n)) { "记录计数必须为整数" }
            }
        }
        for (field in listOf("total", "best", "celebrated")) input.optJSONObject(field)?.let { obj ->
            for (key in obj.keys()) require(obj.getDouble(key).let { it.isFinite() && it >= 0 && it <= 1e15 }) { "汇总数据无效" }
        }
        return input
    }
}
