/**
 * 探针: 解析器会不会丢掉"省略宾语/很短"的模型输出?
 *
 * 为什么需要 (2026-09-27 实机反馈「天气凉了 突然不想买了」不进记忆):
 * 要分清两种可能 —— ① **模型返回了 `{"facts":[]}`**(提示词层面的原因),
 * 还是 ② **模型给了事实但被解析器/写入侧丢掉**(代码 bug)。实测结论是 ①:
 * 这些短句/省略句**全都能被 parseLlmMemories 正常接住** ⇒ 问题不在解析器,
 * 而在提示词的「不要记: 一时的情绪和吐槽 / 一次性的琐碎当下动作」把这类**反悔句**也挡掉了
 * (【该记的信息】7 条里根本没有"改口/反悔"这一类)。
 *
 * 运行: cd web-src && node tmp-memcheck/probe-parse-tolerance.mjs
 */
import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)
const root = path.resolve(import.meta.dirname, "..")
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)

const cases = [
	`{"facts":[{"content":"不想买了","type":"preference"}]}`,
	`{"facts":[{"content":"不想买冰激凌了","type":"preference"}]}`,
	`{"facts":[{"content":"我不想买冰激凌了","type":"preference"}]}`,
	`{"facts":["不想买了"]}`,
	`{"facts":[{"content":"天气凉了不想买了","type":"preference"}]}`,
]
console.log("① 解析器容错: 短句/省略宾语会不会被丢")
for (const c of cases) {
	const out = core.parseLlmMemories(c)
	console.log(`  ${c}\n    → ${out.length ? JSON.stringify(out.map(i => i.content)) : "(被丢掉)"}`)
}

console.log("")
console.log("② 提取提示词的「不要记」清单 (节选) —— 反悔句就落在第 3/4 条里")
const p = core.buildLlmExtractPrompt("天气凉了 突然不想买了", [
	{role: "user", content: "我想去买冰激凌"},
	{role: "assistant", content: "好呀"},
])
console.log(p.slice(0, 1400))
