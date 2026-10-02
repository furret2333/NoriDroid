/* 诊断: APK 里的前端包到底有没有"记忆判重/收敛"这段代码? (按**正则字面量**找, 不靠函数名) */
import {readFileSync, readdirSync} from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
const apkDir = path.resolve(import.meta.dirname, "..", "..", "app", "build", "outputs", "apk", "release")
const apk = path.join(apkDir, readdirSync(apkDir).filter(f => f.endsWith(".apk"))[0])
const b = readFileSync(apk)
let eocd = -1
for (let i = b.length - 22; i >= 0; i -= 1) { if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break } }
const count = b.readUInt16LE(eocd + 10); let off = b.readUInt32LE(eocd + 16)
for (let i = 0; i < count; i += 1) {
	const nameLen = b.readUInt16LE(off + 28), extraLen = b.readUInt16LE(off + 30), commentLen = b.readUInt16LE(off + 32)
	const method = b.readUInt16LE(off + 10), compSize = b.readUInt32LE(off + 20), localOff = b.readUInt32LE(off + 42)
	const name = b.toString("utf8", off + 46, off + 46 + nameLen)
	if (name.startsWith("assets/web/assets/") && name.endsWith(".js")) {
		const lnameLen = b.readUInt16LE(localOff + 26), lextraLen = b.readUInt16LE(localOff + 28)
		const raw = b.subarray(localOff + 30 + lnameLen + lextraLen, localOff + 30 + lnameLen + lextraLen + compSize)
		const js = (method === 0 ? raw : zlib.inflateRawSync(raw)).toString("utf8")
		const marks = {
			"记忆库入口文案": "记忆库 · 目标 / 长期记忆 / 历史总结",
			"语气词正则字面量": "啊|呀|哦|哟|啦|呢|吧|嘛|哈|喔|噢",
			"主语白名单字面量": "我的名字叫",
			"含'我的名字是'": "我的名字是",
			"存量收敛日志": "存量重复记忆已收敛",
			"墓碑相关": "tombstones",
		}
		const hit = Object.entries(marks).map(([k, v]) => `${k}=${js.includes(v)}`).join("  ")
		if (Object.values(marks).some(v => js.includes(v)) || /main-/.test(name)) {
			console.log(`\n[${name}]  ${(js.length / 1024).toFixed(1)}KB`)
			console.log("  " + hit)
		}
	}
	off += 46 + nameLen + extraLen + commentLen
}
