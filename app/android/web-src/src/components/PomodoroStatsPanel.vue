<template>
<div class="pomo-stats-toolbar"><button class="mini" @click="emit('back')">‹ 返回计时</button><span>{{ pomoStatsReady ? '每一段努力，都算数' : '记录暂不可用' }}</span></div>
                            <div v-if="pomoError" class="hint">{{ pomoError }} <button class="mini" @click="pomoRefresh()">重试</button></div>
                            <template v-if="pomoStatsReady">
                            <div class="pomo-range"><button v-for="r in ([7,30,365] as const)" :key="r" class="pomo-rbtn" :class="{on: pomoRange === r}" @click="pomoRange = r">{{ r === 365 ? '近一年' : `近 ${r} 天` }}</button></div>
                            <div class="pomo-range-overview"><b>{{ pomoRangeSummary.rangeMin }}<small> 分钟</small></b><span>完成 {{ pomoRangeSummary.rangeDone }} 个 · 单日最佳 {{ pomoRangeSummary.rangeBest }} 分钟</span></div>
                            <div v-if="pomoRange <= 30" class="pomo-bars pomo-selectable-bars" :class="{dense: pomoRange === 30}"><button v-for="d in pomoRangeBars" :key="d.day" class="pb-col" :aria-label="`${d.day}，${d.min} 分钟`" @click="pomoSelectDate(d.day)"><i :style="{height: d.h + '%'}"></i><span>{{ d.label }}</span></button></div>
                            <div v-if="pomoSummary.todayRate >= 0" class="pomo-sub">今日倒计时完成率 {{ Math.round(pomoSummary.todayRate * 100) }}%<span v-if="pomoSummary.todayAvgMin > 0">平均完成段 {{ pomoSummary.todayAvgMin }} 分钟</span></div>
                            <!-- 独立统计页: 一年热力图 (点格子看某天) + 终身累计 + 月度汇总 -->
							<div class="settings-row">
								<label>近一年</label>
								<!-- 52 列 × 11px ≈ 572px, 比面板(约 260px)宽 → 必须放可横滚容器里,
								     否则会溢出面板。canvas 用像素尺寸绘制, 不随容器缩放。 -->
								<div class="pomo-heat-wrap">
									<canvas
										:ref="setHeatCanvas"
										class="pomo-heat"
										@click="onHeatClick"
									></canvas>
								</div>
								<div class="pomo-heat-legend">
									<span class="mh-label">少</span>
									<i v-for="lv in [1, 2, 3, 4]" :key="lv" :class="'mh-lv' + lv"></i>
									<span class="mh-label">多</span>
								</div>
								<div class="hint" v-if="!pomoSelectedDay">点任意格子查看那一天的专注情况。</div>
								<label class="pomo-date-picker">选择日期<input type="date" :max="pomoDayKey(pomoDate)" @change="pomoSelectDate(($event.target as HTMLInputElement).value)" /></label>
								<div class="pomo-daybox" v-if="pomoSelectedDay">
									<b>{{ pomoSelectedDay.date }}</b>
									<span>{{ pomoSelectedDay.min }} 分钟 · 完成 {{ pomoSelectedDay.done }} · 中断 {{ pomoSelectedDay.abort }}</span>
								</div>
							</div>
							<div class="settings-row">
								<label>累计</label>
								<span class="pomo-today">
									总专注 {{ fmtTotalMin((pomoStats.total?.focusMin || 0) + (pomoStats.total?.countUpMin || 0)) }}
									· 完成 {{ pomoStats.total?.done || 0 }} 个
									<span v-if="(pomoStats.total?.countUpMin || 0) > 0"> · 其中正向 {{ fmtTotalMin(pomoStats.total?.countUpMin || 0) }}</span>
								</span>
								<div class="pomo-sub">
									<span>最好的一天 {{ Math.round(pomoStats.best?.dayMin || 0) }} 分钟</span>
									<span>最长连续 {{ pomoStats.best?.streak || 0 }} 天</span>
								</div>
							</div>
							<div class="settings-row">
								<label>近 12 个月</label>
								<div class="pomo-months">
									<div v-for="m in pomoMonths" :key="m.month" class="pm-row">
										<span class="pm-name">{{ m.month.slice(2) }}</span>
										<span class="pm-bar"><i :style="{width: monthPercent(m.min, pomoMonths) + '%'}"></i></span>
										<span class="pm-val">{{ m.min }} 分 · {{ m.done }} 个</span>
									</div>
								</div>
							</div>
							<div class="hint">有效专注记录长期保留。总专注包含倒计时与正向计时，不包含休息。</div>
                            </template>
</template>

<script setup lang="ts">
import {toRefs, type ComponentPublicInstance} from "vue"
import {monthPercent} from "../services/pomodoro"
import type {PomodoroModel} from "../composables/usePomodoro"

type StatsModel = Pick<PomodoroModel,
    "pomoStatsReady" | "pomoError" | "pomoRefresh" | "pomoRange" | "pomoRangeSummary" | "pomoRangeBars" | "pomoSelectDate" | "pomoSummary" | "onHeatClick" | "pomoSelectedDay" | "pomoDayKey" | "pomoDate" | "fmtTotalMin" | "pomoStats" | "pomoMonths" | "pomoHeatCanvas">
