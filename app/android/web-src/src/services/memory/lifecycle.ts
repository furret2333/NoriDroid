import {isActiveMemory, memoryContentKey, normalizeForCompare, type MemoryContentAction, type MemoryItem, type MemoryStoreData, type MemorySummary} from "./core"

const sentences = (text: string): string[] => text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? []
const normalizedValue = (text: string): string => normalizeForCompare(text).replace(/猫咪/g, "猫").replace(/狗狗/g, "狗")
const chineseNumber = (s: string): number => {
	if (/^\d+$/.test(s)) return Number(s)
	const digits = "零一二三四五六七八九"
	if (s === "两") return 2
	if (s.includes("十")) {
		const [a, b] = s.split("十")
		return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0)
	}
	return digits.indexOf(s)
}

/** 有限的事实等价规则：保留主体和正反方向；指纹不是完整语义理解，也不是加密。 */
export const summaryFactKeys = (text: string): string[] => {
	const out = new Set<string>()
	const add = (family: string, value: string): void => {
		const norm = normalizedValue(value)
		if (norm) out.add(memoryContentKey(`${family}:${norm}`))
	}
	for (const sentence of sentences(text)) {
		const clean = sentence.trim().replace(/^〔[^〕]*〕/, "").replace(/^[\s\-*•\d.、]+/, "")
		// 倒装、指代只认明确的用户主体，避免把朋友的偏好套给用户。
		const reverse = clean.match(/^(.+?)是(?:用户|主人|我)(?:最)?(?:喜欢|喜爱|爱)的(?:动物|东西|事物)[。！!]?$/)
		if (reverse) add("self:like:yes", reverse[1])
		const refer = clean.match(/^(?:用户|主人|我)(?:曾)?谈起(.+?)[，,]\s*说它是(?:最)?(?:喜欢|喜爱|爱)的(?:动物|东西|事物)/)
		if (refer) add("self:like:yes", refer[1])
		for (const clause of clean.split(/[，,]/)) {
			let body = clause.trim().replace(/[。！？!?；;]+$/, "")
			const subject = body.match(/^(?:用户|主人|我|自己)/)
			if (subject) body = body.slice(subject[0].length)
			// 所有格的他人、引述、疑问、条件和旧事实回顾不能当作当前自述。
			if (/^(?:的)?(?:朋友|同事|家人|父母|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|孩子|男朋友|女朋友)/.test(body) ||
				/^(?:同事|朋友|他|她|别人)/.test(body) ||
				/如果|假如|可能|据说|听说|以前|曾经|原来|过去|不是|并非|不叫|不住|不在|[？?]|(?:什么|哪里|哪儿|几月|几日)/.test(body)) continue
			body = body.replace(/^(?:的)?(?:目前|现在|一直|平常|平时)?/, "").replace(/^(?:表示|说)(?:自己)?/, "")
			if (!body) continue
			// 明确自述正文提供一般事实的精确护栏，指纹不含原文。
			if (subject || /^(?:喜欢|不喜欢|喜爱|偏爱|住在|名字|生日)/.test(body)) add("statement", body)
			const name = body.match(/^(?:的)?(?:名(?:字)?(?:是|叫)|姓名(?:是|叫)|叫)([\p{L}\p{N}·]{1,24})$/u) ??
				body.match(/^用(.+?)这个(?:称谓|名字|称呼)$/)
			if (name && subject) add("self:name", name[1])
			const home = body.match(/^(?:住在|居住在|定居(?:在)?|居住地是)([\p{L}\p{N}·]{2,30})$/u)
			if (home && subject) add("self:home", home[1])
			const date = body.match(/([\d零一二三四五六七八九十两]+)月([\d零一二三四五六七八九十两]+)[日号]/)
			if (subject && /生日/.test(body) && date) {
				const month = chineseNumber(date[1]), day = chineseNumber(date[2])
				if (month >= 1 && month <= 12 && day >= 1 && day <= 31) add("self:birthday", `${month}月${day}日`)
			}
			const like = body.match(/^(不|并不|不再|没)?(?:最)?(?:喜欢|喜爱|偏爱|钟爱|热爱)(.+)$/)
			if (like) add(`self:like:${like[1] ? "no" : "yes"}`, like[2])
		}
	}
	return [...out]
}

/** 同毫秒删除/恢复也有确定顺序；指纹随公共 JSON 持久化，永久删除不藏原文。 */
export const setContentAction = (store: MemoryStoreData, item: MemoryItem, state: MemoryContentAction["state"]): void => {
	const key = memoryContentKey(item.content)
	const list = store.contentActions ?? []
	const prev = list.find(x => x.key === key)
	const summaryKeys = [...new Set([...(prev?.summaryKeys ?? []), ...summaryFactKeys(item.content)])]
	const related = list.filter(x => x.key === key || (x.summaryKeys ?? []).some(k => summaryKeys.includes(k)))
	const at = Math.max(Date.now(), ...related.map(x => x.at + 1), (item.updatedAt ?? 0) + 1)
	store.contentActions = [...list.filter(x => x.key !== key).map(x => state === "restored" && related.includes(x)
		? {...x, state, at} : x), {id: item.id, key, state, at, summaryKeys}]
}

