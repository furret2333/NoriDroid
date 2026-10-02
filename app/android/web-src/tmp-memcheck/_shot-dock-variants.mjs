/* 底栏图标风格对比: 把 5 套方案注入真实页面 (用 App 自己的 .dock/.fab CSS) 截一张图
 * 前置: 1) 图标素材拷进 app/src/main/assets/web/_mock/  2) harness 在 8123
 * 运行: node tmp-memcheck/_shot-dock-variants.mjs
 * 产物: tmp-memcheck/_shot-dock-variants.png
 */
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 9448
const profile = mkdtempSync(join(tmpdir(), "nori-variants-"))
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=520,1100", "about:blank"], {stdio: "ignore"})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let id = 0
const pending = new Map()
let ws
const send = (method, params = {}, sid) => {
	const m = ++id
	ws.send(JSON.stringify({id: m, method, params, ...(sid ? {sessionId: sid} : {})}))
	return new Promise((res, rej) => {
		pending.set(m, {res, rej})
		setTimeout(() => { if (pending.has(m)) { pending.delete(m); rej(new Error("超时 " + method)) } }, 25000)
	})
}
async function wsUrl() {
	for (let i = 0; i < 40; i += 1) {
		try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch { /* wait */ }
		await sleep(250)
	}
	throw new Error("Edge CDP 未就绪")
}

/* 自绘像素图标 (16×16 网格, 硬边): 书 / 机器头 / 手 / 番茄 / 推子 / 气泡 */
const L = "#dff1ff", C = "#7fd4e6"
const svg = (inner) => `<svg viewBox="0 0 16 16" width="38" height="38" shape-rendering="crispEdges">${inner}</svg>`
const PIXEL = {
	diary: svg(`<rect x="3" y="2" width="10" height="12" fill="none" stroke="${L}" stroke-width="1"/>
		<rect x="5" y="2" width="1" height="12" fill="${C}"/>
		<rect x="7" y="5" width="5" height="1" fill="${L}"/><rect x="7" y="8" width="5" height="1" fill="${L}"/>
		<rect x="7" y="11" width="3" height="1" fill="${L}"/>`),
	model: svg(`<rect x="2" y="5" width="12" height="8" fill="none" stroke="${L}" stroke-width="1"/>
		<rect x="7" y="2" width="2" height="3" fill="${L}"/><rect x="6" y="1" width="4" height="1" fill="${C}"/>
		<rect x="5" y="7" width="2" height="3" fill="${C}"/><rect x="9" y="7" width="2" height="3" fill="${C}"/>`),
	touch: svg(`<rect x="5" y="7" width="7" height="7" fill="none" stroke="${L}" stroke-width="1"/>
		<rect x="5" y="3" width="1" height="4" fill="${L}"/><rect x="7" y="2" width="1" height="5" fill="${L}"/>
		<rect x="9" y="3" width="1" height="4" fill="${L}"/><rect x="11" y="4" width="1" height="3" fill="${L}"/>
		<rect x="3" y="8" width="2" height="4" fill="${C}"/>`),
	pomo: svg(`<rect x="4" y="5" width="8" height="8" fill="none" stroke="${L}" stroke-width="1"/>
		<rect x="5" y="4" width="6" height="1" fill="${L}"/><rect x="7" y="2" width="2" height="2" fill="${C}"/>
		<rect x="9" y="3" width="3" height="1" fill="${C}"/><rect x="7" y="7" width="2" height="2" fill="${C}"/>`),
	settings: svg(`<rect x="2" y="4" width="12" height="1" fill="${L}"/><rect x="2" y="8" width="12" height="1" fill="${L}"/>
		<rect x="2" y="12" width="12" height="1" fill="${L}"/><rect x="5" y="3" width="2" height="3" fill="${C}"/>
		<rect x="9" y="7" width="2" height="3" fill="${C}"/><rect x="4" y="11" width="2" height="3" fill="${C}"/>`),
	chat: svg(`<rect x="2" y="3" width="12" height="8" fill="none" stroke="${L}" stroke-width="1"/>
		<rect x="4" y="11" width="3" height="2" fill="${L}"/>
		<rect x="4" y="6" width="2" height="2" fill="${C}"/><rect x="7" y="6" width="2" height="2" fill="${C}"/>
		<rect x="10" y="6" width="2" height="2" fill="${C}"/>`),
}

