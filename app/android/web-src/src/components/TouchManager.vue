<script setup lang="ts">




import {ref, watch} from "vue"
import type {TouchArea} from "../services/live2d/touch"

const props = defineProps<{
	touches: TouchArea[]
	drawing: boolean
	adjusting: boolean
	hasDraft: boolean
	enabled: boolean
	testing: boolean
	cooldownText: string
	selectedId: string | null
	editingId: string | null
	canUndo: boolean
	busy: boolean
}>()

const emit = defineEmits<{
	(e: "toggleDraw"): void
	(e: "toggleAdjust"): void
	(e: "toggleTesting"): void
	(e: "setEnabled", enabled: boolean): void
	(e: "add", t: {name: string; prompt: string; reactionPrompt: string; gesture: "tap" | "swipe" | "both"}): void
	(e: "update", id: string, patch: Partial<TouchArea>): void
	(e: "remove", id: string): void
	(e: "test", t: TouchArea): void
	(e: "resetDraft"): void
	(e: "select", id: string): void
	(e: "edit", id: string): void
	(e: "preview", id: string, patch: Partial<TouchArea>): void
	(e: "cancelEdit"): void
	(e: "undo"): void
}>()


const editName = ref("")
const editPrompt = ref("")
const editGesture = ref<"tap" | "swipe" | "both">("both")
const editWidth = ref(0.2)
const editHeight = ref(0.2)

const name = ref("")
const prompt = ref("")
const gesture = ref<"tap" | "swipe" | "both">("both")

const pct = (v: number) => `${Math.round(v * 100)}%`

const startEdit = (t: TouchArea) => {
	emit("edit", t.id)
	emit("select", t.id)
	emit("resetDraft")
}

watch(() => props.editingId, (id) => {
	const t = props.touches.find(t => t.id === id)
	if (!t) return
	editName.value = t.name
	editPrompt.value = t.reactionPrompt ?? ""
	editGesture.value = t.gesture ?? "both"
	editWidth.value = t.w
	editHeight.value = t.h
})

watch(() => props.touches.find(t => t.id === props.editingId), t => {
	if (!t) return
	editWidth.value = t.w
	editHeight.value = t.h
})

const previewSize = () => {
	if (props.editingId) emit("preview", props.editingId, {w: editWidth.value, h: editHeight.value})
}

const cancelEdit = () => {
	emit("cancelEdit")
	editName.value = ""
	editPrompt.value = ""
	editGesture.value = "both"
}

const saveEdit = () => {
	const nm = editName.value.trim() || "未命名"
	if (props.editingId) emit("update", props.editingId, {
		name: nm,
		reactionPrompt: editPrompt.value.trim(),
		gesture: editGesture.value,
		w: editWidth.value,
		h: editHeight.value,
	})
}

const submitNew = () => {
	emit("add", {name: name.value, prompt: "", reactionPrompt: prompt.value.trim(), gesture: gesture.value})
}

watch(() => props.hasDraft, (has) => {
	if (has) {
		
		emit("cancelEdit")
		if (!name.value) name.value = `区域 ${props.touches.length + 1}`
	} else {
		name.value = ""
		prompt.value = ""
		gesture.value = "both"
	}
})
</script>

