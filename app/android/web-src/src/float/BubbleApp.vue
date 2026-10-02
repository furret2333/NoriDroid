<script setup lang="ts">
/**
 * 悬浮窗聊天气泡 (FloatBubbleActivity 承载): 输入 + 回复 + TTS + 记忆.
 * 布局 (用户设计): 回复文字在顶部 (对话框顶部伸进悬浮窗底部留白, 纯展示不交互),
 * 输入框在底部 (悬浮窗下方 → 可点击, 键盘弹出).
 * 交互: 拖动把手/双指缩放由**原生**处理 (rawX 屏幕绝对坐标, 不受窗口移动影响),
 * 本页只上报把手位置 + 锁定状态; ✕ 短按锁定/长按退出.
 * 点 Nori 不会碰到本窗口, 不会弹键盘. 悬浮窗零改动 → Nori 永不透明.
 * 注意: 回复区必须始终占位 (flex:1), 否则输入行会被 flex 顶到窗口顶部
 * (伸进悬浮窗的区域) → 被悬浮窗盖住 → 键盘打不开.
 * 记忆/总结: 与主 App 共用同一份 chat.json / memory 库 —— 剥离表情标记、
 * 追加历史、写长期记忆、生成历史总结, 悬浮窗对话与主 App 无缝衔接.
 */
import {nextTick, onBeforeUnmount, onMounted, ref, watch} from "vue"
import {
	loadSettings, sendChat, sendChatStream, loadChat, persistChat, flushChatPersist, setChatTrimCutoff,
	type ChatMsg, type Settings, personaPrompt, localTimeBlock,
} from "../services/chat"
import {parseMarkerDelta} from "../services/chat/markers"
import {
	extractMemoriesSmart,
	recallForQuery, recallForQuerySmart, summaryBlock, summarizeIfNeeded, flushMemoryPersist,
	notifyHistoryTrimmed, contextHistory, safeTrimDrop, recentTopicsBlock,
	goalCarePrompt, shouldSkipLlmExtract, setDiagEnabled,
} from "../services/memory"
import {bufferDiarySource} from "../services/nori-diary"
import {
	beginSpeakSession, speakAppend, endSpeakSession, isTtsReady, onSpeakingChange,
	stop as stopTts,
} from "../services/tts"
import {splitSpeechText} from "../services/tts"

const draft = ref("")
const replyText = ref("")
const busy = ref(false)
const typing = ref(false)
const bubbleW = ref(82)
/** 语义召回预算 (ms): 与主 App 同策略 */
const RECALL_BUDGET_MS = 1200
/** 生成中的取消控制器 (停止按钮用) */
let activeAbort: AbortController | null = null
const stopGenerate = (): void => {
	if (activeAbort) {
		activeAbort.abort()
		activeAbort = null
	}
	stopTts()
}
/** "记住了"迷你提示 (回复区下方, 自动消失) */
const memTip = ref("")
let memTipTimer: ReturnType<typeof setTimeout> | null = null
const showMemTip = (t: string) => {
	memTip.value = t
	if (memTipTimer) clearTimeout(memTipTimer)
	memTipTimer = setTimeout(() => { memTip.value = "" }, 2600)
}
/** 锁定: 固定窗口位置/大小 (原生拖动/缩放失效), ✕ 短按切换, 长按退出 */
const locked = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const replyEl = ref<HTMLDivElement | null>(null)
const handleEl = ref<HTMLDivElement | null>(null)

type BubbleBridge = {
	closeFloatBubble?: () => void
	playFloatMarker?: (emotion: string, motion: string) => void
	playFloatByText?: (text: string) => void
}
type BubbleWindowBridge = {
	setHandleRect?: (l: number, t: number, r: number, b: number) => void
	setLocked?: (l: boolean) => void
}
const bubbleBridge = () => (window as unknown as {NoriChat?: BubbleBridge}).NoriChat
const winBridge = () => (window as unknown as {BubbleWindow?: BubbleWindowBridge}).BubbleWindow

