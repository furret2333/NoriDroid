<template>
	<transition name="chat">
	<div v-if="portraitLayout || chatOpen" v-show="!portraitLayout || !panelOpen" class="chat-panel" :class="{'history-open': chatOpen, 'portrait-chat': portraitLayout, 'keyboard-open': keyboardOpen}">
		<transition name="ai">
			<button v-if="portraitLayout && !chatOpen && portraitReply" class="portrait-reply" type="button" title="点击展开聊天记录" @click="emit('openHistory')">
				<span v-for="(seg, i) in bubbleSegments(portraitReply)" :key="i" class="portrait-reply-text">{{ bubbleText(seg) }}</span>
			</button>
		</transition>
		<button v-if="portraitLayout" class="history-toggle" type="button" :aria-expanded="chatOpen" aria-controls="chat-history" :aria-label="chatOpen ? '收起聊天记录' : '展开聊天记录'" @click="emit('toggleHistory')">
			<svg viewBox="0 0 24 24" aria-hidden="true" :class="{expanded: chatOpen}"><path d="m6 15 6-6 6 6" /></svg>
		</button>
		<div id="chat-history" class="chat-history" v-show="chatOpen">
		<div class="chat-head">
			<span class="chat-title">对话 · {{ modelName }}</span>
			<button v-if="chatStreaming || touchStreaming" class="x stop" @click="emit('stopGenerate')">■ 停止生成</button>
			<button v-if="speaking" class="x stop" @click="emit('stopSpeech')">■ 停止</button>
			<button class="x" aria-label="收起聊天记录" @click="chatOpen = false">✕</button>
		</div>
		<div ref="scrollElement" class="chat-msgs" :style="{ fontSize: chatFontPX, '--bubble-w': bubbleWidthNum + '%' }" @click="imageMenu = false">
			<div v-if="!messages.length" class="chat-empty">和我说点什么吧</div>
			<div
				v-for="m in messages"
				:key="msgKey(m)"
				class="bubble-wrap"
				:class="m.role"
				:data-message-ts="m.ts"
			>
				<div v-if="m.role === 'user' && messageImageUrl(m)" class="message-image-wrap">
					<img class="message-image" :src="messageImageUrl(m) ?? ''" alt="已发送图片" />
				</div>
				<!-- 存储/历史: 一条消息; 显示: assistant 按句拆多气泡, user 保持整条 -->
				<div
					v-for="(seg, j) in messageSegments(m)"
					:key="j"
					class="bubble"
				>{{ bubbleText(seg) }}</div>
			</div>
			<div v-if="(typing && !chatStreaming) || (touchStreaming && messages[messages.length - 1]?.role === 'user')" class="bubble-wrap assistant"><div class="bubble typing sea-dots"><span></span><span></span><span></span></div></div>
		</div>
		</div>
		<div v-if="pendingCount" class="queue-hint">已排队 {{ pendingCount }} 条</div>
		<div v-if="pendingImage" class="image-preview-row">
			<img class="image-preview" :src="pendingImage.dataUrl" alt="待发送图片" />
			<div class="image-preview-meta"><span>已选图片 · 仅随本条发送</span><button class="image-remove" title="移除图片" aria-label="移除图片" @click="pendingImage = null">✕</button></div>
		</div>
		<div class="chat-input">
			<input
				v-model="draft"
				:placeholder="modelReady ? '输入消息…' : '请先在设置里配置 API Key 和模型'"
				@focus="emit('composerFocus')"
				@blur="emit('composerBlur')"
				@keydown.enter="emit('inputEnter', $event)"
			/>
			<div v-if="portraitLayout" class="image-entry composer-more">
				<button class="chat-tool" type="button" title="图片与戳戳" aria-label="图片与戳戳" aria-haspopup="menu" :aria-expanded="imageMenu" @click="imageMenu = !imageMenu">＋</button>
				<div v-show="imageMenu" class="image-menu" role="menu" @keydown.esc="imageMenu = false">
					<button role="menuitem" :disabled="imagePicking" @click="emit('chooseImage', 'album')">{{ imagePicking ? '选图中…' : '从相册选图' }}</button>
					<button role="menuitem" :disabled="imagePicking" @click="emit('chooseImage', 'camera')">直接拍摄</button>
					<button class="poke" role="menuitem" :disabled="!modelReady || typing || chatStreaming || touchStreaming" @click="imageMenu = false; emit('poke')">戳戳 Nori</button>
				</div>
			</div>
			<button class="send" :class="{stop: portraitLayout && (chatStreaming || touchStreaming)}" @click="portraitLayout && (chatStreaming || touchStreaming) ? emit('stopGenerate') : emit('send')" :disabled="!(portraitLayout && (chatStreaming || touchStreaming)) && !draft.trim() && !pendingImage">{{ portraitLayout && (chatStreaming || touchStreaming) ? '停止' : '发送' }}</button>
		</div>
		<div v-if="!portraitLayout" class="chat-tools">
			<div class="image-entry">
				<button class="chat-tool" title="添加图片" aria-haspopup="menu" :aria-expanded="imageMenu" :disabled="imagePicking" @click="imageMenu = !imageMenu">{{ imagePicking ? '选图中…' : '图片' }}</button>
				<div v-if="imageMenu" class="image-menu" role="menu" @keydown.esc="imageMenu = false">
					<button role="menuitem" @click="emit('chooseImage', 'album')">从相册选图</button>
					<button role="menuitem" @click="emit('chooseImage', 'camera')">直接拍摄</button>
				</div>
			</div>
			<button class="chat-tool poke" title="戳戳 Nori，聊一句" @click="emit('poke')" :disabled="!modelReady || typing || chatStreaming || touchStreaming">戳戳</button>
			<span class="chat-tool-hint">识图需模型支持</span>
		</div>
	</div>
