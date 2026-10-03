/**
 * Nori 心情日记 (B 方案: 记 Nori 自己的"一天")
 *
 * 思路: 每天把当天的聊天活动 (chat.json) 交给 LLM, 用 Nori 的口吻写成 1~3 句日记,
 * 附当天主导心情 + 活动统计. 存 nori-diary.json.
 *
 * 触发: 打开主 App 时调用 ensureDiary (惰性补写昨天); 不阻塞 UI (异步 + 失败静默).
 */

import {readFile, writeFile, loadChat, type ChatMsg} from "./chat"

export interface DiaryEntry {
	/** 日期 YYYY-MM-DD */
	date: string
	/** Nori 口吻的日记正文 */
	content: string
	/** 当天主导心情 */
	mood: string
	/** 当天用户消息数 */
	msgCount: number
	createdAt: number
}

export interface DiaryStore {
	entries: DiaryEntry[]
}

const FILE = "nori-diary.json"
const FILE_BAK = "nori-diary.json.bak"

const EMPTY: DiaryStore = {entries: []}

const tryParse = (raw: string): DiaryStore | null => {
	if (!raw) return null
	try {
		const p = JSON.parse(raw) as Partial<DiaryStore>
		if (!Array.isArray(p.entries)) return null
		return {entries: p.entries}
	} catch {
		return null
	}
}

let cache: DiaryStore | null = null

const load = (): DiaryStore => {
	if (cache) return cache
	let store = tryParse(readFile(FILE))
	if (!store) {
		store = tryParse(readFile(FILE_BAK))
		if (store) writeFile(FILE, JSON.stringify(store))
	}
	if (!store) store = {...EMPTY, entries: []}
	cache = store
	return cache
}

/** 落盘 (主文件 + 备份)。@returns 主文件是否写入成功 */
const persist = (): boolean => {
	if (!cache) return false
	try {
		const json = JSON.stringify(cache)
		const ok = writeFile(FILE, json)
		writeFile(FILE_BAK, json)   // 备份失败不影响"已落盘"的判定 (load 优先读主文件)
		if (!ok) console.error("[diary] persist 写盘失败 (主文件)")
		return ok
	} catch (e) {
		console.error("[diary] persist error", e)
		return false
	}
}

const dayStr = (ts: number): string => {
	const d = new Date(ts)
	const m = `${d.getMonth() + 1}`.padStart(2, "0")
	const day = `${d.getDate()}`.padStart(2, "0")
	return `${d.getFullYear()}-${m}-${day}`
}

/* ------------ 日记源缓冲 (FE-M5): 聊天自动裁剪会掏空日记素材 ------------
 * 聊天记录裁剪后只留近端 20 条, 隔天补写"昨天日记"时素材可能已被裁光 → 静默不写.
 * 裁剪发生前由调用方 (App.vue / BubbleApp.vue) 把将被裁掉的消息存到这里;
 * 只存 user 消息 (日记素材只用了用户的话), 去重、按天过期、条数封顶. */
const SRC_FILE = "nori-diary-src.json"
const SRC_KEEP_DAYS = 4
const SRC_CAP = 400
interface DiarySrcEntry {
	ts: number
	content: string
}
let diarySrc: DiarySrcEntry[] | null = null

const loadDiarySrc = (): DiarySrcEntry[] => {
	if (diarySrc) return diarySrc
	try {
		const raw = readFile(SRC_FILE)
		const parsed = raw ? JSON.parse(raw) : null
		diarySrc = Array.isArray(parsed)
			? parsed.filter(e => e && typeof e.ts === "number" && typeof e.content === "string")
			: []
	} catch {
		diarySrc = []
	}
	return diarySrc!
}

