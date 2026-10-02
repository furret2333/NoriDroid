/**
 * 探针: 「作废 → 摘要回流」这一步里 invalidAt 为什么会丢 (T29-C 实测失败)。
 * 只做复现 + 逐步打印状态, 不改被测代码。
 * 运行: cd web-src && node tmp-memcheck/probe-invalid-reflow.mjs
 */
import {readFileSync, readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")).href)
const rawPlugin = {
	name: "raw",
	setup(b) {
		b.onResolve({filter: /\?raw$/}, (args) => ({path: args.path, namespace: "raw-file"}))
		b.onLoad({filter: /./, namespace: "raw-file"}, (args) => {
			const rel = args.path.replace(/\?raw$/, "").replace(/^\.\//, "")
			const base = path.dirname(args.importer || path.join(root, "src/services/chat/index.ts"))
			return {loader: "text", contents: readFileSync(path.resolve(base, rel), "utf8")}
		})
	},
}
await build({
	entryPoints: [path.join(root, "src/services/memory/index.ts")],
	bundle: true, platform: "neutral", format: "esm", logLevel: "silent",
	outfile: path.join(root, "tmp-memcheck/memory-bundle.mjs"), plugins: [rawPlugin],
})

const files = new Map()
globalThis.window = {
	NoriChat: {
		readFile: (n) => files.get(n) ?? "",
		writeFile: (n, c) => { files.set(n, String(c)); return "ok" },
	},
}
const mem = await import(pathToFileURL(path.join(root, "tmp-memcheck/memory-bundle.mjs")).href)

const mkMem = (id, content, over = {}) => ({
	id, content, type: "preference", importance: 0.7, confidence: 0.9,
	createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over,
})
const dump = (tag) => {
	const mems = JSON.parse(files.get("memory.json") || "{}").memories ?? []
	const live = mem.listAll(true).memories
	console.log(`\n[${tag}]`)
	console.log("  内存:", JSON.stringify(live.map(m => [m.id, !!m.invalidAt, m.updatedAt])))
	console.log("  磁盘:", JSON.stringify(mems.map(m => [m.id, !!m.invalidAt, m.updatedAt])))
}

files.set("memory.json", JSON.stringify({
	memories: [mkMem("nm2", "我叫小明", {type: "fact", importance: 0.9, tags: ["identity"], decayDays: null})],
	summaries: [], summarizedMsgCount: 0, tombstones: [],
}))
mem.reloadMemory()
dump("载入后")

console.log("\ninvalidMemory(nm2) =", mem.invalidateMemory("nm2"))
dump("作废后 (防抖未落盘)")

const msgCount = 60
const history = Array.from({length: msgCount}, (_, i) => ({role: i % 2 ? "assistant" : "user", content: `第${i}句闲聊`, ts: Date.now() + i}))
const ok = await mem.summarizeIfNeeded(history, async () => "这段时间聊了些家常。\n**记忆要点**：我叫小明\n")
console.log("\nsummarizeIfNeeded =", ok)
dump("摘要后 (未 flush)")

await mem.flushMemoryPersist()
dump("flush 后")
console.log("\n摘要正文:", JSON.stringify(mem.listAll().summaries.map(s => s.content)))
