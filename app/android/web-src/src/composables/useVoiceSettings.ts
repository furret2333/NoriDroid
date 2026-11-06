import {computed, ref, type UnwrapNestedRefs} from "vue"
import {checkFishBalance, checkDeepSeekBalance, checkCosyBalance, fetchVoices, type VoiceInfo} from "../services/chat"
import {test as testTTS, cosyVoiceModelOf} from "../services/tts"
import {COSY_NO_VOICE_ERROR, cosyVoiceModelError, pickVoiceFile, createCloneVoice, queryCloneVoice} from "../services/tts/cosyvoice"
import type {AppSettings} from "./useAppSettings"

export interface VoiceSettingsOptions {
	cfg: AppSettings
	persistSettings: () => string
}

export const useVoiceSettings = ({cfg, persistSettings}: VoiceSettingsOptions) => {
	const ttsTesting = ref(false)
	const ttsMsg = ref("")
	const ttsMsgOk = ref(false)

	/** 无音色或音色与模型不匹配时提前提示；与合成侧使用相同的判定和文案。 */
	const cosyVoiceHint = computed(() => {
		const v = (cfg.cosyVoice ?? "").trim()
		if (!v) return COSY_NO_VOICE_ERROR
		const vm = cosyVoiceModelOf(cfg)
		return vm && vm !== cfg.cosyModel ? cosyVoiceModelError(v, vm, cfg.cosyModel) : ""
	})

	const clonePrefix = ref("myvoice")
	const cloneFileName = ref("")
	const cloneFileSize = ref(0)
	const clonePicking = ref(false)
	const cloneCreating = ref(false)
	const cloneMsg = ref("")
	const cloneMsgOk = ref(false)
	const cloneStatusText = ref("")
	const cloneStatusOk = ref(false)
	let cloneVoiceId = ""

	const fmtSize = (n: number): string =>
		n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`

	const doPickVoice = async () => {
		clonePicking.value = true
		cloneMsg.value = ""
		try {
			const r = await pickVoiceFile()
			if (r.ok) {
				cloneFileName.value = r.name ?? "audio"
				cloneFileSize.value = r.size ?? 0
				cloneMsg.value = ""
			} else {
				cloneMsg.value = r.message ?? "选择失败"
				cloneMsgOk.value = false
			}
		} finally {
			clonePicking.value = false
		}
	}

	/** 记录/更新某个克隆音色的所属模型 (同 id 覆盖, 新 id 追加)。
	 *  必须持久化这个绑定关系: 官方明确音色不能跨模型混用, 不记下来用户一换模型就会静默用错音色。 */
	const rememberCloneVoice = (id: string, model: string): void => {
		const vid = (id ?? "").trim()
		if (!vid) return
		const m = (model ?? "").trim()
		const list = cfg.cosyCloneVoices ?? []
		const i = list.findIndex((x) => x?.id === vid)
		if (i < 0) cfg.cosyCloneVoices = [...list, {id: vid, model: m}]
		else if (m && list[i].model !== m) cfg.cosyCloneVoices = list.map((x, k) => (k === i ? {...x, model: m} : x))
	}

	const doCreateClone = async () => {
		if (!cloneFileName.value) return
		cloneCreating.value = true
		cloneMsg.value = ""
		cloneStatusText.value = ""
		try {
			const key = cfg.cosyApiKey?.trim() || ""
			if (!key) {
				cloneMsg.value = "请先填写千问 API Key"
				cloneMsgOk.value = false
				return
			}
			// 锁定克隆用的模型: 后面轮询最长 2 分钟, 期间用户可能改「模型」下拉,
			// 记错模型会让"绑定关系"直接失真
			const cloneModel = cfg.cosyModel || "cosyvoice-v3.5-flash"
			const r = await createCloneVoice(key, cloneModel, clonePrefix.value.trim() || "myvoice")
			if (!r.ok) {
				cloneMsg.value = r.message ?? "创建失败"
				cloneMsgOk.value = false
				return
			}
			cloneVoiceId = r.voice_id ?? ""
			cloneMsg.value = `创建成功，等待审核…`
			cloneMsgOk.value = true
			// 轮询状态直到 OK / UNDEPLOYED (最多 ~2 分钟)
			for (let i = 0; i < 24; i++) {
				await new Promise((res) => setTimeout(res, 5000))
				const q = await queryCloneVoice(key, cloneVoiceId)
				if (!q.ok) {
					cloneStatusText.value = `查询失败: ${q.message ?? ""}`
					cloneStatusOk.value = false
					break
				}
				const st = q.status ?? ""
				if (st === "OK") {
					cloneStatusText.value = `审核通过 ✅ 已加入我的音色`
					cloneStatusOk.value = true
					cfg.cosyVoice = cloneVoiceId
					// 记下"这个音色是为哪个模型克隆的": 接口返回的 target_model 最权威,
					// 缺失时退回克隆时锁定的 cloneModel (不是当前下拉值)
					rememberCloneVoice(cloneVoiceId, q.target_model || cloneModel)
					persistSettings()
					break
				}
				if (st === "UNDEPLOYED") {
					cloneStatusText.value = `审核未通过 (UNDEPLOYED)，请更换音频重试`
					cloneStatusOk.value = false
					break
				}
				cloneStatusText.value = `审核中… (${Math.min(i + 1, 24)}/24)`
				cloneStatusOk.value = true
			}
		} finally {
			cloneCreating.value = false
		}
	}

	const doTestTTS = async () => {
		ttsTesting.value = true
		ttsMsg.value = ""
		try {
			const r = await testTTS(cfg)
			if (r.ok) {
				ttsMsg.value = "连接成功，正在试听…"
				ttsMsgOk.value = true
			} else {
				ttsMsg.value = r.error ?? "测试失败"
				ttsMsgOk.value = false
			}
		} finally {
			ttsTesting.value = false
		}
	}

	/* ---------------- 余额查询 ---------------- */
	const balFish = ref("")
	const balDs = ref("")
	const balCosy = ref("")
	const balFishLoading = ref(false)
	const balDsLoading = ref(false)
	const balCosyLoading = ref(false)
	const balMsg = ref("")
	const balMsgOk = ref(false)

	const queryFishBalance = async () => {
		if (!(cfg.ttsApiKey ?? "").trim()) {
			balMsg.value = "请先填写 Fish Audio API Key"
			balMsgOk.value = false
			return
		}
		balFishLoading.value = true
		balMsg.value = ""
		try {
			const r = await checkFishBalance(cfg.ttsBaseUrl, cfg.ttsApiKey)
			if (r.ok) {
				balFish.value = `余额 ${r.credit ?? "0"}${r.hasFreeCredit ? "（含免费额度）" : ""}`
				balMsg.value = "Fish Audio 余额查询成功"
				balMsgOk.value = true
			} else {
				balFish.value = ""
				balMsg.value = `Fish Audio: ${r.message ?? "查询失败"}`
				balMsgOk.value = false
			}
		} finally {
			balFishLoading.value = false
		}
	}

	const queryDeepSeekBalance = async () => {
		if (!(cfg.apiKey ?? "").trim()) {
			balMsg.value = "请先在聊天设置里配置 DeepSeek API Key"
			balMsgOk.value = false
			return
		}
		balDsLoading.value = true
		balMsg.value = ""
		try {
			const r = await checkDeepSeekBalance(cfg.baseUrl, cfg.apiKey)
			if (r.ok) {
				balDs.value = r.balance ?? "无余额信息"
				balMsg.value = r.isAvailable === false ? "DeepSeek 账户当前不可用" : "DeepSeek 余额查询成功"
				balMsgOk.value = r.isAvailable !== false
			} else {
				balDs.value = ""
				balMsg.value = `DeepSeek: ${r.message ?? "查询失败"}`
				balMsgOk.value = false
			}
		} finally {
			balDsLoading.value = false
		}
	}

	const queryCosyBalance = async () => {
		if (!(cfg.cosyApiKey ?? "").trim()) {
			balMsg.value = "请先填写千问 API Key"
			balMsgOk.value = false
			return
		}
		balCosyLoading.value = true
		balMsg.value = ""
		try {
			const r = await checkCosyBalance(cfg.cosyBaseUrl, cfg.cosyApiKey)
			if (r.ok) {
				balCosy.value = r.balance ?? "无余额信息"
				balMsg.value = "千问余额查询成功"
				balMsgOk.value = true
			} else {
				balCosy.value = ""
				balMsg.value = `千问: ${r.message ?? "查询失败"}`
				balMsgOk.value = false
			}
		} finally {
			balCosyLoading.value = false
		}
	}

	/* ---------------- 音色列表 ---------------- */
	const voiceOptions = ref<VoiceInfo[]>([])
	const voicesLoading = ref(false)
	const voicesMsg = ref("")
	const voicesMsgOk = ref(false)

	const loadVoices = async () => {
		if (!(cfg.ttsApiKey ?? "").trim()) {
			voicesMsg.value = "请先填写 Fish Audio API Key"
			voicesMsgOk.value = false
			return
		}
		voicesLoading.value = true
		voicesMsg.value = ""
		try {
			const r = await fetchVoices(cfg.ttsBaseUrl, cfg.ttsApiKey)
			if (r.ok) {
				voiceOptions.value = r.voices ?? []
				voicesMsg.value = voiceOptions.value.length
					? `找到 ${voiceOptions.value.length} 个可用音色（只显示已训练的 TTS 音色）`
					: "没有找到音色。可在 fish.audio 克隆音色, 或手动输入 Reference ID"
				voicesMsgOk.value = true
			} else {
				voicesMsg.value = r.message ?? "拉取音色列表失败"
				voicesMsgOk.value = false
			}
		} finally {
			voicesLoading.value = false
		}
	}

	return {
		ttsTesting, ttsMsg, ttsMsgOk, cosyVoiceHint,
		clonePrefix, cloneFileName, cloneFileSize, clonePicking, cloneCreating,
		cloneMsg, cloneMsgOk, cloneStatusText, cloneStatusOk,
		fmtSize, doPickVoice, rememberCloneVoice, doCreateClone, doTestTTS,
		balFish, balDs, balCosy, balFishLoading, balDsLoading, balCosyLoading,
		balMsg, balMsgOk, queryFishBalance, queryDeepSeekBalance, queryCosyBalance,
		voiceOptions, voicesLoading, voicesMsg, voicesMsgOk, loadVoices
	}
}

export type VoiceSettingsModel = UnwrapNestedRefs<ReturnType<typeof useVoiceSettings>>
