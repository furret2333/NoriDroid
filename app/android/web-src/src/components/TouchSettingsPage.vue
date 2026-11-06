<template>
<div class="touch-page">
	<div v-show="touchCustomExpanded" class="touch-overlay" :class="{drawing: touchDrawing, testing: touchTesting}">
		<div v-for="(t, i) in touchAreas" :key="t.id" class="touch-area-box" :class="[t.type, {selected: selectedTouchId === t.id}]" :style="[boxStyle(t), {zIndex: i + 1}]">
			<span class="ba-name">{{ t.name }}</span>
			<span v-if="touchAdjusting && selectedTouchId === t.id" class="touch-resize-handle" aria-hidden="true">↘</span>
		</div>
		<div v-if="touchDraft" class="touch-area-box draft" :style="boxStyle(touchDraft)"></div>
	</div>
	
	<div class="touch-top">
		<span class="touch-title">互动设置</span>
		<button class="x" aria-label="关闭互动设置" @click="emit('close')">✕</button>
	</div>
	
	<div class="touch-editor">
		<section class="touch-intro">
			<div class="touch-intro-icon" aria-hidden="true">♡</div>
			<div class="touch-intro-copy">
				<b>摸头 · 默认互动</b>
				<span>在模型头部按住或轻轻抚摸，会触发表情、轻摆和柔光反馈。台词朗读跟随语音合成设置。</span>
			</div>
		</section>
		<section class="touch-pet-options">
			<div class="touch-option-head"><b>摸头反馈</b><small>默认开启；关闭后仍保留头部跟随</small></div>
			<div class="touch-option-grid">
				<label><span>表情与轻摆</span><input type="checkbox" v-model="cfg.petTouchEnabled" @change="emit('petTouchSetting')" /></label>
				<label><span>柔光特效</span><input type="checkbox" v-model="cfg.petTouchEffects" @change="emit('petTouchSetting')" /></label>
				<label><span>摩擦音效</span><input type="checkbox" v-model="cfg.petTouchSound" @change="emit('petTouchSetting')" /></label>
				<label><span>台词朗读</span><input type="checkbox" v-model="cfg.petTouchSpeech" @change="emit('petTouchSetting')" /></label>
			</div>
		</section>
		<details class="touch-custom" :open="touchCustomExpanded" @toggle="emit('customToggle', $event)">
			<summary>自定义区域 · 进阶 <small>{{ touchAreas.length }} 个区域</small></summary>
		<TouchManager
			:touches="touchAreas"
			:drawing="touchDrawing"
			:adjusting="touchAdjusting"
			:has-draft="draftReady"
			:enabled="touchEnabled"
			:testing="touchTesting"
			:cooldown-text="touchCooldownText"
			:selected-id="selectedTouchId"
			:editing-id="touchEditingId"
			:can-undo="canUndo"
			:busy="busy"
			@toggle-draw="emit('toggleDraw')"
			@toggle-adjust="emit('toggleAdjust')"
			@toggle-testing="emit('toggleTesting')"
			@set-enabled="emit('setEnabled', $event)"
			@add="emit('add', $event)"
			@update="(id, patch) => emit('update', id, patch)"
			@select="selectedTouchId = $event"
			@edit="emit('edit', $event)"
			@preview="(id, patch) => emit('preview', id, patch)"
			@cancel-edit="emit('cancelEdit')"
			@undo="emit('undo')"
			@remove="emit('remove', $event)"
			@test="emit('test', $event)"
			@reset-draft="emit('resetDraft')"
		/>
		</details>
		<p v-if="touchBubble" class="touch-feedback" role="status">{{ touchBubble }}</p>
		<div v-if="touchReplyPreview" class="touch-ai-preview" aria-live="polite"><b>Nori{{ touchStreaming ? ' · 正在回应' : '' }}</b><p>{{ touchReplyPreview }}</p></div>
	</div>
</div>
</template>

<script setup lang="ts">
import type {CSSProperties} from "vue"
import type {Settings} from "../services/chat"
import type {TouchArea} from "../services/live2d/touch"
import TouchManager from "./TouchManager.vue"

type TouchBox = {x: number; y: number; w: number; h: number}
type NewTouchArea = {name: string; prompt: string; reactionPrompt: string; gesture: "tap" | "swipe" | "both"}

// State and pointer routing stay in useTouchEditor / App; this component renders the editor.
defineProps<{
	cfg: Settings
	touchAreas: TouchArea[]
	touchCustomExpanded: boolean
	touchDrawing: boolean
	touchTesting: boolean
	touchAdjusting: boolean
	touchDraft: TouchBox | null
	draftReady: boolean
	touchEnabled: boolean
	touchCooldownText: string
	touchEditingId: string | null
	canUndo: boolean
	busy: boolean
	touchBubble: string
	touchReplyPreview: string
	touchStreaming: boolean
	boxStyle: (box: TouchBox) => CSSProperties
}>()

