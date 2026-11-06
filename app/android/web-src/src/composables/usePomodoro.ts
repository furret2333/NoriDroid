import {computed, nextTick, reactive, ref, watch, type Ref, type UnwrapNestedRefs} from "vue"
import {readFileState} from "../services/chat"
import {DEFAULT_POMO, normalizePomo, projectLiveDays, parsePomoBackup, pomoCsv} from "../services/pomodoro"
import {
    summarize as pomoSummarize, buildHeatmap, monthlyRollup, migrateStats, addToStore,
    dayMinutes, shiftDay, dayKey as pomoStatDayKey,
    type PomoStatsFile, type PomoSummary, type Heatmap,
} from "../services/pomo-stats"
import {isTtsReady, speak as speakTTS} from "../services/tts"
import {playSfxFile} from "../services/sfx"
import type {AppSettings} from "./useAppSettings"

export interface PomodoroOptions {
    cfg: AppSettings
    panel: Readonly<Ref<string>>
    showPanel: (panel: "pomo" | "pomoStats") => void
    persistSettings: () => string
    applyQuiet: () => void
}

/** The native engine owns timing; this controller owns its main-window presentation. */
export const usePomodoro = ({cfg, panel, showPanel, persistSettings, applyQuiet}: PomodoroOptions) => {
    const pomoFocusMuteOn = ref(false)
	type PomoPhase = "idle" | "focus" | "break" | "countUp"
	interface PomoStateT {now?: number; days?: Record<string, number>; sessionId?: string; revision?: number; eventSeq?: number; goal?: string; rounds?: number; longEvery?: number; cycleEnabled?: boolean; isLongBreak?: boolean; rebootPending?: boolean; durationMs?: number; autoFocus?: boolean; phase: PomoPhase; paused: boolean; endAt: number; remainMs: number; focusMin: number; breakMin: number; autoBreak: boolean; startedAt: number; elapsedMs?: number; remainingMs?: number}
	interface PomoDay {focusMin: number; done: number; abort: number; countUpMin: number}
	interface PomoBridgeT {
	    pomoDashboard?: () => string
	    pomoStartPlan?: (options: string) => string
	    pomoStartFree?: (goal: string) => string
	    pomoReminderSettings?: (kind: string) => void
	    pomoResolveReboot?: (include: boolean) => string
	    pomoRestoreBackup?: (content: string) => string
	    pickPomoBackup?: () => void
	    pomoOpenedFromNotification?: () => boolean
		readFile?: (n: string) => string
		writeFile?: (n: string, c: string) => string
		pomoStart?: (f: number, b: number, ab: boolean) => string
		pomoStartCountUp?: () => string
		pomoPause?: () => string
		pomoResume?: () => string
		pomoStop?: () => string
	    pomoStopSession?: (session: string) => string
		pomoState?: () => string
		pomoRequestNotify?: () => void
		pomoSetNotify?: (enabled: boolean) => void
		pomoStats?: () => string
		pomoMarkCelebrated?: (key: string) => string
	}
	const noriB = (): PomoBridgeT | null => (window as unknown as {NoriChat?: PomoBridgeT}).NoriChat ?? null

	const pomo = ref<PomoStateT>({phase: "idle", paused: false, endAt: 0, remainMs: 0, focusMin: 25, breakMin: 5, autoBreak: true, startedAt: 0})
	const pomoWidgetOn = ref(false)
	const pomoMini = ref(false)
	const pomoFocus = ref(false)
	const pomoPos = ref({x: 16, y: 96, w: 260})
	const pomoCfg = reactive({...DEFAULT_POMO})
	const pomoStatsReady = ref(false)
	const pomoError = ref("")
	const pomoConfigError = ref("")
	const pomoMessage = ref("")
	const pomoBusy = ref(false)
	const pomoSyncedAt = ref(0)
	const pomoSyncPending = ref(false)
	const pomoReminder = ref<{permission: boolean; channel: boolean; controlChannel?: boolean; exact: boolean; scheduleError?: string} | null>(null)
	const pomoDisplayAt = ref(performance.now())
	const pomoQuietHeld = ref(false)
	let pomoSettingsReady = false
	let pomoConfigTimer = 0
	let pomoNeedsMigration = false
	let pomoSettingsReadable = true
	let pomoBackupContent = ""
	const pomoRestorePreview = ref("")
	const pomoConfirmEnd = ref(false)
	const POMO_PRESETS = [
		{label: "25+5", focus: 25, break: 5},
		{label: "52+17", focus: 52, break: 17},
		{label: "90+20", focus: 90, break: 20},
		{label: "15+3", focus: 15, break: 3},
	]
	// 音效不再打进包 (2026-10-02): 全部走本地目录 /sfx-local/ 供流 (设置里「下载音效」下到本机)
	const POMO_SFX = {start: "/sfx-local/start.m4a", complete: "/sfx-local/complete.m4a", ret: "/sfx-local/return.m4a", abandon: "/sfx-local/abandon.m4a"}
	// PomoStatsFile 类型: 多了可选的 celebrated (里程碑) 与 total/best (终身累计/最佳记录)。
	// **必须是 reactive**: 模板直接读 pomoStats.total / .best, 而 pomoDay/addToStore/migrateStats
	// 都是原地改这个对象 —— 用普通 let 时改动不触发重渲染 (统计页的"累计"会一直显示加载前的 0)。
	const pomoStats = reactive<PomoStatsFile>({v: 1, days: {}})

	// 日期键统一用 services/pomo-stats 里的 dayKey (原此处另有一份同实现, 已删, 避免两处漂移)
	const pomoDayKey = pomoStatDayKey
	const pomoDate = ref(new Date())
	const pomoDay = (): PomoDay => {
		const k = pomoDayKey()
		if (!pomoStats.days[k]) pomoStats.days[k] = {focusMin: 0, done: 0, abort: 0, countUpMin: 0}
		return pomoStats.days[k]
	}
	const pomoApplyStats = (parsed: PomoStatsFile): void => {
	    if (!parsed || typeof parsed.days !== "object" || !parsed.days || Array.isArray(parsed.days)) throw new Error("专注记录格式异常")
	    Object.assign(pomoStats, {v: 2, days: {}, total: undefined, best: undefined, celebrated: {}, lastEventSeq: 0}, parsed)
	    pomoStatsReady.value = true
	}
	const pomoAcceptDashboard = (raw: string): void => {
	    const result = JSON.parse(raw)
	    if (result.ok === false) throw new Error(result.message || "记录读取失败")
	    if (!result.state || !result.stats) throw new Error("计时状态读取不完整")
	    if (!["idle", "focus", "break", "countUp"].includes(result.state.phase)) throw new Error("计时状态格式异常")
	    pomoApplyStats(result.stats)
	    pomoStateSet(JSON.stringify(result.state))
	    pomoSyncPending.value = result.syncStatus !== "ok"
	    pomoSyncedAt.value = Number(result.syncedAt) || 0
	    pomoReminder.value = result.reminder || null
	    pomoError.value = ""
	}
	const pomoStatsLoad = (): void => {
	    try {
	        const b = noriB()
	        if (b?.pomoDashboard) { pomoAcceptDashboard(b.pomoDashboard()); return }
	        const raw = b?.pomoStats ? b.pomoStats() : b?.readFile?.("pomo.json") || ""
	        if (!raw) { if (!b?.pomoStats) { pomoStatsReady.value = true; return }; throw new Error("暂时无法读取记录") }
	        const parsed = JSON.parse(raw)
	        if (parsed.ok === false) throw new Error(parsed.message)
	        pomoApplyStats(parsed)
	        if (!b?.pomoStats && migrateStats(pomoStats)) pomoStatsSave()
	        pomoError.value = ""
	    } catch (e) { pomoError.value = `记录暂未更新：${(e as Error).message}。已保留上次显示。` }
	}
	const pomoStatsSave = (): void => {
	    try { if (noriB()?.writeFile?.("pomo.json", JSON.stringify(pomoStats)) !== "ok") throw new Error("文件不可写") }
	    catch (e) { pomoError.value = `记录保存失败：${(e as Error).message}` }
	}
	const pomoCfgLoad = (): void => {
	    try {
	        const file = readFileState("settings.json")
	        if (file.status === "error") { pomoSettingsReadable = false; throw new Error("设置暂不可读") }
	        const settings = file.status === "ok" ? JSON.parse(file.content) : {}
	        const legacy = localStorage.getItem("pomo_cfg")
	        Object.assign(pomoCfg, normalizePomo(settings.pomo || (legacy ? JSON.parse(legacy) : {})))
	        pomoNeedsMigration = !settings.pomo
	        pomoSettingsReadable = true
	        pomoConfigError.value = ""
	    } catch { pomoConfigError.value = "设置暂未恢复；读取恢复前不会自动覆盖旧设置。"; pomoSettingsReadable = false }
	}
	watch(pomoCfg, () => {
	    if (!pomoSettingsReady || !pomoSettingsReadable) return
	    if (pomoConfigTimer) clearTimeout(pomoConfigTimer)
	    pomoConfigTimer = window.setTimeout(() => {
	        Object.assign(pomoCfg, normalizePomo(pomoCfg))
	        const result = persistSettings()
	        pomoConfigError.value = result === "ok" ? "" : "专注设置未保存，请检查存储权限后重试。"
	        if (result === "ok") { pomoNeedsMigration = false; localStorage.removeItem("pomo_cfg") }
	        pomoSyncFocus()
	    }, 400)
	}, {deep: true})

	let pomoSnapshotAt = performance.now()

	const pomoStateSet = (json: string): boolean => {
		try {
			const s = JSON.parse(json)
			if (!s || !["idle", "focus", "break", "countUp"].includes(s.phase)) { pomoError.value = s?.message || "计时状态读取失败，请重试"; return false }
			const finiteMs = (v: unknown): number => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0
			pomo.value = {now: finiteMs(s.now) || Date.now(), days: s.days || {}, sessionId: s.sessionId, revision: finiteMs(s.revision), eventSeq: finiteMs(s.eventSeq), goal: String(s.goal || ""), rounds: finiteMs(s.rounds), longEvery: finiteMs(s.longEvery), cycleEnabled: !!s.cycleEnabled, isLongBreak: !!s.isLongBreak, rebootPending: !!s.rebootPending, durationMs: finiteMs(s.durationMs), autoFocus: !!s.autoFocus, phase: s.phase, paused: !!s.paused, endAt: finiteMs(s.endAt), remainMs: finiteMs(s.remainMs), focusMin: finiteMs(s.focusMin), breakMin: finiteMs(s.breakMin), autoBreak: !!s.autoBreak, startedAt: finiteMs(s.startedAt),
				...(s.elapsedMs !== undefined ? {elapsedMs: finiteMs(s.elapsedMs), remainingMs: finiteMs(s.remainingMs)} : {})}
			pomoSnapshotAt = performance.now()
	        pomoDisplayAt.value = pomoSnapshotAt
	        return true
		} catch { pomoError.value = "计时状态读取失败，请重试"; return false }
	}
	const pomoSyncFocus = (): void => {
	    const active = pomo.value.phase !== "idle"
	    if (active && !pomoFocus.value) pomoFocusMuteStart()
	    else if (!active && pomoFocus.value) pomoFocusMuteEnd()
	    pomoFocus.value = active
	    if (active) pomoWidgetOn.value = true
	    pomoFocusMuteOn.value = !pomoQuietUser && (pomoSulk?.stage === "sulk" || active && (pomo.value.paused ? pomoCfg.quietPaused : pomo.value.phase === "break" ? pomoCfg.quietBreak : pomoCfg.quietFocus))
	    pomoQuietHeld.value = pomoFocusMuteOn.value
	    applyQuiet()
	}

	/** 原生推送入口 (PomodoroEngine.evaluateJavascript) */
	;(window as unknown as {__noriPomoEvent?: (json: string) => void}).__noriPomoEvent = (json: string) => {
		try {
			const e = JSON.parse(json)
			if (e?.type === "state") { pomoRefresh(); return }
	        if (!e || e.type !== "end") return
			if (e.seq && e.seq <= pomoLastAnnounced) { pomoRefresh(); return }
			if (e.seq) pomoLastAnnounced = e.seq
			const b = noriB()
			if (b?.pomoState) pomoStateSet(b.pomoState())
			pomoSyncFocus()
			pomoStatsLoad()
			pomoUpdateDisplay()
			// 已结束很久的后台事件只补账，避免重新打开时连续播报旧提示。
			if (e.reason && e.reason !== "complete" || e.endedAt && Date.now() - e.endedAt > 15000) return
			pomoMessage.value = e.phase === "focus" ? `本段 ${Math.round((e.elapsedMs || pomo.value.focusMin * 60000) / 60000)} 分钟已记录，做得很好。今天已积累 ${pomoSummary.value.todayMin} 分钟。` : "休息结束了，准备好再继续。"
			if (e.phase === "focus") {
				// 专注到点后进入休息 —— 仍在一个番茄周期内, 保持静音, 不在这里还原
				if (!b?.pomoStats) {
					const day = pomoDay()
					day.done++; day.focusMin += pomo.value.focusMin
					addToStore(pomoStats, {focusMin: pomo.value.focusMin, done: 1})
					pomoStatsSave()
				}
				if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.complete)
				if (pomoCfg.feedback !== "silent" && isTtsReady(cfg)) { try { void speakTTS(cfg, "专注完成，做得很好。休息一下吧，我看着时间。") } catch { /* 忽略 */ } }
			} else {
				// 休息结束 = 一个完整番茄跑完 → 还原进专注前的安静设置 (BGM 恢复)
				if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.ret)
				if (pomoCfg.feedback !== "silent" && isTtsReady(cfg)) { try { void speakTTS(cfg, "休息够了？回来吧，我陪着你。") } catch { /* 忽略 */ } }
			}
		} catch { /* 忽略 */ }
	}
	let pomoLastAnnounced = 0

	/* 可见且运行时每秒推进显示，原生仅低频校准及核对到点状态。 */
	const pomoFmt = ref("00:00")
	const pomoPct = ref(0)
	const pomoFmtOf = (sec: number): string => {
		const h = Math.floor(sec / 3600)
		const m = Math.floor((sec % 3600) / 60)
		const s2 = sec % 60
		const core = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}`
		return core
	}
	const pomoTick = (): void => {
	    pomoDisplayAt.value = performance.now()
		const s = pomo.value
		if (s.phase === "idle") { pomoFmt.value = "00:00"; pomoPct.value = 0; return }
		const now = Date.now()
		const delta = s.paused ? 0 : Math.max(0, performance.now() - pomoSnapshotAt)
		if (s.phase === "countUp") {
			const el = Math.max(0, s.elapsedMs !== undefined ? s.elapsedMs + delta : s.paused ? s.remainMs : now - s.startedAt)
			pomoFmt.value = pomoFmtOf(Math.floor(el / 1000))
			pomoPct.value = 0
			return
		}
		const total = s.durationMs ? s.durationMs / 1000 : (s.phase === "focus" ? s.focusMin : s.breakMin) * 60
		const left = s.remainingMs !== undefined ? Math.max(0, Math.ceil((s.remainingMs - delta) / 1000))
			: s.paused ? Math.ceil(s.remainMs / 1000) : Math.max(0, Math.ceil((s.endAt - now) / 1000))
		pomoFmt.value = pomoFmtOf(left)
		pomoPct.value = total > 0 ? Math.min(100, Math.round(((total - left) / total) * 100)) : 0
	}
	let pomoTickTimer = 0
	let pomoDateTimer = 0
	const pomoRefresh = (stats = true): void => {
		const previousPhase = pomo.value.phase
		try { const b = noriB(); if (b?.pomoState) pomoStateSet(b.pomoState()) } catch { pomoError.value = "计时状态暂未更新，请重试。" }
		pomoSyncFocus()
		// 原生完成回调即使未送达，轮询发现阶段变化时也立即同步账本。
		if (stats || previousPhase !== pomo.value.phase) pomoStatsLoad()
	    pomoSyncFocus()
		pomoUpdateDisplay()
	}
	let pomoLastCalibrated = performance.now()
	const pomoUpdateDisplay = (): void => {
	    pomoTick()
	    const running = !document.hidden && pomo.value.phase !== "idle" && !pomo.value.paused
	    if (!running && pomoTickTimer) { clearInterval(pomoTickTimer); pomoTickTimer = 0 }
	    if (running && !pomoTickTimer) pomoTickTimer = window.setInterval(() => {
	        pomoTick()
	        if (performance.now() - pomoLastCalibrated >= 10000 || pomo.value.phase !== "countUp" && pomoFmt.value === "00:00") {
	            pomoLastCalibrated = performance.now(); pomoRefresh(false)
	        }
	    }, 1000)
	}
	const pomoRefreshDate = (): void => {
		pomoDate.value = new Date()
		if (pomoDateTimer) clearTimeout(pomoDateTimer)
		if (document.hidden) { pomoDateTimer = 0; return }
		const midnight = new Date()
		midnight.setHours(24, 0, 0, 20)
		pomoDateTimer = window.setTimeout(pomoRefreshDate, Math.max(1, midnight.getTime() - Date.now()))
	}

	/* ---------------- 番茄钟静音：周期/放弃保持/用户接管 ---------------- */
	const FOCUS_MUTE_KEY = "pomo_focus_mute_snapshot"
	type PomoQuiet = {v?: number; mode: string; on: boolean; stage: "cycle" | "sulk"; until: number; timer: number}
	let pomoSulk: PomoQuiet | null = null
	let pomoQuietUser = false
	const saveFocusMuteSnapshot = (): void => {
	    try {
	        const value = pomoQuietUser ? {stage: "user", v: 2} : pomoSulk
	        if (value) localStorage.setItem(FOCUS_MUTE_KEY, JSON.stringify({...value, timer: 0}))
	        else localStorage.removeItem(FOCUS_MUTE_KEY)
	    } catch { /* 非权威的显示策略快照 */ }
	}
	const clearFocusMuteSnapshot = (): void => { try { localStorage.removeItem(FOCUS_MUTE_KEY) } catch { /* ignore */ } }
	const pomoFocusMuteStart = (): void => {
	    if (pomoQuietUser) return
	    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
	    pomoSulk = {v: 2, mode: cfg.quietMode, on: cfg.quietOn, stage: "cycle", until: 0, timer: 0}
	    saveFocusMuteSnapshot()
	}
	const pomoFocusMuteEnd = (): void => {
	    if (pomoSulk?.stage === "cycle") pomoSulkRestore()
	    if (pomoQuietUser) { pomoQuietUser = false; clearFocusMuteSnapshot() }
	}
	const pomoSulkRestore = (): void => {
	    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
	    // 只还原旧版曾持久化改写过的全局设置；新版是临时覆盖策略。
	    if (pomoSulk && pomoSulk.v !== 2) { cfg.quietMode = pomoSulk.mode; cfg.quietOn = pomoSulk.on; persistSettings() }
	    pomoSulk = null; pomoFocusMuteOn.value = false; pomoQuietHeld.value = false
	    clearFocusMuteSnapshot(); applyQuiet()
	}
	const pomoArmSulk = (): void => {
	    if (!pomoSulk || pomoSulk.stage !== "sulk" || !pomoSulk.until) return
	    if (pomoSulk.timer) clearTimeout(pomoSulk.timer)
	    const left = pomoSulk.until - Date.now()
	    if (left <= 0) { pomoSulkRestore(); return }
	    pomoSulk.timer = window.setTimeout(pomoSulkRestore, left)
	}
	const pomoSulkStart = (): void => {
	    if (pomoQuietUser || !pomoCfg.quietFocus) return
	    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
	    pomoSulk = {v: 2, mode: cfg.quietMode, on: cfg.quietOn, stage: "sulk", until: pomoCfg.sulkMin > 0 ? Date.now() + pomoCfg.sulkMin * 60000 : 0, timer: 0}
	    saveFocusMuteSnapshot(); pomoArmSulk()
	}
	const pomoSulkCancelByUser = (): void => {
	    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
	    pomoSulk = null; pomoQuietUser = pomo.value.phase !== "idle"
	    pomoFocusMuteOn.value = false; pomoQuietHeld.value = false; saveFocusMuteSnapshot()
	}
	const recoverFocusMuteIfNeeded = (): void => {
	    try {
	        const raw = localStorage.getItem(FOCUS_MUTE_KEY), snap = raw ? JSON.parse(raw) : null
	        if (snap?.stage === "user") pomoQuietUser = pomo.value.phase !== "idle"
	        else if (snap && ["off", "auto", "manual"].includes(snap.mode)) {
	            if (snap.v !== 2) { cfg.quietMode = snap.mode; cfg.quietOn = !!snap.on; persistSettings() }
	            pomoSulk = {...snap, v: 2, stage: snap.stage === "sulk" ? "sulk" : "cycle", until: Number(snap.until) || 0, timer: 0}
	        }
	    } catch { clearFocusMuteSnapshot() }
	    if (pomo.value.phase === "idle" && pomoSulk?.stage === "cycle") pomoSulkRestore()
	    pomoArmSulk(); pomoSyncFocus()
	}

	/* 操作 */
	const pomoStartImpl = (f: number, b: number): void => {
		const b2 = noriB()
		if (!b2?.pomoStart) return
		pomoQuietUser = false
		b2.pomoSetNotify?.(pomoCfg.notify)
		if (!pomoStateSet(b2.pomoStartPlan ? b2.pomoStartPlan(JSON.stringify(normalizePomo({...pomoCfg, focusMin: f, breakMin: b}))) : b2.pomoStart(Math.min(120, Math.max(5, Math.round(f))), Math.min(30, Math.max(1, Math.round(b))), pomoCfg.autoBreak))) return
		pomoWidgetOn.value = true
		pomoFocusMuteStart()
		pomoSyncFocus()
		pomoStatsLoad()
		pomoUpdateDisplay()
		if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.start)
		if (pomoCfg.notify && pomoReminder.value?.permission === false) pomoMessage.value = "计时已开始；系统通知未开启，可在循环与提醒中开启。"
	}
	const pomoCountUpImpl = (): void => {
		const b = noriB()
		if (!b?.pomoStartCountUp) return
		pomoQuietUser = false
		b.pomoSetNotify?.(pomoCfg.notify)
		if (!pomoStateSet(b.pomoStartFree ? b.pomoStartFree(pomoCfg.goal) : b.pomoStartCountUp())) return
		pomoWidgetOn.value = true
		pomoFocusMuteStart()
		pomoSyncFocus()
		pomoStatsLoad()
		pomoUpdateDisplay()
		if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.start)
		if (pomoCfg.notify && pomoReminder.value?.permission === false) pomoMessage.value = "计时已开始；系统通知未开启，可在循环与提醒中开启。"
	}
	const pomoPauseBtn = (): void => {
		const b = noriB()
		if (!b) return
		const previousPhase = pomo.value.phase
		if (pomo.value.paused) pomoStateSet(b.pomoResume?.() || "")
		else pomoStateSet(b.pomoPause?.() || "")
		pomoSyncFocus()
		if (previousPhase !== pomo.value.phase) pomoStatsLoad()
		pomoUpdateDisplay()
	}
	const pomoStopBtn = (): number | undefined => {
		const b = noriB()
		if (!b?.pomoStop) return
		let r: PomoStateT & {endedPhase?: PomoPhase; elapsedMs?: number}
	    const raw = b.pomoStopSession && pomo.value.sessionId ? b.pomoStopSession(pomo.value.sessionId) : b.pomoStop()
	    try { r = JSON.parse(raw) } catch { throw new Error("结束结果无法读取，请刷新当前计时") }
	    if (!pomoStateSet(JSON.stringify(r))) { pomoRefresh(); throw new Error("结束未确认，请检查当前计时状态") }
		if (r.endedPhase === "focus") pomoSulkStart()
		pomoSyncFocus()
		pomoUpdateDisplay()
		if (b.pomoStats) pomoStatsLoad()
		if (r.endedPhase === "focus") {
			if (!b.pomoStats) {
				const day = pomoDay()
				const elMin = (r.elapsedMs || 0) / 60000
				day.abort++; day.focusMin += elMin
				addToStore(pomoStats, {focusMin: elMin})
				pomoStatsSave()
			}
			if (pomoCfg.feedback === "character") playSfxFile(POMO_SFX.abandon)
			if (pomoCfg.feedback !== "silent" && isTtsReady(cfg)) { try { void speakTTS(cfg, pomoCfg.feedback === "character" ? "……好吧。" : "这段时间已经记下了，需要时再继续。") } catch { /* 忽略 */ } }
		} else if (r.endedPhase === "countUp") {
			if (!b.pomoStats) {
				const day = pomoDay()
				const elMin = (r.elapsedMs || 0) / 60000
				day.countUpMin += elMin
				addToStore(pomoStats, {countUpMin: elMin})
				pomoStatsSave()
			}
		}
	    return r.elapsedMs || 0
	}
	const pomoGoBtn = (): void => {
		pomoRefresh()
		if (pomo.value.phase === "focus" || pomo.value.phase === "break") { pomoStopBtn(); return }
		pomoStartImpl(pomoCfg.focusMin, pomoCfg.breakMin)
	}
	const pomoCountUpBtn = (): void => {
		pomoRefresh()
		if (pomo.value.phase === "countUp") { pomoStopBtn(); return }
		pomoCountUpImpl()
	}
	const pomoOnNotifyChange = (): void => {
		noriB()?.pomoSetNotify?.(pomoCfg.notify)
		if (pomoCfg.notify) noriB()?.pomoRequestNotify?.()
	}

	/* 面板文案 */
	const pomoPhaseText = computed((): string => {
		if (pomo.value.phase === "focus") return pomo.value.paused ? "已暂停 · 专注" : "专注中"
		if (pomo.value.phase === "break") return (pomo.value.paused ? "已暂停 · " : "") + (pomo.value.isLongBreak ? "长休息" : "休息中")
		if (pomo.value.phase === "countUp") return pomo.value.paused ? "已暂停 · 正向计时" : "正向计时"
		return "未开始"
	})
	const pomoGoLabel = computed((): string => {
		const p = pomo.value.phase
		if (p === "countUp") return "保存并转倒计时"
		if (p === "focus") return "放弃当前"
		if (p === "break") return "结束休息"
		return `开始专注 ${pomoCfg.focusMin} 分钟`
	})
	const pomoTodayText = computed((): string => {
		const d = pomoStats.days[pomoDayKey(pomoDate.value)]
		return `${Math.round(dayMinutes(d))} 分钟 · 完成 ${d?.done || 0} · 中断 ${d?.abort || 0}`
	})
	// 注: 原先这里还有一个固定的 7 天 pomoBars, 已被 pomoRangeBars (7/30/365 可切) 取代并删除

	/* ---------------- 专注统计: 面板展示 + 给 Nori 的克制注入 ----------------
	 * 展示(面板)与注入(Nori 台词)分工不同:
	 *   - 面板给出全部客观数据, 包括完成率/中断这类"自我批评"指标, 是给你自己看的;
	 *   - Nori 嘴里最多提一件**正向且话题相关**的事, 且一天一次 (见 buildFocusHint)。
	 * 汇总计算与注入判定都在 services/pomo-stats.ts (纯逻辑, 有单测)。 */
	const pomoSummary = computed<PomoSummary>(() => pomoSummarize(pomoStats.days, 7, pomoDate.value))

	/* ---- 统计范围切换 (柱状图: 7 / 30 / 365 天) ---- */
	const pomoRange = ref<7 | 30 | 365>(7)
	const pomoRangeBars = computed(() => {
		const n = pomoRange.value
		const out: {day: string; label: string; min: number; h: number}[] = []
		let max = 1
		// 柱子太密时只标部分标签 (30 天每 5 天一个, 365 天只标月份首日)
		const labelStep = n <= 7 ? 1 : n <= 30 ? 5 : 30
		for (let i = n - 1; i >= 0; i--) {
			const d = shiftDay(pomoDate.value, -i)
			const k = pomoDayKey(d)
			const min = Math.round(dayMinutes(pomoStats.days[k]))
			if (min > max) max = min
			const showLabel = n <= 7 || i === 0 || (labelStep > 1 && i % labelStep === 0)
			out.push({
				day: k,
				label: showLabel ? (i === 0 ? "今" : (n > 30 ? `${d.getMonth() + 1}月` : String(d.getDate()))) : "",
				min,
				h: 4,
			})
		}
		for (const o of out) o.h = Math.max(4, Math.round((o.min / max) * 100))
		return out
	})
	const pomoRangeSummary = computed<PomoSummary>(() => pomoSummarize(pomoStats.days, pomoRange.value, pomoDate.value))

	/* ---- 独立统计页: 热力图 + 点选某天 + 月度汇总 ---- */
	const pomoSelectedDay = ref<{date: string; min: number; done: number; abort: number} | null>(null)
	const pomoSelectDate = (date: string): void => {
	    if (!date) return
	    const day = pomoStats.days[date]
	    pomoSelectedDay.value = {date, min: Math.round(dayMinutes(day)), done: day?.done || 0, abort: day?.abort || 0}
	}
	const pomoHeat = computed<Heatmap>(() => buildHeatmap(pomoStats.days, 52, pomoDate.value))
	const pomoMonths = computed(() => monthlyRollup(pomoStats.days, 12, pomoDate.value))
	const pomoHeatCanvas = ref<HTMLCanvasElement | null>(null)

	/** 画热力图: 静态重绘 (数据变化才画), 不参与逐帧 ——
	 *  避免和 Live2D(WebGL) / 数据海(2D canvas) 抢同一个 GPU。 */
	const CELL = 9
	const CELL_GAP = 2
	const drawHeatmap = (): void => {
		const cv = pomoHeatCanvas.value
		if (!cv) return
		const hm = pomoHeat.value
		const dpr = Math.min(window.devicePixelRatio || 1, 2)
		const w = hm.weeks * (CELL + CELL_GAP)
		const hgt = 7 * (CELL + CELL_GAP)
		cv.width = Math.round(w * dpr)
		cv.height = Math.round(hgt * dpr)
		cv.style.width = `${w}px`
		cv.style.height = `${hgt}px`
		const ctx = cv.getContext("2d")
		if (!ctx) return
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, w, hgt)
		const theme = getComputedStyle(cv)
		const accent = theme.getPropertyValue("--px-cyan").trim()
		const empty = theme.getPropertyValue("--px-line").trim()
		const step = CELL + CELL_GAP
		for (let w2 = 0; w2 < hm.weeks; w2++) {
			for (let row = 0; row < 7; row++) {
				const c = hm.cells[w2 * 7 + row]
				if (!c) continue
				ctx.fillStyle = c.level === 0 ? empty : accent
				ctx.globalAlpha = [1, 0.35, 0.55, 0.78, 1][c.level]
				ctx.fillRect(w2 * step, row * step, CELL, CELL)
			}
		}
		ctx.globalAlpha = 1
	}
	/** 点热力图 → 选中某天 (反算列/行) */
	const onHeatClick = (e: MouseEvent): void => {
		const cv = pomoHeatCanvas.value
		if (!cv) return
		const rect = cv.getBoundingClientRect()
		const step = CELL + CELL_GAP
		const col = Math.floor((e.clientX - rect.left) / step)
		const row = Math.floor((e.clientY - rect.top) / step)
		if (col < 0 || col >= pomoHeat.value.weeks || row < 0 || row > 6) return
		const c = pomoHeat.value.cells[col * 7 + row]
		if (!c) return
		const d = pomoStats.days[c.date]
		pomoSelectedDay.value = {date: c.date, min: c.min, done: d?.done || 0, abort: d?.abort || 0}
	}
	/** 进入统计页时画一次 (面板打开后 canvas 才有尺寸) */
	const openPomoStats = (): void => {
		pomoRefresh()
		showPanel("pomoStats")
		void nextTick(() => drawHeatmap())
	}
	// 面板开着时数据变了 (如番茄完成/放弃) → 重绘热力图, 否则它停在旧状态
	watch([pomoHeat, () => panel.value], () => {
		if (pomoSelectedDay.value) pomoSelectDate(pomoSelectedDay.value.date)
		if (panel.value === "pomoStats") void nextTick(() => drawHeatmap())
	})
	/** 累计时长的人话格式 */
	const fmtTotalMin = (m: number): string => {
		const min = Math.round(m)
		return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${min} 分钟`
	}

	/** "今天已经跟 Nori 提过专注"的日期标记 (每天最多提一次, 避免连着聊工作就句句提) */
	const POMO_HINT_DAY_KEY = "pomo_hint_day"
	const focusHintDay = ref<string>(
		(() => { try { return localStorage.getItem(POMO_HINT_DAY_KEY) || "" } catch { return "" } })(),
	)
	/** 清掉过期的"已提过"标记 (跨天自动重置, 无需定时器) */
	const focusHintFresh = (): boolean => focusHintDay.value !== pomoStatDayKey()
	const markFocusHinted = (): void => {
		focusHintDay.value = pomoStatDayKey()
		try { localStorage.setItem(POMO_HINT_DAY_KEY, focusHintDay.value) } catch { /* 忽略 */ }
	}

	/** 里程碑"只庆祝一次"的标记持久化 (与 pomo.json 的 celebrated 同步) */
	const markCelebrated = (key: string): void => {
		try {
			const b = noriB()
			if (b?.pomoMarkCelebrated) {
				const raw = b.pomoMarkCelebrated(key)
				if (raw) Object.assign(pomoStats, JSON.parse(raw))
				return
			}
			pomoStats.celebrated = {...(pomoStats.celebrated ?? {}), [key]: Date.now()}
			pomoStatsSave()
		} catch { /* 忽略 */ }
	}

	const pomoLiveMin = computed(() => {
	    const st = pomo.value
	    if (!["focus", "countUp"].includes(st.phase)) return 0
	    if (st.eventSeq !== undefined && st.eventSeq > (pomoStats.lastEventSeq || 0)) return 0
	    let delta = st.paused ? 0 : Math.max(0, pomoDisplayAt.value - pomoSnapshotAt)
	    if (st.phase === "focus") delta = Math.min(delta, st.remainingMs || 0)
	    const days = projectLiveDays(st.days || {}, st.now || Date.now(), delta)
	    // 旧桥没有分日快照，仅为当前版本兼容显示，正式桥始终使用分日数据。
	    return Math.floor((days[pomoDayKey(pomoDate.value)] || (!st.days || !Object.keys(st.days).length ? st.elapsedMs || 0 : 0)) / 60000)
	})
	const pomoEndText = computed(() => {
	    const st = pomo.value
	    if (st.paused) return st.rebootPending ? "等待确认离线时段" : "时间停在这里，准备好再继续"
	    if (st.phase === "idle") return ""
	    if (st.phase === "countUp") return "不赶时间，按自己的节奏来"
	    const remaining = Math.max(0, (st.remainingMs ?? st.remainMs) - (pomoDisplayAt.value - pomoSnapshotAt))
	    const date = new Date(Date.now() + remaining)
	    return `预计 ${date.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})} 结束${st.phase === "focus" && st.autoBreak ? " · 随后进入休息" : ""}`
	})
	const pomoWeekBars = computed(() => {
	    const out = Array.from({length: 7}, (_, i) => { const d = shiftDay(pomoDate.value, i - 6), day = pomoDayKey(d); return {day, label: i === 6 ? "今天" : ["日", "一", "二", "三", "四", "五", "六"][d.getDay()], min: Math.round(dayMinutes(pomoStats.days[day])), h: 0} })
	    const max = Math.max(1, ...out.map(d => d.min)); return out.map(d => ({...d, h: d.min > 0 ? Math.max(5, d.min / max * 100) : 0}))
	})
	const pomoSyncText = computed(() => !pomoStatsReady.value ? "记录尚未读取，请重试。" : pomoSyncPending.value
	    ? "本机已保存，公共副本待同步。检查存储权限后点重试。"
	    : pomoSyncedAt.value ? `本机已保存 · 公共副本同步于 ${new Date(pomoSyncedAt.value).toLocaleString()}` : "记录保存在本机；建议定期导出 JSON 备份。")
	const pomoReminderAction = computed(() => !pomoReminder.value ? "" : !pomoReminder.value.permission ? "notification" : !pomoReminder.value.channel ? "channel" : pomoReminder.value.controlChannel === false ? "controlChannel" : !pomoReminder.value.exact ? "exact" : "")
	const pomoReminderText = computed(() => !pomoCfg.notify ? "系统提醒已关闭，页面计时仍正常。" : !pomoReminder.value ? "后台提醒受系统权限和省电策略影响。"
	    : pomoReminder.value.scheduleError ? "后台提醒安排失败，请重试。" : !pomoReminder.value.permission ? "通知尚未授权。" : !pomoReminder.value.channel ? "番茄钟通知渠道已关闭。" : pomoReminder.value.controlChannel === false ? "计时控制通知已关闭，暂停与结束请在应用内操作。" : !pomoReminder.value.exact ? "精确提醒未开启，后台通知可能延迟。" : "提醒已就绪 · 可在通知栏暂停或结束计时。")
	const pomoReminderSettings = (kind: string): void => {
	    try { noriB()?.pomoReminderSettings?.(kind) }
	    catch { pomoError.value = "暂时无法打开系统提醒设置" }
	}
	const pomoExport = (kind: "json" | "csv"): void => {
	    pomoRefresh()
	    if (!pomoStatsReady.value || pomoError.value) return
	    try {
	        const stamp = new Date(), name = `nori-focus-${pomoDayKey(stamp)}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}${String(stamp.getSeconds()).padStart(2, "0")}.${kind}`
	        const content = kind === "csv" ? pomoCsv(pomoStats) : JSON.stringify({kind: "nori-pomodoro", version: 1, exportedAt: Date.now(), stats: pomoStats}, null, 2)
	        if (noriB()?.writeFile?.(name, content) !== "ok") throw new Error("文件保存失败，请检查存储权限")
	        pomoMessage.value = `已导出至 Download/NoriDroid/${name}${pomo.value.phase !== "idle" ? "（包含已结算记录）" : ""}`
	    } catch (e) { pomoError.value = (e as Error).message }
	}
	;(window as unknown as {__noriPomoPickedRes?: (raw: string) => void}).__noriPomoPickedRes = (raw) => {
	    try { const result = JSON.parse(raw); if (result.cancelled) return; if (!result.ok) throw new Error(result.message || "读取失败")
	        const preview = parsePomoBackup(result.content); pomoBackupContent = result.content
	        pomoRestorePreview.value = `备份中有 ${preview.days} 天、${preview.minutes} 分钟。当前有 ${Object.keys(pomoStats.days).length} 天记录，将整体替换；重复恢复同一份不会叠加。`
	    } catch(e) { pomoError.value = (e as Error).message }
	}
	const pomoAction = (kind: string): void => {
	    if (pomoBusy.value) return
	    pomoBusy.value = true; pomoMessage.value = ""
	    try {
	        const before = pomo.value.phase, elapsed = Math.floor((pomo.value.elapsedMs || 0) / 60000)
	        if (kind === "start") pomoStartImpl(pomoCfg.focusMin, pomoCfg.breakMin)
	        else if (kind === "countUp") pomoCountUpImpl()
	        else if (kind === "pause") pomoPauseBtn()
	        else if (kind === "stop") { pomoConfirmEnd.value = false; const saved = pomoStopBtn(); if (saved !== undefined && pomo.value.phase === "idle") pomoMessage.value = `本段 ${Math.floor(saved / 60000)} 分钟已记录。每一段投入都算数。` }
	        else if (kind === "notify") pomoOnNotifyChange()
	        else if (kind === "stats") openPomoStats()
	        else if (kind === "retry") { pomoRefresh(); if (!pomoSettingsReadable) pomoCfgLoad(); if (pomoSettingsReady && pomoSettingsReadable) { const result = persistSettings(); pomoConfigError.value = result === "ok" ? "" : "设置保存失败，请检查存储权限" } }
	        else if (kind === "quietRestore") { pomoSulkCancelByUser(); applyQuiet() }
	        else if (kind === "rebootInclude" || kind === "rebootExclude") { const raw = noriB()?.pomoResolveReboot?.(kind === "rebootInclude"); if (raw) pomoStateSet(raw); pomoRefresh() }
	        else if (kind === "import") { if (pomo.value.phase !== "idle") throw new Error("请先结束计时"); if (!noriB()?.pickPomoBackup) throw new Error("请在 Android 主界面恢复备份"); noriB()?.pickPomoBackup?.() }
	        else if (kind === "cancelRestore") { pomoBackupContent = ""; pomoRestorePreview.value = "" }
	        else if (kind === "restore") {
	            if (!pomoBackupContent || pomo.value.phase !== "idle") throw new Error("请先结束计时并重新选择备份")
	            parsePomoBackup(pomoBackupContent)
	            const raw = noriB()?.pomoRestoreBackup?.(pomoBackupContent); if (!raw) throw new Error("恢复接口不可用")
	            pomoAcceptDashboard(raw); pomoRestorePreview.value = ""; pomoBackupContent = ""; pomoMessage.value = "记录已恢复；恢复前副本保存在 pomo-before-restore.json。"
	        }
	        if ((kind === "start" || kind === "countUp") && before !== "idle" && before !== pomo.value.phase) pomoMessage.value = `已保存上一段 ${elapsed} 分钟，新的计时已开始。`
	        else if ((kind === "start" || kind === "countUp") && before === "idle" && pomo.value.phase !== "idle" && !pomoMessage.value && pomoCfg.feedback !== "silent") pomoMessage.value = "这一段，Nori 陪你一起。按自己的节奏就好。"
	    } catch(e) { pomoError.value = `操作未完成：${(e as Error).message}` }
	    finally { window.setTimeout(() => { pomoBusy.value = false }, 250) }
	}
	const openPomoFromNotification = (): void => { showPanel("pomo"); pomoRefresh() }
	const pomoWidgetStop = (): void => {
	    if (pomo.value.phase === "focus") { pomoConfirmEnd.value = true; showPanel("pomo") }
	    else pomoAction("stop")
	}
	watch(panel, value => { if (value !== "pomo") pomoConfirmEnd.value = false })

	/* 悬浮窗: 拖拽 + 缩放 (位置/大小 localStorage 持久化; 组件根 pointerdown.stop 截断, 不惊动摸头/缩放手势) */
	const pomoWidgetEl = ref<HTMLElement | null>(null)
	const pomoPosLoad = (): void => {
		try {
			const raw = localStorage.getItem("pomo_widget")
			if (raw) {
				const o = JSON.parse(raw)
				pomoPos.value = {x: Number(o.x) || 16, y: Number(o.y) || 96, w: Math.min(480, Math.max(240, Number(o.w) || 260))}
				pomoMini.value = !!o.mini
			}
		} catch { /* 忽略 */ }
		pomoClampPos()
	}
	const pomoPosSave = (): void => {
		try { localStorage.setItem("pomo_widget", JSON.stringify({...pomoPos.value, mini: pomoMini.value})) } catch { /* 忽略 */ }
	}
	const pomoClampPos = (): void => {
	    const viewport = window.visualViewport
	    const left = (viewport?.offsetLeft || 0) + 12, top = (viewport?.offsetTop || 0) + 12
	    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
	    pomoPos.value.w = Math.min(pomoPos.value.w, Math.max(120, width - 24))
	    const rect = pomoWidgetEl.value?.getBoundingClientRect()
	    const w = rect?.width || (pomoMini.value ? 215 : pomoPos.value.w)
	    const h = rect?.height || (pomoMini.value ? 50 : 190)
	    const dock = document.querySelector<HTMLElement>(".dock")?.getBoundingClientRect()
	    const bottom = dock && dock.height > 0 && dock.top > top + h ? Math.min(top + height - 24, dock.top - 12) : top + height - 24
	    pomoPos.value.x = Math.max(left, Math.min(pomoPos.value.x, left + width - Math.min(w, width - 24) - 24))
	    pomoPos.value.y = Math.max(top, Math.min(pomoPos.value.y, bottom - h))
	}
	let pomoDragSt: {px: number; py: number; x: number; y: number} | null = null
	const onPomoDragDown = (e: PointerEvent): void => {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
		pomoDragSt = {px: e.clientX, py: e.clientY, x: pomoPos.value.x, y: pomoPos.value.y}
	}
	const onPomoDragMove = (e: PointerEvent): void => {
		if (!pomoDragSt) return
	    if (Math.hypot(e.clientX - pomoDragSt.px, e.clientY - pomoDragSt.py) < 5) return
		pomoPos.value.x = pomoDragSt.x + e.clientX - pomoDragSt.px
		pomoPos.value.y = pomoDragSt.y + e.clientY - pomoDragSt.py
		pomoClampPos()
	}
	const onPomoDragUp = (): void => { if (pomoDragSt) { pomoDragSt = null; pomoPosSave() } }
	let pomoRzSt: {px: number; w: number} | null = null
	const onPomoRzDown = (e: PointerEvent): void => {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
		pomoRzSt = {px: e.clientX, w: pomoPos.value.w}
	}
	const onPomoRzMove = (e: PointerEvent): void => {
		if (!pomoRzSt) return
		pomoPos.value.w = Math.min(480, Math.max(240, pomoRzSt.w + e.clientX - pomoRzSt.px))
	    pomoClampPos()
	}
	const onPomoRzUp = (): void => { if (pomoRzSt) { pomoRzSt = null; pomoClampPos(); pomoPosSave() } }
	watch([pomoMini, panel, pomoWidgetEl], () => { void nextTick(() => { pomoClampPos(); pomoPosSave() }) })

	/** Setup work is explicit so App.vue can preserve bridge/audio startup ordering. */
	const initializePomodoro = (): void => {
		pomoCfgLoad()
		noriB()?.pomoSetNotify?.(pomoCfg.notify)
		pomoStatsLoad()
		pomoPosLoad()
		try { const b0 = noriB(); if (b0?.pomoState) pomoStateSet(b0.pomoState()) } catch { /* 忽略 */ }
		if (pomo.value.phase !== "idle") pomoWidgetOn.value = true   // 计时中刷新/重载: 组件自动回来
		pomoUpdateDisplay()
		pomoRefreshDate()
		window.addEventListener("resize", pomoClampPos)
		window.visualViewport?.addEventListener("resize", pomoClampPos)
		window.visualViewport?.addEventListener("scroll", pomoClampPos)
	}

	/** Called after general settings hydrate and before BGM resumes. */
	const mountPomodoro = (): void => {
	    pomoSettingsReady = true
	    if (pomoNeedsMigration && pomoSettingsReadable) {
	        const result = persistSettings()
	        if (result === "ok") { pomoNeedsMigration = false; localStorage.removeItem("pomo_cfg") }
	        else pomoConfigError.value = "专注设置迁移待保存，请检查存储权限。"
	    }
	    window.addEventListener("nori-open-pomo", openPomoFromNotification)
	    if (noriB()?.pomoOpenedFromNotification?.()) openPomoFromNotification()
	    recoverFocusMuteIfNeeded()
	    pomoUpdateDisplay()
	}

	const refreshPomodoroStorage = (): void => {
	    if (!pomoSettingsReadable) pomoCfgLoad()
	    pomoRefreshDate()
	    pomoRefresh()
	    pomoArmSulk()
	}

	/** App invokes this at the original cleanup point, after pending memory writes. */
	const disposePomodoro = (): void => {
	    if (pomoTickTimer) { clearInterval(pomoTickTimer); pomoTickTimer = 0 }
	    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
	    if (pomoDateTimer) { clearTimeout(pomoDateTimer); pomoDateTimer = 0 }
	    window.removeEventListener("nori-open-pomo", openPomoFromNotification)
	    if (pomoConfigTimer) clearTimeout(pomoConfigTimer)
	    if (pomoSettingsReady && pomoSettingsReadable) persistSettings()
	    window.removeEventListener("resize", pomoClampPos)
	    window.visualViewport?.removeEventListener("resize", pomoClampPos)
	    window.visualViewport?.removeEventListener("scroll", pomoClampPos)
	}

	return {
	    pomo, pomoCfg, pomoWidgetOn, pomoMini, pomoPos, pomoFocusMuteOn,
	    pomoStats, pomoStatsReady, pomoError, pomoConfigError, pomoMessage,
	    pomoBusy, pomoQuietHeld, pomoRestorePreview, pomoConfirmEnd,
	    pomoFmt, pomoPct, pomoPhaseText, pomoEndText, pomoLiveMin,
	    pomoSummary, pomoRange, pomoRangeBars, pomoRangeSummary, pomoSelectedDay,
	    pomoSelectDate, pomoHeatCanvas, onHeatClick, pomoMonths, pomoDayKey, pomoDate,
	    fmtTotalMin, pomoWeekBars, pomoSyncText, pomoReminderAction, pomoReminderText,
	    pomoReminderSettings, pomoExport, pomoAction, pomoRefresh, pomoUpdateDisplay,
	    pomoRefreshDate, pomoSulkCancelByUser, focusHintFresh, markFocusHinted, markCelebrated,
	    pomoWidgetEl, pomoWidgetStop, pomoPosSave,
	    onPomoDragDown, onPomoDragMove, onPomoDragUp, onPomoRzDown, onPomoRzMove, onPomoRzUp,
	    initializePomodoro, mountPomodoro, refreshPomodoroStorage, disposePomodoro,
	}
}

export type PomodoroState = ReturnType<typeof usePomodoro>
export type PomodoroModel = UnwrapNestedRefs<PomodoroState>
