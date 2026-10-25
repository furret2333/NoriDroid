/* 主题 token / 视觉的可见性验证 (原「像素风重构验证」2026-09-26; 2026-10-25 重写)。
 *
 * 为什么需要它: 改样式最容易出现"改了 token 但元素没引用"或"var 落空 → 静默回落",
 * 两种情况都**不报错、不红**, 只是页面没变 / 变丑。之前那轮"看不出变化"就是这么来的。
 * 所以这里读 computedStyle 逐项核对**具体数值**, 而不是看源码。
 *
 * 2026-10-25 重写背景: 像素风已从产品下线 (v2.4.0 起只剩 柔和雾面 / 潮汐玻璃 两态),
 * 旧断言里"把主题切到像素风再核对像素凸起"全部失效。现在改为:
 *   ① --px-* 色板与亮度纪律 (两态共用)
 *   ② 默认态 = 柔和风: 圆角 / 柔和阴影 / **不再有像素硬边**
 *   ③ 切潮汐玻璃: 渐变底 + 浮影 + 更强模糊 + 色板不变
 *   ④ 切回柔和: 可逆, 且永远不会切出像素风第三态
 *   ⑤ token 落空检测 + 全程无 JS 异常
 *
 * 运行: node tmp-memcheck/e2e-pixel-ui.mjs   (需 harness 在 8123)
 */
