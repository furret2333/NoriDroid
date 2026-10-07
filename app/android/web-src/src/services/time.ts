/** 使用设备本地时区，供对话和历史时间标记共用。 */
export const formatLocalTime = (date: Date): string => {
	const p = (n: number): string => String(n).padStart(2, "0")
	const offset = -date.getTimezoneOffset()
	const zone = `UTC${offset >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(offset) / 60))}:${p(Math.abs(offset) % 60)}`
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}（${zone}）`
}

export const isValidTimestamp = (ts: unknown): ts is number =>
	typeof ts === "number" && Number.isFinite(ts) && ts > 0 && Number.isFinite(new Date(ts).getTime())

export interface MessageTimeRange {fromTs: number; toTs: number}

/** 缺少原始时间时不猜测，也不拿摘要创建时间充当对话时间。 */
export const messageTimeRange = (messages: readonly {role?: string; ts?: number}[]): MessageTimeRange | undefined => {
	const source = messages.filter(m => m.role !== "system")
	if (!source.length || source.some(m => !isValidTimestamp(m.ts))) return undefined
	const times = source.map(m => m.ts as number)
	return {fromTs: Math.min(...times), toTs: Math.max(...times)}
}
