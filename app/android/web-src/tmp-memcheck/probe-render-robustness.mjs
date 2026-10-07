/* 探针: 渲染层架构可靠性 (报告型, 永不失败)
 *
 * 三条此前"只在代码里推断、没人实测"的事, 这里各给一个可复现的判据:
 *
 *   ① 模型纹理的**真实尺寸与张数** —— 报告里唯一标【待实测】的硬数字。
 *      做法: 在页面脚本跑之前 hook `WebGL2RenderingContext.texImage2D`, 记下每次上传的宽高
 *      与 generateMipmap 次数。可以直接算出解码显存 (w*h*4, 含 mipmap 再 ×4/3)。
 *
 *   ② 主界面 GPU 上下文丢失后**能不能自己回来**。
 *      关键机制: 浏览器只有在 `webglcontextlost` 被 `preventDefault()` 时才会恢复上下文。
 *      本项目全库搜 webglcontextlost/restored 只有 4 处, **全在 FloatApp.vue**;
 *      主界面 App.vue 零处 ⇒ 预期"永久丢失"。这里实测验证。
 *
 *   ③ 悬浮窗 `__noriRefresh()` **并发重入**会不会叠出两套画布/两条渲染循环。
 *      审计报告记过这个风险 (mountModel 重挂前没 destroy, 已补 destroy; 但并发守卫仍缺)。
 *      判据: 连调两次后数 canvas 数量, 并比 "出帧数 vs rAF 帧数" —— 两条循环都在 tick 的话
 *      `__noriL2dDraws` 会涨得比 rAF 帧数还快。
 *
 * 运行: node tmp-memcheck/probe-render-robustness.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const CDP_PORT = 9415
const HARNESS = "http://127.0.0.1:8123"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seedUrl = (o) => `${HARNESS}/assets/web/index.html?seed=${Buffer.from(JSON.stringify(o)).toString("base64url")}`

let ws, id = 0
const pending = new Map()
const send = (method, params = {}, sessionId) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sessionId ? {sessionId} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 30000)
	})
}
async function wsUrl(port) {
	for (let i = 0; i < 60; i += 1) {
		try {
			const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
			if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl
		} catch { /* 未就绪 */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

let sessionId, evalJs
/** 在**页面任何脚本之前**注入: 记录纹理上传尺寸 + mipmap 次数
 *  ⚠ 解析 texImage2D 必须按**参数个数**分重载, 不能只看"第3、4个是不是数字":
 *    6 参形式 `texImage2D(target, level, internalformat, format, type, source)`
 *      第3参是 internalformat(gl.RGBA=6408), 第4参是 type(gl.UNSIGNED_BYTE=5121) ——
 *      曾经就因此把 3 张纹理记成 "6408x5121", 凭空多出 375MB 的假显存。别再用那个判法。
 *    9 参形式 `texImage2D(target, level, internalformat, width, height, border, format, type, pixels)`
 *      第3、4参才是真正的宽高(裁剪遮罩缓冲走的是这条, 256x256)。 */
const TEX_HOOK = `(() => {
	window.__texLog = []; window.__mipCount = 0;
	const hookProto = (P) => {
		if (!P || !P.prototype) return;
		const ti = P.prototype.texImage2D;
		if (ti) P.prototype.texImage2D = function (...a) {
			try {
				if (a.length >= 9) {
					window.__texLog.push([a[3], a[4], "dims"]);
				} else if (a[5] && typeof a[5] === "object" && a[5].width) {
					window.__texLog.push([a[5].width, a[5].height, a[5].constructor && a[5].constructor.name]);
				}
			} catch (_) {}
			return ti.apply(this, a);
		};
		const gm = P.prototype.generateMipmap;
		if (gm) P.prototype.generateMipmap = function (...a) { window.__mipCount++; return gm.apply(this, a); };
	};
	hookProto(window.WebGL2RenderingContext);
	hookProto(window.WebGLRenderingContext);
})()`

const waitModel = async (limitMs) => {
	const t0 = Date.now()
	let poked = false
	while (Date.now() - t0 < limitMs) {
		if (await evalJs(`(window.__noriL2dDraws||0) > 0`)) return true
		if (!poked && Date.now() - t0 > 6000) {
			poked = true
			try {
				await evalJs(`[...document.querySelectorAll(".fab")].find(x => /模型/.test(x.textContent))?.click()`)
				await sleep(1200)
				await evalJs(`(() => { const c=[...document.querySelectorAll(".mc")].find(x=>x.textContent.includes("ARGNori")); if(c) c.click() })()`)
				await sleep(4000)
			} catch { /* 忽略 */ }
		}
		await sleep(500)
	}
	return false
}

const draws = () => evalJs(`(window.__noriL2dDraws||0)`)