/** 上报把手区域 (转成物理像素, 与原生 rawX/rawY 同一单位; 相对窗口左上角) */
const reportHandleRect = () => {
	try {
		const el = handleEl.value
		if (!el) return
		const r = el.getBoundingClientRect()
		const dpr = window.devicePixelRatio || 1
		winBridge()?.setHandleRect?.(
			Math.round(r.left * dpr), Math.round(r.top * dpr),
			Math.round(r.right * dpr), Math.round(r.bottom * dpr)
		)
	} catch { /* 忽略 */ }
}

// ---------------- ✕: 短按锁定 / 长按退出 ----------------
let closeTimer: number | undefined
const onCloseStart = (e: TouchEvent) => {
	e.preventDefault()
	closeTimer = window.setTimeout(() => {
		closeTimer = undefined
		closeBubble() // 长按 600ms → 退出对话框
	}, 600)
}
const onCloseEnd = () => {
	if (closeTimer) {
		clearTimeout(closeTimer)
		closeTimer = undefined
		locked.value = !locked.value // 短按 → 切换锁定 (再按解锁)
		winBridge()?.setLocked?.(locked.value)
	}
}

// 回复内容变化时自动滚到底部, 新文字始终可见 (贴在输入框上方)
watch(replyText, () => {
	nextTick(() => {
		const el = replyEl.value
		if (el) el.scrollTop = el.scrollHeight
	})
})

/** 窗口缩放后把手位置会变 → 重新上报 (具名 + onBeforeUnmount 解绑:
 *  原先用匿名箭头函数, 无法移除, 每次挂载都累积一个监听器) */
const onWinResize = (): void => {
	setTimeout(reportHandleRect, 100)
}

onMounted(() => {
	// 气泡宽度: 读主 App 设置 (回复文字最大宽度)
	try {
		const s = loadSettings()
		bubbleW.value = Number(s.floatBubbleW) || 82
		// 记忆诊断日志 (P1): 悬浮窗里也会整理历史, 开关要跟主界面一致
		setDiagEnabled(s.memoryDiagnostics === true)
	} catch { /* 忽略 */ }
	// TTS 状态 (显示正在朗读)
	onSpeakingChange((p) => { typing.value = p })
	// 上报把手区域: 等布局稳定后 (原生据此识别拖动起点)
	nextTick(reportHandleRect)
	setTimeout(reportHandleRect, 300)
	window.addEventListener("resize", onWinResize)
})

/** 点气泡空白处 → 聚焦输入框 → 键盘弹出 */
const focusInput = () => inputEl.value?.focus()

/** 关闭气泡 (Activity) */
const closeBubble = () => {
	try {
		bubbleBridge()?.closeFloatBubble?.()
	} catch { /* 忽略 */ }
}

/**
 * 记忆写入 (与主界面同一套: Mem0 两段式) —— 规则免费兜底 + AI 提取事实 + AI 决策入库.
 * @param recentContext 最近对话 (仅供 AI 理解指代)
 * @returns 提示文本 (如"记住了:小明") 或 ""
 */
const doMemExtract = async (text: string, s: Settings, recentContext: {role: string; content: string}[] = []): Promise<string> => {
	try {
		// 实时(逐句)通道默认关 (重构 P3): 记忆由 summarizeIfNeeded 一次产出 (见下方调用点)
		if (s.memoryRealtimeExtract !== true) return ""
		const llmOk = !!s.memoryLlmExtract && !!s.apiKey.trim() && !!s.model.trim()
		const res = await extractMemoriesSmart(
			text,
			llmOk
				? async (prompt: string): Promise<string> => {
					const r = await sendChat(s.baseUrl, s.apiKey, s.model, [
						{role: "system", content: prompt} as ChatMsg,
					])
					return r.ok ? (r.content ?? "") : ""
				}
				: null,
			recentContext,
		)
		return res.tips.length ? `记住了：${res.tips.join("、")}` : ""
	} catch (e) {
		console.error("[mem] extractMemoriesSmart failed:", e)
		return ""
	}
}

