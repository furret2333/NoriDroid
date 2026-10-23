/**
 * 一键发布：把已构建的 APK 发到 Gitee，并同步更新官网的版本信息与下载链接。
 *
 * 为什么需要：
 *   1) 原来的 GitHub Actions 从美国 runner 往 Gitee 传大文件会卡死（9.7MB 起，12 分钟超时），
 *      导致官网下载 404。从本机（国内）传只要几秒。
 *   2) 官网 index.html 里有一批"写死的回退值"（版本/日期/大小/SHA + 7 处链接），
 *      以前发版要手动改，容易漏。这个脚本一起做掉。
 *
 * 用法：
 *   node scripts/publish-gitee.mjs            # 版本号读 app/android/app/build.gradle
 *   node scripts/publish-gitee.mjs 2.5.0      # 或显式指定
 *
 * 前置：
 *   - Gitee 私人令牌（勾 projects）：`~/.gitee-token` 或环境变量 GITEE_TOKEN
 *   - GitHub 凭据：用 `git credential fill` 自动取（本机推 GitHub 能用即可）
 *   - 官网仓库路径：环境变量 NORI_SITE_DIR，或 `~/.nori-site-dir`（一行路径）
 *
 * 它做四件事：
 *   1. 把 APK 推到 Gitee 仓库 dl/（只留最近 2 个）
 *   2. 回读校验 Gitee raw：HTTP 200、Content-Type 不是 zip、SHA 与本地一致
 *   3. 更新官网 index.html 的版本/日期/大小/SHA 与全部下载链接，提交并推送
 *   4. 轮询线上页面，确认新版本已生效
 */
import { execFileSync } from "node:child_process"
import {
	readFileSync, existsSync, mkdtempSync, copyFileSync, readdirSync,
	rmSync, statSync, mkdirSync, writeFileSync,
} from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

// ============ 配置 ============
// 仓库根目录按脚本位置推导，不写死本机路径（公开仓库的隐私扫描会拦绝对路径）
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const GH_REPO = "furret2333/NoriDroid"
const GITEE_OWNER = "HuiQwQ"
const GITEE_REPO = "nori-droid"
const DL_DIR = "dl"
const KEEP_LAST = 2

/** 官网仓库位置：环境变量 NORI_SITE_DIR，或本机配置文件 ~/.nori-site-dir（一行路径） */
function resolveSiteDir() {
	const cands = []
	if (process.env.NORI_SITE_DIR) cands.push(process.env.NORI_SITE_DIR)
	const cfg = join(homedir(), ".nori-site-dir")
	if (existsSync(cfg)) {
		const p = readFileSync(cfg, "utf8").trim()
		if (p) cands.push(p)
	}
	return cands.find((d) => existsSync(join(d, "index.html"))) || null
}

const log = (m = "") => console.log(m)
const die = (m) => {
	console.error("✗ " + m)
	process.exit(1)
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

// ============ 1) 版本号 & APK ============
let version = process.argv[2]
if (!version) {
	const gradle = readFileSync(join(REPO_ROOT, "app/android/app/build.gradle"), "utf8")
	const m = gradle.match(/versionName\s+"([^"]+)"/)
	if (!m) die("读不到 build.gradle 的 versionName")
	version = m[1]
}
const APK_NAME = `NoriDroid-${version}-release.apk`
const APK_PATH = join(REPO_ROOT, "app/android/app/build/outputs/apk/release", APK_NAME)
if (!existsSync(APK_PATH)) die(`找不到 APK：${APK_PATH}\n先构建：cd app/android && ./gradlew assembleRelease`)
const apkBuf = readFileSync(APK_PATH)
const apkSize = apkBuf.length
const apkSha = sha256(apkBuf)
const sizeText = (apkSize / 1048576).toFixed(1) + " MB"

log("=== 发布信息 ===")
log(`版本：${version}`)
log(`APK ：${APK_PATH}`)
log(`大小：${(apkSize / 1048576).toFixed(2)} MB（写死值用 "${sizeText}"）`)
log(`SHA ：${apkSha}`)
if (apkSize < 1024 * 1024) die("APK 小于 1MB，像是构建失败")

