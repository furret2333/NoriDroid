/* 摸头"低头"诊断 —— **参数 → 几何位移探针**（只读诊断，不改产品代码）
 *
 * ⚠ 本探针对应的功能（摸头"低头"）**已被用户永久删除**（2026-09-24，原因是"头部角度跳变"）。
 *   探针本身仍然可用（只依赖补丁钩子），留着是为了"以后想捡回来时不用重写"；
 *   全部实测数据见 docs/低头参数探针.md，历史实现见 backups\低头重做与参数归属护栏-20260924-232222\。
 *
 * 要回答的问题（交接文档 §4 的唯一未解决项）：
 *   参数确实写进了真参数（下标 15、值 8.87 → -6.42），注入点也在 `this._model.update()` 之前，
 *   **但画出来的几何几乎不动**（E2E 用例 D 的 Δ = -0.0036 模型单位，阈值 0.02）。
 *   推测：这份 rig 里 `ParamAngleY` 不是（唯一）驱动头部俯仰的杠杆。**这条必须实测。**
 *
 * 做法：
 *   ① 先量**噪声**（待机动作/呼吸会让包围盒自己抖）—— 不看噪声就没法判"动了没有"
 *   ② 阳性对照：给已知有效的杠杆加值，证明**尺子是准的**
 *   ③ 全参数扫描：逐个参数按 span/2 往两个方向各推一次，量模型盒 / 头并集 / Part3 / Part61 / 各部件
 *   ④ 汇总：按 |ΔheadTop| 与"最大部件位移"排序，并单列"让头部下沉"的候选
 *   ⑤ 对头部候选再用**满量程** span 推一次（看这份 rig 到底能把头压低多少）
 *
 * 参数名单来源：模型自带的 `<id>.cdi3.json`（147 个，与运行时 `getParameterCount()` 交叉校验）。
 *   ※ 不用 `__noriPartProbe().params` —— 实测它回来是空的（原因未查明），而 cdi3 同样是权威来源。
 *
 * 写入时机用补丁钩子 `__noriBeforeModelUpdate`（顶点计算之前）—— 加在之后顶点已定死，看不见。
 * 钩子做**链式包装**：不覆盖 App 已装的 petBow，只在其后再加一层。
 *
 * 运行: node tmp-memcheck/probe-bow-params.mjs [模型名]   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync, readFileSync, existsSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const MODEL = process.argv[2] || "ARGNori"
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const MODELS_DIR = "D:/norios/models"
const PORT = 9402
const NOISE_SAMPLES = 20
const NOISE_MS = 110
const APPLY_MS = 320
const CLEAR_MS = 170

/* ---- 参数名单：优先本地 cdi3.json（平铺 / 双层两种布局都试） ---- */
const paramNames = (() => {
	const cands = [join(MODELS_DIR, MODEL, `${MODEL}.cdi3.json`), join(MODELS_DIR, MODEL, MODEL, `${MODEL}.cdi3.json`)]
	for (const p of cands) {
		if (!existsSync(p)) continue
		try {
			const j = JSON.parse(readFileSync(p, "utf8"))
			const ids = (j.Parameters || []).map((x) => x.Id).filter((x) => typeof x === "string" && x)
			if (ids.length) return {ids, from: p}
		} catch { /* 换下一个 */ }
	}
	return {ids: [], from: null}
})()

