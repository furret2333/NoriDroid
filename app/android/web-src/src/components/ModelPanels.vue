<template>
<template v-if="panel === 'model'">
	<div v-if="listError" class="empty">{{ listError }}</div>
	<div v-else-if="!modelList.length" class="empty">正在获取模型列表…</div>
	<div v-else class="grid">
		<div v-for="m in modelList" :key="m.id" class="mc" :class="{on: m.id === currentModelId}" @click="emit('pick', m.id)">
			<div class="thumb"><img :src="coverUrl(m.id)" @error="hideThumb" /></div>
			<div class="mname">{{ m.name }}</div>
		</div>
	</div>
</template>


<template v-else-if="panel === 'motion'">
	<div v-if="!motions.length" class="empty">暂无动作</div>
	<div v-for="g in motions" :key="g.group" class="grp">
		<div class="grp-name">{{ g.group }}</div>
		<div class="chips">
			<button v-for="(n, i) in g.names" :key="n" class="chip ripple" @click="emit('motion', g.group, i)">{{ n }}</button>
		</div>
	</div>
</template>


<template v-else-if="panel === 'expression'">
	<div v-if="!expressions.length" class="empty">暂无表情</div>
	<div class="chips">
		<button class="chip w ripple" @click="emit('clear-expression')">清除</button>
		<button v-for="n in expressions" :key="n" class="chip ripple" @click="emit('expression', n)">{{ n }}</button>
	</div>
</template>
</template>

<script setup lang="ts">
import {coverUrl} from "../services/gateway/api"
import type {MotionGroup} from "../services/live2d"

defineProps<{
 panel: string
 modelList: {id: string; name: string}[]
 currentModelId: string
 listError: string
 motions: MotionGroup[]
 expressions: string[]
}>()
const emit = defineEmits<{
 pick: [id: string]
 motion: [group: string, index: number]
 expression: [name: string]
 "clear-expression": []
}>()
const hideThumb = (e: Event) => { (e.currentTarget as HTMLElement).style.visibility = "hidden" }
</script>

<style lang="less" scoped>
@import "../assets/style/dialog-controls.less";
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.mc {
	border-radius: var(--ui-radius-card); overflow: hidden;
	background: rgba(30, 41, 59, 0.6);
	border: 2px solid transparent;
	cursor: pointer;
	.thumb { width: 100%; height: 130px; background: #1e293b; }
	img { width: 100%; height: 130px; object-fit: cover; display: block; }
	&.on { border-color: var(--accent-strong); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); }
}
.mname { padding: 8px 10px 10px; font-size: 14px; color: var(--fg); }

.empty { padding: 24px 0; text-align: center; color: var(--fg-dim); font-size: 14px; }
.grp { margin-bottom: 14px; }
.grp-name { font-size: 13px; color: var(--fg-3); padding: 6px 2px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
	padding: 7px 12px; border-radius: var(--ui-radius-ctl);
	position: relative; overflow: hidden;
	background: var(--px-panel-2);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	color: var(--px-white); font-size: 13px;
	box-shadow: inset 1px 1px 0 0 var(--ui-hi);
	&:active { background: var(--px-panel); }
}
.chip.w { background: rgba(146, 64, 14, 0.35); border-color: var(--px-red); color: #fecaca; }
</style>
