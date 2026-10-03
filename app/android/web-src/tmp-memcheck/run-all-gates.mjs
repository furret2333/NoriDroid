/* 一键全量门禁 (2026-09-29): 把散在文档里的 24+ 条命令收成一条, 自动起停 harness, 出汇总表。
 *
 * 用法:
 *   node tmp-memcheck/run-all-gates.mjs              # 全量 (含 pnpm build + E2E, 约 12~15 分钟)
 *   node tmp-memcheck/run-all-gates.mjs --fast       # 跳过 E2E / build / 评估探针 (改代码时的快速回路, ~1 分钟)
 *   node tmp-memcheck/run-all-gates.mjs --no-build   # 跳过 pnpm build (已构建过)
 *   node tmp-memcheck/run-all-gates.mjs --only=mem   # 只跑名字里含 mem 的套件
 *   node tmp-memcheck/run-all-gates.mjs --list       # 只列出会跑哪些套件
 *
 * 设计取舍 (都是踩过的坑):
 * - **不用管道**: 子进程输出直接写文件描述符 (stdio: ["ignore", fd, fd]) —— 沙箱受限模式下
 *   管道会 EPERM, 而且日志落盘也方便回溯。
 * - **harness**: 8123 已在监听就复用 (跑完不关, 那是别人的); 没在跑才自己起, 跑完关掉自己的。
 * - **E2E 串行跑**: 各套用不同的 CDP 端口, 但并行时相互抢 CPU 会让"等渲染"的超时误报, 得不偿失。
 */
import {spawn} from "node:child_process"
import {openSync, closeSync, readFileSync, writeFileSync, existsSync} from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const memDir = path.join(root, "tmp-memcheck")
const appDir = path.join(root, "..")            // app/android
const argv = process.argv.slice(2)
const has = (f) => argv.some(a => a === f || a.startsWith(`${f}=`))
const val = (f) => { const a = argv.find(x => x.startsWith(`${f}=`)); return a ? a.slice(f.length + 1) : "" }
const FAST = has("--fast")
const NO_BUILD = has("--no-build") || FAST
const ONLY = val("--only")

/** 套件表: kind = unit(纯 Node) / probe(探针) / probe-h(需要 harness) / probe-eval(评估用) / e2e(需要 harness) */
const SUITES = [
	{name: "run-tests", kind: "unit"},
	{name: "run-memory-collapse-tests", kind: "unit"},
	{name: "run-marker-tests", kind: "unit"},
	{name: "run-tts-tests", kind: "unit"},
	{name: "run-chat-tests", kind: "unit"},
	{name: "verify-habit-peak", kind: "unit"},        // B1: habitProfile().peakHour 必须落在真实高峰桶 (修前恒为 -1)
	{name: "verify-floatservice-fgs", kind: "unit"},  // B3: 悬浮窗服务的前台服务契约 (manifest 类型/权限 + startForeground 先于 addView + 通知剪影图标)
	{name: "probe-trim-skip", kind: "probe"},
	{name: "probe-organize-cadence", kind: "probe"},
	{name: "probe-mem-collapse-safety", kind: "probe"},
	{name: "probe-mem-correction", kind: "probe"},
	{name: "probe-invalid-reflow", kind: "probe"},
	{name: "probe-restore-rollback", kind: "probe"},
	{name: "prop-summary-overlap", kind: "probe"},
	{name: "probe-recall-tiering", kind: "probe-eval"},   // 评估用 (非门禁, 只报告不改判)
	{name: "probe-longrun-capacity", kind: "probe-eval"},  // P3 长期运行推演 (模拟一年; 只报告"发现", 加 --strict 才算失败)
	{name: "probe-dual-instance-fuzz", kind: "probe-eval"}, // P2 双实例模糊测试 (随机操作两个窗口; 报告型, --strict 才算失败)
	{name: "probe-organize-button", kind: "probe-h"},
	{name: "probe-mem-panel-render", kind: "probe-h"},     // 量「已收起」条数 → 记忆库打开/展开耗时 (P3 §5)
	{name: "probe-mem-diag-ui", kind: "probe-h"},          // 记忆诊断日志: 开关/记录/导出 (P1)
	{name: "probe-ui-asterisks", kind: "probe-h"},         // 界面里有没有字面 ** (markdown 漏渲染)
	{name: "probe-model-pick-persist", kind: "probe-h"},   // Live2D 模型选择要被记住 (换模型重启不回第一只)
	{name: "probe-time-context", kind: "probe-h"},         // Nori 看得到当前时间 (payload 里有人格+时间块, 顺序对)
	{name: "probe-clone-gate", kind: "probe-h"},
	{name: "probe-model-download-gate", kind: "probe-h"},  // 下载模型前的同一道答题门: 没答对不许下载/取消也不下载 + 克隆那道门没被搞坏
	{name: "probe-bubble-place", kind: "probe-h"},   // float bubble initial placement (below model)           // 一键克隆的答题门 + 引导里的 Steam 愿望单
	{name: "probe-persona-import", kind: "probe-h"},       // 设置顶部导入自定义人设 (替代内置提示词) + payload 真的换了
	{name: "probe-sfx-download", kind: "probe-h"},         // 音效改为联网下载: 设置里「下载音效」+ 未下载时静默不报错
	{name: "probe-about-page", kind: "probe-h"},           // 设置里的「关于 / 隐私 / 开源许可」页: 入口 + 四块内容(版本/隐私/许可/反馈) + 链接走 openExternal
	{name: "probe-bgm-state", kind: "probe-h"},            // BGM「已下载」按磁盘算: 开关关着 + 重启后仍显示「资源已就绪」
	{name: "probe-thinking-default", kind: "probe-h"},     // DeepSeek 思考模式: 默认开 + 关掉时显式传 disabled + 非 DeepSeek 端点不塞字段
	{name: "probe-main-fps", kind: "probe-h"},             // 掉帧: 两个 Live2D 同时渲染的代价 + 暂停渲染后恢复 + 隐藏时 0 排程 0 帧 (要两个 Edge 进程, ~1.5 分钟)
	{name: "e2e-mem-invalid", kind: "e2e"},
	{name: "e2e-mem-blocks", kind: "e2e"},
	{name: "e2e-mem-realtime", kind: "e2e"},
	{name: "e2e-mem-menu", kind: "e2e"},
	{name: "e2e-mem-gate", kind: "e2e"},
	{name: "e2e-goal-done", kind: "e2e"},
	{name: "e2e-mem-faded", kind: "e2e"},
	{name: "e2e-mem-tune", kind: "e2e"},
	{name: "e2e-mem-name-write", kind: "e2e"},
	{name: "e2e-pixel-ui", kind: "e2e"},
	{name: "e2e-storage-probe", kind: "e2e"},
	{name: "e2e-intro", kind: "e2e"},
	{name: "e2e-tts-hint", kind: "e2e"},
	{name: "e2e-pet-hover", kind: "e2e"},
	{name: "e2e-pet-effect", kind: "e2e"},
]

