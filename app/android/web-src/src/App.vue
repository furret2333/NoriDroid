<template>
	<div
		class="stage-root"
		:class="[uiSoft ? 'ui-soft' : 'ui-tide', {portrait: portraitLayout, 'keyboard-open': keyboardOpen}]"
		:style="{'--chat-keyboard-inset': keyboardInset + 'px'}"
		@pointerdown="closeChatMenusOutside"
		@touchstart.passive="onTouchStart"
		@touchmove.passive="onTouchMove"
		@touchend.passive="onTouchEnd"
		@touchcancel.passive="onTouchEnd"
	>

		<div ref="rippleHost" class="ripple-host"></div>

		<!-- 手指触摸追踪: 半透明磨砂小白点跟随手指 -->
		<div ref="touchDotHost" class="touch-dot-host"></div>

		<!-- 两种背景位于 Live2D 下方，由控制器保证只有一种运行。 -->
		<canvas ref="dataseaCanvas" class="datasea-bg" v-show="visibleBackground === 'datasea'"></canvas>
		<canvas ref="deepseaCanvas" class="datasea-bg deepsea-bg" v-show="visibleBackground === 'deep-sea'"></canvas>
		<div v-if="footlight" class="deepsea-footlight" :style="{left: footlight.x + 'px', top: footlight.y + 'px', width: footlight.width + 'px', height: footlight.height + 'px'}" aria-hidden="true"></div>

		<!-- 命中区域调试显示 (测试用): 实时显示当前触摸命中的区域 + 抚摸进度/完成次数 -->
		<div v-if="hitDebug && hitZoneText" class="hit-debug">命中：{{ hitZoneText }}<span v-if="petDebugText"> ｜ {{ petDebugText }}</span></div>

		<!-- 番茄钟悬浮窗 (拖拽移动 / 右下角缩放 / 可折叠; 组件根截断 pointer 事件, 不惊动摸头与双指手势) -->
		<PomodoroWidget
			v-if="pomoWidgetOn && pomo.phase !== 'idle' && panel !== 'pomo' && panel !== 'pomoStats'"
			:model="pomodoroModel" />



		<div ref="l2dHost" class="l2d-host"></div>


		<transition name="fade">
			<div v-if="touchBubble" class="touch-bubble">{{ touchBubble }}</div>
		</transition>


		<transition name="ai">
			<div v-if="!portraitLayout && aiBubble" class="ai-bubble">
				<div class="ai-bubble-head"><span class="ai-bubble-dot"></span>Nori</div>
				<div class="ai-bubble-txt">{{ aiBubble }}</div>
			</div>
		</transition>

		<div class="topbar" v-show="panel !== 'touch' && panel !== 'tts'">
			<button
				type="button"
				class="tag"
				:class="{locked: canvasLocked}"
				:title="canvasLocked ? '点击选择模型；长按或按空格解锁画布' : '点击选择模型；长按或按空格锁定画布'"
				@pointerdown="onModelTagDown"
				@pointermove="onModelTagMove"
				@pointerup="cancelModelTagPress()"
				@pointercancel="cancelModelTagPress(true)"
				@lostpointercapture="cancelModelTagPress(true)"
				@contextmenu.prevent
				@keydown.space.prevent="onModelTagSpace"
				@keyup.space.prevent
				@click="onModelTagClick"
			>
				<span>{{ currentModel?.name ?? "—" }}</span>
				<span class="tag-hint">{{ canvasLocked ? '已锁定 · 长按解锁' : '长按锁定画布' }}</span>
			</button>
			<div v-if="error" class="err" @click="error = ''">{{ error }} ✕</div>
			<div v-else-if="loading" class="loading">{{ loadingMsg }}</div>
		</div>


		<ChatPanel ref="chatPanelRef"
			v-model:draft="draft" v-model:chat-open="chatOpen"
			v-model:image-menu="imageMenu" v-model:pending-image="pendingImage"
			:portrait-layout="portraitLayout" :keyboard-open="keyboardOpen"
			:panel-open="!!panel" :portrait-reply="portraitReply"
			:model-name="curModelName" :chat-streaming="chatStreaming"
			:touch-streaming="touchStreaming" :speaking="speaking" :typing="typing"
			:messages="messages" :chat-font-p-x="chatFontPX"
			:bubble-width-num="bubbleWidthNum" :pending-count="pendingQueue.length"
			:model-ready="modelReady" :image-picking="imagePicking" :image-previews="imagePreviews"
			@open-history="openPortraitHistory" @toggle-history="toggleChat"
			@stop-generate="stopGenerate" @stop-speech="stopTTS"
			@composer-focus="onComposerFocus" @composer-blur="onComposerBlur"
			@input-enter="onInputEnter" @choose-image="chooseImage"
			@poke="pokeNori" @send="send" />

		<div v-if="portraitLayout && !panel" v-show="sideRailOpen" class="side-rail-mask" @pointerdown.stop="sideRailOpen = false"></div>
		<nav v-if="portraitLayout && !panel" class="side-rail" :class="{open: sideRailOpen}" aria-label="功能菜单" @pointerdown="onDockPress" @keydown.esc="sideRailOpen = false">
			<button class="side-rail-handle" type="button" :aria-expanded="sideRailOpen" aria-controls="side-rail-items" :aria-label="sideRailOpen ? '收起功能菜单' : '展开功能菜单'" @click="sideRailOpen = !sideRailOpen; imageMenu = false">
				<svg viewBox="0 0 24 24" aria-hidden="true" :class="{expanded: sideRailOpen}"><path d="m14 6-6 6 6 6" /></svg>
			</button>
			<div id="side-rail-items" v-show="sideRailOpen" class="side-rail-items">
				<button v-for="item in portraitActions" :key="item.panel" class="side-action ripple" @click="item.panel === 'diary' ? openDiary() : openPanel(item.panel)">
					<img :src="item.icon" alt="" draggable="false" /><span>{{ item.label }}</span>
				</button>
			</div>
		</nav>

		<div class="dock" v-show="!portraitLayout && panel !== 'touch' && panel !== 'tts'" @pointerdown="onDockPress">
			<button class="fab ripple" @click="openDiary">
				<img class="fab-ico" :src="DOCK_ICONS.diary" alt="" draggable="false" />
				<span class="fab-label">日记</span>
			</button>
			<button class="fab ripple" @click="openPanel('model')">
				<img class="fab-ico" :src="DOCK_ICONS.model" alt="" draggable="false" />
				<span class="fab-label">模型</span>
			</button>
			<button class="fab ripple" @click="openPanel('pomo')">
				<img class="fab-ico" :src="DOCK_ICONS.pomo" alt="" draggable="false" />
				<span class="fab-label">番茄</span>
			</button>
			<button class="fab ripple" @click="openPanel('settings')">
				<img class="fab-ico" :src="DOCK_ICONS.settings" alt="" draggable="false" />
				<span class="fab-label">设置</span>
			</button>
			<button class="fab ripple" @click="toggleChat">
				<img class="fab-ico" :src="DOCK_ICONS.chat" alt="" draggable="false" />
				<span class="fab-label">对话</span>
			</button>
		</div>


		<Transition name="fade">
		<TouchSettingsPage v-if="panel === 'touch'"
			v-model:selected-touch-id="selectedTouchId"
			:cfg="cfg" :touch-areas="touchAreas" :touch-custom-expanded="touchCustomExpanded"
			:touch-drawing="touchDrawing" :touch-testing="touchTesting" :touch-adjusting="touchAdjusting"
			:touch-draft="touchDraft" :draft-ready="draftReady" :touch-enabled="touchEnabled"
			:touch-cooldown-text="touchCooldownText" :touch-editing-id="touchEditingId"
			:can-undo="!!deletedTouch" :busy="touchReplyBusy()" :touch-bubble="touchBubble"
			:touch-reply-preview="touchReplyPreview" :touch-streaming="touchStreaming" :box-style="boxStyle"
			@close="closeTouchSettings" @pet-touch-setting="onPetTouchSetting" @custom-toggle="onTouchCustomToggle"
			@toggle-draw="toggleTouchDraw" @toggle-adjust="toggleTouchAdjust" @toggle-testing="toggleTouchTesting"
			@set-enabled="setTouchEnabled" @add="onTouchAdd" @update="onTouchUpdate" @edit="beginTouchEdit"
			@preview="previewTouchEdit" @cancel-edit="cancelTouchEdit" @undo="undoTouchRemove"
			@remove="onTouchRemove" @test="onTouchTest" @reset-draft="resetTouchDraft" />
		</Transition>

		<Transition name="fade">
		<TtsSettingsPage v-if="panel === 'tts'" :cfg="cfg" :model="voiceSettings" :speaking="speaking"
			@close="panel = ''" @volume-change="applyTtsVolume" @persist="persistSettings"
			@open-clone-gate="openCloneGate" @save="saveSettingsNow" @stop="stopTTS" />
		</Transition>

		<transition name="sheet">
			<div v-if="panel && panel !== 'touch' && panel !== 'tts'" class="sheet-mask" @click.self="panel = ''">
				<div class="sheet" :class="{'diary-sheet': panel === 'diary', 'focus-sheet': panel === 'pomo' || panel === 'pomoStats'}">
					<div class="sheet-head" :class="{'settings-sheet-head': panel === 'settings'}">
						<span class="sheet-title">{{ panelTitle(panel) }}</span>
						<div v-if="panel === 'settings'" class="settings-bgm-player" :class="{ 'is-playing': bgmCanSkip }">
							<span class="settings-bgm-copy">
								<b>{{ bgmQuickTrack }}</b>
								<small>{{ bgmQuickStatus }}</small>
							</span>
							<span class="settings-bgm-icon" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
							<button class="settings-bgm-control" type="button" :aria-label="bgmQuickActionLabel" :title="bgmQuickActionLabel" @click="onBgmQuickToggle"><span aria-hidden="true">{{ bgmState === 'missing' && cfg.bgmEnabled ? '↻' : cfg.bgmEnabled ? 'Ⅱ' : '▶' }}</span></button>
							<button class="settings-bgm-control settings-bgm-next" type="button" aria-label="换一首" title="换一首" :disabled="!bgmCanSkip" @click="onBgmNext">⏭</button>
						</div>
						<button class="x" :aria-label="'关闭'" @click="panel = ''">✕</button>
					</div>
					<div class="sheet-body">

						<ModelPanels v-if="panel === 'model' || panel === 'motion' || panel === 'expression'"
							:panel="panel" :model-list="modelList" :current-model-id="currentModelId"
							:list-error="listError" :motions="motions" :expressions="expressions"
							@pick="pick" @motion="doMotion" @expression="l2d.playExpression($event)"
							@clear-expression="l2d.stopExpression()" />

						<DiaryPanel v-else-if="panel === 'diary'" :config="cfg" :chat-busy="chatStreaming || touchStreaming" @notify="triggerBubble($event)" />


						<!-- 记忆库 (二级菜单: 目标 / 长期记忆 / 历史总结 三份内容都收在这里) -->
						<MemoryPanel v-else-if="panel === 'memories'" :model="memoryPanel" />

						<template v-else-if="panel === 'pomo'">
                            <PomodoroPanel :config="pomoCfg" :phase="pomo.phase" :paused="pomo.paused" :time="pomoFmt" :percent="pomoPct" :phase-text="pomoPhaseText"
                                :end-text="pomoEndText" :goal="pomo.goal || ''" :session-id="pomo.sessionId || ''" :rounds="pomo.rounds || 0" :long-every="pomo.longEvery || pomoCfg.longEvery" :cycle-enabled="pomo.phase === 'idle' ? pomoCfg.cycleEnabled : !!pomo.cycleEnabled"
                                :saved-min="pomoSummary.todayMin" :live-min="pomoLiveMin" :done="pomoSummary.todayDone" :streak="pomoSummary.streak" :ready="pomoStatsReady" :busy="pomoBusy"
                                :error="pomoError || pomoConfigError" :message="pomoMessage" :sync-text="pomoSyncText" :reminder-text="pomoReminderText" :reminder-action="pomoReminderAction"
                                :quiet-held="pomoQuietHeld" :reboot-pending="!!pomo.rebootPending" :bars="pomoWeekBars" :restore-preview="pomoRestorePreview" :confirm-stop="pomoConfirmEnd"
                                @action="pomoAction" @reminder="pomoReminderSettings" @export="pomoExport" />
                        </template>
						<PomodoroStatsPanel v-else-if="panel === 'pomoStats'" :model="pomodoroModel" @back="panel = 'pomo'" />
						<SettingsPage v-else-if="panel === 'settings'"
							v-model:settings-tab="settingsTab" v-model:hit-debug="hitDebug"
							:cfg="cfg" :version="APP_VERSION"
							:model-ready="modelReady" :model-options="modelOptions"
							:model-load-msg="modelLoadMsg" :render-scale-num="renderScaleNum"
							:native-dpr="nativeDpr" :bubble-scale-num="bubbleScaleNum"
							:bubble-width-num="bubbleWidthNum" :l2d-fps-num="l2dFpsNum"
							:bgm-state="bgmState" :bgm-pct="bgmPct"
							:bgm-can-skip="bgmCanSkip" :bgm-now-name="bgmNowName"
							:float-permission-hint="floatPermissionHint" :ui-font-now="uiFontNow"
							:ui-font-hint="uiFontHint" :persona-custom="personaCustom"
							:persona-state-text="personaStateText" :persona-msg="personaMsg"
							:persona-msg-ok="personaMsgOk" :persona-dl-busy="personaDlBusy"
							:persona-dl-msg="personaDlMsg" :persona-dl-ok="personaDlOk"
							:background-error="backgroundError" :storage-path="storagePath"
							:all-files-access="allFilesAccess" :storage-probe-msg="storageProbeMsg"
							:memory-count="nonGoalMemories.length + goals.length" :has-backup="hasBackup"
							:mem-prune-msg="memPruneMsg" :mem-prune-msg-ok="memPruneMsgOk"
							:sfx-busy="sfxBusy" :sfx-btn-text="sfxBtnText"
							:sfx-msg="sfxMsg" :sfx-msg-ok="sfxMsgOk"
							:sfx-msg-bad="sfxMsgBad" :ui-soft="uiSoft"
							:presence-ready="presenceReady" :presence-tone-class="presenceToneClass"
							:presence-count="presenceCount" :presence-today="presenceToday"
							:presence-status="presenceStatus" :presence-can-retry="!!presenceState && !presenceState.ok"
							@apply-render-scale="applyRenderScale" @clear-memory="doClearMemory"
							@download-sfx="doDownloadSfx" @export-all="doExportAll"
							@import-persona="doImportPersona" @prune-memories="doPruneMemories"
							@request-all-files="doRequestAllFiles" @reset-persona="doResetPersona"
							@restore-memory="doRestoreMemory" @storage-probe="doStorageProbe"
							@intro-open="introOpen" @ambient-toggle="onAmbientToggle"
							@background-mode-change="onBackgroundModeChange" @bgm-download="onBgmDownload"
							@bgm-next="onBgmNext" @bgm-redownload="onBgmRedownload"
							@bgm-volume="onBgmVolume" @deepsea-quality-change="onDeepseaQualityChange"
							@float-render-scale="onFloatRenderScale" @mem-entry-tap="onMemEntryTap"
							@presence-retry="onPresenceRetry" @presence-toggle="onPresenceToggle"
							@quiet-mode-change="onQuietModeChange" @quiet-toggle="onQuietToggle"
							@sfx-volume="onSfxVolume" @open-about-page="openAboutPage"
							@open-persona-gate="openPersonaGate" @persist-settings="persistSettings"
							@refresh-models="refreshModels" @reset-float-window="resetFloatWindow"
							@retry-background="retryBackground" @save-settings-now="saveSettingsNow"
							@toggle-ui-style="toggleUiStyle" @bgm-toggle="onBgmToggle"
							@bgm-track-change="onBgmTrackChange" @float-toggle="onFloatToggle"
							@open-panel="openPanel" @set-ui-font="setUiFont"
							@set-l2d-fps="setL2dFps" />
						<!-- 关于 / 隐私 / 开源许可（2026-10-02 用户要求）: 复用现有 sheet 面板（入口在设置面板里），
						     四块内容缺一不可 —— 版本+上游声明 / 隐私说明 / 开源许可 / 反馈渠道。
						     许可细节与义务说明以仓库根 THIRD-PARTY.md 为准，这里只放要点 + 指向它。 -->
						<AboutPanel v-else-if="panel === 'about'" :version="APP_VERSION" :presence-ready="presenceReady" @open-url="openExternalUrl" />
					</div>
				</div>
			</div>
		</transition>

		<!-- 新手引导 (分步弹窗): 首次打开 (还没建立数据目录) 自动弹一次; 之后可由 设置 → 「新手引导」重新打开。
		     z-index 80 高于面板(20)/调试行(70), 保证任何时候都在最上层。 -->
		<transition name="sheet">
			<IntroDialog v-if="introOn" @close="introClose" @step-change="playSfx()" @open-url="openExternalUrl" />
		</transition>

		<!-- 模型授权验证（答题门，2026-10-01 为一键克隆引入；2026-10-02 起**同一道门**也守「下载模型」，
		     2026-10-14 起再守「下载官方人设」）
		     —— 照用户给的参考图做的结构：标题/说明/问题/输入框/取消·验证/底部提示。
		     只有一份弹窗与一份状态（gateOn/gateKind/...），动作靠 openGate(kind, onPass) 分岔：
		     clone = 建音色（原样，.clone-gate 这套类名/文案一字未改，probe-clone-gate 盯着）；
		     model = 放行后走原来的"切模型→下载"流程（进度还在 topbar 的 loadingMsg 上）；
		     persona = 放行后从静态托管拉官方人设文案（.persona-gate，标题/说明按动作分岔）。 -->
		<transition name="sheet">
			<AuthorizationGate
				v-if="gateOn"
				v-model:input="gateInput"
				:kind="gateKind"
				:message="gateMsg"
				:ok="gateOk"
				:busy="gateBusy"
				@close="closeGate"
				@submit="doGate"
			/>
		</transition>
	</div>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue"
