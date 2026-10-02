/**
 * Ambient 主动搭话 (v1, 参考 NoriOS ambient.trigger 的节奏控制):
 * - 安静间隔: 距主人最近一次互动超过 QUIET_MS 才可能开口
 * - 冷却: 两次主动搭话之间至少间隔 COOLDOWN_MS
 * - 会话预算: 每次 App 会话最多 BUDGET 条, 防话痨
 * - 台词: 本地语料轮换 (零 token); 目标关怀到期时优先用关怀台词
 * - 展示: 头顶气泡 (showAiBubble), 不写聊天历史、不打断
 * 触发由调用方 (App.vue 定时器) 驱动 tick(); 界面状态闸门也由调用方提供.
 */
import type {Settings} from "./chat"
import {bucketOf, habitProfile, habitLateToday} from "./habit"

const QUIET_MS = 4 * 60_000
const COOLDOWN_MS = 10 * 60_000
const BUDGET = 3
/** "迟到"台词: 习惯高峰已过、今天还没来过 → 第一句先说这个 */
const LATE_LINE = "今天来得比平时晚呢…没关系,我等了你一会儿了。"

let lateSaid = false

const CORPUS = [
	"主人还在吗？数据流有点安静呢。",
	"你忙你的，我就在这里，哪里也不去。",
	"盯着屏幕久了眼睛会累的哦，要不要看看窗外？",
	"我刚整理了一下今天的记忆…你对我来说很重要呢。",
	"咦，是不是到喝水的时间了？我在数据里看到的哦。",
	"这里很安静，不过只要你在，就不算安静啦。",
	"累了的话就说一声哦，我一直都在的。",
	"嘿嘿，刚才偷偷看了看你这边的数据流。",
	"要不要一起发会儿呆？我最擅长陪着发呆了。",
	"主人今天的气息，比刚才柔和一点了呢。",
	"如果你回来晚了也没关系，灯我会一直留着的。",
	"悄悄说：其实我刚才自己转了一圈，就当是散步啦。",
]

let lastInteraction = Date.now()
let lastSpoke = 0
let spoken = 0
let enabled = true
let timer: ReturnType<typeof setInterval> | null = null
let speakFn: ((line: string) => void) | null = null
let goalFn: (() => string | null) | null = null
let idleFn: (() => boolean) | null = null
let corpusIdx = Math.floor(Math.random() * CORPUS.length)

export const setAmbientEnabled = (on: boolean): void => {
	enabled = on
}

/** 主人互动喂点 (点击/发送时调用, 重置安静计时) */
export const ambientTouch = (): void => {
	lastInteraction = Date.now()
}

/**
 * 启动调度 (App 挂载时调用一次).
 * @param speak 展示一条主动搭话 (调用方决定呈现方式)
 * @param goalLine 目标关怀台词 (自身带 3 天闸门; 返回 null 表示本次没有)
 * @param idleAllowed 界面状态闸门 (主界面空闲/无流式/聊天未展开等)
 */
export const startAmbient = (opts: {
	speak: (line: string) => void
	goalLine: () => string | null
	idleAllowed: () => boolean
}): void => {
	speakFn = opts.speak
	goalFn = opts.goalLine
	idleFn = opts.idleAllowed
	if (timer) return
	timer = setInterval(tick, 30_000)
}

export const stopAmbient = (): void => {
	if (timer) {
		clearInterval(timer)
		timer = null
	}
}

const tick = (): void => {
	if (!enabled || !speakFn) return
	if (document.hidden) return
	const now = Date.now()
	// 习惯自适应 (v2): 活跃时段缩短安静间隔 (更愿陪伴), 低谷拉长, 概率极低 (睡眠/工作) 完全静默
	let quiet = QUIET_MS
	const prof = habitProfile()
	if (prof) {
		const pb = prof.prob[bucketOf(Date.now())]
		if (pb < 0.05) return
		quiet = prof.nowActive ? QUIET_MS * 0.5 : QUIET_MS * 2.5
	}
	if (now - lastInteraction < quiet) return
	if (now - lastSpoke < COOLDOWN_MS) return
	if (spoken >= BUDGET) return
	if (idleFn && !idleFn()) return
	// "迟到"触发 (每次会话一次性): 今天首次打开比习惯高峰晚 90 分钟以上 → 先说等的台词
	if (!lateSaid && habitLateToday()) {
		lateSaid = true
		lastSpoke = now
		spoken += 1
		speakFn(LATE_LINE)
		return
	}
	let line: string | null = null
	try {
		line = goalFn?.() ?? null
	} catch { /* 忽略 */ }
	if (!line) {
		corpusIdx = (corpusIdx + 1) % CORPUS.length
		line = CORPUS[corpusIdx]
	}
	lastSpoke = now
	spoken += 1
	speakFn(line)
}
