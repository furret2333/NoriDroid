import {reactive, ref, watch, type Ref} from "vue"
import {
	persistChat, setChatTrimCutoff, sendChat, personaPrompt, pickImageFile, captureImage,
	sendChatStream, cancelChatStream, type ChatMsg, type ImagePickedResult,
} from "../services/chat"
import {
	selectOpeningRecall, summarizeIfNeeded, notifyHistoryTrimmed, safeTrimDrop,
	contextHistory, shouldSkipLlmExtract,
} from "../services/memory"
import {memoryChatOptions, selectRecallWithinBudget} from "../services/memory/context"
import {
	isTtsReady, stop as stopTTS, beginSpeakSession, speakAppend, endSpeakSession, splitSpeechText,
} from "../services/tts"
import {parseMarkerDelta} from "../services/chat/markers"
import {stripInternalPromptMetadata} from "../services/chat/replyMetadata"
import {ambientTouch} from "../services/ambient"
import {habitRecord} from "../services/habit"
import {bufferDiarySource} from "../services/nori-diary"
import {buildFocusHint, type PomoSummary} from "../services/pomo-stats"
import {petAudioTouch} from "../services/live2d/petAudio"
import type {TouchArea} from "../services/live2d/touch"
import type {AppSettings} from "./useAppSettings"

export interface ChatSessionOptions {
	settings: () => AppSettings
	modelReady: () => boolean
	panel: Readonly<Ref<string>>
	chatOpen: Readonly<Ref<boolean>>
	imageMenu: Ref<boolean>
	speaking: Readonly<Ref<boolean>>
	portraitReply: Ref<string>
	touchReplyPreview: Ref<string>
	openSettings: () => void
	chatScrollElement: () => HTMLElement | null | undefined
	triggerBubble: (text: string, durationMs?: number) => void
	showPortraitReply: (text: string, durationMs?: number) => void
	showAiBubble: (text: string, durationMs?: number) => void
	scrollChatBottom: () => void
	pomoPhase: () => string
	pomoPhaseText: () => string
	pomoSummary: () => PomoSummary
	celebrated: () => Record<string, number> | undefined
	focusHintFresh: () => boolean
	markFocusHinted: () => void
	markCelebrated: (key: string) => void
	playMarkerEmotion: (text: string) => void
	playMarkerMotion: (text: string) => void
	triggerEmotion: (text: string) => void
	pickMotionByKeyword: (text: string) => void
	analyzeAfterReply: (userText: string, replyText: string) => Promise<void>
	maybeAutoTuneExamples: () => unknown
	refreshMemView: () => void
}

/** Chat and touch share transport ownership and the input queue.
 * App keeps watcher registration, hydration and lifecycle ordering explicit.
 */