import {
	createLive2D,
	normalizeRenderScale,
} from "./services/live2d"
import {applyCanvasLayout} from "./services/live2d/stage"
import {useModelControls} from "./composables/useModelControls"
import {useChatSession} from "./composables/useChatSession"
import {useReplyReactions} from "./composables/useReplyReactions"
import {useDiaryScheduler} from "./composables/useDiaryScheduler"
import {useStageInteraction} from "./composables/useStageInteraction"
import {useStageRendering} from "./composables/useStageRendering"
import {useAppVisibility} from "./composables/useAppVisibility"
import {useFloatControls} from "./composables/useFloatControls"
import {useStorageAccess} from "./composables/useStorageAccess"
import TouchSettingsPage from "./components/TouchSettingsPage.vue"
import PomodoroPanel from "./components/PomodoroPanel.vue"
import PomodoroWidget from "./components/PomodoroWidget.vue"
import PomodoroStatsPanel from "./components/PomodoroStatsPanel.vue"
import {usePomodoro} from "./composables/usePomodoro"
import {
	loadSettings,
	loadChat,
	persistChat,
	flushChatPersist,
	fetchModels,
	sendChat,
	cancelChatStream,
	type ChatMsg,
} from "./services/chat"
import {
	addMemoriesFromText,
	extractMemoriesSmart,
	pruneDoneGoals,
	flushMemoryPersist,
	setDiagEnabled,
	goalCarePrompt,
} from "./services/memory"
import {
	stop as stopTTS,
	setTtsErrorHandler,
	setTtsVolume,
} from "./services/tts"
import {stripInternalPromptMetadata} from "./services/chat/replyMetadata"
// 在线人数（2026-10-21）: 匿名心跳 + 纯逻辑文案；服务端见 services/presence/
import {startPresence} from "./services/presence"
import {usePresence} from "./composables/usePresence"
// 界面可选字体（2026-10-15）: system / 霞鹜文楷 / 站酷快乐体；纯逻辑在 services/ui-font.ts
import {UI_FONT_OPTIONS, applyUiFont, normalizeUiFont, type UiFontChoice} from "./services/ui-font"
import DiaryPanel from "./components/DiaryPanel.vue"
import SettingsPage from "./components/SettingsPage.vue"
import AboutPanel from "./components/AboutPanel.vue"
import IntroDialog from "./components/IntroDialog.vue"
import AuthorizationGate from "./components/AuthorizationGate.vue"
import {useAuthorizationGate} from "./composables/useAuthorizationGate"
import ModelPanels from "./components/ModelPanels.vue"
import {usePersonaSettings} from "./composables/usePersonaSettings"
import {useAppSettings} from "./composables/useAppSettings"
import ChatPanel from "./components/ChatPanel.vue"
import {useAudioControls} from "./composables/useAudioControls"
import {useTouchEditor} from "./composables/useTouchEditor"
import {useChatLayout} from "./composables/useChatLayout"
import {useSpeechFeedback} from "./composables/useSpeechFeedback"
import {useCanvasTransform} from "./composables/useCanvasTransform"
import {useMemoryPanel} from "./composables/useMemoryPanel"
import {useVoiceSettings} from "./composables/useVoiceSettings"
import MemoryPanel from "./components/MemoryPanel.vue"
import TtsSettingsPage from "./components/TtsSettingsPage.vue"
import {pauseBgm} from "./services/bgm"
import {setSfxVolume, playSfx} from "./services/sfx"
import {setAmbientEnabled, startAmbient, stopAmbient} from "./services/ambient"
import {habitRecord} from "./services/habit"
import {scheduleReturnToNeutral, cancelReturnToNeutral} from "./services/live2d/motionReturn"
import {clearPetFx} from "./services/live2d/petEffect"
import {disposePetAudio} from "./services/live2d/petAudio"
// 眨眼: 库内置的 CubismEyeBlink 被 model3.json 的空 EyeBlink 名单废掉了, 这里自己做
import {installBlink} from "./services/live2d/blink"
import {installLipSync} from "./services/live2d/lipSync"

