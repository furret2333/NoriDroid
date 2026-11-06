<template>
	<div class="tts-page">
		<div class="tts-top">
			<span class="tts-title">语音合成</span>
			<button class="x" @click="emit('close')">✕</button>
		</div>
		<div class="tts-body">
			<div class="tts-sec">
				<div class="tts-sec-title">开关</div>
				<div class="field row-inline">
					<label>启用语音朗读</label>
					<input type="checkbox" v-model="cfg.ttsEnabled" />
				</div>
				<div class="field">
					<label>提供商</label>
					<div class="voice-pick">
						<select v-model="cfg.ttsProvider">
							<option value="fish">Fish Audio</option>
							<option value="cosyvoice">千问 CosyVoice</option>
						</select>
					</div>
					<div class="hint">切换后各自配置独立保存, 互不影响</div>
				</div>
				<div class="field">
					<label>朗读音量 {{ Math.round((Number(cfg.ttsVolume) || 0) * 100) }}%（应用内，不影响系统音量）</label>
					<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.ttsVolume" @input="emit('volumeChange')" @change="emit('persist')" />
					<div class="hint">只调整 Nori 说话的音量，手机铃声/媒体音量不受影响</div>
				</div>
				<div class="hint">开启后, Nori 的每句回复都会流式朗读</div>
			</div>

			<template v-if="cfg.ttsProvider === 'fish'">
			<div class="tts-sec">
				<div class="tts-sec-title">账户配置</div>
				<div class="field">
					<label>Fish Audio API Key</label>
					<input v-model="cfg.ttsApiKey" type="text" autocomplete="off" spellcheck="false" placeholder="在 fish.audio 控制台获取 (sk-...)" />
				</div>
				<div class="field">
					<label>API Base URL</label>
					<input v-model="cfg.ttsBaseUrl" type="text" autocomplete="off" spellcheck="false" />
				</div>
			</div>

			<div class="tts-sec">
				<div class="tts-sec-title">音色与参数</div>
				<div class="field">
					<label>音色（可选）</label>
					<div class="voice-pick">
						<select v-model="cfg.ttsReferenceId">
							<option value="">默认音色</option>
							<option v-for="v in model.voiceOptions" :key="v.id" :value="v.id">{{ v.title }}</option>
						</select>
						<button class="mini ripple" :disabled="model.voicesLoading" @click="model.loadVoices">{{ model.voicesLoading ? "加载中…" : "加载音色" }}</button>
					</div>
					<input v-model="cfg.ttsReferenceId" type="text" autocomplete="off" spellcheck="false" placeholder="或手动输入 Reference ID, 留空用默认音色" />
					<div v-if="model.voicesMsg" class="hint" :class="{ok: model.voicesMsgOk, bad: !model.voicesMsgOk}">{{ model.voicesMsg }}</div>
				</div>
				<div class="field">
					<label>模型</label>
					<select v-model="cfg.ttsModel">
						<option v-for="md in FISH_MODELS" :key="md" :value="md">{{ md }}</option>
					</select>
				</div>
				<div class="field">
					<label>音频格式</label>
					<select v-model="cfg.ttsFormat">
						<option v-for="f in FISH_FORMATS" :key="f" :value="f">{{ f }}</option>
					</select>
					<div class="hint">mp3 兼容性最好; pcm 延迟最低</div>
				</div>
				<div class="field">
					<label>分块长度 {{ cfg.ttsChunkLength }}</label>
					<input type="range" min="100" max="500" step="50" v-model.number="cfg.ttsChunkLength" />
					<div class="hint">越小首音越快、块数越多</div>
				</div>
				<div class="field">
					<label>延迟模式</label>
					<select v-model="cfg.ttsLatency">
						<option v-for="l in FISH_LATENCIES" :key="l" :value="l">{{ l }}</option>
					</select>
				</div>
			</div>
			</template>

			<template v-else>
			<div class="tts-sec">
				<div class="tts-sec-title">千问 CosyVoice 配置</div>
				<div class="field">
					<label>千问/百炼 API Key</label>
					<input v-model="cfg.cosyApiKey" type="text" autocomplete="off" spellcheck="false" placeholder="在百炼控制台获取 (sk-...)" />
				</div>
				<div class="field">
					<label>API Base URL</label>
					<input v-model="cfg.cosyBaseUrl" type="text" autocomplete="off" spellcheck="false" placeholder="https://dashscope.aliyuncs.com 或北京专属域名" />
				</div>
				<div class="field">
					<label>模型</label>
					<select v-model="cfg.cosyModel">
						<option v-for="md in COSY_MODELS" :key="md" :value="md">{{ md }}</option>
					</select>
				</div>
				<div class="field">
					<label>音色</label>
					<div class="voice-pick">
						<select v-model="cfg.cosyVoice">
							<option v-if="!cfg.cosyCloneVoices.length" value="">暂无克隆音色，先克隆一个</option>
							<option v-for="v in cfg.cosyCloneVoices" :key="v.id" :value="v.id">{{ v.model ? `${v.model} · ${v.id}` : v.id }}{{ v.model && v.model !== cfg.cosyModel ? "（当前模型不可用）" : "" }}</option>
						</select>
					</div>
					<input v-model="cfg.cosyVoice" type="text" autocomplete="off" spellcheck="false" placeholder="或手动输入音色 id" />
					<div v-if="model.cosyVoiceHint" class="hint bad">{{ model.cosyVoiceHint }}</div>
				</div>
				<div class="field">
					<label>语速 {{ Number(cfg.cosyRate).toFixed(1) }}x</label>
					<input type="range" min="0.5" max="2" step="0.1" v-model.number="cfg.cosyRate" />
				</div>
				<div class="tts-sec-title">声音克隆</div>
				<div class="field">
					<label>克隆音色前缀 (字母数字)</label>
					<input v-model="model.clonePrefix" type="text" autocomplete="off" spellcheck="false" placeholder="如 myvoice" />
				</div>
				<!-- 一键克隆（2026-10-01）: 参考音频**联网下载**（不再打进 APK），省掉"自己找一段 10~20 秒干音"这一步 -->
				<div class="field">
					<label>一键克隆（预设参考音频）</label>
					<button class="btn ripple primary" :disabled="model.cloneCreating" @click="emit('openCloneGate')">
						{{ model.cloneCreating ? "下载/创建中…" : "一键克隆预设音色" }}
					</button>
					<div class="hint">点按钮后会先**联网下载**一段 12.5 秒的参考音频（首次约 3.4MB，之后走本地缓存），再由千问创建音色；需先答对「模型授权验证」的问题。⚠ 下载源在国内可能直连不了，**可能需要魔法**。</div>
				</div>
				<div class="btn-row">
					<button class="btn ripple" :disabled="model.clonePicking" @click="model.doPickVoice">{{ model.clonePicking ? "选择中…" : (model.cloneFileName || "选择音频文件") }}</button>
					<button class="btn ripple primary" :disabled="!model.cloneFileName || model.cloneCreating" @click="model.doCreateClone">{{ model.cloneCreating ? "创建中…" : "创建克隆音色" }}</button>
				</div>
				<div class="hint">建议音频：10~20 秒，≤10MB，WAV/MP3/M4A，无背景音乐</div>
				<div v-if="model.cloneFileName" class="hint">已选: {{ model.cloneFileName }}{{ model.cloneFileSize ? ` (${model.fmtSize(model.cloneFileSize)})` : "" }}</div>
				<div v-if="model.cloneMsg" class="hint" :class="{ok: model.cloneMsgOk, bad: !model.cloneMsgOk}">{{ model.cloneMsg }}</div>
				<div v-if="model.cloneStatusText" class="hint" :class="{ok: model.cloneStatusOk, bad: !model.cloneStatusOk}">{{ model.cloneStatusText }}</div>
				<div class="tts-sec-title">余额查询</div>
				<div class="bal-grid">
					<div class="bal-item">
						<div class="bal-name">千问 CosyVoice</div>
						<div class="bal-value" :class="{loading: model.balCosyLoading}">{{ model.balCosyLoading ? "查询中…" : (model.balCosy || "未查询") }}</div>
					</div>
					<div class="bal-item">
						<div class="bal-name">DeepSeek</div>
						<div class="bal-value" :class="{loading: model.balDsLoading}">{{ model.balDsLoading ? "查询中…" : (model.balDs || "未查询") }}</div>
					</div>
				</div>
				<div class="bal-btns">
					<button class="mini ripple" :disabled="model.balCosyLoading" @click="model.queryCosyBalance">查询千问余额</button>
					<button class="mini ripple" :disabled="model.balDsLoading" @click="model.queryDeepSeekBalance">查询 DeepSeek</button>
				</div>
				<div class="hint">千问/DashScope 官方未开放余额查询接口，若提示不可用请到千问控制台账单页查看</div>
				<div v-if="model.balMsg" class="hint" :class="{ok: model.balMsgOk, bad: !model.balMsgOk}">{{ model.balMsg }}</div>
			</div>
			</template>

			<div class="tts-sec" v-if="cfg.ttsProvider === 'fish'">
				<div class="tts-sec-title">余额查询</div>
				<div class="bal-grid">
					<div class="bal-item">
						<div class="bal-name">Fish Audio</div>
						<div class="bal-value" :class="{loading: model.balFishLoading}">{{ model.balFishLoading ? "查询中…" : (model.balFish || "未查询") }}</div>
					</div>
					<div class="bal-item">
						<div class="bal-name">DeepSeek</div>
						<div class="bal-value" :class="{loading: model.balDsLoading}">{{ model.balDsLoading ? "查询中…" : (model.balDs || "未查询") }}</div>
					</div>
				</div>
				<div class="bal-btns">
					<button class="mini ripple" :disabled="model.balFishLoading" @click="model.queryFishBalance">查询 Fish Audio</button>
					<button class="mini ripple" :disabled="model.balDsLoading" @click="model.queryDeepSeekBalance">查询 DeepSeek</button>
				</div>
				<div class="hint">Fish Audio 用上面账户配置; DeepSeek 用聊天设置里的 API Key</div>
				<div v-if="model.balMsg" class="hint" :class="{ok: model.balMsgOk, bad: !model.balMsgOk}">{{ model.balMsg }}</div>
			</div>

			<div class="tts-sec">
				<div class="tts-sec-title">操作</div>
				<div class="btn-row">
					<button class="btn ripple" :disabled="model.ttsTesting" @click="model.doTestTTS">{{ model.ttsTesting ? "测试中…" : "测试并试听" }}</button>
					<button class="btn ripple" v-if="speaking" @click="emit('stop')">停止朗读</button>
				</div>
				<button class="btn ripple primary" @click="emit('save')">保存设置</button>
				<div v-if="model.ttsMsg" class="hint" :class="{ok: model.ttsMsgOk, bad: !model.ttsMsgOk}">{{ model.ttsMsg }}</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import type {AppSettings} from "../composables/useAppSettings"