/** 发送并流式对话 (与主 App 同库: 剥离标记、写记忆、生成总结、保存历史) */
const send = async () => {	const text = draft.value.trim()
	if (!text || busy.value) return
	draft.value = ""
	busy.value = true
	// 朗读打断: 消息真正发出时才停朗读 (打字不打断); stop 后排队的句子不会复活
	stopTts()
	// 本地取消 (停止按钮用): 即使原生桥丢弃过期回包也能正常结束
	const ac = new AbortController()
	activeAbort = ac
	replyText.value = ""
	try {
		const s = loadSettings()
		if (!s.apiKey.trim() || !s.model.trim()) {
			replyText.value = "请先在主 App 配置 API Key 和模型"
			return
		}
		// 共享历史: 主 App 与悬浮窗同一份 chat.json, 悬浮窗对话也进历史/总结。
		// P5: 原文窗口 = 近端 20 条 + 一整个待总结批次 (空窗清零), 与主界面同一规则
		const history = contextHistory(loadChat())
		// 记忆系统: 召回长期记忆 + 历史总结, 注入上下文 (smartRecall 开 → LLM 语义召回).
		// 发送延迟优化: 语义召回只等预算期, 超时先用关键词兜底发送, 迟到结果后台自行收尾
		let memoryBlock = ""
		const llmRecallCall = async (prompt: string): Promise<string> => {
			const r = await sendChat(s.baseUrl, s.apiKey, s.model, [
				{role: "system", content: prompt} as ChatMsg,
			])
			return r.ok ? (r.content ?? "") : ""
		}
		if (s.smartRecall && !shouldSkipLlmExtract(text)) {
			const smart = recallForQuerySmart(text, llmRecallCall).catch(() => "")
			const fast = new Promise<string>((resolve) =>
				setTimeout(() => resolve(recallForQuery(text)), RECALL_BUDGET_MS)
			)
			memoryBlock = await Promise.race([smart, fast])
			void smart.catch(() => { /* 已兜底, 后台自行收尾 */ })
		} else {
			memoryBlock = recallForQuery(text)
		}
		const summary = summaryBlock()
		const context: ChatMsg[] = []
		const personaText = personaPrompt()
		if (personaText) context.push({role: "system", content: personaText} as ChatMsg)
		if (summary) context.push({role: "system", content: summary} as ChatMsg)
		if (memoryBlock) context.push({role: "system", content: memoryBlock} as ChatMsg)
		// 近况注入 (P5): 最近聊过的话题 (与主界面同一规则; 摘要不重复注入)
		const recentTopics = recentTopicsBlock()
		if (recentTopics) context.push({role: "system", content: recentTopics} as ChatMsg)
		// 目标陪伴: 有超过 3 天没被关心的目标时注入提示, 让 Nori 自然地问问进展
		const goalCare = goalCarePrompt()
		if (goalCare) context.push({role: "system", content: goalCare} as ChatMsg)
		// 当前时间（2026-10-01）: 与主界面同一规则 —— 放在人格/记忆等 system 块**之后**（不伤提示词缓存）
		if (s.timeAware !== false) context.push({role: "system", content: localTimeBlock()} as ChatMsg)
		const payload: ChatMsg[] = [...context, ...history, {role: "user", content: text, ts: Date.now()}]

		const ttsOn = isTtsReady(s)
		if (ttsOn) beginSpeakSession(s)

		// 剥离隐藏的【表情:xxx】【动作:xxx】标记 (标记不显示、不朗读、不写记忆)
		const markerBuf = {value: ""}
		let reply = ""
		let pendingSpeech = ""
		let streamOk = false
		// 本次会话是否收到过表演标记 (有 → 已驱动; 无 → 回复完成后正文关键词兜底)
		let markerSeen = false
		const flushSpeech = () => {
			if (!ttsOn || !pendingSpeech) return
			const {sentences, rest} = splitSpeechText(pendingSpeech)
			for (const p of sentences) if (p.trim()) speakAppend(s, p.trim())
			pendingSpeech = rest
		}

		await new Promise<void>((resolve) => {
			sendChatStream(s.baseUrl, s.apiKey, s.model, payload, {
				onDelta: (delta) => {
					if (delta === "null") return
					const {clean, emotion, motion} = parseMarkerDelta(delta, markerBuf)
					reply += clean
					pendingSpeech += clean
					flushSpeech()
					// 标记驱动悬浮窗 Nori 表演 (与主 App 同规则映射)
					if (emotion || motion) {
						markerSeen = true
						try { bubbleBridge()?.playFloatMarker?.(emotion ?? "", motion ?? "") } catch { /* 忽略 */ }
					}
					replyText.value = reply
				},
				onDone: (content) => {
					streamOk = true
					if (ttsOn) {
						if (pendingSpeech.trim()) speakAppend(s, pendingSpeech)
						endSpeakSession()
					}
					// content 是含标记的全文: 若流式累积为空 (非流式回退), 整体剥离一次
					if (content && !reply.trim()) {
						const fresh = {value: ""}
						const {clean, emotion, motion} = parseMarkerDelta(content, fresh)
						reply = clean
						if (emotion || motion) {
							markerSeen = true
							try { bubbleBridge()?.playFloatMarker?.(emotion ?? "", motion ?? "") } catch { /* 忽略 */ }
						}
					}
					markerBuf.value = ""
					replyText.value = reply
					resolve()
				},
				onError: (msg) => {
					if (ttsOn) endSpeakSession()
					// 用户主动停止不算错误
					if (msg === "已停止") replyText.value = reply.trim() || "已停止"
					else if (!reply.trim()) replyText.value = `⚠ ${msg}`
					else replyText.value = reply
					resolve()
				},
			}, s.deepseekThinking, ac.signal)
		})

		// 表演兜底: 全程没收到标记 → 用正文关键词驱动 (与主 App triggerEmotion/pickMotionByKeyword 一致)
		if (streamOk && reply.trim() && !markerSeen) {
			try { bubbleBridge()?.playFloatByText?.(reply) } catch { /* 忽略 */ }
		}

		// 记录历史 (与主 App 同一份 chat.json): 用户消息 + 回复
		if (streamOk && reply.trim()) {
			const all = loadChat()
			all.push({role: "user", content: text, ts: Date.now()} as ChatMsg)
			all.push({role: "assistant", content: reply, ts: Date.now()} as ChatMsg)
			persistChat(all)
			// 记忆/总结后台执行: 不阻塞本次回复 (busy 立即释放, 用户可继续聊)
			void (async () => {
				try {
					// 记忆写入: 与主界面同一套 (Mem0 两段式: 规则兜底 + AI 提取/决策);
					// 有净新增/改写时给一条"记住了"迷你提示, 让用户知道悬浮窗聊的也记下了
					// 最近对话 (不含当前句) 供 AI 理解指代
					const recentCtx = all
						.slice(-6, -1)
						.filter(m => !(m.role === "user" && m.content === text))
						.map(m => ({role: m.role, content: m.content}))
					const tip = await doMemExtract(text, s, recentCtx)
					if (tip) showMemTip(tip)
					// 历史总结: 过长时压缩旧对话 (同一份 summarizeIfNeeded, 和主 App 共享进度)
					try {
						const summarized = await summarizeIfNeeded(all, async (prompt) => {
							const r = await sendChat(s.baseUrl, s.apiKey, s.model, [
								{role: "system", content: prompt} as ChatMsg,
							])
							return r.ok ? (r.content ?? "") : ""
						}, !!s.memoryLlmExtract)
						// 自动裁剪 (与主界面同规则): 只裁**已经进过摘要的那段前缀**
						// (P5 safeTrimDrop: 还没总结的消息一旦删掉就永远进不了记忆),
						// 近端窗口照旧保留 —— 否则只用悬浮窗聊时聊天文件会无限膨胀.
						const live = loadChat()
						const base = live.length >= all.length ? live : all
						const dropN = summarized ? safeTrimDrop(base.length) : 0
						if (dropN > 0) {
							// 裁剪前把将被裁掉的消息备份进日记源缓冲 (FE-M5)
							bufferDiarySource(base.slice(0, dropN))
							const kept = base.slice(dropN)
							kept.unshift({role: "system", content: "（更早的对话已压缩为历史总结，可在设置→记忆系统查看）", ts: Date.now(), placeholder: true} as ChatMsg)
							const firstReal = kept.find(m => m.role !== "system")
							if (firstReal) setChatTrimCutoff(firstReal.ts)
							persistChat(kept)
							// 登记被裁掉的条数 (P5 新语义; 旧的"重置成保留条数"会让近端 20 条永不入库)
							notifyHistoryTrimmed(dropN)
						}
					} catch { /* 忽略: 总结失败不影响本次对话 */ }
				} finally {
					flushChatPersist()
				}
			})()
		}
	} catch (e: any) {
		replyText.value = `⚠ ${e?.message ?? String(e)}`
		} finally {
			if (activeAbort === ac) activeAbort = null
			busy.value = false
		}
	}