type P = "model" | "motion" | "expression" | "touch" | "settings" | "tts" | "diary" | "memories" | "pomo" | "pomoStats" | "about" | ""

const l2dHost = ref<HTMLElement | null>(null)

const l2d = createLive2D()
const {
	loading, error, ready, currentModelId, motions, expressions,
	loadingMsg, modelList, listError, currentModel, pick, initializeModels,
} = useModelControls({
	l2d, host: () => l2dHost.value, settings: () => cfg,
	persistSettings: () => persistSettings(),
	closePanel: () => { panel.value = "" },
	openModelGate: onPass => openGate("model", onPass),
	restoreTransform: id => restoreTransform(id), relayout: () => relayout(),
	resetHeadLook: () => resetHeadLook(),
	loadTouchForModel: id => loadTouchForModel(id),
})
const panel = ref<P>("")
const settingsTab = ref<"basic" | "advanced">("basic")

const {
	touchBubble, aiBubble, portraitReply, speaking,
	triggerBubble, showAiBubble, showPortraitReply, clearPortraitReplyTimer,
	schedulePortraitReplyClear, maybeSpeakPetLine, clearPetLineBubble, speakSideLine,
	registerSpeakingHandler, bindReplyWatcher, clearReplyTimers, clearTouchBubbleTimer,
} = useSpeechFeedback({
	settings: () => cfg, typing: () => typing.value,
	chatStreaming: () => chatStreaming.value, touchStreaming: () => touchStreaming.value,
	chatOpen: () => chatOpen.value, panel: () => panel.value,
	updateTouchReplyPreview: text => { touchReplyPreview.value = text },
})
const {
	scale, offsetX, offsetY, canvasLocked, restoreTransform, clearTransformTouches,
	onModelTagDown, onModelTagMove, onModelTagSpace, onModelTagClick, cancelModelTagPress,
	onTouchStart, onTouchMove, onTouchEnd, flushTransformSave,
} = useCanvasTransform({
	modelId: currentModelId,
	inTouchSettings: () => panel.value === "touch",
	relayout: () => relayout(),
	openModelPanel: () => openPanel("model"),
})