import {spawn} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9408
const profile = mkdtempSync(join(tmpdir(), "nori-px-"))
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
const hexToRgb = (h) => {
	const n = String(h).replace("#", "")
	return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`
}

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

	await send("Page.navigate", {url: "http://127.0.0.1:8123/assets/web/index.html"}, sessionId)
	await sleep(4500)

	/* ① 网页版 --px-* 色板必须逐个就位 */
	const px = await evalJs(`(() => {
		const root = document.querySelector(".stage-root")
		if (!root) return {err: "no .stage-root"}
		const cs = getComputedStyle(root)
		const out = {}
		for (const n of ["--px-void","--px-bg","--px-panel","--px-panel-2","--px-stroke","--px-line","--px-cyan","--px-cyan-mid","--px-cyan-dim","--px-cyan-src","--px-hilite","--px-hilite-src","--px-amber","--px-magenta","--px-violet","--px-green","--px-red","--px-white","--px-grey","--px-dim"]) out[n] = cs.getPropertyValue(n).trim()
		return out
	})()`)
	if (px.err) throw new Error(px.err)
	const missing = Object.entries(px).filter(([, v]) => !v).map(([k]) => k)
	check(`网页版 --px-* 色板全部就位 (${Object.keys(px).length} 个)`, missing.length === 0, JSON.stringify(missing))
	check("网页版原值留档 --px-cyan-src = #67e8f9", px["--px-cyan-src"] === "#67e8f9", px["--px-cyan-src"])
	check("主题色板解析完整", missing.length === 0, JSON.stringify(missing))

	/* ①b 亮度纪律 (2026-09-26 用户反馈"像素风太亮"后加):
	 * 强调色与凸起高光都不能是"接近白"的高亮 —— 满屏高光在深色底上就是视疲劳。
	 * 依据: 像素风通行做法是低饱和受限色板 (NES.css: NES 每个 sprite 仅 3 色);
	 *      深色主题不该用接近纯白的高光 (UX Movement / Material dark theme)。 */
	const LUM = (hex) => {
		const n = String(hex).replace("#", "")
		const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
		return 0.2126 * lin(parseInt(n.slice(0, 2), 16)) + 0.7152 * lin(parseInt(n.slice(2, 4), 16)) + 0.0722 * lin(parseInt(n.slice(4, 6), 16))
	}
	const lAcc = LUM(px["--px-cyan"]), lHi = LUM(px["--px-hilite"]), lTxt = LUM(px["--px-white"])
	console.log(`   亮度: accent=${lAcc.toFixed(3)} hilite=${lHi.toFixed(3)} text=${lTxt.toFixed(3)}`)
	check("强调色不再是高亮 (亮度 < 0.50; 网页版原值 0.674)", lAcc < 0.50, String(lAcc))
	check("凸起高光不再接近纯白 (亮度 < 0.62; 网页版原值 0.905)", lHi < 0.62, String(lHi))
	check("高光仍亮于强调色 (保住\"亮上左\"的立体关系)", lHi > lAcc, `${lHi} vs ${lAcc}`)
	check("正文亮度略降但可读 (0.80~0.92; 原 #f8fafc 是 0.954)", lTxt > 0.80 && lTxt < 0.92, String(lTxt))

	/* ② 打开设置面板 (等它真的出现) */
	await evalJs(`[...document.querySelectorAll(".fab")].find(x => /设置/.test(x.textContent))?.click()`)
	let hasSheet = false
	for (let i = 0; i < 12 && !hasSheet; i += 1) { await sleep(250); hasSheet = await evalJs(`!!document.querySelector(".sheet")`) }
	check("设置面板已打开 (后续断言的前提)", hasSheet === true, `hasSheet=${hasSheet}`)
	if (!hasSheet) throw new Error("设置面板没打开, 无法继续")
	/* v2.4.0 起设置分「基础设置 / 进阶设置」两个 tab（默认基础设置）；
	   「外观风格」切换按钮在进阶设置 →「更多工具」里，先切过去。 */
	await evalJs(`[...document.querySelectorAll(".settings-tabs [role=tab]")].find(x => /进阶设置/.test(x.textContent))?.click()`)
	await sleep(400)

	/* ②b 默认外观 = 柔和风 (2026-10-01 用户定稿)。
	   像素风在 v2.4.0 已经**从产品下线**（只剩 柔和雾面 / 潮汐玻璃 两态），
	   所以这里不再"切到像素风"，而是先断言默认柔和、再由 ⑤ 切潮汐玻璃做对比。 */
	const themeState = await evalJs(`(() => {
		const root = document.querySelector(".stage-root");
		const b = [...document.querySelectorAll(".sheet button")].find(x => /外观风格/.test(x.textContent));
		return {cls: String(root && root.className), label: (b && b.textContent.trim()) || ""};
	})()`)
	check("默认外观 = 柔和风 (ui-soft; 2026-10-01 用户定稿)", themeState.cls.includes("ui-soft"), JSON.stringify(themeState))
	check("外观风格按钮显示当前风格「柔和雾面」", /柔和雾面/.test(themeState.label), themeState.label)

	/* ③ 逐项核对渲染值 */
	const look = await evalJs(`(() => {
		const q = (s) => document.querySelector(s)
		const g = (el, p) => el ? getComputedStyle(el)[p] : null
		const sheet = q(".sheet"), head = q(".sheet-head"), x = q(".sheet .x"), fab = q(".fab")
		const mini = q(".sheet .mini"), chip = q(".sheet .chip")
		return {
			sheetRadius: g(sheet, "borderTopLeftRadius"),
			sheetBg: g(sheet, "backgroundColor"),
			sheetBorderTop: g(sheet, "borderTopWidth"),
			sheetShadow: g(sheet, "boxShadow"),
			headBorderBottom: g(head, "borderBottomWidth"),
			headBgImage: String(g(head, "backgroundImage") || "").includes("repeating-linear-gradient"),
			xRadius: g(x, "borderRadius"),
			xBorder: g(x, "borderTopWidth"),
			fabRadius: g(fab, "borderRadius"),
			fabShadow: g(fab, "boxShadow"),
			fabBg: g(fab, "backgroundColor"),
			/* 2026-10-25: 底栏改成 .dock 容器 + 透明 .fab 图标, 底色要看 .dock 而不是 .fab */
			dockBg: g(q(".dock"), "backgroundColor"),
			dockBgImage: String(g(q(".dock"), "backgroundImage")),
			miniRadius: mini ? g(mini, "borderRadius") : "(no .mini)",
			miniShadow: mini ? g(mini, "boxShadow") : "(no .mini)",
			chipRadius: chip ? g(chip, "borderRadius") : "(no .chip)",
			titleColor: g(q(".sheet-title"), "color"),
			// C4: 模糊半径集中成 --ui-blur-* 变量 (像素风 = 0px 保持硬边质感)
			blurs: ["bubble", "chip", "mask"].map(k => {
				const root = q(".stage-root")
				return root ? getComputedStyle(root).getPropertyValue("--ui-blur-" + k).trim() : null
			}),
			tagBlur: g(q(".topbar .tag") || q(".tag"), "backdropFilter"),
			// 2026-09-30 底栏图标化: 6 个 <img> 必须**真的加载出来** (路径错/没打进包 ⇒ naturalWidth=0)
			fabIcons: [...document.querySelectorAll(".fab .fab-ico")].map(i => ({
				src: i.getAttribute("src"), w: i.naturalWidth, done: i.complete,
			})),
			fabLabels: [...document.querySelectorAll(".fab .fab-label")].map(s => s.textContent.trim()),
		}
	})()`)
	console.log(`   底栏: ${JSON.stringify(look.fabIcons)} · 文字 ${JSON.stringify(look.fabLabels)}`)
	check("底栏 5 个图标都真的加载出来了 (naturalWidth>0 ⇒ 路径/打包没问题)",
		look.fabIcons.length === 5 && look.fabIcons.every(i => i.done && i.w > 0), JSON.stringify(look.fabIcons))
	check("底栏 5 个图标下方都有文字 (日记/模型/番茄/设置/对话)",
		JSON.stringify(look.fabLabels) === JSON.stringify(["日记", "模型", "番茄", "设置", "对话"]),
		JSON.stringify(look.fabLabels))
	console.log(`   渲染值(柔和): ${JSON.stringify(look)}`)
	const panel = hexToRgb(px["--px-panel"])
	const white = hexToRgb(px["--px-white"])
	/* ---- 柔和风（默认态）: 圆角 + 柔和阴影 + 没有像素硬边 ---- */
	check("柔和: 面板圆角 20px", look.sheetRadius === "20px", look.sheetRadius)
	check(`柔和: 面板底色 = --px-panel (${panel})`, look.sheetBg === panel, `${look.sheetBg} vs ${panel}`)
	check("柔和: 面板描边是 1px 细线", look.sheetBorderTop === "1px", look.sheetBorderTop)
	check("标题栏有清晰分隔线", look.headBorderBottom === "1px" || look.headBorderBottom === "2px", look.headBorderBottom)
	/* 反向断言: 那层抖动条纹不许再出现（用户实机截图判定"太丑"⇒ 删掉，别哪天又被加回来） */
	check("标题栏**不再**有抖动条纹底纹 (用户 2026-10-01 要求删)",
		look.headBgImage === false, `backgroundImage=${JSON.stringify(look.headBgImage)}`)
	check("关闭按钮保持圆形细描边", look.xRadius !== "0px" && look.xBorder === "1px",
		`${look.xRadius} / ${look.xBorder}`)
	check("面板标题用 --px-white (色板不变)", look.titleColor === white, `${look.titleColor} vs ${white}`)
	check("柔和: 底栏按钮是圆角 (不再是直角)", look.fabRadius !== "0px", look.fabRadius)
	check("柔和: 底栏底色已解析 (色值或渐变, 不能是空的)",
		(!!look.dockBg && look.dockBg !== "rgba(0, 0, 0, 0)") || (!!look.dockBgImage && look.dockBgImage !== "none"),
		`bg=${look.dockBg} img=${String(look.dockBgImage).slice(0, 80)}`)
	/* 2026-10-25 修复: 面板阴影末尾那条像素硬底边 (`0 -6px 0 rgba(5,8,17,.55)`) 之前是字面量,
	   柔和风覆盖不到, 圆角面板下沿还挂着像素凸起。现在走 --ui-sheet-edge, 柔和风 = 全透明。 */
	check("柔和: 面板阴影是柔和投影 (含 0.38 那条投影)",
		/0\.38/.test(String(look.sheetShadow)), String(look.sheetShadow))
	check("柔和: 面板**不再**有像素风硬底边 (无 5,8,17 / -6px 硬投影)",
		!/5, 8, 17/.test(String(look.sheetShadow)) && !/-6px/.test(String(look.sheetShadow)), String(look.sheetShadow))
	check("柔和: 凸起不再使用网页版原高光 #d6fbff (太亮)",
		!/214, 251, 255/.test(String(look.fabShadow)), look.fabShadow)
	/* mini 存在于设置页则不放过; 不存在就明确说明而不是假绿 */
	if (String(look.miniRadius).startsWith("(")) {
		check("柔和: 小按钮 .mini 圆角", false, `设置页里没找到 .mini: ${look.miniRadius}`)
	} else {
		check("柔和: 小按钮 .mini 圆角", look.miniRadius !== "0px", look.miniRadius)
	}

	/* ④ 变量落空检测: 深色面板里出现纯黑文字 = token 没解析出来 */
	const broken = await evalJs(`(() => {
		const bad = []
		for (const el of document.querySelectorAll(".sheet *")) {
			const cs = getComputedStyle(el)
			if (cs.color === "rgb(0, 0, 0)" && (el.textContent || "").trim()) bad.push(el.className || el.tagName)
			if (bad.length > 8) break
		}
		return bad
	})()`)
	/* C4: 模糊半径变量 (柔和 6/8/3px, 潮汐 10/12/5px; 两个主题都必须解析出值, 不能落空) */
	check("当前主题模糊变量均有值", look.blurs.every(v => !!v), JSON.stringify(look.blurs))
	check("真实元素的 backdrop-filter 已解析", String(look.tagBlur).includes("blur("), `${look.tagBlur}`)
	check("面板内没有\"变量落空变黑\"的元素", broken.length === 0, JSON.stringify(broken))

	/* ⑤ 切到潮汐玻璃: 玻璃质感 = 渐变底 + 更重的浮影 + 更强模糊; **色板不变**。
	 * (像素风已从产品下线, 所以这里是"柔和 ↔ 潮汐玻璃"两态对比, 不是回到像素风。) */
	const beforeToggle = await evalJs(`({
		cls: document.querySelector(".stage-root").className,
		label: ([...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent)) || {}).textContent || "",
	})`)
	console.log(`   切换前: ${JSON.stringify(beforeToggle)}`)
	check("设置页有「外观风格」切换按钮 (便于真机 A/B)", /柔和雾面/.test(beforeToggle.label), beforeToggle.label)

	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent))?.click()`)
	await sleep(600)
	const tide = await evalJs(`(() => {
		const q = (s) => document.querySelector(s)
		const g = (el, p) => el ? getComputedStyle(el)[p] : null
		const root = q(".stage-root")
		return {
			cls: root.className,
			sheetRadius: g(q(".sheet"), "borderTopLeftRadius"),
			sheetBgImage: String(g(q(".sheet"), "backgroundImage")),
			sheetShadow: g(q(".sheet"), "boxShadow"),
			fabRadius: g(q(".fab"), "borderRadius"),
			titleColor: g(q(".sheet-title"), "color"),
			blurs: ["bubble", "chip", "mask"].map(k => getComputedStyle(root).getPropertyValue("--ui-blur-" + k).trim()),
			tagBlur: g(q(".topbar .tag") || q(".tag"), "backdropFilter"),
		}
	})()`)
	console.log(`   潮汐玻璃: ${JSON.stringify(tide)}`)
	check("切到潮汐玻璃: 根节点 class 变为 ui-tide", String(tide.cls).includes("ui-tide"), tide.cls)
	check("潮汐玻璃: 面板圆角 18px", tide.sheetRadius === "18px", tide.sheetRadius)
	check("潮汐玻璃: 面板是渐变底 (不是纯色)", /linear-gradient/.test(tide.sheetBgImage), tide.sheetBgImage.slice(0, 140))
	check("潮汐玻璃: 面板有浮影", /rgba?\(/.test(String(tide.sheetShadow)), tide.sheetShadow)
	check("潮汐玻璃: 底栏按钮是圆角", tide.fabRadius !== "0px", tide.fabRadius)
	check("★ 潮汐玻璃**色板不变**: 标题仍是 --px-white", tide.titleColor === white, `${tide.titleColor} vs ${white}`)
	check("潮汐玻璃: 三个模糊变量都有值 (bubble/chip/mask)", tide.blurs.every(v => !!v), JSON.stringify(tide.blurs))
	check("潮汐玻璃: 真实元素 backdrop-filter 已解析", String(tide.tagBlur).includes("blur("), `${tide.tagBlur}`)

	/* ⑥ 切回柔和: 状态可逆, 且**永远不会切出像素风第三态** (v2.4.0 起像素风已下线) */
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent))?.click()`)
	await sleep(500)
	const back = await evalJs(`({
		cls: String(document.querySelector(".stage-root").className),
		r: getComputedStyle(document.querySelector(".sheet")).borderTopLeftRadius,
		label: ([...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent)) || {}).textContent || "",
	})`)
	check("能切回柔和风 (状态可逆)", String(back.cls).includes("ui-soft") && back.r === "20px", JSON.stringify(back))
	check("像素风已下线: 切换只在「柔和雾面 / 潮汐玻璃」两态之间",
		!String(back.cls).includes("ui-pixel") && /柔和雾面/.test(back.label), JSON.stringify(back))

	check("全程无未捕获 JS 异常", jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))

	const failed = results.filter(r => !r.cond)
	console.log(`\n${results.length - failed.length}/${results.length} passed`)
	if (failed.length) { process.exitCode = 1; console.log("FAILED:", failed.map(f => f.name).join(" | ")) }
} catch (e) {
	console.error("探针异常:", e?.message || e)
	process.exitCode = 2
} finally {
	try { ws?.close() } catch { /* 忽略 */ }
	edge.kill()
	await sleep(400)
	try { rmSync(profile, {recursive: true, force: true}) } catch { /* 忽略 */ }
}
