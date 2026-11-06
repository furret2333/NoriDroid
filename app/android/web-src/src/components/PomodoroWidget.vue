<template>
		<div :ref="setWidgetEl" class="pomo-widget" :class="{mini: pomoMini}" :style="{left: pomoPos.x + 'px', top: pomoPos.y + 'px', width: pomoMini ? 'auto' : pomoPos.w + 'px'}" @pointerdown.stop>
			<template v-if="!pomoMini">
				<div class="pw-head" @pointerdown="onPomoDragDown" @pointermove="onPomoDragMove" @pointerup="onPomoDragUp" @pointercancel="onPomoDragUp">
					<span class="pw-tomato">🍅</span><span>{{ pomoPhaseText }}</span>
					<button class="pw-mini-btn" title="收起" aria-label="收起计时挂件" @pointerdown.stop @click="pomoMini = true; pomoPosSave()">—</button>
				</div>
				<div class="pw-time">{{ pomoFmt }}</div>
				<div v-if="pomo.phase !== 'countUp'" class="pw-bar"><i :style="{transform: 'scaleX(' + pomoPct / 100 + ')'}"></i></div>
				<div class="pw-btns">
					<button :disabled="pomoBusy || pomo.rebootPending" @click="pomoAction('pause')">{{ pomo.paused ? '继续' : '暂停' }}</button>
					<button class="warn" @click="pomoWidgetStop">{{ pomo.phase === 'break' ? '结束休息' : '结束并保存' }}</button>
				</div>
				<i class="pw-grip" @pointerdown="onPomoRzDown" @pointermove="onPomoRzMove" @pointerup="onPomoRzUp" @pointercancel="onPomoRzUp"></i>
			</template>
			<template v-else>
                <div class="pw-mini-group"><span class="pw-mini-drag" title="拖动" @pointerdown="onPomoDragDown" @pointermove="onPomoDragMove" @pointerup="onPomoDragUp" @pointercancel="onPomoDragUp">⠿</span><button class="pw-pill" :aria-label="pomoPhaseText + '，展开计时挂件'" @click="pomoMini = false; pomoPosSave()"><small>{{ pomoPhaseText }}</small>{{ pomoFmt }}</button><button class="pw-mini-control" :disabled="pomoBusy || pomo.rebootPending" :aria-label="pomo.paused ? '继续计时' : '暂停计时'" @click="pomoAction('pause')">{{ pomo.paused ? '▶' : 'Ⅱ' }}</button></div>
			</template>
		</div>
</template>

<script setup lang="ts">
import {toRefs, type ComponentPublicInstance} from "vue"
import type {PomodoroModel} from "../composables/usePomodoro"

type WidgetModel = Pick<PomodoroModel,
    "pomo" | "pomoMini" | "pomoPos" | "pomoPhaseText" | "pomoFmt" | "pomoPct" | "pomoBusy" | "pomoAction" | "pomoWidgetStop" | "pomoPosSave" | "onPomoDragDown" | "onPomoDragMove" | "onPomoDragUp" | "onPomoRzDown" | "onPomoRzMove" | "onPomoRzUp" | "pomoWidgetEl">
const props = defineProps<{model: WidgetModel}>()
const {pomo, pomoMini, pomoPos, pomoPhaseText, pomoFmt, pomoPct, pomoBusy, pomoAction, pomoWidgetStop, pomoPosSave, onPomoDragDown, onPomoDragMove, onPomoDragUp, onPomoRzDown, onPomoRzMove, onPomoRzUp} = toRefs(props.model)
const setWidgetEl = (el: Element | ComponentPublicInstance | null): void => {
    props.model.pomoWidgetEl = el instanceof HTMLElement ? el : null
}
</script>

<style lang="less" scoped>
.pomo-widget {
	position: fixed;
	z-index: 18;
	box-sizing: border-box;
	max-width: calc(100vw - 24px);
	background: var(--px-panel);
	border: 1px solid var(--px-stroke);
	border-radius: var(--ui-radius-card);
	box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
	padding: 10px 12px 14px;
	touch-action: none;
	user-select: none;
}
.pomo-widget.mini { background: transparent; border: none; box-shadow: none; padding: 0 }
.pw-head {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	color: var(--px-cyan);
	cursor: grab;
	touch-action: none;
}
.pw-mini-btn {
	margin-left: auto;
	background: transparent;
	border: none;
	color: var(--px-grey);
	font-size: 14px;
	min-width: 44px;
	min-height: 44px;
}
.pw-tomato { font-size: 13px }
.pw-time {
	font-size: 34px;
	font-weight: 700;
	color: var(--px-white);
	text-align: center;
	margin: 6px 0 6px;
	font-variant-numeric: tabular-nums;
	letter-spacing: 1px;
}
.pw-bar {
	height: 5px;
	border-radius: var(--ui-radius-pill);
	background: rgba(255, 255, 255, 0.09);
	overflow: hidden;
}
.pw-bar i {
	display: block;
	height: 100%;
	border-radius: var(--ui-radius-pill);
	width: 100%;
	transform-origin: left;
	background: var(--px-cyan);
	transition: transform 0.4s linear;
}
.pw-btns {
	display: flex;
	gap: 8px;
	margin-top: 10px;
}
.pw-btns button {
	min-height: 44px;
	flex: 1;
	background: rgba(255, 255, 255, 0.08);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: var(--px-text);
	border-radius: var(--ui-radius-ctl);
	padding: 7px 0;
	font-size: 13px;
}
.pw-btns button.warn { color: var(--px-red); border-color: rgba(255, 150, 130, 0.35) }
.pw-grip {
	position: absolute;
	right: 2px;
	bottom: 2px;
	width: 44px;
	height: 44px;
	cursor: nwse-resize;
	touch-action: none;
	transform: translate(12px,12px);
	background: linear-gradient(135deg, transparent 80%, var(--px-stroke) 80%);
	border-bottom-right-radius: 12px;
}
.pw-pill {
	background: transparent;
	border: none;
	color: var(--px-white);
	border-radius: var(--ui-radius-pill);
	padding: 7px 14px;
	font-size: 15px;
	font-variant-numeric: tabular-nums;
}
.pw-mini-group {display:flex;align-items:center;background:var(--px-panel);border:1px solid var(--px-stroke);border-radius:var(--ui-radius-pill);overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.pw-mini-drag {display:grid;place-items:center;width:30px;min-height:50px;color:var(--px-grey);cursor:grab;touch-action:none}
.pw-pill {display:flex;flex-direction:column;gap:3px;min-height:50px;padding:5px 10px;cursor:pointer}
.pw-pill small{font-size:9px;color:var(--px-cyan)}
.pw-mini-control{min-width:44px;min-height:50px;color:var(--px-cyan);border:0;border-left:1px solid var(--px-line);background:transparent;cursor:pointer}
@media(prefers-reduced-motion:reduce){.pw-bar i{transition:none}}
</style>
