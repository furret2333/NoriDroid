import type {ChatMsg, ChatRequestOptions} from "../chat"
import {commitRecall, goalCarePrompt, historicalFactKey, materializeRecall, recentTopicsBlock,
	selectRecall, selectRecallSmart, summaryBlock, type MemoryRecall} from "./index"

/** 主界面与悬浮窗共用：迟到候选只读，结束竞速时撤销定时器及辅助调用。 */
export const selectRecallWithinBudget = async (
	query: string,
	llmCall: ((prompt: string, signal: AbortSignal) => Promise<string>) | null,
	budgetMs: number,
	signal?: AbortSignal,
): Promise<MemoryRecall> => {
	if (!llmCall || signal?.aborted) return selectRecall(query)
	const abort = new AbortController()
	const onAbort = (): void => abort.abort()
	signal?.addEventListener("abort", onAbort, {once: true})
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const smart = selectRecallSmart(query, prompt => llmCall(prompt, abort.signal)).catch(() => selectRecall(query))
		const fast = new Promise<MemoryRecall>(resolve => {
			timer = setTimeout(() => resolve(selectRecall(query)), budgetMs)
		})
		return await Promise.race([smart, fast])
	} finally {
		if (timer) clearTimeout(timer)
		abort.abort()
		signal?.removeEventListener("abort", onAbort)
	}
}

/** 队列真正发送时刷新记忆及摘要，预算淘汰掉的块不计数。 */
export const memoryChatOptions = (selection: MemoryRecall, payload: ChatMsg[], timeAware: boolean): ChatRequestOptions => {
	const requestId = `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`
	let sent = {text: "", ids: [] as string[]}
	return {
		timeAware,
		inputCharBudget: 16000,
		prepareMessages: (): ChatMsg[] => {
			sent = materializeRecall(selection)
			const extras = [summaryBlock(timeAware, !!historicalFactKey(selection.query)), sent.text,
				recentTopicsBlock(), goalCarePrompt()].filter(Boolean).map(content => ({role: "system", content} as ChatMsg))
			const first = payload.findIndex(m => m.role !== "system")
			const split = first < 0 ? payload.length : first
			return [...payload.slice(0, split), ...extras, ...payload.slice(split)]
		},
		onDispatched: (actual: ChatMsg[]): void => {
			commitRecall(selection, requestId, actual.some(m => m.role === "system" && m.content === sent.text) ? sent.ids : [])
		},
	}
}