const layoutVer = ref(0)

/**
 * 底栏图标 (2026-09-30)。取自网页版 NoriOS 底栏的 6 个图标（用户按序号点名的：你画我猜/算力/
 * 国际象棋/蛋糕对决/文件/致谢），缩到 144px 放在 `public/icons/`，作为**本机自用**素材。
 *
 * 为什么用字符串常量 + `:src`：`public/` 里的文件是原样落盘的，写成模板里的相对路径会被 Vite
 * 当成本地资源去解析（SFC 里不存在该文件 ⇒ 构建报错）。运行时按 `./icons/...` 相对文档解析，
 * WebView 走 WebViewAssetLoader（`/assets/web/index.html`）⇒ 正好命中 `assets/web/icons/`。
 */
const DOCK_ICONS = {
	diary: "./icons/dock-diary.svg",
	model: "./icons/dock-model.svg",
	touch: "./icons/dock-touch.svg",
	pomo: "./icons/dock-pomo.svg",
	settings: "./icons/dock-settings.svg",
	chat: "./icons/dock-chat.svg",
} as const

const panelTitle = (p: P) => ({model: "选择模型", motion: "动作列表", expression: "表情列表", touch: "互动设置", settings: "设置", tts: "语音合成", diary: "Nori 的心情日记", memories: "记忆库", pomo: "番茄钟", pomoStats: "专注统计", about: "关于 / 隐私 / 开源许可"} as Record<string, string>)[p] ?? ""

/* ---------------- 新手引导 (分步弹窗) ----------------
 * 首次打开 (还没建立数据目录) 自动弹一次; 之后设置页底部有「新手引导」按钮可重新打开。
 * 文案来自用户给的说明文档, 只做分步与润色, 内容不改。
 */
const introOn = ref(false)
const INTRO_SEEN_KEY = "intro_seen_v1"
const introOpen = (): void => { introOn.value = true }
const introClose = (): void => {
	introOn.value = false
	try { localStorage.setItem(INTRO_SEEN_KEY, "1") } catch { /* 忽略 */ }
	playSfx()
}

/** External links use the native browser when available, preserving WebView state. */
const openExternalUrl = (url: string): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(url)
		else window.open(url, "_blank")
	} catch { /* 打不开时不打断阅读或引导 */ }
	playSfx()
}

/* ---------------- 「关于 / 隐私 / 开源许可」页用到的常量（2026-10-02 用户要求） ----------------
 * 版本号：与 app/android/app/build.gradle 的 versionName 保持一致（前端随 APK 一起发版）。
 * ⚠ 别拿 web-src/package.json 的 version（脚手架留下的 0.1.0）当版本号 —— 那不是用户看到的版本。
 * 上游声明与许可清单同步自仓库根的 THIRD-PARTY.md（App 里只放要点 + 指向它）。 */
const APP_VERSION = "2.5.3"
/** 打开「关于 / 隐私 / 开源许可」页。入口在设置面板**最下面**，而 sheet 的滚动位置是跨面板保留的
 *  （`.sheet-body` 始终是同一个滚动容器）—— 不主动滚回顶部的话，点进来会直接落在「开源许可」那一屏，
 *  用户根本看不到开头的「版本」。所以切换面板后把内容滚回顶部。 */
const openAboutPage = (): void => {
	openPanel("about")
	void nextTick(() => {
		const body = document.querySelector<HTMLElement>(".sheet-body")
		if (body) body.scrollTop = 0
	})
}



const relayout = () => {
	applyCanvasLayout(l2d.canvas(), undefined, {
		zIndex: "1", scale: scale.value, offsetX: offsetX.value, offsetY: offsetY.value, animate: false,
	})

	layoutVer.value++
}




const touchReplyBusy = (): boolean => Boolean(typing.value || chatStreaming.value || touchStreaming.value || speaking.value)
const {
	touchAreas, selectedTouchId, touchCustomExpanded, touchEditingId, deletedTouch,
	touchEnabled, touchTesting, touchCooldownText, touchReplyPreview,
	touchDrawing, touchAdjusting, touchDraft, draftReady, drawingTarget,
	detector, configureTouchDetector, modelSize, loadTouchForModel,
	onTouchAdd, beginTouchEdit, cancelTouchEdit, previewTouchEdit, onTouchUpdate,
	onTouchRemove, undoTouchRemove, setTouchEnabled, toggleTouchTesting,
	onTouchTest, closeTouchSettings, onTouchCustomToggle, toggleTouchDraw, toggleTouchAdjust,
	resetTouchDraft, onDrawDown, onDrawMove, onDrawUp, boxStyle, clearTouchCooldown, disposeTouchDetector,
} = useTouchEditor({
	modelId: currentModelId, ready, loading, panel,
	scale, offsetX, offsetY, layoutVersion: layoutVer,
	canvas: () => l2d.canvas(),
	notify: (text, ms) => triggerBubble(text, ms),
	replyBusy: () => touchReplyBusy(),
	modelReady: () => modelReady.value,
	onTrigger: (area, type) => handleTouchTrigger(area, type),
	cancelStageInteraction: () => cancelStageInteraction(),
	closePanel: () => { panel.value = "" },
})

const {
	touchDotHost, hitDebug, hitZoneText, petDebugText,
	onPetTouchSetting, onStagePointerDown, onStagePointerMove, onStagePointerUp,
	cancelStageInteraction, resetHeadLook, canvasView, registerStageDiagnostics,
} = useStageInteraction({
	l2d, settings: () => cfg, ready, expressions, panel, scale, offsetX, offsetY,
	touchEditor: () => ({
		touchDrawing, touchAdjusting, touchTesting, touchEnabled,
		detector, modelSize, onDrawDown, onDrawMove, onDrawUp,
	}),
	background: () => background,
	persistSettings: () => persistSettings(), notify: triggerBubble,
	replyBusy: touchReplyBusy, maybeSpeakPetLine, clearTransformTouches,
})




const doMotion = (group: string, i: number) => {
	void l2d.playMotionByIndex(group, i)
	// 手动从「动作列表」触发的动作同样是 Loop:true, 也会一直保持 —— 一并安排回中性
	scheduleReturnToNeutral(returnToNeutral)
}

const playRand = () => {
	if (panel.value === "motion") { panel.value = ""; return }
	panel.value = "motion"
}

const playExpr = () => {
	if (panel.value === "expression") { panel.value = ""; return }
	if (!expressions.value.length) {
		l2d.playMotionByIndex("Idle", 0)
	} else {
		panel.value = "expression"
	}
}

const openPanel = (p: P) => {
	sideRailOpen.value = false
	imageMenu.value = false
	if (p === "settings" && panel.value !== p) settingsTab.value = "basic"
	// 打开/关闭任何面板都重置"记忆库入口"的连击计数 —— 否则计数会跨场景累积
	// (用户点两下入口、去别的面板逛一圈、回来点一下就直接进去了)
	resetMemEntryGate()
	// 打开设置/记忆库时: 先刷新(重读磁盘)再显示, 否则看到的是启动时的旧快照
	if (p === "settings" || p === "memories") {
		refreshMemFromDisk()
		if (p === "memories") { memSearch.value = ""; memFilter.value = "" }
	}
	if (p === "diary") scheduleDiary()
	panel.value = panel.value === p ? "" : p
}






const rippleHost = ref<HTMLElement | null>(null)

const spawnRipple = (e: Event) => {
	const btn = (e.target as HTMLElement).closest<HTMLElement>(".ripple")
	if (!btn) return
	const rect = btn.getBoundingClientRect()
	const m = e as MouseEvent
	const span = document.createElement("span")
	const d = Math.max(rect.width, rect.height) * 2
	span.className = "ripple-el"
	span.style.width = span.style.height = `${d}px`
	span.style.left = `${m.clientX - rect.left - d / 2}px`
	span.style.top = `${m.clientY - rect.top - d / 2}px`
	btn.appendChild(span)
	setTimeout(() => span.remove(), 600)
}