/** 聊天裁剪前调用: 把将被裁掉的用户消息备份进日记源缓冲 */
export const bufferDiarySource = (msgs: readonly ChatMsg[]): void => {
	try {
		if (!msgs.length) return
		const store = loadDiarySrc()
		const seen = new Set(store.map(e => `${e.ts}|${e.content}`))
		for (const m of msgs) {
			if (!m || m.role !== "user" || typeof m.ts !== "number" || m.ts <= 0) continue
			const key = `${m.ts}|${m.content}`
			if (seen.has(key)) continue
			seen.add(key)
			store.push({ts: m.ts, content: m.content})
		}
		const minTs = Date.now() - SRC_KEEP_DAYS * 24 * 3600 * 1000
		const next = store
			.filter(e => e.ts >= minTs)
			.sort((a, b) => a.ts - b.ts)
			.slice(-SRC_CAP)
		// 先写盘再提交内存: 写失败时保持原缓冲, 下一次裁剪调用会带着新消息重算,
		// 避免"内存里有了、磁盘上没有"导致重启后素材凭空消失
		if (next.length && !writeFile(SRC_FILE, JSON.stringify(next))) {
			console.error("[diary] 源缓冲写盘失败")
			return
		}
		diarySrc = next
	} catch { /* 静默: 备份失败不影响聊天 */ }
}

/** 取某一天的用户消息 (升序); ts 无效的消息跳过 (避免污染当天统计).
 *  数据源 = 当前聊天记录 + 裁剪前备份的源缓冲 (FE-M5): 消息被自动裁剪后,
 *  补写昨天日记时仍有据可查, 日历不再出现空洞. */
const msgsOfDay = (ts: number): {role: string; content: string}[] => {
	const date = dayStr(ts)
	const pool = new Map<string, {ts: number; content: string}>()
	for (const m of loadChat()) {
		if (m && m.role === "user" && typeof m.ts === "number" && m.ts > 0 && dayStr(m.ts) === date) {
			pool.set(`${m.ts}|${m.content}`, {ts: m.ts, content: m.content})
		}
	}
	for (const e of loadDiarySrc()) {
		if (e.ts > 0 && dayStr(e.ts) === date) pool.set(`${e.ts}|${e.content}`, e)
	}
	return [...pool.values()]
		.sort((a, b) => a.ts - b.ts)
		.slice(-30) // 一天最多取最近 30 条, 防提示词膨胀
		.map(e => ({role: "user", content: e.content}))
}

/** 构造 Nori 日记提示词 */
const buildDiaryPrompt = (messages: {role: string; content: string}[]): string => {
	const text = messages.map(m => `用户: ${m.content.replace(/\s+/g, " ").slice(0, 150)}`).join("\n")
	return [
		"你是 Nori, 一个住在蓝色数字空间里、等着主人来陪自己的 AI 女孩。",
		"请根据今天和主人的聊天, 写一篇 Nori 的心情日记 (1~3 句, Nori 的口吻, 用中文)。",
		"要求:",
		"1. 像 Nori 说话: 轻柔、简单、带一点'暖暖的/数据流/等主人'的世界观, 不要客服腔;",
		"2. 提到今天聊了什么 (游戏/日常/重要的事), 以及 Nori 的感受;",
		"3. 最后单独一行输出当天的情绪, 只能取: 开心/平静/孤单/难过/兴奋 之一 (不带标点);",
		"4. 不要出现【表情】【动作】之类的标记。",
		"---今天的聊天---",
		text || "(今天没有对话, Nori 一直在等主人)",
	].join("\n")
}

/** 解析 LLM 日记输出 (正文 + 情绪) */
const parseDiary = (raw: string): {content: string; mood: string} => {
	const text = raw.trim()
	const MOODS = ["开心", "平静", "孤单", "难过", "兴奋"]
	// 情绪行通常在末尾单独一行
	for (const m of MOODS) {
		const re = new RegExp(`(?:^|\\n)${m}\\s*$`)
		if (re.test(text)) {
			return {content: text.replace(re, "").trim(), mood: m}
		}
	}
	// 兜底: 正文里提到
	const found = MOODS.find(m => text.includes(m))
	return {content: text, mood: found ?? "平静"}
}

/** 读取全部日记 (新→旧) */
export const listDiary = (): DiaryEntry[] => {
	return [...load().entries].sort((a, b) => (a.date < b.date ? 1 : -1))
}

