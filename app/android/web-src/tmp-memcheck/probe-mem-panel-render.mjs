/* 量测: 记忆库里「已收起」条数 → 打开记忆库要多久 (2026-09-30)
 *
 * 为什么量这个: P3 推演发现「已收起」**没有上限**(自动路径只收起不删除)。唯一还没量过的代价
 * 就是**界面渲染** —— 已收起区在 Vue 里是 `v-for` 全量渲染 (`<details>` 默认折叠,
 * 但 DOM 节点照样会建)。本脚本就量这一笔, 用来决定"要不要给列表分页/懒渲染"。
 *
 * 做法: 起 harness(8123) + Edge headless, 每次**全新页面**灌一份 memory.json
 * (N 条已收起 + 3 条生效), 然后按真实路径打开记忆库(设置 → 点三下「记忆库」), 在页面里用
 * performance.now() 分别量:
 *   · 面板打开耗时 (第 3 下点击 → 统计行渲染出来)
 *   · 已收起列表渲染耗时 (→ N 行 .mem-item 全部就位)
 *   · 展开折叠区的耗时 (点 summary → 2 帧之后)
 *   · 面板内 DOM 节点数
 *
 * 运行: cd web-src && node tmp-memcheck/probe-mem-panel-render.mjs
 *       (harness 没在跑会自动起, 跑完关掉自己起的那个)
 */
import {spawn} from "node:child_process"
import {mkdtempSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const CDP_PORT = 9441
const root = join(import.meta.dirname, "..")
const appDir = join(root, "..")
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const CASES = [0, 200, 800, 2400]

/* ---------- harness ---------- */
const harnessUp = async () => {
	try { return (await fetch("http://127.0.0.1:8123/assets/web/index.html", {signal: AbortSignal.timeout(1200)})).ok } catch { return false }
}
let harness = null
if (!(await harnessUp())) {
	console.log("起 harness (8123)…")
	harness = spawn(process.execPath, [".harness/server.mjs"], {cwd: appDir, stdio: "ignore"})
	let up = false
	for (let i = 0; i < 40 && !up; i += 1) { await sleep(250); up = await harnessUp() }
	if (!up) { console.log("harness 起不来, 退出"); process.exit(1) }
	console.log("  harness 就绪 (跑完会关掉)")
}

/* ---------- Edge + CDP ---------- */
const profile = mkdtempSync(join(tmpdir(), "nori-panelrender-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
	})
}
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