<template>
	<div class="touch-manager">
		<div class="tm-head">
			<span class="tm-title">自定义触摸区域</span>
			<span class="tm-count">{{ touches.length }} 个区域</span>
			<button v-if="canUndo" class="tm-btn" @click="emit('undo')">撤销删除</button>
		</div>

		<div class="tm-switches">
			<label class="tm-switch-row">
				<span><b>启用自定义区域</b><small>触发后让 AI 按部位回应</small></span>
				<input type="checkbox" :checked="enabled" @change="emit('setEnabled', ($event.target as HTMLInputElement).checked)" />
			</label>
			<div class="tm-tools">
				<button class="tm-me-btn primary" :class="{on: drawing}" @click="emit('toggleDraw')">
					{{ drawing ? "退出框选" : "＋ 新增区域" }}
				</button>
				<button class="tm-me-btn adj" :class="{on: adjusting}" @click="emit('toggleAdjust')">
					{{ adjusting ? "完成调整" : "调整位置" }}
				</button>
				<button class="tm-me-btn test" :class="{on: testing}" @click="emit('toggleTesting')">
					{{ testing ? "结束试用" : "试用命中" }}
				</button>
			</div>
			<div class="tm-hint" :class="{warn: !enabled || testing}">
				{{ !enabled ? "自定义互动已暂停，摸头反馈仍可照常使用。" : testing ? "在模型上点按或滑动，只检查命中；不调用 AI，也不消耗冷却。" : "日常互动在松手后触发 AI；每个区域冷却 10 秒。摸头优先，回复或朗读期间跳过。" }}
			</div>
			<div v-if="cooldownText" class="tm-cooldown">{{ cooldownText }}</div>
		</div>

		<div v-if="drawing" class="tm-hint">在模型上按住拖动画新矩形，松手填写名称</div>
		<div v-else-if="adjusting" class="tm-hint warn">拖动区域移动，拖右下角缩放；在区域卡片里保存或取消。</div>

		<ul v-if="touches.length" class="tm-list">
			<li v-for="t in touches" :key="t.id" class="tm-item" :class="{open: selectedId === t.id}">
				<div class="tm-item-top">
					<button class="tm-name" @click="emit('select', t.id)" :aria-pressed="selectedId === t.id">{{ t.name }}</button>
					<span class="tm-size">{{ pct(t.w) }} × {{ pct(t.h) }} · {{ t.gesture === 'tap' ? '点按' : t.gesture === 'swipe' ? '滑动' : '点按/滑动' }}</span>
				</div>
				<div v-if="t.reactionPrompt" class="tm-prompt">反应：{{ t.reactionPrompt }}</div>
				<div v-if="t.prompt" class="tm-prompt">原区域说明：{{ t.prompt }}</div>
				<div class="tm-actions">
					<button class="tm-btn primary" :disabled="!enabled || busy || !!editingId" @click="emit('test', t)">试 AI 一次</button>
					<button class="tm-btn" @click="startEdit(t)">编辑</button>
					<button class="tm-btn danger" @click="emit('remove', t.id)">删除</button>
				</div>
				
				<div v-if="editingId === t.id" class="tm-edit">
					<div class="tm-field">
						<label>名称</label>
						<input v-model="editName" type="text" spellcheck="false" placeholder="如：头顶、脸颊、肚皮" />
					</div>
					<div class="tm-field">
						<label>触发方式</label>
						<select v-model="editGesture"><option value="both">点按和滑动</option><option value="tap">只点按</option><option value="swipe">只滑动</option></select>
					</div>
					<div class="tm-field">
						<label>希望 Nori 怎么回应（可选）</label>
						<textarea v-model="editPrompt" rows="2" spellcheck="false" placeholder="例如：有点痒，轻轻抱怨一句，符合当前人设" />
					</div>
					<div class="tm-field">
						<label>区域宽度 {{ pct(editWidth) }}</label>
						<input v-model.number="editWidth" @input="previewSize" type="range" min="0.06" :max="Math.max(0.06, 1 - t.x)" step="0.01" />
					</div>
					<div class="tm-field">
						<label>区域高度 {{ pct(editHeight) }}</label>
						<input v-model.number="editHeight" @input="previewSize" type="range" min="0.06" :max="Math.max(0.06, 1 - t.y)" step="0.01" />
					</div>
					<div class="tm-edit-actions">
						<button class="tm-btn" @click="cancelEdit">取消</button>
						<button class="tm-btn primary" @click="saveEdit">保存</button>
					</div>
				</div>
			</li>
		</ul>
		<p v-else-if="!hasDraft" class="tm-empty">
			还没有触摸区域。<br/>点「＋ 新增区域」，然后在模型上画矩形。
		</p>

		
		<div v-if="hasDraft" class="tm-edit tm-new">
			<div class="tm-field">
				<label>名称</label>
				<input v-model="name" type="text" spellcheck="false" placeholder="如：头顶、脸颊、肚皮" />
			</div>
			<div class="tm-field">
				<label>触发方式</label>
				<select v-model="gesture"><option value="both">点按和滑动</option><option value="tap">只点按</option><option value="swipe">只滑动</option></select>
			</div>
			<div class="tm-field">
				<label>希望 Nori 怎么回应（可选）</label>
				<textarea v-model="prompt" rows="2" spellcheck="false" placeholder="例如：有点痒，轻轻抱怨一句，符合当前人设" />
			</div>
			<div class="tm-edit-actions">
				<button class="tm-btn" @click="emit('resetDraft')">取消</button>
				<button class="tm-btn primary" @click="submitNew">添加</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.touch-manager { display: flex; flex-direction: column; gap: 10px; }