</transition>
</template>

<script setup lang="ts">
import {ref} from "vue"
import type {ChatMsg, ImagePickedResult} from "../services/chat"
import {splitSpeechText} from "../services/tts"
import {stripInternalPromptMetadata} from "../services/chat/replyMetadata"

type PendingImage = Pick<ImagePickedResult, "dataUrl" | "mime" | "width" | "height" | "size">
const props = defineProps<{
	portraitLayout: boolean
	keyboardOpen: boolean
	panelOpen: boolean
	portraitReply: string
	modelName: string
	chatStreaming: boolean
	touchStreaming: boolean
	speaking: boolean
	typing: boolean
	messages: ChatMsg[]
	chatFontPX: string
	bubbleWidthNum: number
	pendingCount: number
	modelReady: boolean
	imagePicking: boolean
	imagePreviews: ReadonlyMap<number, string>
}>()
const draft = defineModel<string>("draft", {required: true})
const chatOpen = defineModel<boolean>("chatOpen", {required: true})
const imageMenu = defineModel<boolean>("imageMenu", {required: true})
const pendingImage = defineModel<PendingImage | null>("pendingImage", {required: true})
const emit = defineEmits<{
	openHistory: []
	toggleHistory: []
	stopGenerate: []
	stopSpeech: []
	composerFocus: []
	composerBlur: []
	inputEnter: [event: KeyboardEvent]
	chooseImage: [source: "album" | "camera"]
	poke: []
	send: []
}>()
const scrollElement = ref<HTMLElement | null>(null)
defineExpose({scrollElement})
const MAX_BUBBLE_LEN = 60

const messageImageUrl = (message: ChatMsg): string | null => props.imagePreviews.get(message.ts) ?? null

const messageSegments = (message: ChatMsg): string[] => {
	if (message.role === "assistant") return bubbleSegments(message.content)
	// 有预览时不再显示历史占位符；纯图片没有文字气泡。
	const text = messageImageUrl(message) && message.content.startsWith("[图片]")
		? message.content.slice("[图片]".length).trimStart()
		: message.content
	return text ? [text] : []
}

/**
 * 气泡显示文本: 统一省略号显示, 防止被 CSS 断行拆开.
 * - 连续英文点 (AI 可能输出 "......") → 单个中文省略号 "…"
 * - 中文省略号 (…… 或 ······) → 合并为单个 "…"
 * 单个字符永远不会被断行拆开.
 */

const bubbleText = (content: string): string =>
	stripInternalPromptMetadata(content)
		.replace(/\.{2,20}/g, "…")
		.replace(/…{2,}/g, "…")
		.replace(/·{2,}/g, "…")

/**
 * 按句拆气泡 (仅显示用): 存储里一条消息, 显示时按句末标点切成多个独立气泡.
 * 复用 splitSpeechText 的切分规则 (。！？!?\n…), 超长无标点段用 MAX_BUBBLE_LEN 兜底.
 * 结果按内容缓存 (性能): 流式时每个增量都触发重渲染, 模板里直接调用会让
 * 全部历史消息每帧重切一遍 —— 长对话打字/流式输出卡顿的根源. 内容字符串
 * 不可变 → 缓存按内容做键, 只有正在生长的那条会重算.
 */
