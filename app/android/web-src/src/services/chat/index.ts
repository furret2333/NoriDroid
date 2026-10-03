



// 音色↔模型的纯逻辑放在零依赖的 cosy-models 里 (好让 Node 门禁直接测, 不拖进合成实现)。
// 这里只做再导出, 保持既有调用方 (App.vue 等) 的 import 路径不变。
import {normalizeCloneVoices, type CosyCloneVoice} from "../tts/cosy-models"
export {normalizeCloneVoices, type CosyCloneVoice}


/* 2026-10-01 用户要求：**内置人设已从 App 移除**（原文见 git 历史 / 桌面《Nori-人设设定.md》）。
   Nori 的人格完全来自用户导入的 `persona.md`；没有导入时就没有人格提示词（不会用任何内置文本兜底）。 */

export interface Settings {
	apiKey: string
	baseUrl: string
	model: string
	/** 上次选的 **Live2D 模型 id**（不是上面的 LLM `model`）。空 = 没选过，启动用已装列表第一个。
	 *  2026-09-30 修：此前没有这个字段，换模型后重启会回到列表第一个。 */
	live2dModel?: string
	
	bubbleScale: number
	/** 气泡最大宽度 (%, 默认 82; 越大气泡越宽, 越小句子越容易换行) */
	bubbleWidth: number
	renderScale: number
	/** Live2D 渲染帧率档位 (0 = 不限制)。档位定义见 services/live2d/frameCap.ts。
	 *  可选: 旧设置文件没有它, 读取时由 normalizeFps 回落默认档 */
	l2dFps?: number
	
	ttsEnabled: boolean
	/** 语音提供商: fish / cosyvoice */
	ttsProvider: "fish" | "cosyvoice"
	ttsApiKey: string
	ttsBaseUrl: string
	ttsReferenceId: string
	ttsModel: string
	ttsFormat: string
	ttsChunkLength: number
	ttsLatency: string
	/** 朗读音量 (应用内 0~1; 只作用于本 App 的播放, 不改系统音量) */
	ttsVolume: number
	/** 背景音乐开关 (NoriOS 官方 OST 三首, 独立于朗读) */
	bgmEnabled: boolean
	/** 背景音乐曲目: "random" 随机 / 指定曲目 id (bgm_memory | bgm1 | nori_daily_manifold) */
	bgmTrack: string
	/** 背景音乐音量 (0~1, 默认压低不盖过朗读语音) */
	bgmVolume: number
	/** 按键音效音量 (0~1, 0 = 关闭) */
	sfxVolume: number
	/** 动态背景 (数据海: 星尘/星云漂移/网格, 纯程序渲染零素材) */
	dataseaBg: boolean
	/** 让 Nori 知道当前时间（默认开）。关掉后聊天提示词里不再带时间块 —— 她会答不上"现在几点"。 */
	timeAware: boolean
	/** Nori 主动搭话 (安静间隔 + 冷却 + 会话预算, 本地语料零 token) */
	ambientEnabled: boolean
	/** 安静模式: off 关闭 / auto 自动(每日 23:00–次日 8:00) / manual 手动开关 */
	quietMode: string
	/** 手动安静模式的立即静音开关 (仅 quietMode=manual 时生效) */
	quietOn: boolean
	/** 千问 CosyVoice 配置 (与 Fish 独立) */
	cosyApiKey: string
	cosyBaseUrl: string
	cosyModel: string
	cosyVoice: string
	cosyRate: number
	/** 用户克隆的音色列表 (声音克隆成功后自动加入)。
	 *  必须带 model —— 音色是分模型的, 官方明确"不能将一个模型的音色与另一个模型混用",
	 *  切换模型后继续用旧克隆会直接 InvalidParameter, 所以绑定关系必须持久化。 */
	cosyCloneVoices: CosyCloneVoice[]
	/** 摘要成功后自动裁剪旧聊天记录 (默认关) */
	trimHistory: boolean
	/** 用 LLM 辅助提取记忆 (更准, 每次回复多花少量 token; 默认关) */
	memoryLlmExtract: boolean
	/**
	 * **实时（逐句）记忆提取**开关 (2026-09-27 重构 P3), **默认 false**。
	 *
	 * 记忆的生产已改到"每次历史总结顺手筛出" (见 services/memory 的 summarizeIfNeeded):
	 * 一次总结调用同时出摘要 + 记忆块, 逐句通道(每轮 1~2 次小调用 + 判重决策 + 改口判据)
	 * 整体下线。留这个开关只为出问题能一键切回旧行为, 不是给日常用的。
	 */
	memoryRealtimeExtract: boolean
	/**
	 * **自动优化记忆示例** (2026-09-28, 用户的"整理优化"), **默认 false**。
	 * 开启后: 每新增 20 条生效记忆, 自动把库里已有记忆提炼成 few-shot 示例写进整理提示词
	 * (正例 = 你保留的; 反例 = 你删掉的)。零额外调用, 只是提示词长一点。
	 * 默认关的原因: 早期库里若有没清掉的垃圾, 例子会把那种风味固化 —— 首次使用会提示先自己过一遍。
	 */
	memoryAutoTuneExamples: boolean
	/**
	 * **记忆诊断日志** (2026-09-30, P1「观测闭环」), **默认 false**。
	 *
	 * 打开后: 每次整理在内存里留一条完整证据 —— 喂给模型的提示词、模型原始输出、解析出的条目、
	 * **被写入门槛挡下的**条目、写入结果、以及库状态（生效/收起/作废/总数）。
	 * 记忆库里随之出现「导出记忆诊断」按钮，导出的 JSONL 落在 `Download/NoriDroid/`。
	 *
	 * 为什么默认关 + 只留内存: 它含**主人的原话与记忆内容**（诊断必须如此），且日常聊天
	 * 完全不需要它 —— 关着时零开销、零落盘。重启 App 会清空（导出请在同一次里做）。
	 * 之前所有"提示词是否被遵守"的结论都只能标"推测"，就是因为设备上看不到这些。
	 */
	memoryDiagnostics: boolean
	/** 用 LLM 语义召回记忆 (更准, 每次对话多一次小调用; 默认开) */
	smartRecall: boolean
	/** 用 LLM 选择回复表情 (更生动, 每次回复多花少量 token; 默认开) */
	emotionLlm: boolean
	/** DeepSeek 思考模式 (仅对 DeepSeek 端点生效; **默认开** —— 2026-10-02 用户纠正)。
	 *  开关是唯一口径: 开 → 传 enabled, 关 → 传 disabled (服务端默认就是开的, 不传等于没关);
	 *  见 resolveThinking */
	deepseekThinking: boolean
	/** 「思考模式默认开」这次口径变更的一次性迁移标记 (2026-10-02)。
	 *  老设置文件里那个 `deepseekThinking:false` 是**旧默认**自动写进去的, 不代表用户选择 ——
	 *  没有这个标记时按"默认开"处理一次; 标记落盘后, 用户手动关掉就永久生效, 不会再被翻回来。 */
	thinkDefaultV2?: boolean
	/** 头部跟随: 左右反向 (方向不对时现场调) */
	lookFlipX: boolean
	/** 头部跟随: 上下反向 */
	lookFlipY: boolean
	/** 头部跟随灵敏度 (0.1~0.5) */
	lookSens: number
	/** 退出后显示悬浮窗 Nori */
	floatEnabled: boolean
	/** 悬浮窗: 聊天气泡回复最大宽度 (%, 默认 82) */
	floatBubbleW: number
	/** 悬浮窗: Live2D 渲染分辨率 (x, 0.5~3.0, 同主 App 渲染分辨率) */
	floatRenderScale: number
}

