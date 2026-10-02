import {readFileSync, readdirSync} from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
const apkDir = path.resolve(import.meta.dirname, "..", "..", "app", "build", "outputs", "apk", "release")
const apk = readdirSync(apkDir).filter(f => f.endsWith(".apk"))[0]
const b = readFileSync(path.join(apkDir, apk))
let eocd = -1
for (let i = b.length - 22; i >= 0; i -= 1) { if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break } }
const count = b.readUInt16LE(eocd + 10); let off = b.readUInt32LE(eocd + 16)
for (let i = 0; i < count; i += 1) {
  const nameLen = b.readUInt16LE(off + 28), extraLen = b.readUInt16LE(off + 30), commentLen = b.readUInt16LE(off + 32)
  const method = b.readUInt16LE(off + 10), compSize = b.readUInt32LE(off + 20), localOff = b.readUInt32LE(off + 42)
  const name = b.toString("utf8", off + 46, off + 46 + nameLen)
  if (/assets\/web\/assets\/main-.*\.js$/.test(name)) {
    const lnameLen = b.readUInt16LE(localOff + 26), lextraLen = b.readUInt16LE(localOff + 28)
    const raw = b.subarray(localOff + 30 + lnameLen + lextraLen, localOff + 30 + lnameLen + lextraLen + compSize)
    const js = (method === 0 ? raw : zlib.inflateRawSync(raw)).toString("utf8")
    console.log("长度", js.length)
    for (const k of ["mem-enter", "记忆库", "我的名字", "啊", "哦", "u554a", "u6211", "u7684"]) {
      console.log(`  含 ${JSON.stringify(k)} : ${js.includes(k)}`)
    }
    // 找"记忆库"附近的片段看中文有没有被转义
    const i2 = js.indexOf("记忆库")
    console.log("记忆库附近:", JSON.stringify(js.slice(i2 - 60, i2 + 60)))
    const i3 = js.indexOf("u554a")
    if (i3 >= 0) console.log("u554a 附近:", JSON.stringify(js.slice(i3 - 120, i3 + 60)))
    break
  }
  off += 46 + nameLen + extraLen + commentLen
}