const segCache = new Map<string, string[]>()
const bubbleSegments = (content: string): string[] => {
	const cleaned = stripInternalPromptMetadata(content)
	const hit = segCache.get(cleaned)
	if (hit) return hit
	const segs = computeBubbleSegments(cleaned)
	if (segCache.size > 150) segCache.clear() // 防止极长对话下缓存膨胀 (内容键不可枚举复用)
	segCache.set(cleaned, segs)
	return segs
}

const computeBubbleSegments = (content: string): string[] => {
	const raw = content ?? ""
	const segs: string[] = []
	let rest = raw
	const pushSeg = (t: string): void => {
		if (!t.trim()) return
		if (t.length > MAX_BUBBLE_LEN) {
			for (let i = 0; i < t.length; i += MAX_BUBBLE_LEN) {
				segs.push(t.slice(i, i + MAX_BUBBLE_LEN))
			}
		} else {
			segs.push(t)
		}
	}
	// 防死循环: 迭代上限 (正常回复最多几十句)
	for (let guard = 0; guard < 200; guard++) {
		// 气泡显示: 省略号不当句子边界 (否则 "……" 会被单独切出/挤到下一行)
		const {sentences, rest: r} = splitSpeechText(rest, 40, false)
		for (const s of sentences) pushSeg(s.trim())
		if (!r.trim()) break
		rest = r
		// splitSpeechText 对 <40 字的无标点 rest 不产生 sentences, 直接作为最后一段
		if (rest.length < 40) {
			pushSeg(rest.trim())
			break
		}
		// rest >= 40 字无标点: 下一轮 splitSpeechText 会按弱分隔或整段切出 sentences
	}
	return segs.filter(Boolean)
}

/**
 * v-for 稳定 key: 按消息对象身份分配自增 id (WeakMap, 不影响持久化/响应式).
 * 旧实现用数组下标作 key —— 删除错误气泡/裁剪移位后整段下标前移, Vue 错误
 * 复用 DOM 节点; 内容类 key 又会随流式增量变化导致节点重建.
 */
const msgIdMap = new WeakMap<ChatMsg, number>()
let msgIdSeq = 0
const msgKey = (m: ChatMsg): number => {
	let id = msgIdMap.get(m)
	if (id === undefined) {
		id = ++msgIdSeq
		msgIdMap.set(m, id)
	}
	return id
}
</script>

<style scoped lang="less">
@import "../assets/style/dialog-controls.less";