const {
	chatOpen, portraitLayout, sideRailOpen, keyboardOpen, keyboardInset, imageMenu,
	toggleChat, openPortraitHistory, scrollChatBottom, syncChatLayout,
	onComposerFocus, onComposerBlur, closeChatMenusOutside, bindChatViewport, unbindChatViewport,
} = useChatLayout({panel, scrollElement: () => chatPanelRef.value?.scrollElement})
const portraitActions: {panel: P; label: string; icon: string}[] = [
	{panel: "diary", label: "日记", icon: DOCK_ICONS.diary},
	{panel: "model", label: "模型", icon: DOCK_ICONS.model},
	{panel: "pomo", label: "番茄", icon: DOCK_ICONS.pomo},
	{panel: "settings", label: "设置", icon: DOCK_ICONS.settings},
]
const {
	draft, typing, chatStreaming, touchStreaming, messages,
	imagePicking, pendingImage, imagePreviews, pendingQueue,
	chooseImage, onInputEnter, send, stopGenerate, handleTouchTrigger, pokeNori, bindQueueWatcher,
} = useChatSession({
	settings: () => cfg, modelReady: () => modelReady.value,
	panel, chatOpen, imageMenu, speaking, portraitReply, touchReplyPreview,
	openSettings: () => { panel.value = "settings" },
	chatScrollElement: () => chatPanelRef.value?.scrollElement,
	triggerBubble, showPortraitReply, showAiBubble, scrollChatBottom,
	pomoPhase: () => pomo.value.phase, pomoPhaseText: () => pomoPhaseText.value,
	pomoSummary: () => pomoSummary.value, celebrated: () => pomoStats.celebrated,
	focusHintFresh: () => focusHintFresh(), markFocusHinted: () => markFocusHinted(),
	markCelebrated: key => markCelebrated(key),
	playMarkerEmotion: text => playMarkerEmotion(text), playMarkerMotion: text => playMarkerMotion(text),
	triggerEmotion: text => triggerEmotion(text), pickMotionByKeyword: text => pickMotionByKeyword(text),
	analyzeAfterReply: (text, reply) => analyzeAfterReply(text, reply),
	maybeAutoTuneExamples: () => maybeAutoTuneExamples(), refreshMemView: () => refreshMemView(),
})

registerStageDiagnostics()
// 眨眼: 装上"库 update() 之前"的钩子 (由 beforeUpdate 调度器统一分发)
installBlink()
/* 口型：默认关闭。开启后只以播放器状态作为活动闸门；真实振幅可用时按 RMS 开口，振幅缺失或超时则安全收口。
   惰性读取: 每帧现取 speaking.value, 所以注册一次就够, 不用管 model 重挂。 */
installLipSync(() =>
	cfg.lipSyncEnabled
	&& (speaking.value || (window as unknown as {__noriLipForce?: boolean}).__noriLipForce === true),
)
const {
	dataseaCanvas, deepseaCanvas, visibleBackground, backgroundError, footlight,
	background, renderScaleNum, nativeDpr, l2dFpsNum,
	bindFootlightSampling, applyRenderScale, applyL2dFps, setL2dFps,
	onBackgroundModeChange, onDeepseaQualityChange, retryBackground, setStageRenderPaused,
} = useStageRendering({
	l2d, ready, loading, layoutVersion: layoutVer,
	canvasView: () => canvasView(), settings: () => cfg,
	persistSettings: () => persistSettings(),
})
bindFootlightSampling()
const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null)
const modelOptions = ref<string[]>([])
const modelLoadMsg = ref("")

const {cfg, hydrateSettings, persistSettings} = useAppSettings({
	nativeDpr: () => nativeDpr.value,
	pomo: () => pomoCfg,
})

/* ---------------- 在线人数（2026-10-21，匿名心跳） ----------------
 * 逻辑全在 services/presence.ts（可单测）；这里只做数据绑定、设置开关和生命周期接线。
 * 未部署计数服务（PRESENCE_URL 为空）时整块 UI 不出现，也不发请求。 */
const {
	presenceState, presenceReady, presenceCount, presenceToday, presenceStatus, presenceToneClass, ensurePresenceWiring, onPresenceToggle, onPresenceRetry, disposePresence
} = usePresence({enabled: () => cfg.presenceEnabled, version: APP_VERSION, persistSettings: () => persistSettings()})

const chatFontPX = computed(() => `${14 * (Number(cfg.bubbleScale) || 1)}px`)

const bubbleScaleNum = computed(() => Number(cfg.bubbleScale) || 1)

const bubbleWidthNum = computed(() => Number(cfg.bubbleWidth) || 82)


const curModelName = computed(() => cfg.model || "未配置模型")

const {
	storageReady, storagePath, storageProbeMsg, allFilesAccess,
	doRequestAllFiles, doStorageProbe, grantStorage, refreshStorage, initializeStorage,
} = useStorageAccess({
	notify: triggerBubble,
	scheduleDiary: () => scheduleDiary(),
	refreshPomodoroStorage: () => refreshPomodoroStorage(),
})
/**
 * 外观风格: "soft" = 只保留**色板**的柔和风（**2026-10-01 起默认** —— 用户定稿「默认 UI 改成柔和」）;
 *            "pixel" = 网页版像素风（硬边/直角/斜纹），不再作为默认，但保留为可切换项做 A/B。
 *
 * 为什么还留着开关: 两种风格的取舍要在**真机上看**，一个包里带两套样式，用 `?ui=soft` / `?ui=pixel`
 * 或设置页按钮即可切换，不必来回刷两次固件。用户手动切过的记在 localStorage（`ui_style`）里，
 * 所以"改默认值"只影响没选过的人。只影响 class，不参与任何业务逻辑。
 */
const uiSoft = ref(true)
try {
	const q = new URLSearchParams(location.search).get("ui")
	const saved = localStorage.getItem("ui_style")
	if (q === "soft" || q === "tide" || q === "pixel") uiSoft.value = q === "soft"
	else if (saved === "soft") uiSoft.value = true
	else if (saved === "tide" || saved === "pixel") uiSoft.value = false
} catch { /* 忽略 */ }
const toggleUiStyle = (): void => {
	uiSoft.value = !uiSoft.value
	try { localStorage.setItem("ui_style", uiSoft.value ? "soft" : "tide") } catch { /* 忽略 */ }
	playSfx()
	triggerBubble(uiSoft.value ? "外观：柔和雾面" : "外观：潮汐玻璃", 2200)
}

/* ---------------- 界面字体（2026-10-15 用户要求） ----------------
 * 三个选项：系统默认 / 霞鹜文楷 / 站酷快乐体。后两个是随包的 OFL 子集（见 ui-fonts.less）。
 * 这里只管"当前选哪个 + 写进设置"；落 DOM 与字体栈由 services/ui-font.ts + ui-fonts.less 负责。 */
const uiFontNow = computed<UiFontChoice>(() => normalizeUiFont(cfg.uiFont))
const uiFontHint = computed<string>(() => UI_FONT_OPTIONS.find(o => o.value === uiFontNow.value)?.hint ?? "")
const setUiFont = (v: UiFontChoice): void => {
	if (uiFontNow.value === v) return
	cfg.uiFont = applyUiFont(v)
	persistSettings()
	playSfx()
	const label = UI_FONT_OPTIONS.find(o => o.value === v)?.label ?? v
	triggerBubble(`界面字体：${label}`, 2200)
}
/* ---------------- 自定义人设（2026-10-01 用户要求）----------------
 * 用户导入自己的提示词替代内置 `nori-prompt.md`; 内容存在本机 `persona.md`（见 services/chat）。
 * 这里只管**设置面板顶部那行的显示与两个按钮**; 真正取用哪份人设是 chat 里的 personaPrompt()。
 * ⚠ `personaName` 只在内存里（文件名不落盘）—— 重开 App 后只知道「有自定义」, 不知道原来叫什么。 */