export const contentBlocked = (store: MemoryStoreData, content: string): boolean => {
	const keys = new Set(summaryFactKeys(content))
	return (store.contentActions ?? []).some(x => x.state !== "restored" &&
		(x.key === memoryContentKey(content) || (x.summaryKeys ?? []).some(k => keys.has(k)))) ||
		(store.deletedBin ?? []).some(x => textMentionsMemory(content, x))
}

export const textMentionsMemory = (text: string, item: MemoryItem): boolean => {
	const keys = new Set(summaryFactKeys(item.content))
	return summaryFactKeys(text).some(k => keys.has(k)) || sentences(text).some(s =>
		memoryContentKey(s) === memoryContentKey(item.content))
}

/** 按完整句子移除停用事实；不拼接残缺分句，保留其他独立事实。 */
export const filterSummaryText = (store: MemoryStoreData, text: string, historical = false, includeInactive = true): string => {
	const inactive = includeInactive ? store.memories.filter(m => !isActiveMemory(m) && !(historical && m.invalidAt && !m.fadedAt)) : []
	const blocked = [...inactive, ...(store.deletedBin ?? [])]
	const actions = (store.contentActions ?? []).filter(x => x.state !== "restored")
	const exact = new Set([...blocked.map(m => memoryContentKey(m.content)), ...actions.map(x => x.key)])
	const semantic = new Set([...blocked.flatMap(m => summaryFactKeys(m.content)), ...actions.flatMap(x => x.summaryKeys ?? [])])
	const excluded = (s: string): boolean => exact.has(memoryContentKey(s)) || summaryFactKeys(s).some(k => semantic.has(k))
	return sentences(text).flatMap(s => {
		if (!excluded(s)) return [s]
		const clauses = s.split(/[，,]/).map(c => c.trim()).filter(Boolean)
		// 只有能独立定位被删事实时才分句；保留带明确主语的其他事实，不拼接代词残句。
		if (!clauses.some(excluded)) return []
		return clauses.filter(c => !excluded(c) && /^(?:用户|主人|我|自己|同事|朋友|他|她)/.test(c))
			.map(c => /[。！？!?；;]$/.test(c) ? c : `${c}。`)
	})
		.map(s => s.trim()).filter(Boolean).join("\n")
}

/** 写入只清除已删除事实。收起的原文保留，新证据仍可恢复自动收起条目。 */
export const filterDeletedText = (store: MemoryStoreData, text: string): string => filterSummaryText(store, text, false, false)

export const filteredSummary = (store: MemoryStoreData, summary: MemorySummary, historical = false): MemorySummary | null => {
	const hidden = new Set(store.suppressedSummaryIds ?? [])
	if ([summary.id, ...(summary.sourceIds ?? [])].some(id => hidden.has(id))) return null
	const content = filterSummaryText(store, summary.content, historical)
	return content ? {...summary, content, tokenCount: Math.max(1, Math.ceil(content.length / 4))} : null
}

export const summaryUsable = (store: MemoryStoreData, summary: Pick<MemorySummary, "id" | "content" | "sourceIds">, historical = false): boolean => {
	const hidden = new Set(store.suppressedSummaryIds ?? [])
	return ![summary.id, ...(summary.sourceIds ?? [])].some(id => hidden.has(id)) &&
		filterSummaryText(store, summary.content, historical) === sentences(summary.content).map(s => s.trim()).filter(Boolean).join("\n")
}

/** 永久删除时清掉已知叙事副本；整条被移除才屏蔽来源 id，避免丢掉其他有效事实。 */
export const suppressRelatedSummaries = (store: MemoryStoreData, item: MemoryItem): void => {
	const hidden = new Set(store.suppressedSummaryIds ?? [])
	for (const s of [...store.summaries, ...(store.meta ?? [])]) {
		if (!textMentionsMemory(s.content, item)) continue
		s.content = filterDeletedText(store, s.content)
		s.tokenCount = Math.max(1, Math.ceil(s.content.length / 4))
		if (!s.content) hidden.add(s.id)
	}
	for (const b of store.blocks ?? []) {
		if (!textMentionsMemory(`${b.topic}\n${b.summary}`, item)) continue
		b.summary = filterDeletedText(store, b.summary)
		if (textMentionsMemory(b.topic, item)) b.topic = ""
		if (!b.summary) { b.topic = ""; hidden.add(b.id) }
	}
	store.suppressedSummaryIds = [...hidden]
}
