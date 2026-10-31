import {subjectHints} from "./subjects"

export interface RecallTurn {role: string; content: string; error?: boolean}
export interface RecallQuery {search: string; contextTurns: number; unresolved: boolean}

/** A shared word is not a reason to attach personal tastes to an administrative task. */
const impersonalRecallQuery = (query: string): boolean =>
	/(?:天气|气温|天气预报).{0,8}(?:怎么样|如何|多少|怎样|几度)/.test(query) ||
	/(?:票|证件|证书|账号|密码|设备|电脑|手机).{0,8}(?:丢了|遗失|补办|重装|找回|维修|修理)/.test(query)

export const recallIntentMatches = (query: string, item: {type: string; content: string}): boolean =>
	!impersonalRecallQuery(query) || (item.type !== "preference" && item.type !== "relationship" &&
		!/喜欢|讨厌|最爱|偏爱|有个朋友|朋友叫/.test(item.content))
const REFERENCE = /(?:她|他|它)(?:呢|的|对|喜欢|现在|怎么样|还|叫)|^(?:她|他|它)[？?。！!]*$|(?:那|这)(?:个|件|项|部|只|场)(?:项目|事|工作|计划|电影|游戏|考试|宠物)|^(?:后来|然后|接着)呢/
const PROJECT = /项目|开发|工程|计划|论文|备考|考研|研究/
const EXPLICIT = /[A-Za-z][A-Za-z0-9_-]{2,}|[“「《][^”」》]{2,30}[”」》]/

/** At most six recent turns, 240 chars per user turn; assistants cannot invent an anchor. */
export const buildRecallQuery = (query: string, recent: readonly RecallTurn[] = []): RecallQuery => {
	const base = {search: query, contextTurns: 0, unresolved: false}
	if (!REFERENCE.test(query)) return base
	const hints = subjectHints(query)
	if (hints.names.length || hints.roles.length || EXPLICIT.test(query)) return base
	// “星际穿越这部电影” already names its object; “这部电影” does not.
	const refAt = query.search(REFERENCE)
	const prefix = query.slice(0, refAt).replace(/^(?:再聊聊|聊聊|说说|关于|请问|我(?:的)?)/, "").trim()
	if (prefix.length >= 2) return base
	const turns = recent.slice(-6).filter(m => !m.error && (m.role === "user" || m.role === "assistant"))
	const tail = turns[turns.length - 1]
	if (tail?.role === "user" && tail.content === query) turns.pop()
	const last = [...turns].reverse().find(m => m.role === "user")
	if (!last || last.content.length > 240 || /换个话题|换话题|不聊这个|先不说|另外一件事/.test(last.content)) return {...base, unresolved: true}
	const anchor = last.content.trim()
	const subjects = subjectHints(anchor)
	const entities = anchor.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []
	if (subjects.roles.length > 1 || /(?:和|与|还有|、).{0,12}(?:项目|朋友|同事|妈妈|爸爸)/.test(anchor) || new Set(entities).size > 1) return {...base, unresolved: true}
	let valid = false
	if (/她/.test(query)) valid = /妈妈|母亲|姐姐|妹妹|女朋友|女友|老婆|她/.test(anchor)
	else if (/他/.test(query)) valid = /爸爸|父亲|哥哥|弟弟|男朋友|男友|老公|他/.test(anchor)
	else if (/项目|计划|那件事|这件事/.test(query)) valid = PROJECT.test(anchor) && (entities.length === 1 || subjects.names.length === 1 || /[“「《]/.test(anchor))
	else if (/它|那只|这只/.test(query)) valid = /猫|狗|宠物/.test(anchor) || (PROJECT.test(anchor) && entities.length === 1)
	else if (/那部|这部/.test(query)) valid = /电影|影片|[《“「]/.test(anchor)
	if (!valid) return {...base, unresolved: true}
	// Preserve the entire short source clause, including subject, negation and time.
	return {search: `${anchor}；${query}`, contextTurns: 1, unresolved: false}
}
