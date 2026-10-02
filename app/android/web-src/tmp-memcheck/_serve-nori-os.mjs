/* 临时静态服务器: 把爬下来的网页版站点喂给浏览器看 (只读; 排查/对照用)
 * 运行: node tmp-memcheck/_serve-nori-os.mjs [port]
 * 默认 8199, 根目录 = D:\norios网页版\archive_0831_nori-os\os.inori.ai
 */
import http from "node:http"
import {readFile, stat} from "node:fs/promises"
import {join, normalize, extname} from "node:path"

const ROOT = "D:/norios网页版/archive_0831_nori-os/os.inori.ai"
const PORT = Number(process.argv[2]) || 8199
const MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
	".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".bin": "application/octet-stream",
	".moc3": "application/octet-stream", ".model3.json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff",
	".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8"}

http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
		let p = decodeURIComponent(url.pathname)
		if (p.endsWith("/")) p += "index.html"
		const file = normalize(join(ROOT, p))
		if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end("forbidden"); return }
		let target = file
		try { const s = await stat(target); if (s.isDirectory()) target = join(target, "index.html") } catch { /* SPA 回落 */ }
		let body
		try { body = await readFile(target) } catch { body = await readFile(join(ROOT, "index.html")) }
		const ext = extname(target).toLowerCase()
		res.writeHead(200, {"content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store"})
		res.end(body)
	} catch (e) {
		res.writeHead(500).end(String(e && e.message || e))
	}
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`))