const rows = []
try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	const jsErrors = []
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
		if (m.method === "Runtime.exceptionThrown") jsErrors.push(m.params?.exceptionDetails?.exception?.description || "?")
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
	}
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId)
	await send("Page.enable", {}, sessionId)
	const evalJs = async (expr) => {
		const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
		return r.result.value
	}
	const S = Buffer.from(JSON.stringify({apiKey: "sk-e2e", baseUrl: "https://api.e2e.test", model: "e2e-model"})).toString("base64url")

	for (const nFaded of CASES) {
		/* 每个用例都从**全新页面**开始 (假桥的 files 是页面级的, 换页即清空) */
		await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
		await sleep(4300)
		await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
		for (let i = 0; i < 5; i += 1) {
			if (!(await evalJs(`!!document.querySelector(".intro-mask")`))) break
			await evalJs(`document.querySelector(".intro-next")?.click()`)
			await sleep(300)
		}
		await evalJs(`document.querySelector(".intro-mask")?.remove()`)

		/* 灌数据: N 条已收起 + 3 条生效 (内容长度按真实量级: 8~20 字) */
		const seedInfo = await evalJs(`(() => {
			const ts0 = Date.now() - 86400000 * 30;
			const mk = (id, content, over = {}) => ({id, content, type:"preference", importance:0.6, confidence:0.9,
				createdAt: ts0, updatedAt: ts0, lastAccessedAt: 0, accessCount: 0, tags: [], decayDays: 90, ...over});
			const kind = ["expired", "lowvalue"];
			const memories = [];
			for (let i = 0; i < ${nFaded}; i += 1) {
				memories.push(mk("f" + i, "第" + i + "条已经收起的旧记忆内容", {
					fadedAt: ts0 + i * 1000, fadedReason: kind[i % 2]}));
			}
			for (let i = 0; i < 3; i += 1) memories.push(mk("act" + i, "生效中的记忆" + i));
			const raw = JSON.stringify({memories, summaries: [], summarizedMsgCount: 0, tombstones: [], meta: [], schemaVersion: 2,
				blocks: [{id: "blk-a", fromTs: ts0, toTs: ts0 + 1000, msgCount: 25, topic: "初见", summary: "s", createdAt: ts0, itemIds: ["act0"]}]});
			window.NoriChat.writeFile("memory.json", raw);
			return {bytes: raw.length};
		})()`)

		/* 打开记忆库: 设置 → 点三下 (前两下只是拦门气泡, 第三下才真正进) */
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(900)
		for (let i = 0; i < 2; i += 1) { await evalJs(`document.querySelector(".sheet .mem-enter")?.click()`); await sleep(340) }
		/* ★ 计时从"真正进记忆库的那一下"开始, 不含上面人为的 340ms 间隔 */
		const timing = await evalJs(`(async () => {
			const waitFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
			const until = async (fn, budget = 15000) => {
				const t0 = performance.now();
				while (performance.now() - t0 < budget) {
					if (fn()) return performance.now() - t0;
					await new Promise(r => setTimeout(r, 5));
				}
				return -1;
			};
			const t0 = performance.now();
			document.querySelector(".sheet .mem-enter")?.click();
			const panelMs = await until(() => !!document.querySelector(".sheet .mem-stats"));
			const listMs = ${nFaded} === 0 ? 0 : await until(() => document.querySelectorAll(".sheet .mem-faded .mem-item").length >= ${nFaded});
			const stats = (document.querySelector(".sheet .mem-stats") || {}).innerText || "";
			const rowsNow = document.querySelectorAll(".sheet .mem-faded .mem-item").length;
			const nodesClosed = document.querySelectorAll(".sheet *").length;
			await waitFrame();
			const nodesPainted = document.querySelectorAll(".sheet *").length;
			/* 展开折叠区 (真实点击 summary) */
			const t1 = performance.now();
			const d = document.querySelector(".sheet .mem-faded");
			if (d) d.open = true;
			await waitFrame();
			await waitFrame();
			const expandMs = performance.now() - t1;
			await waitFrame();
			return {totalMs: performance.now() - t0, panelMs, listMs, expandMs, rowsNow, nodesClosed, nodesPainted,
				stats, jsonKb: Math.round((window.NoriChat.readFile("memory.json") || "").length / 1024)};
		})()`)

		rows.push({nFaded, ...timing, seedBytes: seedInfo.bytes})
		console.log(`  已收起 ${String(nFaded).padStart(4)} 条 · memory.json ${timing.jsonKb} KB → 面板 ${timing.panelMs.toFixed(1)}ms · 列表 ${timing.listMs.toFixed(1)}ms · 展开 ${timing.expandMs.toFixed(1)}ms · DOM ${timing.nodesPainted} 节点 · 行数 ${timing.rowsNow}`)
	}

	/* ---------- 结论 ---------- */
	const base = rows[0], big = rows.at(-1)
	const f = (x) => `${x.toFixed(0)}ms`
	console.log("\n===== 汇总 (520x900 视口, headless Edge) =====")
	console.log("  已收起条数 | memory.json | 面板打开 | 列表渲染 | 展开折叠 | 面板 DOM 节点")
	for (const r of rows) {
		console.log(`  ${String(r.nFaded).padStart(9)}  | ${String(r.jsonKb + " KB").padStart(10)}  | ${f(r.panelMs).padStart(8)} | ${f(r.listMs).padStart(8)} | ${f(r.expandMs).padStart(8)} | ${r.nodesPainted}`)
	}
	const extra = big.panelMs - base.panelMs
	console.log(`\n  ${big.nFaded} 条 vs 0 条: 打开记忆库多花 ${f(extra)} (${(big.panelMs / Math.max(1, base.panelMs)).toFixed(1)}×) · DOM 节点 ${base.nodesPainted} → ${big.nodesPainted}`)
	const verdict = big.panelMs < 400
		? "结论: 渲染**不是**瓶颈 (<400ms) ⇒ 不需要给「已收起」列表分页/懒渲染"
		: big.panelMs < 1200
			? "结论: 有感知但不卡 (<1.2s) ⇒ 可选做「只渲染最近 N 条 + 展开更多」"
			: "结论: **需要**改渲染 (>1.2s) ⇒ 给列表加懒渲染/分页"
	console.log(`  ${verdict}`)
	console.log(`  JS 异常: ${jsErrors.length ? jsErrors.slice(0, 3).join(" | ") : "无"}`)
	process.exitCode = jsErrors.length ? 1 : 0
} catch (e) {
	console.log("量测失败:", e.message)
	process.exitCode = 1
} finally {
	try { edge.kill() } catch { /* 忽略 */ }
	try { ws?.close() } catch { /* 忽略 */ }
	if (harness) { try { harness.kill() } catch { /* 忽略 */ } }
}
