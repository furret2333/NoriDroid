// 真实 Vue 页面 + 假渲染器/原生桥；不依赖未随仓库提供的模型，不调用外部 API。
import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {createServer} from "vite"

const root = path.resolve(import.meta.dirname, "..")
const port = 9483
const profile = mkdtempSync(path.join(tmpdir(), "nori-touch-ui-"))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const oldArea = {id: "legacy", name: "脸颊", type: "swipe", x: .12, y: .16, w: .44, h: .18, image: "", prompt: "脸颊左侧"}
const seed = {apiKey: "fake-key", baseUrl: "https://api.probe.test", model: "fake", ambientEnabled: false, dataseaBg: false, memoryLlmExtract: false, smartRecall: false, emotionLlm: false}
const shim = `
localStorage.setItem("intro_seen_v1", "1"); localStorage.setItem("storage_asked", "1");
if (!localStorage.getItem("l2d_touch_ARGNori")) localStorage.setItem("l2d_touch_ARGNori", ${JSON.stringify(JSON.stringify({version: 1, touches: [oldArea]}))});
window.__requests = []; window.__hold = false; window.__head = false;
window.NoriBridge = {listInstalled: () => JSON.stringify([{id: "ARGNori", entryBase: "ARGNori"}])};
window.__files = {"settings.json": ${JSON.stringify(JSON.stringify(seed))}};
window.NoriChat = {
 readFile: n => window.__files[n] || "", writeFile: (n, v) => { window.__files[n] = v; return "ok" },
 isStorageReady: () => true, hasAllFilesAccess: () => true, getStorageDir: () => "test",
 chatStream: (_url, _key, _model, json) => { window.__requests.push(JSON.parse(json)); if (!window.__hold) setTimeout(window.__finish, 80) },
 chat: () => setTimeout(() => window.__noriChatRes?.(JSON.stringify({ok: true, content: "{}"})), 5),
 chatStop: () => {}, ttsStop: () => {}, cosyTtsStop: () => {}
};
window.__finish = () => { window.__noriChatDelta?.("轻轻回应一下。"); window.__noriChatDone?.(JSON.stringify({ok: true, content: "轻轻回应一下。"})) };
window.__noriHitTest = () => ({hit: true});
const realFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
 const url = new URL(typeof input === "string" ? input : input.url, location.href);
 if (url.pathname.endsWith(".model3.json")) return Promise.resolve(new Response(JSON.stringify({FileReferences: {Motions: {}, Expressions: []}})));
 if (url.origin !== location.origin) return Promise.resolve(new Response(JSON.stringify({list: [], data: [{id: "fake"}]})));
 return realFetch(input, options);
};
`
const fakeRenderer = `
export {readModelConfig, writeModelConfig} from "/src/services/live2d/config.ts";
export {L2D_FPS_OPTIONS, normalizeFps} from "/src/services/live2d/frameCap.ts";
export {normalizeRenderScale} from "/src/services/live2d/renderScale.ts";
export const createLive2D = () => {
 let cv;
 const noop = () => {};
 return {mount: async (_spec, options) => { cv = document.createElement("canvas"); cv.width = innerWidth; cv.height = innerHeight; options.host.appendChild(cv); },
 canvas: () => cv, destroy: async () => cv?.remove(), getMotions: async () => [],
 lookAt: noop, resetLook: noop, playExpression: noop, stopExpression: noop, playMotionByIndex: noop, playMotionByName: noop,
 pauseRender: noop, applyFrameCap: noop, setRenderScale: noop};
};`
let server, edge, ws, seq = 0, passed = 0
const pending = new Map(), errors = []
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = ++seq
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
	pending.set(id, {resolve, reject, timer})
	ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
})
const until = async (fn, label) => { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await sleep(80) } throw new Error(`Timeout: ${label}`) }
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`PASS ${name}`) }
try {
	server = await createServer({root, configFile: path.join(root, "vite.config.ts"), server: {host: "127.0.0.1", port: 5188, strictPort: true}, plugins: [{
		name: "touch-ui-fakes", enforce: "pre",
		resolveId(source, importer) { if (source === "./services/live2d" && importer?.includes("App.vue")) return "\0touch-ui-renderer" },
		load(id) { if (id === "\0touch-ui-renderer") return fakeRenderer },
		transformIndexHtml() { return [{tag: "script", children: shim, injectTo: "head-prepend"}] },
	}]})
	await server.listen()
	edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], {stdio: "ignore", windowsHide: true})
	let debugUrl
	await until(async () => { try { debugUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; return !!debugUrl } catch { return false } }, "Edge")
	ws = new WebSocket(debugUrl)
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
	ws.onmessage = event => { const m = JSON.parse(event.data); if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); const p = pending.get(m.id); if (!p) return; clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
	const {targetId} = await send("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
	await send("Runtime.enable", {}, sessionId); await send("Page.enable", {}, sessionId)
	await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true}, sessionId)
	const js = async expression => { const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value }
	const click = async (selector, text) => { check(`可操作：${text}`, await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.includes(${JSON.stringify(text)})); if (!b || b.disabled) return false; b.click(); return true })()`)); await sleep(100) }
	const pointer = async (type, x, y, id = 1) => js(`document.querySelector(".stage-root").dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {pointerId:${id},clientX:${x},clientY:${y},button:0,buttons:${type === "pointerup" || type === "pointercancel" ? 0 : 1},bubbles:true}))`)
	const box = () => js('(() => { const r = document.querySelector(".touch-area-box").getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2} })()')
	const stored = () => js('JSON.parse(localStorage.getItem("l2d_touch_ARGNori"))')
	const open = async () => {
		await js('document.querySelector(".side-rail-handle")?.click()')
		await click(".side-action,.fab", "设置")
		check("摸头入口是与日常偏好平级的独立卡片", await js('(() => { const c=document.querySelector(".settings-basic-group-touch"); const p=document.querySelector(".settings-basic-group-preferences");return !!c && c.parentElement===p.parentElement && !p.contains(c) && c.querySelector("h3").textContent==="摸头与自定义触摸" && getComputedStyle(c).borderStyle===getComputedStyle(p).borderStyle })()'))
		await click(".settings-basic-group-touch button", "打开互动设置")
	}
	await send("Page.navigate", {url: "http://127.0.0.1:5188"}, sessionId)
	await until(() => js('!!document.querySelector(".l2d-host canvas") && !document.querySelector(".topbar .loading")'), "App mounted")
	await sleep(400)
	check("侧栏移除旧触摸入口", await js('[...document.querySelectorAll(".side-action")].every(b=>!b.textContent.includes("触摸"))'))
	await open()
	check("内置摸头四项反馈默认开启", await js('document.querySelectorAll(".touch-option-grid input:checked").length === 4'))
	check("自定义区域默认折叠", await js('!document.querySelector(".touch-custom").open'))
	check("互动页移除语音设置入口", await js('![...document.querySelectorAll(".touch-page button")].some(b=>b.textContent.includes("语音设置"))'))
	await js('document.querySelector(".touch-option-grid input").click()')
	check("表情开关独立持久化，不改变其他三项", await js('(() => { const s=JSON.parse(window.NoriChat.readFile("settings.json"));return s.petTouchEnabled===false && s.petTouchEffects && s.petTouchSound && s.petTouchSpeech })()'))
	await js('document.querySelector(".touch-option-grid input").click(); document.querySelector(".touch-custom summary").click()'); await sleep(100)
	check("进阶原位展开，保留摸头说明和反馈开关", await js('(() => { const editor=document.querySelector(".touch-editor");const intro=editor.querySelector(".touch-intro"); const options=editor.querySelector(".touch-pet-options"); const details=editor.querySelector(".touch-custom");return details.open && intro.offsetHeight>0 && options.offsetHeight>0 && options.compareDocumentPosition(details)&Node.DOCUMENT_POSITION_FOLLOWING && !!details.querySelector(".touch-manager") })()'))
	check("旧区域名称和说明正确展示", await js('document.querySelector(".tm-list").textContent.includes("脸颊左侧")'))
	await click(".tm-actions button", "编辑")
	await js('(() => { const i=document.querySelector(".tm-edit input[type=range]"); i.value="0.3"; i.dispatchEvent(new Event("input",{bubbles:true})) })()'); await sleep(80)
	check("调整尺寸实时预览但尚未落盘", (await box()).w < 150 && (await stored()).touches[0].w === oldArea.w)
	await click(".tm-edit-actions button", "取消")
	check("取消恢复原尺寸", Math.abs((await box()).w - 390 * 1.12 * oldArea.w) < 2)
	await click(".tm-actions button", "编辑")
	await js('(() => { const i=document.querySelector(".tm-edit input[type=text]"); i.value="左脸颊"; i.dispatchEvent(new Event("input",{bubbles:true})); const t=document.querySelector(".tm-edit textarea");t.value="有点痒，短短回应一句";t.dispatchEvent(new Event("input",{bubbles:true})); })()')
	await click(".tm-edit-actions button", "保存")
	check("名称与 AI 反应独立保存，保留旧说明", (await stored()).touches[0].name === "左脸颊" && (await stored()).touches[0].reactionPrompt.includes("有点痒") && (await stored()).touches[0].prompt === oldArea.prompt)
	await click(".tm-tools button", "调整位置")
	let b = await box(); await pointer("pointerdown", b.cx, b.cy); await pointer("pointermove", b.cx + 24, b.cy + 15); await pointer("pointerup", b.cx + 24, b.cy + 15)
	check("拖动可预览位置，松手不会直接保存", (await box()).x > b.x + 20 && (await stored()).touches[0].x === oldArea.x)
	await click(".tm-edit-actions button", "取消")
	b = await box(); await pointer("pointerdown", b.x+b.w-12, b.y+b.h-12); await pointer("pointermove", b.x+b.w+8, b.y+b.h+8); await pointer("pointerup", b.x+b.w+8, b.y+b.h+8)
	check("右下角可拖动缩放", (await box()).w > b.w + 15)
	await click(".tm-edit-actions button", "保存")
	check("保存后尺寸写入模型配置", (await stored()).touches[0].w > oldArea.w)
	await click(".tm-tools button", "完成调整")
	await click(".tm-actions button", "删除"); check("删除立即生效", (await stored()).touches.length === 0)
	await click(".tm-head button", "撤销删除"); check("撤销恢复原区域", (await stored()).touches[0].id === "legacy")
	await click(".tm-tools button", "试用命中")
	b = await box(); await pointer("pointerdown", b.cx, b.cy); await pointer("pointerup", b.cx, b.cy)
	check("命中试用只显示结果、不调用 AI", await js('window.__requests.length===0 && document.querySelector(".touch-feedback").textContent.includes("命中")'))
	await click(".tm-tools button", "结束试用")
	await js('window.__hold=true')
	await click(".tm-actions button", "试 AI 一次")
	check("显式 AI 测试仅发一次并禁用忙碌按钮", await js('window.__requests.length===1 && document.querySelector(".tm-actions button").disabled'))
	check("合成动作不包含反应要求，要求放独立上下文", await js('(() => { const p=window.__requests[0]; return p.at(-1).content.includes("左脸颊") && !p.at(-1).content.includes("有点痒") && p.some(m=>m.role==="system" && m.content.includes("有点痒")) })()'))
	await js('window.__hold=false;window.__finish()'); await sleep(180)
	check("测试回复在互动设置内可见", await js('document.querySelector(".touch-ai-preview").textContent.includes("轻轻回应一下")'))
	await click(".tm-actions button", "试 AI 一次"); check("显式测试遵守区域冷却", await js('window.__requests.length===1 && document.querySelector(".tm-cooldown").textContent.includes("秒")'))
	await click(".tm-tools button", "试用命中"); b = await box(); await pointer("pointerdown", b.cx, b.cy); await pointer("pointerup", b.cx, b.cy)
	check("AI 冷却中仍可免费试用命中", await js('window.__requests.length===1 && document.querySelector(".touch-feedback").textContent.includes("命中")'))
	await click(".tm-tools button", "结束试用")
	await click(".tm-actions button", "编辑")
	await js('(() => { const i=document.querySelector(".tm-edit input[type=range]");i.value="0.2";i.dispatchEvent(new Event("input",{bubbles:true})) })()')
	await click(".touch-top button", "✕"); await open(); await js('if(!document.querySelector(".touch-custom").open) document.querySelector(".touch-custom summary").click()'); await sleep(80)
	check("离开页面取消未保存的几何调整", (await box()).w > 180)
	await click(".tm-tools button", "＋ 新增区域")
	await pointer("pointerdown", 245, 140); await pointer("pointermove", 315, 245); await pointer("pointercancel", 315, 245)
	check("框选被系统取消时不产生新区域", await js('!document.querySelector(".tm-new") && JSON.parse(localStorage.getItem("l2d_touch_ARGNori")).touches.length===1'))
	await pointer("pointerdown", 245, 140); await pointer("pointermove", 315, 245); await pointer("pointerup", 315, 245); await sleep(80)
	check("框选完成出现新区域表单", await js('!!document.querySelector(".tm-new")'))
	await js('window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error("quota")}')
	await click(".tm-new button", "添加")
	check("新增保存失败保留草稿，不产生未保存区域", await js('!!document.querySelector(".tm-new") && document.querySelectorAll(".tm-item").length===1 && JSON.parse(localStorage.getItem("l2d_touch_ARGNori")).touches.length===1'))
	await js('Storage.prototype.setItem=window.__setItem')
	await click(".tm-new button", "添加")
	check("新区域保存到当前模型", (await stored()).touches.length === 2)
	await click(".tm-actions button", "编辑")
	const beforeFailure = await stored()
	await js('window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error("quota")};document.querySelector(".tm-edit input[type=text]").value="未保存";document.querySelector(".tm-edit input[type=text]").dispatchEvent(new Event("input",{bubbles:true}))')
	await click(".tm-edit-actions button", "保存")
	check("存储失败保留编辑表单并显示失败", await js('!!document.querySelector(".tm-edit") && document.querySelector(".touch-feedback").textContent.includes("保存失败")'))
	await js('Storage.prototype.setItem=window.__setItem')
	check("存储失败不篡改已保存配置", JSON.stringify(await stored()) === JSON.stringify(beforeFailure))
	await click(".tm-edit-actions button", "取消")
	const shot = await send("Page.captureScreenshot", {format: "png"}, sessionId)
	writeFileSync(path.join(root, "tmp-memcheck/_touch-settings-portrait.png"), Buffer.from(shot.data, "base64"))
	b = await box()
	await js('document.querySelector(".touch-custom summary").click()'); await sleep(80)
	await js('document.querySelector(".touch-option-grid input").click()')
	await click(".touch-top button", "✕")
	await js('window.__realNow=Date.now;Date.now=()=>window.__realNow()+20000')
	const beforePet = await js('window.__requests.length')
	const fxBefore = await js('window.__noriPetFxSpawned().mote')
	await pointer("pointerdown", b.cx, b.cy); await sleep(330); await pointer("pointerup", b.cx, b.cy)
	check("长按摸头优先，松手不再追加 AI 回复", await js(`window.__requests.length===${beforePet}`))
	check("关闭表情轻摆不影响独立开启的柔光", await js(`window.__noriPetFxSpawned().mote>${fxBefore}`))
	await pointer("pointerdown", b.cx, b.cy); await pointer("pointerup", b.cx, b.cy); await sleep(130)
	check("短按头部仍可触发自定义区域", await js(`window.__requests.length===${beforePet + 1}`))
	await js('Date.now=()=>window.__realNow()+40000')
	const beforeCancel = await js('window.__requests.length')
	await pointer("pointerdown", b.cx, b.cy); await pointer("pointercancel", b.cx, b.cy)
	await pointer("pointerdown", b.cx, b.cy); await pointer("pointerdown", b.cx+10, b.cy+10, 2); await pointer("pointerup", b.cx+10, b.cy+10, 2); await pointer("pointerup", b.cx, b.cy)
	await pointer("pointerdown", b.cx, b.cy); await js('window.dispatchEvent(new Event("blur"))'); await pointer("pointerup", b.cx, b.cy)
	check("取消、双指和失焦均不会误触发 AI", await js(`window.__requests.length===${beforeCancel}`))
	await js('window.__hold=true')
	await pointer("pointerdown", b.cx, b.cy); await pointer("pointerup", b.cx, b.cy)
	await pointer("pointerdown", b.cx, b.cy); await pointer("pointerup", b.cx, b.cy)
	check("回复生成时再次触摸直接跳过", await js(`window.__requests.length===${beforeCancel + 1}`))
	await js('window.__hold=false;window.__finish()'); await sleep(140)
	check("跳过的触摸不排队、不补发", await js(`window.__requests.length===${beforeCancel + 1}`))
	await open()
	await send("Emulation.setDeviceMetricsOverride", {width: 900, height: 500, deviceScaleFactor: 1, mobile: true}, sessionId); await sleep(180)
	check("横屏编辑器位于右侧，保留模型操作空间", await js('(() => { const r=document.querySelector(".touch-editor").getBoundingClientRect();return r.left>450 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1 })()'))
	await click(".touch-top button", "✕")
	check("横屏导航五个入口均分，无第六列留白", await js('(() => { const dock=document.querySelector(".dock");const buttons=[...dock.querySelectorAll(".fab")];const style=getComputedStyle(dock);const r=dock.getBoundingClientRect();const first=buttons[0].getBoundingClientRect();const last=buttons.at(-1).getBoundingClientRect();const innerRight=r.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth);const innerLeft=r.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth);return buttons.length===5 && style.gridTemplateColumns.split(" ").length===5 && Math.abs(last.right-innerRight)<1 && Math.abs(first.left-innerLeft)<1 && r.width<500 })()'))
	check("页面无未处理异常", errors.length === 0)
	console.log(`\n${passed} touch UI checks passed (fake renderer; no external API)`)
} catch (error) { console.error(error); process.exitCode = 1 }
finally { for (const p of pending.values()) clearTimeout(p.timer); ws?.close(); edge?.kill(); await server?.close() }
