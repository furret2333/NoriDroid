import {reactive} from "vue"
import {saveSettingsRaw, normalizeCloneVoices, type BackgroundMode, type DeepseaQuality, type CosyCloneVoice, type Settings} from "../services/chat"
import {normalizeFps} from "../services/live2d/frameCap"
import {normalizeRenderScale} from "../services/live2d/renderScale"
import {normalizeUiFont, type UiFontChoice} from "../services/ui-font"
import {normalizePomo, type PomoConfig} from "../services/pomodoro"

const createSettingsState = () => ({
	apiKey: "",
	baseUrl: "https://api.openai.com/v1",
	model: "",
	/** 上次选的 Live2D 模型 id (空 = 没选过 ⇒ 启动用已装列表第一个)。
	 *  2026-09-30 修：以前没存这个，换模型后重启会回到列表第一个。 */
	live2dModel: "",
	bubbleScale: 1,
	bubbleWidth: 82,
	renderScale: 1,
	/** Live2D 渲染帧率档位 (0 = 不限制)。档位定义见 services/live2d/frameCap.ts */
	l2dFps: 60,
	ttsEnabled: false,
	lipSyncEnabled: false,
	petTouchEnabled: true,
	petTouchEffects: true,
	petTouchSound: true,
	petTouchSpeech: true,
	ttsProvider: "fish" as "fish" | "cosyvoice",
	ttsApiKey: "",
	ttsBaseUrl: "https://api.fish.audio",
	ttsReferenceId: "",
	ttsModel: "s2.1-pro",
	ttsFormat: "mp3",
	ttsChunkLength: 120,
	ttsLatency: "balanced",
	cosyApiKey: "",
	cosyBaseUrl: "https://dashscope.aliyuncs.com",
	cosyModel: "cosyvoice-v3.5-flash",
	cosyVoice: "",
	cosyRate: 1,
	ttsVolume: 1,
	bgmEnabled: false,
	bgmTrack: "random",
	bgmVolume: 0.35,
	sfxVolume: 0.5,
	dataseaBg: true, // 兼容仍接收 Settings 的既有服务
	backgroundMode: "datasea" as BackgroundMode,
	deepseaQuality: "balanced" as DeepseaQuality,
	/** 界面字体（2026-10-15）：system 系统默认 / wenkai 霞鹜文楷 / kuaile 站酷快乐体（后两者随包 OFL 子集） */
	uiFont: "system" as UiFontChoice,
	/** 让 Nori 知道当前时间（2026-10-01）：每次对话在人格之后追加一个时间块；关掉即回到以前 */
	timeAware: true,
	ambientEnabled: true,
	quietMode: "off",
	quietOn: false,
	cosyCloneVoices: [] as CosyCloneVoice[],
	trimHistory: true,
	memoryLlmExtract: true,
	/** 实时(逐句)记忆提取: 重构 P3 起默认关, 记忆由历史总结一次产出 (见 services/memory) */
	memoryRealtimeExtract: false,
	/** 自动优化记忆示例 (默认关; 见设置里「记忆优化」小节) */
	memoryAutoTuneExamples: false,
	/** 记忆诊断日志 (默认关; 只留内存, 导出才落盘 —— 见 P1「观测闭环」) */
	memoryDiagnostics: false,
	smartRecall: true,
	emotionLlm: true,
	/** DeepSeek 思考模式: **默认开**（2026-10-02 用户纠正）。服务端默认也是开的,
	 *  但只有把开关**显式**传出去, 这个勾选框才真的能关掉它 —— 见 services/chat 的 resolveThinking */
	deepseekThinking: true,
	lookFlipX: false,
	lookFlipY: false,
	lookSens: 0.2,
	floatEnabled: false,
	floatBubbleW: 82,
	floatRenderScale: 2,
	/** 在线人数（2026-10-21）: 匿名心跳开关，默认开；关掉后不发任何请求 */
	presenceEnabled: true,
})

export type AppSettings = ReturnType<typeof createSettingsState>

export interface AppSettingsOptions {
	nativeDpr: () => number
	pomo: () => PomoConfig
}

