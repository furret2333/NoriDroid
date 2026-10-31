import {subjectMatches} from "./subjects"
/** Conservative factuality checks for automatic writes, not manual edits. */
const NON_FACT = /开玩笑(?:说|的|地|[，,。！!]|$)|开个玩笑|闹着玩|逗你|说笑|假如|假设|如果|要是|比方说|举个例子|据说|听说|转述|台词|角色扮演|并不是说|不是说|从没说|没有说|没说过|不是真的|并非事实|难道|难不成|谁说/
const QUOTE = /[“「『"][\s\S]*?[”」』"]/g

export const factualClauses = (text: string, keepHistorical = false): string[] => {
	// Keep quote scope before splitting: punctuation inside a quotation cannot expose a fake “我”.
	const unquoted = text.replace(QUOTE, quote => " ".repeat(quote.length))
	const sentences = unquoted.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? []
	const result: string[] = []
	for (const sentence of sentences) {
		if (NON_FACT.test(sentence)) continue
		// A reported claim stays reported across commas, not across a new independent sentence.
		if (/(?:他说|她说|朋友说|同事说|妈妈说|爸爸说|有人说|别人说|说过|问我|问你|声称|原话)/.test(sentence)) continue
		for (const part of sentence.split(/[，,]/)) {
			if (/[？?]|(?:吗|么|呢)[。！!\s]*$/.test(part)) continue
			const clause = part.trim().replace(/^[但而]是|^不过|^其实|^现在|^目前/, "").trim()
			if (!clause || /不叫|不住|不在|才怪|并非|不是|未必|可能|也许|大概/.test(clause) ||
				(!keepHistorical && /以前|曾经|过去|原来|当时|小时候/.test(clause))) continue
			result.push(clause.replace(/[。！!；;]$/, ""))
		}
	}
	return result
}

/** A deterministic rule may only use a match at the user's own clause boundary. */
export const ruleMatchAllowed = (clause: string, index: number): boolean => {
	const before = clause.slice(0, index).trim()
	return !before || /^(?:对了|对|嗯|嗯嗯|其实|不过|但是|请|请你|帮我|一定要|永远|一直|记住[：:，,\s]*)$/.test(before)
}

/** Reject a model's decontextualized fact only when all matching user evidence is unsafe.
 * Unknown paraphrases remain the model's responsibility; no similarity-based deletion. */
export const supportedAutomaticFact = (content: string, messages: readonly {role: string; content: string}[], mentions: (text: string, content: string) => boolean): boolean => {
	const users = messages.filter(m => m.role === "user")
	const evidence = users.filter(m => mentions(m.content, content))
	if (!evidence.length) return true
	const historical = /以前|曾经|过去|原来|当时|小时候/.test(content)
	return evidence.some(m => factualClauses(m.content, historical).some(clause => {
		if (!mentions(clause, content) || !subjectMatches(content, clause)) return false
		if (/不(?:再)?喜欢|讨厌|不爱/.test(clause) && /喜欢|喜爱|爱/.test(content) && !/不(?:再)?喜欢|讨厌|不爱/.test(content)) return false
		return true
	}))
}