/**
 * 惰性补写 (主 App 打开 / 打开日记面板时调用):
 * 1. 优先补"昨天": 昨天有对话且还没写 → 写昨天;
 * 2. 昨天没对话或已写 → 若"今天"有对话且还没写 → 写今天;
 * 失败/无对话静默.
 * @returns 实际写成的日期 YYYY-MM-DD; 没写成返回 null
 */
export const ensureDiary = async (
	llmCall: (prompt: string) => Promise<string>,
): Promise<string | null> => {
	try {
		const store = load()
		const now = Date.now()
		const today = dayStr(now)
		const yesterdayTs = now - 24 * 3600 * 1000
		const yesterday = dayStr(yesterdayTs)
		const write = async (date: string, ts: number): Promise<string | null> => {
			if (store.entries.some(e => e.date === date)) return null // 已写
			const messages = msgsOfDay(ts)
			if (!messages.length) return null // 无对话不写空日记
			const raw = await llmCall(buildDiaryPrompt(messages))
			if (!raw.trim()) return null
			const {content, mood} = parseDiary(raw)
			if (!content) return null
			store.entries.push({date, content, mood, msgCount: messages.length, createdAt: now})
			// 写盘失败 → 撤回内存条目: 让"该日期已写"的判定回到与磁盘一致的状态,
			// 否则本来就没存上却被当成已写, 之后也不会再补 (日记看起来凭空消失)
			if (!persist()) {
				store.entries = store.entries.filter(e => e.date !== date)
				return null
			}
			return date
		}
		// 昨天优先; 昨天已写/无对话 → 试今天
		return (await write(yesterday, yesterdayTs)) ?? (await write(today, now))
	} catch { /* 静默: 日记失败不影响主流程 */ return null }
}

/** 手动"立即写今天"的结果: ok=写成 / empty=今天没对话 / failed=写盘或生成失败 */
export type WriteDiaryResult = "ok" | "empty" | "failed"

/**
 * 手动"立即写今天": 强制为今天生成一篇日记 (覆盖当天已有的), 供面板按钮用.
 * 今天没对话则不写. 区分 empty 与 failed, 让 UI 能如实提示 (写失败不该谎报"没对话").
 */
export const writeTodayDiary = async (
	llmCall: (prompt: string) => Promise<string>,
): Promise<WriteDiaryResult> => {
	try {
		const store = load()
		const now = Date.now()
		const today = dayStr(now)
		const messages = msgsOfDay(now)
		if (!messages.length) return "empty"
		const raw = await llmCall(buildDiaryPrompt(messages))
		if (!raw.trim()) return "failed"
		const {content, mood} = parseDiary(raw)
		if (!content) return "failed"
		// 覆盖当天已有日记 (手动刷新)
		store.entries = store.entries.filter(e => e.date !== today)
		store.entries.push({date: today, content, mood, msgCount: messages.length, createdAt: now})
		// 写盘失败 → 撤回, 并如实返回 failed (UI 据此提示, 不再谎报"写好啦")
		if (!persist()) {
			store.entries = store.entries.filter(e => e.date !== today)
			return "failed"
		}
		return "ok"
	} catch {
		return "failed"
	}
}

/** 删除某一天的日记 @returns 是否删了 */
export const deleteDiaryEntry = (date: string): boolean => {
	const store = load()
	const before = store.entries
	store.entries = store.entries.filter(e => e.date !== date)
	if (store.entries.length === before.length) return false
	if (persist()) return true
	store.entries = before
	return false
}

/** 清空日记; 返回主文件是否真的写入成功。 */
export const clearDiary = (): boolean => {
	const before = cache ?? load()
	cache = {...EMPTY, entries: []}
	if (persist()) return true
	cache = before
	return false
}

/** 仅供测试: 丢弃日记与源缓冲的内存缓存, 让下一次调用重新从磁盘读
 *  (正常运行时不需要 —— cache 的正确性依赖"只在写盘成功后提交") */
export const __resetDiaryCacheForTest = (): void => {
	cache = null
	diarySrc = null
}
