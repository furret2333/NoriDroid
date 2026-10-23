<script setup lang="ts">
import {computed, ref, watch} from "vue"
import type {PomoConfig} from "../services/pomodoro"
const props = defineProps<{
  config: PomoConfig; phase: string; paused: boolean; time: string; percent: number; phaseText: string
  endText: string; goal: string; sessionId: string; rounds: number; longEvery: number; cycleEnabled: boolean
  savedMin: number; liveMin: number; done: number; streak: number; ready: boolean; busy: boolean
  error: string; message: string; syncText: string; reminderText: string; reminderAction: string
  quietHeld: boolean; rebootPending: boolean; bars: {day: string; label: string; min: number; h: number}[]
  restorePreview: string; confirmStop: boolean
}>()
const emit = defineEmits<{
  action: [kind: string]; reminder: [kind: string]; export: [kind: "json" | "csv"]
}>()
const confirmEnd = ref(props.confirmStop)
watch(() => props.confirmStop, value => { confirmEnd.value = value })
watch(() => [props.sessionId, props.phase], () => { confirmEnd.value = false })
const selectedBar = ref("")
const active = computed(() => props.phase !== "idle")
const goalPct = computed(() => props.config.dailyGoal ? Math.min(100, (props.savedMin + props.liveMin) / props.config.dailyGoal * 100) : 0)
const barText = computed(() => props.bars.find(b => b.day === selectedBar.value))
const stop = () => { if (props.phase === "focus") confirmEnd.value = true; else emit("action", "stop") }
</script>

