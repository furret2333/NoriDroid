import {computed, ref} from "vue"
import {loadCustomPersona, pickPersonaFile, saveCustomPersona, downloadOfficialPersona} from "../services/chat"

interface PersonaSettingsOptions {
	notify: (message: string, duration?: number) => void
	openGate: (onPass: () => void) => void
}

export const usePersonaSettings = (options: PersonaSettingsOptions) => {
	const personaName = ref("")
	const personaCustom = ref(false)
	const personaChars = ref(0)
	const personaMsg = ref("")
	const personaMsgOk = ref(false)
	/* 官方人设下载（2026-10-14 用户要求）: 与「下载模型」同一道答题门，答对才真的去下拉 .md。
	 *  `personaOfficial` 只用来把状态行写成「当前：官方人设」—— 与文件名一样只在内存里，
	 *  重启后回落显示成「自定义 · N 字」（内容本身是落盘的，不影响功能）。 */
	const personaOfficial = ref(false)
	const personaDlMsg = ref("")
	const personaDlOk = ref(false)
	const personaDlBusy = ref(false)

	/** 状态行文案（2026-10-01 起**没有内置人设**）: 「未设置人设…」/「当前：自定义（文件名）· N 字」/
	 *  「当前：官方人设 · N 字」（最后一条是 2026-10-14 加的下载入口带来的） */
	const personaStateText = computed(() =>
		personaCustom.value
			? `当前：${personaOfficial.value ? "官方人设" : "自定义"}${personaName.value ? `（${personaName.value}）` : ""} · ${personaChars.value} 字`
			: `未设置人设 —— 点「导入文件」选一份人设文案，或点「下载官方人设」（不导入的话 Nori 没有人格设定）`
	)

	/** 重读自定义人设, 刷新那行状态 (启动时与导入/下载/恢复后各调一次) */
	const refreshPersonaState = () => {
		const t = loadCustomPersona()
		personaCustom.value = !!t
		personaChars.value = t ? t.length : 0
		if (!t) {
			personaName.value = ""
			personaOfficial.value = false
		}
	}

	/** 导入文案人设: 系统文件选择器 → 存 `persona.md` → 之后每轮对话都用它 */
	const doImportPersona = async () => {
		personaMsg.value = ""
		const r = await pickPersonaFile()
		if (!r.ok) {
			personaMsgOk.value = false
			// 用户在系统选择器里点了返回 —— 这不算错误, 不弹气泡, 只说一句
			personaMsg.value = r.message ?? "未选择文件"
			return
		}
		const text = (r.text ?? "").trim()
		if (!text) {
			personaMsgOk.value = false
			personaMsg.value = "这个文件是空的, 没有可当人设的内容"
			return
		}
		saveCustomPersona(text)
		personaName.value = r.name ?? ""
		personaOfficial.value = false
		refreshPersonaState()
		personaMsgOk.value = true
		personaMsg.value = `已导入 ${r.name ?? "人设文件"}（${personaChars.value} 字）`
		options.notify("人设已更新，下次说话就照这个来")
	}

	/** 清除自定义人设: 把 `persona.md` 内容清空（文件留着, 不删；没有内置人设可回落） */
	const doResetPersona = () => {
		saveCustomPersona("")
		personaOfficial.value = false
		personaDlMsg.value = ""
		refreshPersonaState()
		personaMsgOk.value = true
		personaMsg.value = ""
		options.notify("已清除自定义人设")
	}

	/* ---------------- 官方人设下载（2026-10-14 用户要求）----------------
	 * 入口在设置 → 连接与人设 →「官方人设」行（就排在「人设文案（提示词）」正下方）。
	 * 和「下载模型」完全同一套：点按钮 → 开「人设授权验证」那道题 → **答对才**去下载（答错/取消都不下）。
	 * 下载源在 services/chat（PERSONA_DOWNLOAD_URL, PinMe/IPFS 静态托管，与模型/音效同一套）。
	 * 下完直接 saveCustomPersona（= `persona.md`）→ 下一轮对话就按这份人设走。 */
	const openPersonaGate = (): void => {
		if (personaDlBusy.value) return
		personaDlMsg.value = ""
		options.openGate( () => { void doDownloadOfficialPersona() })
	}

	/** 答题门放行之后真正去下载；文本校验在 services/chat 里做（空/超大/HTML/不是 Nori 的都不写盘） */
	const doDownloadOfficialPersona = async (): Promise<void> => {
		personaDlBusy.value = true
		personaDlOk.value = false
		personaDlMsg.value = "下载中…"
		try {
			const r = await downloadOfficialPersona()
			if (!r.ok || !r.text) {
				personaDlOk.value = false
				personaDlMsg.value = r.message ?? "下载失败"
				return
			}
			saveCustomPersona(r.text)
			personaOfficial.value = true
			personaName.value = ""
			refreshPersonaState()
			personaDlOk.value = true
			personaDlMsg.value = `已下载并启用官方人设（${Math.round((r.bytes ?? 0) / 1024)}KB · ${personaChars.value} 字）`
			options.notify("人设装好啦，从现在开始就是Nori了")
		} catch (e) {
			personaDlOk.value = false
			personaDlMsg.value = `下载失败: ${(e as Error)?.message ?? String(e)}`
		} finally {
			personaDlBusy.value = false
		}
	}
	return {personaName, personaCustom, personaChars, personaMsg, personaMsgOk, personaOfficial, personaDlMsg, personaDlOk, personaDlBusy, personaStateText, refreshPersonaState, doImportPersona, doResetPersona, openPersonaGate}
}
