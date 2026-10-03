/**
 * B3 闸门: 静态校验"悬浮窗服务 = 合法前台服务"的 AOSP 契约。
 *
 * 为什么需要: 这条链路的每个环节都只在**真机 + 后台状态**下才出错, 单测和构建都不会报。
 * 校验的是契约事实 (来自 android14-release AOSP 源码):
 *   ① Manifest 声明 foregroundServiceType="specialUse" + PROPERTY_SPECIAL_USE_FGS_SUBTYPE
 *      —— targetSdk 34 起 foregroundServiceType 未声明时 startForeground 会抛
 *      MissingForegroundServiceTypeException。
 *   ② Manifest 声明 FOREGROUND_SERVICE + FOREGROUND_SERVICE_SPECIAL_USE 权限
 *      —— 缺权限时 startForeground 抛 SecurityException (ActiveServices L2024-2028 对
 *      targetSdk >= P enforcePermission(FOREGROUND_SERVICE); specialUse 另有类型级权限)。
 *   ③ 悬浮窗启动走 startForegroundService (而非裸 startService)。
 *   ④ ACTION_SHOW 分支里 startForeground 在 addView 之前
 *      —— 顺序反了会踩 ActiveServices L5600: 被 startForegroundService 拉起却没进入前台的
 *      服务一旦结束, 系统以 ForegroundServiceDidNotStartInTimeException 杀掉进程。
 *   ⑤ 控制类指令 (HIDE/PAUSED/PLAY_MARKER/PLAY_BY_TEXT/RENDER_SCALE) 保持普通 startService
 *      —— 它们会 stopSelf(); 用 startForegroundService 就会落进 ④ 的崩溃分支。
 *   ⑥ 通知 id / requestCode 不与 PomodoroEngine 冲突。
 *   ⑦ 不再有裸 `catch (_: Exception) { }` 吞掉悬浮窗启动失败。
 *   ⑧ 触摸/命中/窗口 flag/手势语义未被改动 (回归保护)。
 *   ⑨ 通知小图标是白色剪影 (彩色/不透明图会在状态栏变成白方块)。
 *
 * 这是源码一致性检查, 不是行为测试 —— 行为需要真机 (见文件末尾说明)。
 */
import {readFileSync} from "node:fs"
import path from "node:path"

// 默认按"本脚本位于 <android>/web-src/tmp-memcheck"推导; 也可用 NORI_ANDROID 显式指定,
// 这样脚本能放在仓库外运行，不会在工作区留下未跟踪文件。
const root = process.env.NORI_ANDROID || path.resolve(import.meta.dirname, "../..")
const read = p => readFileSync(path.join(root, p), "utf8")

/**
 * 去掉 Kotlin/XML 注释后再做正则判断。
 * 必需: 这些文件的注释里大量提到 `startForegroundService` / `startService` 等词 (我写的说明),
 * 不去注释的话 "代码里用了哪个 API" 会被注释误判 —— 反证测试 (把 startForegroundService 换成
 * startService) 曾经因此漏报。字符串字面量要保留 (URL 里的 "//" 不是注释)。
 */
function stripComments(src) {
	let out = ""
	let i = 0
	const n = src.length
	while (i < n) {
		const c = src[i]
		if (c === '"' || c === "'") {
			// 字符串/字符字面量: 原样搬运, 处理转义
			const q = c
			out += c
			i++
			while (i < n) {
				if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue }
				if (src[i] === q) { out += src[i]; i++; break }
				out += src[i]; i++
			}
			continue
		}
		if (c === "/" && src[i + 1] === "/") {
			while (i < n && src[i] !== "\n") i++
			continue
		}
		if (c === "/" && src[i + 1] === "*") {
			i += 2
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++
			i += 2
			continue
		}
		if (c === "<" && src[i + 1] === "!" && src[i + 2] === "-" && src[i + 3] === "-") {
			i += 4
			while (i < n && !(src[i] === "-" && src[i + 1] === "-" && src[i + 2] === ">")) i++
			i += 3
			continue
		}
		out += c
		i++
	}
	return out
}