.tm-head { display: flex; align-items: center; }
.tm-title { font-size: 14px; font-weight: 600; color: #f1f5f9; }
.tm-count { margin-left: auto; font-size: 11px; color: #94a3b8; }
.tm-switches { display: flex; flex-direction: column; gap: 8px; }
.tm-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px; border-radius: 10px; background: rgba(30,41,59,0.62); }
.tm-switch-row span { display: flex; flex-direction: column; gap: 2px; }
.tm-switch-row b { color: #e2e8f0; font-size: 12px; font-weight: 600; }
.tm-switch-row small { color: #94a3b8; font-size: 11px; }
.tm-switch-row input { width: 19px; height: 19px; accent-color: #38bdf8; }
.tm-cooldown { padding: 7px 9px; border-radius: 8px; color: #a5d8f3; background: rgba(56,189,248,0.09); font-size: 11px; }
.tm-tools { display: flex; gap: 8px; }
.tm-me-btn {
	flex: 1;
	padding: 9px 0;
	border-radius: 10px;
	font-size: 13px;
	border: 1px solid rgba(148, 163, 184, 0.22);
	background: rgba(51, 65, 85, 0.85);
	color: #e2e8f0;
}
.tm-me-btn.primary.on { background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); color: #fff; }
.tm-me-btn.adj { background: rgba(30, 41, 59, 0.8); color: #7dd3fc; }
.tm-me-btn.adj.on { background: rgba(56, 189, 248, 0.18); border-color: rgba(56, 189, 248, 0.6); color: #7dd3fc; }
.tm-me-btn.test { background: rgba(16, 185, 129, 0.1); color: #86efac; }
.tm-me-btn.test.on { background: rgba(16, 185, 129, 0.22); border-color: rgba(110,231,183,0.55); }
.tm-hint {
	font-size: 12px; color: #fbbf24; background: rgba(251,191,36,0.12);
	border-radius: 8px; padding: 8px 10px; line-height: 1.6;
}
.tm-hint.warn { color: #7dd3fc; background: rgba(56, 189, 248, 0.12); }
.tm-list { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; }
.tm-item {
	border-radius: 10px; padding: 10px 12px;
	background: rgba(30,41,59,0.6); border-left: 3px solid #60a5fa;
}
.tm-item.open { border-color: #7dd3fc; }
.tm-item-top { display: flex; align-items: center; gap: 6px; }
.tm-name { flex: 1; min-width: 0; text-align: left; border: 0; background: none; padding: 4px 0; font-size: 13px; color: #e2e8f0; cursor: pointer; }
.tm-size { font-size: 11px; color: #94a3b8; }
.tm-prompt { margin-top: 4px; font-size: 12px; color: #94a3b8; }
.tm-actions { margin-top: 8px; display: flex; gap: 8px; }
.tm-btn {
	padding: 6px 12px; font-size: 12px; border-radius: 8px;
	background: rgba(51,65,85,0.85); color: #cbd5e1; border: 1px solid rgba(148,163,184,0.2);
	&.danger { color: #fca5a5; }
	&.primary { background: linear-gradient(135deg,#38bdf8,#6366f1); color: #fff; }
	&:disabled { opacity: 0.45; }
}
.tm-empty { text-align: center; color: #64748b; font-size: 13px; padding: 8px 0; line-height: 1.6; }
.tm-edit {
	border-radius: 12px; padding: 12px;
	background: rgba(30,41,59,0.7); border: 1px solid rgba(148,163,184,0.2);
	display: flex; flex-direction: column; gap: 8px;
	margin-top: 10px;
}
.tm-new { border-color: rgba(56,189,248,0.45); background: rgba(30,41,59,0.85); }
.tm-field { display: flex; flex-direction: column; gap: 5px; label { font-size: 12px; color: #94a3b8; } }
.tm-field input:not([type=range]), .tm-field select, .tm-field textarea {
	background: rgba(30,41,59,0.9); border: 1px solid rgba(148,163,184,0.25);
	border-radius: 8px; padding: 9px 11px; color: #e2e8f0; font-size: 13px; outline: none;
}
.tm-field input[type=range] { width: 100%; accent-color: #38bdf8; }
.tm-field textarea { resize: vertical; min-height: 52px; font: inherit; }
.tm-edit-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