const ROWS = [
	{label: "① 现状：原版白底贴纸 + 像素面板", src: (n) => `./_mock/a-${n}.png`, tune: ""},
	{label: "② 原版深色版（icon-b，深底白图案）+ 像素面板", src: (n) => `./_mock/b-${n}.png`, tune: ""},
	{label: "③ 单色剪影（从原版抠出图案，去掉白底）+ 像素面板", src: (n) => (n === "chat" ? null : `./_mock/mono-${n}.png`), tune: ""},
	{label: "④ 同 ③，但弱化面板（去掉青色描边、只留深底 + 极淡高光）",
		src: (n) => (n === "chat" ? null : `./_mock/mono-${n}.png`),
		tune: "border-color:rgba(74,127,191,.28);box-shadow:inset 2px 2px 0 0 rgba(255,255,255,.045),inset -2px -2px 0 0 rgba(0,0,0,.35);"},
	{label: "⑤ 自绘像素图标（与全站像素风同源）+ 弱化面板", svgIcons: true,
		tune: "border-color:rgba(74,127,191,.28);box-shadow:inset 2px 2px 0 0 rgba(255,255,255,.045),inset -2px -2px 0 0 rgba(0,0,0,.35);"},
]
const NAMES = ["diary", "model", "touch", "pomo", "settings", "chat"]
const LABELS = ["日记", "模型", "触摸", "番茄", "设置", "对话"]

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
	const S = Buffer.from(JSON.stringify({apiKey: "sk-v", baseUrl: "https://api.v.test", model: "m"})).toString("base64url")
	await send("Page.navigate", {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${S}`}, sessionId)
	await sleep(4500)
	await evalJs(`localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1")`)
	await evalJs(`document.querySelector(".intro-mask")?.remove()`)
	await sleep(500)

	const html = ROWS.map((row, i) => {
		const btns = NAMES.map((n, k) => {
			const ico = row.svgIcons ? PIXEL[n] : `<img class="fab-ico" src="${row.src(n) ?? ""}" alt="" />`
			const iconHtml = row.svgIcons ? `<span class="fab-ico fab-ico-svg">${ico}</span>`
				: (row.src(n) ? ico : `<span class="fab-ico fab-ico-svg">${PIXEL[n]}</span>`)
			return `<button class="fab" style="${row.tune}">${iconHtml}<span class="fab-label">${LABELS[k]}</span></button>`
		}).join("")
		return `<div style="margin:0 0 10px">
			<div style="font:600 12px/1.4 system-ui;color:#9fd0ff;padding:0 2px 4px">${row.label}</div>
			<div class="dock-mock">${btns}</div>
		</div>`
	}).join("")
	/* ⚠ 不能自己拼 DOM: App.vue 的样式是 scoped (带 data-v-* 属性选择器), 手写元素匹配不上,
	   会变成"没有样式的巨大图标"(第一次就踩了这个坑)。所以**克隆真实底栏节点**再换图标。 */
	/* 传进页面前先去掉函数 (JSON 不认) —— 每行的图标来源预先算成 {名字: 路径|null} */
	const ROWS_SERIAL = ROWS.map(r => ({
		label: r.label,
		tune: r.tune ?? "",
		svgIcons: !!r.svgIcons,
		srcs: Object.fromEntries(NAMES.map(n => [n, r.svgIcons ? null : (r.src(n) ?? null)])),
	}))
	await evalJs(`(() => {
		const real = document.querySelector(".dock");
		if (!real) throw new Error("找不到 .dock");
		const rows = ${JSON.stringify(ROWS_SERIAL)};
		const labels = ${JSON.stringify(LABELS)};
		const pixel = ${JSON.stringify(PIXEL)};
		real.style.display = "none";
		const wrap = document.createElement("div");
		wrap.id = "variant-mock";
		wrap.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99;background:#050b18;padding:10px 8px 12px";
		rows.forEach((row) => {
			const label = document.createElement("div");
			label.style.cssText = "font:600 12px/1.45 system-ui,sans-serif;color:#9fd0ff;padding:0 2px 5px";
			label.textContent = row.label;
			const bar = real.cloneNode(true);              // 带 scoped 属性 ⇒ 样式生效
			bar.style.cssText = "position:static;background:none;padding:0;gap:6px";
			[...bar.querySelectorAll(".fab")].forEach((b, k) => {
				const n = ${JSON.stringify(NAMES)}[k];
				if (row.tune) b.style.cssText += ";" + row.tune;
				const icon = b.querySelector(".fab-ico");
				const src = row.srcs[n];
				if (row.svgIcons || !src) {
					const span = document.createElement("span");
					span.className = "fab-ico";
					span.innerHTML = pixel[n];
					icon.replaceWith(span);
				} else {
					icon.setAttribute("src", src);
				}
				const lab = b.querySelector(".fab-label");
				if (lab) lab.textContent = labels[k];
			});
			wrap.appendChild(label);
			wrap.appendChild(bar);
		});
		document.body.appendChild(wrap);
		return true;
	})()`)
	await sleep(1200)
	const box = await evalJs(`(() => { const r = document.querySelector("#variant-mock").getBoundingClientRect();
		return {x: 0, y: 0, w: Math.ceil(r.width), h: Math.ceil(r.height)} })()`)
	const shot = await send("Page.captureScreenshot", {
		format: "png",
		clip: {x: box.x, y: box.y, width: Math.min(box.w, 520), height: Math.min(box.h, 1100), scale: 2},
	}, sessionId)
	const out = resolve(import.meta.dirname, "_shot-dock-variants.png")
	writeFileSync(out, Buffer.from(shot.data, "base64"))
	console.log(`已保存: ${out}  (${box.w}x${box.h})`)
} catch (e) {
	console.log("失败:", e.message)
	process.exitCode = 1
} finally {
	try { ws && ws.close() } catch { /* 忽略 */ }
	try { edge.kill() } catch { /* 忽略 */ }
}