<template>
  <div class="focus-panel">
    <div class="focus-intro"><span class="focus-eyebrow">Nori · 专注时光</span><span class="focus-companion">一点一点，也是在向前</span></div>
    <section class="focus-clock" :class="{'is-rest': phase === 'break', 'is-paused': paused}">
      <div class="focus-clock-top"><span class="focus-status"><i></i>{{ phaseText }}</span><span v-if="cycleEnabled" class="focus-round">已完成 {{ rounds }} 段 · 每 {{ longEvery }} 段长休息</span><span v-else class="focus-round">{{ phase === 'countUp' ? '跟随自己的节奏' : '留一段时间给自己' }}</span></div>
      <div class="focus-time">{{ active ? time : String(config.focusMin).padStart(2, '0') + ':00' }}</div>
      <div class="focus-end">{{ endText || (active ? 'Nori 陪你，慢慢来' : '准备好了，就从这一刻开始') }}</div>
      <div v-if="active && phase !== 'countUp'" class="focus-track"><i :style="{transform: `scaleX(${percent / 100})`}"></i></div>
      <div v-if="active && goal" class="focus-current-goal">{{ goal }}</div>
      <label v-if="!active" class="focus-goal-input"><span>这段想做什么</span><input v-model="config.goal" maxlength="100" placeholder="写几页书、读一会儿…也可以留空" /></label>
      <div v-if="rebootPending" class="focus-recovery" role="status"><b>检测到设备重启</b><p>正向计时已暂停。是否把离线时段计入本段？</p><div class="focus-actions"><button @click="emit('action', 'rebootExclude')">不计入，继续</button><button @click="emit('action', 'rebootInclude')">计入并继续</button></div></div>
      <div v-else class="focus-actions pomo-act">
        <button v-if="!active" class="focus-primary pomo-go" :disabled="busy" @click="emit('action', 'start')"><span>▶</span> 开始专注</button>
        <button v-if="!active" class="pomo-go alt" :disabled="busy" @click="emit('action', 'countUp')">正向计时 ↗</button>
        <button v-if="active" class="focus-primary" :disabled="busy" @click="emit('action', 'pause')">{{ paused ? '▶ 继续' : 'Ⅱ 暂停' }}</button>
        <button v-if="active" :disabled="busy" @click="stop">{{ phase === 'break' ? '结束休息' : '结束并保存' }}</button>
      </div>
      <button v-if="active && !rebootPending" class="focus-switch" :disabled="busy" @click="emit('action', phase === 'countUp' ? 'start' : 'countUp')">{{ phase === 'countUp' ? '保存本段，转倒计时' : '保存本段，转正向计时' }} ↗</button>
      <div v-if="confirmEnd && phase === 'focus'" class="focus-confirm" role="alertdialog" aria-label="结束专注"><b>结束这一段？</b><p>已经专注的时间会保留，本次不计完整番茄。</p><div class="focus-actions"><button @click="confirmEnd = false">继续专注</button><button :disabled="busy" @click="confirmEnd = false; emit('action', 'stop')">确认结束并保存</button></div></div>
    </section>
    <div v-if="error" class="focus-notice is-error" role="alert"><span>{{ error }}</span><button @click="emit('action', 'retry')">重试</button></div>
    <div v-if="message" class="focus-notice" role="status">{{ message }}</div>
    <section class="focus-today">
      <div class="focus-section-head"><h3>今天的积累</h3><button @click="emit('action', 'stats')">查看统计 ↗</button></div>
      <div class="focus-metrics"><div><strong>{{ ready ? savedMin : '—' }}<small>分钟</small></strong><span>已记录</span></div><div><strong>{{ liveMin }}<small>分钟</small></strong><span>本段进行中</span></div><div><strong>{{ ready ? done : '—' }}<small>个</small></strong><span>完成番茄</span></div></div>
      <div v-if="config.dailyGoal > 0" class="focus-daily"><div><span>每日目标 {{ config.dailyGoal }} 分钟</span><span>{{ Math.round(goalPct) }}%</span></div><div class="focus-track"><i :style="{transform: `scaleX(${goalPct / 100})`}"></i></div></div>
      <p class="focus-footnote">{{ streak > 1 ? `已经连续专注 ${streak} 天。` : '每一小段投入，都值得记下来。' }}{{ liveMin > 0 ? ' 进行中时间在本段结束后保存。' : '' }}</p>
    </section>
    <section class="focus-plan">
      <div class="focus-section-head"><h3>专注节奏</h3><span v-if="active" class="focus-footnote">修改后下次生效</span></div>
      <div class="focus-presets"><button v-for="p in [[25,5],[50,10],[52,17],[90,20],[15,3]]" :key="p[0]" :class="{selected: config.focusMin === p[0] && config.breakMin === p[1]}" @click="config.focusMin=p[0]; config.breakMin=p[1]"><b>{{ p[0] }}</b><span> / {{ p[1] }}</span></button></div>
      <div class="focus-fields"><label><span>专注 · 分钟</span><input v-model.number="config.focusMin" type="number" min="5" max="120" /></label><label><span>休息 · 分钟</span><input v-model.number="config.breakMin" type="number" min="1" max="30" /></label></div>
    </section>
    <section class="focus-week"><div class="focus-section-head"><h3>最近 7 天</h3><span class="focus-footnote">{{ barText ? `${barText.day} · ${barText.min} 分钟` : '点选查看每天的积累' }}</span></div><div class="focus-bars"><button v-for="bar in bars" :key="bar.day" :aria-label="`${bar.day}，${bar.min} 分钟`" :class="{selected: selectedBar === bar.day}" @click="selectedBar = bar.day"><span class="focus-bar-space"><i :style="{height: `${bar.h}%`}"></i></span><small>{{ bar.label || bar.day.slice(8) }}</small></button></div></section>
    <details class="focus-options"><summary>循环与提醒 <span>节奏，由你决定</span></summary><div class="focus-option-body">
      <label class="focus-toggle"><span>专注完成后自动休息</span><input v-model="config.autoBreak" type="checkbox" /></label>
      <label class="focus-toggle"><span>休息后自动开始下一段</span><input v-model="config.autoFocus" type="checkbox" /></label><p class="focus-footnote">离线很久后只恢复已有记录，不自动补出多轮专注。</p>
      <label class="focus-toggle"><span>循环长休息</span><input v-model="config.cycleEnabled" type="checkbox" /></label>
      <div v-if="config.cycleEnabled" class="focus-fields"><label><span>每完成几段</span><input v-model.number="config.longEvery" type="number" min="2" max="12" /></label><label><span>长休息 · 分钟</span><input v-model.number="config.longBreakMin" type="number" min="1" max="60" /></label></div>
      <label class="focus-toggle"><span>系统通知与计时控制</span><input v-model="config.notify" type="checkbox" @change="emit('action', 'notify')" /></label>
      <div class="focus-notice"><span>{{ reminderText }}</span><button v-if="config.notify && reminderAction" @click="emit('reminder', reminderAction)">去开启 ↗</button></div>
      <label class="focus-field"><span>每日目标 · 分钟（0 为不设置）</span><input v-model.number="config.dailyGoal" type="number" min="0" max="720" /></label>
    </div></details>
    <details class="focus-options"><summary>陪伴与安静 <span>专注时少一点打扰</span></summary><div class="focus-option-body">
      <label class="focus-toggle"><span>专注期间保持安静</span><input v-model="config.quietFocus" type="checkbox" /></label><label class="focus-toggle"><span>休息期间保持安静</span><input v-model="config.quietBreak" type="checkbox" /></label><label class="focus-toggle"><span>暂停期间保持安静</span><input v-model="config.quietPaused" type="checkbox" /></label>
      <label class="focus-field"><span>提前结束后继续安静</span><select v-model.number="config.sulkMin"><option :value="0">手动恢复</option><option v-for="n in [5,10,15]" :key="n" :value="n">{{ n }} 分钟</option></select></label>
      <label class="focus-field"><span>开始与结束的反馈</span><select v-model="config.feedback"><option value="gentle">温和陪伴</option><option value="character">角色互动</option><option value="silent">仅计时，不播报</option></select></label>
      <p class="focus-footnote">安静时暂停音乐与主动搭话，朗读和按键音保留。手动修改全局安静设置后，以你的选择为准。</p><button v-if="quietHeld" class="focus-text-button" @click="emit('action', 'quietRestore')">立即恢复声音与主动搭话</button>
    </div></details>
    <details class="focus-options"><summary>记录与备份 <span>把每一段努力留下</span></summary><div class="focus-option-body"><p class="focus-footnote">{{ syncText }}</p><div class="focus-actions"><button :disabled="!ready || busy" @click="emit('export', 'json')">导出 JSON 备份</button><button :disabled="!ready || busy" @click="emit('export', 'csv')">导出 CSV 表格</button></div><button class="focus-text-button" :disabled="active || busy" @click="emit('action', 'import')">从 JSON 备份恢复 ↗</button><p class="focus-footnote">恢复会替换现有记录，并保留恢复前副本；计时中请先结束本段。</p><div v-if="restorePreview" class="focus-confirm"><b>恢复预览</b><p>{{ restorePreview }}</p><div class="focus-actions"><button @click="emit('action', 'cancelRestore')">取消</button><button @click="emit('action', 'restore')">确认替换记录</button></div></div></div></details>
    <p class="focus-footer">时间会积累。你也可以慢慢来。</p>
  </div>
