/** 命中测试本地实测服务器: /assets/web/* → 构建产物, /live2d/* → 模型目录, / → 冒烟测试页 */
import http from "node:http"
import {createReadStream, existsSync, readFileSync, statSync} from "node:fs"
import path, {join, extname, normalize, dirname} from "node:path"
import {networkInterfaces} from "node:os"
import {fileURLToPath} from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
// 构建产物: 默认按本文件位置推导 (app/android/.harness → app/android/app/src/main/assets/web),
// 换副本/换机器不用改代码; 特殊布局可用 NORI_WEB_ASSETS 覆盖。
const ASSETS = process.env.NORI_WEB_ASSETS || path.resolve(HERE, "../app/src/main/assets/web")
// 模型目录: 仓库里不含模型 (18MB+), 由本机提供; 用 NORI_MODELS_DIR 指过去。
// 默认使用测试服务器旁的模型目录；正式回归通过环境变量显式使用无模型夹具。
const MODELS = process.env.NORI_MODELS_DIR || path.resolve(HERE, "models")
const PORT = 8123

/** `?seed=` 的约定: base64url(JSON)。只接受能解析成 JSON 的内容, 避免把坏数据注进页面。
 *  2026-09-30 抽成函数: 悬浮窗页(?)也要用同一套解码, 不然会把 base64 原文当 JSON 塞进去。 */
const decodeSeed = (u) => {
	const raw = u.searchParams.get("seed") || ""
	if (!raw) return ""
	try {
		const decoded = Buffer.from(raw, "base64url").toString("utf-8")
		JSON.parse(decoded)
		return decoded
	} catch { return "" }
}

