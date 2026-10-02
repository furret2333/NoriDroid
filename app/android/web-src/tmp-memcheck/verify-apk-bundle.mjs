/* 校验打进 APK 的前端包**确实包含**本轮改动。
 * 纯 Node 读 zip (不依赖 pwsh/PowerShell: 本机 `pwsh` 不在 PATH, 而中文关键字也不能走命令行)。
 *
 * 2026-09-27 加 `--web` 模式: 直接查**已构建的 web 产物** (app/src/main/assets/web/assets),
 * 用于"打包前预检" —— 关键字缺了就先补, 不必白跑一次 gradle。
 *   node tmp-memcheck/verify-apk-bundle.mjs --web     # 查 web 产物
 *   node tmp-memcheck/verify-apk-bundle.mjs           # 查 APK (打包后)
 */
import {readFileSync, readdirSync, existsSync} from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

const webOnly = process.argv.includes("--web")
const webAssetsDir = path.resolve(import.meta.dirname, "..", "..", "app", "src", "main", "assets", "web", "assets")
const apkDir = path.resolve(import.meta.dirname, "..", "..", "app", "build", "outputs", "apk", "release")

let js = ""
let css = ""
	let buf = null
	let readZipEntries = null
	if (webOnly) {
		const all = readdirSync(webAssetsDir)
		js = all.filter(f => f.endsWith(".js")).map(f => readFileSync(path.join(webAssetsDir, f), "utf8")).join("\n")
		css = all.filter(f => f.endsWith(".css")).map(f => readFileSync(path.join(webAssetsDir, f), "utf8")).join("\n")
		console.log(`模式: --web (打包前预检)  产物目录: ${webAssetsDir}`)
		console.log(`web js: ${all.filter(f => f.endsWith(".js")).length} 个 · css: ${all.filter(f => f.endsWith(".css")).length} 个`)
	} else {
		const apks = readdirSync(apkDir).filter(f => f.endsWith(".apk")).map(f => path.join(apkDir, f))
		const apk = apks.sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0]
		buf = readFileSync(apk)
		console.log(`APK: ${path.basename(apk)}  ${(buf.length / 1024 / 1024).toFixed(2)} MB`)
	}