if (has("--list")) {
	for (const s of SUITES) console.log(`  ${s.kind.padEnd(10)} ${s.name}`)
	console.log(`  ${"precheck".padEnd(10)} verify-apk-bundle --web`)
	process.exit(0)
}

const picked = SUITES.filter(s => !ONLY || s.name.includes(ONLY))
// --fast: 只跑纯 Node 的**门禁**套件 (unit + 探针), 跳过需要浏览器/harness 的 (e2e + probe-h)
//         与 build; probe-eval 是"评估用、不改判"的 (recall 分层 / P3 长期推演, 后者要 40s+),
//         快速回路里跳过, 全量跑时才算。
const willRun = picked.filter(s => !(FAST && (s.kind === "e2e" || s.kind === "probe-h" || s.kind === "probe-eval")))
const needHarness = willRun.some(s => s.kind === "e2e" || s.kind === "probe-h")
const startedAt = Date.now()
const report = []
const say = (s) => { console.log(s); report.push(s) }

/** 用文件描述符接子进程输出 (不用管道) */
const runCmd = (cmd, args, opts = {}) => new Promise((resolve) => {
	const logFile = path.join(memDir, `_gate-${opts.tag ?? "cmd"}.log`)
	const fd = openSync(logFile, "w")
	const t0 = Date.now()
	const child = spawn(cmd, args, {cwd: opts.cwd ?? memDir, stdio: ["ignore", fd, fd]})
	child.on("error", () => { closeSync(fd); resolve({code: -1, logFile, ms: Date.now() - t0}) })
	child.on("close", (code) => { closeSync(fd); resolve({code: code ?? -1, logFile, ms: Date.now() - t0}) })
})

const tailCount = (logFile) => {
	try {
		const txt = readFileSync(logFile, "utf8")
		const m = [...txt.matchAll(/(\d+)\/(\d+) passed/g)].pop()
		if (m) return `${m[1]}/${m[2]}`
		if (/\bOK\b/.test(txt)) return "OK"
		return ""
	} catch { return "" }
}

const harnessUp = async () => {
	try {
		const r = await fetch("http://127.0.0.1:8123/assets/web/index.html", {signal: AbortSignal.timeout(1200)})
		return r.ok
	} catch { return false }
}