.chat-panel {
	position: absolute;
	left: 10px; right: 10px;
	bottom: calc(86px + env(safe-area-inset-bottom));
	max-height: 58vh;
	display: flex;
	flex-direction: column;
	/* 面板改为完全透明: 去掉整块毛玻璃, 让背景/模型透出来.
	   气泡改用自身半透明填充承担可读性 (见下), 因此这里不再需要任何背景层.
	   性能上这是净收益: 原先 ::before 的 backdrop-filter 要每帧对约半个屏幕做
	   区域重采样, 而底下的 Live2D(WebGL) 与数据海(2D canvas) 都在逐帧渲染, 共用同一个 GPU.
	   连带去掉 border 与 box-shadow —— 它们原本是框在毛玻璃块上的, 面板透明后会变成
	   悬空的一圈线和一条暗带. */
	background: transparent;
	border: none;
	/* 保留圆角: border 去掉了, 但 overflow:hidden 需要它作为裁剪半径,
	   否则滚动内容会溢出面板边界 */
	border-radius: var(--ui-radius-card);
	z-index: 12;
	overflow: hidden;
}
.chat-head {
	display: flex; justify-content: space-between; align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid var(--line-soft);
}
.chat-history {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
	overflow: hidden;
}
.chat-title { font-size: 14px; font-weight: 600; color: var(--fg); }
.chat-msgs {
	flex: 1; min-height: 120px; overflow-y: auto;
	padding: 12px 14px;
	display: flex; flex-direction: column; gap: 8px;
	line-height: 1.5;
	-webkit-overflow-scrolling: touch;
	touch-action: pan-y;
}
.chat-empty { text-align: center; color: var(--fg-dim); font-size: 13px; }
.bubble-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; animation: msg-land 0.26s ease-out both; }
@keyframes msg-land {
	0% { opacity: 0; transform: translateY(10px) scale(0.97); }
	100% { opacity: 1; transform: none; }
}
.bubble-wrap.user { align-items: flex-end; }
.bubble-wrap.assistant { align-items: flex-start; }
.bubble {
	min-width: 0;
	max-width: var(--bubble-w, 82%);
	padding: 9px 12px;
	border-radius: var(--ui-radius-card);
	font-size: 1em;
	white-space: pre-wrap;
	/* 中文按字自然换行 (与微信等一致): 之前的 keep-all 会让无标点长句整段不可断,
	   到气泡边缘被迫在任意位置硬切 —— 这正是"长句中间被强制换行"的根源;
	   line-break: strict 保留标点禁则 (。！？等不出现在行首), 英文长单词由
	   overflow-wrap 只在整行放不下时才拆 */
	word-break: normal;
	line-break: strict;
	overflow-wrap: break-word;
	color: var(--fg);
}
.bubble-wrap.user .bubble {
	/* 扁平着色 (配合面板级毛玻璃): 气泡不再各自开 backdrop-filter */
	background: linear-gradient(135deg, rgba(56, 189, 248, 0.55) 0%, rgba(99, 102, 241, 0.55) 100%);
	border: 1px solid var(--line);
	color: #fff;
	text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
	border-bottom-right-radius: 4px;
}
.bubble-wrap.assistant .bubble {
	/* 面板透明后, Nori 的气泡自己承担"可读又可透"的平衡:
	   底色由 0.62 降到 0.34 (纯填充, 不产生合成层, 不采样背景 → 零 backdrop-filter 成本),
	   并补一层文字投影 —— 半透明底压到模型亮部时, 光靠底色对比不够. */
	background: rgba(30, 41, 59, 0.34);
	border: 1px solid var(--line-strong);
	color: #e8eef7;
	text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
	border-bottom-left-radius: 4px;
}
/* 裁剪占位符: 居中弱化显示 (重启后不再消失, FE-M4) */
.bubble-wrap.system { align-items: center; }
.bubble-wrap.system .bubble {
	background: transparent;
	border: none;
	color: var(--fg-dim);
	font-size: 12px;
}
.bubble-wrap.assistant .bubble.typing { color: var(--fg-3); }
.chat-input {
	display: flex; gap: 8px;
	padding: 10px 12px 4px;
	border-top: 1px solid var(--line-soft);
}
.chat-tools {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 12px 8px;
	flex-shrink: 0;
}
.chat-tool {
	min-height: 40px;
	padding: 0 12px;
	border: 1px solid var(--line-soft);
	border-radius: var(--ui-radius-ctl);
	background: var(--surface);
	color: var(--fg);
	font-size: 13px;
	white-space: nowrap;
	&:disabled { opacity: 0.4; }
}
.chat-tool-hint {
	margin-left: auto;
	color: var(--fg-dim);
	font-size: 11px;
}
.image-entry { position: relative; }
.image-menu {
	position: absolute;
	bottom: calc(100% + 6px);
	left: 0;
	z-index: 2;
	display: flex;
	flex-direction: column;
	width: 160px;
	padding: 4px;
	border: 1px solid var(--line-strong);
	border-radius: var(--ui-radius-ctl);
	background: rgba(15, 23, 42, 0.98);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	button {
		min-height: 44px;
		padding: 8px 12px;
		text-align: left;
		color: var(--fg);
		font-size: 14px;
		border-radius: var(--ui-radius-ctl);
		&:active { background: rgba(56, 189, 248, 0.16); }
	}
}
.image-preview-row {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 12px;
	flex-shrink: 0;
}
.image-preview {
	width: 56px;
	height: 56px;
	object-fit: cover;
	border-radius: var(--ui-radius-ctl);
}
.image-preview-meta {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex: 1;
	min-width: 0;
	color: var(--fg-3);
	font-size: 12px;
}
.image-remove { min-width: 40px; min-height: 40px; color: var(--fg); }
.message-image-wrap { max-width: var(--bubble-w, 82%); }
.message-image {
	display: block;
	max-width: 100%;
	width: 200px;
	max-height: 180px;
	object-fit: contain;
	border-radius: var(--ui-radius-card);
}
.queue-hint {
	padding: 5px 14px 0;
	font-size: 11px;
	color: var(--accent);
	text-align: right;
}
.chat-input input {
	flex: 1;
	min-width: 0;
	background: rgba(30, 41, 59, 0.9);
	border: 1px solid var(--line-strong);
	border-radius: var(--ui-radius-ctl);
	padding: 10px 12px;
	color: var(--fg);
	font-size: 14px;
	outline: none;
}
.chat-input .send {
	flex-shrink: 0;
	padding: 0 16px;
	border-radius: var(--ui-radius-ctl);
	background: linear-gradient(135deg, var(--accent-strong) 0%, #6366f1 100%);
	color: #fff;
	font-size: 14px;
	font-weight: 600;
	&:disabled { opacity: 0.4; }
}

.sea-dots {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: sea-dot 1.2s ease-in-out infinite;
		&:nth-child(2) { animation-delay: 0.15s; }
		&:nth-child(3) { animation-delay: 0.3s; }
	}
}
@keyframes sea-dot {
	0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
	30% { opacity: 1; transform: translateY(-3px); }
}