/** 关闭对话框前 flush 未落盘的聊天历史 + 记忆 (防丢最后一次写入) */
onBeforeUnmount(async () => {
	window.removeEventListener("resize", onWinResize)
	flushChatPersist()
	await flushMemoryPersist()
})
</script>

<template>
	<!-- 回复文字在顶部 (伸进悬浮窗底部留白, 纯展示), 输入框在底部 (悬浮窗下方, 可点) -->
	<div class="bubble-root" @click="focusInput">
		<div class="bubble-panel">
			<!-- 回复区常驻占位 (flex:1): 保证输入行永远在底部, 不被悬浮窗遮挡 -->
			<div ref="replyEl" class="bubble-reply">
				<div v-if="!replyText && !typing" class="bubble-hint">Nori 的回复会显示在这里</div>
				<span v-if="typing" class="bubble-dots">Nori 正在说…</span>
				<div v-if="replyText" class="bubble-text" :style="{ maxWidth: bubbleW + '%' }">{{ replyText }}</div>
				<div v-if="memTip" class="bubble-memtip">{{ memTip }}</div>
			</div>
			<div class="bubble-input-row">
				<!-- 拖动把手: 位置上报给原生, 由原生触摸识别拖动 (点击不冒泡 → 不弹键盘) -->
				<div
					ref="handleEl"
					class="bubble-handle"
					:class="{ locked }"
					@click.stop.prevent
				>≡</div>
				<input
					ref="inputEl"
					v-model="draft"
					class="bubble-input"
					placeholder="和 Nori 说点什么…"
					@keydown.enter="send"
					@click.stop="focusInput"
					:disabled="busy"
				/>
				<button
					class="bubble-send"
					:class="{ stop: busy }"
					@click.stop="busy ? stopGenerate() : send()"
					:disabled="!busy && !draft.trim()"
				>{{ busy ? "■ 停止" : "发送" }}</button>
				<!-- 朗读中 (未在生成): 一键停止朗读 -->
				<button
					v-if="typing && !busy"
					class="bubble-send stop"
					@click.stop="stopTts()"
				>■</button>
				<!-- ✕: 短按锁定 (固定位置大小), 长按退出对话框 -->
				<button
					class="bubble-close"
					:class="{ locked }"
					@touchstart.stop.prevent="onCloseStart"
					@touchend.stop.prevent="onCloseEnd"
					@touchcancel.stop.prevent="onCloseEnd"
				>{{ locked ? "🔒" : "✕" }}</button>
			</div>
		</div>
	</div>
