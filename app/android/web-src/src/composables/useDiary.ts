import {computed, onBeforeUnmount, ref} from "vue"
import {sendChat} from "../services/chat"
import {createDiaryDraft, diaryDay, diaryHealth, diarySourceInfo, diarySuppressed, listDiary, pendingDiaryDates, pendingDiaryDraft, saveDiaryDraft, type DiaryDraft, type DiaryEntry, type DiaryResult} from "../services/nori-diary"

export interface DiaryConfig {baseUrl: string; apiKey: string; model: string}
// Keep an unsaved preview across closing/reopening the panel in this app session.
const retainedDraft = ref<DiaryDraft | null>(null)
const retainedSaveFailed = ref(false)
export const useDiary = (config: () => DiaryConfig, conversationBusy: () => boolean) => {
	const entries = ref<DiaryEntry[]>([])
	const today = ref(diaryDay())
	const selected = ref(today.value)
	const health = ref(diaryHealth())
	const pendingDates = ref<string[]>([])
	const source = ref(diarySourceInfo(selected.value))
	const suppressed = ref(false)
	const busy = ref(false)
	const draft = retainedDraft
	const message = ref("")
	const error = ref(false)
	const draftConflict = ref(false)
	const saveFailed = retainedSaveFailed
	let controller: AbortController | null = null
	let lastAutomaticMessage = ""
	const entry = computed(() => entries.value.find(e => e.date === selected.value))
	const hasNewMessages = computed(() => !!entry.value?.sourceFingerprint && source.value.fingerprint !== entry.value.sourceFingerprint)
	const showResult = (r: DiaryResult) => { message.value = r.message; error.value = r.code !== "ok" && r.code !== "cancelled" && r.code !== "no_source" }
	const refresh = () => {
		today.value = diaryDay()
		entries.value = listDiary()
		health.value = diaryHealth()
		const pending = pendingDiaryDraft()
		if (pending.draft && !draft.value) { draft.value = pending.draft; saveFailed.value = pending.saveFailed }
		if (pending.failure && draft.value === pending.draft) {
			draftConflict.value = pending.failure.code === "conflict"
			if (!message.value) showResult(pending.failure)
		}
		if (health.value.lastMessage && health.value.lastMessage !== lastAutomaticMessage) {
			lastAutomaticMessage = health.value.lastMessage
			if (!message.value) { message.value = lastAutomaticMessage; error.value = /失败|无法|不可|异常/.test(lastAutomaticMessage) }
		}
		pendingDates.value = pendingDiaryDates()
		source.value = diarySourceInfo(selected.value)
		suppressed.value = diarySuppressed(selected.value)
	}
	const select = (date: string) => { selected.value = date; refresh() }
	const cancel = () => { controller?.abort(); message.value = "已停止写日记，原文已保留" }
	const saveDraft = () => {
		if (!draft.value) return
		const r = saveDiaryDraft(draft.value)
		showResult(r)
		draftConflict.value = r.code === "conflict"
		saveFailed.value = r.code !== "ok"
		if (r.code === "ok") {
			const date = draft.value.entry.date
			draft.value = null
			select(date)
			window.dispatchEvent(new Event("nori-diary-updated"))
		} else refresh()
	}
	const generate = async (date = selected.value) => {
		if (busy.value || draft.value) return
		if (conversationBusy()) { message.value = "先聊完这一句，再来写日记吧"; return }
		const cfg = config()
		if (!cfg.apiKey.trim() || !cfg.model.trim()) { showResult({code: "config_missing", message: "请先在设置里配置 API Key 和模型"}); return }
		busy.value = true
		error.value = false
		saveFailed.value = false
		draftConflict.value = false
		message.value = `正在写 ${date} 的日记…`
		controller = new AbortController()
		const signal = controller.signal
		try {
			const r = await createDiaryDraft(date, async (system, material) => {
				const response = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
					{role: "system", content: system, ts: Date.now()},
					{role: "user", content: material ?? "", ts: Date.now()},
				], false, {signal})
				if (!response.ok) throw new Error(response.message || "模型请求失败，请检查网络后重试")
				return response.content ?? ""
			}, signal)
			if (signal.aborted) return
			showResult(r)
			if (r.draft) {
				draft.value = r.draft
				// Existing prose always gets an explicit preview before replacement.
				if (!entries.value.some(e => e.date === date)) saveDraft()
			}
		} finally { busy.value = false; controller = null; refresh() }
	}
	onBeforeUnmount(cancel)
	refresh()
	return {entries, today, selected, health, pendingDates, source, suppressed, busy, draft, message, error, saveFailed, draftConflict, entry, hasNewMessages, refresh, select, cancel, saveDraft, generate}
}
