/* 像素风重构的可见性验证 (2026-09-26)。
 *
 * 为什么需要它: 改样式最容易出现"改了 token 但元素没引用"或"var 落空 → 静默回落",
 * 两种情况都**不报错、不红**, 只是页面没变 / 变丑。之前那轮"看不出变化"就是这么来的。
 * 所以这里读 computedStyle 逐项核对**具体数值**, 而不是看源码。
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
	check("--px-void = 网页版 #050811", px["--px-void"] === "#050811", px["--px-void"])
	check("--px-panel = 网页版 #0d1b33 (不是旧灰蓝 #0f172a)", px["--px-panel"] === "#0d1b33", px["--px-panel"])

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

	/* ②b 默认外观 (2026-10-01 起 = 柔和风) + 把主题切到像素风, 让下面的像素断言**确定**成立。
	   以前这里依赖"应用默认就是像素风" —— 默认一改, 整套断言就会莫名其妙地红。 */
	const themeState = await evalJs(`(() => {
		const root = document.querySelector(".stage-root");
		const soft = String(root && root.className).includes("ui-soft");
		const b = [...document.querySelectorAll(".sheet button")].find(x => /外观风格/.test(x.textContent));
		return {soft, label: (b && b.textContent.trim()) || ""};
	})()`)
	check("默认外观 = 柔和风 (2026-10-01 起; 用户定稿)", themeState.soft === true, JSON.stringify(themeState))
	if (themeState.soft) {
		await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent))?.click()`)
		await sleep(400)
	}
	const nowPixel = await evalJs(`String(document.querySelector(".stage-root").className).includes("ui-pixel")`)
	check("切到像素风 (后续像素断言的确定前提)", nowPixel === true, String(nowPixel))

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
			miniRadius: mini ? g(mini, "borderRadius") : "(no .mini)",
			miniShadow: mini ? g(mini, "boxShadow") : "(no .mini)",
			chipRadius: chip ? g(chip, "borderRadius") : "(no .chip)",
			titleColor: g(q(".sheet-title"), "color"),
			// C4: 模糊半径集中成 --ui-blur-* 变量 (像素风 = 0px 保持硬边质感)
			blurs: ["dot", "bubble", "chip", "mask"].map(k => {
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
	check("底栏 6 个图标都真的加载出来了 (naturalWidth>0 ⇒ 路径/打包没问题)",
		look.fabIcons.length === 6 && look.fabIcons.every(i => i.done && i.w > 0), JSON.stringify(look.fabIcons))
	check("底栏 6 个图标下方都有文字 (日记/模型/触摸/番茄/设置/对话)",
		JSON.stringify(look.fabLabels) === JSON.stringify(["日记", "模型", "触摸", "番茄", "设置", "对话"]),
		JSON.stringify(look.fabLabels))
	console.log(`   渲染值: ${JSON.stringify(look)}`)
	const panel = hexToRgb(px["--px-panel"])
	const panel2 = hexToRgb(px["--px-panel-2"])
	const white = hexToRgb(px["--px-white"])
	check("面板直角 (border-radius 0, 改造前 22px)", look.sheetRadius === "0px", look.sheetRadius)
	check(`面板底色 = --px-panel (${panel})`, look.sheetBg === panel, `${look.sheetBg} vs ${panel}`)
	check("面板描边 2px 硬边 (改造前 1px)", look.sheetBorderTop === "2px", look.sheetBorderTop)
	check("标题栏 2px 分隔线 (标题栏底纹已于 2026-10-01 按用户要求删除)",
		look.headBorderBottom === "2px", look.headBorderBottom)
	/* 反向断言: 那层抖动条纹不许再出现（用户实机截图判定"太丑"⇒ 删掉，别哪天又被加回来） */
	check("标题栏**不再**有抖动条纹底纹 (用户 2026-10-01 要求删)",
		look.headBgImage === false, `backgroundImage=${JSON.stringify(look.headBgImage)}`)
	check("关闭按钮直角 + 2px 描边 (改造前 50% 圆形)", look.xRadius === "0px" && look.xBorder === "2px",
		`${look.xRadius} / ${look.xBorder}`)
	check("面板标题用 --px-white", look.titleColor === white, `${look.titleColor} vs ${white}`)
	check("底栏按钮直角 (改造前 16px)", look.fabRadius === "0px", look.fabRadius)
	check("底栏按钮底色 = --px-panel-2", look.fabBg === panel2, `${look.fabBg} vs ${panel2}`)
	/* 凸起: 亮上左(收敛后的柔和青) + 暗下右(--px-void) + 硬投影。
	 * 注意断言的是**收敛后**的高光, 不是网页版原值 #d6fbff —— 那正是"太亮"的来源。 */
	check("底栏按钮有像素凸起 (inset 柔和高光 + inset 暗 050811 + 4px 硬投影)",
		/inset/.test(look.fabShadow) && look.fabShadow.includes(hexToRgb(px["--px-hilite"])) && /5, 8, 17/.test(look.fabShadow),
		`${look.fabShadow}  (期望含 ${hexToRgb(px["--px-hilite"])})`)
	check("凸起不再使用网页版的原高光 #d6fbff (太亮)",
		!/214, 251, 255/.test(look.fabShadow), look.fabShadow)
	/* mini/chip 存在于设置页则不放过; 不存在就明确说明而不是假绿 */
	if (String(look.miniRadius).startsWith("(")) {
		check("小按钮 .mini 直角 + 凸起", false, `设置页里没找到 .mini: ${look.miniRadius}`)
	} else {
		check("小按钮 .mini 直角 + 凸起",
			look.miniRadius === "0px" && /inset/.test(String(look.miniShadow)), `${look.miniRadius} / ${look.miniShadow}`)
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
	/* C4: 模糊半径变量 (像素风必须四个都是 0px, 否则"像素"被柔和模糊糊掉) */
	check("C4 像素风: --ui-blur-dot/bubble/chip/mask 四个都是 0px",
		look.blurs.join(",") === "0px,0px,0px,0px", JSON.stringify(look.blurs))
	check("C4 像素风: 真实元素的 backdrop-filter 解析为 blur(0px) (不是变量落空)",
		String(look.tagBlur).replace(/\s/g, "") === "blur(0px)", `${look.tagBlur}`)
	check("面板内没有\"变量落空变黑\"的元素", broken.length === 0, JSON.stringify(broken))

	/* ⑤ 两种模式对比: 点设置页底部「外观风格」按钮 → 柔和风。
	 * 断言"色板不变、只有形状变" —— 这正是用户要的"只保留新色板"。 */
	const beforeToggle = await evalJs(`({
		cls: document.querySelector(".stage-root").className,
		label: ([...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent)) || {}).textContent || "",
	})`)
	console.log(`   切换前: ${JSON.stringify(beforeToggle)}`)
	check("设置页有「外观风格」切换按钮 (便于真机 A/B)", beforeToggle.label.includes("像素风"), beforeToggle.label)

	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent))?.click()`)
	await sleep(600)
	const soft = await evalJs(`(() => {
		const q = (s) => document.querySelector(s)
		const g = (el, p) => el ? getComputedStyle(el)[p] : null
		return {
			cls: q(".stage-root").className,
			sheetRadius: g(q(".sheet"), "borderTopLeftRadius"),
			sheetBg: g(q(".sheet"), "backgroundColor"),
			sheetBorderTop: g(q(".sheet"), "borderTopWidth"),
			sheetShadow: g(q(".sheet"), "boxShadow"),
			fabRadius: g(q(".fab"), "borderRadius"),
			fabShadow: g(q(".fab"), "boxShadow"),
			titleColor: g(q(".sheet-title"), "color"),
			blurs: ["dot", "bubble", "chip", "mask"].map(k => {
				const root = q(".stage-root")
				return root ? getComputedStyle(root).getPropertyValue("--ui-blur-" + k).trim() : null
			}),
			tagBlur: g(q(".topbar .tag") || q(".tag"), "backdropFilter"),
		}
	})()`)
	console.log(`   柔和模式: ${JSON.stringify(soft)}`)
	check("切到柔和: 根节点 class 变为 ui-soft", String(soft.cls).includes("ui-soft"), soft.cls)
	check("柔和: 面板圆角回来 (20px)", soft.sheetRadius === "20px", soft.sheetRadius)
	check("柔和: 描边变回 1px 细线", soft.sheetBorderTop === "1px", soft.sheetBorderTop)
	check("柔和: 底栏按钮不再是直角", soft.fabRadius !== "0px", soft.fabRadius)
	check("柔和: 有柔和阴影、不再有像素凸起的亮边",
		!/214, 251, 255/.test(String(soft.fabShadow)) && /rgba?\(/.test(String(soft.fabShadow)), soft.fabShadow)
	check("★ 柔和模式**色板不变**: 面板底仍是 --px-panel 深蓝", soft.sheetBg === panel, `${soft.sheetBg} vs ${panel}`)
	check("★ 柔和模式**色板不变**: 标题仍是 --px-white", soft.titleColor === white, `${soft.titleColor} vs ${white}`)
	check("C4 柔和风: 模糊半径回到 2/6/8/3px (与像素风的硬边形成对比)",
		soft.blurs.join(",") === "2px,6px,8px,3px", JSON.stringify(soft.blurs))
	check("C4 柔和风: 真实元素 backdrop-filter = blur(8px) (chip 变量接上了)",
		String(soft.tagBlur).replace(/\s/g, "") === "blur(8px)", `${soft.tagBlur}`)

	/* 切回像素风, 并顺手把状态还原, 免得影响后续断言 */
	await evalJs(`[...document.querySelectorAll(".sheet button")].find(b => /外观风格/.test(b.textContent))?.click()`)
	await sleep(500)
	const back = await evalJs(`({cls: document.querySelector(".stage-root").className, r: getComputedStyle(document.querySelector(".sheet")).borderTopLeftRadius})`)
	check("能切回像素风 (状态可逆)", String(back.cls).includes("ui-pixel") && back.r === "0px", JSON.stringify(back))

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
