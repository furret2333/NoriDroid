/**
 * 千问 CosyVoice / Qwen-Audio-TTS 的模型清单, 以及"音色 ↔ 模型"关系的纯逻辑。
 *
 * 这些函数**刻意不依赖任何东西** (不 import 设置模块、不 import 合成实现、不碰 window),
 * 原因有两个:
 *   1. settings 层 (services/chat) 也要用它们做数据归一化,
 *      若从 cosyvoice.ts import 会把合成实现 (fishaudio / 播放器) 拖进无关 bundle;
 *   2. 纯函数才能被 Node 门禁直接测 —— tmp-memcheck/run-tts-tests.mjs 覆盖本文件全部导出。
 * 对应地: 改动本文件后**必须**跑 `node tmp-memcheck/run-tts-tests.mjs`。
 */

/** 可选模型清单 (下拉顺序即此处顺序)。三族都走同一套 SpeechSynthesizer + 复刻接口, 故可直接列在这里。
 *  音色策略: 本项目一律使用"用户自己克隆的专属音色", 不用任何系统音色。
 *  依据 (官方音色列表文档原文): "每个模型仅支持一组特定的音色, 不能将一个模型的音色与另一个模型混用。
 *  如果所填音色不在当前模型支持的音色列表中, 服务将返回 InvalidParameter 错误"。
 *  踩过的坑: 曾在音色留空时兜底成裸的 `longxiaochun`, 但各模型的"龙小淳"实际是
 *  `longxiaochun_v3`(v3-flash) / `longxiaochun_v2`(v2), qwen-audio 系更是 `longanhuan_v3.1` 这种写法,
 *  所以那个兜底对清单里每个模型都无效 —— 留空必然失败, 服务端只回一句 Engine error [411], 不点明原因。
 *
 *  ⚠️ 往这里加模型时必须保证: 不存在两个模型互为"带横线前缀"的关系
 *     (即 `a + "-"` 不是 `b` 的开头), 否则 cosyModelFromVoiceId 会有歧义。
 *     run-tts-tests.mjs 里有一条属性测试专门守这个不变量。 */
export const COSY_MODELS = ["cosyvoice-v3.5-plus", "cosyvoice-v3.5-flash", "cosyvoice-v3-plus", "cosyvoice-v3-flash", "cosyvoice-v2", "qwen-audio-3.1-tts-flash", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"]

/** 一个用户克隆出来的音色, 以及它是为哪个模型克隆的。
 *  model 为空字符串 = 未知 (旧版本数据没存且前缀也认不出), 此时不做"跨模型"判断, 宁可少提示也不误报。 */
export interface CosyCloneVoice {
	id: string
	model: string
}

/**
 * 从音色 id 反推它属于哪个模型。
 *
 * 依据 (官方"声音复刻 HTTP API 参考"原文): 生成的音色名格式为
 *   `{target_model}-{prefix}-{唯一标识}`
 * 例如 `qwen-audio-3.0-tts-flash-myvoice-ab12cd`。
 * 所以用 "模型名 + -" 做前缀匹配即可 —— COSY_MODELS 里不存在互为带横线前缀的两个模型,
 * 无歧义, 遍历顺序也不影响结果 (该不变量由门禁的属性测试守着)。
 *
 * 用途: 旧版本克隆的音色没有记录所属模型。靠这条规则把它们认出来,
 * 否则它们会永远停在"归属未知 → 不做跨模型判断", 白丢一层保护。
 * 认不出来 (不属于这 8 个模型, 例如手工填的其它 id) 返回 "", 调用方据此保持"未知"。
 */
export const cosyModelFromVoiceId = (id: string): string => {
	const v = (id ?? "").trim()
	if (!v) return ""
	for (const m of COSY_MODELS) {
		if (v.startsWith(m + "-")) return m
	}
	return ""
}

/**
 * 当前选中的音色属于哪个模型 (空音色返回 "")。
 * 优先级: settings 里记录的绑定 > 用音色 id 前缀反推。
 * 两者都认不出 → "" = 未知, 调用方不做跨模型判断。
 */
export const pickVoiceModel = (voice: string, cloneVoices: readonly CosyCloneVoice[] | undefined): string => {
	const id = (voice ?? "").trim()
	if (!id) return ""
	const known = (cloneVoices ?? []).find((v) => v?.id === id)?.model ?? ""
	return known || cosyModelFromVoiceId(id)
}

/**
 * 归一化 cosyCloneVoices: 兼容旧版的 string[] (只有 id) 以及各种坏数据。
 * 老用户升级后 settings.json 里是 ["myvoice_xxx"], 不归一化会在读设置时就崩。
 * 记录里没有 model 时用 cosyModelFromVoiceId 反推, 让旧数据也拿到"跨模型"保护。
 * 同 id 去重时**优先保留带 model 的那条** (信息更多)。
 */
export const normalizeCloneVoices = (v: unknown): CosyCloneVoice[] => {
	if (!Array.isArray(v)) return []
	const byId = new Map<string, CosyCloneVoice>()
	for (const it of v) {
		let id = ""
		let model = ""
		if (typeof it === "string") {
			id = it.trim()
		} else if (it && typeof it === "object") {
			const o = it as {id?: unknown; model?: unknown}
			id = typeof o.id === "string" ? o.id.trim() : ""
			model = typeof o.model === "string" ? o.model.trim() : ""
		}
		if (!id) continue
		if (!model) model = cosyModelFromVoiceId(id)
		// Map 对已存在的键不会改变插入顺序, 所以"先出现的排前面"这一点保持不变。
		const prev = byId.get(id)
		if (!prev || (!prev.model && model)) byId.set(id, {id, model})
	}
	return [...byId.values()]
}