const {
	personaName, personaCustom, personaChars, personaMsg, personaMsgOk, personaOfficial, personaDlMsg, personaDlOk, personaDlBusy, personaStateText, refreshPersonaState, doImportPersona, doResetPersona, openPersonaGate
} = usePersonaSettings({notify: triggerBubble, openGate: (onPass) => openGate("persona", onPass)})

const modelReady = computed(() => !!cfg.apiKey.trim() && !!cfg.model)
const refreshModels = async () => {
	modelLoadMsg.value = "加载中…"
	const r = await fetchModels(cfg.baseUrl, cfg.apiKey)
	if (!r.ok) { modelLoadMsg.value = r.message ?? "加载失败"; return }
	modelOptions.value = r.models ?? []
	if (modelOptions.value.length && !modelOptions.value.includes(cfg.model)) cfg.model = modelOptions.value[0]
	modelLoadMsg.value = `找到 ${modelOptions.value.length} 个模型`
}

bindQueueWatcher()


/* ---------------- 记忆系统 UI 状态 ---------------- */
/* P5 起"近端保留多少条/这次能裁多少条"由记忆服务决定 (RAW_WINDOW 与 safeTrimDrop),
   界面不再自己写死 20 —— 之前界面与记忆层各存一份窗口大小, 是"裁剪把没总结的消息删掉"
   这类 bug 的温床。 */
const memory = useMemoryPanel({
	cfg, messages,
	persistSettings: () => persistSettings(),
	notify: triggerBubble,
})
const memoryPanel = reactive(memory)
const {
	health, nonGoalMemories, goals, memSearch, memFilter, refreshMemView, refreshMemFromDisk, maybeAutoTuneExamples,
	hasBackup, doClearMemory, doRestoreMemory, doExportAll, doPruneMemories, memPruneMsg, memPruneMsgOk,
} = memory

/* ---------------- 日记：空闲时最多补一篇，聊天开始即停止 ---------------- */
const openDiary = () => openPanel("diary")
const {stopAutoDiary, scheduleDiary, bindDiaryWatcher} = useDiaryScheduler({
	settings: () => cfg, chatStreaming, touchStreaming,
})
bindDiaryWatcher()
onMounted(scheduleDiary)
onBeforeUnmount(stopAutoDiary)

/* ---------------- Fish Audio 流式 TTS UI 状态 ---------------- */
bindReplyWatcher()
const voice = useVoiceSettings({cfg, persistSettings: () => persistSettings()})
const voiceSettings = reactive(voice)
const {clonePrefix, rememberCloneVoice} = voice

/** 滑块实时调整"应用内朗读音量" (只影响本 App 播放, 不动系统音量; 松手时 change 事件落盘) */
const applyTtsVolume = () => setTtsVolume(Number(cfg.ttsVolume))

/* ---------------- 背景音乐 ---------------- */
const {
	bgmNowName, bgmState, bgmPct, bgmQuietHold,
	bgmQuickTrack, bgmQuickActionLabel, bgmQuickStatus, bgmCanSkip,
	onBgmToggle, onBgmQuickToggle, onBgmTrackChange, onBgmVolume,
	onBgmNext, onBgmDownload, onBgmRedownload, onSfxVolume,
	sfxMsg, sfxMsgOk, sfxMsgBad, sfxBusy, sfxBtnText, doDownloadSfx,
	onAmbientToggle, quietActive, ambientAllowed, bgmHeld, applyQuiet, onQuietModeChange, onQuietToggle,
	registerBgmErrorHandler, registerBgmStateHandler, restoreBgm, initializeSfxControls, startQuietTimer, disposeAudioControls,
} = useAudioControls({
	cfg, persistSettings, notify: triggerBubble,
	pomoFocusMuted: () => pomoFocusMuteOn.value,
	cancelPomoSulk: () => pomoSulkCancelByUser(),
})

/** 底部 dock 按键音 (按到按钮上才响, 点空白处不响); 安静模式也保留按键音 */
const onDockPress = (e: PointerEvent): void => {
	if ((e.target as HTMLElement)?.closest?.(".fab, .side-action")) playSfx()
}
/* ---------------- 番茄钟 ----------------
 * 计时本体在原生 PomodoroEngine (进程存活即准点触发, 完成发系统通知);
 * 这里是遥控器 + 悬浮窗视图 + 联动: 播报(sfx/TTS)/每日统计(pomo.json)/放弃静音惩罚/ambient 抑制。
 * 时长以原生单调时钟快照为准；页面只展示，旧桥兼容 epoch 时间戳。 */
const pomodoro = usePomodoro({
	cfg,
	panel,
	showPanel: value => { panel.value = value },
	persistSettings,
	applyQuiet: () => applyQuiet(),
})
const pomodoroModel = reactive(pomodoro)
const {
	pomo, pomoCfg, pomoWidgetOn, pomoFocusMuteOn,
	pomoStats, pomoStatsReady, pomoError, pomoConfigError, pomoMessage,
	pomoBusy, pomoQuietHeld, pomoRestorePreview, pomoConfirmEnd,
	pomoFmt, pomoPct, pomoPhaseText, pomoEndText, pomoLiveMin,
	pomoSummary, pomoWeekBars, pomoSyncText, pomoReminderAction, pomoReminderText,
	pomoReminderSettings, pomoExport, pomoAction, pomoUpdateDisplay, pomoRefreshDate,
	pomoSulkCancelByUser, focusHintFresh, markFocusHinted, markCelebrated,
	initializePomodoro, mountPomodoro, refreshPomodoroStorage, disposePomodoro,
} = pomodoro
initializePomodoro()

/* ---------------- 模型授权验证（答题门，2026-10-01；2026-10-02 抽成两处共用；2026-10-14 三处） ----------------
   同一道门守三个"要联网拿 inori 东西"的动作：
     · clone —— 一键克隆内置音色（原样：建音色 → 轮询审核 → 选中并持久化；参考音频同样走**联网下载**，
                 原生侧负责下载+规范成 16bit，见 ChatBridge.createPresetCloneVoice）
     · model —— 下载还没装的 Live2D 模型（见下面 pick()：**答对才真的开始下载**）
     · persona —— 下载官方人设文案（见 openPersonaGate()：**答对才去拉 .md**）
   题面/答案/判卷在 services/tts/clone-gate.ts（唯一事实源）；这里只放"这道门此刻为谁开"。
   弹窗只有一份，克隆那边的类名(.clone-gate)与文案一字未改 —— probe-clone-gate 是护栏。 */
const {
	gateOn, gateKind, gateInput, gateMsg, gateOk, gateBusy,
	openGate, closeGate, openCloneGate, doGate,
} = useAuthorizationGate({cfg, clonePrefix, rememberCloneVoice, persistSettings, triggerBubble})

registerSpeakingHandler()
const {playMarkerEmotion, playMarkerMotion, returnToNeutral, pickMotionByKeyword, triggerEmotion} =
	useReplyReactions({l2d, ready, motions, expressions})

/**
 * 合并 AI 分析 (表情细化 + 记忆提取, 一次 LLM 调用, 省 token 省延迟)
 * - 表情: 先由关键词规则即时播放, 这里用 AI 结果细化/纠正
 * - 记忆: 规则结果 + AI 提取结果合并去重入库
 */
