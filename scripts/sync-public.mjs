#!/usr/bin/env node
/**
 * 把当前仓库同步成**只含 Android 版**的干净快照，以「带历史」的方式推到公开仓库。
 *
 * 三条硬规矩（任何一条不满足就 exit(1)，**绝不推送**）：
 *   ① 只导出**已提交的 HEAD**（工作区改动不带进快照）；
 *   ② 快照里只允许出现：Android 代码 + `README.md` / `LICENSE` / `SETUP.md` / `THIRD-PARTY.md`
 *      （外加 `.github/` 与 `scripts/`）—— 交接/清单/方案这类**内部文档一律不进公开仓库**；
 *   ③ 推送前跑**隐私/密钥扫描**：命中本机绝对路径、密钥文件名、口令字面量、常见凭据、
 *      日志/临时物 ⇒ 直接报错退出（fail-closed，"宁可拦住也不许推"）。
 *
 * 公开仓库是**带历史**的：新提交以公开仓库当前 `main` 为父提交，**fast-forward** 推上去（不带 `-f`）。
 * 快照内容每次仍是**全量导出**（不是增量 diff）——"敏感内容永不进历史"靠的是导出 + 硬扫描，
 * 而不是靠强推覆盖。
 *
 * 为什么要有它：公开仓库以前是"单次提交的干净快照 + 强推"，手动拼很容易漏 —— 2026-10-02 我就因为
 * `git checkout-index` 不认目录、`--stdin` 又不按预期工作，把公开仓库推成过只有 3 个文件的样子；
 * 同一天还出过 `keystore/*.jks` 与口令文件被推进公开仓库的事故。所以这里有一条硬规矩：
 * **本地校验或扫描不通过，绝不推送**。
 *
 * 用法（在仓库根目录）：
 *   node scripts/sync-public.mjs                 # 导出 → 清理 → 校验+扫描 → 建提交 → FF 推送
 *   node scripts/sync-public.mjs --dry-run       # 只到校验+扫描为止（安全预演，不建提交不推）
 *   node scripts/sync-public.mjs --keep-temp     # 保留临时目录，便于人工翻看
 *   node scripts/sync-public.mjs --tmp <目录>    # 跳过导出，直接对已有目录跑清理+校验+扫描（复现/调试）
 *   node scripts/sync-public.mjs --remote <URL>  # 换推送目标（默认公开仓库；可指向本地裸仓库做演练）
 *   node scripts/sync-public.mjs --message "..." # 自定义提交信息
 *
 * 只同步**已提交**的内容（HEAD）。工作区有未提交改动时会提示，但不会带进快照。
 */
import {execFileSync} from "node:child_process"
import {existsSync, rmSync, readdirSync, appendFileSync, readFileSync, writeFileSync, statSync,
	openSync, readSync, closeSync} from "node:fs"
import {join, resolve, extname, basename} from "node:path"
import {tmpdir} from "node:os"

const REPO_ROOT = resolve(import.meta.dirname, "..")
const PUBLIC_REMOTE = "https://github.com/furret2333/NoriDroid.git"

/** 公开快照的提交作者：**必须显式指定** —— 默认身份会把提交挂到不相干的账号上
 *  （公开仓库侧栏因此显示"没有贡献者"）。作者与提交者设成同一个，避免两者不一致。 */
const COMMIT_IDENTITY = {name: "HuiOVO", email: "317002734+furret2333@users.noreply.github.com"}

/** 根级只保留这些（其余根级条目一律排除，并逐条打印原因） */
const ROOT_KEEP_FILES = [".gitignore", "README.md", "LICENSE", "SETUP.md", "THIRD-PARTY.md"]
const ROOT_KEEP_DIRS = [".github", "app", "scripts"]
/** 根级"内部文档"的命名（用户要求：这些是项目记忆，留在私有仓库，不进公开仓库） */
const ROOT_DOC_PATTERNS = [/^交接-.*\.md$/, /^实机验证清单-.*\.md$/, /^待办清单-.*\.md$/,
	/^记忆模块重构方案-.*\.md$/, /^长期.*\.md$/, /^回滚说明\.txt$/]