const props = defineProps<{model: StatsModel}>()
const emit = defineEmits<{back: []}>()
const {pomoStatsReady, pomoError, pomoRefresh, pomoRange, pomoRangeSummary, pomoRangeBars, pomoSelectDate, pomoSummary, onHeatClick, pomoSelectedDay, pomoDayKey, pomoDate, fmtTotalMin, pomoStats, pomoMonths} = toRefs(props.model)
const setHeatCanvas = (el: Element | ComponentPublicInstance | null): void => {
    props.model.pomoHeatCanvas = el instanceof HTMLCanvasElement ? el : null
}
</script>

<style lang="less" scoped>
@import "../assets/style/dialog-controls.less";
.pomo-stats-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px;font-size:11px;color:var(--px-grey)}
.pomo-range-overview{display:flex;flex-direction:column;gap:8px;padding:18px 0;color:var(--px-grey);font-size:11px}
.pomo-range-overview b{font-size:30px;color:var(--px-white);font-weight:500}.pomo-range-overview small{font-size:12px;font-weight:400}
.pomo-date-picker{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--px-grey);margin-top:14px}.pomo-date-picker input{min-height:44px;background:var(--px-bg);color:var(--px-text);border:1px solid var(--px-stroke);border-radius:var(--ui-radius-ctl);padding:8px;color-scheme:dark}
.pomo-selectable-bars button{border:0;background:none;padding:0;cursor:pointer;min-width:0}.pomo-selectable-bars button:focus-visible{outline:1px solid var(--px-cyan)}
.pomo-today { color: var(--px-white); font-size: 13px }
/* 完成率/平均每段: 次级信息, 弱化显示 */
.pomo-sub { display: flex; gap: 12px; margin-top: 2px; font-size: 11px; color: var(--px-dim) }
.pomo-bars {
	display: flex;
	align-items: flex-end;
	gap: 8px;
	height: 74px;
	padding: 6px 10px;
	background: rgba(255, 255, 255, 0.04);
	border-radius: var(--ui-radius-ctl);
	margin: 4px 0 8px;
}
.pomo-bars .pb-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100% }
.pomo-bars .pb-col i { width: 100%; max-width: 22px; border-radius: var(--ui-radius-ctl) 4px 0 0; background: linear-gradient(180deg, var(--px-cyan), var(--px-cyan-dim)) }
/* 柱顶常显分钟数: 手机上 hover 不可用, 原先的 title 等于看不到 */
.pomo-bars .pb-col .pb-val { font-size: 10px; font-weight: 600; color: var(--px-grey); margin-bottom: 2px }
.pomo-bars .pb-col span { font-size: 10px; color: var(--px-dim); margin-top: 4px }
/* 30/365 天档: 柱子变窄、间隙变小, 否则一根不到 1px 看不清 */
.pomo-bars.dense { gap: 1px; padding: 6px 6px }
.pomo-bars.dense .pb-col i { max-width: 100%; border-radius: 2px 2px 0 0 }
.pomo-bars.dense .pb-col span { font-size: 8px; margin-top: 2px }
/* 范围切换器 */
.pomo-range { display: flex; gap: 6px; margin: 2px 0 6px }
.pomo-rbtn {
	min-height:44px;
	flex: 1;
	padding: 6px 0;
	border-radius: var(--ui-radius-card);
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: var(--px-grey);
	font-size: 12px;
	&.on { background: var(--px-cyan-deep); border-color: var(--px-cyan); color: var(--px-white) }
	&.all { flex: 0 0 auto; padding: 6px 12px; color: var(--accent) }
}
/* 热力图容器: 一年 52 列比面板宽, 必须可横向滚动 */
.pomo-heat-wrap { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; padding-bottom: 4px }
.pomo-heat { display: block; image-rendering: pixelated; cursor: pointer }
.pomo-heat-legend { display: flex; align-items: center; gap: 4px; margin-top: 6px; justify-content: flex-end }
.pomo-heat-legend .mh-label { font-size: 10px; color: var(--px-dim) }
.pomo-heat-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block }
.mh-lv1 { background: var(--px-cyan); opacity: .35 }
.mh-lv2 { background: var(--px-cyan); opacity: .55 }
.mh-lv3 { background: var(--px-cyan); opacity: .78 }
.mh-lv4 { background: var(--px-cyan) }
.pomo-daybox {
	display: flex; flex-direction: column; gap: 2px;
	margin-top: 6px; padding: 8px 10px;
	background: var(--px-cyan-deep);
	border: 1px solid var(--px-cyan-deep);
	border-radius: var(--ui-radius-ctl);
	b { font-size: 13px; color: var(--px-white) }
	span { font-size: 12px; color: var(--px-grey) }
}
/* 月度汇总条 */
.pomo-months { display: flex; flex-direction: column; gap: 4px }
.pm-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--px-grey) }
.pm-name { flex: 0 0 44px; color: var(--px-dim) }
.pm-bar { flex: 1; height: 7px; border-radius: var(--ui-radius-ctl); background: var(--line-soft); overflow: hidden }
.pm-bar i { display: block; height: 100%; border-radius: var(--ui-radius-ctl); background: linear-gradient(90deg, var(--px-cyan-dim), var(--px-cyan)) }
.pm-val { flex: 0 0 92px; text-align: right }

.settings-row {
    padding: 14px;
    display: flex; flex-direction: column; gap: 6px;
    border: 1px solid var(--px-line);
    background: var(--px-panel);
    border-radius: var(--ui-radius-card);
    margin-bottom: 14px;
    label { font-size: 13px; color: var(--fg-2); }
}
.pomo-months { margin-top: 14px; }

</style>
