// Real Vue App + production native controls/visibility wiring; no external API.
// --baseline swaps only App.vue for the snapshot frozen before stage8.
import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {createServer} from "vite"

const root = path.resolve(import.meta.dirname, "..")
const baseline = process.argv.includes("--baseline")
const appBefore = baseline ? readFileSync(path.join(root, "tmp-memcheck/_mock/App-stage8-before.vue"), "utf8") : null
const webPort = 5198, debugPort = 9498
const profile = mkdtempSync(path.join(tmpdir(), "nori-resume-ui-"))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const seed = {
	apiKey: "fake-resume-key", baseUrl: "https://api.resume.test", model: "fake-resume",
	ambientEnabled: false, backgroundMode: "off", dataseaBg: false, presenceEnabled: false,
	memoryLlmExtract: false, memoryRealtimeExtract: false, smartRecall: false,
	emotionLlm: false, petTouchSpeech: false, floatEnabled: false, floatRenderScale: 2,
}
const shim = `
localStorage.setItem("intro_seen_v1","1");localStorage.setItem("storage_asked","1");
window.__resumeState={
 hidden:false,permission:false,allFiles:false,storageReady:true,
 reads:0,storageChecks:0,permissionChecks:0,permissionRequests:0,allFilesRequests:0,
 floatEnabled:[],floatScales:[],floatHides:0,floatResets:0,
 renderPaused:null,renderCalls:[],ttsStops:0,cosyStops:0,chatStops:0,probes:[]
};
Object.defineProperty(document,"hidden",{configurable:true,get:()=>window.__resumeState.hidden});
window.__files={"settings.json":${JSON.stringify(JSON.stringify(seed))}};
window.__requests=[];
window.NoriBridge={listInstalled:()=>JSON.stringify([{id:"ARGNori",entryBase:"ARGNori"}])};
window.NoriChat={
 readFile:n=>{window.__resumeState.reads++;return window.__files[n]||""},
 writeFile:(n,v)=>{window.__files[n]=v;return "ok"},
 isStorageReady:()=>{window.__resumeState.storageChecks++;return window.__resumeState.storageReady},
 hasAllFilesAccessJs:()=>window.__resumeState.allFiles,
 getStorageDir:()=>"Download/ResumeFixture",
 requestAllFilesAccess:()=>window.__resumeState.allFilesRequests++,
 requestStoragePermission:()=>{},
 probePublicFiles:n=>{
  window.__resumeState.probes.push(n);
  return JSON.stringify({onDisk:true,fileBytes:123,fileReadable:true,inMediaStore:false,
   mediaStoreBytes:0,allFilesAccess:window.__resumeState.allFiles,
   dir:"Download/ResumeFixture",dirExists:true,dirReadable:true,listed:["chat.json"]});
 },
 canFloat:()=>{window.__resumeState.permissionChecks++;return window.__resumeState.permission},
 requestFloatPermission:()=>window.__resumeState.permissionRequests++,
 setFloatEnabled:v=>window.__resumeState.floatEnabled.push(v),
 hideFloat:()=>window.__resumeState.floatHides++,
 resetFloatWindow:()=>window.__resumeState.floatResets++,
 setFloatRenderScale:v=>window.__resumeState.floatScales.push(v),
 chat:()=>setTimeout(()=>window.__noriChatRes?.(JSON.stringify({ok:true,content:"{}"})),5),
 chatStream:(_url,_key,_model,json)=>window.__requests.push(JSON.parse(json)),
 chatStop:()=>window.__resumeState.chatStops++,
 ttsStop:()=>window.__resumeState.ttsStops++,
 cosyTtsStop:()=>window.__resumeState.cosyStops++
};
window.__noriHitTest=()=>({hit:true});
window.__emit=delta=>window.__noriChatDelta?.(delta);
window.__done=content=>window.__noriChatDone?.(JSON.stringify({ok:true,content}));
const realFetch=window.fetch.bind(window);
window.fetch=(input,options)=>{
 const url=new URL(typeof input==="string"?input:input.url,location.href);
 if(url.pathname.endsWith(".model3.json"))return Promise.resolve(new Response(JSON.stringify({FileReferences:{Motions:{},Expressions:[]}})));
 if(url.origin!==location.origin)return Promise.resolve(new Response(JSON.stringify({list:[],data:[]})));
 return realFetch(input,options);
};
`
const fakeRenderer = `
export {readModelConfig,writeModelConfig} from "/src/services/live2d/config.ts";
export {L2D_FPS_OPTIONS,normalizeFps} from "/src/services/live2d/frameCap.ts";
export {normalizeRenderScale} from "/src/services/live2d/renderScale.ts";
export const createLive2D=()=>{let cv;const noop=()=>{};return {
 mount:async(_spec,options)=>{cv=document.createElement("canvas");cv.width=innerWidth;cv.height=innerHeight;options.host.appendChild(cv)},
 canvas:()=>cv,destroy:async()=>cv?.remove(),getMotions:async()=>[],
 lookAt:noop,resetLook:noop,playExpression:noop,stopExpression:noop,playMotionByIndex:noop,playMotionByName:noop,
 pauseRender:paused=>{window.__resumeState.renderPaused=paused;window.__resumeState.renderCalls.push(paused)},
 applyFrameCap:noop,setRenderScale:noop
}};`
let server, edge, ws, seq = 0, passed = 0
const pending = new Map(), errors = []
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = ++seq
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
	pending.set(id, {resolve, reject, timer})
	ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
})
const until = async (fn, label) => {
	const end = Date.now() + 20000
	while (Date.now() < end) { if (await fn()) return; await sleep(80) }
	throw new Error(`Timeout: ${label}`)
}
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`PASS ${name}`) }
try {
	server = await createServer({root, configFile: path.join(root, "vite.config.ts"), server: {host: "127.0.0.1", port: webPort, strictPort: true}, plugins: [{
		name: "resume-ui-fakes", enforce: "pre",
		resolveId(source, importer) { if (source === "./services/live2d" && importer?.includes("App.vue")) return "\0resume-ui-renderer" },
		load(id) { if (id === "\0resume-ui-renderer") return fakeRenderer; if (appBefore && id.replaceAll("\\", "/").endsWith("/src/App.vue")) return appBefore },
		transform(code, id) {
			if (id.replaceAll("\\", "/").endsWith("/src/main.ts")) {
				return code.replace('createApp(App).mount("#app")', 'window.__resumeApp = createApp(App); window.__resumeApp.mount("#app")')
			}
		},
		transformIndexHtml() { return [{tag: "script", children: shim, injectTo: "head-prepend"}] },
	}]})
	await server.listen()
	edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], {stdio: "ignore", windowsHide: true})
	let debugUrl
	await until(async () => { try { debugUrl = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl; return !!debugUrl } catch { return false } }, "Edge")
	ws = new WebSocket(debugUrl)
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
	ws.onmessage = event => {
		const message = JSON.parse(event.data)
		if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
		const item = pending.get(message.id)
		if (!item) return
		clearTimeout(item.timer); pending.delete(message.id)
		message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result)
	}
	const {targetId} = await cdp("Target.createTarget", {url: "about:blank"})
	const {sessionId} = await cdp("Target.attachToTarget", {targetId, flatten: true})
	await cdp("Runtime.enable", {}, sessionId); await cdp("Page.enable", {}, sessionId)
	await cdp("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true}, sessionId)
	const js = async expression => {
		const result = await cdp("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sessionId)
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
		return result.result.value
	}
	const state = () => js("window.__resumeState")
	const tick = async expression => { await js(expression); await sleep(100) }
	const pause = () => tick('window.__noriAppPaused=true;window.dispatchEvent(new Event("nori-app-pause"))')
	const resume = () => tick('window.__noriAppPaused=false;window.dispatchEvent(new Event("nori-app-resume"))')
	const hidden = value => tick(`window.__resumeState.hidden=${value};document.dispatchEvent(new Event("visibilitychange"))`)
	const focus = () => tick('window.dispatchEvent(new Event("focus"))')
	const settings = () => tick('[...document.querySelectorAll("button")].find(b=>b.querySelector(".fab-label")?.textContent==="设置").click()')
	const floatToggle = () => tick('document.querySelector(".settings-basic-group-float input[type=checkbox]").click()')
	const floatHint = text => js(`document.querySelector(".settings-basic-group-float .hint").textContent.includes(${JSON.stringify(text)})`)
	const checked = () => js('document.querySelector(".settings-basic-group-float input[type=checkbox]").checked')
	const saved = () => js('JSON.parse(window.__files["settings.json"])')
	const storageText = () => js('document.querySelector(".settings-basic-group-memory").textContent')
	const sendText = text => tick(`(() => {const input=document.querySelector(".chat-input input");input.value=${JSON.stringify(text)};input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))})()`)
	const count = n => until(() => js(`window.__requests.length===${n}`), `request ${n}`)
	const chatText = () => js('document.querySelector(".chat-msgs").textContent')
	const finish = async content => {
		await tick(`window.__done(${JSON.stringify(content)})`)
		await until(() => js('!window.__noriDiagChat().typing && !window.__noriDiagChat().chatStreaming && !document.querySelector(".send.stop")'), "chat idle")
	}
	await cdp("Page.navigate", {url: `http://127.0.0.1:${webPort}`}, sessionId)
	await until(() => js('!!window.__noriDiagChat && !!document.querySelector(".l2d-host canvas") && !!document.querySelector(".chat-input input")'), "App mounted")
	check("mount starts no chat request and leaves the renderer active", await js("window.__requests.length===0 && window.__resumeState.renderPaused===false"))
	await settings()
	check("settings hydrate the disabled floating flag and denied permission", !await checked() && (await state()).floatEnabled.at(-1) === false && await floatHint("尚未获得"))
	await floatToggle()
	check("denied toggle restores checkbox and persists the disabled native flag", !await checked() && (await saved()).floatEnabled === false && (await state()).floatEnabled.at(-1) === false)
	check("denied toggle opens native permission request and displays pending feedback", (await state()).permissionRequests === 1 && await floatHint("等待系统授权"))
	await resume()
	check("returning without permission settles the pending toggle as denied", !await checked() && await floatHint("尚未获得") && (await state()).floatHides > 0)
	await floatToggle()
	await js("window.__resumeState.permission=true")
	await resume()
	check("granted permission on resume completes the pending enable", await checked() && (await saved()).floatEnabled === true && (await state()).floatEnabled.at(-1) === true && await floatHint("已授权"))
	await js("window.__resumeState.permission=false")
	await resume()
	check("revoked permission disables and persists the floating flag", !await checked() && (await saved()).floatEnabled === false && (await state()).floatEnabled.at(-1) === false && await floatHint("已被撤销"))
	await tick('document.querySelector(".settings-basic-group-float button").click()')
	check("reset action reaches the native floating window bridge", (await state()).floatResets === 1)
	await tick('document.querySelector(".settings-basic-group-memory .row-inline button").click()')
	check("storage permission action reaches the native bridge", (await state()).allFilesRequests === 1)
	const beforeFocus = await state()
	await js("window.__resumeState.allFiles=true")
	await focus()
	check("focus refreshes granted storage status in the open settings", (await storageText()).includes("（已授权）") && (await state()).storageChecks > beforeFocus.storageChecks)
	check("focus does not change renderer or query floating permission", (await state()).renderCalls.length === beforeFocus.renderCalls.length && (await state()).permissionChecks === beforeFocus.permissionChecks)
	await js("window.__resumeState.allFiles=false")
	await focus()
	check("focus also refreshes revoked storage access", (await storageText()).includes("（未授权）"))
	await tick('[...document.querySelectorAll("[role=tab]")].find(b=>b.textContent==="进阶设置").click()')
	await tick('(() => {const row=[...document.querySelectorAll(".settings-row")].find(r=>r.querySelector("label")?.textContent.startsWith("悬浮窗渲染分辨率"));const input=row.querySelector("input");input.value="1.3";input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}))})()')
	check("floating render scale persists and reaches native code", (await saved()).floatRenderScale === 1.3 && (await state()).floatScales.at(-1) === 1.3)
	await js("window.__resumeState.allFiles=true")
	await tick('[...document.querySelectorAll("#settings-storage button")].find(b=>b.textContent==="自检").click()')
	const probeNames = ["chat.json", "memory.json", "settings.json", "nori-diary.json", "nori-diary.json.bak", "nori-diary-src.json"]
	check("storage probe asks native code for all six public files", JSON.stringify((await state()).probes) === JSON.stringify(probeNames))
	check("storage probe renders native file diagnostics and updates access state", await js('document.querySelector(".store-probe").textContent.includes("123 字节") && document.querySelector(".store-probe").textContent.includes("Download/ResumeFixture") && document.querySelector("#settings-storage").textContent.includes("已授权 ✓")'))
	await settings()
	await tick('document.querySelector(".history-toggle").click()')

	const beforePause = await state()
	await pause()
	check("native pause stops rendering and TTS without cancelling chat", (await state()).renderPaused === true && (await state()).ttsStops > beforePause.ttsStops && (await state()).chatStops === beforePause.chatStops)
	await hidden(false)
	check("visible document does not override a native pause", (await state()).renderPaused === true)
	await hidden(true)
	await resume()
	check("native resume does not override a hidden document", (await state()).renderPaused === true)
	await hidden(false)
	check("clearing both pause reasons resumes rendering", (await state()).renderPaused === false)
	await pause()
	await js('window.__files["chat.json"]=JSON.stringify([{role:"assistant",content:"Shared floating history",ts:Date.now()-10000}])')
	await resume()
	check("idle resume imports history written by the floating window", (await chatText()).includes("Shared floating history"))

	await sendText("typed resume"); await count(1)
	await tick('window.__emit("Typed before ")')
	await js('window.__resumeTypedBubble=[...document.querySelectorAll(".bubble-wrap.assistant")].at(-1)')
	const beforeTypedPause = await state()
	await pause()
	check("pause preserves a typed stream while immediately stopping TTS", await js("window.__noriDiagChat().typing && window.__noriDiagChat().chatStreaming") && (await state()).chatStops === beforeTypedPause.chatStops && (await state()).ttsStops > beforeTypedPause.ttsStops)
	await resume()
	await tick('window.__emit("and after resume")')
	// The baseline mutates a raw liveBubble: history state advances before Vue
	// refreshes its text at completion. Check continuity without requiring a new render.
	check("typed stream keeps its history record and bubble across resume", await js('window.__noriDiagChat().lastRoles.at(-1)==="assistant:Typed before and aft" && window.__resumeTypedBubble===[...document.querySelectorAll(".bubble-wrap.assistant")].at(-1) && window.__noriDiagChat().msgCount===3'))
	await finish("unused typed fallback")
	check("typed reply completes after resume", (await chatText()).includes("Typed before and after resume") && await js('!document.querySelector(".send.stop")'))
	await tick('document.querySelector(".poke").click()'); await count(2)
	await tick('window.__emit("Touch before ")')
	await js('window.__resumeTouchBubble=[...document.querySelectorAll(".bubble-wrap.assistant")].at(-1)')
	const beforeTouchPause = await state()
	await pause()
	await resume()
	await tick('window.__emit("and after resume")')
	check("touch stream keeps its history record and bubble across resume without cancellation", await js('window.__noriDiagChat().lastRoles.at(-1)==="assistant:Touch before and aft" && window.__resumeTouchBubble===[...document.querySelectorAll(".bubble-wrap.assistant")].at(-1) && window.__noriDiagChat().msgCount===5') && (await state()).chatStops === beforeTouchPause.chatStops)
	await finish("unused touch fallback")
	check("touch reply completes after resume", (await chatText()).includes("Touch before and after resume") && await js('!document.querySelector(".send.stop")'))
	await js("window.__resumeApp.unmount()")
	await until(() => js('!document.querySelector(".l2d-host canvas")'), "App unmounted")
	await sleep(250)
	const afterUnmount = await state()
	await js('window.dispatchEvent(new Event("focus"));window.__noriAppPaused=true;window.dispatchEvent(new Event("nori-app-pause"));window.__noriAppPaused=false;window.dispatchEvent(new Event("nori-app-resume"));document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new Event("resize"))')
	await sleep(150)
	const afterEvents = await state()
	check("unmount removes storage, visibility and native pause listeners", afterEvents.storageChecks === afterUnmount.storageChecks && afterEvents.permissionChecks === afterUnmount.permissionChecks && afterEvents.renderCalls.length === afterUnmount.renderCalls.length && afterEvents.ttsStops === afterUnmount.ttsStops)
	check("no unhandled page exception", errors.length === 0)
	console.log(`\n${passed} App resume checks passed (${baseline ? "stage8 baseline" : "current App"}; fake native bridge/renderer; no external API)`)
} catch (error) {
	console.error(error); if (errors.length) console.error(errors)
	process.exitCode = 1
} finally {
	for (const item of pending.values()) clearTimeout(item.timer)
	ws?.close(); edge?.kill(); await server?.close()
}
