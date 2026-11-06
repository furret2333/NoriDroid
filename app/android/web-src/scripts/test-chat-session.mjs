// Real Vue + production chat transport; native stream completion stays under test control.
// --baseline replaces only App.vue with the local snapshot frozen before stage7.
import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {createServer} from "vite"

const root = path.resolve(import.meta.dirname, "..")
const baseline = process.argv.includes("--baseline")
const appBefore = baseline ? readFileSync(path.join(root, "tmp-memcheck/_mock/App-stage7-before.vue"), "utf8") : null
const webPort = 5197, debugPort = 9497
const profile = mkdtempSync(path.join(tmpdir(), "nori-session-ui-"))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const seed = {apiKey: "fake-session-key", baseUrl: "https://api.session.test", model: "fake-session", ambientEnabled: false, backgroundMode: "off", dataseaBg: false, memoryLlmExtract: false, memoryRealtimeExtract: false, smartRecall: false, emotionLlm: false, petTouchSpeech: false}
const shim = `
localStorage.setItem("intro_seen_v1","1"); localStorage.setItem("storage_asked","1");
window.NoriBridge={listInstalled:()=>JSON.stringify([{id:"ARGNori",entryBase:"ARGNori"}])};
window.__files=JSON.parse(localStorage.getItem("__session_files")||"{}");
window.__files["settings.json"]=${JSON.stringify(JSON.stringify(seed))};
window.__requests=[]; window.__stops=0; window.__pickCancel=false;
window.NoriChat={
 readFile:n=>window.__files[n]||"",
 writeFile:(n,v)=>{window.__files[n]=v;localStorage.setItem("__session_files",JSON.stringify(window.__files));return "ok"},
 isStorageReady:()=>true,hasAllFilesAccess:()=>true,getStorageDir:()=>"test",
 chat:()=>setTimeout(()=>window.__noriChatRes?.(JSON.stringify({ok:true,content:"{}"})),5),
 chatStream:(_url,_key,_model,json)=>window.__requests.push(JSON.parse(json)),
 chatStop:()=>window.__stops++,ttsStop:()=>{},cosyTtsStop:()=>{},
 pickImageFile:requestId=>setTimeout(()=>window.__noriImagePickedRes?.(JSON.stringify(window.__pickCancel
  ? {ok:false,requestId,message:"未选择图片"}
  : {ok:true,requestId,dataUrl:window.__imageData,mime:"image/png",width:20,height:40,size:100})),20),
};
window.__noriHitTest=()=>({hit:true});
window.__emit=delta=>window.__noriChatDelta?.(delta);
window.__done=content=>window.__noriChatDone?.(JSON.stringify({ok:true,content}));
window.__fail=message=>window.__noriChatError?.(JSON.stringify({message}));
const image=document.createElement("canvas");image.width=20;image.height=40;image.getContext("2d").fillRect(0,0,20,40);window.__imageData=image.toDataURL("image/png");
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
 pauseRender:noop,applyFrameCap:noop,setRenderScale:noop
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
const body = text => typeof text === "string" ? text.replace(/^【消息发送时间】[^\n]+\n/, "") : text
try {
	server = await createServer({root, configFile: path.join(root, "vite.config.ts"), server: {host: "127.0.0.1", port: webPort, strictPort: true}, plugins: [{
		name: "session-ui-fakes", enforce: "pre",
		resolveId(source, importer) { if (source === "./services/live2d" && importer?.includes("App.vue")) return "\0session-ui-renderer" },
		load(id) { if (id === "\0session-ui-renderer") return fakeRenderer; if (appBefore && id.replaceAll("\\", "/").endsWith("/src/App.vue")) return appBefore },
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
	const requests = () => js("window.__requests")
	const last = async () => (await requests()).at(-1)
	const assistant = () => js('[...document.querySelectorAll(".bubble-wrap.assistant")].filter(e=>!e.querySelector(".typing")).map(e=>e.textContent)')
	const sendText = async (text, options = {}) => js(`(() => {const input=document.querySelector(".chat-input input");input.value=${JSON.stringify(text)};input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,...${JSON.stringify(options)}}))})()`)
	const finish = async content => { await js(`window.__done(${JSON.stringify(content)})`); await sleep(120) }
	const idle = () => until(() => js('!window.__noriDiagChat().typing && !window.__noriDiagChat().chatStreaming && !document.querySelector(".send.stop")'), "session idle")
	const count = n => until(() => js(`window.__requests.length===${n}`), `request ${n}`)
	const poke = () => js('document.querySelector(".poke").click()')
	const stop = () => js('document.querySelector(".send.stop").click()')
	const stored = () => js('(() => {const v=JSON.parse(window.NoriChat.readFile("chat.json")||"[]");return Array.isArray(v)?v:v.msgs})()')
	const flush = async () => {
		await js('window.__noriAppPaused=true;window.dispatchEvent(new Event("nori-app-pause"))')
		await js('window.__noriAppPaused=false;window.dispatchEvent(new Event("nori-app-resume"))')
		await sleep(100)
	}
	await cdp("Page.navigate", {url: `http://127.0.0.1:${webPort}`}, sessionId)
	await until(() => js('!!window.__noriDiagChat && !!document.querySelector(".l2d-host canvas") && !!document.querySelector(".chat-input input")'), "App mounted")
	await js('document.querySelector(".history-toggle").click()'); await sleep(250)
	check("mount starts no chat request", (await requests()).length === 0)
	await sendText("first"); await count(1)
	check("typed request marks both typing and streaming busy", await js("window.__noriDiagChat().typing && window.__noriDiagChat().chatStreaming"))
	await sendText("composition", {isComposing: true}); await sleep(100)
	check("IME Enter leaves composition draft and does not queue", await js('document.querySelector(".chat-input input").value==="composition" && !document.querySelector(".queue-hint")'))
	await sendText("second"); await sendText("third")
	check("busy Enter queues two requests without dispatching early", (await requests()).length === 1 && await js('document.querySelector(".queue-hint").textContent.includes("2")'))
	check("accepted queued drafts clear the input", await js('document.querySelector(".chat-input input").value===""'))
	await js('window.__emit("First【表");window.__emit("情:开心】 line。");window.__emit("\\nNext【动作:wave】")')
	let replies = await assistant()
	check("split markers stay hidden across stream deltas", replies.length === 1 && replies[0].includes("First line") && replies[0].includes("Next") && !replies[0].includes("表情") && !replies[0].includes("动作"))
	await finish("ignored final fallback"); await count(2)
	check("FIFO dispatch sends the second draft before the third", body((await last()).at(-1).content) === "second")
	check("each stream owns one assistant history record", (await assistant()).filter(s => s.includes("First line")).length === 1)
	await finish("Second【表情:害羞】 response。"); await count(3)
	check("done-only fallback strips markers before rendering", (await assistant()).some(s => s.includes("Second response") && !s.includes("表情")))
	check("third draft dispatches only after second finishes", body((await last()).at(-1).content) === "third")
	await finish("Third response。"); await idle()
	check("completed queue removes its UI hint", await js('!document.querySelector(".queue-hint")'))

	await sendText("failure-empty"); await count(4); await sendText("after-failure")
	await js('window.__fail("mock-network")'); await count(5)
	check("empty failure displays one warning and releases the queue", (await assistant()).filter(s => s.includes("mock-network")).length === 1 && body((await last()).at(-1).content) === "after-failure")
	await js('window.__emit("Partial survives。");window.__fail("mock-late-failure")'); await idle()
	check("failure after content preserves partial reply without another warning", (await assistant()).some(s => s.includes("Partial survives")) && !(await assistant()).some(s => s.includes("mock-late-failure")))
	await flush()
	check("error warning never enters persisted history", !(await stored()).some(m => m.error || m.content.includes("mock-network")))

	await sendText("stop-typed"); await count(6); await js('window.__emit("Stopped partial。")')
	const stopsBefore = await js("window.__stops")
	await stop(); await idle()
	check("typed stop reaches native cancellation and releases busy state", await js(`window.__stops>${stopsBefore} && !window.__noriDiagChat().typing && !window.__noriDiagChat().chatStreaming`))
	check("typed stop keeps received text without an error warning", (await assistant()).some(s => s.includes("Stopped partial")) && !(await assistant()).some(s => s.includes("已停止")))
	check("cancelled transport removes singleton stream callbacks", await js('!window.__noriChatDelta && !window.__noriChatDone && !window.__noriChatError'))
	await sendText("after-stop"); await count(7); await finish("After stop response。"); await idle()
	check("a new typed stream can finish after cancellation", (await assistant()).some(s => s.includes("After stop response")))

	await poke(); await count(8)
	check("poke uses the touch stream without typed busy state", await js('!window.__noriDiagChat().typing && !!document.querySelector(".send.stop")'))
	await sendText("queued-behind-touch"); await sleep(100)
	check("typed input waits while a touch reply is streaming", (await requests()).length === 8 && await js('document.querySelector(".queue-hint").textContent.includes("1")'))
	await stop(); await count(9)
	check("touch stop releases a queued typed request", body((await last()).at(-1).content) === "queued-behind-touch")
	await finish("Queued after touch。"); await idle()
	check("touch stop does not add an error message", !(await assistant()).some(s => s.includes("已停止")))
	await poke(); await count(10); await js('window.__emit("Touch clean【表")'); await finish("Touch clean【表"); await idle()
	check("unfinished touch marker is discarded at stream completion", (await assistant()).some(s => s === "Touch clean"))
	await sendText("fresh-buffer"); await count(11); await js('window.__emit("Fresh text。")'); await finish("Fresh text。"); await idle()
	check("new typed reply starts with an independent marker buffer", (await assistant()).some(s => s.includes("Fresh text")) && !(await assistant()).some(s => s.includes("表Fresh")))

	const choose = async cancelled => {
		await js(`window.__pickCancel=${cancelled};document.querySelector(".image-entry > button").click()`)
		await js('document.querySelector(".image-menu button").click()')
		await until(() => js('!document.querySelector(".image-menu button").disabled'), "image picker")
	}
	await choose(true)
	check("cancelled picker leaves no pending image and permits another selection", await js('!document.querySelector(".image-preview-row") && !document.querySelector(".image-menu button").disabled'))
	await choose(false)
	check("successful selection shows the pending preview", await js('!!document.querySelector(".image-preview-row .image-preview")'))
	await sendText("look-once"); await count(12)
	let imagePayload = await last()
	check("selected image belongs to the current user payload", Array.isArray(imagePayload.at(-1).content) && imagePayload.at(-1).content.some(p => p.type === "image_url"))
	check("dispatch consumes the pending image while retaining a sent preview", await js('!document.querySelector(".image-preview-row") && document.querySelectorAll(".message-image").length===1'))
	await finish("Image response。"); await idle(); await flush()
	let history = await stored()
	check("persisted image message has a text placeholder and no binary parts", history.some(m => m.role === "user" && m.content === "[图片] look-once") && history.every(m => !m.parts && !JSON.stringify(m).includes("data:image")))
	await sendText("plain-after-image"); await count(13)
	const plainPayload = await last()
	check("later request keeps the earlier image as text-only history", plainPayload.every(m => typeof m.content === "string") && plainPayload.some(m => m.role === "user" && body(m.content) === "[图片] look-once"))
	await finish("Plain response。"); await idle(); await flush()
	check("plain reply and image placeholder both survive persistence", (await stored()).some(m => m.content === "Plain response。") && (await stored()).some(m => m.content === "[图片] look-once"))
	await cdp("Page.reload", {}, sessionId)
	await until(() => js('!!window.__noriDiagChat && !!document.querySelector(".chat-input input")'), "reload")
	await js('document.querySelector(".history-toggle").click()'); await sleep(200)
	check("reload restores textual history while transient image previews disappear", await js('document.querySelector(".chat-msgs").textContent.includes("look-once") && document.querySelector(".chat-msgs").textContent.includes("Plain response") && !document.querySelector(".message-image")'))
	check("no unhandled page exception", errors.length === 0)
	console.log(`\n${passed} chat session checks passed (${baseline ? "stage7 baseline" : "current App"}; fake native bridge/renderer; no external API)`)
} catch (error) {
	console.error(error); if (errors.length) console.error(errors)
	process.exitCode = 1
} finally {
	for (const item of pending.values()) clearTimeout(item.timer)
	ws?.close(); edge?.kill(); await server?.close()
}