console.log("探针: 渲染层架构可靠性")
try {
	const up = await fetch(`${HARNESS}/assets/web/index.html`, {signal: AbortSignal.timeout(1500)}).then(() => true).catch(() => false)
	if (!up) {
		console.log("!! harness 不在 8123。先跑: 双击 app/android/打开测试服务器.bat  (或 node .harness/server.mjs)")
		process.exit(0)
	}
	const profile = mkdtempSync(join(tmpdir(), "nori-rb-"))
	const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--window-size=520,900",
		"--force-device-scale-factor=3", "about:blank"], {stdio: "ignore"})
	try {
		ws = new WebSocket(await wsUrl(CDP_PORT))
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
		ws.onmessage = (ev) => {
			const m = JSON.parse(ev.data)
			if (m.id && pending.has(m.id)) {
				const p = pending.get(m.id)
				pending.delete(m.id)
				m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
			}
		}
		const {targetId} = await send("Target.createTarget", {url: "about:blank"})
		;({sessionId} = await send("Target.attachToTarget", {targetId, flatten: true}))
		await send("Runtime.enable", {}, sessionId)
		await send("Page.enable", {}, sessionId)
		evalJs = async (expr) => {
			const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, sessionId)
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
			return r.result.value
		}
		// 纹理钩子必须在导航之前注入
		await send("Page.addScriptToEvaluateOnNewDocument", {source: TEX_HOOK}, sessionId)

		/* ======== ① 纹理真实尺寸/张数 (主界面) ======== */
		console.log("\n① 模型纹理的真实尺寸与张数")
		await send("Page.navigate", {url: seedUrl({renderScale: 3, dataseaBg: true, l2dFps: 0})}, sessionId)
		await sleep(3000)
		const loaded = await waitModel(26000)
		const tex = await evalJs(`({log: window.__texLog, mip: window.__mipCount})`)
		const counts = new Map()
		for (const t of tex.log || []) {
			const k = `${t[0]}x${t[1]}`
			counts.set(k, (counts.get(k) || 0) + 1)
		}
		console.log(`   模型已加载=${loaded}   纹理上传次数=${(tex.log || []).length}   generateMipmap 次数=${tex.mip}`)
		for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
			const [w, h] = k.split("x").map(Number)
			const mb = (w * h * 4) / 1048576
			console.log(`   ${k.padEnd(12)} ×${String(n).padStart(2)}   单张解码 ${mb.toFixed(1)} MB   合计 ${(mb * n).toFixed(1)} MB   含 mipmap ${(mb * n * 4 / 3).toFixed(1)} MB`)
		}
		const big = [...counts.entries()].filter(([k]) => { const [w] = k.split("x").map(Number); return w >= 4096 })
		if (big.length) {
			const total = [...counts.entries()].reduce((s, [k, n]) => { const [w, h] = k.split("x").map(Number); return s + (w * h * 4 / 1048576) * n }, 0)
			console.log(`   ★ 存在 4096 级纹理 ⇒ 全部纹理解码合计约 ${total.toFixed(0)} MB, 含 mipmap 约 ${(total * 4 / 3).toFixed(0)} MB`)
		} else if ((tex.log || []).length) {
			console.log(`   (未发现 4096 级纹理)`)
		}

		/* ======== ② 主界面 GPU 上下文丢失后能否恢复 ======== */
		console.log("\n② 主界面 GPU 上下文丢失 → 能否恢复")
		const armed = await evalJs(`(() => {
			const cv = [...document.querySelectorAll("canvas")].find(c => !c.classList.contains("datasea-bg"));
			if (!cv) return {ok: false, why: "找不到 Live2D 画布"};
			const gl = cv.getContext("webgl2") || cv.getContext("webgl");
			if (!gl) return {ok: false, why: "拿不到 gl"};
			const ext = gl.getExtension("WEBGL_lose_context");
			if (!ext) return {ok: false, why: "无 WEBGL_lose_context"};
			window.__ctxGl = gl; window.__ctxExt = ext; window.__ctxEvents = [];
			// 本监听器注册在 App **之后** ⇒ 读到的 defaultPrevented 反映的就是"App 有没有 preventDefault"。
			// 规范: 只有 webglcontextlost 被 preventDefault, 浏览器才会尝试恢复上下文。
			// 注意本监听器自己**不能** preventDefault (否则就把 App 的行为掩盖了)。
			cv.addEventListener("webglcontextlost", (e) => { window.__ctxEvents.push({t: "lost", defaultPrevented: !!e.defaultPrevented}) }, false)
			cv.addEventListener("webglcontextrestored", () => { window.__ctxEvents.push({t: "restored"}) }, false)
			return {ok: true};
		})()`)
		if (!armed.ok) console.log(`   跳过: ${armed.why}`)
		else {
			const before = await draws()
			await evalJs(`window.__ctxExt.loseContext()`)
			await sleep(3000)
			const s1 = await evalJs(`({lost: window.__ctxGl.isContextLost(), ev: window.__ctxEvents.slice(), d: window.__noriL2dDraws||0})`)
			const lostEv = s1.ev.find((e) => e.t === "lost")
			console.log(`   loseContext() 后: isContextLost=${s1.lost}   事件=${JSON.stringify(s1.ev)}`)
			if (lostEv && lostEv.defaultPrevented) console.log(`   → App **调用了 preventDefault** ⇒ 允许浏览器恢复`)
			else console.log(`   ★ 丢失事件**没人 preventDefault** ⇒ 按规范浏览器**不会**自动恢复上下文 (= 永久失效)`)
			console.log(`   出帧计数: ${before} → ${s1.d} (增量 ${s1.d - before})`)
			console.log(`   ⚠ 这个计数**不是**恢复判据: __noriL2dTick 是"先自增再调 model.update()",`)
			console.log(`      而 isContextLost 检查在 model.update() 内部提前返回 ⇒ 上下文丢了计数照样涨。`)
			await evalJs(`window.__ctxExt.restoreContext()`)
			await sleep(3000)
			const s2 = await evalJs(`({lost: window.__ctxGl.isContextLost(), ev: window.__ctxEvents.slice()})`)
			console.log(`   显式 restoreContext() 后: isContextLost=${s2.lost}   事件=${JSON.stringify(s2.ev)}`)
			const gotRestored = s2.ev.some((e) => e.t === "restored")
			if (gotRestored) console.log(`   → 浏览器把上下文还回来了; 是否重建 GPU 资源取决于 App 有没有接 webglcontextrestored 重挂`)
			else console.log(`   ★ 连显式 restoreContext() 都没能恢复`)
			const dp = lostEv && lostEv.defaultPrevented
			if (dp && gotRestored) console.log(`   结论: **已具备恢复能力** (preventDefault ✓ + restored 事件 ✓) ✓`)
			else if (!dp) console.log(`   结论: 缺 preventDefault ⇒ 上下文一丢就是**永久失效**。补法: 照 FloatApp.vue:166 加一跳 (preventDefault + 重挂)`)
			else console.log(`   结论: preventDefault 有了, 但 restored 事件没回来 ⇒ 查浏览器/驱动行为`)
		}

		/* ======== ③ 悬浮窗 __noriRefresh 并发重入 ======== */
		console.log("\n③ 悬浮窗 __noriRefresh() 并发重入")
		await send("Page.navigate", {url: `${HARNESS}/assets/web/float.html?shim=1`}, sessionId)
		await sleep(3000)
		const fLoaded = await waitModel(26000)
		const c0 = await evalJs(`document.querySelectorAll("canvas").length`)
		const d0 = await draws()
		const has = await evalJs(`typeof window.__noriRefresh === "function"`)
		console.log(`   模型已加载=${fLoaded}  canvas 数=${c0}  __noriRefresh 存在=${has}`)
		if (!has) console.log("   跳过: 悬浮窗页没暴露 __noriRefresh")
		else {
			// 连调两次: 两个 mountModel 会交错 (都是 async, 都 await destroy → 都 await mount)
			await evalJs(`window.__noriRefresh(); window.__noriRefresh(); true`)
			await sleep(8000)
			const c1 = await evalJs(`document.querySelectorAll("canvas").length`)
			await evalJs(`window.__fpsFrames=0;(function t(){window.__fpsFrames++;requestAnimationFrame(t)})()`)
			const s0 = await evalJs(`({f: window.__fpsFrames, d: window.__noriL2dDraws||0})`)
			await sleep(5000)
			const s1 = await evalJs(`({f: window.__fpsFrames, d: window.__noriL2dDraws||0})`)
			const fps = (s1.f - s0.f) / 5
			const dRate = (s1.d - s0.d) / 5
			console.log(`   重入后 canvas 数=${c1} (重入前 ${c0}), 出帧=${dRate.toFixed(1)}/s, rAF=${fps.toFixed(1)}/s`)
			if (c1 > c0) console.log(`   ★ canvas 数增加 (${c0}→${c1}) ⇒ 叠出了多套画布/渲染循环`)
			else if (dRate > fps * 1.4) console.log(`   ★ 出帧速率(${dRate.toFixed(1)}/s) 明显高于 rAF 帧率(${fps.toFixed(1)}/s) ⇒ **两条渲染循环都在 tick**`)
			else console.log(`   → 未观察到叠加 (canvas 数不变, 出帧≈rAF) ✓  (destroy 前置 + mountModel 的 in-flight 守卫)`)
			if (c1 > c0 || dRate > fps * 1.4) console.log(`     提示: 悬浮窗 mountModel 应有一个 in-flight 标志挡住 webglcontextrestored 与 __noriRefresh 并发`)
		}

		console.log("\n================ 汇总 ================")
		console.log("① 纹理: 见上 (可直接算解码显存)")
		console.log("② 主界面上下文丢失恢复能力: 见上")
		console.log("③ 悬浮窗重入: 见上")
		console.log("\n注: headless + 桌面 GPU 下的行为; 真机 WebView 的上下文丢失更频繁 (息屏/后台/内存压力),")
		console.log("    所以 ② 这条在真机上的暴露概率比这里高得多。")
	} finally {
		try { ws?.close() } catch { /* 忽略 */ }
		edge.kill()
		await sleep(400)
		try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
	}
} catch (e) {
	console.log("!! 探针异常 (报告型探针, 不算门禁失败):", e?.message ?? e)
}
process.exit(0)