/** Owns configuration data; applying it to renderers and native services stays with the app. */
export const useAppSettings = (options: AppSettingsOptions) => {
	const cfg = reactive(createSettingsState())

	const hydrateSettings = (s: Settings): void => {
		cfg.apiKey = s.apiKey
		cfg.baseUrl = s.baseUrl || "https://api.openai.com/v1"
		cfg.model = s.model
		// 上次选的 Live2D 模型 (旧设置文件没有这个字段 → 空串 ⇒ 启动走"已装列表第一个")
		cfg.live2dModel = s.live2dModel ?? ""
		cfg.bubbleScale = s.bubbleScale || 1
		cfg.bubbleWidth = Number(s.bubbleWidth) || 82
		// 默认封顶 1.5x（2026-10-05 从 2 下调）: 台式/大屏上两层合计填充 3.206 → 1.297 MP(−60%)。
		// 用户显式设置过的值不受影响。真正生效的倍率还会被"最长边上限"再夹一次(见 live2d/index.ts)。
		cfg.renderScale = normalizeRenderScale(s.renderScale, Math.min(options.nativeDpr(), 1.5))
		// 旧设置文件没有 l2dFps → normalizeFps 回落到默认档 (60)
		cfg.l2dFps = normalizeFps(s.l2dFps)
		cfg.ttsEnabled = !!s.ttsEnabled
		// 口型默认关闭；旧设置文件缺少该字段时必须保持关闭
		cfg.lipSyncEnabled = s.lipSyncEnabled === true
		cfg.petTouchEnabled = s.petTouchEnabled !== false
		cfg.petTouchEffects = s.petTouchEffects !== false
		cfg.petTouchSound = s.petTouchSound !== false
		cfg.petTouchSpeech = s.petTouchSpeech !== false
		cfg.bgmEnabled = !!s.bgmEnabled
		cfg.bgmTrack = s.bgmTrack || "random"
		cfg.ttsProvider = s.ttsProvider === "cosyvoice" ? "cosyvoice" : "fish"
		cfg.ttsApiKey = s.ttsApiKey ?? ""
		cfg.ttsBaseUrl = s.ttsBaseUrl || "https://api.fish.audio"
		cfg.ttsReferenceId = s.ttsReferenceId ?? ""
		cfg.ttsModel = s.ttsModel || "s2.1-pro"
		cfg.ttsFormat = s.ttsFormat || "mp3"
		cfg.ttsChunkLength = s.ttsChunkLength || 120
		cfg.ttsLatency = s.ttsLatency || "balanced"
		cfg.cosyApiKey = s.cosyApiKey ?? ""
		cfg.cosyBaseUrl = s.cosyBaseUrl || "https://dashscope.aliyuncs.com"
		cfg.cosyModel = s.cosyModel || "cosyvoice-v3.5-flash"
		cfg.cosyVoice = s.cosyVoice ?? ""
		cfg.cosyRate = Number(s.cosyRate) || 1
		cfg.ttsVolume = Number.isFinite(Number(s.ttsVolume)) ? Math.min(1, Math.max(0, Number(s.ttsVolume))) : 1
		cfg.bgmVolume = Number.isFinite(Number(s.bgmVolume)) ? Math.min(1, Math.max(0, Number(s.bgmVolume))) : 0.35
		cfg.sfxVolume = Number.isFinite(Number(s.sfxVolume)) ? Math.min(1, Math.max(0, Number(s.sfxVolume))) : 0.5
		cfg.backgroundMode = s.backgroundMode
		cfg.deepseaQuality = s.deepseaQuality
		cfg.dataseaBg = cfg.backgroundMode !== "off"
		cfg.timeAware = s.timeAware !== false      // 旧设置文件没这个字段 ⇒ 默认开
		cfg.ambientEnabled = s.ambientEnabled !== false
		// 老设置文件没有界面字体时使用系统默认。
		cfg.uiFont = normalizeUiFont(s.uiFont)
		cfg.quietMode = ["off", "auto", "manual"].includes(String(s.quietMode)) ? String(s.quietMode) : "off"
		cfg.quietOn = !!s.quietOn
		cfg.cosyCloneVoices = normalizeCloneVoices(s.cosyCloneVoices)
		cfg.trimHistory = s.trimHistory !== false
		cfg.memoryLlmExtract = !!s.memoryLlmExtract
		// 实时通道默认**关** (重构 P3): 只有显式存过 true 才开 (老设置文件里没有这个字段 → 关)
		cfg.memoryRealtimeExtract = s.memoryRealtimeExtract === true
		cfg.memoryAutoTuneExamples = s.memoryAutoTuneExamples === true
		cfg.memoryDiagnostics = s.memoryDiagnostics === true
		cfg.smartRecall = s.smartRecall !== false
		cfg.emotionLlm = s.emotionLlm !== false
		/* 思考模式: 2026-10-02 用户纠正为**默认开**。
		 * 老设置文件里那个 `false` 是**旧默认**自动写进去的 (persistSettings 会把全部字段写盘),
		 * 不代表用户的选择 —— 所以按 `thinkDefaultV2` 标记**一次性迁移**成开;
		 * 迁移过的机器上, 用户手动关掉就永久生效 (标记已落盘, 不会再被翻回来)。 */
		cfg.deepseekThinking = s.thinkDefaultV2 === true ? !!s.deepseekThinking : true
		cfg.lookFlipX = !!s.lookFlipX
		cfg.lookFlipY = !!s.lookFlipY
		cfg.lookSens = Number(s.lookSens) || 0.2
		cfg.floatEnabled = !!s.floatEnabled
		cfg.floatBubbleW = Number(s.floatBubbleW) || 82
		cfg.floatRenderScale = normalizeRenderScale(s.floatRenderScale, options.nativeDpr())
		// 在线人数（2026-10-21）: 老设置文件没这个字段 ⇒ 默认开
		cfg.presenceEnabled = s.presenceEnabled !== false
	}

	const persistSettings = (): string => {
		const raw = saveSettingsRaw({
	        pomo: normalizePomo(options.pomo()),
			apiKey: cfg.apiKey,
			baseUrl: cfg.baseUrl,
			model: cfg.model,
			live2dModel: cfg.live2dModel || "",
			bubbleScale: Number(cfg.bubbleScale) || 1,
			bubbleWidth: Number(cfg.bubbleWidth) || 82,
			renderScale: normalizeRenderScale(cfg.renderScale, 1),
			l2dFps: normalizeFps(cfg.l2dFps),
			ttsEnabled: !!cfg.ttsEnabled,
			petTouchEnabled: cfg.petTouchEnabled !== false,
			petTouchEffects: cfg.petTouchEffects !== false,
			petTouchSound: cfg.petTouchSound !== false,
			petTouchSpeech: cfg.petTouchSpeech !== false,
			lipSyncEnabled: !!cfg.lipSyncEnabled,
			bgmEnabled: !!cfg.bgmEnabled,
			bgmTrack: cfg.bgmTrack || "random",
			ttsProvider: cfg.ttsProvider === "cosyvoice" ? "cosyvoice" : "fish",
			ttsApiKey: cfg.ttsApiKey,
			ttsBaseUrl: cfg.ttsBaseUrl,
			ttsReferenceId: cfg.ttsReferenceId,
			ttsModel: cfg.ttsModel,
			ttsFormat: cfg.ttsFormat,
			ttsChunkLength: Number(cfg.ttsChunkLength) || 120,
			ttsLatency: cfg.ttsLatency,
			cosyApiKey: cfg.cosyApiKey,
			cosyBaseUrl: cfg.cosyBaseUrl,
			cosyModel: cfg.cosyModel,
			cosyVoice: cfg.cosyVoice,
			cosyRate: Number(cfg.cosyRate) || 1,
			ttsVolume: Number.isFinite(Number(cfg.ttsVolume)) ? Math.min(1, Math.max(0, Number(cfg.ttsVolume))) : 1,
			bgmVolume: Number.isFinite(Number(cfg.bgmVolume)) ? Math.min(1, Math.max(0, Number(cfg.bgmVolume))) : 0.35,
			sfxVolume: Number.isFinite(Number(cfg.sfxVolume)) ? Math.min(1, Math.max(0, Number(cfg.sfxVolume))) : 0.5,
			dataseaBg: cfg.backgroundMode !== "off", // 旧版读取时保留开关语义
			backgroundMode: cfg.backgroundMode,
			deepseaQuality: cfg.deepseaQuality,
			// 界面字体（2026-10-15）: 必须进这份"逐字段"的落盘清单，否则重启就回系统字体
			uiFont: normalizeUiFont(cfg.uiFont),
			timeAware: cfg.timeAware !== false,
			ambientEnabled: !!cfg.ambientEnabled,
			quietMode: cfg.quietMode,
			quietOn: !!cfg.quietOn,
			cosyCloneVoices: normalizeCloneVoices(cfg.cosyCloneVoices),
			trimHistory: !!cfg.trimHistory,
			memoryLlmExtract: !!cfg.memoryLlmExtract,
			memoryRealtimeExtract: !!cfg.memoryRealtimeExtract,
			memoryAutoTuneExamples: !!cfg.memoryAutoTuneExamples,
			memoryDiagnostics: !!cfg.memoryDiagnostics,
			smartRecall: !!cfg.smartRecall,
			emotionLlm: !!cfg.emotionLlm,
			deepseekThinking: !!cfg.deepseekThinking,
			/** 迁移标记: 一旦写过盘, 说明上面对 `deepseekThinking` 的读取已经是"用户真选的值" */
			thinkDefaultV2: true,
			lookFlipX: !!cfg.lookFlipX,
			lookFlipY: !!cfg.lookFlipY,
			lookSens: Number(cfg.lookSens) || 0.2,
			floatEnabled: !!cfg.floatEnabled,
			floatBubbleW: Number(cfg.floatBubbleW) || 82,
			floatRenderScale: normalizeRenderScale(cfg.floatRenderScale, options.nativeDpr()),
			// 在线人数开关（2026-10-21）: 必须进这份"逐字段"清单，否则关掉后重启又变回开
			presenceEnabled: cfg.presenceEnabled !== false,
		})
		if (raw !== "ok") console.error("[settings] 写盘失败:", raw)
		return raw
	}

	return {cfg, hydrateSettings, persistSettings}
}
