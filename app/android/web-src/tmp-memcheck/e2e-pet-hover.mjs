/* E2E: "鼠标指针落到 Nori 头上"到底会不会触发触摸音/特效?
 *
 * 用户反馈（2026-09-26）: "鼠标指针落到 nori 头上还是有触摸声音与特效。改成只有真正按下才触发"。
 * 代码上 `updateNoriHead` 的反馈分支看着是 `if (stroking)` 守着的（stroking 只在 pointerdown
 * 后由 260ms 定时器置位）—— 所以先**实测**：只移动指针、不按下，究竟会不会冒粒子/响音。
 *
 * 做法: CDP 派发 pointermove(buttons=0) 到头部坐标若干次, 观察:
 *   - __noriPetDebug().onHead   (悬停是否被判成"在头上")
 *   - __noriPetFxSpawned()      (累积特效计数, 不随元素过期而变, 比数 DOM 稳)
 *   - #nori-pet-fx 子元素数      (当下是否真有粒子)
 *   - petAudioState()           (音频上下文/播放状态)
 * 之后再做一次**真正按下**的对照, 证明这套探针能抓到"该触发"的情况 (反证, 避免假通过)。
 *
 * 运行: node tmp-memcheck/e2e-pet-hover.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9401
const profile = mkdtempSync(join(tmpdir(), "nori-hover-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 25000)
	})
}
const results = []
const check = (name, cond, detail = "") => {
	results.push({name, cond: !!cond})
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ← ${detail}`}`)
}
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

try {
	ws = new WebSocket(await wsUrl())
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data)
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
	/** 派发指针事件; buttons 用于区分"悬停"(0) 与"真的按着"(1) */
	const pointer = (type, x, y, buttons) => `document.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
		clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: "mouse", isPrimary: true,
		buttons: ${buttons}, button: ${type === "pointermove" ? -1 : 0}, bubbles: true, cancelable: true}))`

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	const card = await evalJs(`(() => {
		const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)}));
		if (!c) return "NO_CARD"; c.click(); return "CLICKED"
	})()`)
	await sleep(9000)
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(600)
	check("模型已加载且面板已关闭", card === "CLICKED", String(card))

	/* 找一个"头部"坐标。
	 * 注意: `headBox` 只在 `refreshHeadBox()` 里算, 而它只在 **pointerdown** 里被调用 ⇒
	 * 必须**先按一下**才能读到头部框 (这一步本身不算悬停测试, 它只是定位)。 */
	await evalJs(pointer("pointerdown", 260, 700, 1))   // 先按在画面下方(多半不是头), 只为触发生成
	await sleep(150)
	await evalJs(pointer("pointerup", 260, 700, 0))
	await sleep(200)
	const headPt = await evalJs(`(() => {
		const dbg = window.__noriPetDebug ? window.__noriPetDebug() : null
		const cv = window.__noriCanvasView ? window.__noriCanvasView() : null
		if (!dbg || !cv) return {err: "钩子缺失", dbg: !!dbg, cv: !!cv}
		const hb = dbg.headBox
		if (!hb) return {err: "headBox 为空", dbg}
		const canvas = [...document.querySelectorAll("canvas")].find((c) => /scale\\(/.test(c.style.transform || ""))
		if (!canvas) return {err: "找不到 canvas"}
		const R = canvas.getBoundingClientRect()
		const mb = dbg.modelBox
		const cx = (hb.left + hb.right) / 2, cy = (hb.top + hb.bottom) / 2
		// 模型坐标 → client: 模型框线性映射到 canvas 矩形, 再套 CSS transform 的逆变换
		const u = (cx - mb.left) / (mb.right - mb.left)
		const v = (mb.top - cy) / (mb.top - mb.bottom)
		const px = R.left + u * R.width, py = R.top + v * R.height
		const Ox = R.left + R.width / 2, Oy = R.top + R.height / 2
		const scale = cv.scale || 1
		return {
			hb, mb, cv, rect: [R.left, R.top, R.width, R.height],
			pt: {x: Ox + (px - Ox) / scale - (cv.offsetX || 0), y: Oy + (py - Oy) / scale - (cv.offsetY || 0)},
		}
	})()`)
	if (headPt?.err) { check("能定位到头部坐标", false, JSON.stringify(headPt)) }
	else {
		console.log(`   头部框 ${JSON.stringify(headPt.hb)} → 视口 ${JSON.stringify(headPt.pt)}`)
		/* 位置校验: 这个点必须真的被判为"在头上" (按下去验证一次), 否则后面的悬停断言没有意义 */
		await evalJs(pointer("pointerdown", headPt.pt.x, headPt.pt.y, 1))
		await sleep(500)
		const sanity = await evalJs(`(window.__noriPetDebug ? window.__noriPetDebug() : null)`)
		await evalJs(pointer("pointerup", headPt.pt.x, headPt.pt.y, 0))
		await sleep(600)
		console.log(`   位置校验: onHead=${sanity?.onHead} geomOk=${sanity?.geomOk} modelY=${sanity?.modelY} 线=${sanity?.bandLine}`)
		check("定位到的点确实落在头区 (否则悬停断言无效)", sanity?.onHead === true,
			`onHead=${sanity?.onHead} modelY=${sanity?.modelY} bandLine=${sanity?.bandLine}`)

		/* ---- 关键实测: 只移动指针 (buttons=0), 在头部小幅移动, 全程不按下 ---- */
		/* ---- 关键实测: 只移动指针 (buttons=0), 在头部小幅移动, 全程不按下 ----
		 * 先**重新载入页面**: 排除"之前那次定位按压"留下的任何延时定时器/状态 ——
		 * 用户报的场景本来就是"指针落到头上", 不该依赖任何先前交互。 */
		await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
		await sleep(6500)
		const reloaded = await evalJs(`(() => {
			const dbg = window.__noriPetDebug ? window.__noriPetDebug() : null
			return {ready: !!dbg, headBox: dbg ? dbg.headBox : null, strokeOnModel: false}
		})()`)
		console.log(`   重载后: 探针就绪=${reloaded.ready} headBox=${reloaded.headBox ? "已有(无需按下)" : "空"}`)
		const before = await evalJs(`(() => { window.__noriBurstTrace = []; window.__noriFxTrace = []; return {
			fx: window.__noriPetFxSpawned ? window.__noriPetFxSpawned() : null,
			dom: document.getElementById("nori-pet-fx") ? document.getElementById("nori-pet-fx").childElementCount : -1,
			audio: window.__noriPetDebug ? window.__noriPetDebug().audio : null,
		} })()`)
		for (let i = 0; i < 24; i += 1) {
			const dx = (i % 2 === 0 ? -6 : 6)
			await evalJs(pointer("pointermove", headPt.pt.x + dx, headPt.pt.y, 0))
			await sleep(60)
		}
		const after = await evalJs(`({
			dbg: window.__noriPetDebug ? window.__noriPetDebug() : null,
			fx: window.__noriPetFxSpawned ? window.__noriPetFxSpawned() : null,
			dom: document.getElementById("nori-pet-fx") ? document.getElementById("nori-pet-fx").childElementCount : -1,
			audio: window.__noriPetDebug ? window.__noriPetDebug().audio : null,
			pressed: window.__noriPetDebug ? window.__noriPetDebug().pressed : null,
		})`)
		const dFx = (after.fx && before.fx) ? {
			mote: (after.fx.mote ?? 0) - (before.fx.mote ?? 0),
			star: (after.fx.star ?? 0) - (before.fx.star ?? 0),
			ripple: (after.fx.ripple ?? 0) - (before.fx.ripple ?? 0),
			touch: (after.fx.touch ?? 0) - (before.fx.touch ?? 0),
		} : after.fx
		console.log(`   悬停 ${24 * 60}ms 后: onHead=${after.dbg?.onHead} pressed=${after.pressed} stroking=${after.dbg?.stroking} headFollow=${after.dbg?.headFollow} swayRaf=${after.dbg?.swayRaf} 特效增量=${JSON.stringify(dFx)} DOM=${after.dom}`)
		const trace = await evalJs(`({burst: window.__noriBurstTrace || [], fx: window.__noriFxTrace || []})`)
		if (trace.burst.length) console.log(`   悬停期间 spawnPetTouchBurst 调用栈:\n     ${trace.burst.join("\n     ")}`)
		else console.log(`   悬停期间没有 spawnPetTouchBurst 调用`)
		if (trace.fx.length) console.log(`   悬停期间生成来源 ${trace.fx.length} 条: ${trace.fx.slice(0, 4).join(" ; ")}`)
		check("悬停时不处于抚摸状态 (stroking=false)", after.dbg?.stroking === false,
			`stroking=${after.dbg?.stroking} headFollow=${after.dbg?.headFollow} swayRaf=${after.dbg?.swayRaf}`)
		check("悬停不产生任何特效 (粒子/火花/涟漪/触到爆发 计数都不变)",
			!!dFx && dFx.mote === 0 && dFx.star === 0 && dFx.ripple === 0 && dFx.touch === 0, JSON.stringify(dFx))
		check("悬停后特效层没有残留元素", after.dom <= 0, `dom=${after.dom}`)
		check("悬停不被计入\"按下的手指数\"", after.pressed === 0, `pressed=${after.pressed}`)

		/* ---- 反证: 真正按下并按住 >260ms, 同样位置必须冒特效 (证明探针抓得住) ---- */
		const b2 = await evalJs(`(window.__noriPetFxSpawned ? window.__noriPetFxSpawned() : null)`)
		await evalJs(pointer("pointerdown", headPt.pt.x, headPt.pt.y, 1))
		await sleep(420)
		for (let i = 0; i < 8; i += 1) {
			await evalJs(pointer("pointermove", headPt.pt.x + (i % 2 === 0 ? -6 : 6), headPt.pt.y, 1))
			await sleep(70)
		}
		const a2 = await evalJs(`({fx: window.__noriPetFxSpawned ? window.__noriPetFxSpawned() : null, dbg: window.__noriPetDebug()})`)
		await evalJs(pointer("pointerup", headPt.pt.x, headPt.pt.y, 0))
		await sleep(200)
		const d2 = (a2.fx && b2) ? {
			mote: (a2.fx.mote ?? 0) - (b2.mote ?? 0),
			star: (a2.fx.star ?? 0) - (b2.star ?? 0),
			ripple: (a2.fx.ripple ?? 0) - (b2.ripple ?? 0),
			touch: (a2.fx.touch ?? 0) - (b2.touch ?? 0),
		} : a2.fx
		console.log(`   反证(真按下): onHead=${a2.dbg?.onHead} 特效增量=${JSON.stringify(d2)}`)
		check("反证: 真正按下并按住确实触发特效 (说明本探针有效)", !!d2 && (d2.touch > 0 || d2.mote > 0 || d2.star > 0), JSON.stringify(d2))

		/* ---- 场景 B: "摸头途中面板被打开, 抬手被面板分支吞掉"后 悬停不得冒特效 ----
		 * 这是真正泄漏的那条路径: onStagePointerUp 原先在 panel!=="" 时直接 return,
		 * endHeadFollow 永不执行 ⇒ stroking/headFollowActive 卡在 true ⇒
		 * 之后任何一次悬停划过头部都会把"刚摸到"的爆发(触到音+火花涟漪)重放。 */
		await evalJs(pointer("pointerdown", headPt.pt.x, headPt.pt.y, 1))
		await sleep(420)                                  // 越过 STROKE_DELAY(260ms) 进入抚摸
		await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
		await sleep(500)                                  // 面板打开 (panel !== "")
		await evalJs(pointer("pointerup", headPt.pt.x, headPt.pt.y, 0))
		await sleep(300)
		const during = await evalJs(`(window.__noriPetDebug ? window.__noriPetDebug() : null)`)
		console.log(`   面板开着抬手后: stroking=${during?.stroking} headFollow=${during?.headFollow} swayRaf=${during?.swayRaf}`)
		check("场景B: 面板开着抬手也必须收尾 (stroking/headFollow 归 false)",
			during?.stroking === false && during?.headFollow === false,
			`stroking=${during?.stroking} headFollow=${during?.headFollow} swayRaf=${during?.swayRaf}`)
		await evalJs(`document.querySelector(".sheet-mask")?.click()`)
		await sleep(600)
		await evalJs(`(() => { window.__noriFxTrace = []; window.__noriBurstTrace = []; return 1 })()`)
		const b3 = await evalJs(`(window.__noriPetFxSpawned ? window.__noriPetFxSpawned() : null)`)
		for (let i = 0; i < 20; i += 1) {
			await evalJs(pointer("pointermove", headPt.pt.x + (i % 2 === 0 ? -6 : 6), headPt.pt.y, 0))
			await sleep(70)
		}
		const a3 = await evalJs(`({fx: window.__noriPetFxSpawned ? window.__noriPetFxSpawned() : null, dbg: window.__noriPetDebug ? window.__noriPetDebug() : null, trace: window.__noriFxTrace || []})`)
		const d3 = (a3.fx && b3) ? {
			mote: (a3.fx.mote ?? 0) - (b3.mote ?? 0),
			star: (a3.fx.star ?? 0) - (b3.star ?? 0),
			ripple: (a3.fx.ripple ?? 0) - (b3.ripple ?? 0),
		} : a3.fx
		console.log(`   场景B 悬停 1.4s: 特效增量=${JSON.stringify(d3)} onHead=${a3.dbg?.onHead} stroking=${a3.dbg?.stroking} 生成来源=${a3.trace.length}`)
		for (const line of a3.trace.slice(0, 6)) console.log(`     ${line}`)
		check("场景B: 面板开合之后, 悬停仍然不冒任何特效",
			!!d3 && d3.mote === 0 && d3.star === 0 && d3.ripple === 0, JSON.stringify(d3))
	}

	const failed = results.filter(r => !r.cond)
	console.log(`\n${results.length - failed.length}/${results.length} passed`)
	if (failed.length) {
		process.exitCode = 1
		console.log("FAILED:", failed.map(f => f.name).join(" | "))
	}
} catch (e) {
	console.error("探针异常:", e?.message || e)
	process.exitCode = 2
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