const selectedTouchId = defineModel<string | null>("selectedTouchId", {required: true})
const emit = defineEmits<{
	close: []
	petTouchSetting: []
	customToggle: [event: Event]
	toggleDraw: []
	toggleAdjust: []
	toggleTesting: []
	setEnabled: [enabled: boolean]
	add: [area: NewTouchArea]
	update: [id: string, patch: Partial<TouchArea>]
	edit: [id: string]
	preview: [id: string, patch: Partial<TouchArea>]
	cancelEdit: []
	undo: []
	remove: [id: string]
	test: [area: TouchArea]
	resetDraft: []
}>()
</script>

<style lang="less" scoped>
@import "../assets/style/dialog-controls.less";

.touch-overlay {
	position: absolute;
	inset: 0;
	z-index: 2;
	pointer-events: none;
}
.touch-overlay.drawing { cursor: crosshair; }
.touch-area-box {
	position: absolute;
	box-sizing: border-box;
	border: 2px solid rgba(80, 160, 255, 0.95);
	background: rgba(80, 160, 255, 0.15);
	border-radius: var(--ui-radius-ctl);
	&.swipe { border-color: rgba(255,170,60,0.95); background: rgba(255,170,60,0.15); }
	&.frenzy { border-color: rgba(255,80,200,0.95); background: rgba(255,80,200,0.15); }
	&.draft { border-style: dashed; border-color: rgba(125,227,255,0.95); background: rgba(125,227,255,0.15); }
	&.selected { border-color: #a7f3d0; box-shadow: 0 0 0 2px rgba(110,231,183,0.28), 0 0 18px rgba(110,231,183,0.2); }
}


.touch-page {
	position: fixed;
	inset: 0;
	z-index: 15;
	background: rgba(2, 6, 23, 0.35);
	pointer-events: none; 
	touch-action: none;
}
.touch-page .touch-overlay.drawing, .touch-page .touch-overlay.testing { cursor: crosshair; }
.touch-top {
	position: absolute;
	top: 0; left: 0; right: 0;
	z-index: 3;
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: calc(12px + env(safe-area-inset-top)) 14px 10px;
	pointer-events: auto;
	background: linear-gradient(180deg, rgba(2,6,23,0.7) 0%, rgba(2,6,23,0) 100%);
}
.touch-title {
	font-size: 16px; font-weight: 600; color: var(--fg);
	text-shadow: 0 0 12px rgba(56, 189, 248, 0.35);
}
.touch-intro, .touch-pet-options {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 11px 12px;
	border: 1px solid rgba(127, 212, 230, 0.2);
	border-radius: var(--ui-radius-card);
	background: rgba(20, 37, 52, 0.72);
}
.touch-intro-icon { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 10px; color: #bdefff; background: rgba(56,189,248,0.14); font-size: 21px; }
.touch-intro-copy, .touch-option-head { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1; }
.touch-intro-copy b, .touch-option-head b { color: var(--fg); font-size: 13px; }
.touch-intro-copy span, .touch-option-head small { color: var(--fg-dim); font-size: 11px; line-height: 1.45; }
.touch-pet-options { display: block; }
.touch-option-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 9px; }
.touch-option-grid label { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 9px; background: rgba(2, 6, 23, 0.25); color: var(--fg-2); font-size: 11px; }
.touch-option-grid input { width: 17px; height: 17px; accent-color: var(--accent-strong); }
.touch-editor {
	position: absolute;
	left: 0; right: 0; bottom: 0;
	z-index: 3;
	max-height: 48vh;
	overflow-y: auto;
	pointer-events: auto;
	padding: 12px 14px calc(16px + env(safe-area-inset-bottom));
	background: linear-gradient(180deg, rgba(2,6,23,0.75) 0%, rgba(2,6,23,0.97) 100%);
	border-top: 1px solid var(--line);
	display: flex;
	flex-direction: column;
	gap: 10px;
	touch-action: pan-y;
}
.touch-custom summary { padding: 10px 0; color: var(--fg-2); font-size: 13px; cursor: pointer; }
.touch-custom summary small { color: var(--fg-dim); margin-left: 8px; }
.touch-feedback { margin: 0; font-size: 12px; color: var(--accent-strong); }
.touch-ai-preview { padding: 10px; border: 1px solid var(--line); border-radius: var(--ui-radius-card); font-size: 12px; color: var(--fg); }
.touch-ai-preview p { margin: 5px 0 0; white-space: pre-wrap; line-height: 1.6; max-height: 22vh; overflow: auto; }
.touch-resize-handle { position: absolute; right: -3px; bottom: -3px; width: 28px; height: 28px; background: #164e63; color: #a7f3d0; border: 1px solid currentColor; display: grid; place-items: center; border-radius: 4px; }
@media (orientation: landscape) and (min-width: 640px) {
	.touch-editor { left: auto; top: 58px; width: min(360px, 44vw); max-height: none; border-left: 1px solid var(--line); }
}
.ba-name {
	position: absolute;
	left: 4px; top: 4px;
	font-size: 10px;
	line-height: 1;
	color: #fff;
	padding: 2px 5px;
	border-radius: var(--ui-radius-ctl);
	background: rgba(0,0,0,0.45);
	max-width: calc(100% - 8px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
