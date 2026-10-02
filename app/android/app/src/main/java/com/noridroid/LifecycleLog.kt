package com.noridroid

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * 生命周期事件留痕 (排查"切蓝牙键盘/软键盘导致应用重启"这类问题)。
 *
 * ## 为什么需要
 * 用户反馈"从虚拟键盘切到蓝牙键盘时应用会重启"。代码侧能确认的是 Manifest 少声明了
 * `keyboard`/`navigation` 等 configuration change, 但真机上到底触发的是哪一个字段**无法从
 * 代码推断** —— 本机没有 adb/模拟器, 只能靠设备自己记下来。
 *
 * ## 做了什么
 * 把 MainActivity 的生命周期事件 (onCreate/onPause/onResume/onConfigurationChanged/onDestroy)
 * 连同关键状态一起追加到**应用私有目录**的 `lifecycle.log`:
 *   `<应用内部存储>/files/lifecycle.log`  (每行一个 JSON, 只保留最近 [MAX_LINES] 行)
 * 用 adb 或文件管理器 (Android/data/com.noridroid/files/) 即可取出。
 *
 * ## 边界 (必须如实说明)
 * - 应用私有目录**没有接进 JS 桥** (ChatBridge 读写的是公共 Downloads), 所以它**不会**出现在
 *   `Download/NoriDroid/` 里, 也没有"导出诊断"按钮能直接读到 —— 这一版只做原生留痕。
 * - 只记录**进程内**事件: 如果重启是进程被杀 (而不是 Activity 重建), 这里会断开 (新进程的第一行
 *   是 onCreate), 那本身就是"进程级重启"的证据。
 * - 写盘刻意放在单线程 executor 且整体 try-catch: 诊断代码绝不能让应用崩在生命周期回调里。
 */
object LifecycleLog {

    private const val TAG = "NoriLifecycle"
    private const val FILE_NAME = "lifecycle.log"
    /** 保留的最大行数 (超出丢最旧) */
    private const val MAX_LINES = 80

    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "nori-lifecycle-log").apply { isDaemon = true }
    }

    /** 记录一条事件; detail 里放"排查这个问题时需要知道的状态" */
    fun record(ctx: Context, event: String, detail: String = "") {
        try {
            val json = JSONObject()
                .put("t", fmt.format(Date()))
                .put("event", event)
                .put("detail", detail)
                .toString()
            Log.i(TAG, "$event $detail")
            val app = ctx.applicationContext
            io.execute {
                try {
                    val f = File(app.filesDir, FILE_NAME)
                    val lines = if (f.isFile) f.readLines().toMutableList() else mutableListOf()
                    lines.add(json)
                    while (lines.size > MAX_LINES) lines.removeAt(0)
                    f.writeText(lines.joinToString("\n"))
                } catch (_: Throwable) {
                    // 诊断写盘失败就算了: 绝不因为日志把主流程搞崩
                }
            }
        } catch (_: Throwable) {
            // 同上
        }
    }
}
