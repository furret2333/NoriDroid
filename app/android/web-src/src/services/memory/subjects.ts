/** Read-time subject hints only. Nothing is inferred into the persisted schema. */
const RELATIONS: [string, RegExp][] = [
	["mother", /妈妈|母亲|我妈/], ["father", /爸爸|父亲|我爸/],
	["sister", /姐姐|妹妹/], ["brother", /哥哥|弟弟/],
	["partner", /女朋友|男朋友|女友|男友|老婆|老公|对象|伴侣/],
	["friend", /朋友/], ["colleague", /同事/],
	["cat", /猫咪|猫/], ["dog", /狗狗|狗/],
	["company", /公司/],
]
const PREDICATE = /(?:最)?(?:喜欢|不喜欢|讨厌|爱喝|爱吃|对|叫|名字|姓名|住|生日|过敏|在做|在开发|正在|负责|习惯|每天|喝|吃|养|有|是什么)/
export interface SubjectHints {self: boolean; roles: string[]; names: string[]}

export const subjectHints = (text: string): SubjectHints => {
	// Inspect subjects before the predicate, not objects such as “我喜欢猫”.
	const first = text.trim().replace(/^(?:对了[，,\s]*|请问|你还记得|你记得|你知道|还记得|(?:请|能)?告诉我|记住[：:，,\s]*|再聊聊|再聊|说说|关于)/, "")
		.replace(/^我有(?:个|一[个位])(?=朋友|同事)/, "")
	const end = first.search(PREDICATE)
	const head = end < 0 ? first : first.slice(0, end)
	const roles = RELATIONS.filter(([key, re]) => re.test(key === "friend" ? head.replace(/男朋友|女朋友/g, "") : head)).map(([key]) => key)
	const named = head.replace(/(?:我的|我家|用户的|主人的|我有个|我有一个|我有位|我那位|我|和|与|以及|分别|朋友|同事|妈妈|爸爸|姐姐|妹妹|哥哥|弟弟|的|那位|那个|这个|之前提到的|吗|呢|怎么样|进度|项目|[，,。；;\s])/g, "")
	const latin = !/^(?:我|主人|用户|自己)/.test(head) || roles.length ? head.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [] : []
	const names = latin.length ? latin : !/^(?:我|主人|用户|自己)(?!的?(?:朋友|同事))/.test(head) &&
		(end >= 0 || roles.includes("friend") || roles.includes("colleague")) && /^[\p{L}·]{2,4}$/u.test(named) &&
		!/(?:什么|怎么|哪里|那个|这个|事情|以前|现在|最近|电影|影片|天气|宠物|名字|姓名|考试|快|要|想|帮|请|能|会|需要)/.test(named) ? [named] : []
	const possessive = /(?:我|主人|用户)(?:的|家)/.test(head)
	const coordinated = /(?:我|主人|用户)(?:和|与|以及)/.test(head)
	const self = coordinated || (!roles.length && !names.length && /我|主人|用户|自己/.test(head)) ||
		(!head && /^(?:喜欢|不喜欢|讨厌|住在|每天|习惯)/.test(first)) ||
		(possessive && /养|有只/.test(first) && !roles.length)
	return {self, roles, names}
}

/** Unknown subjects stay unknown. Explicit other subjects cannot become user facts. */
export const subjectMatches = (query: string, content: string): boolean => {
	const q = subjectHints(query), m = subjectHints(content)
	if (q.names.length) return q.names.some(name => content.includes(name)) ||
		(q.self && m.self)
	if (q.roles.length) return q.roles.some(role => m.roles.includes(role)) || (q.self && m.self)
	if (q.self) return !m.roles.length && !m.names.length && !/^(?:他|她|别人)/.test(content.trim())
	return true
}

/** Direct lookup is deliberately restricted to an explicit personal attribute. */
export const selfQueryFactKey = (query: string): string | null => {
	const q = query.replace(/以前|过去|原来|曾经|之前|旧|现在|目前|请问|你还记得|还记得|你知道|你记得/g, "").replace(/[\s，,。？?！!]/g, "")
	if (/^(?:我(?:的)?(?:名字|姓名|称呼)|我(?:叫(?:什么|啥)|是谁)|(?:主人|用户)(?:的)?(?:名字|姓名|称呼|叫什么))/.test(q)) return "self:name"
	if (/^(?:我(?:的)?(?:家|居住地)(?:在|是|哪|住)|我(?:住哪|住在|居住)|(?:主人|用户)(?:住哪|住在|的居住地))/.test(q) && !/(?:猫|狗|朋友|妈妈|爸爸)/.test(q)) return "self:home"
	if (/^(?:我(?:的)?生日|(?:主人|用户)(?:的)?生日)/.test(q)) return "self:birthday"
	return null
}