const MANIFEST = "app/src/main/AndroidManifest.xml"
const FLOAT = "app/src/main/java/com/noridroid/FloatService.kt"
const CHAT = "app/src/main/java/com/noridroid/ChatBridge.kt"
const MAIN = "app/src/main/java/com/noridroid/MainActivity.kt"
const POMODORO = "app/src/main/java/com/noridroid/PomodoroEngine.kt"

let bad = 0
let total = 0
const check = (ok, label, extra = "") => {
	total += 1
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`)
	if (!ok) bad += 1
}

// 注释里的 API 名字不能算数 → 判断前统一去注释
const manifest = stripComments(read(MANIFEST))
const float = stripComments(read(FLOAT))
const chat = stripComments(read(CHAT))
const main = stripComments(read(MAIN))
// 契约/ID 的存在性断言可以带注释看 (避免注释里写了却没实现的情况)
const floatRaw = read(FLOAT)

// ---- ① Manifest 服务声明 ----
check(/<service[^>]*\.FloatService[\s\S]{0,400}?foregroundServiceType\s*=\s*"specialUse"/.test(manifest),
	"① Manifest: FloatService 声明 foregroundServiceType=\"specialUse\"")
check(/PROPERTY_SPECIAL_USE_FGS_SUBTYPE/.test(manifest),
	"① Manifest: 声明 PROPERTY_SPECIAL_USE_FGS_SUBTYPE (specialUse 的用途说明)")
check(/<service[^>]*\.FloatService[\s\S]{0,200}?android:exported="false"/.test(manifest),
	"① Manifest: FloatService 仍 exported=false (不对外暴露)")

// ---- ② Manifest 权限 ----
check(/android\.permission\.FOREGROUND_SERVICE"/.test(manifest),
	"② Manifest: 声明 FOREGROUND_SERVICE")
check(/android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE"/.test(manifest),
	"② Manifest: 声明 FOREGROUND_SERVICE_SPECIAL_USE")
check(/SYSTEM_ALERT_WINDOW/.test(manifest),
	"② Manifest: 仍持有 SYSTEM_ALERT_WINDOW (后台启动前台服务的豁免理由)")

// ---- ③ 启动 API ----
check(/fun startShow\s*\(/.test(float), "③ FloatService 提供 startShow() 统一入口")
check(/startForegroundService\s*\(/.test(float), "③ startShow 使用 startForegroundService")
check(/Build\.VERSION\.SDK_INT\s*>=\s*Build\.VERSION_CODES\.O[\s\S]{0,200}?startForegroundService|startForegroundService[\s\S]{0,200}?else[\s\S]{0,120}?startService/.test(float),
	"③ startForegroundService 有 API 26 分支保护 (低版本退回 startService)")

// 所有 ACTION_SHOW 调用点都走 startShow
// 注意: 这些 .kt 文件用 4 空格缩进 (不是 tab), 所以用大括号配平切函数体, 不靠缩进猜。
function ktBlock(src, signature) {
	const i = src.indexOf(signature)
	if (i < 0) return null
	const open = src.indexOf("{", i)
	if (open < 0) return null
	let depth = 0
	for (let j = open; j < src.length; j++) {
		if (src[j] === "{") depth++
		else if (src[j] === "}") {
			depth--
			if (depth === 0) return src.slice(i, j + 1)
		}
	}
	return null
}
{
	const b = ktBlock(chat, "fun showFloat()")
	check(!!b && /FloatService\.startShow\(/.test(b),
		"③ ChatBridge.showFloat 走 FloatService.startShow")
	check(!!b && !/startForegroundService/.test(b),
		"③ ChatBridge.showFloat 自身不重复调用 startForegroundService (封装在 startShow 里)")
}
check(!/setAction\(FloatService\.ACTION_SHOW\)/.test(chat),
	"③ ChatBridge 里不再有裸 ACTION_SHOW startService")
check(!/setAction\(FloatService\.ACTION_SHOW\)/.test(main),
	"③ MainActivity 里不再有裸 ACTION_SHOW startService")
check((main.match(/FloatService\.startShow\(/g) || []).length >= 2,
	"③ MainActivity 两处退出路径都走 startShow (onPause + onDestroy)",
	`实际=${(main.match(/FloatService\.startShow\(/g) || []).length}`)

// ---- ④ startForeground 早于 addView ----
// 取 ACTION_SHOW 的"else -> {" 分支窗口, 去掉注释后比较两个调用的先后。
const elseIdx = float.search(/else\s*->\s*\{/)
check(elseIdx >= 0, "④ 能定位到 onStartCommand 的 else (ACTION_SHOW) 分支")
if (elseIdx >= 0) {
	const window = float.slice(elseIdx, elseIdx + 1400).replace(/\/\/[^\n]*/g, "")
	const iFg = window.indexOf("promoteToForeground()")
	const iShow = window.indexOf("showFloat()")
	check(iFg >= 0 && iShow >= 0 && iFg < iShow,
		"④ ACTION_SHOW 分支: startForeground 先于 addView (避免未进前台就被结束)",
		`startForeground@${iFg} addView@${iShow}`)
}

// ---- ⑤ 控制类指令保持普通 startService ----
// 按函数体逐个断言: 必须出现 startService(intent), 且不得出现 startForegroundService。
function bodyOf(src, signature) {
	const i = src.indexOf(signature)
	if (i < 0) return null
	// 取到下一个顶层方法注释/方法声明为止 (够用即可)
	return src.slice(i, i + 1200)
}
for (const [label, fn, action] of [
	["hideFloat", "fun hideFloat()", "FloatService.ACTION_HIDE"],
	["playFloatMarker", "fun playFloatMarker(", "FloatService.ACTION_PLAY_MARKER"],
	["playFloatByText", "fun playFloatByText(", "FloatService.ACTION_PLAY_BY_TEXT"],
	["setFloatRenderScale", "fun setFloatRenderScale(", "FloatService.ACTION_RENDER_SCALE"],
]) {
	const b = bodyOf(chat, fn)
	check(!!b && b.includes(action) && /startService\(intent\)/.test(b) && !/startForegroundService/.test(b),
		`⑤ ChatBridge.${label} 用普通 startService 发送 ${label} (会 stopSelf, 不能走 FGS 契约)`)
}
{
	const b = bodyOf(main, "private fun setFloatPaused(")
	check(!!b && b.includes("ACTION_SET_PAUSED") && /startService\(/.test(b) && !/startForegroundService/.test(b),
		"⑤ MainActivity.setFloatPaused 用普通 startService 发送 ACTION_SET_PAUSED")
}

// ---- ⑥ 通知 id 不冲突 ----
// 用 floatRaw (常量声明在主源码里, 去不去注释都一样; 但保持与 ①② 分开更清晰)
const pomodoro = read(POMODORO)
const fgsId = (floatRaw.match(/FGS_NOTIF_ID\s*=\s*(\d+)/) || [])[1]
const fgsPi = (floatRaw.match(/FGS_PI_REQ\s*=\s*(\d+)/) || [])[1]
const pomNotif = (pomodoro.match(/NOTIF_ID\s*=\s*(\d+)/) || [])[1]
const pomAlarm = (pomodoro.match(/ALARM_REQ\s*=\s*(\d+)/) || [])[1]
check(fgsId && pomNotif && fgsId !== pomNotif,
	"⑥ 前台通知 id 与番茄钟通知 id 不同", `float=${fgsId} pomodoro=${pomNotif}`)
check(fgsPi && pomAlarm && fgsPi !== pomAlarm,
	"⑥ PendingIntent requestCode 与番茄钟不同", `float=${fgsPi} pomodoro=${pomAlarm}`)
check(/FGS_CHANNEL\s*=\s*"(?!pomodoro)/.test(float),
	"⑥ 通知渠道名与番茄钟的 \"pomodoro\" 不同")

// ---- ⑦ 失败被记录而非静默吞掉 ----
check(!/startService\(Intent\(this, FloatService[\s\S]{0,120}catch\s*\(_:\s*Exception\)\s*\{\s*\}/.test(main),
	"⑦ MainActivity 不再静默吞掉悬浮窗启动失败")
// 三条失败路径各自记录 (它们分属不同文件, 所以跨文件检查)
check(/floatForegroundFailed/.test(float), "⑦ FloatService 记录 startForeground 失败 (floatForegroundFailed)")
check(/floatShowFailed/.test(float), "⑦ FloatService 记录 addView 失败 (floatShowFailed)")
check(/floatStartFailed/.test(main), "⑦ MainActivity 记录悬浮窗启动失败 (floatStartFailed)")
check(/floatStartFailed/.test(chat), "⑦ ChatBridge 记录悬浮窗启动失败 (floatStartFailed)")
check(/LifecycleLog\.record\(appContext, "floatStartFailed"/.test(chat),
	"⑦ ChatBridge.showFloat 失败会落盘记录")

// ---- 回归保护: 不得改动触摸/命中/窗口 flag 语义 ----
check(/FLAG_NOT_FOCUSABLE/.test(float) && /PixelFormat\.TRANSLUCENT/.test(float),
	"⑧ 窗口 flag/格式未被改动 (FLAG_NOT_FOCUSABLE + TRANSLUCENT)")
check(/TYPE_APPLICATION_OVERLAY/.test(float), "⑧ 仍使用 TYPE_APPLICATION_OVERLAY")
check(/START_NOT_STICKY/.test(float), "⑧ 仍返回 START_NOT_STICKY")
check(/onTaskRemoved[\s\S]{0,120}?stopSelf\(\)/.test(float),
	"⑧ onTaskRemoved 仍 stopSelf (划掉应用时悬浮窗消失)")

// ---- ⑨ 通知小图标必须是白色剪影 (不能复用彩色启动图标) ----
// 系统对通知小图标只取 alpha 通道并统一染白: 填彩色会丢掉颜色; 整幅不透明
// (如 R.mipmap.ic_launcher) 就会在状态栏显示成一个白色实心方块。
const STAT = "app/src/main/res/drawable/ic_stat_nori.xml"
const stat = read(STAT)
check(/<vector/.test(stat) && /android:width="24dp"/.test(stat) && /android:height="24dp"/.test(stat),
	"⑨ 通知小图标 ic_stat_nori.xml 是 24dp 矢量图")
check(!/fillColor\s*=\s*"#(?!FFFFFF)/i.test(stat) && !/strokeColor\s*=\s*"#(?!FFFFFF)/i.test(stat),
	"⑨ 剪影只有纯白填充 (彩色会被系统丢弃, 只剩白块)")
check(/setSmallIcon\(R\.drawable\.ic_stat_nori\)/.test(float),
	"⑨ FloatService 使用剪影图标")
check(/setSmallIcon\(R\.drawable\.ic_stat_nori\)/.test(pomodoro),
	"⑨ PomodoroEngine 同步改用剪影图标")
check(!/setSmallIcon\(R\.mipmap\.ic_launcher\)/.test(float + pomodoro),
	"⑨ 不再有 setSmallIcon(R.mipmap.ic_launcher) (彩色不透明图)")

console.log(bad ? `\n${bad} 项未通过` : "\n全部通过: B3 前台服务契约校验")
// 统一给 run-all-gates.mjs 读的计数行 (它 tail 里找 "N/N passed")
console.log(`${total - bad}/${total} passed`)
if (!bad) {
	console.log(`
注意 (本闸门无法覆盖): 真机行为需人工确认 ——
  · Android 14+ 设备: 退出应用后悬浮窗仍存在 (不再被系统收走), 且有"悬浮窗运行中"通知
  · 通知渠道为"低重要性"(静默), 不发声不弹横幅
  · 无悬浮窗权限时: 悬浮窗不出现, 但应用**不闪退**, lifecycle.log 里有记录
  · 划掉最近任务: 悬浮窗消失, 通知同步消失
  · 触摸/拖动/缩放/抚摸/气泡定位与改动前一致`)
}

process.exitCode = bad ? 1 : 0