// 桌面浏览器没有 Android 桥: 注入假 NoriBridge/NoriChat + 把 CDN 的 cubismcore 脚本重定向到本地。
// ?rs=N    → 假 NoriChat.readFile("settings.json") 返回 renderScale=N, 模拟真机"渲染分辨率≠dpr"场景
// ?seed=B  → B = base64url(JSON), 直接当作 settings.json 内容返回。
//            用于需要"开机就是某套设置"的实测 (例如预置一个属于别的模型的克隆音色)。
// ?smoke=1 → 模型加载完成后自动跑命中网格扫描并断言, 结果写进 document.title (SMOKE-OK / SMOKE-FAIL:原因)
// 假桥同时内置 番茄钟 内存状态机 (分钟级, 语义与原生 PomodoroEngine 一致), 用于 Web 侧组件实测
const shimOf = (rs, smoke, seed) => `<script>
var __seed=${JSON.stringify(seed || "")};
window.NoriBridge={listInstalled:()=>JSON.stringify([{id:"ARGNori",entryBase:"ARGNori"}]),download:(id)=>{setTimeout(()=>window.__noriModelRes&&window.__noriModelRes(JSON.stringify({ok:true,entryBase:"ARGNori"})),50)}};
window.NoriChat=(function(){
	var st={phase:"idle",paused:false,endAt:0,remainMs:0,focusMin:25,breakMin:5,autoBreak:true,startedAt:0};
	var files={};
	var snap=function(){st.now=Date.now();return JSON.parse(JSON.stringify(st))};
	var arm=function(){if(st.phase==="focus"){setTimeout(function(){if(st.phase!=="focus")return;st.phase="break";st.startedAt=Date.now();st.endAt=Date.now()+st.breakMin*60000;window.__noriPomoEvent&&window.__noriPomoEvent(JSON.stringify({type:"end",phase:"focus"}))},Math.max(200,st.endAt-Date.now()))}};
	var ms=function(min){return Math.max(200,min*60000/60)};
	return {
		readFile:function(n){if(files[n])return files[n];if(n!=="settings.json")return "";if(__seed)return __seed;return ${rs}?JSON.stringify({renderScale:${rs}}):""},
		writeFile:function(n,c){files[n]=c;return "ok"},
		pomoStart:function(f,b,ab){st={phase:"focus",paused:false,endAt:Date.now()+ms(f),remainMs:0,focusMin:f,breakMin:b,autoBreak:!!ab,startedAt:Date.now()};arm();return JSON.stringify(snap())},
		pomoStartCountUp:function(){st={phase:"countUp",paused:false,endAt:0,remainMs:0,focusMin:0,breakMin:0,autoBreak:false,startedAt:Date.now()};return JSON.stringify(snap())},
		pomoPause:function(){if(st.phase==="idle"||st.paused)return JSON.stringify(snap());st.paused=true;st.remainMs=st.phase==="countUp"?Date.now()-st.startedAt:Math.max(0,st.endAt-Date.now());return JSON.stringify(snap())},
		pomoResume:function(){if(st.phase==="idle"||!st.paused)return JSON.stringify(snap());st.paused=false;if(st.phase==="countUp")st.startedAt=Date.now()-st.remainMs;else st.endAt=Date.now()+st.remainMs;arm();return JSON.stringify(snap())},
		pomoStop:function(){var ended=st.phase;var el=st.phase==="idle"?0:(st.paused?st.remainMs:Date.now()-st.startedAt);st={phase:"idle",paused:false,endAt:0,remainMs:0,focusMin:st.focusMin,breakMin:st.breakMin,autoBreak:st.autoBreak,startedAt:0};var o=snap();o.endedPhase=ended;o.elapsedMs=el;return JSON.stringify(o)},
		pomoState:function(){return JSON.stringify(snap())},
		pomoRequestNotify:function(){},
		// 假 CosyVoice 桥: 把最后一次请求记到 window.__noriCosyLast, 再回一个显式错误。
		// 有了它, E2E 才能区分"本地守卫拦下了(桥根本没被调用)"和"真的走到发请求这一步"。
		cosyTtsStream:function(baseUrl,apiKey,model,voice,format,sampleRate,rate,text){
			window.__noriCosyLast={baseUrl:baseUrl,model:model,voice:voice,text:text};
			setTimeout(function(){
				window.__noriTtsError&&window.__noriTtsError(JSON.stringify({message:"FAKE_BRIDGE_REACHED"}));
			},30);
		},
		cosyTtsStop:function(){},
		ttsStop:function(){}
	};
})();
${rs ? "" : ""}
(function(){
	const ce = document.createElement.bind(document);
	document.createElement = function(tag){
		const el = ce.apply(null, arguments);
		if (String(tag).toLowerCase() === "script") {
			const d = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
			Object.defineProperty(el, "src", {
				set(v){ d.set.call(this, String(v).indexOf("cubism.live2d.com") >= 0 ? "/assets/web/live2dcubismcore.min.js" : v); },
				get(){ return d.get.call(this); }
			});
		}
		return el;
	};
})();
</script>${
	smoke
		? `<script>
