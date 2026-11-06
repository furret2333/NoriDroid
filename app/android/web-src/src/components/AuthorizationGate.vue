<template>
	<div class="gate-mask" :class="kind === 'clone' ? 'clone-gate-mask' : kind === 'persona' ? 'persona-gate-mask' : 'model-gate-mask'" @click.self="emit('close')">
		<div class="gate" :class="kind === 'clone' ? 'clone-gate' : kind === 'persona' ? 'persona-gate' : 'model-gate'">
			<div class="gate-head">
				<span class="gate-title">{{ kind === "persona" ? "人设授权验证" : "模型授权验证" }}</span>
				<button class="x" @click="emit('close')">✕</button>
			</div>
			<p class="gate-desc">该{{ kind === "clone" ? "内置音色" : kind === "persona" ? "人设文案" : "模型" }}由 <b>inori</b> 提供，因{{ kind === "persona" ? "特殊性" : "模型特殊性" }}不可直接分发；答对下面的问题即可{{ kind === "clone" ? "获得使用资格" : "开始下载" }}。</p>
			<div class="gate-q">{{ CLONE_GATE_QUESTION }}</div>
			<input v-model="input" class="gate-input" type="text" autocomplete="off" spellcheck="false" placeholder="请输入答案" @keyup.enter="emit('submit')" />
			<div v-if="message" class="hint" :class="ok ? 'ok' : 'bad'">{{ message }}</div>
			<div class="gate-btns">
				<button class="mini ripple" @click="emit('close')">取消</button>
				<button class="mini ripple gate-go" :disabled="busy || !input.trim()" @click="emit('submit')">{{ busy ? gateBusyLabel : gateGoLabel }}</button>
			</div>
			<div class="gate-hint">{{ kind === "clone" ? CLONE_GATE_HINT : kind === "persona" ? PERSONA_GATE_HINT : MODEL_GATE_HINT }}</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import {computed} from "vue"
import {CLONE_GATE_QUESTION, CLONE_GATE_HINT, MODEL_GATE_HINT, PERSONA_GATE_HINT} from "../services/tts/clone-gate"

const props = defineProps<{
	kind: "clone" | "model" | "persona"
	message: string
	ok: boolean
	busy: boolean
}>()
const emit = defineEmits<{
	close: []
	submit: []
}>()
const input = defineModel<string>("input", {required: true})
const gateGoLabel = computed(() => props.kind === "clone" ? "验证并克隆" : "验证并下载")
const gateBusyLabel = computed(() => props.kind === "clone" ? "创建中…" : "下载中…")
</script>

<style lang="less" scoped>
@import "../assets/style/dialog-controls.less";

.gate-mask {
	position: absolute; inset: 0; z-index: 60;
	display: flex; align-items: center; justify-content: center;
	padding: 22px;
	background: rgba(4, 10, 20, 0.62);
	backdrop-filter: blur(3px);
}
.gate {
	width: 100%; max-width: 340px;
	padding: 18px 18px 14px;
	background: var(--panel, rgba(12, 22, 38, 0.96));
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-panel);
	box-shadow: var(--ui-shadow);
	color: var(--fg);
}
.gate-head {
	display: flex; align-items: center; justify-content: space-between;
	margin-bottom: 10px;
}
.gate-title {
	font-size: 16px; font-weight: 700; letter-spacing: 0.02em;
	color: var(--accent);
}
.gate-desc {
	margin: 0 0 12px; font-size: 12.5px; line-height: 1.7; color: var(--fg-dim);
	b { color: var(--fg); font-weight: 600; }
}
.gate-q {
	margin-bottom: 10px;
	font-size: 14px; font-weight: 700; line-height: 1.5;
}
.gate-input {
	width: 100%; box-sizing: border-box;
	padding: 10px 12px;
	background: var(--px-void);
	color: var(--fg);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	font-size: 13.5px;
	outline: none;
	&:focus { border-color: var(--accent); }
}
.gate-btns {
	margin-top: 12px;
	display: flex; align-items: center; justify-content: flex-end; gap: 8px;
	.mini {
		padding: 9px 16px; border-radius: var(--ui-radius-ctl);
		font-size: 13.5px; line-height: 1;
		background: transparent; color: var(--fg-dim);
		border: var(--ui-line-w) solid var(--ui-line-c-soft);
	}
	.gate-go {
		background: var(--accent); color: #06121f; font-weight: 600;
		border-color: transparent; box-shadow: var(--ui-shadow);
		&:disabled { opacity: 0.5; }
	}
}
.gate-hint {
	margin-top: 12px; padding-top: 10px;
	border-top: var(--ui-line-w) solid var(--ui-line-c-soft);
	font-size: 11.5px; line-height: 1.65; color: var(--fg-dim);
}
</style>
