import type {ChatMsg, ChatRequestOptions} from "../chat"
import {commitRecall, goalCarePrompt, historicalFactKey, materializeRecall, recentTopicsBlock,
	selectRecall, selectRecallSmart, summaryBlock, type MemoryRecall} from "./index"
import {recordRecall, type RecallMetrics} from "./diag"
import type {RecallTurn} from "./query"

/** 主界面与悬浮窗共用：迟到候选只读，结束竞速时撤销定时器及辅助调用。 */
export const selectRecallWithinBudget = async (
	query: string,
	llmCall: ((prompt: string, signal: AbortSignal) => Promise<string>) | null,
	budgetMs: number,
	signal?: AbortSignal,
	recent: readonly RecallTurn[] = [],
): Promise<MemoryRecall> => {
	const start = performance.now()
	let candidateMetrics: Pick<RecallMetrics, "candidates" | "channels" | "contextTurns"> | undefined
	const finish = (selection: MemoryRecall): MemoryRecall => {
		if (selection.metrics) {
			selection = {...selection, metrics: {...selection.metrics, elapsedMs: performance.now() - start}}
			recordRecall(selection.metrics!)
		}
		return selection
	}
	const fallback = (outcome?: RecallMetrics["outcome"]): MemoryRecall => {
		const selection = selectRecall(query, recent)
		return outcome ? {...selection, source: "smart-fallback", note: `AI 召回降级：${outcome}`,
			metrics: {...selection.metrics!, ...candidateMetrics, outcome}} : selection
	}
	if (signal?.aborted) return finish(fallback("cancelled"))
	if (!llmCall) return finish(fallback())
	const abort = new AbortController()
	let cancel: (selection: MemoryRecall) => void = () => {}
	const onAbort = (): void => { cancel(fallback("cancelled")); abort.abort() }
	signal?.addEventListener("abort", onAbort, {once: true})
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const fast = new Promise<MemoryRecall>(resolve => {
			cancel = resolve
			timer = setTimeout(() => resolve(fallback("budget-timeout")), Math.max(0, budgetMs))
		})
		const smart = selectRecallSmart(query, prompt => llmCall(prompt, abort.signal), 6, recent,
			data => {candidateMetrics = data}).catch(() => fallback("network-error"))
		return finish(await Promise.race([smart, fast]))
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
