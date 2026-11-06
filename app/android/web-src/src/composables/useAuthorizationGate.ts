import {ref, type Ref} from "vue"
import type {AppSettings} from "./useAppSettings"
import {checkCloneAnswer} from "../services/tts/clone-gate"
import {queryCloneVoice, createPresetCloneVoice} from "../services/tts/cosyvoice"

export type GateKind = "clone" | "model" | "persona"

interface AuthorizationGateOptions {
 cfg: AppSettings
 clonePrefix: Ref<string>
 rememberCloneVoice: (id: string, model: string) => void
 persistSettings: () => string
 triggerBubble: (message: string, ms?: number) => void
}

/** Three entry points share the same challenge; network work starts only after it passes. */
export const useAuthorizationGate = ({cfg, clonePrefix, rememberCloneVoice, persistSettings, triggerBubble}: AuthorizationGateOptions) => {
	const gateOn = ref(false)
	const gateKind = ref<GateKind>("clone")
	const gateInput = ref("")
	const gateMsg = ref("")
	const gateOk = ref(false)
	const gateBusy = ref(false)
	/** 答对之后的"放行动作"（下载模型 / 下载官方人设用得上：关掉弹窗再去干那件事）。
	 *  克隆的动作就在门里跑（要把"审核中…"一直显示在弹窗里），所以它是 null。 */
	let gatePass: (() => void) | null = null

	/** 开门：清掉上一次的输入/提示。onPass 只在**答对之后**才被调用（答错/取消都碰不到它） */
	const openGate = (kind: GateKind, onPass?: () => void): void => {
		gateKind.value = kind
		gatePass = onPass ?? null
		gateInput.value = ""
		gateMsg.value = ""
		gateOk.value = false
		gateOn.value = true
	}
	/** 取消 / 点遮罩 / 点✕：关门即放弃（gatePass 一起丢掉 ⇒ 绝不会偷偷开始下载）；忙的时候不许关 */
	const closeGate = (): void => {
		if (gateBusy.value) return
		gateOn.value = false
		gatePass = null
	}

	/** 一键克隆的入口按钮（TTS 页）：开同一道门，答对后走下面 clone 那套 */
	const openCloneGate = (): void => openGate("clone")

	/** 一键克隆：判卷已由 doGate 做掉 → 建音色 → 轮询审核（与手动流程一致）→ 选中并持久化 */
	const doCloneGate = async (): Promise<void> => {
		const key = cfg.cosyApiKey?.trim() || ""
		if (!key) {
			gateOk.value = false
			gateMsg.value = "请先在「语音」里填写千问 API Key"
			return
		}
		gateBusy.value = true
		gateMsg.value = ""
		// 锁定模型: 后面轮询最长 2 分钟, 期间用户可能改下拉, 记错模型会让"音色↔模型"绑定失真
		const gateModel = cfg.cosyModel || "cosyvoice-v3.5-flash"
		try {
			const r = await createPresetCloneVoice(key, gateModel, clonePrefix.value.trim() || "nori")
			if (!r.ok) {
				gateOk.value = false
				gateMsg.value = r.message ?? "创建失败"
				return
			}
			const vid = r.voice_id ?? ""
			gateOk.value = true
			gateMsg.value = "已创建，等待审核…"
			for (let i = 0; i < 24; i++) {
				await new Promise((res) => setTimeout(res, 5000))
				const q = await queryCloneVoice(key, vid)
				if (!q.ok) { gateOk.value = false; gateMsg.value = `查询失败: ${q.message ?? ""}`; return }
				const st = q.status ?? ""
				if (st === "OK") {
					cfg.cosyVoice = vid
					rememberCloneVoice(vid, q.target_model || gateModel)
					persistSettings()
					gateOk.value = true
					gateMsg.value = "审核通过 ✅ 已设为当前音色"
					triggerBubble("音色准备好了，说句话试试？")
					setTimeout(() => { gateOn.value = false; gateBusy.value = false }, 1200)
					return
				}
				if (st === "UNDEPLOYED") {
					gateOk.value = false
					gateMsg.value = "审核未通过（UNDEPLOYED），换一段音频再试吧"
					return
				}
				gateMsg.value = `审核中… (${Math.min(i + 1, 24)}/24)`
			}
			gateOk.value = false
			gateMsg.value = "等太久了，稍后可在「音色」里看看有没有出来"
		} finally {
			gateBusy.value = false
		}
	}

	/** 判卷（两处动作共用）：答错只提示、**不执行任何动作**；答对才分岔到具体动作 */
	const doGate = async (): Promise<void> => {
		if (gateBusy.value) return
		if (!checkCloneAnswer(gateInput.value)) {
			gateOk.value = false
			gateMsg.value = "答案不对，再想想～"
			return
		}
		if (gateKind.value === "clone") { await doCloneGate(); return }
		// 下载模型 / 下载官方人设：答对即放行 —— 关掉弹窗，剩下的事由 gatePass 去干
		// （模型是回到原来的"切模型→下载"流程，进度在 topbar；人设是去拉 .md 再落盘）
		const pass = gatePass
		gateOn.value = false
		gatePass = null
		gateOk.value = false
		gateMsg.value = ""
		pass?.()
	}

	return {gateOn, gateKind, gateInput, gateMsg, gateOk, gateBusy, openGate, closeGate, openCloneGate, doGate}
}