.x.stop {
	width: auto; min-width: 32px; height: 32px;
	padding: 0 8px;
	white-space: nowrap;
	flex-shrink: 0;
}

.chat-enter-active, .chat-leave-active { transition: opacity 0.22s ease, transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1); }
.chat-enter-from, .chat-leave-to { opacity: 0; transform: translateY(16px); }

.ai-enter-active, .ai-leave-active { transition: opacity 0.24s ease, transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); }
.ai-enter-from, .ai-leave-to { opacity: 0; transform: translateY(14px) scale(0.98); }

.chat-panel:not(.portrait-chat) {
	left: auto;
	right: calc(10px + env(safe-area-inset-right, 0px));
	width: min(52vw, 520px);
	max-height: 80vh;
}

.chat-panel.portrait-chat {
	left: calc(12px + env(safe-area-inset-left, 0px));
	right: calc(12px + env(safe-area-inset-right, 0px));
	bottom: calc(10px + env(safe-area-inset-bottom, 0px) + var(--chat-keyboard-inset, 0px));
	max-height: none;
	overflow: visible;
	border-radius: 20px;
	.history-toggle {
		align-self: center;
		width: 64px;
		height: 30px;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		border-radius: 12px 12px 0 0;
		background: rgba(20, 32, 48, 0.22);
		color: rgba(238, 245, 255, 0.8);
		svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform 0.18s ease; }
		svg.expanded { transform: rotate(180deg); }
	}
	.chat-history {
		flex: 0 1 auto;
		height: min(28vh, 260px);
		border: 1px solid rgba(228, 241, 255, 0.14);
		border-radius: 16px 16px 0 0;
		background: rgba(15, 26, 42, 0.22);
	}
	.chat-head { flex-shrink: 0; padding: 5px 10px; gap: 6px; }
	.chat-title { font-size: 12px; margin-right: auto; }
	.chat-head .x { font-size: 11px; padding: 4px 6px; }
	.chat-msgs { min-height: 0; padding: 8px 10px; gap: 6px; }
	.chat-input {
		flex-shrink: 0;
		align-items: stretch;
		padding: 8px;
		gap: 6px;
		border: 1px solid rgba(228, 241, 255, 0.18);
		border-radius: 18px;
		background: rgba(22, 34, 51, 0.3);
		backdrop-filter: blur(var(--ui-blur-chip));
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
	}
	.chat-input input {
		min-height: 42px;
		padding: 8px 10px;
		box-sizing: border-box;
		border-color: rgba(228, 241, 255, 0.14);
		border-radius: 12px;
		background: rgba(16, 27, 44, 0.2);
	}
	.chat-input .send { padding: 0 12px; border-radius: 12px; font-size: 13px; }
	.composer-more { display: flex; flex-shrink: 0; }
	.composer-more > .chat-tool { width: 40px; padding: 0; border-radius: 12px; font-size: 23px; font-weight: 300; background: rgba(228, 241, 255, 0.09); }
	.composer-more .image-menu { left: auto; right: 0; z-index: 3; }
	.image-menu button:disabled { opacity: 0.4; }
	.image-preview-row { padding: 5px 10px; background: rgba(16, 27, 44, 0.24); border-radius: 12px 12px 0 0; }
	.image-preview { width: 36px; height: 36px; }
	.image-preview-meta { font-size: 11px; }
	.queue-hint { padding: 4px 10px; }
	.portrait-reply {
		position: absolute;
		left: 50%;
		bottom: calc(100% + clamp(24px, 8vh, 72px));
		transform: translateX(-50%);
		width: max-content;
		max-width: calc(100% - 24px);
		padding: 10px 16px;
		border: 1px solid rgba(235, 245, 255, 0.16);
		border-radius: 18px;
		background: rgba(24, 35, 51, 0.3);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		backdrop-filter: blur(var(--ui-blur-bubble));
		color: #f2f6fc;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
		font-size: 14px;
		line-height: 1.6;
		text-align: center;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		line-break: strict;
	}
	.portrait-reply-text { display: block; max-width: min(80vw, 520px); }
	.portrait-reply.ai-enter-from, .portrait-reply.ai-leave-to { transform: translateX(-50%) translateY(8px); }
}


.chat-panel.portrait-chat.keyboard-open {
	.chat-history { height: min(28vh, 120px); }
	.portrait-reply { bottom: calc(100% + 8px); }
}
</style>