/** 上游 / 不该进公开仓库的目录（相对仓库根） */
const DROP_DIRS = ["app/desktop", "backend", "docs", "backups", ".reasonix"]
/** 全树按目录名清理（日志/临时物） */
const DROP_DIR_NAMES = [".scope-logs"]

/**
 * ⚠ 只允许排除**下面这份显式清单**里的文件；除了它们，任何泄露都靠硬扫描门"命中即拒绝推送"，
 * **不会被自动放行**（不许用"自动排除"蒙混过关）。
 *
 * 这些文件的共同点：**开发机专用脚本，硬编码了本机绝对路径**（D 盘上的仓库树、C 盘用户目录下的
 * 私人聊天软件目录等），在别人机器上本来也跑不起来，还会泄露本机用户名与目录结构；
 * `.lnk` 是 Windows 快捷方式，绝对路径内嵌在二进制里（文本扫描扫不到）。
 * 私有仓库里的这些文件**一字不动**，只是不导出进公开快照。
 */
const DROP_DEV_FILES = [
	// 本地实测服务器 + Windows 快捷方式
	"app/android/.harness/server.mjs",
	"app/android/.harness/打开测试服务器.bat.lnk",
	// 一次性开发脚本（改文件 / 生成资源 / 出预览图 / 跑本地 APK 检查）
	"app/android/web-src/tmp-memcheck/_add-repo-button.py",
	"app/android/web-src/tmp-memcheck/_check-preset-voice.mjs",
	"app/android/web-src/tmp-memcheck/_drop-builtin-persona.py",
	"app/android/web-src/tmp-memcheck/_fix-persona-probe.py",
	"app/android/web-src/tmp-memcheck/_fix-statusline-and-escape.py",
	"app/android/web-src/tmp-memcheck/_fix-time-probe.py",
	"app/android/web-src/tmp-memcheck/_gen-assets.py",
	"app/android/web-src/tmp-memcheck/_montage-icons.py",
	"app/android/web-src/tmp-memcheck/_prep-app-icon.py",
	"app/android/web-src/tmp-memcheck/_prep-clone-voice.py",
	"app/android/web-src/tmp-memcheck/_prep-dock-icons.py",
	"app/android/web-src/tmp-memcheck/_prep-dock-mono.py",
	"app/android/web-src/tmp-memcheck/_prep-dock-redraw.py",
	"app/android/web-src/tmp-memcheck/_prep-icon-variants.py",
]

/** 必须存在的文件（校验用；少一个就说明导出/清理错了） */
const MUST_HAVE = ["app/android/app/src/main/java/com/noridroid/ChatBridge.kt",
	"app/android/web-src/src/App.vue", "app/android/web-src/tmp-memcheck/run-tests.mjs",
	"README.md", "LICENSE", "SETUP.md", "THIRD-PARTY.md", ".github/workflows/android.yml"]
/** 最少文件数（低于这个数说明导出不完整） */
const MIN_FILES = 150

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const dryRun = flag("--dry-run")
const keepTemp = flag("--keep-temp")
const reuseTmp = opt("--tmp") ? resolve(opt("--tmp")) : null
const REMOTE = opt("--remote") ?? PUBLIC_REMOTE
/* 提交信息：默认带上 app 的 versionName，读 app/android/app/build.gradle
   （2026-10-02 用户要求：原来的『chore: 公开快照同步…』在每个文件上都显示同一串、太难看） */
const appVersion = (() => {
	try {
		const m = readFileSync(join(REPO_ROOT, "app/android/app/build.gradle"), "utf8").match(/versionName\s+"([^"]+)"/)
		return m ? m[1] : "?"
	} catch { return "?" }
})()
const message = opt("--message") ?? `release: v${appVersion}（Android 版源码快照）`