import type {VoiceSettingsModel} from "../composables/useVoiceSettings"
import {FISH_MODELS, FISH_FORMATS, FISH_LATENCIES} from "../services/tts/fishaudio"
import {COSY_MODELS} from "../services/tts/cosyvoice"

defineProps<{cfg: AppSettings; model: VoiceSettingsModel; speaking: boolean}>()
const emit = defineEmits<{
	close: []
	volumeChange: []
	persist: []
	openCloneGate: []
	save: []
	stop: []
}>()
</script>

<style lang="less" scoped>
@import "../assets/style/dialog-controls.less";

.tts-page {
	position: fixed;
	inset: 0;
	z-index: 15;
	background: rgba(2, 6, 23, 0.5);
	display: flex;
	flex-direction: column;
}
.tts-top {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: calc(12px + env(safe-area-inset-top)) 14px 10px;
	background: linear-gradient(180deg, rgba(2,6,23,0.7) 0%, rgba(2,6,23,0) 100%);
}
.tts-title {
	font-size: 16px; font-weight: 600; color: var(--fg);
	text-shadow: 0 0 12px rgba(56, 189, 248, 0.35);
}
.tts-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 4px 16px calc(20px + env(safe-area-inset-bottom));
	-webkit-overflow-scrolling: touch;
	touch-action: pan-y;
}
.tts-empty {
	color: var(--fg-dim);
	font-size: 14px;
	text-align: center;
}

