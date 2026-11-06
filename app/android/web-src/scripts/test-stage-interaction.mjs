// Real Vue and production stage code, with synthetic model geometry and native bridge.
// --baseline loads the frozen App from before stage6 without changing working files.
import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {createServer} from "vite"

const root = path.resolve(import.meta.dirname, "..")
const baseline = process.argv.includes("--baseline")
const appBefore = baseline ? readFileSync(path.join(root, "tmp-memcheck/_mock/App-stage6-before.vue"), "utf8") : null
const webPort = 5196, debugPort = 9496
const profile = mkdtempSync(path.join(tmpdir(), "nori-stage-ui-"))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const seed = {apiKey: "", model: "", ambientEnabled: false, backgroundMode: "off", dataseaBg: false, memoryLlmExtract: false, smartRecall: false, emotionLlm: false, petTouchEnabled: true, petTouchEffects: true, petTouchSound: false, petTouchSpeech: false}
const shim = `
localStorage.setItem("intro_seen_v1", "1"); localStorage.setItem("storage_asked", "1");
if (!localStorage.getItem("l2d_scale_ARGNori")) localStorage.setItem("l2d_scale_ARGNori", "1");
window.__stageCalls = {look: [], reset: 0, paused: []};
window.NoriBridge = {listInstalled: () => JSON.stringify([{id: "ARGNori", entryBase: "ARGNori"}])};
window.__files = {"settings.json": ${JSON.stringify(JSON.stringify(seed))}};
window.NoriChat = {
 readFile: n => window.__files[n] || "", writeFile: (n, v) => { window.__files[n] = v; return "ok" },
 isStorageReady: () => true, hasAllFilesAccess: () => true, getStorageDir: () => "test",
 chatStop: () => {}, ttsStop: () => {}, cosyTtsStop: () => {}
};
window.__noriModelPoint = (x,y) => ({x: x/innerWidth*2-1, y: 1-y/innerHeight*2});
window.__noriHitTest = (x,y) => { const p=window.__noriModelPoint(x,y); return {hit: Math.abs(p.x)<=.8 && p.y<=.9 && p.y>=-.9} };
window.__noriPartProbe = () => ({ok:true, parts:[{box:{left:-.4,right:.4,top:.9,bottom:.4}},{box:{left:-.8,right:.8,top:.3,bottom:-.9}}], allBox:{left:-.8,right:.8,top:.9,bottom:-.9}});
const realFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
 const url = new URL(typeof input === "string" ? input : input.url, location.href);
 if (url.pathname.endsWith(".model3.json")) return Promise.resolve(new Response(JSON.stringify({FileReferences: {Motions: {}, Expressions: []}})));
 if (url.origin !== location.origin) return Promise.resolve(new Response(JSON.stringify({list: [], data: []})));
 return realFetch(input, options);
};
`
const fakeRenderer = `
export {readModelConfig, writeModelConfig} from "/src/services/live2d/config.ts";
export {L2D_FPS_OPTIONS, normalizeFps} from "/src/services/live2d/frameCap.ts";
export {normalizeRenderScale} from "/src/services/live2d/renderScale.ts";
export const createLive2D = () => {
 let cv; const noop = () => {};
 return {mount: async (_spec, options) => { cv=document.createElement("canvas"); cv.width=innerWidth; cv.height=innerHeight; options.host.appendChild(cv); },
 canvas: () => cv, destroy: async () => cv?.remove(), getMotions: async () => [],
 lookAt: (x,y) => window.__stageCalls.look.push({x,y}), resetLook: () => window.__stageCalls.reset++,
 playExpression: noop, stopExpression: noop, playMotionByIndex: noop, playMotionByName: noop,
 pauseRender: p => window.__stageCalls.paused.push(p), applyFrameCap: noop,
 setRenderScale: s => {window.__noriRenderScale=s}};
};`
let server, edge, ws, seq=0, passed=0
const pending = new Map(), errors=[]
const send = (method, params={}, sessionId) => new Promise((resolve,reject) => {
 const id=++seq, timer=setTimeout(() => {pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},15000)
 pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))
})
const until = async (fn,label) => {const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(80)}throw new Error(`Timeout: ${label}`)}
const check = (name,value) => {assert.ok(value,name);passed++;console.log(`PASS ${name}`)}
try {
 server=await createServer({root,configFile:path.join(root,"vite.config.ts"),server:{host:"127.0.0.1",port:webPort,strictPort:true},plugins:[{
  name:"stage-ui-fakes",enforce:"pre",
  resolveId(source,importer){if(source==="./services/live2d"&&importer?.includes("App.vue"))return "\0stage-ui-renderer"},
  load(id){if(id==="\0stage-ui-renderer")return fakeRenderer;if(appBefore && id.replaceAll("\\","/").endsWith("/src/App.vue"))return appBefore},
  transformIndexHtml(){return [{tag:"script",children:shim,injectTo:"head-prepend"}]},
 }]})
 await server.listen()
 edge=spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",["--headless=new",`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-gpu","about:blank"],{stdio:"ignore",windowsHide:true})
 let debugUrl
 await until(async()=>{try{debugUrl=(await(await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl;return !!debugUrl}catch{return false}},"Edge")
 ws=new WebSocket(debugUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}
 const {targetId}=await send("Target.createTarget",{url:"about:blank"})
 const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true})
 await send("Runtime.enable",{},sessionId);await send("Page.enable",{},sessionId)
 await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId)
 const js=async expression=>{const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
 const pointer=(type,x,y,id=1,options={})=>js(`document.querySelector(${JSON.stringify(options.target||".stage-root")}).dispatchEvent(new PointerEvent(${JSON.stringify(type)},${JSON.stringify({pointerId:id,clientX:x,clientY:y,button:0,buttons:["pointerup","pointercancel","lostpointercapture"].includes(type)?0:1,bubbles:true,...options,target:undefined})}))`)
 const state=()=>js("window.__noriPetDebug()")
 const fx=()=>js("Object.values(window.__noriPetFxSpawned()).reduce((a,b)=>a+b,0)")
 const inactive=s=>s.pressed===0&&!s.stroking&&!s.headFollow&&!s.swayRaf&&!s.active
 const mounted=async()=>{await until(()=>js('!!document.querySelector(".l2d-host canvas") && !!window.__noriPetDebug && !document.querySelector(".topbar .loading")'),"mounted");await sleep(350)}
 const H={x:195,y:126.6}, B={x:195,y:500}, blank={x:380,y:126.6}
 await send("Page.navigate",{url:`http://127.0.0.1:${webPort}`},sessionId);await mounted()
 check("initial CSS transform is identity",await js("window.__noriCanvasView().scale===1"))
 const startFx=await fx()
 for(let i=0;i<10;i++){await pointer("pointermove",H.x+(i%2?20:-20),H.y,1,{buttons:0});await sleep(40)}
 const hover=await state()
 check("hover never starts pressed/stroking/follow/sway",hover.pressed===0&&!hover.stroking&&!hover.headFollow&&!hover.swayRaf)
 check("hover produces no pet particles",await fx()===startFx)
 await js('window.dispatchEvent(new Event("blur"))')
 await js('const b=document.createElement("button");b.id="stage-test-button";document.querySelector(".stage-root").appendChild(b)')
 await pointer("pointerdown",H.x,H.y,1,{target:"#stage-test-button"});await sleep(300)
 check("UI pointerdown is excluded",inactive(await state()))
 await pointer("pointerdown",H.x,H.y,1,{button:2});await sleep(300)
 check("non-primary mouse button is excluded",inactive(await state()))
 await pointer("pointerdown",blank.x,blank.y);await sleep(330)
 let s=await state()
 check("blank press follows pointer without a model/head hit",s.pressed===1&&s.headFollow&&!s.onModel&&!s.onHead)
 check("blank hold produces no pet particles",await fx()===startFx)
 await pointer("pointerup",blank.x,blank.y);check("blank release clears stage state",inactive(await state()))
 await pointer("pointerdown",B.x,B.y);s=await state()
 check("body is an entity hit outside the head zone",s.onModel&&!s.onHead&&s.geomOk)
 await pointer("pointerup",B.x,B.y)
 const holdFx=await fx()
 await pointer("pointerdown",H.x,H.y);await sleep(100);s=await state()
 check("head press starts follow before the hold threshold",s.pressed===1&&s.headFollow&&s.onHead&&!s.stroking)
 await sleep(230);s=await state()
 check("hold beyond 260ms enables stroking and sway",s.stroking&&s.swayRaf&&s.onHead)
 check("confirmed head hold emits particle feedback",await fx()>holdFx)
 check("look spring feeds finite renderer coordinates",await js("window.__stageCalls.look.length>0 && window.__stageCalls.look.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))"))
 await pointer("pointerup",H.x,H.y);check("head release clears sampling and feedback state",inactive(await state()))
 await until(()=>js("window.__stageCalls.reset>0"),"spring return")
 check("spring settles through renderer resetLook",await js("window.__stageCalls.reset>0"))
 await pointer("pointerdown",H.x,H.y);await sleep(330)
 const completions=(await state()).completions
 for(let i=0;i<36;i++){await sleep(40);await pointer("pointermove",H.x+(i%2?35:-35),H.y)}
 s=await state();check("horizontal head strokes complete one session",s.completions===completions+1&&s.progressMs===1000)
 for(let i=0;i<8;i++){await sleep(40);await pointer("pointermove",H.x+(i%2?35:-35),H.y)}
 check("completion is latched until the session ends",(await state()).completions===completions+1)
 await sleep(110);await pointer("pointermove",B.x,B.y);s=await state()
 check("leaving the head clears sampling while press remains",s.pressed===1&&s.stroking&&!s.onHead&&!s.active&&s.progressMs===0)
 const reenterFx=await fx();await sleep(110);await pointer("pointermove",H.x,H.y);s=await state()
 check("reentering the head restarts the sampler",s.onHead&&s.active&&s.progressMs===0)
 check("reentering during a press emits contact feedback",await fx()>reenterFx)
 await pointer("pointerup",H.x,H.y)
 await pointer("pointerdown",H.x,H.y);await sleep(330)
 await pointer("pointerup",H.x,H.y,99);s=await state()
 check("unrelated pointerup does not end the active gesture",s.pressed===1&&s.stroking&&s.headFollow)
 await pointer("pointerdown",H.x+10,H.y+10,2);s=await state()
 check("a second pointer cancels pet follow and sampling",s.pressed===2&&!s.stroking&&!s.headFollow&&!s.active&&!s.swayRaf)
 await pointer("pointerup",H.x+10,H.y+10,2);await pointer("pointerup",H.x,H.y)
 check("both finger releases return pointer count to zero",inactive(await state()))
 for(const event of ["pointercancel","lostpointercapture"]){
  await pointer("pointerdown",H.x,H.y);await sleep(330);await pointer(event,H.x,H.y)
  check(`${event} clears the held gesture`,inactive(await state()))
 }
 await pointer("pointerdown",H.x,H.y);await sleep(100);await js('window.dispatchEvent(new Event("blur"))');await sleep(250)
 check("blur cancels the pending 260ms hold timer",inactive(await state()))
 await pointer("pointerdown",H.x,H.y);await sleep(330);await js('window.__noriAppPaused=true;window.dispatchEvent(new Event("nori-app-pause"))')
 check("native pause clears stage interaction",inactive(await state()))
 check("native pause reaches the renderer",await js("window.__stageCalls.paused.at(-1)===true"))
 await js('window.__noriAppPaused=false;window.dispatchEvent(new Event("nori-app-resume"))')
 check("native resume reaches the renderer",await js("window.__stageCalls.paused.at(-1)===false"))
 await js('localStorage.setItem("l2d_scale_ARGNori","0.7");localStorage.setItem("l2d_offset_x_ARGNori","45");localStorage.setItem("l2d_offset_y_ARGNori","80")')
 await send("Page.reload",{},sessionId);await mounted()
 const view=await js("window.__noriCanvasView()")
 check("model scale and offsets restore after reload",view.scale===.7&&view.offsetX===45&&view.offsetY===80)
 const transform=p=>({x:view.w/2+view.scale*(p.x+view.offsetX-view.w/2),y:view.h/2+view.scale*(p.y+view.offsetY-view.h/2)})
 const th=transform(H),tb=transform(blank)
 const mp=await js(`window.__noriModelPointFixed(${th.x},${th.y})`)
 check("client-to-model mapping inverts scale and translation",Math.abs(mp.x)<1e-10&&Math.abs(mp.y-.7)<1e-10)
 await pointer("pointerdown",th.x,th.y);s=await state()
 check("transformed head location hits the same geometry",s.onModel&&s.onHead&&s.geomOk&&Math.abs(s.modelY-.7)<1e-10)
 await pointer("pointerup",th.x,th.y)
 await pointer("pointerdown",tb.x,tb.y);s=await state()
 check("transformed blank location stays outside the entity",!s.onModel&&!s.onHead)
 await pointer("pointerup",tb.x,tb.y)
 check("no unhandled page exceptions",errors.length===0)
 console.log(`\n${passed} stage interaction checks passed (${baseline?"stage6 baseline":"current App"}; fake geometry/renderer; no external API)`)
} catch(error){console.error(error);if(errors.length)console.error(errors);process.exitCode=1}
finally{for(const p of pending.values())clearTimeout(p.timer);ws?.close();edge?.kill();await server?.close()}
