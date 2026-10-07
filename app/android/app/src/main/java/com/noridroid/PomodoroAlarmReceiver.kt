package com.noridroid

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 番茄钟闹钟兜底接收器: 进程存活时 Handler 已准点完成并回到 idle, 这里幂等跳过;
 * 进程被杀后由此唤起，先持久化完成事件再按通知偏好提醒；页面打开时幂等补账。
 */
class PomodoroAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        runCatching { PomodoroEngine.completeIfDue(context) }
    }
}