/* TTS 面板分组 */
.tts-sec {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px 14px;
	border-radius: var(--ui-radius-card);
	background: rgba(15, 23, 42, 0.55);
	border: 1px solid var(--line-soft);
}
.tts-sec-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--accent);
	letter-spacing: 0.5px;
}
.field {
	display: flex;
	flex-direction: column;
	gap: 6px;
	label { font-size: 13px; color: var(--fg-2); }
	/* 与 .settings-row 同款: 补 number/password, 避免默认白底 */
	input[type=text], input[type=password], input[type=number] {
		background: rgba(30, 41, 59, 0.9);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-ctl);
		padding: 10px 12px;
		color: var(--fg);
		font-size: 14px;
		outline: none;
	}
	input[type=number] { -webkit-appearance: none; appearance: textfield; }
	select {
		background: rgba(30, 41, 59, 0.9);
		color: var(--fg);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-ctl);
		padding: 10px 12px;
		font-size: 14px;
	}
	input[type=range] { width: 100%; accent-color: var(--accent-strong); }
}
.field.row-inline {
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent-strong); }
}

/* 余额查询 */
.bal-grid {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

/* 音色选择行 */
.voice-pick {
	display: flex;
	gap: 8px;
	align-items: center;
	select { flex: 1; }
	.mini { flex-shrink: 0; }
}
.bal-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 10px 12px;
	border-radius: var(--ui-radius-ctl);
	background: rgba(30, 41, 59, 0.7);
	border: 1px solid var(--line);
}
.bal-name {
	font-size: 13px;
	color: var(--fg-3);
	flex-shrink: 0;
}
.bal-value {
	font-size: 14px;
	font-weight: 600;
	color: #4ade80;
	text-align: right;
	word-break: break-all;
	&.loading { color: #fbbf24; }
}
.bal-btns {
	display: flex;
	gap: 8px;
	.mini { flex: 1; }
}

.btn-row {
	display: flex;
	gap: 8px;
	.btn { flex: 1; width: auto; margin-top: 0; }
}
.row-inline {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	label { font-size: 13px; color: var(--fg-2); flex: 1; }
	input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent-strong); flex-shrink: 0; }
}
.btn {
	width: 100%; margin-top: 10px;
	padding: 12px; border-radius: var(--ui-radius-ctl);
	position: relative; overflow: hidden;
	background: var(--px-panel-2);
	color: var(--px-white); font-size: 14px;
	border: var(--ui-line-w) solid var(--ui-line-c);
	/* 像素凸起 (网页版 .pixel-btn-primary 同款配方):
	   亮上左 + 暗下右 + 硬投影, 按下时反转 —— 这是"能一眼看出换了风格"的关键 */
	box-shadow: inset 2px 2px 0 0 var(--ui-hi), inset -2px -2px 0 0 var(--ui-lo), 0 var(--ui-lift) 0 0 var(--ui-lo), var(--ui-shadow);
	&:active {
		transform: translateY(2px);
		box-shadow: var(--ui-press), 0 calc(var(--ui-lift) / 2) 0 0 var(--ui-lo);
	}
}


:global(.ui-tide .tts-sec) {
	background: linear-gradient(155deg, rgba(24, 51, 69, 0.72), rgba(10, 27, 44, 0.72));
	border-color: rgba(127, 212, 230, 0.16);
}
</style>