// ============ 2) 取令牌 ============
let giteeToken = process.env.GITEE_TOKEN
if (!giteeToken) {
	const tf = join(homedir(), ".gitee-token")
	if (existsSync(tf)) giteeToken = readFileSync(tf, "utf8").trim()
}
if (!giteeToken) die(`没有 Gitee 令牌。放到 ${join(homedir(), ".gitee-token")}，或设置环境变量 GITEE_TOKEN`)

let ghUser = ""
let ghToken = ""
try {
	const out = execFileSync("git", ["credential", "fill"], {
		input: "protocol=https\nhost=github.com\n\n",
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	})
	ghUser = (out.match(/^username=(.*)$/m) || [])[1] || ""
	ghToken = (out.match(/^password=(.*)$/m) || [])[1] || ""
} catch {
	/* 没有凭据时下面会报错 */
}

// 一份 env 同时给两个 host 配好认证（避免 GCM 弹窗）
const b64 = (s) => Buffer.from(s, "ascii").toString("base64")
const gitEnv = {
	...process.env,
	GIT_TERMINAL_PROMPT: "0",
	GCM_INTERACTIVE: "never",
	GIT_CONFIG_COUNT: "2",
	GIT_CONFIG_KEY_0: "http.https://gitee.com/.extraheader",
	GIT_CONFIG_VALUE_0: `Authorization: Basic ${b64(`${GITEE_OWNER}:${giteeToken}`)}`,
	...(ghToken
		? {
				GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
				GIT_CONFIG_VALUE_1: `Authorization: Basic ${b64(`${ghUser}:${ghToken}`)}`,
			}
		: {}),
}
if (!ghToken) log("⚠ 取不到 GitHub 凭据，官网仓库那一步可能失败")
const git = (args, cwd) =>
	execFileSync("git", args, { cwd: cwd || REPO_ROOT, env: gitEnv, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })

// ============ 3) 推 Gitee dl/ ============
log("\n=== [1/4] 推送到 Gitee dl/ ===")
const work = mkdtempSync(join(tmpdir(), "gitee-dl-"))
try {
	git(["clone", "--depth", "1", `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}.git`, work], tmpdir())
	const dlDir = join(work, DL_DIR)
	if (!existsSync(dlDir)) mkdirSync(dlDir)

	copyFileSync(APK_PATH, join(dlDir, APK_NAME))
	log(`  写入 ${DL_DIR}/${APK_NAME}`)

	// 只保留最近 KEEP_LAST 个 apk（按修改时间，刚写入的最新）
	const apks = readdirSync(dlDir)
		.filter((f) => f.toLowerCase().endsWith(".apk"))
		.map((f) => ({ f, t: statSync(join(dlDir, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t)
	for (const { f } of apks.slice(KEEP_LAST)) {
		log(`  删除旧包 ${f}`)
		git(["rm", "-q", "--ignore-unmatch", `${DL_DIR}/${f}`], work)
	}
	git(["add", "-A", DL_DIR], work)

	let changed = true
	try {
		git(["diff", "--cached", "--quiet"], work)
		changed = false
	} catch {
		changed = true
	}
	if (!changed) {
		log("  dl/ 里已有同名文件，无需提交")
	} else {
		git(["config", "user.name", "HuiOVO"], work)
		git(["config", "user.email", "317002734+furret2333@users.noreply.github.com"], work)
		git(["commit", "-m", `dl: publish ${APK_NAME}`], work)
		git(["push", "origin", "HEAD:master"], work)
		log("  ✓ 已推送")
	}
} finally {
	try {
		rmSync(work, { recursive: true, force: true })
	} catch {
		/* ignore */
	}
}

// ============ 4) 校验 Gitee raw ============
log("\n=== [2/4] 校验 Gitee raw 链接 ===")
const rawUrl = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/raw/master/${DL_DIR}/${APK_NAME}`
const res = await fetch(rawUrl, { redirect: "follow" })
if (!res.ok) die(`回读失败 HTTP ${res.status}`)
const ct = res.headers.get("content-type") || ""
if (ct.includes("zip")) die(`Content-Type 是 ${ct}（不能是 zip，否则浏览器会当成压缩包）`)
const buf = Buffer.from(await res.arrayBuffer())
if (sha256(buf) !== apkSha) die(`SHA 不一致\n  本地 ${apkSha}\n  Gitee ${sha256(buf)}`)
log(`  ✓ HTTP 200 · ${ct} · ${(buf.length / 1048576).toFixed(2)} MB · SHA 一致`)

// ============ 5) 更新官网 ============
log("\n=== [3/4] 更新官网 ===")
const siteDir = resolveSiteDir()
if (!siteDir) {
	log("  ⚠ 找不到官网仓库，跳过。")
	log(`     解决办法：把官网仓库路径写进 ${join(homedir(), ".nori-site-dir")}，或设置环境变量 NORI_SITE_DIR`)
} else {
	log(`  仓库：${siteDir}`)
	const indexPath = join(siteDir, "index.html")
	let html = readFileSync(indexPath, "utf8")

	const mVer = html.match(/<span data-release="version">v?([^<]+)<\/span>/)
	if (!mVer) die("index.html 里找不到 data-release=\"version\"")
	const oldVer = mVer[1]
	if (oldVer === version) {
		log(`  已是 v${version}，无需改版本`)
	} else {
		log(`  v${oldVer} → v${version}`)
		// 日期用 GitHub Release 的 published_at（页面 JS 也读这个，取 UTC 日期）
		let dateText = new Date().toISOString().slice(0, 10)
		try {
			const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/tags/${version}`, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": "publish-gitee" },
			})
			if (r.ok) {
				const j = await r.json()
				if (j.published_at) dateText = String(j.published_at).slice(0, 10)
			}
		} catch {
			/* 用本地日期兜底 */
		}
		log(`  日期：${dateText}`)

		const reps = [
			[`<span data-release="version">v${oldVer}</span>`, `<span data-release="version">v${version}</span>`],
			[`NoriDroid-${oldVer}-release.apk`, `NoriDroid-${version}-release.apk`],
			[`releases/download/${oldVer}/`, `releases/download/${version}/`],
		]
		for (const [a, b] of reps) html = html.split(a).join(b)
		html = html.replace(/<span data-release="size">[^<]*<\/span>/g, `<span data-release="size">${sizeText}</span>`)
		html = html.replace(/<span data-release="date">[^<]*<\/span>/g, `<span data-release="date">${dateText}</span>`)
		html = html.replace(/(<code id="apk-sha" data-release="sha256">)[0-9a-f]+(<\/code>)/, `$1${apkSha}$2`)
		writeFileSync(indexPath, html, "utf8")

		// 校验替换结果里没有旧值残留
		const leftOver = [`NoriDroid-${oldVer}-release.apk`, `releases/download/${oldVer}/`, `v${oldVer}</span>`].filter((s) =>
			html.includes(s),
		)
		if (leftOver.length) die(`官网仍有旧值残留：${leftOver.join(", ")}`)

		git(["add", "index.html"], siteDir)
		try {
			git(["diff", "--cached", "--quiet"], siteDir)
			log("  index.html 无变化，跳过提交")
		} catch {
			git(["config", "user.name", "HuiOVO"], siteDir)
			git(["config", "user.email", "317002734+furret2333@users.noreply.github.com"], siteDir)
			git(["commit", "-m", `release: 官网更新到 v${version}（${sizeText} / 新 SHA / Gitee raw 链接）`], siteDir)
			git(["push", "origin", "main"], siteDir)
			log("  ✓ 官网已提交并推送")
		}
	}
}

// ============ 6) 线上验证 ============
log("\n=== [4/4] 线上验证（等待 GitHub Pages 部署）===")
const page = `https://inori.mom/dl-check?cb=${Date.now()}`
let liveOk = false
for (let i = 1; i <= 12; i++) {
	try {
		const r = await fetch(`https://inori.mom/?cb=${Date.now()}-${i}`, { redirect: "follow" })
		const t = await r.text()
		if (t.includes(`v${version}`) && t.includes(APK_NAME)) {
			liveOk = true
			log(`  ✓ 第 ${i} 次：线上已显示 v${version}`)
			break
		}
		log(`  第 ${i} 次：还是旧版，等 10 秒…`)
	} catch (e) {
		log(`  第 ${i} 次：请求失败 ${e.message}`)
	}
	await new Promise((r) => setTimeout(r, 10000))
}
if (!liveOk) log("  ⚠ 线上还没更新（Pages 可能要再等一会儿），稍后刷新看")

log("\n================ 完成 ================")
log(`GitHub Release：https://github.com/${GH_REPO}/releases/tag/${version}`)
log(`官网：https://inori.mom/`)
log(`主下载：${rawUrl}`)