const log = (...a) => console.log(...a)
const GIT_ENV = {...process.env, GIT_TERMINAL_PROMPT: "0"}
const git = (args, opts = {}) => execFileSync("git", args, {cwd: opts.cwd ?? REPO_ROOT,
	stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", env: GIT_ENV})

// ---------- 0) 工作区状态提示 ----------
const dirty = git(["status", "--porcelain"], {quiet: true}).trim()
if (dirty) log(`⚠ 工作区有未提交改动（${dirty.split("\n").length} 个文件）——快照只含已提交的 HEAD 内容，这些不会进去`)

// ---------- 1) 导出 HEAD 的全部跟踪文件 ----------
let tmp
if (reuseTmp) {
	if (!existsSync(reuseTmp)) { log(`✗ --tmp 指定的目录不存在：${reuseTmp}`); process.exit(1) }
	tmp = reuseTmp
	log(`\n[1/5] 复用已有目录（跳过导出）→ ${tmp}`)
	log(`      目录里现有条目 ${readdirSync(tmp, {recursive: true}).length} 个`)
} else {
	tmp = join(tmpdir(), `nori-public-${Date.now()}`)
	rmSync(tmp, {recursive: true, force: true})
	execFileSync("node", ["-e", `require('fs').mkdirSync(${JSON.stringify(tmp)},{recursive:true})`])
	log(`\n[1/5] 导出 HEAD → ${tmp}`)
	/* ⚠ 必须用**临时索引**导出 HEAD：直接 `checkout-index -a` 导出的是**暂存区（index）**，
	   谁 `git add` 过什么，快照里就是什么 —— 那等于把"未提交内容"偷偷带进公开仓库。
	   这里 read-tree HEAD 到独立索引文件，导出的就是货真价实的 HEAD。 */
	const tmpIdx = join(tmpdir(), `nori-sync-index-${Date.now()}`)
	rmSync(tmpIdx, {force: true})
	const idxEnv = {...GIT_ENV, GIT_INDEX_FILE: tmpIdx}
	execFileSync("git", ["read-tree", "HEAD"], {cwd: REPO_ROOT, env: idxEnv})
	execFileSync("git", ["checkout-index", "-a", `--prefix=${tmp}/`], {cwd: REPO_ROOT, env: idxEnv})
	rmSync(tmpIdx, {force: true})
	log(`      导出条目 ${readdirSync(tmp, {recursive: true}).length} 个（来自 HEAD，不含暂存区/工作区改动）`)
}

// ---------- 2) 清理：上游 / 内部文档 / 本机专用脚本 / Live2D Core ----------
log("[2/5] 清理上游 / 内部文档 / 不要的东西")
const dropped = []
const drop = (rel, why) => {
	const p = join(tmp, rel)
	if (!existsSync(p)) return false
	rmSync(p, {recursive: true, force: true})
	dropped.push({rel, why})
	log(`      删 ${rel}（${why}）`)
	return true
}
// 2a. 根级：只留白名单里的（内部文档、上游目录、杂项都在这里被挡掉）
for (const e of readdirSync(tmp, {withFileTypes: true})) {
	const keep = e.isDirectory() ? ROOT_KEEP_DIRS.includes(e.name) : ROOT_KEEP_FILES.includes(e.name)
	if (keep) continue
	const why = ROOT_DOC_PATTERNS.some((re) => re.test(e.name)) ? "内部文档（不入公开仓库）"
		: e.isDirectory() ? "根级非白名单目录" : "根级非白名单文件"
	drop(e.name, why)
}
// 2b. 上游 / 不要的目录
for (const d of DROP_DIRS) drop(d, "上游或不该公开")
// 2c. 全树按名字清理的目录（日志）
;(function walkDropDirs(dir, base = "") {
	for (const e of readdirSync(dir, {withFileTypes: true})) {
		const rel = base ? `${base}/${e.name}` : e.name
		if (!e.isDirectory()) continue
		if (DROP_DIR_NAMES.includes(e.name)) drop(rel, "日志/临时物目录")
		else walkDropDirs(join(dir, e.name), rel)
	}
})(tmp)
// 2d. 显式清单：开发机专用、硬编码本机路径的脚本（见 DROP_DEV_FILES 注释）
for (const f of DROP_DEV_FILES) drop(f, "开发机专用（硬编码本机绝对路径）")
// 2e. Live2D Cubism Core（专有许可，不进仓库）
let coreCount = 0
;(function walkCore(dir) {
	for (const e of readdirSync(dir, {withFileTypes: true})) {
		const p = join(dir, e.name)
		if (e.isDirectory()) walkCore(p)
		else if (e.name === "live2dcubismcore.min.js") { rmSync(p, {force: true}); coreCount += 1 }
	}
})(tmp)
log(`      删 Core 文件 ${coreCount} 个`)

// .gitignore 补一条（防以后又提交进来）
const giPath = join(tmp, ".gitignore")
const giLine = "\n# Live2D Cubism Core（专有许可，不进仓库；见 SETUP.md）\nlive2dcubismcore.min.js\n"
const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : ""
if (!gi.includes("live2dcubismcore.min.js")) {
	writeFileSync(giPath, gi + giLine, "utf8")
	log("      .gitignore 补了 Core 忽略项")
}
// README 末尾补"本仓库只含 Android 版"
const rdPath = join(tmp, "README.md")
const note = "\n---\n\n> **本仓库只包含 Android 版**（`app/android`）。上游的桌面版（Tauri）与服务端（Go）不在本仓库内。\n"
if (existsSync(rdPath) && !readFileSync(rdPath, "utf8").includes("本仓库只包含 Android 版")) {
	appendFileSync(rdPath, note, "utf8")
	log("      README 补了说明")
}

// ---------- 3) 本地硬校验 + 隐私/密钥扫描（不过就退出，绝不推） ----------
log("[3/5] 本地校验 + 隐私/密钥扫描")
const problems = []
for (const f of MUST_HAVE) if (!existsSync(join(tmp, f))) problems.push(`缺少必需文件: ${f}`)
for (const d of DROP_DIRS) if (existsSync(join(tmp, d))) problems.push(`上游/不要的目录还在: ${d}`)
for (const f of DROP_DEV_FILES) if (existsSync(join(tmp, f))) problems.push(`开发机专用脚本没被排除: ${f}`)
for (const e of readdirSync(tmp, {withFileTypes: true})) {
	const keep = e.isDirectory() ? ROOT_KEEP_DIRS.includes(e.name) : ROOT_KEEP_FILES.includes(e.name)
	if (!keep) problems.push(`根级出现白名单之外的东西: ${e.name}`)
}
let leftoverCore = false
;(function scanCore(dir) {
	for (const e of readdirSync(dir, {withFileTypes: true})) {
		const p = join(dir, e.name)
		if (e.isDirectory()) scanCore(p)
		else if (e.name === "live2dcubismcore.min.js") leftoverCore = true
	}
})(tmp)
if (leftoverCore) problems.push("Live2D Cubism Core 还在快照里")
const files = (function list(dir, base = "", out = []) {
	for (const e of readdirSync(dir, {withFileTypes: true})) {
		const rel = base ? `${base}/${e.name}` : e.name
		if (e.isDirectory()) list(join(dir, e.name), rel, out)
		else out.push(rel)
	}
	return out
})(tmp)
if (files.length < MIN_FILES) problems.push(`文件数过少（${files.length} < ${MIN_FILES}）——导出可能不完整`)

// ---------- 隐私/密钥扫描：命中就拒绝推送（fail-closed） ----------
/** 只查文本文件：先按扩展名，再做"头部含 NUL 即二进制"的探测 */
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".jar",
	".apk", ".aab", ".jks", ".keystore", ".p12", ".pfx", ".zip", ".gz", ".7z", ".rar", ".mp3", ".mp4",
	".m4a", ".wav", ".ogg", ".opus", ".flac", ".ttf", ".otf", ".woff", ".woff2", ".so", ".dll", ".exe",
	".bin", ".pdf", ".class", ".dex", ".arsc", ".lnk", ".db", ".sqlite", ".psd", ".tflite", ".onnx",
	".aar", ".der", ".wasm"])