(function(){
	const t0 = Date.now();
	const scan = () => {
		try {
			const W = innerWidth, H = innerHeight;
			let hit = 0, miss = 0, bad = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
			for (let y = 10; y < H; y += 24) for (let x = 10; x < W; x += 24) {
				let r; try { r = window.__noriHitTest(x, y); } catch (e) { bad++; continue; }
				if (!r || r.err) bad++;
				else if (r.hit === true) { hit++; if (x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
				else if (r.hit === false) miss++;
				else bad++;
			}
			const bw = maxX - minX, bh = maxY - minY;
			const ok = bad === 0 && hit >= 30 && bw >= W * 0.3 && bh >= H * 0.4;
			window.__smokeResult = { ok, hit, miss, bad, bbox: hit ? [minX, minY, maxX, maxY] : null, W, H };
			document.title = ok ? "SMOKE-OK" : "SMOKE-FAIL:hit" + hit + "/bad" + bad + "/bw" + Math.round(bw) + "/bh" + Math.round(bh);
		} catch (e) { document.title = "SMOKE-FAIL:" + ((e && e.message) || e); }
	};
	const tick = () => {
		if (typeof window.__noriHitTest === "function") return setTimeout(scan, 800);
		if (Date.now() - t0 > 30000) { document.title = "SMOKE-FAIL:钩子未就绪"; return; }
		setTimeout(tick, 300);
	};
	tick();
})();
</script>`
		: ""
}`

const mimeOf = (p) => {
	const e = extname(p).toLowerCase()
	const m = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript",
		".mjs": "text/javascript",
		".css": "text/css",
		".json": "application/json",
		".png": "image/png",
		".webp": "image/webp",
		".jpg": "image/jpeg",
		".svg": "image/svg+xml",
	}
	return m[e] || "application/octet-stream"
}

const send = (res, code, body, type) => {
	res.writeHead(code, {"content-type": type, "access-control-allow-origin": "*", "cache-control": "no-store"})
	res.end(body)
}

/** /live2d/ 请求: 设备上是 嵌套目录 (ARGNori/ARGNori/...), 本地副本是平铺的 → 双层段回退 */
const resolveLive2d = (rel) => {
	const f1 = join(MODELS, rel)
	if (existsSync(f1)) return f1
	const dup = rel.match(/^[/\\]([^/\\]+)[/\\]\1([/\\].+)$/)
	if (dup) {
		const f2 = join(MODELS, dup[1] + dup[2])
		if (existsSync(f2)) return f2
	}
	return f1
}

http.createServer((req, res) => {
	const u = new URL(req.url, "http://x")
	let path = decodeURIComponent(u.pathname)
	let base = null
	if (path === "/" || path === "/smoke.html") {
		base = HERE
		path = "/smoke.html"
	} else if (path === "/gpu" || path === "/gpu.html") {
		/* 渲染器字符串 / 分级对照页: 给"GPU 分级 + 自动降档"(P1-2) 用。
		   手机浏览器打开即可读, 不需要 devtools (工程的 setWebContentsDebuggingEnabled 是关的)。 */
		const file = join(HERE, "gpu.html")
		if (!existsSync(file)) return send(res, 404, "gpu.html 缺失", "text/plain")
		return send(res, 200, readFileSync(file, "utf-8"), "text/html; charset=utf-8")
	} else if (path === "/bench" || path === "/bench.html") {
		/* 渲染自测页: iframe 载 App 并依次跑 5 组配置(分辨率/背景/毛玻璃), 结果铺在屏幕上 —— 手机友好。
		   ⚠ 它靠 iframe 的 rAF 与 __noriL2dDraws 取数, 所以 iframe 必须**可见**(页面里没给 display:none)。 */
		const file = join(HERE, "bench.html")
		if (!existsSync(file)) return send(res, 404, "bench.html 缺失", "text/plain")
		return send(res, 200, readFileSync(file, "utf-8"), "text/html; charset=utf-8")
	} else if (path === "/sumtest" || path === "/sumtest.html") {
		// 历史总结机制自测页: 真跑记忆服务代码, 对比修复前后 (不联网/不花 token)
		const file = join(HERE, "sumtest.html")
		if (!existsSync(file)) return send(res, 404, "sumtest.html 缺失", "text/plain")
		return send(res, 200, readFileSync(file, "utf-8"), "text/html; charset=utf-8")
	} else if (path.startsWith("/sumtest/")) {
		// 自测页用的两个 bundle (由 build-sumtest.mjs 生成)
		const file = join(HERE, "sumtest", normalize(path.slice("/sumtest".length)).replace(/^[/\\]+/, "").replace(/^([.][.][/\\])+/, ""))
		if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, "not found: " + path, "text/plain")
		return send(res, 200, readFileSync(file, "utf-8"), "text/javascript; charset=utf-8")
	} else if (path.startsWith("/assets/web/")) {
		const rest = path.slice("/assets/web".length)
		if (rest === "/" || rest === "" || rest === "/index.html") {
			const html = readFileSync(join(ASSETS, "index.html"), "utf-8")
			const shim = shimOf(Number(u.searchParams.get("rs")) || 0, u.searchParams.get("smoke") === "1", decodeSeed(u))
			return send(res, 200, html.includes("<head>") ? html.replace("<head>", "<head>" + shim) : shim + html, "text/html; charset=utf-8")
		}
		/* 悬浮窗页默认**不注入**任何东西（保持与别的会话共用时行为不变）。
		   需要跑悬浮窗冒烟时显式加 `?shim=1` —— 那条链路此前**零覆盖**，
		   而它同样吃 frameCap（FloatApp.vue 自己也调 applyFrameCap）。 */
		/* 2026-10-01: 气泡聊天页(bubble.html)也要能注假桥 —— 悬浮窗里"点 Nori 弹气泡聊天"
		   是真实使用路径，之前完全没法在 harness 里测（BubbleApp 走的是自己的 payload 拼装）。 */
		if (rest === "/bubble.html" && u.searchParams.get("shim") === "1") {
			const html = readFileSync(join(ASSETS, "bubble.html"), "utf-8")
			const shim = shimOf(0, false, decodeSeed(u))
			return send(res, 200, html.includes("<head>") ? html.replace("<head>", "<head>" + shim) : shim + html, "text/html; charset=utf-8")
		}
		if (rest === "/float.html" && u.searchParams.get("shim") === "1") {
			const html = readFileSync(join(ASSETS, "float.html"), "utf-8")
			// 2026-09-30: 也支持 ?seed= —— 悬浮窗现在会优先跟主 App 的 settings.live2dModel 走,
			// 要验"两边显示同一只模型"就得能给悬浮窗预置一份 settings.json（与 index.html 同一约定）。
			const shim = shimOf(0, false, decodeSeed(u))
			return send(res, 200, html.includes("<head>") ? html.replace("<head>", "<head>" + shim) : shim + html, "text/html; charset=utf-8")
		}
		const li = rest.indexOf("/live2d/")
		if (li >= 0) {
			const file = resolveLive2d(rest.slice(li + "/live2d".length))
			if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, "not found: " + rest, "text/plain")
			res.writeHead(200, {"content-type": mimeOf(file), "access-control-allow-origin": "*", "cache-control": "no-store"})
			return createReadStream(file).pipe(res)
		}
		base = ASSETS
		path = rest
	}
	if (!base) return send(res, 404, "not found", "text/plain")
	const file = join(base, normalize(path).replace(/^([.][.][/\\])+/, ""))
	if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, "not found: " + path, "text/plain")
	res.writeHead(200, {"content-type": mimeOf(file), "access-control-allow-origin": "*", "cache-control": "no-store"})
	createReadStream(file).pipe(res)
}).listen(PORT, "0.0.0.0", () => {
	// 绑 0.0.0.0: 手机与 PC 同一 Wi-Fi 时可直接用局域网地址打开自测页。
	// (只读的本地调试服务器, 不接触任何凭据; 用完关掉窗口即可)
	const nets = networkInterfaces()
	const lan = Object.values(nets).flat().filter(n => n && n.family === "IPv4" && !n.internal).map(n => n.address)
	console.log(`harness (本机):   http://127.0.0.1:${PORT}/sumtest`)
	for (const ip of lan) {
		console.log(`harness (局域网): http://${ip}:${PORT}/sumtest   ← 手机用这个`)
		console.log(`  渲染自测 (手机): http://${ip}:${PORT}/bench`)
		console.log(`  GPU 信息 (手机): http://${ip}:${PORT}/gpu`)
	}
	// 模型缺失是最常见的 "浏览器回归集体红" 原因, 启动时就说清楚, 别让人去翻日志
	console.log(`  build:  ${ASSETS}`)
	if (existsSync(MODELS)) console.log(`  models: ${MODELS}`)
	else console.log(`  models: **${MODELS} 不存在** —— /live2d/* 会 404, 浏览器回归会红; 用 NORI_MODELS_DIR 指到模型目录`)
})
