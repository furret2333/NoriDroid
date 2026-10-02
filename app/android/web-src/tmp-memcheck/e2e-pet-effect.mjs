/* E2E: 抚摸反馈 (柔光粒子 + 合成音 + 头区判定 + 有界 leash) 的真实浏览器验证。
 *
 * 验的是"实际 DOM/几何行为", 不是源码:
 *   - 按住 >260ms 进入抚摸后, 真的生成了粒子元素
 *   - **只有摸到头才给反馈**: 留白/身体按住不触发 —— 且用反证证明这不是假通过
 *   - 特效层**绝不挡触摸** (pointer-events:none) —— 否则会打断摸头本身
 *   - 层级在 canvas 之上、UI 之下; 存活数量有上限; 松手后自动移除 (不泄漏 DOM)
 *   - 头区判定**实时**更新: 手指可以随时滑进/滑出; 滑出模型外必须很快取消
 *   - 摸头时的"低头"曾用顶点几何验证 —— **那个功能已删除**, 对应断言整块移除（见 D 处说明）
 *
 * 运行: node tmp-memcheck/e2e-pet-effect.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9399
const profile = mkdtempSync(join(tmpdir(), "nori-pet-"))
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
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  <- ${detail}`}`)
}

/**
 * **已知失败白名单**：这些断言**预期就是失败的**，原因见 `why`。
 *
 * 为什么要它：有常驻红时，`72/73` 这个计数就失去了报警能力 ——
 * 以后真出现回归也是 72/73（甚至 71/73），没人分得清。
 *
 * 规则（两条都必要）：
 * 1. 不在白名单里的失败**一定**让脚本红 ⇒ "已知红"不会淹没"新红"；
 * 2. 白名单条目**必须确实还在失败** ⇒ 哪天它通过了就报"白名单已过期"并要求删除，
 *    否则白名单会慢慢变成永久免死金牌。
 *
 * 目前**是空的**：唯一那条常驻红（低头几何）随"低头功能删除"一起消失了。
 * 空着就是最好的状态 —— 它意味着这套 E2E 应该**全绿**。
 */
const KNOWN_FAILS = []
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