</template>

<style scoped>
.focus-panel{--focus-accent:var(--px-cyan);--focus-soft:var(--px-cyan-deep);color:var(--px-text);display:grid;gap:18px;padding:2px 0 10px}
.focus-intro,.focus-clock-top,.focus-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.focus-eyebrow{font-size:11px;letter-spacing:2px;color:var(--px-cyan)}.focus-companion{font-size:11px;color:var(--px-grey)}
.focus-clock{position:relative;border:1px solid var(--px-stroke);border-radius:var(--ui-radius-card);background:radial-gradient(ellipse at 50% 10%,var(--focus-soft),transparent 75%),var(--px-bg);padding:22px;overflow:hidden}.focus-clock.is-rest{--focus-accent:var(--px-hilite)}.focus-clock.is-paused{--focus-accent:var(--px-grey)}
.focus-status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--focus-accent)}.focus-status i{width:6px;height:6px;background:currentColor;border-radius:50%;box-shadow:0 0 10px var(--focus-accent)}.is-paused .focus-status i{box-shadow:none}.focus-round{font-size:10px;color:var(--px-grey)}
.focus-time{text-align:center;font:500 clamp(48px,12vw,70px)/1.2 ui-monospace,monospace;font-variant-numeric:tabular-nums;letter-spacing:-3px;margin:22px 0 8px;color:var(--px-white)}.focus-end{text-align:center;color:var(--px-grey);font-size:12px;min-height:18px;margin-bottom:22px}.focus-current-goal{text-align:center;overflow-wrap:anywhere;font-size:13px;padding:14px 0 2px}.focus-track{height:4px;background:var(--px-line);border-radius:var(--ui-radius-pill);overflow:hidden}.focus-track i{display:block;width:100%;height:100%;transform-origin:left;background:var(--focus-accent);transition:transform .3s linear}
.focus-goal-input{display:block;margin:8px 0 18px}.focus-goal-input>span,.focus-field>span,.focus-fields label>span{display:block;color:var(--px-grey);font-size:11px;margin-bottom:8px}.focus-panel input:not([type=checkbox]),.focus-panel select{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--px-line);background:var(--px-bg);color:var(--px-text);border-radius:var(--ui-radius-ctl);padding:11px 12px;font:inherit;font-size:13px;min-height:44px}.focus-panel input::placeholder{color:var(--px-grey);opacity:.7}.focus-panel input:focus,.focus-panel select:focus{outline:1px solid var(--px-cyan);border-color:var(--px-cyan)}
.focus-actions{display:flex;gap:10px;margin-top:16px}.focus-panel button{cursor:pointer;font:inherit}.focus-actions button{flex:1;min-height:46px;border:1px solid var(--px-stroke);background:var(--px-panel-2);color:var(--px-text);border-radius:var(--ui-radius-ctl);padding:10px 8px;font-size:12px}.focus-actions .focus-primary{background:var(--px-cyan);border-color:var(--px-cyan);color:var(--px-bg);font-weight:700}.focus-panel button:disabled{opacity:.45;cursor:default}.focus-panel button:focus-visible,.focus-panel summary:focus-visible{outline:2px solid var(--px-hilite);outline-offset:3px}.focus-switch,.focus-text-button{display:block;border:0;background:none;color:var(--px-cyan);font-size:11px;min-height:44px;padding:10px 0}.focus-switch{margin:4px auto -10px}.focus-section-head h3{font-size:13px;font-weight:600;margin:0}.focus-section-head>button{border:0;background:none;color:var(--px-cyan);font-size:11px;padding:7px 0;min-height:36px}
.focus-today,.focus-plan,.focus-week{border:1px solid var(--px-line);border-radius:var(--ui-radius-card);padding:16px;background:var(--px-panel)}.focus-metrics{display:grid;grid-template-columns:repeat(3,1fr);margin:14px 0 18px;gap:10px}.focus-metrics>div{display:flex;flex-direction:column;gap:7px}.focus-metrics strong{font-size:26px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--px-white)}.focus-metrics small{font-size:10px;margin-left:4px;color:var(--px-grey);font-weight:400}.focus-metrics>div>span{font-size:10px;color:var(--px-grey)}.focus-daily>div:first-child{display:flex;justify-content:space-between;font-size:10px;color:var(--px-grey);margin:8px 0}.focus-footnote{font-size:11px;line-height:1.7;color:var(--px-grey);margin:9px 0 0;overflow-wrap:anywhere}.focus-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.focus-presets{display:flex;gap:7px;margin:15px 0;flex-wrap:wrap}.focus-presets button{flex:1;min-height:44px;padding:8px 5px;border:1px solid var(--px-line);border-radius:var(--ui-radius-ctl);background:var(--px-bg);color:var(--px-grey);white-space:nowrap;font-size:11px}.focus-presets b{font-weight:600;font-size:14px;color:var(--px-text)}.focus-presets .selected{background:var(--px-cyan-deep);border-color:var(--px-cyan);color:var(--px-cyan)}
.focus-bars{display:grid;grid-template-columns:repeat(7,1fr);height:96px;gap:8px;margin-top:14px}.focus-bars button{display:flex;flex-direction:column;align-items:center;gap:7px;border:0;background:none;padding:0;color:var(--px-grey);min-width:0}.focus-bar-space{display:flex;align-items:flex-end;width:100%;height:72px;background:var(--px-bg);border-radius:var(--ui-radius-ctl);overflow:hidden}.focus-bar-space i{display:block;width:100%;background:var(--px-cyan-dim);border-top:2px solid var(--px-cyan)}.focus-bars .selected i{background:var(--px-cyan)}.focus-bars small{font-size:10px}
.focus-options{border:1px solid var(--px-line);border-radius:var(--ui-radius-card);overflow:hidden;background:var(--px-panel)}.focus-options summary{cursor:pointer;padding:17px 16px;font-size:12px;min-height:20px}.focus-options summary>span{float:right;color:var(--px-grey);font-size:10px;padding-top:1px}.focus-option-body{padding:0 16px 16px;display:grid;gap:12px}.focus-toggle{display:flex;align-items:center;justify-content:space-between;gap:15px;min-height:44px;font-size:12px}.focus-toggle input{accent-color:var(--px-cyan);width:19px;height:19px;flex-shrink:0}.focus-field{display:block}.focus-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid var(--px-stroke);border-radius:var(--ui-radius-ctl);font-size:11px;line-height:1.7;background:var(--px-bg);overflow-wrap:anywhere}.focus-notice button{border:0;color:var(--px-cyan);background:none;white-space:nowrap;min-height:36px}.focus-notice.is-error{border-color:var(--px-cyan);color:var(--px-hilite)}.focus-confirm,.focus-recovery{padding:14px;margin-top:16px;background:var(--px-panel-2);border:1px solid var(--px-stroke);border-radius:var(--ui-radius-ctl);font-size:12px}.focus-confirm p,.focus-recovery p{line-height:1.7;font-size:11px;color:var(--px-grey);margin-bottom:0}.focus-footer{text-align:center;font-size:10px;letter-spacing:1px;color:var(--px-grey);margin:0;padding:5px 0}
@media(max-width:380px){.focus-clock{padding:17px}.focus-companion{display:none}.focus-options summary>span{display:none}.focus-metrics strong{font-size:23px}.focus-round{font-size:9px}}
@media(prefers-reduced-motion:reduce){.focus-track i{transition:none}}
</style>