/**
 * 「当前时间」提示块（2026-10-01 加）。
 *
 * 为什么要有：LLM 权重是固定的快照，**没有"现在"这个概念** —— 不给它时间，它会答不上"现在几点"，
 * 也会算错"下周三"。但**注入的位置很关键**：
 *   - 塞进 `nori-prompt.md` 开头、或做成第一条 system 消息 ⇒ 一个每次都变的前缀会让**提示词缓存**
 *     整段失效（Anthropic 官方文档点名的缓存反例；DeepSeek 的前缀缓存同理）；
 *   - 所以这里只产出一个**独立小块**，由调用方追加在人格与其它 system 块**之后**（越靠后越好）。
 * 参考实现：AgentScope 的 HintBlock（"instead of mutating the system prompt, so prompt caching still
 * works"）与 osaurus PR#2173（"never into the system prompt … must stay byte-stable"）。
 *
 * 纯度：给定 `now` 输出稳定，便于门禁断言；**调用方必须每次重新调用**（别缓存成常量，否则时间会变旧）。
 */
export const localTimeBlock = (now: Date = new Date()): string => {
	const p = (n: number): string => String(n).padStart(2, "0")
	const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()]
	const off = -now.getTimezoneOffset()          // 分钟, 东八区 = +480
	const tz = `UTC${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
	return `【当前时间】${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${week} ${p(now.getHours())}:${p(now.getMinutes())}（${tz}）\n`
		+ "这是设备的真实时间（不是猜测，可以直接用来回答时间类问题），也用它来换算「今天/明天/下周三」这类相对时间。"
		+ "自然使用即可，不必每句话都提时间。"
}

export const DEFAULT_SETTINGS: Settings = {
	apiKey: "",
	baseUrl: "https://api.openai.com/v1",
	model: "",
	live2dModel: "",
	bubbleScale: 1,
	bubbleWidth: 82,
	renderScale: 1,
	ttsEnabled: false,
	ttsProvider: "fish",
	ttsApiKey: "",
	ttsBaseUrl: "https://api.fish.audio",
	ttsReferenceId: "",
	ttsModel: "s2.1-pro",
	ttsFormat: "mp3",
	ttsChunkLength: 120,
	ttsLatency: "balanced",
	ttsVolume: 1,
	bgmEnabled: false,
	bgmTrack: "random",
	bgmVolume: 0.35,
	sfxVolume: 0.5,
	dataseaBg: true,
	timeAware: true,
	ambientEnabled: true,
	quietMode: "off",
	quietOn: false,
	cosyApiKey: "",
	cosyBaseUrl: "https://dashscope.aliyuncs.com",
	cosyModel: "cosyvoice-v3.5-flash",
	cosyVoice: "",
	cosyRate: 1.0,
	cosyCloneVoices: [],
	trimHistory: true,
	memoryLlmExtract: true,
	memoryRealtimeExtract: false,
	memoryAutoTuneExamples: false,
	memoryDiagnostics: false,
	smartRecall: true,
	emotionLlm: true,
	deepseekThinking: true,
	lookFlipX: false,
	lookFlipY: false,
	lookSens: 0.2,
	floatEnabled: false,
	floatBubbleW: 82,
	floatRenderScale: 2,
}

export interface ChatMsg {
	role: "user" | "assistant" | "system"
	content: string
	ts: number
	/** 界面错误提示气泡 (⚠ …): 只显示, 不落盘、不进模型上下文 */
	error?: boolean
	/** 裁剪占位符 (更早的对话已压缩…): 落盘且重启后保留 (FE-M4) */
	placeholder?: boolean
}

interface NoriChat {
	fetchModels: (baseUrl: string, apiKey: string) => void
	chat: (baseUrl: string, apiKey: string, model: string, messagesJson: string, thinkingMode: string) => void
	chatStream: (baseUrl: string, apiKey: string, model: string, messagesJson: string, thinkingMode: string) => void
	chatStop: () => void
	readFile: (name: string) => string
	writeFile: (name: string, content: string) => string
	appendMemory: (text: string) => string
	readMemory: () => string
	isStorageReady: () => boolean
	requestStoragePermission: () => void
	getStorageDir: () => string
	/** 公共目录直读可行性探针 (实机自查"卸载重装后读不到"用; 返回 JSON 字符串) */
	probePublicFiles: (name: string) => string
	/** 是否已获得「所有文件访问权限」(Android 11+; 读写公共目录要靠它) */
	hasAllFilesAccessJs: () => boolean
	/** 跳到系统设置里的「所有文件访问权限」页 */
	requestAllFilesAccess: () => void
	checkFishBalance: (apiKey: string, baseUrl: string) => void
	checkDeepSeekBalance: (apiKey: string, baseUrl: string) => void
	checkCosyBalance: (apiKey: string, baseUrl: string) => void
	listVoices: (apiKey: string, baseUrl: string) => void
	cosyTtsStream: (baseUrl: string, apiKey: string, model: string, voice: string, format: string, sampleRate: number, rate: number, text: string) => void
	cosyTtsStop: () => void
	/** 声音克隆: 系统文件选择器选音频 */
	pickVoiceFile: () => void
	/** 创建克隆音色 (内部完成上传) */
	createCloneVoice: (apiKey: string, targetModel: string, prefix: string) => void
	/** 查询克隆音色状态 */
	queryCloneVoice: (apiKey: string, voiceId: string) => void
	/** 悬浮窗: 是否有权限 */
	canFloat: () => boolean
	/** 悬浮窗: 打开权限设置页 */
	requestFloatPermission: () => void
	/** 悬浮窗: 启动 */
	showFloat: () => void
	/** 悬浮窗: 关闭 */
	hideFloat: () => void
	/** 悬浮窗: 记录开关状态 (原生, 退出时判断用) */
	setFloatEnabled: (enable: boolean) => void
	/** 悬浮窗聊天气泡: 关闭 */
	closeFloatBubble: () => void
	/** 悬浮窗: 设置渲染分辨率 (x) */
	setFloatRenderScale: (s: number) => void
}

declare global {
	interface Window {
		NoriChat?: NoriChat
	}
}

const bridge = (): NoriChat => {
	if (!window.NoriChat) throw new Error("NoriChat 未注入")
	return window.NoriChat
}



export const loadSettings = (): Settings => {
	try {
		const raw = bridge().readFile("settings.json")
		if (!raw) return {...DEFAULT_SETTINGS}
		const parsed = JSON.parse(raw)
		const merged = {...DEFAULT_SETTINGS, ...parsed} as Settings
		// 旧版是 string[], 读时统一归一化 (不能只靠类型断言)
		merged.cosyCloneVoices = normalizeCloneVoices((parsed as {cosyCloneVoices?: unknown})?.cosyCloneVoices)
		return merged
	} catch {
		return {...DEFAULT_SETTINGS}
	}
}

/** 通用文件读取 (记忆系统等使用) */
export const readFile = (name: string): string => {
	try { return bridge().readFile(name) } catch { return "" }
}

/** 通用文件写入; 返回是否成功 (原生返回 "ok" 或 "err:xxx"; 其他值一律视为失败,
 *  避免桥异常路径下 undefined 被误判成写盘成功)。
 *  失败时把**原生给的原因**打进 console —— 只报"失败"等于把原因丢了, 真机上无从定位。 */
export const writeFile = (name: string, content: string): boolean => {
	try {
		const raw = bridge().writeFile(name, content)
		if (raw !== "ok") console.error(`[writeFile] ${name} 写盘失败: ${raw}`)
		return raw === "ok"
	} catch (e) {
		console.error(`[writeFile] ${name} 写盘异常:`, e)
		return false
	}
}

/* ---------------- 自定义文案人设 (2026-10-01 用户要求) ----------------
 * 内置人设是 `nori-prompt.md`（打包进 APK、只读）；用户可以导入自己的提示词替代它。
 * 导入后**只存在本机的 `persona.md`**（与 settings.json 同一个目录，不上传、不进包）。
 * 口径：自定义非空 ⇒ 用它；自定义为空 / 读不到 ⇒ 回落到内置人设（等于没导入过）。
 * ⚠ 缓存是必需的：每次对话都会调 personaPrompt()，每轮读一次盘纯属浪费 —— 模块级缓存，
 *   写盘时清掉（`saveCustomPersona`）。 */
export const PERSONA_FILE = "persona.md"

export interface PersonaPickedResult {
	ok: boolean
	name?: string
	size?: number
	text?: string
	message?: string
}

/** 打开系统文件选择器选文本文件 (结果异步回调; 与选音频那条分开, 回调名不同) */
export const pickPersonaFile = (): Promise<PersonaPickedResult> =>
	new Promise((resolve) => {
		const W = window as unknown as {__noriPersonaPickedRes?: (json: string) => void}
		W.__noriPersonaPickedRes = (json) => {
			delete W.__noriPersonaPickedRes
			try { resolve(JSON.parse(json) as PersonaPickedResult) } catch { resolve({ok: false, message: "选择结果解析失败"}) }
		}
		const nori = (window as unknown as {NoriChat?: {pickPersonaFile?: () => void}}).NoriChat
		if (!nori || typeof nori.pickPersonaFile !== "function") {
			resolve({ok: false, message: "原生桥不支持文件选择 (请升级应用)"})
			return
		}
		try { nori.pickPersonaFile() } catch (e) { resolve({ok: false, message: `发起选择失败: ${String(e)}`}) }
	})

let customPersonaCache: string | null = null

/** 读自定义人设 (没导入过 / 读不到 ⇒ 空串)。带模块级缓存, 避免每轮对话读盘 */
export const loadCustomPersona = (): string => {
	if (customPersonaCache !== null) return customPersonaCache
	customPersonaCache = readFile(PERSONA_FILE).trim()
	return customPersonaCache
}

/** 保存自定义人设 (写盘 + 清缓存)。传空串 = 恢复内置: 只是把文件内容清空, 不删文件 */
export const saveCustomPersona = (text: string): void => {
	customPersonaCache = text.trim()
	writeFile(PERSONA_FILE, text)
}

/** 本轮该用的人设: **自定义优先**, 没有自定义才用内置 —— 三处注入点统一走这里 */
export const personaPrompt = (): string => loadCustomPersona()

/** 保存全部设置, 返回原生 writeFile 的**原始返回** ("ok" / "err:xxx")。
 *  单独开这个入口是为了把真实原因带到界面: 只压成布尔会让 err:insert / err:stream /
 *  SecurityException 全变成一句"存储不可写", 真机上完全没法定位 (2026-09-22 踩过)。
 *  ⚠️ 不要用本函数替换 saveSettings —— T17/A6 守着"写盘失败不许谎报成功"的不变量。 */
export const saveSettingsRaw = (s: Settings): string => {
	try {
		return String(bridge().writeFile("settings.json", JSON.stringify(s)))
	} catch (e) {
		return `err:throw:${(e as Error)?.message ?? String(e)}`
	}
}

/** 保存全部设置。@returns 是否真的写入成功 —— 设置写失败是"用户改了却重启后没了",
 *  调用方 (App 的 persistSettings) 需要据此提示, 不能静默吞掉。 */
export const saveSettings = (s: Settings): boolean => saveSettingsRaw(s) === "ok"



/** chat.json 存储格式: v1 = {cutoff 裁剪边界, msgs 消息}; 旧版本是裸数组 (读时兼容) */
interface ChatFile {
	v?: 1
	/** 裁剪边界: ts 低于它的消息视为"已删除", 双实例共享取最大 (FE-M1) */
	cutoff: number
	msgs: ChatMsg[]
}

/** 裁剪占位符识别 (FE-M4): 之前写盘保留、读盘却过滤, 重启后"更早已压缩"提示消失 */
const PLACEHOLDER_PREFIX = "（更早的对话已压缩"
const isPlaceholderMsg = (m: ChatMsg): boolean =>
	m.role === "system" && (m.placeholder === true || m.content.startsWith(PLACEHOLDER_PREFIX))

/** 读盘消息过滤: 错误气泡 (error 标记 + 旧版 ⚠ 前缀兜底) 不回读; 占位符只保留**第一条**。
 *
 *  为什么占位符要限一条: 裁剪每发生一次就 unshift 一条新占位符 (ts 用 Date.now()),
 *  而归并按 (ts, content) 判重 —— 同文案不同 ts 会被当成两条不同消息都留下。
 *  实测 33 轮裁剪后磁盘累积了 33 条同样的"更早的对话已压缩"占位符, 在聊天界面里
 *  显示成一长串重复气泡, 还挤占 HISTORY_KEEP 的真实消息名额。
 *  占位符只是"更早的已压缩"标记, 语义上全局只需一条。 */
const filterChatMsgs = (arr: unknown[]): ChatMsg[] => {
	let placeholderKept = false
	return arr.filter((m): m is ChatMsg => {
		if (!m || typeof m !== "object") return false
		const role = (m as ChatMsg).role
		const content = (m as ChatMsg).content
		if (typeof content !== "string") return false
		if ((m as ChatMsg).error || content.startsWith("⚠ ")) return false
		if (role === "system") {
			if (!isPlaceholderMsg(m as ChatMsg)) return false
			if (placeholderKept) return false   // 旧数据可能已累积多条 → 只留第一条
			placeholderKept = true
			return true
		}
		return role === "user" || role === "assistant"
	})
}

const readChatFile = (): ChatFile => {
	try {
		const raw = bridge().readFile("chat.json")
		if (!raw) return {cutoff: 0, msgs: []}
		const parsed = JSON.parse(raw) as ChatFile | ChatMsg[]
		if (Array.isArray(parsed)) return {cutoff: 0, msgs: filterChatMsgs(parsed)}
		if (!parsed || !Array.isArray(parsed.msgs)) return {cutoff: 0, msgs: []}
		return {
			cutoff: typeof parsed.cutoff === "number" ? parsed.cutoff : 0,
			msgs: filterChatMsgs(parsed.msgs),
		}
	} catch {
		return {cutoff: 0, msgs: []}
	}
}

/** 本实例裁剪边界: ts 低于它的磁盘消息视为"已删除", 落盘归并时不并入 (0 = 未裁剪) */
let chatCutoff = 0

export const loadChat = (): ChatMsg[] => {
	const file = readChatFile()
	// 裁剪边界跨实例同步 (FE-M1): 磁盘上另一实例可能已裁得更深, 取最大
	if (file.cutoff > chatCutoff) chatCutoff = file.cutoff
	return file.msgs
}

/* ---------------- 聊天记录持久化 (防抖节流 + 双实例落盘归并) ----------------
 * chat.json 会随对话增长, 每次都全量写盘浪费 IO.
 * 改为: 3 秒内多次 persistChat 合并成一次写入; App 退后台时 flush 兜底.
 *
 * 双实例 (主界面 / 悬浮窗对话框各自 WebView) 共享同一份 chat.json, 各有内存快照:
 * - 任一实例全量覆盖都会弄丢另一实例刚写入的消息 → 落盘前把磁盘上
 *   "本地没有的" 消息按 ts 归并进来 (追加日志语义, 谁都不丢);
 * - 裁剪边界 (chatCutoff) 随 chat.json 持久化并在读取/落盘时取双方最大,
 *   任一实例裁掉的旧消息不会再被另一实例的旧快照写回 (FE-M1).
 */
let chatPersistTimer: ReturnType<typeof setTimeout> | null = null
let chatPersistPending: ChatMsg[] | null = null

/** 通知聊天存储"自动裁剪"发生: cutoffTs = 保留段第一条真实消息的 ts.
 *  边界随下一次 persistChat 一并写入 chat.json, 另一实例读盘即生效. */
export const setChatTrimCutoff = (cutoffTs: number): void => {
	if (cutoffTs > chatCutoff) chatCutoff = cutoffTs
}

/** 复位裁剪边界 (仅供测试: 模块级变量跨测试块存活, 不复位会让后续块的归并失效) */
export const __resetChatCutoffForTest = (): void => { chatCutoff = 0 }

export const persistChat = (messages: ChatMsg[]): void => {
	// 真拷贝快照 (FE-M9): 逐条 {...m} 浅拷 (content 为不可变字符串) —— 防抖窗口内
	// 调用方对消息对象的后续修改 (liveBubble 流式增量、错误路径 splice) 不会穿透到写盘内容
	chatPersistPending = messages.map(m => ({...m}))
	if (chatPersistTimer) clearTimeout(chatPersistTimer)
	chatPersistTimer = setTimeout(() => {
		chatPersistTimer = null
		flushChatPersist()
	}, 3000)
}

/** 消息身份: (ts, role)。同一毫秒内同一角色只算一条 (内容取更长的那个, 见 mergeChatLists) */
const identityOf = (m: ChatMsg): string => `${m.ts}\u0000${m.role}`

/** 磁盘为空时走的捷径: 与 mergeChatLists 用**同一套**去重+排序规则, 保证两条路径一致 */
const dedupeByIdentity = (msgs: ChatMsg[]): ChatMsg[] => {
	const map = new Map<string, ChatMsg>()
	for (const m of msgs) {
		if (isPlaceholderMsg(m)) {
			let has = false
			for (const [, v] of map) if (isPlaceholderMsg(v)) { has = true; break }
			if (has) continue
		}
		const k = identityOf(m)
		const prev = map.get(k)
		if (!prev || m.content.length > prev.content.length) map.set(k, m)
	}
	return [...map.values()].sort((a, b) => a.ts - b.ts)
}

/**
 * 归并两条聊天列表 (追加日志语义): 求并集, 按 ts 升序输出。
 *
 * 去重分两层:
 * 1. **同 (ts, role) 视为同一条消息** —— 保留内容**较长**的那个。
 *    为什么: 助手消息的 ts 在流式**开始**时定下, 内容在流式过程中原地增长。
 *    若流式途中切后台再回前台, `messages.value = loadChat()` 会换掉内存里那个
 *    正在增长的对象 (App.vue 注释里承认的 FE-H2 场景), 之后流式完成写入的是
 *    **部分内容**, 而磁盘上已有**完整内容** —— 两者 ts 相同、role 相同、内容不同。
 *    按"不同内容就都留"的规则会渲染成两条气泡 (实测复现)。
 *    同一毫秒内两条**不同角色**的消息不受影响, 仍都保留 (防丢)。
 * 2. 占位符全局只留一条 (它每轮裁剪都会新建, 文案相同 ts 不同)。
 *
 * 磁盘中 ts < 裁剪边界的丢弃 (本实例已 trim 的旧消息, 防止被并回)。
 * 用 Map 做并集, 从构造上不可能产出重复项。
 */
const mergeChatLists = (disk: ChatMsg[], local: ChatMsg[]): ChatMsg[] => {
	const map = new Map<string, ChatMsg>()
	const add = (m: ChatMsg): void => {
		// 占位符只留第一条 (先进 Map 的胜出)
		if (isPlaceholderMsg(m)) {
			for (const [, v] of map) if (isPlaceholderMsg(v)) return
		}
		const k = `${m.ts}\u0000${m.role}`
		const prev = map.get(k)
		if (!prev) { map.set(k, m); return }
		// 同 ts 同角色: 留内容更长的那条 (完整 vs 流式部分)
		if (m.content.length > prev.content.length) map.set(k, m)
	}
	for (const m of disk) {
		if (m.ts < chatCutoff) continue
		add(m)
	}
	for (const m of local) add(m)
	return [...map.values()].sort((a, b) => a.ts - b.ts)
}

/** 防抖重试间隔: 写盘失败后重排下一次尝试 (比常规防抖短, 尽快自愈) */
const PERSIST_RETRY_MS = 1000

/**
 * 把待落盘快照归并成最终写入内容 (每次都重读磁盘, 不缓存结果).
 * 提成独立函数是为了让"失败重试"能安全重跑: 归并是幂等的 (同一输入必得同一输出),
 * 重试时再读一次磁盘, 还能顺带吸收重试期间另一实例写进来的新消息.
 */
const buildChatFile = (): ChatFile => {
	// 错误提示气泡 (⚠ …) 不落盘: 否则重启前一直可见, 且会被 loadChat 读回当作 assistant 历史
	const data = (chatPersistPending ?? []).filter(m => !m.error)
	// 双实例防线: 落盘前与磁盘归并 —— 磁盘可能是另一实例 (悬浮窗) 刚写的,
	// 本地内存没有; 直接覆盖会把对方的新消息弄丢. 归并 = 追加日志求并集.
	// 裁剪边界先取双方最大 (FE-M1): 任一实例裁掉的旧消息不再被旧快照并回.
	const diskFile = readChatFile()
	if (diskFile.cutoff > chatCutoff) chatCutoff = diskFile.cutoff
	const sys = data.filter(m => m.role === "system")
	const local = data.filter(m => m.role !== "system")
	let out = data
	if (local.length) {
		// 磁盘消息同样过一遍 filterChatMsgs: 否则**历史遗留**的重复占位符 (旧版本累积
		// 出来的) 会被并回本地快照, 永远清不掉 —— loadChat 走过滤、这里不走, 就会
		// 出现"读出来是 1 条、写回去又变 2 条"的拉锯。过滤对消息无害, 只是丢掉
		// 错误气泡与非占位符 system 消息 (本就不该落盘)。
		const disk = filterChatMsgs(diskFile.msgs)
		out = [...sys, ...(disk.length ? mergeChatLists(disk, local) : dedupeByIdentity(local))]
	}
	// 最后一道收口: 上面 sys 是**前置拼接**的, 绕过了 mergeChatLists 的占位符去重,
	// 所以磁盘上会长期留着 2 条同文案占位符 (读盘时被 filter 收成 1 条, 功能无碍,
	// 但文件里不该有垃圾)。这里统一去重, 保证落盘内容本身就只有一条。
	return {v: 1, cutoff: chatCutoff, msgs: dedupePlaceholders(out)}
}

/** 只保留第一条占位符 (消息顺序不变); 非占位符消息一律不动 */
const dedupePlaceholders = (msgs: ChatMsg[]): ChatMsg[] => {
	let seen = false
	let dup = false
	for (const m of msgs) {
		if (!isPlaceholderMsg(m)) continue
		if (seen) { dup = true; break }
		seen = true
	}
	if (!dup) return msgs
	seen = false
	return msgs.filter(m => {
		if (!isPlaceholderMsg(m)) return true
		if (seen) return false
		seen = true
		return true
	})
}

/** 立即落盘 (App 退后台/关闭前调用, 防止丢最后一次写入) */
export const flushChatPersist = (): void => {
	if (chatPersistTimer) {
		clearTimeout(chatPersistTimer)
		chatPersistTimer = null
	}
	if (!chatPersistPending) return
	try {
		// 注意: pending 只在**写成功之后**才清空, 且必须检查返回值 —— 原生可能返回
		// "err:xxx" 或桥异常, 旧实现先把 pending 置 null 且丢弃返回值, 于是任何一次
		// 写盘失败都会让这一整批消息静默消失 (退后台时用户刚发的内容可能就此丢掉).
		// 失败则保留 pending 并重排一次重试; 重试会重读磁盘重新归并, 不会重复或丢消息.
		const file = buildChatFile()
		if (writeFile("chat.json", JSON.stringify(file))) {
			chatPersistPending = null
			return
		}
		console.error("[chat] persist write failed, will retry")
	} catch (e) {
		console.error("[chat] persist error", e)
	}
	if (!chatPersistTimer) {
		chatPersistTimer = setTimeout(() => {
			chatPersistTimer = null
			flushChatPersist()
		}, PERSIST_RETRY_MS)
	}
}



export const readMemory = (): string => {
	try { return bridge().readMemory() } catch { return "" }
}

export const appendMemory = (text: string): void => {
	try { if (text.trim()) bridge().appendMemory(text.trim()) } catch {  }
}



export const isStorageReady = (): boolean => {
	try { return !!bridge().isStorageReady() } catch { return false }
}

export const requestStoragePermission = (): void => {
	try { bridge().requestStoragePermission() } catch {  }
}

export const getStorageDir = (): string => {
	try { return bridge().getStorageDir() } catch { return "Download/DeepEr" }
}

/**
 * **公共目录直读探针** (实机自查): 返回 JSON 字符串, 说明某个文件在
 * MediaStore 是否可见 / 磁盘上是否存在 / 能否直读 / 目录内容列表。
 * 用途: 定位"卸载重装后读不到原有数据" —— 是 MediaStore 行没了, 还是直读被系统挡住。
 */
export const probePublicFiles = (name: string): string => {
	try { return bridge().probePublicFiles(name) } catch (e) { return `err:${String(e)}` }
}

/** 是否已获得「所有文件访问权限」(Android 11+): 拿到后读写公共目录走文件路径, 不受 MediaStore 隔离 */
export const hasAllFilesAccess = (): boolean => {
	try { return !!bridge().hasAllFilesAccessJs() } catch { return false }
}

/** 跳到系统设置里的「所有文件访问权限」页 (授予后返回应用即可生效) */
export const requestAllFilesAccess = (): void => {
	try { bridge().requestAllFilesAccess() } catch { /* 忽略 */ }
}



export interface ModelsResult {
	ok: boolean
	models?: string[]
	message?: string
}


declare global {
	interface Window {
		__noriModelsRes?: (json: string) => void
		__noriChatRes?: (json: string) => void
		__noriFishBalanceRes?: (json: string) => void
		__noriDeepseekBalanceRes?: (json: string) => void
		__noriCosyBalanceRes?: (json: string) => void
		__noriVoicesRes?: (json: string) => void
		/** 测试钩子: 覆盖桥调用超时 (毫秒) */
		__noriBridgeTimeoutMs?: number
	}
}

/** 桥调用超时 (FE-M2): 原生不回包时 Promise 永不 settle, UI 永久转圈 ——
 *  元数据类调用 (模型/余额/音色) 统一加超时兜底. 下载/聊天/克隆语义不同不加. */
const bridgeTimeoutMs = (): number =>
	(window as unknown as {__noriBridgeTimeoutMs?: number}).__noriBridgeTimeoutMs ?? 12_000

export const fetchModels = (baseUrl: string, apiKey: string): Promise<ModelsResult> =>
	new Promise((resolve) => {
		let settled = false
		const done = (r: ModelsResult): void => {
			if (settled) return
			settled = true
			delete window.__noriModelsRes
			resolve(r)
		}
		window.__noriModelsRes = (json) => {
			try { done(JSON.parse(json)) } catch { done({ok: false, message: "响应解析失败"}) }
		}
		setTimeout(() => done({ok: false, message: "请求超时, 请检查网络后重试"}), bridgeTimeoutMs())
		try { bridge().fetchModels(baseUrl, apiKey) } catch { done({ok: false, message: "NoriChat 未注入"}) }
	})

export interface BalanceResult {
	ok: boolean
	credit?: string
	hasFreeCredit?: boolean
	isAvailable?: boolean
	balance?: string
	message?: string
}


export const checkFishBalance = (baseUrl: string, apiKey: string): Promise<BalanceResult> =>
	new Promise((resolve) => {
		let settled = false
		const done = (r: BalanceResult): void => {
			if (settled) return
			settled = true
			delete window.__noriFishBalanceRes
			resolve(r)
		}
		window.__noriFishBalanceRes = (json) => {
			try { done(JSON.parse(json)) } catch { done({ok: false, message: "响应解析失败"}) }
		}
		setTimeout(() => done({ok: false, message: "请求超时, 请检查网络后重试"}), bridgeTimeoutMs())
		try { bridge().checkFishBalance(apiKey, baseUrl) } catch { done({ok: false, message: "NoriChat 未注入"}) }
	})


export const checkDeepSeekBalance = (baseUrl: string, apiKey: string): Promise<BalanceResult> =>
	new Promise((resolve) => {
		let settled = false
		const done = (r: BalanceResult): void => {
			if (settled) return
			settled = true
			delete window.__noriDeepseekBalanceRes
			resolve(r)
		}
		window.__noriDeepseekBalanceRes = (json) => {
			try { done(JSON.parse(json)) } catch { done({ok: false, message: "响应解析失败"}) }
		}
		setTimeout(() => done({ok: false, message: "请求超时, 请检查网络后重试"}), bridgeTimeoutMs())
		try { bridge().checkDeepSeekBalance(apiKey, baseUrl) } catch { done({ok: false, message: "NoriChat 未注入"}) }
	})

export const checkCosyBalance = (baseUrl: string, apiKey: string): Promise<BalanceResult> =>
	new Promise((resolve) => {
		let settled = false
		const done = (r: BalanceResult): void => {
			if (settled) return
			settled = true
			delete window.__noriCosyBalanceRes
			resolve(r)
		}
		window.__noriCosyBalanceRes = (json) => {
			try { done(JSON.parse(json)) } catch { done({ok: false, message: "响应解析失败"}) }
		}
		setTimeout(() => done({ok: false, message: "请求超时, 请检查网络后重试"}), bridgeTimeoutMs())
		try { bridge().checkCosyBalance(apiKey, baseUrl) } catch { done({ok: false, message: "NoriChat 未注入"}) }
	})

export interface VoiceInfo {
	id: string
	title: string
}

export interface VoicesResult {
	ok: boolean
	voices?: VoiceInfo[]
	message?: string
}


export const fetchVoices = (baseUrl: string, apiKey: string): Promise<VoicesResult> =>
	new Promise((resolve) => {
		let settled = false
		const done = (r: VoicesResult): void => {
			if (settled) return
			settled = true
			delete window.__noriVoicesRes
			resolve(r)
		}
		window.__noriVoicesRes = (json) => {
			try { done(JSON.parse(json)) } catch { done({ok: false, message: "响应解析失败"}) }
		}
		setTimeout(() => done({ok: false, message: "请求超时, 请检查网络后重试"}), bridgeTimeoutMs())
		try { bridge().listVoices(apiKey, baseUrl) } catch { done({ok: false, message: "NoriChat 未注入"}) }
	})

export interface ChatResult {
	ok: boolean
	content?: string
	message?: string
}

/** Native non-stream calls share one callback; a missing callback must not stall the queue. */
const CHAT_TOTAL_TIMEOUT_MS = 90_000

export const sendChat = (
	baseUrl: string,
	apiKey: string,
	model: string,
	messages: ChatMsg[],
	thinking = false,
): Promise<ChatResult> => {
	if (!apiKey.trim()) return Promise.resolve({ok: false, message: "请先在设置里填写 API Key"})
	if (!model.trim()) return Promise.resolve({ok: false, message: "请先在设置里选择模型"})
	// 串行队列: 非流式调用 (记忆提取/总结/日记/语义召回) 共用 __noriChatRes 单例回调,
	// 并发会互相覆盖导致丢响应 → 排队逐个执行
	return enqueueChat(() => {
		const payload = JSON.stringify(messages.map(({role, content}) => ({role, content})))
		return new Promise<ChatResult>((resolve) => {
			let settled = false
			let timeout: ReturnType<typeof setTimeout> | null = null
			const done = (result: ChatResult): void => {
				if (settled) return
				settled = true
				if (timeout) { clearTimeout(timeout); timeout = null }
				delete window.__noriChatRes
				resolve(result)
			}
			window.__noriChatRes = (json) => {
				try { done(JSON.parse(json)) } catch { done({ok: false, message: "响应解析失败"}) }
			}
			timeout = setTimeout(() => done({ok: false, message: "请求超时, 请检查网络后重试"}), CHAT_TOTAL_TIMEOUT_MS)
			try {
				bridge().chat(baseUrl, apiKey, model, payload, resolveThinking(baseUrl, thinking))
			} catch {
				done({ok: false, message: "请求失败"})
			}
		})
	})
}

/** 非流式聊天串行队列 (防 __noriChatRes 单例回调被并发覆盖) */
let chatQueue: Promise<unknown> = Promise.resolve()
const enqueueChat = <T,>(task: () => Promise<T>): Promise<T> => {
	const run = chatQueue.then(task, task) // 无论前一个成败都继续
	chatQueue = run.catch(() => { /* 吞掉队列错误, 防止断链 */ })
	return run
}

/**
 * DeepSeek 思考模式: **开关是唯一口径**, 且两个方向都要**显式**告诉服务端。
 *
 * ## 为什么"不传"不等于"关"（2026-10-02, 用户指定默认**开**）
 * 官方文档写明「思考模式**默认打开**，且 effort 默认为 `high`」（见
 * https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/ ）。旧实现只在开关打开时传
 * `thinking:{type:"enabled"}`，关的时候**什么都不传** —— 服务端照样按默认思考。
 * 也就是说设置里那个开关以前是**单向**的：能开、不能关。现在两个方向都显式传。
 *
 * ## 返回值的三态（对应原生侧要不要写这个字段）
 * - `"enabled"`  → 传 `thinking:{type:"enabled"}`（默认值, 见 DEFAULT_SETTINGS）
 * - `"disabled"` → 传 `thinking:{type:"disabled"}`（用户手动关掉时）
 * - `""`         → **不传**：非 DeepSeek 端点, 这个字段是 DeepSeek 专有扩展,
 *                  绝不能塞给 OpenAI 等其它提供商（可能直接 400）。
 */
export const resolveThinking = (baseUrl: string, thinking: boolean): "" | "enabled" | "disabled" =>
	/deepseek/i.test(baseUrl) ? (thinking ? "enabled" : "disabled") : ""

/* ---------------- 流式聊天 (SSE) ---------------- */

export interface StreamChatCallbacks {
	/** 每次收到文本增量 */
	onDelta: (delta: string) => void
	/** 流结束 (content 为完整回复) */
	onDone: (content: string) => void
	/** 失败 */
	onError: (message: string) => void
}

declare global {
	interface Window {
		__noriChatDelta?: (delta: string) => void
		__noriChatDone?: (json: string) => void
		__noriChatError?: (json: string) => void
	}
}

/** 流式"空闲看门狗" (ms): 距上次收到 delta 超过该时长即判失败。
 *  为什么必须有: window.__noriChatDelta/Done/Error 是全局单例回调, 原生桥一旦"调用成功但
 *  永不回包"(进程被回收/断流/原生异常), 那一路 Promise 永不 settle →
 *  streamQueue 被永久卡住 → **之后所有消息都发不出去, 只能重启 App** (已实测复现)。
 *  做成"空闲"而非"总时长"看门狗: 每收到一个 delta 就重置, 长回复不会被误杀。
 *  30s 足够宽裕 —— 正常流式不会 30 秒一个字都不吐。 */
const STREAM_IDLE_TIMEOUT_MS = 30_000
const streamIdleTimeoutMs = (): number =>
	(window as unknown as {__noriStreamTimeoutMs?: number}).__noriStreamTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS

/**
 * 流式聊天: 优先走原生 SSE 桥; 桥不可用时回退非流式 (一次返回全文).
 * @param signal 本地取消信号: abort 时立即结束 (并通知原生桥 chatStop)
 */
/** 流式串行队列: window.__noriChatDelta/Done/Error 是全局单例回调, 且原生 chatToken
 *  只把回包发给"最近一次" chatStream —— 并发两路流式 (如触摸触发对话 + 手动发送)
 *  会互相覆盖回调, 先结束的一方把另一方的回调 delete 掉 → 丢回复/永久挂起.
 *  与非流式 enqueueChat 同思路: 排队逐个执行, 前一路结束 (done/error/abort/超时) 才发下一路. */
let streamQueue: Promise<unknown> = Promise.resolve()

export const sendChatStream = (
	baseUrl: string,
	apiKey: string,
	model: string,
	messages: ChatMsg[],
	callbacks: StreamChatCallbacks,
	thinking = false,
	signal?: AbortSignal,
): void => {
	if (!apiKey.trim()) { callbacks.onError("请先在设置里填写 API Key"); return }
	if (!model.trim()) { callbacks.onError("请先在设置里选择模型"); return }
	const task = (): Promise<void> =>
		new Promise<void>((resolveTask) => {
			let idleTimer: ReturnType<typeof setTimeout> | null = null
			const finish = (): void => {
				if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
				resolveTask()
			}
			const payload = JSON.stringify(messages.map(({role, content}) => ({role, content})))
			const nori = window.NoriChat
			if (nori && typeof nori.chatStream === "function") {
				const onAbort = () => {
					// 本地取消: 顺手通知原生断流 (否则原生会把整个 SSE 拉完, 白耗流量);
					// 即使原生桥丢弃过期回包, 这里也能正常结束
					try { nori.chatStop?.() } catch { /* 忽略 */ }
					cleanup()
					callbacks.onError("已停止")
					finish()
				}
				const cleanup = () => {
					delete window.__noriChatDelta
					delete window.__noriChatDone
					delete window.__noriChatError
					signal?.removeEventListener("abort", onAbort)
				}
				/** 重置空闲看门狗: 起跑时与每收到一个 delta 时各调一次 */
				const armIdleWatchdog = (): void => {
					if (idleTimer) clearTimeout(idleTimer)
					idleTimer = setTimeout(() => {
						idleTimer = null
						cleanup()
						callbacks.onError("响应超时（长时间没有数据）")
						finish()
					}, streamIdleTimeoutMs())
				}
				window.__noriChatDelta = (delta) => {
					armIdleWatchdog()   // 有数据 → 重置看门狗, 长回复不会被误杀
					callbacks.onDelta(delta)
				}
				window.__noriChatDone = (json) => {
					cleanup()
					try {
						const r = JSON.parse(json) as {ok?: boolean; content?: string}
						callbacks.onDone(r.content ?? "")
					} catch {
						callbacks.onDone("")
					}
					finish()
				}
				window.__noriChatError = (json) => {
					cleanup()
					try {
						const r = JSON.parse(json) as {message?: string}
						callbacks.onError(r.message ?? "请求失败")
					} catch {
						callbacks.onError("请求失败")
					}
					finish()
				}
				if (signal) {
					if (signal.aborted) { onAbort(); return }
					signal.addEventListener("abort", onAbort)
				}
				armIdleWatchdog()
				try {
					nori.chatStream(baseUrl, apiKey, model, payload, resolveThinking(baseUrl, thinking))
				} catch (e) {
					cleanup()
					callbacks.onError(`发起流式请求失败: ${String(e)}`)
					finish()
				}
				return
			}
			// 回退: 非流式
			void sendChat(baseUrl, apiKey, model, messages, thinking).then((r) => {
				if (r.ok) {
					const content = r.content ?? ""
					callbacks.onDelta(content)
					callbacks.onDone(content)
				} else {
					callbacks.onError(r.message ?? "请求失败")
				}
				finish()
			})
		})
	streamQueue = streamQueue.then(task, task)
}

/** 打断当前流式聊天 */
export const cancelChatStream = (): void => {
	try {
		window.NoriChat?.chatStop?.()
	} catch {
		// 忽略
	}
}
