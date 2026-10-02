/**
 * 记忆诊断日志（P1，2026-09-30）—— 把"模型到底听不听话"从推测变成可查的证据。
 *
 * ## 为什么要有它
 * 记忆的质量取决于两件**在设备上完全看不见**的事：① 喂给模型的提示词长什么样；
 * ② 模型回什么、解析出什么、门槛挡了什么。此前只有 `console.log`，而设备上没有 adb，
 * 用户手机上根本看不到（详见 `长期记忆策展方案-20260928.md` 的 S5「观测闭环」）。
 * 结果就是所有"提示词是否被遵守"的结论都只能标"推测"。
 *
 * ## 设计取舍（都是刻意的）
 * - **默认关**（设置里的「记忆诊断日志」）：日常聊天零开销、零落盘 —— 开关关闭时
 *   `recordOrganize()` 直接返回，连字符串都不拼。
 * - **只留在内存里**（环形，最近 [MAX_DIAG_RECORDS] 次整理）：不写盘、不进 `memory.json`、
 *   不碰双实例合并逻辑。代价是**重启 App 会清空** —— 所以界面上写明了"导出请在同一次里做"。
 * - **导出才落盘**：走与「导出」同一条 `writeFile` 通道（落到 `Download/NoriDroid/`）。
 * - ⚠ 记录里**含主人的原话与记忆内容**（诊断必须如此），导出后请自己留意文件去向。
 */

/** 环形上限：最近多少次整理（大约覆盖 200 × 25 = 5000 条消息） */
export const MAX_DIAG_RECORDS = 200
/** 提示词与模型原始输出的截断长度（够看出格式与规则遵守情况，又不至于一条几十 KB） */
export const DIAG_PROMPT_MAX = 4000
export const DIAG_RAW_MAX = 2000

/** 一条「整理」诊断记录 */
export interface MemDiagRecord {
	/** 记录时间（导出时便于对齐聊天时间线） */
	ts: number
	/** 这次整理的批次信息 */
	msgs: number
	startIndex: number
	/** 喂给模型的提示词（截断） */
	promptChars: number
	prompt: string
	/** 模型原始输出（截断） */
	rawChars: number
	raw: string
	/** 解析结果 */
	topic: string
	items: {c: string; t: string; i: number}[]
	/** 解析出来但被**写入门槛**挡下的（一次性/低重要度） */
	gated: {c: string; t: string; i: number}[]
	/** 被**作废护栏**挡下的（已作废的旧说法不再回流） */
	deadLink: string[]
	/** 写入结果 */
	write: {added: number; updated: number; invalidated: number; intra: number; expired: number; lowvalue: number; revived: number}
	/** 本批摘要字数 / 挂进哪个块 */
	summaryChars: number
	blockId: string | null
	/** 写完之后库的状态 —— 「距离 300 上限还有多远」就靠它 */
	lib: {active: number; faded: number; invalid: number; total: number; blocks: number}
	/** 失败/降级原因（空串 = 正常） */
	note: string
}

let enabled = false
const ring: MemDiagRecord[] = []

export const diagEnabled = (): boolean => enabled
/** 由界面按设置项同步（主界面与悬浮窗各有一处；设置是唯一事实来源） */
export const setDiagEnabled = (on: boolean): void => { enabled = !!on }
export const diagCount = (): number => ring.length
export const clearDiag = (): void => { ring.length = 0 }

/** 记一条（开关关着时直接返回，不产生任何开销） */
export const recordOrganize = (rec: Omit<MemDiagRecord, "ts">): void => {
	if (!enabled) return
	ring.push({ts: Date.now(), ...rec})
	if (ring.length > MAX_DIAG_RECORDS) ring.splice(0, ring.length - MAX_DIAG_RECORDS)
}

/** 只读快照（供"查看最近一条"之类的排查用） */
export const lastDiagRecord = (): MemDiagRecord | null => ring.length ? {...ring[ring.length - 1]} : null

/**
 * 拼导出用的 JSONL：第一行是**环境头**（模型、开关、条数、时间），后面每行一条记录。
 * 用 JSONL 而不是数组：出问题时能直接 `Select-String` 一行行看，也能只截取几条给排查者。
 */
export const buildDiagJsonl = (meta: {model?: string; app?: string; extra?: Record<string, unknown>} = {}): string => {
	const head = {
		kind: "header",
		at: new Date().toISOString(),
		app: meta.app ?? "NoriDroid",
		model: meta.model ?? "",
		records: ring.length,
		cap: MAX_DIAG_RECORDS,
		promptMax: DIAG_PROMPT_MAX,
		rawMax: DIAG_RAW_MAX,
		...(meta.extra ?? {}),
	}
	return [JSON.stringify(head), ...ring.map(r => JSON.stringify(r))].join("\n") + "\n"
}