say(`===== 一键门禁 ${new Date().toLocaleString()} ${FAST ? "(--fast)" : ""}${ONLY ? ` (--only=${ONLY})` : ""} =====`)

/* ① 构建 (含 vue-tsc 类型检查) */
if (!NO_BUILD) {
	process.stdout.write("构建中 (pnpm build)… ")
	const r = await runCmd(process.env.ComSpec || "cmd.exe", ["/c", "pnpm build"], {cwd: root, tag: "build"})
	say(`\n  ${r.code === 0 ? "PASS" : "FAIL"}  pnpm build (含 vue-tsc)  ${(r.ms / 1000).toFixed(1)}s`)
	if (r.code !== 0) {
		const t = readFileSync(r.logFile, "utf8").split("\n").filter(l => /error/i.test(l)).slice(0, 5).join("\n")
		say(`        ${t || "(见 _gate-build.log)"}`)
	}
}

/* ② harness (需要时) */
let harnessProc = null
if (needHarness) {
	if (await harnessUp()) {
		say("  harness: 复用已在 8123 运行的实例 (跑完不关)")
	} else {
		process.stdout.write("启动 harness… ")
		const fd = openSync(path.join(memDir, "_gate-harness.log"), "w")
		harnessProc = spawn(process.execPath, [".harness/server.mjs"], {cwd: appDir, stdio: ["ignore", fd, fd]})
		closeSync(fd)
		let up = false
		for (let i = 0; i < 40 && !up; i += 1) { await new Promise(r => setTimeout(r, 250)); up = await harnessUp() }
		say(up ? "\n  harness: 已启动 (0.0.0.0:8123)" : "\n  harness: **启动失败** (见 _gate-harness.log)")
	}
}

/* ③ 套件 */
const results = []
for (const s of willRun) {
	process.stdout.write(`\r  ${s.name} …`.padEnd(60))
	const r = await runCmd(process.execPath, [`${s.name}.mjs`], {cwd: memDir, tag: s.name})
	const verdict = r.code === 0 ? "PASS" : "FAIL"
	const cnt = tailCount(r.logFile)
	results.push({name: s.name, kind: s.kind, verdict, cnt, ms: r.ms, log: r.logFile})
	process.stdout.write(`\r  ${verdict === "PASS" ? "✓" : "✗"} ${s.name.padEnd(30)} ${cnt.padEnd(9)} ${(r.ms / 1000).toFixed(1)}s\n`)
}

/* ④ 打包前预检 (查已构建的 web 产物关键字) */
if (!FAST) {
	process.stdout.write("\r  verify-apk-bundle --web …".padEnd(60))
	const r = await runCmd(process.execPath, ["verify-apk-bundle.mjs", "--web"], {cwd: memDir, tag: "precheck"})
	const txt = readFileSync(r.logFile, "utf8")
	const pass = (txt.match(/^PASS/gm) ?? []).length
	const fail = (txt.match(/^FAIL/gm) ?? []).length
	results.push({name: "verify-apk-bundle --web", kind: "precheck", verdict: r.code === 0 ? "PASS" : "FAIL", cnt: `${pass}项/${fail}失败`, ms: r.ms, log: r.logFile})
	process.stdout.write(`\r  ${r.code === 0 ? "✓" : "✗"} ${"verify-apk-bundle --web".padEnd(30)} ${pass} 项关键字 ${(r.ms / 1000).toFixed(1)}s\n`)
}

/* ⑤ 关掉自己起的 harness */
if (harnessProc) {
	try { harnessProc.kill() } catch { /* 忽略 */ }
	say("  harness: 已关闭 (自己起的)")
}

/* ⑥ 汇总 */
const failed = results.filter(r => r.verdict !== "PASS")
say("\n===== 汇总 =====")
say(`  ${results.length - failed.length}/${results.length} 套通过 · 总耗时 ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} 分钟`)
const byKind = {}
for (const r of results) (byKind[r.kind] ??= []).push(r)
for (const [kind, list] of Object.entries(byKind)) {
	say(`  [${kind}] ${list.filter(r => r.verdict === "PASS").length}/${list.length} 通过`)
}
if (failed.length) {
	say("  失败项 (看对应日志):")
	for (const f of failed) say(`    - ${f.name}  →  ${path.relative(process.cwd(), f.log)}`)
}
const reportFile = path.join(memDir, "_gates-report.txt")
writeFileSync(reportFile, report.join("\n") + "\n", "utf8")
console.log(`\n报告已写入: ${path.relative(process.cwd(), reportFile)}`)
process.exitCode = failed.length ? 1 : 0
