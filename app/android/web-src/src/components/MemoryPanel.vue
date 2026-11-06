<template>
	<!-- C: 顶部统计行 —— 一眼看到"有没有作废/收起/删除的条目"(用户两次没找到入口, 用这个解决可发现性) -->
	<div class="mem-stats">
		长期 {{ nonGoalMemories.length }} · 目标 {{ goals.length }} · 已作废 {{ invalidMems.length }} · 已收起 {{ fadedMems.length }} · 已删除 {{ deletedMems.length }}
	</div>
	<div v-if="!memSearch && !memFilter">
		<!-- 陪着你的事（目标）—— 从一级设置页搬进来 -->
		<div class="mem-sec">
			<div class="mem-sec-title">陪着你的事（目标）<template v-if="goals.length">（{{ goals.length }}）</template></div>
			<div v-if="!goals.length" class="hint">记下一个目标，Nori 每隔几天会自然地问问进展</div>
			<div v-for="g in goals" :key="g.id" class="mem-item">
				<span class="mem-tag src" :class="{inferred: isInferred(g)}" :title="PROV_TIP">{{ memProvenance(g) }}</span>
				<span class="mem-text">🎯 {{ g.content }}</span>
				<button class="mem-op" @click="doRemoveGoal(g.id)">删除</button>
			</div>
			<div class="goal-add">
				<input v-model="goalDraft" placeholder="如：考雅思 7 分 / 坚持跑步" spellcheck="false" @keyup.enter="doAddGoal" />
				<button class="mini ripple" @click="doAddGoal">记下目标</button>
			</div>
		</div>
		<!-- 历史总结 —— 同样从一级页搬进来 -->
		<div class="mem-sec">
			<div class="mem-sec-title">历史总结（{{ memView.summaries.length }} 条）</div>
			<div v-if="!memView.summaries.length" class="hint">
				暂无总结。对话多了之后会自动把早期对话压缩成摘要
			</div>
			<details v-for="s in memView.summaries" :key="s.id" class="mem-summary">
				<summary>{{ summaryLabel(s) }}</summary>
				<div class="mem-summary-content">{{ s.content }}</div>
			</details>
		</div>
	</div>
	<div class="mem-search-row">
		<input v-model="memSearch" class="mem-search-input" placeholder="搜索记忆内容…" spellcheck="false" />
		<select v-model="memFilter" class="mem-search-sel">
			<option value="">全部类型</option>
			<option value="goal">🎯 目标</option>
			<option v-for="(lb, k) in TYPE_LABELS" :key="k" :value="k">{{ lb }}</option>
			<option value="pinned">📌 已固定</option>
		</select>
	</div>
	<div class="mem-count-hint">长期记忆 {{ filteredMems.length }} 条<template v-if="memSearch || memFilter">（筛选结果）</template></div>
	<!-- 「待整理 N 条」(P4): 让"还没进记忆"这件事可见 —— 否则用户说完一句
	     会以为没记住 (实时通道默认关之后尤其需要这个交代)。
	     A+B (2026-09-27 深夜, 实机反馈"点了没用"): 反馈**就地**显示在按钮旁边;
	     没有可整理内容时按钮置灰 + 文案说清, 不再"可点但无事发生"。 -->
	<div class="mem-pending">
		<span v-if="memPending.pending > 0">待整理 {{ memPending.pending }} 条（满 {{ memPending.threshold }} 条自动整理）</span>
		<span v-else>待整理 0 条 · 最近 20 句还在我眼前，攒够 25 句会自动整理</span>
		<button class="mini ripple" :disabled="memOrganizing || !canOrganize" @click="doOrganizeNow">{{ memOrganizing ? "整理中…" : (canOrganize ? "立即整理" : "暂无可整理") }}</button>
	</div>
	<div v-if="memOrgMsg" class="hint mem-org-msg" :class="{ok: memOrgMsgOk, bad: !memOrgMsgOk}">{{ memOrgMsg }}</div>
	<div v-if="!filteredMems.length" class="empty">没有匹配的记忆</div>
	<!-- 记忆库主视图 (P4): **按块**排时间线 (一次历史总结覆盖的一段对话 = 一个块),
	     块内再**按类型分小节** —— 上半句是块, 下半句沿用用户要的类型分组。
	     搜索/筛选时退回按类型平铺 (见 memSections) -->
	<div v-for="sec in memSections" :key="sec.key" class="mem-sec" :class="{ 'mem-block': sec.key !== 'flat' }">
		<div v-if="sec.title" class="mem-sec-title">{{ sec.title }}</div>
		<div v-for="sub in sec.subs" :key="sub.key" class="mem-sec mem-group">
			<div class="mem-sec-title sub">{{ sub.label }}（{{ sub.items.length }}）</div>
			<div v-for="m in sub.items" :key="m.id" class="mem-item">
				<span class="mem-tag src" :class="{inferred: isInferred(m)}" :title="PROV_TIP">{{ memProvenance(m) }}</span>
				<span class="mem-text">
					<span v-if="(m.tags ?? []).includes('goal')" class="mem-ico" title="目标">🎯</span>
					<span v-if="(m.tags ?? []).includes('pinned')" class="mem-ico" title="已固定">📌</span>
					{{ m.content }}
				</span>
				<span class="mem-sub">{{ fmtTs(m.createdAt) }} · 重要度 {{ m.importance.toFixed(2) }}<template v-if="m.decayDays == null"> · 不淡忘</template></span>
				<button class="mem-op" @click="doTogglePin(m)">{{ isPinnedId(m.id) ? "取消固定" : "固定" }}</button>
				<button class="mem-op" title="暂时停用并保留；手动收起后需点「留下」恢复" @click="doFadeMemory(m)">收起</button>
				<button class="mem-op danger" @click="doDeleteMemory(m)">删除</button>
			</div>
		</div>
	</div>
	<!-- 已作废的记忆 (B1 记忆纠正): 被后来说的话取代的旧说法不再注入/召回,
	     但留在库里存档, 点开就能还原 —— 判错的代价从"永久丢"降到"点一下"。
	     C: 没有作废条时也留一行灰字提示, 让这个功能**可见** (否则用户找不到)。 -->
	<details v-if="invalidMems.length && !memSearch && !memFilter" class="mem-sec mem-invalid">
		<summary class="mem-sec-title">已作废（{{ invalidMems.length }}）</summary>
		<div class="hint">这些旧说法已被你后来的话取代，Nori 不会再用；判错了就点「还原」</div>
		<div v-for="m in invalidMems" :key="m.id" class="mem-item">
			<span class="mem-text">{{ m.content }}</span>
			<span class="mem-sub">作废于 {{ fmtTs(m.invalidAt ?? 0) }}</span>
			<button class="mem-op" @click="doRestoreInvalid(m)">还原</button>
		</div>
	</details>
	<!-- C: 空态也留一行, 让"改口会进历史"这件事可见 -->
	<div v-else-if="!memSearch && !memFilter" class="mem-invalid-empty">
		已作废（0）· 你改口时旧说法会留在这里，随时能还原
	</div>
	<!-- 已收起 (2026-09-28, 用户的"暂时收起"): 到期/太久没提的条目自动收在这里。
	     与「已作废」的区别: 作废=被新说法取代; 收起=不再重要, 但它**可能还是真的**。
	     不注入、不召回, 但点「留下」就能放回生效 —— 自动路径永不真删。 -->
	<details v-if="fadedMems.length && !memSearch && !memFilter" class="mem-sec mem-faded">
		<summary class="mem-sec-title">已收起（{{ fadedMems.length }}）</summary>
		<div class="hint">收起表示暂时不用，内容仍保留。手动收起需点「留下」恢复；自动收起可在你之后重新明确提及时恢复。</div>
		<div v-for="m in fadedMems" :key="m.id" class="mem-item">
			<span class="mem-text">{{ m.content }}</span>
			<span class="mem-sub">{{ fadeReasonLabel(m) }} · 收起于 {{ fmtTs(m.fadedAt ?? 0) }}</span>
			<button class="mem-op" @click="doRestoreFaded(m)">留下</button>
		</div>
	</details>
	<!-- 已删除 (2026-09-28, 回收站): 手删的条目带内容留在这里, 可还原; 确认不要再「永久删除」 -->
	<details v-if="deletedMems.length && !memSearch && !memFilter" class="mem-sec mem-deleted">
		<summary class="mem-sec-title">已删除（{{ deletedMems.length }}）</summary>
		<div class="hint">删除后停止使用，旧对话不会重新记回。回收站最多留 20 条；还原保留删除前状态。永久删除移除回收站条目，不清除原聊天或已有导出。</div>
		<div v-for="m in deletedMems" :key="m.id" class="mem-item">
			<span class="mem-text">{{ m.content }}</span>
			<span class="mem-sub">删除于 {{ fmtTs(m.deletedAt ?? 0) }}</span>
			<button class="mem-op" @click="doRestoreDeleted(m)">还原</button>
			<button class="mem-op danger" @click="doDeleteForever(m)">永久删除</button>
		</div>
	</details>
	<!-- 记忆优化 (2026-09-28, 用户提的"整理优化"): 从**你留下的/删掉的**记忆里学口味,
	     把示例写进整理提示词。默认关 —— 早期库里若有垃圾, 学进去会把风味固化。 -->
	<div v-if="!memSearch && !memFilter" class="mem-sec mem-tune">
		<div class="mem-sec-title">记忆优化</div>
		<div class="row-inline">
			<label>自动优化（每新增 20 条记忆刷新示例）</label>
			<input type="checkbox" v-model="cfg.memoryAutoTuneExamples" />
		</div>
		<div class="hint">{{ tuneInfo }}</div>
		<div class="btn-row mem-tune-btns">
			<button class="mini ripple" @click="doRebuildExamples">立即优化</button>
			<button class="mini ripple" @click="tuneShow = !tuneShow">{{ tuneShow ? "收起示例" : "查看示例" }}</button>
			<button class="mini ripple" :disabled="!tuneHas" @click="doClearExamples">清除示例</button>
		</div>
		<div v-if="tuneShow && tuneHas" class="hint mem-tune-detail">
			<div v-if="tunePos.length">该记：{{ tunePos.join(" / ") }}</div>
			<div v-if="tuneNeg.length">不该记：{{ tuneNeg.join(" / ") }}</div>
			<div class="mem-sub">※ 只是风格示例，不进对话上下文，只在整理时发给模型</div>
		</div>
		<div v-else-if="tuneShow" class="hint">还没有示例 —— 点「立即优化」生成一份（记忆太少时会先跳过）</div>
	</div>
	<!-- A3 (2026-10-08): 记忆健康 + **注入可见性** —— 把"她怎么突然记得 / 不记得"从猜变成可查。
	     计数部分**不依赖**诊断开关 (随时可见); 注入**明细**才需要打开开关
	     (明细含你的原话与记忆内容, 与整理诊断同一隐私口径)。 -->
	<div class="mem-sec mem-health">
		<div class="mem-sec-title">记忆健康</div>
		<div class="hint">
			生效 <b>{{ health.active }}</b> · 已收起 {{ health.faded }} · 已作废 {{ health.invalid }} · 库里共 {{ health.total }} 条
			（历史总结 {{ health.summaries }} 条 · 记忆块 {{ health.blocks }} 个 · 回收站 {{ health.deleted }} 条）
		</div>
		<div class="hint">
			最近保存摘要：<b>{{ fmtWhen(health.lastSummaryAt) }}</b>
			<span v-if="health.lastPersistError" class="bad"> · {{ health.lastPersistError }}</span>
			<template v-if="health.lastOrganize">
				· 本次运行最后一次整理：<b :class="{bad: health.lastOrganize?.ok === false}">{{ /部分完成/.test(health.lastOrganize?.note ?? "") ? "部分完成" : health.lastOrganize?.ok ? "成功" : "失败" }}</b><template v-if="health.lastOrganize?.note">（{{ health.lastOrganize?.note }}）</template>
			</template>
			<template v-else>· 本次运行还没整理过</template>
		</div>
		<div class="hint">上一轮注入：{{ injectSummary }}</div>
		<div v-if="(health.lastInject?.hits?.length ?? 0) > 0" class="mem-inject-hits">
			<div v-for="h in (health.lastInject?.hits ?? [])" :key="h.id" class="mem-inject-hit">
				<span class="mem-inject-score">{{ h.s.toFixed(2) }}</span>
				<span class="mem-inject-type">{{ h.t }}</span>
				<span class="mem-inject-text">{{ h.c }}</span>
				<span v-if="h.kw" class="mem-inject-kw" title="靠关键词/别名命中">别名</span>
			</div>
		</div>
		<div v-else-if="health.lastInject" class="hint">上一轮**一条都没注入**：正文与别名都没命中，或库里没有生效记忆</div>
		<div class="btn-row mem-diag-btns">
			<button class="mini ripple" :disabled="injectN === 0" @click="doExportInject">导出注入记录</button>
		</div>
		<div class="hint mem-sub">※ 注入明细含你的原话与记忆内容，导出后请留意文件去向</div>
	</div>
	<!-- 记忆诊断 (P1「观测闭环」, 2026-09-30): 排查"她为什么记住了 / 为什么没记住"用。
	     默认关; 打开后每次整理在**内存**里留一条证据(提示词/模型输出/门槛挡下的条目/库状态),
	     点「导出记忆诊断」才落盘到 Download/NoriDroid/。重启 App 会清空。 -->
	<div class="mem-sec mem-diag">
		<div class="mem-sec-title">记忆诊断（排查用）</div>
		<div class="row-inline">
			<label>记录整理与注入过程（最多最近 {{ MAX_DIAG_RECORDS }} 次）</label>
			<input type="checkbox" v-model="cfg.memoryDiagnostics" @change="onDiagToggle" />
		</div>
		<div class="hint">
			打开后每次整理会留下证据：喂给模型的提示词、模型原话、门槛挡下了什么、库里现在多少条。
			已记录 <b>{{ diagN }}</b> 次；只在内存里，重启就清空，所以导出要在同一次里做。
		</div>
		<div class="btn-row mem-diag-btns">
			<button class="mini ripple" :disabled="diagN === 0" @click="doExportDiag">导出记忆诊断</button>
			<button class="mini ripple" :disabled="diagN === 0" @click="doClearDiag">清空记录</button>
		</div>
		<div class="hint mem-sub">※ 记录里含你的原话与记忆内容（诊断必须如此），导出后请留意文件去向</div>
	</div>
	<!-- C: 操作按钮复制到记忆库页 —— 原来只在设置一级页的「记忆系统」块里,
	     用户两次都没找到 (导出找不到就是证据)。「清空」仍只留在一级页 (破坏性操作不重复入口) -->
	<div class="btn-row mem-btns mem-btns-bottom">
		<button class="mini ripple" @click="doExportAll">导出</button>
		<button class="mini ripple" @click="doPruneMemories">清理低频记忆（30天未提）</button>
		<button class="mini ripple" @click="doRestoreMemory" :disabled="!hasBackup">撤销上次清理</button>
	</div>
	<div v-if="memPruneMsg" class="hint" :class="{ok: memPruneMsgOk, bad: !memPruneMsgOk}">{{ memPruneMsg }}</div>