export const useChatSession = ({
	settings, modelReady, panel, chatOpen, imageMenu, speaking, portraitReply, touchReplyPreview,
	openSettings, chatScrollElement, triggerBubble, showPortraitReply, showAiBubble, scrollChatBottom,
	pomoPhase, pomoPhaseText, pomoSummary, celebrated, focusHintFresh, markFocusHinted, markCelebrated,
	playMarkerEmotion, playMarkerMotion, triggerEmotion, pickMotionByKeyword, analyzeAfterReply,
	maybeAutoTuneExamples, refreshMemView,
}: ChatSessionOptions) => {
	const draft = ref("")
	const typing = ref(false)
	/** 是否正在流式生成回复 (用于隐藏重复的"…"气泡) */
	const chatStreaming = ref(false)
	/** 触摸触发对话是否正在流式 (防重入锁; 用 ref 供输入排队的 watch 观察) */
	const touchStreaming = ref(false)
	/** 当前流式请求的取消控制器 (停止生成按钮用) */
	let activeChatAbort: AbortController | null = null
	/** 触摸触发对话的取消控制器 (与聊天输入的 activeChatAbort 并行, 都归停止按钮管) */
	let activeTouchAbort: AbortController | null = null

	/** 用户点了"停止生成": onError 里据此区分"用户停止"与"真失败" (不再只靠文案匹配) */
	let stopRequested = false

	/** 停止生成 (本地取消 + 原生桥 chatStop): 同时停聊天流与触摸触发流, 并停朗读 */
	const stopGenerate = () => {
		stopRequested = true
		if (activeChatAbort) {
			activeChatAbort.abort()
			activeChatAbort = null
		}
		if (activeTouchAbort) {
			activeTouchAbort.abort()
			activeTouchAbort = null
		}
		stopTTS()
		cancelChatStream()
	}
	const messages = ref<ChatMsg[]>([])

	/** 聊天流式对话的独立标记缓冲对象 (与触摸触发隔离) */
	const chatMarkerBuf = {value: ""}
	/** 触摸触发对话的独立标记缓冲 (与聊天流式隔离, 避免并发踩踏) */
	const touchMarkerBuf = {value: ""}

	/** 语义召回预算 (ms): 超时先用关键词兜底发送, 语义结果后台自行收尾 */
	const RECALL_BUDGET_MS = 1200

	const TAP_VERBS = ["戳了戳", "点了点", "轻轻点了一下", "碰了碰", "戳了一下"]
	const SWIPE_VERBS = ["摸了摸", "轻轻摸了摸", "蹭了蹭", "抚摸了好几下", "揉了揉"]

	const TOUCH_DIRECTIVE = [
		"这一次是触摸互动：",
		"1. 你已经是一个感觉灵敏的人, 完全按自己的方式来反应, 不许复读之前说过的话, 不许每次都说同一句类似的话。",
		"2. 被摸到什么地方不重要, 重点是营造当下真实、鲜活、有戏的氛围——害羞、舒服、痒、逗趣、傲娇、躲开……随你发挥, 越有趣越好。",
		"3. AI 不要把「什么被摸」这件事机械地复述成一成不变的固定台词, 当作一次自然发生的互动来回应。",
		"4. 只回应当下，用 1～2 句简短自然的话，不主动展开长篇对话。",
	].join("\n")

	const POKE_DIRECTIVE = [
		"用户轻轻戳了戳你。顺着这个小动作，从提供的时间、近况、记忆或目标里选一个合适的点，自然闲聊 1～3 句；也可以撒娇、吐槽、关心或只回应当下。",
		"不硬塞背景，不机械复述动作，避免重复套路。",
	].join("\n")


	const surface = (content: string) => {
		// 显示原文 (带标点, 更稳定)
		messages.value.push({role: "assistant", content, ts: Date.now()})
		showPortraitReply(content)
		persistChat(messages.value)
		if (chatOpen.value) scrollChatBottom()
		else showAiBubble(content)
	}

	const handleTouchTrigger = async (area: Pick<TouchArea, "name" | "prompt" | "reactionPrompt">, type: "tap" | "swipe", poke = false) => {
		if (typing.value || chatStreaming.value || touchStreaming.value || (!poke && speaking.value)) return
		const reaction = (area.reactionPrompt ?? "").trim()
		const areaName = area.name || "未知区域"
		const pool = type === "swipe" ? SWIPE_VERBS : TAP_VERBS
		const verb = pool[Math.floor(Math.random() * pool.length)]
		const text = poke ? "用户正在轻轻戳戳 Nori" : `用户 ${verb} Nori 的「${areaName}」`
		if (!modelReady()) { surface("请先在「设置」里配置 API Key 和模型"); return }
		// 防重入: 触摸触发对话进行中, 再次触发直接忽略 (避免并发流互相踩踏)
		if (touchStreaming.value) return
		if (poke) {
			ambientTouch()
			stopTTS()
		}
		if (!poke && panel.value === "touch") touchReplyPreview.value = "…"
		if (!chatOpen.value) showAiBubble("…")
		// C1 (2026-10-08): 触摸/戳戳是**「没有当前提问」**的场合 —— text 是合成描述
		// （「用户 摸摸 Nori的 头」「用户正在轻轻戳戳 Nori」），拿它做关键词召回基本必然落空
		// （词面重叠是召回的必要条件 ⇒ `recallForQuery("")` 一类必然空手而归）。
		// openingMemoryBlock 正是为这种场合写的：先按当前话题召回，再补"开场就该知道"的
		// 身份/核心记忆（type=core 或 tags 含 identity/explicit，或 importance ≥ 0.8）。
		// 它**只读不强化**（不涨 accessCount）—— 戳戳每次会话都会触发，算强化会让同一批高分
		// 记忆永远霸榜，真正这次被问到的反而挤不进来。
		const selection = selectOpeningRecall(text)
		const context: ChatMsg[] = []
		const personaText = personaPrompt()
		if (personaText) context.push({role: "system", content: personaText} as ChatMsg)
		const touchDirective = !poke && reaction
			? `${TOUCH_DIRECTIVE}\n本次触摸区域是「${areaName}」。用户希望你的反应参考：${reaction}`
			: TOUCH_DIRECTIVE
		context.push({role: "system", content: poke ? POKE_DIRECTIVE : touchDirective} as ChatMsg)
		if (!poke && area.prompt) context.push({role: "system", content: `触摸区域补充说明：${area.prompt}`} as ChatMsg)
		if (poke) {
			if (pomoPhase() !== "idle") context.push({role: "system", content: `【当前状态】用户${pomoPhaseText()}，可以轻轻回应，别催促或打断。`} as ChatMsg)
		}
		const hist = messages.value.filter(m => !m.error).slice(-14).map(({role, content, ts}) => ({role, content, ts}) as ChatMsg)
		
		const payload: ChatMsg[] = [...context, ...hist, {role: "user", content: text, ts: Date.now()}]
		if (poke) {
			messages.value.push({role: "user", content: "（戳戳）", ts: Date.now()})
			persistChat(messages.value)
			scrollChatBottom()
		}

		// 与聊天输入一致: 流式生成 + 逐句 TTS
		const ttsOn = isTtsReady(settings())
		if (ttsOn) beginSpeakSession(settings())

		touchMarkerBuf.value = "" // 新会话重置触摸的标记跨块缓冲
		touchStreaming.value = true
		let reply = ""
		let pendingSpeech = ""
		// 存储/历史合并: 一次回复只存一条消息, 显示时由 bubbleSegments 拆成多气泡
		let liveBubble: ChatMsg | null = null
		let streamOk = false
		// 本次会话是否收到过标记 (有标记 → 收尾不再用正文关键词覆盖)
		let markerDriven = false

		// 触摸触发的对话用独立 abort, 与聊天输入框的 activeChatAbort 互不干扰 (都归停止按钮管)
		stopRequested = false
		const chatAbort = new AbortController()
		activeTouchAbort = chatAbort

		const flushSpeech = () => {
			if (!ttsOn || !pendingSpeech) return
			pendingSpeech = stripInternalPromptMetadata(pendingSpeech)
			const {sentences, rest} = splitSpeechText(pendingSpeech)
			for (const s of sentences) {
				const p = s.trim()
				if (p) speakAppend(settings(), p)
			}
			pendingSpeech = rest
		}

		try {
			// 传输终态由服务自己给出; UI 回调只负责显示 (抛错不影响等待与队列释放)
			await sendChatStream(settings().baseUrl, settings().apiKey, settings().model, payload, {
				onDelta: (delta) => {
					if (delta === "null") return
					// 剥离隐藏的【表情:xxx】【动作:xxx】标记 (标记不显示、不朗读)
					const {clean, emotion, motion} = parseMarkerDelta(delta, touchMarkerBuf)
					const safeClean = stripInternalPromptMetadata(clean)
					reply = stripInternalPromptMetadata(reply + safeClean)
					pendingSpeech = stripInternalPromptMetadata(pendingSpeech + safeClean)
					flushSpeech()
					if (settings().emotionLlm && (emotion || motion)) markerDriven = true
					if (settings().emotionLlm && emotion) playMarkerEmotion(emotion)
					if (settings().emotionLlm && motion) playMarkerMotion(motion)
					// 存储合并: 只更新一条 liveBubble, 显示层自动拆多气泡
					if (!liveBubble && reply.trim()) {
						liveBubble = {role: "assistant", content: reply, ts: Date.now()}
						messages.value.push(liveBubble)
					} else if (liveBubble) {
						if (reply.trim()) liveBubble.content = reply
						else {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
					}
					if (reply.trim()) {
						showPortraitReply(reply)
						if (chatOpen.value) scrollChatBottom()
					}
				},
				onDone: (content) => {
					streamOk = true
					reply = stripInternalPromptMetadata(reply)
					// content 含标记: 优先用已剥离的 reply; reply 为空时整体剥离一次 (空缓冲)
					if (content && !reply.trim()) {
						const fresh = {value: ""}
						const {clean, emotion, motion} = parseMarkerDelta(content, fresh)
						reply = stripInternalPromptMetadata(clean)
						if (settings().emotionLlm && (emotion || motion)) markerDriven = true
						if (settings().emotionLlm && emotion) playMarkerEmotion(emotion)
						if (settings().emotionLlm && motion) playMarkerMotion(motion)
						if (!liveBubble && reply.trim()) {
							liveBubble = {role: "assistant", content: reply, ts: Date.now()}
							messages.value.push(liveBubble)
						} else if (liveBubble) {
							liveBubble.content = reply
						}
					}
					touchMarkerBuf.value = ""
					if (liveBubble) {
						if (reply.trim()) liveBubble.content = reply
						else {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
					}
					if (reply.trim()) showPortraitReply(reply)
					else portraitReply.value = ""
					persistChat(messages.value)
				},
				onError: (msg) => {
					const cancelled = stopRequested || msg === "已停止"
					if (cancelled) showPortraitReply(reply)
					if (!cancelled && !reply.trim()) {
						if (liveBubble) {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
						messages.value.push({role: "assistant", content: `⚠ ${msg}`, ts: Date.now(), error: true})
						showPortraitReply(`⚠ ${msg}`)
					} else if (liveBubble) {
						liveBubble.content = reply
					}
					persistChat(messages.value)
				},
			}, settings().deepseekThinking, chatAbort.signal, memoryChatOptions(selection, payload, settings().timeAware))

			// 收尾: 剩余文本 + 结束朗读会话
			if (ttsOn) {
				const safePendingSpeech = stripInternalPromptMetadata(pendingSpeech)
				if (safePendingSpeech.trim()) speakAppend(settings(), safePendingSpeech)
				pendingSpeech = ""
				endSpeakSession()
			}

			if (streamOk && reply) {
				// 表情/动作: 流式标记已即时驱动; 只有完全没收到标记时才用正文关键词兜底
				if (!markerDriven) {
					triggerEmotion(reply)
					pickMotionByKeyword(reply)
				}
				void analyzeAfterReply(text, reply)
			}
			// 聊天面板没开时: 用顶部小气泡显示完整回复
			if (!chatOpen.value && reply) showAiBubble(reply)
		} catch (e: any) {
			surface(`⚠ ${e?.message ?? "请求失败"}`)
		} finally {
			if (activeTouchAbort === chatAbort) activeTouchAbort = null
			touchStreaming.value = false
		}
	}

	const pokeNori = (): void => {
		if (!modelReady() || typing.value || touchStreaming.value || chatStreaming.value) return
		petAudioTouch()
		void handleTouchTrigger({name: "戳戳", prompt: "戳戳互动"}, "tap", true)
	}

	type PendingImage = Pick<ImagePickedResult, "dataUrl" | "mime" | "width" | "height" | "size">
	type PendingChat = {text: string; image?: PendingImage}
	const imagePicking = ref(false)
	const pendingImage = ref<PendingImage | null>(null)
	// 图片不进入历史/记忆；本次页面只保留最近 6 张缩略预览，避免长聊累积 base64。
	const imagePreviews = reactive(new Map<number, string>())
	const chooseImage = async (source: "album" | "camera"): Promise<void> => {
		if (imagePicking.value) return
		imageMenu.value = false
		imagePicking.value = true
		try {
			const result = source === "camera" ? await captureImage() : await pickImageFile()
			if (!result.ok || !result.dataUrl) {
				if (result.message && result.message !== "未选择图片") triggerBubble(result.message, 2200)
				return
			}
			pendingImage.value = {
				dataUrl: result.dataUrl,
				mime: result.mime,
				width: result.width,
				height: result.height,
				size: result.size,
			}
		} finally {
			imagePicking.value = false
		}
	}

	const onInputEnter = (event: KeyboardEvent): void => {
		if (event.isComposing || event.keyCode === 229) return
		void send()
	}

	/** 输入排队: 上一条还在生成 (含触摸触发的对话) 时, 新消息先进队列, 空闲后依次发出 */
	const pendingQueue = ref<PendingChat[]>([])
	let draining = false
	const drainQueue = async (): Promise<void> => {
		if (draining || typing.value || chatStreaming.value || touchStreaming.value) return
		draining = true
		try {
			while (pendingQueue.value.length && !typing.value && !chatStreaming.value && !touchStreaming.value) {
				const next = pendingQueue.value.shift()
				if (next) await runSend(next.text, next.image)
			}
		} finally {
			draining = false
		}
	}

	const bindQueueWatcher = () => watch([typing, chatStreaming, touchStreaming], () => {
		if (pendingQueue.value.length) void drainQueue()
	})

	const send = async (): Promise<void> => {
		const text = draft.value.trim()
		const image = pendingImage.value
		if (!text && !image) return
		if (!modelReady()) {
			openSettings()
			return
		}
		draft.value = ""
		pendingImage.value = null
		// 正忙时入队 (watch 会在空闲时触发 drain), 空闲时立即发送
		pendingQueue.value.push({text, image: image ?? undefined})
		await drainQueue()
	}

	const runSend = async (text: string, image?: PendingImage): Promise<void> => {
		const userText = text || (image ? "请看看这张图片" : "")
		// 朗读打断 (barge-in): 消息真正发出时才停朗读 (打字不打断);
		// stop() 会关闭朗读会话并置 aborted, 之前回复里排队未读的句子全部丢弃, 不会"复活".
		// 排队场景: 每条消息在实际发出那一刻才打断, 生成中的回复会先读完
		ambientTouch()
		habitRecord("msg")
		stopTTS()
		const imagePart: ChatMsg["parts"] = image?.dataUrl ? [{type: "text", text: userText}, {type: "image_url", image_url: {url: image.dataUrl}}] : undefined
		const userMessage: ChatMsg = {role: "user", content: imagePart ? (text ? `[图片] ${text}` : "[图片]") : userText, ts: Date.now()}
		messages.value.push(userMessage)
		if (image?.dataUrl) {
			imagePreviews.set(userMessage.ts, image.dataUrl)
			while (imagePreviews.size > 6) imagePreviews.delete(imagePreviews.keys().next().value!)
		}
		persistChat(messages.value)
		scrollChatBottom()

		typing.value = true
		showPortraitReply("…")
		stopRequested = false
		const chatAbort = new AbortController()
		activeChatAbort = chatAbort
		try {
			// 记忆系统: 按当前消息召回长期记忆 + 读取历史总结, 注入上下文
			// smartRecall 开 → LLM 语义召回 (更准); 关 → 关键词召回 (免费快)
			const smartEnabled = settings().smartRecall && settings().apiKey.trim() && settings().model.trim() && !shouldSkipLlmExtract(userText)
			const selection = await selectRecallWithinBudget(userText, smartEnabled ? async (prompt, signal) => {
				const r = await sendChat(settings().baseUrl, settings().apiKey, settings().model, [{role: "system", content: prompt} as ChatMsg], false, {signal})
				if (!r.ok) throw new Error(r.message ?? "召回失败")
				return r.content ?? ""
			} : null, RECALL_BUDGET_MS, chatAbort.signal, messages.value.slice(-7, -1))
			if (chatAbort.signal.aborted) return
			const context: ChatMsg[] = []
			const personaText = personaPrompt()
			if (personaText) context.push({role: "system", content: personaText} as ChatMsg)
			// 专注数据: 三个闸门都过才注入 (话题相关 + 有值得说的 + 今天还没提过)。
			// 刻意做成"回复内提一句"而不是 Ambient 主动搭话 —— 后者每次会话只有 3 条预算,
			// 用去报数字就把陪伴变成打卡提醒了。注入文本自带"最多提这一件事"的克制约束,
			// 因为 persona 已反复强调 2~3 句上限 (不去放宽那条规则)。
			if (focusHintFresh()) {
				const fh = buildFocusHint(pomoSummary(), userText, celebrated() ?? {})
				if (fh.hint) {
					context.push({role: "system", content: fh.hint} as ChatMsg)
					markFocusHinted()
					if (fh.milestoneKey) markCelebrated(fh.milestoneKey)
				}
			}
			const hist: ChatMsg[] = contextHistory(messages.value).map(({role, content, ts}) => ({role, content, ts}))
			// 只给本次用户消息附图；后续对话继续使用纯文字历史。
			if (imagePart) hist[hist.length - 1] = {...userMessage, parts: imagePart}
			// 当前时间由发送层在实际发出请求时追加。
			const payload = [...context, ...hist]

			// 流式 TTS: 启用时开"逐句朗读会话", 边生成边出音
			const ttsOn = isTtsReady(settings())
			if (ttsOn) beginSpeakSession(settings())

			chatMarkerBuf.value = "" // 新会话重置聊天标记跨块缓冲
			let reply = ""
			let pendingSpeech = ""
			// 本次会话是否收到过标记 (有标记 → 收尾不再用正文关键词覆盖; 无标记 → 关键词兜底)
			let markerDriven = false
			// 存储/历史合并: 一次回复只存一条消息, 显示时由 bubbleSegments 拆成多气泡
			let liveBubble: ChatMsg | null = null
			let streamOk = false
			chatStreaming.value = true

			// 停止生成: 本地 AbortController (即使原生桥丢弃回包也能正常结束) + 原生桥 chatStop

			// 滚动节流: 长回复时避免每增量都滚动 (仅近底部才滚, 150ms 限频)
			let lastScrollAt = 0
			let scrollTimer: ReturnType<typeof setTimeout> | null = null
			const throttledScroll = () => {
				const el = chatScrollElement()
				if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 120) return
				const now = Date.now()
				if (now - lastScrollAt > 150) {
					lastScrollAt = now
					scrollChatBottom()
				} else if (!scrollTimer) {
					scrollTimer = setTimeout(() => {
						scrollTimer = null
						lastScrollAt = Date.now()
						scrollChatBottom()
					}, 150)
				}
			}

			// 把累积的文本按句子边界切出来, 逐句追加朗读 (只在安全边界切, 不切词)
			const flushSpeech = () => {
				if (!ttsOn || !pendingSpeech) return
				pendingSpeech = stripInternalPromptMetadata(pendingSpeech)
				const {sentences, rest} = splitSpeechText(pendingSpeech)
				for (const s of sentences) {
					const p = s.trim()
					if (p) speakAppend(settings(), p)
				}
				pendingSpeech = rest
			}

			// 传输终态由服务自己给出; UI 回调只负责显示 (抛错不影响等待与队列释放)
			await sendChatStream(settings().baseUrl, settings().apiKey, settings().model, payload, {
					onDelta: (delta) => {
						// 防御: 个别代理会把 null 当字符串下发, 直接跳过
						if (delta === "null") return
						// 剥离隐藏的【表情:xxx】【动作:xxx】标记 (标记不显示、不朗读)
						const {clean, emotion, motion} = parseMarkerDelta(delta, chatMarkerBuf)
						const safeClean = stripInternalPromptMetadata(clean)
						reply = stripInternalPromptMetadata(reply + safeClean)
						pendingSpeech = stripInternalPromptMetadata(pendingSpeech + safeClean)
						flushSpeech()
						if (settings().emotionLlm && (emotion || motion)) markerDriven = true
						if (settings().emotionLlm && emotion) playMarkerEmotion(emotion)
						if (settings().emotionLlm && motion) playMarkerMotion(motion)
						// 存储合并: 只更新一条 liveBubble, 显示层自动拆多气泡
						if (!liveBubble && reply.trim()) {
							liveBubble = {role: "assistant", content: reply, ts: Date.now()}
							messages.value.push(liveBubble)
						} else if (liveBubble) {
							if (reply.trim()) liveBubble.content = reply
							else {
								const idx = messages.value.indexOf(liveBubble)
								if (idx >= 0) messages.value.splice(idx, 1)
								liveBubble = null
							}
						}
						if (reply.trim()) {
							showPortraitReply(reply)
							throttledScroll()
						}
					},
					onDone: (content) => {
						streamOk = true
						chatStreaming.value = false
						reply = stripInternalPromptMetadata(reply)
						// content 是含标记的全文: 优先用流式累积的已剥离 reply;
						// 若 reply 为空 (如非流式回退), 则对 content 整体剥离一次 (用空缓冲, 避免残留拼接)
						if (content && !reply.trim()) {
							const fresh = {value: ""}
							const {clean, emotion, motion} = parseMarkerDelta(content, fresh)
							reply = stripInternalPromptMetadata(clean)
							if (settings().emotionLlm && (emotion || motion)) markerDriven = true
							if (settings().emotionLlm && emotion) playMarkerEmotion(emotion)
							if (settings().emotionLlm && motion) playMarkerMotion(motion)
							// 非流式回退: 整体内容作为一条消息 (显示层自动拆多气泡)
							if (!liveBubble && reply.trim()) {
								liveBubble = {role: "assistant", content: reply, ts: Date.now()}
								messages.value.push(liveBubble)
							} else if (liveBubble) {
								liveBubble.content = reply
							}
						}
						// 兜底: 流式路径若仍有残留未闭合的【(缓冲里), 说明标记不完整, 丢弃不显示
						chatMarkerBuf.value = ""
						if (liveBubble) {
							if (reply.trim()) liveBubble.content = reply
							else {
								const idx = messages.value.indexOf(liveBubble)
								if (idx >= 0) messages.value.splice(idx, 1)
								liveBubble = null
							}
						}
						if (reply.trim()) showPortraitReply(reply)
						else portraitReply.value = ""
						persistChat(messages.value)
					},
					onError: (msg) => {
						chatStreaming.value = false
						// 用户主动停止: 不显示错误气泡; 其他失败且无内容时显示
						const cancelled = stopRequested || msg === "已停止"
						if (cancelled) showPortraitReply(reply)
						if (!cancelled && !reply.trim()) {
							if (liveBubble) {
								const idx = messages.value.indexOf(liveBubble)
								if (idx >= 0) messages.value.splice(idx, 1)
								liveBubble = null
							}
							messages.value.push({role: "assistant", content: `⚠ ${msg}`, ts: Date.now(), error: true})
							showPortraitReply(`⚠ ${msg}`)
						} else if (liveBubble) {
							// 已收到部分内容: 保留为一条消息
							liveBubble.content = reply
						}
						persistChat(messages.value)
					},
				}, settings().deepseekThinking, chatAbort.signal, memoryChatOptions(selection, payload, settings().timeAware))
			if (activeChatAbort === chatAbort) activeChatAbort = null
			if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null }

			// 收尾: 剩余未成句的文本 + 结束朗读会话
			if (ttsOn) {
				const safePendingSpeech = stripInternalPromptMetadata(pendingSpeech)
				if (safePendingSpeech.trim()) speakAppend(settings(), safePendingSpeech)
				pendingSpeech = ""
				endSpeakSession()
			}

			typing.value = false
			scrollChatBottom()

			if (streamOk && reply) {
				// 表情/动作: 流式标记已即时驱动; 只有本次会话完全没收到标记时才用正文关键词兜底
				if (!markerDriven) {
					triggerEmotion(reply)
					pickMotionByKeyword(reply)
				}
				// 记忆提取: 规则法免费 + LLM 可选增强 (表情分析已并入主回复标记, 不再单独调用)
				void analyzeAfterReply(userText, reply)
				// 记忆系统: 历史过长时生成摘要 (用带标点的原文压缩, 质量更好)
				void (async () => {
					const summarized = await summarizeIfNeeded(messages.value, async (prompt) => {
						const r = await sendChat(settings().baseUrl, settings().apiKey, settings().model, [
							{role: "system", content: prompt} as ChatMsg,
						])
						return r.ok ? (r.content ?? "") : ""
					}, !!settings().memoryLlmExtract)
					maybeAutoTuneExamples()   // 自动优化 (开关打开时): 新增够 20 条就顺手刷新示例
					// 开启「自动裁剪」时: 只裁**已经进过摘要的那段前缀** (P5: safeTrimDrop 保证
					// 不会把还没总结的消息删掉 —— 删掉就永远进不了记忆了), 近端窗口照旧保留。
					const dropN = summarized && settings().trimHistory ? safeTrimDrop(messages.value.length) : 0
					if (dropN > 0 && bufferDiarySource(messages.value.slice(0, dropN))) {
						// 日记素材保存成功后才能裁剪；失败时保留原对话。
						// 占位符仍每次都新建, 但聊天存储侧会去重 (filterChatMsgs 只留第一条 /
						// mergeChatLists 对占位符查重) —— 所以它不会在磁盘上越积越多。
						// 不要在这里"复用旧占位符": 它的 ts 低于已设的 cutoff, 重载时照样会被丢掉。
						const kept = messages.value.slice(dropN)
						kept.unshift({role: "system", content: "（更早的对话已压缩为历史总结，可在设置→记忆系统查看）", ts: Date.now(), placeholder: true})
						// 通知聊天存储裁剪边界: 落盘归并时不再把被裁掉的旧消息并回来
						const firstReal = kept.find(m => m.role !== "system")
						if (firstReal) setChatTrimCutoff(firstReal.ts)
						messages.value = kept
						persistChat(messages.value)
						// 登记被裁掉的条数 (P5): 游标靠"累计已摘要 - 累计已裁剪"换算成数组下标,
						// 不再像旧实现那样谎称"保留的都已摘要" (那会让近端 20 条永远不被总结)
						notifyHistoryTrimmed(dropN)
						scrollChatBottom()
					}
				})().catch(e => { console.error("[mem] 后台整理失败", e); refreshMemView() })
			}
		} finally {
			if (activeChatAbort === chatAbort) activeChatAbort = null
			typing.value = false
			scrollChatBottom()
		}
	}

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))


	const splitReplies = (reply: string): string[] => {
		const lines = reply.split(/\n+/).map((s) => s.trim()).filter((s) => s)
		if (lines.length >= 2) return lines.map((s) => s.replace(/[。！？!?^~，,]+$/g, ""))
		return [reply.trim()]
	}

	return {
		draft, typing, chatStreaming, touchStreaming, messages,
		imagePicking, pendingImage, imagePreviews, pendingQueue,
		chooseImage, onInputEnter, send, stopGenerate, handleTouchTrigger, pokeNori, bindQueueWatcher,
	}
}
