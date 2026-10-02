import path from "node:path"
import {pathToFileURL} from "node:url"
await import(pathToFileURL(path.join(import.meta.dirname, "build-mem-bundles.mjs")).href)   // 先重建 bundle, 避免读到旧产物
const root = path.resolve(import.meta.dirname, "..")
globalThis.window = {NoriChat: {readFile: () => "", writeFile: () => "ok"}}
const core = await import(pathToFileURL(path.join(root, "tmp-memcheck/core-bundle.mjs")).href)
const norm = (s) => String(s ?? "").normalize("NFC").replace(/[\uFF0C\u3002\uFF01\uFF1F!?,.、\s"'\u201C\u201D\u2018\u2019]+/g, "").toLowerCase()
const dice = (a, b) => {
	const A = norm(a), B = norm(b)
	if (A.length < 2 || B.length < 2) return A === B ? 1 : 0
	const bi = (s) => { const o = new Map(); for (let i = 0; i < s.length - 1; i += 1) { const g = s.slice(i, i + 2); o.set(g, (o.get(g) ?? 0) + 1) } return o }
	const ma = bi(A), mb = bi(B)
	let inter = 0, na = 0, nb = 0
	for (const n of ma.values()) na += n
	for (const [g, n] of mb) { nb += n; const x = ma.get(g); if (x) inter += Math.min(x, n) }
	return (2 * inter) / (na + nb)
}
const SAME = [["我喜欢下雨天","我最喜欢下雨天"],["我在准备考研","我在准备考研考试"],["我在准备考研","我准备考研"],["我叫小明","我的名字是小明"],["我养了一只猫","我家养了只猫"],["我在准备考研","考研在准备中"],["我的生日是五月一号","我五月一号生日"],["我是程序员","我是一名程序员"],["我住在杭州市","我家在杭州市"],["我的工作是前端","我是做前端的"],["我喜欢吃辣","我很喜欢吃辣的东西"],["我养了一只猫","我有一只猫"],["我最近在学吉他","我在学吉他"],["我女朋友叫小美","我的女朋友叫小美"],["我最喜欢的电影是星际穿越","我最喜欢的电影是《星际穿越》"]]
const DIFF = [["我喜欢猫","我喜欢狗"],["我喜欢下雨天","我讨厌下雨天"],["我不喜欢下雨天","我喜欢下雨天"],["我叫小明","我叫小刚"],["我喜欢吃辣","我喜欢吃甜"],["我是程序员","我是设计师"],["我养了一只猫","我养了一只狗"],["我喜欢猫","我喜欢猫毛"],["我的生日是五月一号","我的生日是六月一号"],["我在准备考研","我在准备考公"],["我住在杭州市","我住在广州市"],["我最近在学吉他","我最近在学钢琴"],["我女朋友叫小美","我女朋友叫小丽"],["我喜欢打篮球","我喜欢打羽毛球"],["我的工作是前端","我的工作是后端"],["我最喜欢的电影是星际穿越","我最喜欢的电影是盗梦空间"],["我喜欢狗","我讨厌狗"],["我在做NoriDroid","我在做NoriOS"],["每天喝咖啡","每天喝茶"]]
const minLen = 4
console.log("阈值扫描 (normalizeContent 同一套归一, 最短长度闸 = " + minLen + " 字)")
console.log("  t     同义合并   误并   误并明细")
for (const t of [0.65,0.7,0.75,0.8,0.85,0.9,0.95,1.0]) {
	let tp=0,fn=0,fp=0,tn=0; const fps=[]
	for (const [a,b] of SAME) { const L=Math.min(norm(a).length,norm(b).length)>=minLen; const hit=L&&dice(a,b)>=t; if(hit)tp+=1; else fn+=1 }
	for (const [a,b] of DIFF) { const L=Math.min(norm(a).length,norm(b).length)>=minLen; const hit=L&&dice(a,b)>=t; if(hit){fp+=1; fps.push(`${a}/${b}(${dice(a,b).toFixed(2)})`)} else tn+=1 }
	console.log(`  ${t.toFixed(2)}   ${tp}/${tp+fn}       ${fp}/${fp+tn}   ${fps.join("  ")}`)
}