</template>

<script setup lang="ts">
import {toRefs} from "vue"
import {MAX_DIAG_RECORDS} from "../services/memory"
import type {MemoryPanelModel} from "../composables/useMemoryPanel"

const props = defineProps<{model: MemoryPanelModel}>()
const {
	cfg, TYPE_LABELS, memView, memPending, summaryLabel, goals,
	goalDraft, hasBackup, invalidMems, fadedMems, deletedMems,
	diagN, injectN, health, fmtWhen, injectSummary,
	doExportInject, fadeReasonLabel, doRestoreFaded, doRestoreDeleted, tuneShow,
	tuneHas, tunePos, tuneNeg, tuneInfo, doRebuildExamples,
	doClearExamples, onDiagToggle, doExportDiag, doClearDiag, doDeleteForever,
	doRestoreInvalid, nonGoalMemories, memSearch, memFilter, filteredMems,
	isInferred, memProvenance, PROV_TIP, memSections, memOrganizing,
	memOrgMsg, memOrgMsgOk, canOrganize, doOrganizeNow, isPinnedId,
	doTogglePin, doFadeMemory, doDeleteMemory, doRestoreMemory, doAddGoal,
	doRemoveGoal, fmtTs, doExportAll, memPruneMsg,
	memPruneMsgOk, doPruneMemories,
} = toRefs(props.model)
</script>