const analyzeAfterReply = async (userText: string, _replyText: string) => {
	// 表情/动作已由流式标记驱动, 这里只做记忆写入:
	// Mem0 两段式 → 规则免费兜底 + AI 提取事实 + AI 决策入库(ADD/UPDATE/DELETE/NONE),
	// 有净新增/改写时用气泡提示 (让用户知道 Nori 记住了什么).
	try {
		const llmOk = cfg.memoryLlmExtract && !!cfg.apiKey.trim() && !!cfg.model.trim()
		// 最近对话 (不含当前句) 供 AI 理解指代, 不作为提取来源
		const recent = messages.value
			.filter(m => m.role === "user" || m.role === "assistant")
			.slice(-6, -1)
			.filter(m => !(m.role === "user" && m.content === userText))
			.map(m => ({role: m.role, content: m.content}))
		/** 记忆相关的小调用统一走这里 (记忆提取与目标收尾共用同一个判据与端点) */
		const llmCall = async (prompt: string): Promise<string> => {
			const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
				{role: "system", content: prompt} as ChatMsg,
			])
			return r.ok ? (r.content ?? "") : ""
		}
		/* 记忆写入 (2026-09-27 重构 P3: 默认**不再**逐句提取)。
		   现在的分工: 近期对话靠原文上下文, 记忆由"每次历史总结顺手筛出"生产
		   (见下方 summarizeIfNeeded → services/memory 的记忆块通道)。
		   留 memoryRealtimeExtract 开关只为出问题能一键切回旧的逐句通道。 */
		if (cfg.memoryRealtimeExtract) {
			const res = await extractMemoriesSmart(
				userText,
				llmOk ? llmCall : null,
				recent,
			)
			if (res.tips.length) {
				const fmt = `记住了：${res.tips.join("、")}`
				triggerBubble(fmt.length > 36 ? `${fmt.slice(0, 36)}…` : fmt, 3200)
			}
		}
		/* 目标收尾 (2026-09-27 用户要求): 主人这句若明确表示某个「陪着你的事」已完成/已放弃,
		   由 LLM 判定并把它从清单里摘掉 —— 否则目标会被每 3 天问一次、永远不收尾。
		   · 库里没有目标时**零调用**(pruneDoneGoals 内部先查);
		   · 判定失败/超时/编造 id → 什么都不删 (见 memory/index.ts 的注释);
		   · 与记忆提取共用同一个 llmCall 判据 (都要求开关开启且配了 Key)。
		   ⚠ 单独一次调用而不是并进记忆提取: 两件事语义无关, 合并会互相污染, 而"判错就删目标"
		     属于用户数据损失, 不值得为省一次调用冒这个险。 */
		if (llmOk) {
			try {
				const done = await pruneDoneGoals(userText, llmCall, recent)
				if (done.length) {
					const fmt = `这个目标我就先收起来啦：${done.join("、")}`
					triggerBubble(fmt.length > 40 ? `${fmt.slice(0, 40)}…` : fmt, 3600)
				}
			} catch (e) {
				console.error("[goal] pruneDoneGoals failed:", e)
			}
		}
		refreshMemView()
	} catch (e) {
		// 兜底: 规则记忆
		console.error("[mem] extractMemoriesSmart failed:", e)
		try {
			addMemoriesFromText(userText)
		} catch (e2) {
			console.error("[mem] fallback addMemoriesFromText failed:", e2)
		}
		refreshMemView()
	}
}

/**
 * 记忆库入口的"害羞拦门"状态 (2026-09-27 用户要求)。
 *
 * 用户点「记忆库」时先弹气泡 + 念一句「这样子看的话，nori 会害羞的。」, **点第三下才真的进去**。
 * 为什么要有这条: 记忆库是她的"心里话", 用户希望进去之前有个当面的反应, 而不是静默翻开。
 *
 * 计数复位规则 (不谨慎就会锁死或形同虚设):
 *   · `entryGateLeaveTimer`: 4 秒没再点 → 假设用户走开了, 计数归零 (否则"点两次、过一会儿点一次"就进去了);
 *   · 打开/关闭任何面板 (openPanel) → 归零;
 *   · 真正进入记忆库 → 归零 (下次再进要重新数三下)。
 */
const MEM_ENTRY_CLICKS = 3
const memEntryClicks = ref(0)
let memEntryLeaveTimer: ReturnType<typeof setTimeout> | null = null
const MEM_ENTRY_LEAVE_MS = 4000
const openMemoriesPage = () => openPanel("memories")
const resetMemEntryGate = (): void => {
	memEntryClicks.value = 0
	if (memEntryLeaveTimer) { clearTimeout(memEntryLeaveTimer); memEntryLeaveTimer = null }
}


/**
 * 点击设置页里的「记忆库」入口。
 * 前两次只给反应 (气泡 + 朗读), 第三次才真的打开。
 */
const onMemEntryTap = (): void => {
	memEntryClicks.value += 1
	if (memEntryClicks.value >= MEM_ENTRY_CLICKS) {
		resetMemEntryGate()
		openMemoriesPage()
		return
	}
	const left = MEM_ENTRY_CLICKS - memEntryClicks.value
	/* 气泡用**小气泡**（`triggerBubble`，与「记住了：…」同一套），不用 Nori 气泡：
	   · 与"记忆新内容"的提示视觉统一（用户 2026-09-27 要求）；
	   · 小气泡 z-index 15，聊天面板打开时也看得见 —— 而 Nori 气泡（58）会盖在面板内容上。 */
	triggerBubble(`这样子看的话，nori 会害羞的。（还差 ${left} 下）`, 3000)
	speakSideLine("这样子看的话，nori 会害羞的。")
	if (memEntryLeaveTimer) clearTimeout(memEntryLeaveTimer)
	memEntryLeaveTimer = setTimeout(() => { memEntryLeaveTimer = null; memEntryClicks.value = 0 }, MEM_ENTRY_LEAVE_MS)
}

/** E2E/实机诊断探针: 聊天与记忆管线的最小状态快照 (纯读, 不建连接)。
 *  排查"发完消息后记忆/目标判定没动静"这类问题时, 控制台敲 `__noriDiagChat()` 就能看到
 *  到底是①没配 Key ②消息没发出去 ③回复为空 还是 ④提取被开关关掉了。 */
;(window as unknown as {__noriDiagChat?: () => unknown}).__noriDiagChat = () => ({
	hasKey: !!cfg.apiKey.trim(),
	model: cfg.model,
	baseUrl: cfg.baseUrl,
	memoryLlmExtract: !!cfg.memoryLlmExtract,
	chatOpen: chatOpen.value,
	typing: typing.value,
	chatStreaming: chatStreaming.value,
	msgCount: messages.value.length,
	lastRoles: messages.value.slice(-4).map(m => `${m.role}:${String(m.content).slice(0, 20)}`),
	hasStreamBridge: typeof (window as unknown as {NoriChat?: {chatStream?: unknown}}).NoriChat?.chatStream === "function",
})

const saveSettingsNow = () => {
	// 如实反馈: 写盘失败时不再谎报"设置已保存", 而且把原生给的真实原因一并显示 ——
	// 只说"存储不可写"会把 err:insert / err:stream / SecurityException 等差异全盖掉, 真机没法定位。
	const raw = persistSettings()
	applyRenderScale()
	modelLoadMsg.value = ""
	const ok = raw === "ok"
	triggerBubble(ok ? "设置已保存" : `设置保存失败：${raw} —— 请打开「所有文件访问权限」（系统设置 → 应用 → NoriDroid → 特殊应用权限）`, ok ? 2000 : 6000)
}

/* ---------------- 悬浮窗 ---------------- */
const {
	floatPermission, floatPermissionHint, refreshFloatPermission,
	onFloatToggle, resetFloatWindow, onFloatRenderScale,
} = useFloatControls({
	settings: () => cfg, nativeDpr: () => nativeDpr.value,
	persistSettings, notify: triggerBubble,
})

// 音色选择后自动保存 (防抖, 避免手滑连续切换时频繁写文件)
let voiceSaveTimer: ReturnType<typeof setTimeout> | null = null
const saveVoicesDebounced = () => {
	if (voiceSaveTimer) clearTimeout(voiceSaveTimer)
	voiceSaveTimer = setTimeout(() => {
		voiceSaveTimer = null
		persistSettings()
	}, 600)
}
// Fish 的音色
watch(() => cfg.ttsReferenceId, saveVoicesDebounced)
// 千问的模型与音色 —— 与上面同一套防抖写法。
// 不用 @change 的原因: 用户打完字直接关面板时 input 不会失焦, change 根本不触发, 改动就丢了;
// watch 在最后一次输入后 600ms 落盘, 不依赖失焦。
watch([() => cfg.cosyModel, () => cfg.cosyVoice], saveVoicesDebounced)

const onResize = () => {
	syncChatLayout()
	relayout()
	background.resize(renderScaleNum.value)
}