const probeBinary = (p) => {
	const fd = openSync(p, "r")
	try {
		const buf = Buffer.alloc(4096)
		const n = readSync(fd, buf, 0, 4096, 0)
		for (let i = 0; i < n; i++) if (buf[i] === 0) return true
		return false
	} finally { closeSync(fd) }
}
/** 内容规则（文本文件逐行查） */
const CONTENT_RULES = [
	// 规则名（id）里**故意不写命中串本身**：否则扫描器会扫到自己的规则表（下面两条口令规则除外，见 SELF_SKIP_RULES）
	{id: "本机绝对路径（D 盘仓库树）", re: /D:[\\/]{1,2}norinew/i},
	{id: "本机绝对路径（C 盘用户目录）", re: /C:[\\/]{1,2}Users\b/i},
	{id: "本机用户名（Windows 默认管理员账号）", re: new RegExp("Administ" + "rator")},
	{id: "macOS 家目录（/Users）", re: /\/Users\//},
	{id: "Linux 家目录（/home）", re: /\/home\//},
	{id: "签名口令字段 storePassword/keyPassword", re: /(?:store|key)Password\b/, passwordField: true, secret: true},
	{id: "私钥块 -----BEGIN … PRIVATE KEY-----", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, secret: true},
	{id: "API Key 字面量 sk-…", re: /sk-[A-Za-z0-9_-]{16,}/, secret: true},
	/* `api[_-]?key[:=]` 本身在代码里到处都是（`apiKey: string` 这种类型标注 / 形参 / 传参），
	   按字面匹配会一次命中 115 处全是误报 ⇒ 只把"右边真是密钥字面量"的算命中（占位符不算）。 */
	{id: "API Key 赋值字面量 apiKey=\"…\"", re: /api[_-]?key["']?\s*[:=]\s*["'`]([^"'`\r\n]{8,})["'`]/i, literalGroup: 1, secret: true},
	{id: "API Key 赋值裸串 apiKey=<长串>", re: /api[_-]?key["']?\s*[:=]\s*([A-Za-z0-9_-]{20,})\b/i, literalGroup: 1, secret: true},
	{id: "GitHub token ghp_…", re: /ghp_[A-Za-z0-9]{10,}/, secret: true},
	{id: "GitHub token github_pat_…", re: /github_pat_[A-Za-z0-9_]{10,}/, secret: true},
	{id: "AWS Access Key AKIA…", re: /AKIA[0-9A-Z]{12,}/, secret: true},
	{id: "Slack token xox[baprs]-…", re: /xox[baprs]-[A-Za-z0-9-]{6,}/, secret: true},
]
/** 文件/目录名规则 */
const NAME_RULES = [
	{id: "签名密钥库 *.jks", re: /\.jks$/i},
	{id: "签名密钥库 *.keystore", re: /\.keystore$/i},
	{id: "口令文件 口令*.txt", re: /^口令.*\.txt$/i},
	{id: "gradle 签名配置 keystore.properties", re: /^keystore\.properties$/i},
	{id: "日志目录 .scope-logs/", re: /(^|\/)\.scope-logs(\/|$)/, dir: true},
	{id: "日志文件 *.log", re: /\.log$/i},
	{id: "临时文件 tmp-*", re: /^tmp-/i},
	{id: "压缩包 *.zip", re: /\.zip$/i},
	// 同类风险，一起挡（见下方"额外规则"说明）
	{id: "私钥/证书 *.pem|*.key|*.p12|*.pfx", re: /\.(pem|key|p12|pfx)$/i},
	{id: "SSH 私钥 id_rsa*", re: /^id_(rsa|ed25519|ecdsa)/i},
	{id: "Windows 快捷方式 *.lnk（内嵌绝对路径）", re: /\.lnk$/i},
	{id: "dotenv .env", re: /^\.env$/i},
	{id: "补丁/备份 *.patch|*.diff|*.orig|*.bak", re: /\.(patch|diff|orig|bak)$/i},
]
/** storePassword/keyPassword 后面是"从外部读"而不是字面量时放行（例：`storePassword ksProps['storePassword']`） */
const SAFE_PASSWORD_VALUE = /^\s*[:=]?\s*["']?\s*(?:ksProps\b|findProperty\s*\(|providers\b|localProperties\b|System\.getenv\b|System\.getProperty\b|project\b|rootProject\b|env\b|\$\{|%|\$|process\.env)/
/** `apiKey = "<占位符>"` / `apiKey = "${ENV}"` 这种不算泄露（真密钥有 sk- / AKIA / ghp_ 等自己的规则兜底） */
const PLACEHOLDER_VALUE = /^(?:\$\{|%|process\.env|import\.meta|your|xxx|placeholder|changeme|example|demo|<|\.\.\.)/i
/** 右边"看起来像真密钥"才拦：≥20 字符 / 含数字 / 无空格，或带已知密钥前缀。
 *  探针脚本里到处都是 `apiKey: "sk-probe"`、`"sk-fake-for-test"` 这类**测试假值**（真密钥不会这么短）。 */
const looksLikeRealKey = (v) => {
	const s = String(v)
	if (/\s/.test(s)) return false
	if (/^(?:sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|ghp_|github_pat_|AKIA|xox[baprs]-)/.test(s)) return true
	return s.length >= 20 && /[0-9]/.test(s) && /[A-Za-z]/.test(s)
}
/** ⚠ 只提示、不拦截：任意盘符的本机绝对路径（例如探针脚本里硬编码的本机浏览器可执行文件位置、
 *  素材出处注释里的旧工作树）。它们不含用户名/密钥，且在 ~30 个探针脚本里是"本机 Edge 路径"这种
 *  标准工具位置（拦了就没法推）⇒ 列出来供人工判断。真正的用户目录路径（C 盘用户目录、D 盘仓库树、
 *  默认管理员用户名）在 CONTENT_RULES 里是**硬拦**的。 */
const PATH_HINT = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?=[A-Za-z0-9_\u4e00-\u9fff])/
/** ⚠ 扫描器自己的文件：规则表与说明里必然出现这些"命中串"（它就是规则本身）⇒ 对这个文件跳过这几条，
 *  否则每次都被自己拦下。**凭据类规则（私钥块 / ghp_ / github_pat_ / AKIA / xox / sk- 长串）仍然照查它**。
 *  这一条会打印出来，不是暗箱。 */
const SCANNER_SELF = "scripts/sync-public.mjs"
const SELF_SKIP_RULES = new Set([
	"本机绝对路径（D 盘仓库树）",
	"本机绝对路径（C 盘用户目录）",
	"本机用户名（Windows 默认管理员账号）",
	"macOS 家目录（/Users）",
	"Linux 家目录（/home）",
	"签名口令字段 storePassword/keyPassword",
	"API Key 赋值字面量 apiKey=\"…\"",
	"API Key 赋值裸串 apiKey=<长串>",
])
const snippetOf = (h) => {
	let s = String(h.snippet ?? "").replace(/\s+/g, " ").trim()
	if (h.secret) for (const r of CONTENT_RULES) if (r.secret) s = s.replace(r.re, "[已屏蔽]")
	return s.length > 80 ? s.slice(0, 80) + "…" : s
}
const scanHits = []
const scanAllowed = []
const pathHints = []
const skippedBinary = []
let scannedText = 0
;(function scanTree(dir, base = "") {
	for (const e of readdirSync(dir, {withFileTypes: true})) {
		const rel = base ? `${base}/${e.name}` : e.name
		const abs = join(dir, e.name)
		if (e.isDirectory()) {
			for (const r of NAME_RULES) if (r.dir && r.re.test(rel + "/")) scanHits.push({rel, line: 0, id: r.id, snippet: "(目录)"})
			scanTree(abs, rel)
			continue
		}
		for (const r of NAME_RULES) if (!r.dir && r.re.test(basename(rel))) scanHits.push({rel, line: 0, id: r.id, snippet: "(文件名)"})
		if (BINARY_EXT.has(extname(e.name).toLowerCase()) || probeBinary(abs)) { skippedBinary.push(rel); continue }
		scannedText += 1
		const lines = readFileSync(abs, "utf8").split(/\r?\n/)
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			let lineHit = false
			for (const r of CONTENT_RULES) {
				if (rel === SCANNER_SELF && SELF_SKIP_RULES.has(r.id)) continue
				const m = line.match(r.re)
				if (!m) continue
				if (r.passwordField) {
					const tail = line.slice(m.index + m[0].length, m.index + m[0].length + 200)
					if (SAFE_PASSWORD_VALUE.test(tail)) { scanAllowed.push({rel, line: i + 1, id: r.id, snippet: tail.trim()}); continue }
				}
				if (r.literalGroup) {
					const v = m[r.literalGroup]
					if (PLACEHOLDER_VALUE.test(v) || !looksLikeRealKey(v)) {
						scanAllowed.push({rel, line: i + 1, id: r.id, snippet: `非密钥值：${v}`})
						continue
					}
				}
				lineHit = true
				scanHits.push({rel, line: i + 1, id: r.id, secret: !!r.secret, snippet: line})
			}
			if (!lineHit && PATH_HINT.test(line)) pathHints.push({rel, line: i + 1, snippet: line})
		}
	}
})(tmp)
log(`      扫描文本文件 ${scannedText} 个 · 跳过二进制 ${skippedBinary.length} 个`)
log(`      · 说明：${SCANNER_SELF}（扫描器自身）跳过 ${SELF_SKIP_RULES.size} 条"规则字面量"规则，避免自己扫自己；其余规则照查`)
for (const a of scanAllowed.slice(0, 20)) log(`      · 放行（读外部属性，非字面量） ${a.rel}:${a.line} ${a.id} ⟶ ${snippetOf(a)}`)
if (pathHints.length) {
	log(`      ⚠ 另有本机绝对路径残留 ${pathHints.length} 处（**只提示、不拦截**：多为 Windows 标准工具路径或出处注释）`)
	for (const h of pathHints.slice(0, 8)) log(`         ${h.rel}:${h.line}  ⟶  \`${snippetOf(h)}\``)
	if (pathHints.length > 8) log(`         …另有 ${pathHints.length - 8} 处（要看全量就把 --keep-temp 的目录拿去 grep）`)
}
if (scanHits.length) {
	problems.push(`隐私/密钥扫描命中 ${scanHits.length} 处`)
	log(`\n✗ 隐私/密钥扫描命中 ${scanHits.length} 处 —— 拒绝推送（fail-closed）：`)
	for (const h of scanHits.slice(0, 60)) log(`   ${h.rel}:${h.line}: ${h.id}  ⟶  \`${snippetOf(h)}\``)
	if (scanHits.length > 60) log(`   …另有 ${scanHits.length - 60} 处未列出`)
}

if (problems.length) {
	log("\n✗ 校验失败，已中止（没有推送任何东西）：")
	for (const p of problems) log("   · " + p)
	if (reuseTmp) log(`   目录保留在 ${tmp}（--tmp 复用模式不删目录）`)
	else log(`   临时目录保留在 ${tmp}，可以自己翻看`)
	process.exit(1)
}
const rootKept = readdirSync(tmp, {withFileTypes: true}).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).sort()
const sizeMb = (function du(dir) {
	let n = 0
	for (const e of readdirSync(dir, {withFileTypes: true})) {
		if (e.isDirectory()) n += du(join(dir, e.name))
		else n += statSync(join(dir, e.name)).size
	}
	return n
})(tmp) / 1024 / 1024
log(`      ✓ 必需文件齐全 · 无上游目录 · 无内部文档 · 无开发机脚本 · 无 Core · 无隐私/密钥命中（硬门）`)
log(`      ✓ ${files.length} 个文件 · ${sizeMb.toFixed(1)} MB · 排除 ${dropped.length} 项`)
log(`      根级保留（${rootKept.length}）：${rootKept.join("  ")}`)

if (dryRun) {
	log(`\n--dry-run：到此为止，没有建提交、没有推送。可以去看 ${tmp}`)
	process.exit(0)
}

// ---------- 4) 建提交（以公开仓库当前 main 为父 ⇒ 带历史） ----------
log("[4/5] 生成快照提交（父提交 = 公开仓库当前 main ⇒ 带历史）")
const g = (args) => git(args, {cwd: tmp, quiet: true})
g(["init", "-q", "-b", "main"])
g(["add", "-A"])
const tree = g(["write-tree"]).trim()
log(`      tree ${tree.slice(0, 8)} · ${g(["ls-files"]).trim().split("\n").length} 个文件`)

let parent = null
const lsRemote = (ref) => execFileSync("git", ["ls-remote", REMOTE, ref],
	{encoding: "utf8", env: GIT_ENV}).trim()
const remoteMain = lsRemote("refs/heads/main")
if (remoteMain) {
	parent = remoteMain.split(/\s+/)[0]
	// commit-tree 需要父提交对象在本地存在 ⇒ 取一份（--depth=1 足够：快照本身是全量导出）
	git(["fetch", "-q", "--no-tags", "--depth=1", REMOTE, "refs/heads/main"], {cwd: tmp, quiet: true})
	const fetched = g(["rev-parse", "FETCH_HEAD"]).trim()
	if (fetched !== parent) {
		log(`\n✗ 公开仓库 main 在读取过程中变了（${parent.slice(0, 8)} → ${fetched.slice(0, 8)}），已中止。重跑一次即可。`)
		process.exit(1)
	}
	const parentTree = g(["rev-parse", `${parent}^{tree}`]).trim()
	if (parentTree === tree) {
		log("      ✓ 快照内容与公开仓库当前 main 完全一致 ⇒ 不产生新提交、不推送")
		if (reuseTmp || keepTemp) log(`      目录保留：${tmp}`)
		else { rmSync(tmp, {recursive: true, force: true}); log("      临时目录已清理") }
		process.exit(0)
	}
}
const ident = ["-c", `user.name=${COMMIT_IDENTITY.name}`, "-c", `user.email=${COMMIT_IDENTITY.email}`]
const sha = g([...ident, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]).trim()
g([...ident, "update-ref", "refs/heads/main", sha])
log(`      提交 ${sha.slice(0, 8)} · 父 ${parent ? parent.slice(0, 8) : "（无，首个提交）"} · 作者 ${COMMIT_IDENTITY.name} <${COMMIT_IDENTITY.email}>`)

// ---------- 5) fast-forward 推送（不带 -f） ----------
log("[5/5] fast-forward 推送 main（不带 -f）")
execFileSync("git", ["push", REMOTE, `${sha}:refs/heads/main`], {cwd: tmp, stdio: "inherit", env: GIT_ENV})
const afterPush = lsRemote("refs/heads/main").split(/\s+/)[0]
if (afterPush !== sha) { log(`✗ 推送后远端 main=${afterPush}，与预期 ${sha} 不一致 —— 请人工核对`); process.exit(1) }
let ffOk = true
if (parent) { try { g(["merge-base", "--is-ancestor", parent, sha]) } catch { ffOk = false } }
log(`      ✓ 已推送：${REMOTE.replace(/\.git$/, "")}`)
log(`      ✓ 复核：远端 main = ${afterPush.slice(0, 8)}${parent ? ` · 父提交 ${parent.slice(0, 8)} 是其祖先（fast-forward，没强推）` : ""}${ffOk ? "" : " ⚠ 祖先校验失败"}`)
if (reuseTmp || keepTemp) log(`      临时目录保留：${tmp}`)
else { rmSync(tmp, {recursive: true, force: true}); log("      临时目录已清理") }
log("\n公开仓库现在是**带历史**的：每次同步 = 一个新提交（父提交是上一次的 main），fast-forward 推送。")
log("快照内容每次仍是**全量**导出（不是增量 diff）⇒ 只要敏感文件没被提交进私有仓库，它就不会出现在公开历史里。")