const profile = mkdtempSync(join(tmpdir(), "nori-bow-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,900", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fx = (n) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(4) : String(n))

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
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

/** 页内辅助：一次装好。IIFE 包裹 —— 重复求值不会因 const 重复声明而抛错。
 *  挂"顶点之前"的消费者走 `__noriRegisterBeforeUpdate`（槽位不可写，直接赋值会抛错）。 */
const HELPERS = `(() => {
  window.__pbMetric = () => {
    const P = window.__noriPartProbe ? window.__noriPartProbe() : null
    if (!P || !P.ok) return {err: (P && P.err) || "no __noriPartProbe"}
    const names = P.names || [], parts = P.parts || []
    const byName = (nm) => { const i = names.indexOf(nm); if (i < 0) return null; const p = parts.find((x) => x.i === i); return p ? p.box : null }
    let headU = null, headN = 0
    for (const p of parts) {
      if (p.box.bottom > 0.40) { headN += 1
        if (!headU) headU = {left: p.box.left, right: p.box.right, top: p.box.top, bottom: p.box.bottom}
        else { headU.left = Math.min(headU.left, p.box.left); headU.right = Math.max(headU.right, p.box.right)
               headU.top = Math.max(headU.top, p.box.top); headU.bottom = Math.min(headU.bottom, p.box.bottom) } } }
    return {all: P.allBox, headU, headN, p3: byName("Part3"), p61: byName("Part61"), names,
            parts: parts.map((p) => ({i: p.i, box: p.box}))}
  }
  window.__pbSnap = () => window.__pbMetric()
  window.__pbSet = (id, v) => { window.__probeAdd = (id == null ? null : {id, v}); window.__pbApplied = 0 }
  window.__pbApplied = 0
  const hook = () => {
    const a = window.__probeAdd
    if (a && typeof window.__noriAddParam === "function") { window.__noriAddParam(a.id, a.v); window.__pbApplied += 1 } }
  // 正规入口（槽位不可写, 直接赋值会抛错）；老产物没有它就退回链式包装
  if (typeof window.__noriRegisterBeforeUpdate === "function") window.__noriRegisterBeforeUpdate(hook)
  else { const prev = window.__noriBeforeModelUpdate; window.__noriBeforeModelUpdate = () => { try { if (typeof prev === "function") prev() } catch (e) {} hook() } }
  return "helpers-ok"
})()`

const hull = (box) => (box ? {left: +box.left.toFixed(4), right: +box.right.toFixed(4), top: +box.top.toFixed(4), bottom: +box.bottom.toFixed(4)} : null)

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

	/* ---- 挂模型 ---- */
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
	await sleep(800)
	console.log(`模型加载: ${card}`)
	if (card === "NO_CARD") throw new Error("卡没找到 —— harness 没在跑? 或模型面板没打开")

	const ok = await evalJs(HELPERS)
	if (ok !== "helpers-ok") throw new Error("页内辅助装载失败: " + ok)
	for (const h of ["__noriPartProbe", "__noriParamInfo", "__noriParamIndexOf", "__noriAddParam", "__noriGetParam"]) {
		const t = await evalJs(`typeof window.${h}`)
		if (t !== "function") throw new Error(`钩子缺失: ${h} (${t}) —— 补丁没打进产物?`)
	}
	console.log("钩子齐备: __noriPartProbe / __noriParamInfo / __noriParamIndexOf / __noriAddParam / __noriGetParam")
	console.log("钩子链式包装: __noriBeforeModelUpdate 已接上（不覆盖 App 的 petBow）")

	/* 顺手记一笔：__noriPartProbe().params 为什么空（不改判定，只留证据） */
	const diag = await evalJs(`(() => { const P = window.__noriPartProbe(); return {paramsType: typeof P.params, paramsIsNull: P.params === null, paramsLen: P.params ? P.params.length : -1, countViaInfo: (window.__noriParamInfo("ParamAngleX") || {}).count} })()`)
	console.log(`诊断: __noriPartProbe().params = ${diag.paramsType}${diag.paramsIsNull ? "(null)" : ""} 长度 ${diag.paramsLen}；运行时参数总数 ${diag.countViaInfo}`)

	const base0 = await evalJs("window.__pbSnap()")
	const partName = (i) => (base0.names && base0.names[i]) || `#${i}`
	console.log(`\n模型: 部件 ${base0.parts.length} / 部件名 ${(base0.names || []).length} / E2E 视作"头顶"的 Part3 = ${partName(base0.names ? base0.names.indexOf("Part3") : -1)}`)
	console.log(`模型盒 allBox: ${JSON.stringify(hull(base0.all))}  高=${fx(base0.all.top - base0.all.bottom)}`)
	console.log(`头锚点 Part3 : ${JSON.stringify(hull(base0.p3))}`)
	console.log(`头锚点 Part61: ${JSON.stringify(hull(base0.p61))}`)
	console.log(`「头」并集(bottom>0.40 的部件): ${JSON.stringify(hull(base0.headU))}  (${base0.headN} 个部件)`)

	/* 参数名单 + 运行时交叉校验 */
	if (!paramNames.ids.length) throw new Error(`读不到参数名单（找过 ${MODELS_DIR}\\${MODEL}\\${MODEL}.cdi3.json）`)
	console.log(`\n参数名单: ${paramNames.ids.length} 个，来自 ${paramNames.from}`)
	if (diag.countViaInfo && diag.countViaInfo !== paramNames.ids.length) console.log(`   ⚠ cdi3 数量(${paramNames.ids.length}) ≠ 运行时 getParameterCount()(${diag.countViaInfo})`)
	const infos = await evalJs(`(() => { const out = {}; for (const n of ${JSON.stringify(paramNames.ids)}) { const i = window.__noriParamInfo(n); if (i) out[n] = i } return out })()`)
	const missing = paramNames.ids.filter((n) => !infos[n])
	console.log(`   运行时能查到 ${Object.keys(infos).length} 个${missing.length ? `；查不到 ${missing.length} 个: ${missing.slice(0, 12).join(", ")}` : "（全部命中）"}`)

	/* ---- ① 噪声 ---- */
	const track = (s) => ({allTop: s.all.top, allBottom: s.all.bottom, headTop: s.headU ? s.headU.top : NaN, headBottom: s.headU ? s.headU.bottom : NaN, p61Top: s.p61 ? s.p61.top : NaN})
	const samples = []
	for (let i = 0; i < NOISE_SAMPLES; i += 1) { samples.push(track(await evalJs("window.__pbSnap()"))); await sleep(NOISE_MS) }
	const noise = {}
	for (const k of Object.keys(samples[0])) {
		const vs = samples.map((s) => s[k]).filter((v) => Number.isFinite(v))
		noise[k] = vs.length ? Math.max(...vs) - Math.min(...vs) : 0
	}
	console.log(`\n① 噪声（${NOISE_SAMPLES} 次采样 / ${(NOISE_SAMPLES * NOISE_MS / 1000).toFixed(1)}s，不推任何参数）:`)
	for (const k of Object.keys(noise)) console.log(`   ${k.padEnd(11)} 抖动范围 = ${fx(noise[k])}`)
	const NOISE = Math.max(noise.allTop, noise.headTop, 0.002)
	console.log(`   ⇒ 判「真的动了」的门槛取 ${fx(NOISE)}（= 噪声里的最大项，且不低于 0.002）`)

	/* ---- 测量原语 ---- */
	const measure = async (nm, v) => {
		await evalJs(`window.__pbSet(${JSON.stringify(nm)}, ${v})`)
		await sleep(APPLY_MS)
		const s = await evalJs("window.__pbSnap()")
		const applied = await evalJs("window.__pbApplied")
		const readBack = await evalJs(`window.__noriGetParam(${JSON.stringify(nm)})`)
		await evalJs("window.__pbSet(null, 0)")
		await sleep(CLEAR_MS)
		return {s, applied, readBack}
	}
	const baseMap = new Map(base0.parts.map((p) => [p.i, p.box]))
	const baseRel = base0.headU && base0.all ? base0.headU.top - base0.all.bottom : NaN
	const diff = (s) => {
		let maxDisp = 0, maxIdx = null
		for (const p of s.parts) {
			const b = baseMap.get(p.i); if (!b) continue
			const d = Math.abs(p.box.left - b.left) + Math.abs(p.box.top - b.top) + Math.abs(p.box.right - b.right) + Math.abs(p.box.bottom - b.bottom)
			if (d > maxDisp) { maxDisp = d; maxIdx = p.i }
		}
		const rel = s.headU && s.all ? s.headU.top - s.all.bottom : NaN
		return {
			dAllTop: s.all.top - base0.all.top, dAllBottom: s.all.bottom - base0.all.bottom,
			dHeadTop: s.headU ? s.headU.top - base0.headU.top : NaN,
			dHeadBottom: s.headU ? s.headU.bottom - base0.headU.bottom : NaN,
			dP3Top: s.p3 && base0.p3 ? s.p3.top - base0.p3.top : NaN,
			dP61Top: s.p61 && base0.p61 ? s.p61.top - base0.p61.top : NaN,
			/** 与 E2E 用例 D 同口径：头顶相对脚底的下沉量 */
			dRelHeadFoot: rel - baseRel,
			maxDisp, maxIdx,
		}
	}
	const line = (nm, i, v, rb, ap, d) => `   ${nm.padEnd(24)} i=${String(i).padStart(3)} 推=${fx(v).padStart(8)} 读回=${fx(rb).padStart(8)} 施加${String(ap).padStart(2)}帧` +
		` | ΔheadTop=${fx(d.dHeadTop)} Δrel(头-脚)=${fx(d.dRelHeadFoot)} ΔallTop=${fx(d.dAllTop)} Δp61Top=${fx(d.dP61Top)} 最大部件位移=${fx(d.maxDisp)}@${partName(d.maxIdx)}`

	const rows = []
	const runOne = async (nm, v) => {
		const t = await measure(nm, v)
		const d = diff(t.s)
		const row = {nm, i: infos[nm]?.i, min: infos[nm]?.min, max: infos[nm]?.max, v, readBack: t.readBack, applied: t.applied, ...d}
		row.score = Math.max(Math.abs(d.dHeadTop), Math.abs(d.dRelHeadFoot), Math.abs(d.dP61Top), Math.abs(d.dAllTop))
		rows.push(row)
		return row
	}

	/* ---- ② 阳性对照 ---- */
	console.log("\n② 阳性对照（已知有效的杠杆，用来证明「尺子」准）:")
	for (const nm of ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleY", "ParamEyeBallY", "ParamMouthOpenY"]) {
		if (!infos[nm]) { console.log(`   ${nm.padEnd(24)} —— 运行时查不到该参数`); continue }
		const {min, max, i} = infos[nm]
		const span = max - min
		const v = span > 0 ? span / 2 : 25
		for (const sign of [1, -1]) {
			const r = await runOne(nm, v * sign)
			console.log(line(nm, i, r.v, r.readBack, r.applied, r))
		}
	}

	/* ---- ③ 全参数扫描 ---- */
	console.log(`\n③ 全参数扫描（${paramNames.ids.length} 个参数 × 两侧 span/2；只打印超过门槛的行）:`)
	const t0 = Date.now()
	let done = 0
	for (const nm of paramNames.ids) {
		const info = infos[nm]
		done += 1
		if (!info) continue
		const span = info.max - info.min
		if (!Number.isFinite(span) || span <= 1e-9) continue
		for (const sign of [1, -1]) {
			const r = await runOne(nm, (span / 2) * sign)
			if (r.score > NOISE) console.log(line(nm, info.i, r.v, r.readBack, r.applied, r))
		}
		if (done % 25 === 0) console.log(`   … 进度 ${done}/${paramNames.ids.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
	}

	/* ---- ④ 汇总 ---- */
	const byHead = [...rows].sort((a, b) => Math.abs(b.dHeadTop) - Math.abs(a.dHeadTop))
	const byDisp = [...rows].sort((a, b) => b.maxDisp - a.maxDisp)
	const head4 = (r) => `   ${r.nm.padEnd(24)} i=${String(r.i).padStart(3)} [${r.min},${r.max}] 推=${fx(r.v).padStart(8)} 读回=${fx(r.readBack).padStart(8)}` +
		` | ΔheadTop=${fx(r.dHeadTop)} ΔheadBot=${fx(r.dHeadBottom)} Δrel(头-脚)=${fx(r.dRelHeadFoot)} 最大部件位移=${fx(r.maxDisp)}@${partName(r.maxIdx)}`
	console.log(`\n④ 汇总 A：按 |ΔheadTop|（头顶绝对高度变化）排序 top 20 —— 共 ${rows.length} 次施加`)
	for (const r of byHead.slice(0, 20)) console.log(head4(r))
	console.log(`\n④ 汇总 B：按「单部件最大位移」排序 top 20（谁在真正带动几何）`)
	for (const r of byDisp.slice(0, 20)) console.log(head4(r))
	const down = rows.filter((r) => Number.isFinite(r.dHeadTop) && r.dHeadTop < -NOISE).sort((a, b) => a.dHeadTop - b.dHeadTop)
	console.log(`\n④ 汇总 C：「把头压下去」（ΔheadTop < -${fx(NOISE)}）共 ${down.length} 条，top 20:`)
	for (const r of down.slice(0, 20)) console.log(head4(r))

	/* ---- ⑤ 满量程复核：头部 top 候选到底能把头压低多少 ---- */
	const cand = [...new Set([...byHead.slice(0, 8).map((r) => r.nm), ...down.slice(0, 8).map((r) => r.nm), "ParamAngleY"])]
	console.log(`\n⑤ 满量程复核（对 ${cand.length} 个候选推 ±span，看这份 rig 的极限）:`)
	for (const nm of cand) {
		const info = infos[nm]; if (!info) continue
		const span = info.max - info.min
		for (const sign of [1, -1]) {
			const r = await runOne(nm, span * sign)
			console.log(line(nm, info.i, r.v, r.readBack, r.applied, r))
		}
	}

	console.log(`\n判读提示：候选应同时满足 —— ① ΔheadTop / Δrel(头-脚) 明显为负且量级 ≥ 0.02（E2E 阈值）`)
	console.log(`          ② 读回值证明参数真被写进 ③ 最大位移部件落在头部部件上（不是马尾/袖摆）`)
} catch (e) {
	console.log(`!! 执行异常: ${e?.message ?? e}`)
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(300)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
