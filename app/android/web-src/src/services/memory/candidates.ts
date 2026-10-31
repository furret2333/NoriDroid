import {kwOverlapCount, overlapCount, recallTokens, type MemoryItem} from "./core"

export type CandidateChannels = {lexical: number; alias: number; diverse: number; recent: number; important: number}

/** Twenty model candidates, with reserved lanes. Exploration is never direct injection. */
export const smartCandidates = (all: MemoryItem[], query: string, lexical: MemoryItem[]): {items: MemoryItem[]; channels: CandidateChannels} => {
	const items: MemoryItem[] = [], seen = new Set<string>()
	const channels: CandidateChannels = {lexical: 0, alias: 0, diverse: 0, recent: 0, important: 0}
	const add = (list: MemoryItem[], lane: keyof CandidateChannels, quota: number): void => {
		for (const m of list) {
			if (items.length >= 20 || quota <= 0) break
			if (seen.has(m.id)) continue
			seen.add(m.id); items.push(m); channels[lane]++; quota--
		}
	}
	const tokens = recallTokens(query)
	const aliases = all.map(item => ({item, n: kwOverlapCount(tokens, item)}))
		.filter(x => x.n > 0).sort((a, b) => b.n - a.n)
	// Raw lexical/alias overlap ignores decay here: old facts still deserve model review.
	const body = all.map(item => ({item, n: overlapCount(tokens, item)}))
		.filter(x => x.n > 0).sort((a, b) => b.n - a.n)
	add([...lexical, ...body.map(x => x.item)], "lexical", 8)
	add(aliases.map(x => x.item), "alias", 4)
	const groups = new Map<string, MemoryItem[]>()
	for (const m of all) {const group = groups.get(m.type) ?? []; group.push(m); groups.set(m.type, group)}
	const diverse = [...groups.values()].flatMap(group => {
		const oldest = [...group].sort((a, b) => a.createdAt - b.createdAt)
		return [oldest[0], oldest[oldest.length - 1]]
	})
	add(diverse, "diverse", 4)
	add([...all].sort((a, b) => b.createdAt - a.createdAt), "recent", 2)
	add([...all].sort((a, b) => b.importance - a.importance), "important", 2)
	// Small libraries and duplicate lanes may leave room; keep the same hard cap.
	add([...body.map(x => x.item), ...aliases.map(x => x.item), ...diverse, ...all], "diverse", 20 - items.length)
	return {items, channels}
}