</template>

<style lang="less" scoped>
.bubble-root {
	position: fixed;
	inset: 0;
	background: transparent;
	user-select: none;
	-webkit-user-select: none;
	-webkit-touch-callout: none;
	-webkit-tap-highlight-color: transparent;
}
.bubble-panel {
	/* 全透明面板: 顶部重叠进悬浮窗底部留白, 回复文字显示在那里 (纯展示);
	   输入框在底部 (悬浮窗下方, 可点击) */
	position: absolute;
	left: 6px;
	right: 6px;
	top: 6px;
	bottom: 6px;
	display: flex;
	flex-direction: column;
	background: transparent;
	border: 1px solid rgba(148, 163, 184, 0.18);
	border-radius: 18px;
	box-shadow: 0 -8px 30px rgba(0,0,0,0.35);
	overflow: hidden;
}
.bubble-input-row {
	/* 固定在底部 (悬浮窗下方, 可点击), 不随回复移动 */
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px;
	border-top: 1px solid rgba(148, 163, 184, 0.14);
	flex-shrink: 0;
}
.bubble-handle {
	/* 拖动把手: 按住移动对话框窗口 */
	flex-shrink: 0;
	width: 34px;
	height: 38px;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 10px;
	background: rgba(148, 163, 184, 0.12);
	border: 1px solid rgba(148, 163, 184, 0.22);
	color: #94a3b8;
	font-size: 15px;
	font-weight: 700;
	user-select: none;
	-webkit-user-select: none;
	touch-action: none;
	&.locked { opacity: 0.4; }
}
.bubble-reply {
	/* 顶部: 回复文字显示区 (含伸进悬浮窗底部留白的部分, 纯展示); 超出内部滚动 */
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	-webkit-overflow-scrolling: touch;
	padding: 10px 12px;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 6px;
}
.bubble-hint {
	/* 无回复时的占位提示 (回复区常驻占位用) */
	font-size: 12px;
	color: rgba(148, 163, 184, 0.55);
	margin-top: 12px;
	align-self: center;
}
.bubble-dots {
	font-size: 11px;
	color: #94a3b8;
}
.bubble-text {
	align-self: flex-start;
	max-width: 100%;
	padding: 9px 12px;
	border-radius: 14px;
	border-bottom-left-radius: 4px;
	background: rgba(51, 65, 85, 0.35);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	border: 1px solid rgba(148, 163, 184, 0.18);
	color: #e2e8f0;
	font-size: 14px;
	line-height: 1.5;
	white-space: pre-wrap;
	word-break: normal;
	line-break: strict;
	overflow-wrap: break-word;
}
.bubble-memtip {
	align-self: flex-start;
	font-size: 11px;
	color: rgba(125, 211, 252, 0.9);
	padding: 2px 6px 0;
}
.bubble-input {
	flex: 1;
	min-width: 0;
	background: rgba(30, 41, 59, 0.9);
	border: 1px solid rgba(148, 163, 184, 0.25);
	border-radius: 12px;
	padding: 8px 12px;
	color: #e2e8f0;
	font-size: 14px;
	outline: none;
}
.bubble-send {
	padding: 0 14px;
	border-radius: 12px;
	background: linear-gradient(135deg, #38bdf8 0%, #6366f1 100%);
	color: #fff;
	font-size: 13px;
	font-weight: 600;
	flex-shrink: 0;
	&:disabled { opacity: 0.4; }
	/* 停止态: 中性灰, 与"发送"区分 */
	&.stop { background: rgba(148, 163, 184, 0.32); }
}
.bubble-close {
	flex-shrink: 0;
	width: 34px;
	height: 38px;
	border-radius: 10px;
	background: rgba(148, 163, 184, 0.14);
	border: 1px solid rgba(148, 163, 184, 0.25);
	color: #cbd5e1;
	font-size: 13px;
	line-height: 1;
	touch-action: none;
	&.locked {
		background: rgba(250, 204, 21, 0.18);
		border-color: rgba(250, 204, 21, 0.4);
	}
}
</style>