/** 极简 zip 读取: 从 EOCD 找中央目录, 再定位目标条目 */
readZipEntries = (b, matcher) => {
	// EOCD 签名 0x06054b50, 从尾部往前找
	let eocd = -1
	for (let i = b.length - 22; i >= 0 && i > b.length - 70000; i -= 1) {
		if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
	}
	if (eocd < 0) throw new Error("找不到 EOCD")
	const count = b.readUInt16LE(eocd + 10)
	let off = b.readUInt32LE(eocd + 16)
	const out = []
	for (let i = 0; i < count; i += 1) {
		if (b.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录签名不对 @" + off)
		const nameLen = b.readUInt16LE(off + 28)
		const extraLen = b.readUInt16LE(off + 30)
		const commentLen = b.readUInt16LE(off + 32)
		const method = b.readUInt16LE(off + 10)
		const compSize = b.readUInt32LE(off + 20)
		const localOff = b.readUInt32LE(off + 42)
		const name = b.toString("utf8", off + 46, off + 46 + nameLen)
		if (matcher(name)) {
			// 本地头 → 数据起点
			const lnameLen = b.readUInt16LE(localOff + 26)
			const lextraLen = b.readUInt16LE(localOff + 28)
			const dataStart = localOff + 30 + lnameLen + lextraLen
			const raw = b.subarray(dataStart, dataStart + compSize)
			out.push({name, text: (method === 0 ? raw : zlib.inflateRawSync(raw)).toString("utf8")})
		}
		off += 46 + nameLen + extraLen + commentLen
	}
	if (!out.length) throw new Error("APK 里没有匹配的条目")
	return out
}

/** 只列 zip 里的**条目名** (不解压) —— 用来断言"某个静态资源确实打进去了" */
const listZipEntryNames = (b) => {
	let eocd = -1
	for (let i = b.length - 22; i >= 0 && i > b.length - 70000; i -= 1) {
		if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
	}
	if (eocd < 0) throw new Error("找不到 EOCD")
	const count = b.readUInt16LE(eocd + 10)
	let off = b.readUInt32LE(eocd + 16)
	const names = []
	for (let i = 0; i < count; i += 1) {
		const nameLen = b.readUInt16LE(off + 28)
		const extraLen = b.readUInt16LE(off + 30)
		const commentLen = b.readUInt16LE(off + 32)
		names.push(b.toString("utf8", off + 46, off + 46 + nameLen))
		off += 46 + nameLen + extraLen + commentLen
	}
	return names
}

/* ⚠ 必须查**所有** web js chunk: Vite 会把记忆服务拆进 index-*.js 之类的独立 chunk,
   只查 main-*.js 会误判"改动没打进去"(实测踩到 —— 中文关键字在另一个 chunk 里)。 */
if (!webOnly && buf && readZipEntries) {
	const entries = readZipEntries(buf, n => /assets\/web\/assets\/.*\.js$/.test(n))
	console.log(`包内 web js: ${entries.length} 个 (${entries.map(e => `${e.name.split("/").pop()}:${(e.text.length / 1024).toFixed(0)}KB`).join(" ")}）`)
	js = entries.map(e => e.text).join("\n")
	css = readZipEntries(buf, n => /assets\/web\/assets\/.*\.css$/.test(n)).map(e => e.text).join("\n")
}

const need = [
	["记忆库入口样式 mem-enter", "mem-enter"],
	["记忆库入口文案", "记忆库 · 目标 / 长期记忆 / 历史总结"],
	["句尾语气词白名单", "啊|呀|哦|哟|啦|呢|吧|嘛|哈|喔|噢"],
	["收敛主语白名单(我的名字是)", "我的名字是"],
	["「陪着你的事」已搬进二级页", "陪着你的事"],
	["二级页分节样式 mem-sec", "mem-sec"],
	["历史总结小节仍在", "历史总结"],
	// 新手引导 (首次打开弹窗) + 更新记录已删
	["新手引导样式 intro-mask", "intro-mask"],
	["新手引导文案(同人二创)", "同人二创"],
	["新手引导文案(小桧/一群号)", "471419518"],
	["新手引导文案(API/TTS 推荐)", "Audio 3.1"],
	["新手引导文案(致谢)", "I_Nori"],
	["设置页「新手引导」按钮", "新手引导 / 致谢"],
	// 存储自检 (卸载重装读不到数据的排查) + 所有文件访问权限
	["存储自检样式 store-probe", "store-probe"],
	["存储自检按钮", "存储自检"],
	["所有文件访问权限入口", "所有文件访问权限"],
	// 记忆纠正 (B1/B2): 作废+还原 / 来源标注 / 导出含作废史 / 模糊变量 (C4)
	["作废记录字段 invalidAt", "invalidAt"],
	["记忆库「已作废（N）」区", "已作废（"],
	["作废时间展示", "作废于"],
	["来源标注「你声明」", "你声明"],
	["来源标注「我推断」", "我推断"],
	["导出含「已作废的记忆」段", "## 已作废的记忆"],
	["模糊变量 ui-blur (C4)", "ui-blur-dot"],
	// 分组 + 可发现性 + 改口消解 (2026-09-27 下午)
	["记忆库按类型分组样式 mem-group", "mem-group"],
	["记忆库顶部统计行 mem-stats", "mem-stats"],
	["底部操作按钮 mem-btns-bottom", "mem-btns-bottom"],
	["已作废空态提示", "已作废（0）"],
	["改口消解日志 (意愿族判据)", "改口消解"],
	// === 记忆模块重构 (摘要驱动 · 分块长期记忆, 2026-09-27 深夜 P1~P5) ===
	["摘要+记忆块一次调用 (哨兵)", "===MEM==="],
	["记忆块数据结构 blk-legacy (迁移块 id)", "blk-legacy"],
	["迁移块主题「早期记忆」", "早期记忆"],
	["块视图样式 mem-block", "mem-block"],
	["「未归类」桶", "未归类"],
	["「待整理 N 条」提示", "待整理"],
	["「立即整理」按钮", "立即整理"],
	["待整理提示样式 mem-pending", "mem-pending"],
	["实时通道开关字段 memoryRealtimeExtract", "memoryRealtimeExtract"],
	["裁剪计数 trimmedMsgCount (P5 防跳号)", "trimmedMsgCount"],
	["数据库结构版本 schemaVersion", "schemaVersion"],
	["块标题带「条对话」", "条对话"],
	["近况注入「最近聊过」", "最近聊过"],
	// === 记忆安全网 (收起 + 回收站, 2026-09-28) ===
	["收起字段 fadedAt", "fadedAt"],
	["收起原因字段 fadedReason", "fadedReason"],
	["「已收起（N）」区", "已收起（"],
	["收起区「留下」按钮", "留下"],
	["回收站字段 deletedBin", "deletedBin"],
	["「已删除（N）」区", "已删除（"],
	["「永久删除」按钮", "永久删除"],
	// === 写入门槛 S2 ===
	["写入门槛判据「三个月后它还成立」", "三个月后它还成立"],
	["写入门槛「一次性的不写」", "一次性的不写"],
	["写入门槛「宁可 0 条」", "宁可 0 条"],
	["写入门槛「低于 0.5 的直接别写」", "低于 0.5 的直接别写"],
	// === 整理优化 (记忆口味自学习) ===
	["示例集字段 exampleSet", "exampleSet"],
	["「记忆优化」小节", "记忆优化"],
	["开关文案「自动优化」", "自动优化"],
	["「立即优化」按钮", "立即优化"],
	["「查看示例」按钮", "查看示例"],
	["「清除示例」按钮", "清除示例"],
	["示例段标题「主人认可的记法」", "主人认可的记法"],
	["示例段反例「主人删掉过的」", "主人删掉过的"],
	// === 记忆诊断日志 (P1「观测闭环」, 2026-09-30) ===
	["「记忆诊断」小节", "记忆诊断"],
	["「导出记忆诊断」按钮", "导出记忆诊断"],
	["诊断设置项 memoryDiagnostics", "memoryDiagnostics"],
	["诊断导出文件名 mem-diag", "mem-diag"],
	// === Live2D 模型选择要被记住 (2026-09-30 修) ===
	["设置字段 live2dModel (换模型后重启记得)", "live2dModel"],
	// === 时间感知 (2026-10-01): Nori 能看时间 ===
	["时间块标题【当前时间】", "【当前时间】"],
	["时间设置项 timeAware", "timeAware"],
	// === 一键克隆 + 答题门 (2026-10-01) ===
	["授权验证弹窗标题", "模型授权验证"],
	["授权验证底部提示", "懒得找答案"],
	// === 引导里的 Steam 愿望单 (2026-10-01) ===
	["Steam 愿望单按钮", "加入 Steam 愿望单"],
	["Steam 链接", "store.steampowered.com/app/4996280"],
	// === 参考音频改为联网下载 (2026-10-01) ===
	["一键克隆提示里的联网下载", "联网下载"],
	["一键克隆按钮(预设音色)", "一键克隆预设音色"],
	["引导里的魔法提示", "可能需要**魔法**"],
	// === 音效改为联网下载 (2026-10-02) ===
	["音效下载地址", "59f06f75.pinme.dev"],
	["音效下载按钮", "下载音效"],
]
/** CSS 关键字 (选择器只可能出现在样式里, 查 JS 一定查不到 —— 我第一版就踩了这个) */
const needCss = [
	["块视图样式 .mem-block", ".mem-block"],
	["块内类型小节样式 .mem-sec-title.sub", ".mem-sec-title.sub"],
	["待整理提示样式 .mem-pending", ".mem-pending"],
	["收起区样式 .mem-faded", ".mem-faded"],
	["回收站样式 .mem-deleted", ".mem-deleted"],
	["记忆优化样式 .mem-tune", ".mem-tune"],
	["记忆诊断样式 .mem-diag", ".mem-diag"],
]
let bad = 0
for (const [label, key] of need) {
	const has = js.includes(key)
	console.log(`${has ? "PASS" : "FAIL"}  ${label}`)
	if (!has) bad += 1
}
for (const [label, key] of needCss) {
	const has = css.includes(key)
	console.log(`${has ? "PASS" : "FAIL"}  ${label}`)
	if (!has) bad += 1
}
// 反向: 收敛白名单里**不应**再有「我家」(实测会误并「养猫」/「我家养猫」)
{
	const has = js.includes('"我家"')
	console.log(`${has ? "FAIL" : "PASS"}  收敛白名单已不含「我家」`)
	if (has) bad += 1
}
// 反向: 更新记录必须已经删掉
{
	const has = js.includes("更新记录") || js.includes("changelog-item")
	console.log(`${has ? "FAIL" : "PASS"}  设置页「更新记录」已删除 (包内不含 changelog-item)`)
	if (has) bad += 1
}
// 反向: 记忆编辑 (用户明确不做) 不应出现在包内
{
	const has = /记忆编辑|编辑这条记忆/.test(js)
	console.log(`${has ? "FAIL" : "PASS"}  包内不含「记忆编辑」(用户明确不做的第二步)`)
	if (has) bad += 1
}
// 反向: 像素风下模糊必须归零 —— 断言 CSS 里 --ui-blur-* 的像素档是 0px
{
	const hasPixel = /--ui-blur-dot:\s*0px/.test(css) && /--ui-blur-bubble:\s*0px/.test(css) && /--ui-blur-chip:\s*0px/.test(css)
	console.log(`${hasPixel ? "PASS" : "FAIL"}  C4: 像素风 --ui-blur-* 全为 0px (包内 CSS)`)
	if (!hasPixel) bad += 1
}
// 正向: 底栏图标 (2026-09-30) —— 6 个 png 必须真的在包里, 否则手机上就是裂图
{
	const want = ["dock-diary", "dock-model", "dock-touch", "dock-pomo", "dock-settings", "dock-chat"]
	if (webOnly) {
		const iconsDir = path.resolve(import.meta.dirname, "..", "..", "app", "src", "main", "assets", "web", "icons")
		const got = existsSync(iconsDir) ? readdirSync(iconsDir) : []
		for (const n of want) {
			const ok = got.includes(`${n}.png`)
			console.log(`${ok ? "PASS" : "FAIL"}  底栏图标 ${n}.png 已在 web 产物里`)
			if (!ok) bad += 1
		}
	} else {
		const names = listZipEntryNames(buf)
		for (const n of want) {
			const ok = names.some(x => x.endsWith(`web/icons/${n}.png`))
			console.log(`${ok ? "PASS" : "FAIL"}  底栏图标 ${n}.png 已打进 APK`)
			if (!ok) bad += 1
		}
	}
}
// 反向: 参考音频**不该**再打进 APK (2026-10-01 起改为联网下载) —— 打进去会让包大 2.4MB，
// 且等于把来源不明的人声对外分发（见桌面《公开发布计划》）。
{
	const gone = ["nori-ref.wav", "nori-ref-16k.wav"]
	for (const w of gone) {
		const hit = webOnly
			? existsSync(path.resolve(import.meta.dirname, "..", "..", "app", "src", "main", "assets", "voice", w))
			: listZipEntryNames(buf).some(x => x.endsWith(`voice/${w}`))
		console.log(`${hit ? "FAIL" : "PASS"}  ${w} 已不再打进包（改为联网下载）`)
		if (hit) bad += 1
	}
}
// 正向: 参考音频的下载地址与桥方法在**原生源码**里（2026-10-01 改为联网下载）——
// 它不在 web 产物、也不在 dex 可读字符串里，所以直接查源码文件最实在：URL 被误删会立刻红。
{
	const kt = path.resolve(import.meta.dirname, "..", "..", "app", "src", "main", "java", "com", "noridroid", "ChatBridge.kt")
	const src = existsSync(kt) ? readFileSync(kt, "utf-8") : ""
	const hasUrl = src.includes("https://cb04914b.pinme.dev")
	const hasBridge = src.includes("fun createPresetCloneVoice(")
	const hasConv = src.includes("normalizeWav16")
	console.log(`${hasUrl ? "PASS" : "FAIL"}  原生里保留参考音频下载地址（cb04914b.pinme.dev）`)
	console.log(`${hasBridge ? "PASS" : "FAIL"}  原生里有 createPresetCloneVoice 桥方法`)
	console.log(`${hasConv ? "PASS" : "FAIL"}  原生里有 24→16bit 规范化（normalizeWav16）`)
	if (!hasUrl) bad += 1
	if (!hasBridge) bad += 1
	if (!hasConv) bad += 1
}
// 反向: 音效**不该**再打进 APK (2026-10-02 起改为联网下载) —— 打进包等于继续把
// 音效素材对外分发, 而且用户听到的是听感差的合成版 (见 交接-P3 §19)
{
	const sfxDir = path.resolve(import.meta.dirname, "..", "..", "app", "src", "main", "assets", "sfx")
	const onDisk = existsSync(sfxDir) ? readdirSync(sfxDir, {recursive: true}).filter(f => /\.m4a$/i.test(String(f))) : []
	const inApk = webOnly ? onDisk : listZipEntryNames(buf).filter(x => /assets\/sfx\/.*\.m4a$/i.test(x))
	const gone = onDisk.length === 0 && inApk.length === 0
	console.log(`${gone ? "PASS" : "FAIL"}  assets/sfx/*.m4a 已不再打进包（改为联网下载）${gone ? "" : ` ← ${JSON.stringify(inApk)}`}`)
	if (!gone) bad += 1
	for (const n of ["button_click.m4a", "start.m4a", "complete.m4a", "return.m4a", "abandon.m4a"]) {
		const hit = webOnly
			? onDisk.some(f => String(f).endsWith(n))
			: (inApk.some(x => x.endsWith(`sfx/${n}`)) || inApk.some(x => x.endsWith(`sfx/pomo/${n}`)))
		console.log(`${hit ? "FAIL" : "PASS"}  ${n} 不在包内`)
		if (hit) bad += 1
	}
}
// 正向: 音效的下载地址 / 桥方法 / 本地供流路径在**原生源码**里 (2026-10-02 改为联网下载) ——
// 这三样都不在 web 产物里, 只能查源码 (照上面参考音频那段的写法): 少一样就是"下了也不知道往哪放".
{
	const kt = path.resolve(import.meta.dirname, "..", "..", "app", "src", "main", "java", "com", "noridroid", "ChatBridge.kt")
	const src = existsSync(kt) ? readFileSync(kt, "utf-8") : ""
	const main = path.resolve(import.meta.dirname, "..", "..", "app", "src", "main", "java", "com", "noridroid", "MainActivity.kt")
	const mainSrc = existsSync(main) ? readFileSync(main, "utf-8") : ""
	const hasDl = src.includes("fun downloadSfx(")
	const hasUrl = src.includes("https://59f06f75.pinme.dev")
	const hasStream = mainSrc.includes("/sfx-local/")
	console.log(`${hasDl ? "PASS" : "FAIL"}  原生里有 downloadSfx 桥方法`)
	console.log(`${hasUrl ? "PASS" : "FAIL"}  原生里保留音效下载地址（59f06f75.pinme.dev）`)
	console.log(`${hasStream ? "PASS" : "FAIL"}  原生里注册了 /sfx-local/ 本地供流处理器`)
	if (!hasDl) bad += 1
	if (!hasUrl) bad += 1
	if (!hasStream) bad += 1
}
console.log(bad ? `\n${bad} 项未通过` : "\n全部通过: APK 内的前端就是本轮构建")
process.exitCode = bad ? 1 : 0
