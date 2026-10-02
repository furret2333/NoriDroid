/* ---------------- 流式表情/动作标记解析 ----------------
 * 方案: AI 在回复末尾附上隐藏标记 【表情:开心】【动作:jump】,
 * 前端流式接收时即时解析并剥离 (不进正文、不进 TTS、不显示).
 * 标记可能被网络分块从中间切断, 因此需要跨块缓冲.
 * 主 App 聊天与悬浮窗聊天气泡共用本模块, 保证行为一致.
 */

export interface ParsedMarkers {
	clean: string
	emotion: string | null
	motion: string | null
}

/** 从增量文本里提取并剥离表情/动作标记 (兼容跨块). buf 为本次流式会话的独立缓冲对象. */
export const parseMarkerDelta = (delta: string, buf: {value: string}): ParsedMarkers => {
	const full = buf.value + delta
	let emotion: string | null = null
	let motion: string | null = null
	// 提取完整标记: 【表情:xxx】 / 【动作:xxx】, 支持全角冒号与空格
	const EMOTE_RE = /【\s*表情\s*[:：]\s*([^】]*?)】/g
	const MOTION_RE = /【\s*动作\s*[:：]\s*([^】]*?)】/g
	let clean = full.replace(EMOTE_RE, (_m, v: string) => {
		const t = String(v).trim()
		if (t) emotion = t
		return ""
	})
	clean = clean.replace(MOTION_RE, (_m, v: string) => {
		const t = String(v).trim()
		if (t) motion = t
		return ""
	})
	// 跨块保护: 末尾出现未闭合的"【"(无论后面是什么) 时进缓冲, 等下一块拼上再判断.
	// 例如 "正文【表" + "情:开心】" 或 "正文【表情:开" + "心】" 都能正确拼回.
	// 上限: 缓冲超过 12 字符仍未闭合 → 把缓冲内容放回正文 (可能是正文里的"【", 不该吞)
	const MAX_TAIL = 12
	const openIdx = clean.lastIndexOf("【")
	if (openIdx >= 0) {
		const tail = clean.slice(openIdx)
		if (!tail.includes("】") && tail.length <= MAX_TAIL) {
			buf.value = tail
			clean = clean.slice(0, openIdx)
		} else {
			// 已闭合 或 超长未闭合: 留在正文 (不丢字符)
			buf.value = ""
		}
	} else {
		buf.value = ""
	}
	return {clean, emotion, motion}
}
