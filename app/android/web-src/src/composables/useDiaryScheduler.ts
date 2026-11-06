import {watch, type Ref} from "vue"
import {sendChat} from "../services/chat"
import {ensureDiary} from "../services/nori-diary"
import type {AppSettings} from "./useAppSettings"

export interface DiarySchedulerOptions {
	settings: () => Pick<AppSettings, "baseUrl" | "apiKey" | "model">
	chatStreaming: Readonly<Ref<boolean>>
	touchStreaming: Readonly<Ref<boolean>>
}

/** Idle diary scheduling; watch registration and lifecycle calls remain explicit in App. */
export const useDiaryScheduler = ({settings, chatStreaming, touchStreaming}: DiarySchedulerOptions) => {
	let diaryIdleTimer: ReturnType<typeof setTimeout> | null = null
	let diaryAutoAbort: AbortController | null = null
	const stopAutoDiary = () => {
		if (diaryIdleTimer) clearTimeout(diaryIdleTimer)
		diaryIdleTimer = null
		diaryAutoAbort?.abort()
	}
	const scheduleDiary = () => {
		if (diaryIdleTimer) clearTimeout(diaryIdleTimer)
		diaryIdleTimer = setTimeout(async () => {
			diaryIdleTimer = null
			if (document.hidden || window.__noriAppPaused || chatStreaming.value || touchStreaming.value || diaryAutoAbort || !settings().apiKey.trim() || !settings().model.trim()) return
			const ac = new AbortController()
			diaryAutoAbort = ac
			try {
				await ensureDiary(async (system, material) => {
					const r = await sendChat(settings().baseUrl, settings().apiKey, settings().model, [
						{role: "system", content: system, ts: Date.now()},
						{role: "user", content: material ?? "", ts: Date.now()},
					], false, {signal: ac.signal})
					if (!r.ok) throw new Error(r.message || "日记生成失败，请稍后重试")
					return r.content ?? ""
				}, ac.signal)
				window.dispatchEvent(new Event("nori-diary-updated"))
			} finally { if (diaryAutoAbort === ac) diaryAutoAbort = null }
		}, 1800)
	}
	const bindDiaryWatcher = () => watch([chatStreaming, touchStreaming], ([chat, touch]) => { if (chat || touch) stopAutoDiary() })

	return {stopAutoDiary, scheduleDiary, bindDiaryWatcher}
}
