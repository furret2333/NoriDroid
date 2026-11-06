import {ref, watch} from "vue"
import {isTtsReady, speak as speakTTS, onSpeakingChange} from "../services/tts"
import {setBgmDucking} from "../services/bgm"
import {maybePetSpeechLine} from "../services/live2d/petSpeech"
import type {AppSettings} from "./useAppSettings"

export interface SpeechFeedbackOptions {
	settings: () => AppSettings
	typing: () => boolean
	chatStreaming: () => boolean
	touchStreaming: () => boolean
	chatOpen: () => boolean
	panel: () => string
	updateTouchReplyPreview: (text: string) => void
}

/** Presentation state shared by chat replies, local side lines and pet speech.
 * Late App state is read through getters; registration and cleanup stay explicit.
 */
export const useSpeechFeedback = (options: SpeechFeedbackOptions) => {
	const touchBubble = ref("")
	let touchBubbleTimer: ReturnType<typeof setTimeout> | null = null
	const speaking = ref(false)

	const triggerBubble = (msg: string, ms = 2000) => {
		touchBubble.value = msg
		if (touchBubbleTimer) clearTimeout(touchBubbleTimer)
		touchBubbleTimer = setTimeout(() => { touchBubble.value = "" }, ms)
	}




	const aiBubble = ref("")
	let aiBubbleTimer: ReturnType<typeof setTimeout> | null = null

	// 竖屏回复独立于历史展开状态；只保存本次展示，不改聊天持久化。
	const portraitReply = ref("")
	let portraitReplyTimer: ReturnType<typeof setTimeout> | null = null
	const clearPortraitReplyTimer = (): void => {
		if (portraitReplyTimer) clearTimeout(portraitReplyTimer)
		portraitReplyTimer = null
	}
	const schedulePortraitReplyClear = (ms?: number): void => {
		clearPortraitReplyTimer()
		if (!portraitReply.value || options.typing() || options.chatStreaming() || options.touchStreaming() || speaking.value) return
		portraitReplyTimer = setTimeout(() => {
			portraitReply.value = ""
			portraitReplyTimer = null
		}, ms ?? Math.min(16000, Math.max(9000, portraitReply.value.length * 80)))
	}
	const showPortraitReply = (text: string, ms?: number): void => {
		portraitReply.value = text
		if (options.touchStreaming() && options.panel() === "touch") options.updateTouchReplyPreview(text)
		schedulePortraitReplyClear(ms)
	}

	/** 展示一条 "Nori 说话" 气泡。
	 *  `ms` 默认 9s（AI 回复 / ambient 搭话沿用原行为）。
	 *  摸头台词传更长的值：它的收尾自己做（说完即收 + 兜底），**必须**保证这里的定时器
	 *  不会更早把字抹掉（否则"她还没说完，字就没了"）。 */
	const showAiBubble = (t: string, ms = 9000) => {
		aiBubble.value = t
		showPortraitReply(t, ms)
		if (aiBubbleTimer) clearTimeout(aiBubbleTimer)
		aiBubbleTimer = setTimeout(() => { aiBubble.value = "" }, ms)
	}

	/* ---------------- 摸头台词 (TTS) ----------------
	 * 规格（用户定）: 摸到头 → 从 10 句语料里随机说一句；**10s 内只说一次**；只有摸到头才说。
	 * 窗口锚在"**上一次真的说了话**"（首次摸头必定说），台词表/窗口/洗牌袋都在
	 * `services/live2d/petSpeech.ts`（纯逻辑，有门禁）；这里只管"该不该开口"与呈现。
	 *
	 * 呈现: 复用 AI 那套气泡 `.ai-bubble`（自带 `● Nori` 说话人标签 —— 那就是"她开口了"的既有视觉语言），
	 *      **开口出现、说完即收**（跟 `speaking` 的 true→false 边沿 —— `speak()` 是单发朗读，
	 *      所以"她在说的就是这一句"）。另挂一个 7s 兜底: TTS 失败/无声时 audio 永远不会 playing，
	 *      否则气泡会一直挂在那。
	 * 不进聊天记录: 与 ambient 搭话同规格（本地语料不写历史、不进记忆/摘要）。
	 *
	 * ## 两个"看起来像边角、其实会真的发生"的坑（都在这里处理）
	 * 1. **兜底 7s 可能比"她说完"还早**：TTS 首音要 1~3s，最长一句 23 字又要 5s 左右
	 *    ⇒ 文字会比声音先消失。所以到点时**只要还在说就续期**（最多续 3 次，绝对上限 22s，
	 *    防"playing 卡住"时气泡永不消失）。
	 * 2. **`speaking=false` 不等于"说完了"**：流式播放中间会有真的静默（句间 / WebAudio 回退
	 *    逐块播 / 网络卡一下），`player` 那时确实会把 playing 置回 false。所以
	 *    ① "说完即收"要**等一个 VOICE_TAIL 再确认**；② 闸门也要把"刚静下来 < VOICE_TAIL"当成"还在说"
	 *    —— 否则那一下的摸头会 `speak()` 打断 Nori 说到一半的回复。
	 */
	/** 气泡兜底时长: 真出声时由"说完即收"提前收掉, 这个只是无声/失败时的保险 */
	const PET_LINE_BUBBLE_FALLBACK_MS = 7000
	/** 兜底到点但**还在说**时的续期步长（见文件头坑 1） */
	const PET_LINE_BUBBLE_EXTEND_MS = 5000
	/** 续期次数上限（绝对上限 = 7s + 3×5s = 22s）—— 防 playing 卡住时气泡永不消失 */
	const PET_LINE_BUBBLE_MAX_EXTEND = 3
	/** 摸头台词的**绝对存活上限**（兜底 + 全部续期） */
	const PET_LINE_BUBBLE_MAX_TOTAL_MS = PET_LINE_BUBBLE_FALLBACK_MS + PET_LINE_BUBBLE_EXTEND_MS * PET_LINE_BUBBLE_MAX_EXTEND
	/** "她刚还在出声"的判定余量（见文件头坑 2）: 流式播放中间的静默不超过它就算"还在说" */
	const PET_LINE_VOICE_TAIL_MS = 700
	/** 当前气泡里是不是摸头台词（与 `aiBubble` 内容比对, 避免误清掉别人的气泡） */
	let petLineBubble = ""
	/** 这条台词是否**真的**推进到过 playing —— 没出过声就不等"说完", 交给兜底 */
	let petLineSpoke = false
	let petLineBubbleTimer: ReturnType<typeof setTimeout> | null = null
	let petLineExtend = 0
	/** 最近一次**确实在出声**的时刻（`Date.now()`）—— "她还在说"用它判, 不用 speaking 的瞬时值 */
	let lastVoiceAt = 0
	/** "说完即收"的确认定时器（等一个 VOICE_TAIL 再收, 见文件头坑 2） */
	let petLineVoiceTailTimer: ReturnType<typeof setTimeout> | null = null

	const clearPetLineBubble = (): void => {
		if (petLineBubbleTimer) { clearTimeout(petLineBubbleTimer); petLineBubbleTimer = null }
		if (petLineVoiceTailTimer) { clearTimeout(petLineVoiceTailTimer); petLineVoiceTailTimer = null }
		if (petLineBubble && aiBubble.value === petLineBubble) aiBubble.value = ""
		if (petLineBubble && portraitReply.value === petLineBubble) {
			clearPortraitReplyTimer()
			portraitReply.value = ""
		}
		petLineBubble = ""
		petLineSpoke = false
		petLineExtend = 0
	}

	/** 兜底到点：还在说就续期，否则收掉（见文件头坑 1） */
	const petLineFallback = (): void => {
		petLineBubbleTimer = null
		if (speaking.value && petLineExtend < PET_LINE_BUBBLE_MAX_EXTEND) {
			petLineExtend += 1
			petLineBubbleTimer = setTimeout(petLineFallback, PET_LINE_BUBBLE_EXTEND_MS)
			return
		}
		clearPetLineBubble()
	}

	/**
	 * 摸头时尝试说一句。**只在两处"确认摸到头"的边沿调用**（与 `petAudioTouch()` 同源）。
	 * 三道闸: ① TTS 就绪 ② 不在朗读/生成中（跳过且**不消耗**窗口） ③ 10s 窗口。
	 */
	const maybeSpeakPetLine = (): void => {
		// ① 没配 TTS 就不说，且**不消耗窗口** —— 配好 Key 后第一次摸头照样能听到
		if (!isTtsReady(options.settings())) return
		// ② "还在说" = speaking 为真 **或** 刚静下来不到 VOICE_TAIL（流式播放中间的静默, 见文件头坑 2），
		//    再加上"正在生成回复 / 正在打字" → 一律**跳过、不打断**，且**不消耗**窗口
		//    （回复说完后再摸一次就能听到，台词不会白丢）
		if (speaking.value || Date.now() - lastVoiceAt < PET_LINE_VOICE_TAIL_MS) return
		if (options.chatStreaming() || options.touchStreaming() || options.typing()) return
		const line = maybePetSpeechLine(performance.now())
		if (!line) return
		// ③ 呈现: 聊天面板开着时**只出声不弹气泡** —— `.ai-bubble` 的 z-index(58) 高于面板(12),
		//    硬弹会盖在聊天内容上（与 ambient 的 `if (!options.chatOpen())` 同一写法）
		if (!options.chatOpen()) {
			petLineBubble = line
			petLineSpoke = false
			petLineExtend = 0
			/* 给 `showAiBubble` 一个**比我们的绝对上限还长**的时长: 它自带的定时器只负责
			   "别用默认的 9s 提前抹掉", 真正的收尾交给 petLineFallback / 说完即收。
			   （原来 9s 那个值会在这句还没说完时就把字清掉 —— 长句 + 首音慢时真会发生。） */
			showAiBubble(line, PET_LINE_BUBBLE_MAX_TOTAL_MS + 1000)
			if (petLineBubbleTimer) clearTimeout(petLineBubbleTimer)
			petLineBubbleTimer = setTimeout(petLineFallback, PET_LINE_BUBBLE_FALLBACK_MS)
		}
		// 单发朗读（内部会打断上一段 TTS; 前面已保证不在朗读中，所以不会切到别人）
		void speakTTS(options.settings(), line).catch(() => { /* 失败已由 setTtsErrorHandler 提示 */ })
	}


	const speakSideLine = (line: string): void => {
		if (!isTtsReady(options.settings())) return
		if (speaking.value || Date.now() - lastVoiceAt < PET_LINE_VOICE_TAIL_MS) return
		if (options.chatStreaming() || options.touchStreaming() || options.typing()) return
		void speakTTS(options.settings(), line).catch(() => { /* 失败已由 setTtsErrorHandler 提示 */ })
	}

	const registerSpeakingHandler = (): void => {
		onSpeakingChange((playing) => {
			speaking.value = playing
			// TTS 闪避: Nori 开口朗读时背景音乐自动压低到 20%, 说完恢复
			setBgmDucking(playing)
			/* 摸头台词的气泡"说完即收" —— ⚠ `onSpeakingChange` 是**单槽赋值**
			   （`player.onStateChange = cb`）, 所以这段必须写在这个**已有**的回调里,
			   另起一次 `onSpeakingChange(...)` 会把上面的"停止朗读按钮 + BGM 闪避"整个覆盖掉。 */
			if (petLineVoiceTailTimer) { clearTimeout(petLineVoiceTailTimer); petLineVoiceTailTimer = null }
			if (playing) {
				lastVoiceAt = Date.now()
				if (petLineBubble) petLineSpoke = true
				return
			}
			// 只有"确实开过口"才收; 一直没出声(TTS 失败)交给 7s 兜底定时器
			if (!petLineBubble || !petLineSpoke) return
			/* ⚠ 不能立刻收: `speaking=false` 未必是"说完了" —— 流式播放中间的静默
			   （句间 / WebAudio 回退逐块播 / 网络卡一下）也会把它置回 false,
			   立刻收会把气泡在"说到一半"时抹掉。等一个 VOICE_TAIL 再确认一次静默。 */
			petLineVoiceTailTimer = setTimeout(() => {
				petLineVoiceTailTimer = null
				if (!speaking.value && Date.now() - lastVoiceAt >= PET_LINE_VOICE_TAIL_MS) clearPetLineBubble()
			}, PET_LINE_VOICE_TAIL_MS)
		})
	}

	/** Call at the original App watcher registration point, after stream refs exist. */
	const bindReplyWatcher = () => watch([
		options.typing, options.chatStreaming, options.touchStreaming, speaking,
	], () => schedulePortraitReplyClear())

	/** Preserve App's early portrait/AI timer cleanup point. */
	const clearReplyTimers = (): void => {
		clearPortraitReplyTimer()
		if (aiBubbleTimer) clearTimeout(aiBubbleTimer)
	}
	/** Preserve App's later touch notification timer cleanup point. */
	const clearTouchBubbleTimer = (): void => {
		if (touchBubbleTimer) clearTimeout(touchBubbleTimer)
	}

	return {
		touchBubble, aiBubble, portraitReply, speaking,
		triggerBubble, showAiBubble, showPortraitReply, clearPortraitReplyTimer,
		schedulePortraitReplyClear, maybeSpeakPetLine, clearPetLineBubble, speakSideLine,
		registerSpeakingHandler, bindReplyWatcher, clearReplyTimers, clearTouchBubbleTimer,
	}
}