const J = (v) => JSON.stringify(v)

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
	const press = (type, x, y) => `document.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true}))`

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4000)

	/* 加载模型 */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
	await sleep(1500)
	const card = await evalJs(`(() => {
		const c = [...document.querySelectorAll(".mc")].find(x => x.textContent.includes(${JSON.stringify(MODEL)}));
		if (!c) return "NO_CARD"; c.click(); return "CLICKED"
	})()`)
	await sleep(9000)
	/* 关掉面板 —— onStagePointerDown 在 panel !== "" 时会直接 return, 摸头会被忽略 */
	await evalJs(`document.querySelector(".sheet-mask")?.click()`)
	await sleep(600)
	check("模型已加载且面板已关闭 (摸头前提)", card === "CLICKED", String(card))

	/* 分层之后不能再取 firstElementChild(第一颗可能是涟漪/小火花) —— 按 class 取, 并分类统计 */
	const fxInfo = `(() => {
		const l = document.getElementById("nori-pet-fx")
		if (!l) return {exists: false, n: 0, motes: 0, stars: 0, ripples: 0}
		const cs = getComputedStyle(l)
		const kid = l.querySelector(".nori-pet-mote")
		const ks = kid ? getComputedStyle(kid) : null
		return {
			exists: true, n: l.childElementCount,
			motes: l.querySelectorAll(".nori-pet-mote").length,
			stars: l.querySelectorAll(".nori-pet-star").length,
			ripples: l.querySelectorAll(".nori-pet-ripple").length,
			pe: cs.pointerEvents, z: cs.zIndex,
			kidPe: ks ? ks.pointerEvents : null,
			kidPos: ks ? ks.position : null,
			kidBg: ks ? ks.backgroundImage : null,
			kidRadius: ks ? ks.borderRadius : null,
			kidText: kid ? kid.textContent : null,
			kidSize: ks ? parseFloat(ks.width) : 0,
			kidKind: kid ? kid.dataset.kind : null,
		}
	})()`
	const rippleInfo = `(() => {
		const r = document.querySelector("#nori-pet-fx .nori-pet-ripple")
		if (!r) return null
		const s = getComputedStyle(r)
		return {bg: s.backgroundColor, bw: parseFloat(s.borderTopWidth), color: s.borderTopColor,
			round: s.borderRadius, size: parseFloat(s.width), pe: s.pointerEvents, kind: r.dataset.kind}
	})()`
	const starInfo = `(() => {
		const r = document.querySelector("#nori-pet-fx .nori-pet-star")
		if (!r) return null
		const s = getComputedStyle(r)
		return {bg: s.backgroundImage, text: r.textContent, radius: s.borderRadius}
	})()`
	const dbgInfo = `(window.__noriPetDebug ? window.__noriPetDebug() : null)`
	const spawnedInfo = `(window.__noriPetFxSpawned ? window.__noriPetFxSpawned() : null)`

	/* 扫点: 只判"这一点是实体"不够 —— 落在轮廓最边缘的点, 模型一呼吸/摆动就不再是实体,
	   会让后续断言偶发失败。所以要求它**连同四邻都是实体**(往实心内部靠)。 */
	const pts = await evalJs(`(() => {
		const onUI = (el) => !!(el && el.closest && el.closest(".sheet, .dock, .topbar, .pet-fab, .chat-panel, .touch-editor, .touch-top, .pomo-widget"))
		const hit = window.__noriHitTest
		if (typeof hit !== "function") return {err: "no __noriHitTest"}
		const solidAt = (x, y) => { const r = hit(x, y); return !!r && !r.err && r.hit }
		const solidEnough = (x, y) => {
			if (!solidAt(x, y)) return false
			const d = 8
			return solidAt(x - d, y) && solidAt(x + d, y) && solidAt(x, y - d) && solidAt(x, y + d)
		}
		let solid = null, blank = null, solidLow = null, scanned = 0
		for (let y = 60; y < window.innerHeight - 40 && !(solid && blank) && scanned < 1600; y += 14) {
			for (let x = 16; x < window.innerWidth - 16 && !(solid && blank) && scanned < 1600; x += 14) {
				if (onUI(document.elementFromPoint(x, y))) continue
				scanned += 1
				if (!solid && solidEnough(x, y)) { solid = {x, y}; continue }
				if (!blank && !solidAt(x, y)) blank = {x, y}
			}
		}
		for (let y = window.innerHeight - 40; y > 60 && !solidLow; y -= 14) {
			for (let x = 16; x < window.innerWidth - 16 && !solidLow; x += 14) {
				if (onUI(document.elementFromPoint(x, y))) continue
				if (solidEnough(x, y)) solidLow = {x, y}
			}
		}
		return {solid, blank, solidLow, scanned, err: null}
	})()`)
	check("能扫到实体命中点与留白点 (命中判定可用)", !!pts?.solid && !!pts?.blank, J(pts))
	const S = pts?.solid || {x: 260, y: 420}
	const B = pts?.blank || {x: 20, y: 60}

	check("抚摸前没有特效层", (await evalJs(fxInfo)).exists === false, J(await evalJs(fxInfo)))

	/* —— 实体命中: 按住应冒粒子 —— */
	await evalJs(press("pointerdown", S.x, S.y))
	await sleep(100)
	/* 粒子累计计数要在**碰到头的爆发(+260ms)之前**取基线, 所以和 early 探测合并成**一次** evalJs:
	   分两次调用时, CDP 往返会把采样点推过 260ms。 */
	const earlyBoth = await evalJs(`({fx: (${fxInfo}), sp: (${spawnedInfo})})`)
	const early = earlyBoth.fx
	const spawnedBefore = earlyBoth.sp
	check("刚按下(未到抚摸阈值 260ms)还没冒粒子", !early.exists || early.n === 0, J(early))
	const dbgDown = await evalJs(`(() => {
		const d = ${dbgInfo}
		return {dbg: d, hasCtor: typeof (window.AudioContext || window.webkitAudioContext) === "function"}
	})()`)
	check("按下即在手势里建起合成音图 (petAudioPrime 生效)", dbgDown.dbg?.ready === true,
		`ready=${dbgDown.dbg?.ready} AudioContext可用=${dbgDown.hasCtor}`)
	check("按下点被判为「头上」(头盒已算出)", dbgDown.dbg?.onHead === true, J(dbgDown.dbg))
	check("合成音音量取自 sfxVolume 且落在 [0,1]",
		typeof dbgDown.dbg?.volume === "number" && dbgDown.dbg.volume >= 0 && dbgDown.dbg.volume <= 1, J(dbgDown.dbg))

	/* 抚摸在 pointerdown 后 260ms 开始 -> 再等 200ms(共约 380ms) 抓"碰到头"的爆发 */
	await sleep(200)
	const burst = await evalJs(fxInfo)
	check("摸到头的瞬间有接触爆发 (火花 + 涟漪)", burst.stars >= 1 && burst.ripples >= 1, J(burst))
	const star = await evalJs(starInfo)
	check("火花也是软边径向渐变 (不是字形/硬边星形)", !!star && star.bg.includes("radial-gradient"), J(star))
	check("火花内没有文字字形", !!star && star.text === "", J(star))
	const rip = await evalJs(rippleInfo)
	check("涟漪是描边圆环 (内部透明, 不是实心圆)",
		!!rip && (rip.bg === "rgba(0, 0, 0, 0)" || rip.bg === "transparent"), J(rip))
	check("涟漪是圆的且有可见环宽", !!rip && rip.round === "50%" && rip.bw >= 1, J(rip))
	check("涟漪尺寸在合理区间 (>=12px)", !!rip && rip.size >= 12, J(rip))
	check("涟漪也 pointer-events = none", !!rip && rip.pe === "none", J(rip))

	await sleep(400)
	const after = await evalJs(fxInfo)
	check(`按在实体上(${S.x},${S.y})超过阈值后开始冒粒子`, after.exists && after.n > 0, J(after))
	check("抚摸中确实有柔光粒子那一层", after.motes >= 1, J(after))
	check("特效层 pointer-events = none (绝不挡触摸)", after.pe === "none", String(after.pe))
	check("粒子元素本身也 pointer-events = none", after.kidPe === "none", String(after.kidPe))
	check("特效层 z-index 在 canvas(1) 之上、UI(>=4) 之下", after.z === "3", String(after.z))
	check("粒子是绝对定位 (由动画驱动 transform)", after.kidPos === "absolute", String(after.kidPos))
	/* "柔和、不突兀" 是可验证的: 必须是**软边的径向渐变圆点**, 而不是字形/实心块。 */
	check("粒子是径向渐变的柔光 (不是字形/实心块)",
		typeof after.kidBg === "string" && after.kidBg.includes("radial-gradient"), String(after.kidBg))
	check("粒子是圆形 (border-radius 50%)", after.kidRadius === "50%", String(after.kidRadius))
	check("粒子内没有文字字形 (没有硬边图形)", after.kidText === "", J(after.kidText))
	check("柔光粒子尺寸克制 (10~20px)", after.kidSize >= 10 && after.kidSize <= 20, String(after.kidSize))
	check("按 class 取到的确实是柔光粒子层", after.kidKind === "mote", String(after.kidKind))

	/* 抚摸期间的状态（"低头"那套已删除；这里保留一条"补丁参数读回可用"的底线断言） */
	const dbgPress = await evalJs(dbgInfo)
	check("抚摸中判为头上 (门控生效)", dbgPress?.onHead === true, J({onHead: dbgPress?.onHead}))
	check("补丁参数读回可用 (__noriGetParam 生效, 眨眼也依赖它)",
		Number.isFinite(dbgPress?.eyeLOpen) && Number.isFinite(dbgPress?.angleY),
		`eyeLOpen=${dbgPress?.eyeLOpen} angleY=${dbgPress?.angleY}`)
	await sleep(400)
	await evalJs(dbgInfo)   // 再取一次快照（保持原来的采样节奏；低头计数那两条已随功能删除）

	/* 持续抚摸约 3s: 数量要有上限, 不能越摸越多 */
	let peak = 0
	for (let i = 0; i < 15; i += 1) {
		await evalJs(press("pointermove", S.x + (i % 5), S.y + (i % 3)))
		await sleep(200)
		peak = Math.max(peak, (await evalJs(fxInfo)).n)
	}
	check(`持续抚摸时存活数量封顶 (峰值 ${peak}, 上限 28)`, peak > 0 && peak <= 28, String(peak))

	/* 快速**横向**来回 -> 采样器应累计满 requiredMs 并完成至少一次(上面那轮每次只挪 1px/200ms, 速度不够) */
	for (let i = 0; i < 20; i += 1) {
		await evalJs(press("pointermove", S.x + (i % 2 ? 40 : -40), S.y))
		await sleep(60)
	}
	const dbgStroke = await evalJs(dbgInfo)
	check("快速横向抚摸累计完成至少一次 (满 1s 记一次)", (dbgStroke?.completions ?? 0) >= 1, J(dbgStroke))
	check("进度累计到封顶值 (1000ms)", dbgStroke?.progressMs === 1000, J(dbgStroke))
	check("速度是有限数 (采样器没被 NaN 污染)", Number.isFinite(dbgStroke?.velocity), J(dbgStroke))

	/* 完成一次 -> 奖励爆发。
	 * ⚠ 这里**不能**用"固定时刻的 DOM 快照"判定 (曾经这么写, 而且注释还写着"用累计计数"——
	 * 实现与注释不一致): 完成爆发的涟漪寿命只有 0.86~1.17s, 长抚摸跑完时它可能已经过期,
	 * 快照就只剩抚摸粒子 → 偶发假红 (实测 3 次里红 1 次: motes=6/ripples=0)。
	 * 真正的判据是下面的**累计生成计数** dRipple / dStar+dMote (不受寿命影响)。 */
	let peakTotal = Math.max(await evalJs(`(${fxInfo}).n`), 0)
	for (let i = 0; i < 10; i += 1) {
		await sleep(60)
		peakTotal = Math.max(peakTotal, (await evalJs(fxInfo)).n)
	}
	const spawnedAfter = await evalJs(spawnedInfo)
	const dRipple = (spawnedAfter?.ripple ?? 0) - (spawnedBefore?.ripple ?? 0)
	const dStar = (spawnedAfter?.star ?? 0) - (spawnedBefore?.star ?? 0)
	const dMote = (spawnedAfter?.mote ?? 0) - (spawnedBefore?.mote ?? 0)
	check(`涟漪数符合"接触 2 圈 + 完成 3 圈" (实际 +${dRipple}, 期望 >=4)`, dRipple >= 4, `dRipple=${dRipple}`)
	check(`火花数符合"接触 3 颗 + 完成 8 波" (实际 +${dStar + dMote}, 期望 >=9)`, dStar + dMote >= 9,
		`star=${dStar} mote=${dMote}`)
	check(`完成爆发期间存活数受上限约束 (DOM 峰值 ${peakTotal}, 上限 28)`, peakTotal <= 28, String(peakTotal))

	/* 松手 -> 残余粒子应自己飘完并移除 */
	await evalJs(press("pointerup", S.x, S.y))
	await sleep(2200)
	const afterUp = await evalJs(fxInfo)
	check("松手 2 秒后粒子全部移除 (不泄漏 DOM)", !afterUp.exists || afterUp.n === 0, J(afterUp))
	const dbgUp = await evalJs(dbgInfo)
	check("松手后采样器复位 (进度归零, 会话结束)", dbgUp?.progressMs === 0 && dbgUp?.active === false, J(dbgUp))
	check("松手后音效归零仍保持已建图 (没把图拆掉)", dbgUp?.ready === true, J(dbgUp))
	await sleep(300)
	await evalJs(dbgInfo)   // 原"松手后不再施加低头"两条已随功能删除；保留采样节奏

	/** 当场重扫一个**实心内部**的实体点 (姿势会变; 只判单点的话边缘点会偶发失效)。
	 *  fromExpr/toExpr 传页面里求值的表达式(字符串), 因为 Node 侧没有 window。 */
	const rescan = async (fromExpr, toExpr, step) => evalJs(`(() => {
		const onUI = (el) => !!(el && el.closest && el.closest(".sheet, .dock, .topbar, .pet-fab, .chat-panel, .touch-editor, .touch-top, .pomo-widget"))
		const hit = window.__noriHitTest
		const solidAt = (x, y) => { const r = hit(x, y); return !!r && !r.err && r.hit }
		const solidEnough = (x, y) => {
			if (!solidAt(x, y)) return false
			const d = 8
			return solidAt(x - d, y) && solidAt(x + d, y) && solidAt(x, y - d) && solidAt(x, y + d)
		}
		const from = ${fromExpr}, to = ${toExpr}, dir = from <= to ? 1 : -1
		for (let y = from; dir > 0 ? y <= to : y >= to; y += dir * ${step}) {
			for (let x = 16; x < window.innerWidth - 16; x += 10) {
				if (onUI(document.elementFromPoint(x, y))) continue
				if (solidEnough(x, y)) return {x, y}
			}
		}
		return null
	})()`)

	/* 脸/头发位置的实体点: 它在旧的头带线下方(以前判头外, 实机 bug), 但在新头区之内 */
	const facePt = await rescan(170, 240, 10)
	check("能扫到一个脸/头发区域的实体点", !!facePt, J(facePt))
	if (facePt) {
		const F = facePt
		await evalJs(press("pointerdown", F.x, F.y))
		await sleep(400)
		const faceDbg = await evalJs(dbgInfo)
		check(`按在脸/头发(${F.x},${F.y})判为「头上」`, faceDbg?.onHead === true,
			`onHead=${faceDbg?.onHead} onModel=${faceDbg?.onModel} modelY=${faceDbg?.modelY} geomOk=${faceDbg?.geomOk}`)
		await sleep(400)
		const faceFx = await evalJs(fxInfo)
		check("脸/头发上按住也会冒粒子", faceFx.exists && faceFx.n > 0, J(faceFx))
		await evalJs(press("pointerup", F.x, F.y))
		await sleep(2200)
	}

	/* 身体(命中实体但不在头区)必须没有抚摸反馈 */
	const bodyPt = await rescan("window.innerHeight - 40", 60, 14)
	check("能从下往上扫到一个身体实体点 (当场重扫)", !!bodyPt, J(bodyPt))
	if (bodyPt) {
		const L = bodyPt
		const beforeBody = await evalJs(dbgInfo)
		await evalJs(press("pointerdown", L.x, L.y))
		await sleep(400)
		const bodyDbg = await evalJs(dbgInfo)
		check(`按在身体(${L.x},${L.y})上判为「头外」`, bodyDbg?.onHead === false, J(bodyDbg))
		const bodyFx = await evalJs(fxInfo)
		check("按在身体上不冒粒子", !bodyFx.exists || bodyFx.n === 0, J(bodyFx))
		for (let i = 0; i < 20; i += 1) {
			await evalJs(press("pointermove", L.x + (i % 2 ? 30 : -30), L.y))
			await sleep(60)
		}
		const bodyDbg2 = await evalJs(dbgInfo)
		check("身体上快摸不累计进度 (采样器没启动)", bodyDbg2?.progressMs === 0, J(bodyDbg2))
		check("身体上快摸不算完成 (次数没增加)",
			(bodyDbg2?.completions ?? -1) === (beforeBody?.completions ?? -1),
			`${beforeBody?.completions} -> ${bodyDbg2?.completions}`)
		const bodyFx2 = await evalJs(fxInfo)
		check("身体上持续快摸仍不冒粒子", !bodyFx2.exists || bodyFx2.n === 0, J(bodyFx2))
		await evalJs(press("pointerup", L.x, L.y))
		await sleep(300)
	}

	/* —— 实时判定: 手指可以随时滑进/滑出头区 —— */
	const headPt2 = await rescan(60, 150, 8)
	const bodyPt2 = await rescan("window.innerHeight - 40", 60, 14)
	check("实时用例: 当场扫到头点与身体点", !!headPt2 && !!bodyPt2, `${J(headPt2)} / ${J(bodyPt2)}`)
	if (headPt2 && bodyPt2) {
		const glide = async (from, to) => {
			for (const t of [0.34, 0.67, 1]) {
				await evalJs(press("pointermove", Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t)))
				await sleep(160)   // updateNoriHead 节流 100ms, 分几步走给它更新的机会
			}
		}
		// A) 落在头上 -> 向下滑到身体: 必须转头外、进度归零、粒子停
		await evalJs(press("pointerdown", headPt2.x, headPt2.y))
		await sleep(420)
		const a1 = await evalJs(dbgInfo)
		const a1fx = await evalJs(fxInfo)
		check("A: 落在头上 -> 判「头上」且冒粒子", a1?.onHead === true && a1fx.n > 0, `onHead=${a1?.onHead} n=${a1fx.n}`)
		await glide(headPt2, bodyPt2)
		const a2 = await evalJs(dbgInfo)
		check("A: 滑到身体后转「头外」(原来会一直算头上)",
			a2?.onHead === false, J({onHead: a2?.onHead, y: a2?.modelY, line: a2?.bandLine}))
		check("A: 滑出后采样进度归零", a2?.progressMs === 0, String(a2?.progressMs))
		await sleep(2000)
		const a2fx = await evalJs(fxInfo)
		check("A: 滑出后粒子停止 (残余飘完归零)", !a2fx.exists || a2fx.n === 0, J(a2fx))
		await evalJs(press("pointerup", bodyPt2.x, bodyPt2.y))
		await sleep(300)

		// B) 落在身体 -> 向上滑到头: 必须转头上并开始冒粒子
		await evalJs(press("pointerdown", bodyPt2.x, bodyPt2.y))
		await sleep(420)
		const b1 = await evalJs(dbgInfo)
		const b1fx = await evalJs(fxInfo)
		check("B: 落在身体上 -> 判「头外」且不冒粒子",
			b1?.onHead === false && (!b1fx.exists || b1fx.n === 0), `onHead=${b1?.onHead} n=${b1fx.n}`)
		await glide(bodyPt2, headPt2)
		const b2 = await evalJs(dbgInfo)
		check("B: 滑到头后转「头上」(原来怎么移都不算)",
			b2?.onHead === true, J({onHead: b2?.onHead, y: b2?.modelY, line: b2?.bandLine}))
		await sleep(420)
		const b2fx = await evalJs(fxInfo)
		check("B: 滑到头后开始冒粒子", b2fx.n > 0, J(b2fx))
		await evalJs(press("pointerup", headPt2.x, headPt2.y))
		await sleep(2200)

		/* C) **移出边界**: 摸上头之后把手指挪到模型**外面**(上方空白/左右空白) 必须很快转头外。
		   实机反馈: 之前留驻只判 y 一条线 -> 往上挪进空白区仍算"摸头", 一直拖到抬手才取消。 */
		for (const [tag, far] of [["上方", {x: headPt2.x, y: 8}], ["左侧", {x: 4, y: headPt2.y}]]) {
			await evalJs(press("pointerdown", headPt2.x, headPt2.y))
			await sleep(420)
			const c1 = await evalJs(dbgInfo)
			check(`C(${tag}): 先摸上头 -> 判「头上」`, c1?.onHead === true, J({onHead: c1?.onHead, y: c1?.modelY}))
			await evalJs(press("pointermove", far.x, far.y))
			await sleep(300)   // 只等 300ms (节流 100ms), 远超就该已取消
			const c2 = await evalJs(dbgInfo)
			check(`C(${tag}): 挪到模型外(空白)后必须很快转「头外」(不能拖到抬手)`,
				c2?.onHead === false, J({onHead: c2?.onHead, y: c2?.modelY, line: c2?.bandLine}))
			check(`C(${tag}): 转头外后采样进度归零`, c2?.progressMs === 0, String(c2?.progressMs))
			await evalJs(press("pointerup", far.x, far.y))
			await sleep(300)
		}
		/* D) 摸头表情：摸到头 → 播 **shy/smile 二选一**；持续摸不换脸；停手 1 秒后**平滑**收回。
		 *
		 *  "真的生效"不看我们自己的变量（那是自证），而是读**各表情独占的参数**：
		 *      04_Shy   → `ParamCheek = 1`（别的表情不设它）
		 *      07_Smile → `ParamEyeSmile = 1`
		 *      13_Happy → `ParamEyeLSmile = 1` ← 旧实现恒用它，所以这组断言也守"退回 happy"的回归
		 *  逐个帧的宽限/收回边界由门禁 `run-pet-expression-tests.mjs` 用可注入时钟精确断言（47 条），
		 *  这里只验**接线**（摸头才播、真生效、持续不换、停手收回）。 */
		const headPt3 = await rescan(170, 240, 10)
		const bodyPt3 = await rescan("window.innerHeight - 40", 60, 14)
		const exprNow = async () => {
			const d = await evalJs(dbgInfo)
			return {name: d?.petExpression ?? null, on: d?.petExpressionOn ?? null,
				cheek: d?.petExprCheek ?? null, eyeSmile: d?.petExprEyeSmile ?? null}
		}
		check("D: 扫到摸头/摸身体两个实心点", !!headPt3 && !!bodyPt3, `${J(headPt3)} / ${J(bodyPt3)}`)
		if (headPt3 && bodyPt3) {
			// 规格 4: 只有摸头才播
			await evalJs(press("pointerdown", bodyPt3.x, bodyPt3.y))
			await sleep(900)
			const onBody = await exprNow()
			await evalJs(press("pointerup", bodyPt3.x, bodyPt3.y))
			await sleep(1700)
			check("D: 摸**身体**不播表情（只有摸头才播）", onBody.on === false && onBody.name === null, J(onBody))

			// 摸头: 播 shy/smile 之一
			await evalJs(press("pointerdown", headPt3.x, headPt3.y))
			await sleep(700)
			const e1 = await exprNow()
			await sleep(1200)
			const e2 = await exprNow()
			console.log(`   [D] 摸头: ${J(e1)}`)
			console.log(`   [D] 持续 1.2s 后: name=${e2.name} on=${e2.on}`)
			check("D: 摸头播的是 shy/smile 之一", ["04_Shy", "07_Smile"].includes(e1.name ?? ""), J(e1))
			check("D: **不再**是旧的 13_Happy", e1.name !== "13_Happy", String(e1.name))
			check("D: 持续摸头期间**同一张脸**（不换）", e2.name === e1.name && e2.on === true, `${e1.name} → ${e2.name}`)
			const evid = e1.name === "04_Shy" ? (e1.cheek ?? 0) > 0.5 : (e1.eyeSmile ?? 0) > 0.5
			check(`D: 表情**真的生效**（${e1.name} 的独占参数已写入）`, evid,
				`cheek=${e1.cheek} eyeSmile=${e1.eyeSmile}`)
			check("D: 另一张脸的独占参数没被写（没有串脸）",
				e1.name === "04_Shy" ? Math.abs(e1.eyeSmile ?? 1) < 0.2 : Math.abs(e1.cheek ?? 1) < 0.2, J(e1))
			// 注: 不再单独断言"没退回 happy" —— 旧 happy 的独占参数 `ParamEyeLSmile` 在 ARGNori 里
			// **不存在**（它引用了一堆不存在的 ParamBrowL*），所以测不了；而上面那条 evid 断言
			// 已经覆盖它：happy 既不设 ParamCheek 也不设 ParamEyeSmile，真退回 happy 时 evid 必红。

			// 抬手: 1 秒宽限内不收, 超时收回（收回是 0.5s 淡出）
			await evalJs(press("pointerup", headPt3.x, headPt3.y))
			await sleep(500)
			const inGrace = await exprNow()
			await sleep(1500)
			const afterGrace = await exprNow()
			console.log(`   [D] 抬手 0.5s: on=${inGrace.on} name=${inGrace.name} / 2s: on=${afterGrace.on} name=${afterGrace.name}`)
			check("D: 抬手 0.5s 内仍在展示（1 秒宽限）", inGrace.on === true && inGrace.name === e1.name, J(inGrace))
			check("D: 停手超过 1 秒后收回", afterGrace.on === false && afterGrace.name === null, J(afterGrace))
			check("D: 收回后独占参数也回落（0.5s 淡出，不是硬切）",
				(e1.name === "04_Shy" ? Math.abs(afterGrace.cheek ?? 1) : Math.abs(afterGrace.eyeSmile ?? 1)) < 0.5, J(afterGrace))
		}
	}

	/* 留白: 按住**不该**冒粒子 */
	await sleep(2000)   // 等上面残留的粒子散掉
	await evalJs(press("pointerdown", B.x, B.y))
	await sleep(900)
	const blankA = await evalJs(fxInfo)
	check(`按在留白(${B.x},${B.y})不冒粒子`, !blankA.exists || blankA.n === 0, J(blankA))
	await evalJs(press("pointermove", B.x + 2, B.y + 2))
	await sleep(700)
	const blankB = await evalJs(fxInfo)
	check("留白处持续按住仍不冒粒子", !blankB.exists || blankB.n === 0, J(blankB))
	await evalJs(press("pointerup", B.x, B.y))
	await sleep(400)

	/* 反证: 上一条有两种可能 —— (a) 门控生效; (b) 那个点压根没进入抚摸流程(比如 pointerdown 被吞了)。
	   所以把**同一个点**强行判成"命中实体", 粒子必须出现。 */
	await evalJs(`window.__noriPetFxOrigHit = window.__noriHitTest; window.__noriHitTest = () => ({hit: true})`)
	await evalJs(press("pointerdown", B.x, B.y))
	await sleep(900)
	const forced = await evalJs(fxInfo)
	check("反证: 同一点被判为实体后立刻冒粒子 (证明留白不冒是门控生效, 而非该点被忽略)",
		forced.exists && forced.n > 0, J(forced))
	await evalJs(press("pointerup", B.x, B.y))
	await evalJs(`if (window.__noriPetFxOrigHit) { window.__noriHitTest = window.__noriPetFxOrigHit; delete window.__noriPetFxOrigHit }`)
} catch (e) {
	check("执行过程未抛异常", false, String(e?.message ?? e))
} finally {
	const failed = results.filter((r) => !r.cond)
	const isKnown = (r) => KNOWN_FAILS.some((k) => r.name.includes(k.match))
	const known = failed.filter(isKnown)
	const unknown = failed.filter((r) => !isKnown(r))
	const stale = KNOWN_FAILS.filter((k) => !results.some((r) => r.name.includes(k.match) && !r.cond))
	const passed = results.length - failed.length
	console.log(`\n${passed}/${results.length} passed` + (known.length ? `  （含 ${known.length} 条白名单内的已知失败）` : ""))
	if (known.length) {
		console.log("已知失败（预期内，不算回归）:")
		for (const k of KNOWN_FAILS) console.log(`  · ${k.match}\n    └ ${k.why}`)
	}
	if (unknown.length) {
		console.log(`❗未知失败 ${unknown.length} 条（**这才是回归**）:`)
		for (const r of unknown) console.log(`  · ${r.name}`)
	}
	if (stale.length) {
		console.log(`⚠ 白名单已过期: ${stale.map((k) => k.match).join(" / ")} 现在**通过**了 —— 请从 KNOWN_FAILS 里删掉该条目`)
	}
	if (unknown.length || stale.length) process.exitCode = 1
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