<style scoped lang="less">
.btn-row { display: flex; gap: 8px; }
.btn-row.mem-btns { flex-wrap: wrap; }
.btn-row.mem-btns .mini { flex: 1 1 auto; text-align: center; }
.empty { padding: 24px 0; text-align: center; color: var(--fg-dim); font-size: 14px; }
.row-inline {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	label { font-size: 13px; color: var(--fg-2); flex: 1; }
	input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent-strong); flex-shrink: 0; }
}
.hint { font-size: 12px; color: var(--fg-3); }
.hint.ok { color: #4ade80; }
.hint.bad { color: #fbbf24; }
.ripple { position: relative; overflow: hidden; }
.mini {
	padding: 9px 14px;
	border-radius: var(--ui-radius-ctl);
	background: var(--px-panel-2);
	color: var(--px-white);
	font-size: 13px;
	border: var(--ui-line-w) solid var(--ui-line-c);
	white-space: nowrap;
	box-shadow: inset 2px 2px 0 0 var(--ui-hi), inset -2px -2px 0 0 var(--ui-lo), var(--ui-shadow);
	&:active { box-shadow: var(--ui-press); }
}

.mem-block {
	border-top: 1px dashed var(--line-strong);
	padding-top: 12px;
}
.mem-sec { display: flex; flex-direction: column; gap: 6px; }
.mem-sec-title {
	font-size: 12px; font-weight: 600; color: var(--accent);
	margin-top: 4px;
}
.mem-item {
	display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px;
	background: var(--px-panel);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	padding: 8px 10px;
	box-shadow: inset 2px 2px 0 0 rgba(20, 38, 72, 0.7);
}
.mem-tag {
	flex-shrink: 0;
	font-size: 10px; line-height: 16px;
	padding: 0 7px; border-radius: var(--ui-radius-ctl);
	border: 1px solid var(--px-line);
	background: var(--px-panel-2); color: var(--px-grey);
	&.core { background: var(--px-amber-deep); color: var(--px-amber); border-color: var(--px-amber); }
	&.fact { background: var(--px-cyan-deep); color: var(--px-cyan); border-color: var(--px-cyan-dim); }
	&.preference { background: var(--px-magenta-deep); color: var(--px-magenta); border-color: var(--px-magenta); }
	&.project { background: #064e3b; color: var(--px-green); border-color: var(--px-green); }
	&.event { background: rgba(251, 146, 60, 0.18); color: #fdba74; }
	&.relationship { background: rgba(244, 114, 182, 0.18); color: #f9a8d4; }
	/* 来源标注 (B2): 「你声明」= 中性灰; 「我推断」= 偏主题色, 提示"这条是她的猜测" */
	&.src { background: var(--px-panel-2); color: var(--px-grey); border-color: var(--px-line); }
	&.src.inferred { background: var(--px-cyan-deep); color: var(--px-cyan); border-color: var(--px-cyan-dim); }
}
.mem-text { flex: 1 1 auto; min-width: 110px; font-size: 13px; color: var(--fg); line-height: 1.45; word-break: break-all; }
/* 目标/固定 图标不再占标签位, 直接贴在正文行首 (B: 标签太乱 → 一行只留一个主标签) */
.mem-ico { margin-right: 2px; }
.mem-group { margin-top: 2px; }
/* P4: 块视图 —— 一个块 = 一次历史总结覆盖的一段对话; 块标题是"主题 · 时间段 · N 条对话",
   块内小节标题降一级 (更小更淡), 让"块 > 类型"的层级一眼看得出来 */
/* 已收起 / 已删除 (2026-09-28): 与「已作废」同一套折叠样式, 但各自一个 class 便于区分与 E2E 断言 */
.mem-faded > summary { cursor: pointer; color: var(--px-grey); }
.mem-deleted > summary { cursor: pointer; color: var(--px-grey); }
/* 记忆优化 (整理优化): 一个小节 + 三个按钮 + 可展开的示例预览 */
.mem-tune { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-tune-btns { margin-top: 2px; }
/* 记忆诊断 (P1): 与「记忆优化」同一套折叠样式, 单独一个 class 便于区分与 E2E 断言 */
.mem-diag { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-diag-btns { margin-top: 2px; }
/* A3 (2026-10-08): 记忆健康 + 注入明细 —— 与 .mem-diag 同一套视觉口径 */
.mem-health { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-inject-hits { margin: 4px 0 2px; }
.mem-inject-hit {
	display: flex; align-items: baseline; gap: 6px;
	padding: 2px 0; font-size: 12px; line-height: 1.45;
}
.mem-inject-score {
	flex: none; min-width: 34px; text-align: right;
	color: var(--accent); font-variant-numeric: tabular-nums;
}
.mem-inject-type { flex: none; color: var(--fg-dim); font-size: 11px; }
.mem-inject-text { flex: 1 1 auto; min-width: 0; overflow-wrap: break-word; }
.mem-inject-kw {
	flex: none; padding: 0 4px; border-radius: 4px; font-size: 10px;
	color: var(--accent); background: rgba(127, 212, 230, 0.12);
}
.mem-tune-detail { line-height: 1.6; }
.mem-block {
	margin-top: 6px;
	padding: 6px 8px 8px;
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	background: color-mix(in srgb, var(--px-panel-2) 55%, transparent);
}
.mem-block > .mem-sec-title { margin-top: 0; }
.mem-sec-title.sub {
	font-size: 11px; font-weight: 500;
	color: var(--px-grey);
	margin-top: 2px;
}
/* P4: 「待整理 N 条」+「立即整理」—— 让"还没进记忆"可见 (实时通道默认关之后的必要交代) */
.mem-pending {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	font-size: 11px; color: var(--px-grey);
	padding: 2px 0 4px;
}
/* A: 整理反馈**就地**贴在按钮下面 (以前写在面板最底部, 用户看不到 ⇒ 以为"点了没用") */
.mem-org-msg {
	margin: 0 0 2px;
	padding: 3px 0 0;
	border-top: 1px dashed var(--ui-line-c-soft);
}
/* C: 记忆库顶部统计行 + 空态提示 + 底部操作区 */
.mem-stats {
	font-size: 11px; color: var(--px-grey);
	padding: 2px 0 4px;
	border-bottom: 1px dashed var(--ui-line-c-soft);
	margin-bottom: 4px;
}
.mem-invalid-empty {
	font-size: 11px; color: var(--px-grey); opacity: 0.85;
	padding: 4px 0 2px;
}
.mem-btns-bottom { margin-top: 8px; }
/* 已作废的记忆 (B1): 灰一档 + 内容划掉, 一眼看出"这是留档, 不是现在生效的" */
.mem-invalid {
	& > summary { cursor: pointer; color: var(--px-grey); }
	.mem-item { opacity: 0.72; }
	.mem-text { text-decoration: line-through; text-decoration-color: var(--px-grey); }
}
.mem-op {
	flex-shrink: 0;
	font-size: 10px; line-height: 1;
	padding: 5px 8px;
	border-radius: var(--ui-radius-ctl);
	background: var(--px-panel-2); color: var(--px-white);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	box-shadow: inset 1px 1px 0 0 var(--ui-hi);
	&:active { background: var(--px-panel); }
	&.danger { background: rgba(146, 64, 14, 0.4); color: #fecaca; border-color: var(--px-red); }
}
/* 记忆库页 (独立页) */
.mem-sec-title-row {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	.mem-view-all { font-size: 11px; padding: 3px 8px; }
}
.mem-search-row {
	display: flex; gap: 6px; margin-bottom: 8px;
	.mem-search-input {
		flex: 1; min-width: 0;
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-card);
		color: var(--fg); font-size: 12px;
		padding: 7px 9px;
	}
	.mem-search-sel {
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-card);
		color: var(--fg-2); font-size: 12px;
		padding: 6px 4px;
	}
}
.mem-count-hint { font-size: 11px; color: var(--fg-dim); margin: 0 0 6px 2px; }
.mem-sub {
	width: 100%;
	font-size: 10px; color: var(--fg-dim);
}
.mem-tag.pinned { background: rgba(56, 189, 248, 0.2); color: var(--accent); }
.mem-tag.goal { background: rgba(251, 191, 36, 0.18); padding: 0 4px; }
.goal-add {
	display: flex; gap: 6px; margin-top: 2px;
	input {
		flex: 1; min-width: 0;
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-card);
		color: var(--fg); font-size: 12px;
		padding: 6px 8px;
	}
	button { flex-shrink: 0; }
}

.mem-summary {
	background: var(--px-panel);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	padding: 8px 10px;
	summary {
		font-size: 12px; color: var(--accent); cursor: pointer; user-select: none;
		list-style: none;
		&::-webkit-details-marker { display: none; }
		&::before { content: "▸ "; }
	}
	&[open] summary::before { content: "▾ "; }
}
.mem-summary-content {
	margin-top: 8px;
	font-size: 13px; color: var(--fg); line-height: 1.6;
	max-height: 160px; overflow-y: auto;
	-webkit-overflow-scrolling: touch;
	touch-action: pan-y;
}
</style>