const {renderPause, onNativeVisibility, onVisibility} = useAppVisibility({
	version: APP_VERSION, settings: () => cfg, setStageRenderPaused,
	refreshFloatPermission, refreshStorage, cancelStageInteraction, stopAutoDiary,
	pomoUpdateDisplay, pomoRefreshDate,
	memoryHasPersistError: () => !!health.value.lastPersistError,
	refreshMemFromDisk, bgmHeld, chatStreaming, touchStreaming, messages,
})

onMounted(async () => {
	window.addEventListener("resize", onResize)
	bindChatViewport()

	document.addEventListener("pointerdown", onStagePointerDown)
	document.addEventListener("pointermove", onStagePointerMove)
	document.addEventListener("pointerup", onStagePointerUp)
	document.addEventListener("pointercancel", onStagePointerUp)
	document.addEventListener("lostpointercapture", onStagePointerUp)
	window.addEventListener("blur", cancelStageInteraction)

	window.addEventListener("focus", refreshStorage)
	window.addEventListener("nori-app-pause", onNativeVisibility)
	window.addEventListener("nori-app-resume", onNativeVisibility)
	document.addEventListener("visibilitychange", onVisibility)
	// TTS 合成失败提示 (不打断对话)
	setTtsErrorHandler((msg) => triggerBubble(`语音合成失败：${msg}`))
	// BGM 加载失败提示
	registerBgmErrorHandler()


	hydrateSettings(loadSettings())
	setSfxVolume(Number(cfg.sfxVolume))
	background.setQuality(cfg.deepseaQuality)
	applyUiFont(cfg.uiFont)
	setDiagEnabled(cfg.memoryDiagnostics)
	// 同步原生悬浮窗开关标记 (退出判断用, 不依赖 settings.json 读写时序)
	try { window.NoriChat?.setFloatEnabled?.(!!cfg.floatEnabled) } catch { /* 忽略 */ }
	refreshFloatPermission()
	// 在线人数（2026-10-21）: 只有配置了计数服务才接线/发心跳；未配置时零请求
	ensurePresenceWiring()
	if (presenceReady.value && cfg.presenceEnabled) startPresence(APP_VERSION)
	// 应用内朗读音量 (按设置初始化; 之后滑块可实时调整)
	setTtsVolume(Number(cfg.ttsVolume))
	// 背景音乐: 注册资源状态回调后恢复播放 (缺失时自动下载; 自动播放被拦时服务内挂手势重试)
	registerBgmStateHandler()
	// 安静模式自愈必须在 syncBgm **之前**: 若上次专注期间被杀, settings.json 里残留
	// manual+on, 而 syncBgm 会照着它**起播** —— 随后 applyQuiet 才把它挂起, 结果是
	// "先响半秒再静音"。先还原成进专注前的配置, syncBgm 一开始就不会播。
	// (自动模式的重估放在后面, 每分钟一次, 跨过 23:00/8:00 边界即时切换)
	mountPomodoro()
	applyQuiet()
	restoreBgm()
	// 音效文件: 注册下载结果回调 + **首次进入读一次状态** (没下载时设置里显示「未下载」,
	// 按键音静默不播 —— 判断在 services/sfx.ts 里, 每次播之前现问一次原生)
	initializeSfxControls()
	// 初始化所选背景；可见性由原生和网页生命周期共同控制。
	habitRecord("open")
	background.setMode(cfg.backgroundMode)
	renderPause.setNativePaused(window.__noriAppPaused === true)
	// Background initialization may have started after an earlier native pause event.
	setStageRenderPaused(renderPause.setHidden(document.hidden))
	// Ambient 主动搭话: 安静几分钟后轻轻说一句 (语料本地, 零 token)
	startAmbient({
		speak: (line) => {
			if (!chatOpen.value) showAiBubble(line)
		},
		goalLine: () => {
			const line = goalCarePrompt()
			if (line) {
				const m = line.match(/「(.+?)」/)
				return m ? `对了，你说要「${m[1]}」的，进展怎么样啦？不要有压力哦，我就是问问。` : line
			}
			return null
		},
		idleAllowed: () =>
			panel.value === "" && !chatOpen.value && !chatStreaming.value && !touchStreaming.value && !typing.value,
	})
	startQuietTimer()
	window.__noriRenderScale = normalizeRenderScale(renderScaleNum.value, 1)
	// 设置加载后同步背景分辨率。
	background.resize(renderScaleNum.value)
	// 启动即应用帧率档位 (设置加载完成后才有效; l2d 的 installFrameCap 已给默认档)
	applyL2dFps()
	initializeStorage()

	if (!storageReady.value && !localStorage.getItem("storage_asked")) {
		localStorage.setItem("storage_asked", "1")
		setTimeout(grantStorage, 1200)
	}
	/* 新手引导: 首次打开 (还没建立数据目录) 且没看过时自动弹一次。
	 * 判据用 isStorageReady() 而不是"memory.json 存不存在": 它读的就是 Downloads/NoriDroid 目录,
	 * 目录建好即为"不是第一次"。宽限 1.6s 是等首帧/模型起头, 避免和启动动画抢注意力;
	 * 存储权限弹窗 (上面那个 setTimeout) 会盖住引导, 所以这里刻意晚于它。 */
	if (!storageReady.value && !localStorage.getItem(INTRO_SEEN_KEY)) {
		setTimeout(() => {
			if (!localStorage.getItem(INTRO_SEEN_KEY) && !introOn.value) introOpen()
		}, 1600)
	}
	const loadedChat = loadChat()
	const cleanedChat = loadedChat.map((m) => {
		if (m.role !== "assistant") return m
		const content = stripInternalPromptMetadata(m.content)
		return content === m.content ? m : {...m, content}
	}).filter((m) => m.role === "system" || m.content.trim() || m.parts?.length)
	messages.value = cleanedChat
	if (cleanedChat.length !== loadedChat.length || cleanedChat.some((m, i) => m !== loadedChat[i])) persistChat(cleanedChat)
	refreshMemView()
	window.dispatchEvent(new Event("nori-diary-updated"))
	// 自定义人设的那行状态 (有导入过就显示「自定义 · N 字」, 否则内置)
	refreshPersonaState()
	if (cfg.apiKey.trim()) refreshModels()

	await initializeModels()
})

onBeforeUnmount(async () => {
	cancelModelTagPress()
	flushTransformSave()
	window.removeEventListener("resize", onResize)
	unbindChatViewport()
	clearReplyTimers()
	document.removeEventListener("pointerdown", onStagePointerDown)
	document.removeEventListener("pointermove", onStagePointerMove)
	document.removeEventListener("pointerup", onStagePointerUp)
	document.removeEventListener("pointercancel", onStagePointerUp)
	document.removeEventListener("lostpointercapture", onStagePointerUp)
	window.removeEventListener("blur", cancelStageInteraction)
	window.removeEventListener("focus", refreshStorage)
	window.removeEventListener("nori-app-pause", onNativeVisibility)
	window.removeEventListener("nori-app-resume", onNativeVisibility)
	document.removeEventListener("visibilitychange", onVisibility)
	// 在线人数（2026-10-21）: 停心跳 + 清 60s 刷新计时器
	disposePresence()
	clearTouchBubbleTimer()
	clearTouchCooldown()
	if (voiceSaveTimer) clearTimeout(voiceSaveTimer)
	// 页面销毁前: 落盘防抖中的聊天记录, 避免丢最后一条
	flushChatPersist()
	background.destroy()
	// 页面销毁前: 记忆/总结的防抖写盘也立即落盘 (防丢最后改动)
	await flushMemoryPersist()
	// 悬浮窗的启动由 MainActivity 生命周期统一处理，页面卸载不重复拉起。
	// 页面销毁前停止朗读 / 流式聊天 / 背景音乐
	stopTTS()
	cancelChatStream()
	pauseBgm()
	stopAmbient()
	disposeAudioControls()
	disposePomodoro()
	setTtsErrorHandler(null)
	disposeTouchDetector()
	cancelReturnToNeutral()
	clearPetFx()
	// 合成音的噪声源是 loop 的: 不显式停掉, 退出页面后它还会占着音频焦点
	disposePetAudio()
	await l2d.destroy()
})
</script>

<style lang="less" scoped src="./assets/style/app-shell.less"></style>
