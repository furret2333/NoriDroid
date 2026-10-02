/**
 * 按键/事件音效: 轻量播放器.
 *
 * 音频**不再打进 APK** (2026-10-02 起): 由设置页「下载音效」按钮触发原生桥
 * (NoriChat.downloadSfx) 把 5 个原版 m4a 下到应用私有目录 (filesDir/sfx, 覆盖升级保留),
 * 播放走 WebViewAssetLoader 的 /sfx-local/ 路径处理器 —— 与背景音乐的 /bgm-local/ 是
 * **同一套** (同一个 BgmPathHandler, 只是 root 指向 filesDir/sfx).
 *
 * - 音量 0 = 静音; 重复点击时从头重播 (快速连点不叠音); 按路径缓存实例
 * - **没下载就静默不播**: 不报错、不刷屏 (整个会话最多 console 一行, 说清去哪儿下)
 * - 页面跑在桌面浏览器里 (harness/调试) 或老壳没有 sfxStatus/sfxReady 时: **无从判断**,
 *   按旧行为照放 —— 否则本地开发什么都听不见, "确实调了音效"那类 E2E 也会假红
 */
const cache = new Map<string, HTMLAudioElement>()
let volume = 0.5

/** 音效文件个数 (与原生 ChatBridge.sfxExpected() 一致; 只在桥没回 total 时兜底) */
const SFX_TOTAL = 5

/**
 * 音效下载源 (主机名)。真正下载的是原生 (ChatBridge.SFX_BASE, 带 https://) ——
 * 这里留一份**只为了在"一个都没下来"时把源站写进提示**, 方便你判断到底卡在哪:
 * 改下载源时两处都要改 (原生那处有 verify-apk-bundle 的源码断言盯着)。
 */
export const SFX_SOURCE = "59f06f75.pinme.dev"

/** 整个会话最多一条"未下载"提示 (要求: 不报错、不刷屏) */
let warned = false

export const setSfxVolume = (v: number): void => {
	volume = Number.isFinite(v) ? Math.min(1, Math.max(0, Number(v))) : 0.5
}

/** 当前音效音量 (0~1)。给合成音 (petAudio) 复用同一套设置, 避免出现第二个"音效音量" */
export const getSfxVolume = (): number => volume

export interface SfxStatus {
	/** 原生桥回答了吗 (false = 桌面浏览器 / 老壳: 无从判断, 按"能放"处理) */
	known: boolean
	ready: boolean
	done: number
	total: number
	missing: string[]
}

interface SfxBridge {
	sfxStatus?: () => string
	sfxReady?: () => boolean
	downloadSfx?: () => string
}

const bridge = (): SfxBridge | null => {
	if (typeof window === "undefined") return null
	return (window as unknown as {NoriChat?: SfxBridge}).NoriChat ?? null
}

/**
 * 直接问原生: 5 个文件齐了没 (同步)。
 * **不缓存**: 每次播之前问一次 —— 下载完成、文件被系统清掉都能立刻反映, 不会卡在旧状态。
 */
export const readSfxStatus = (): SfxStatus => {
	const b = bridge()
	try {
		if (b && typeof b.sfxStatus === "function") {
			const p = JSON.parse(b.sfxStatus() || "{}") as {
				ready?: boolean; done?: number; total?: number; missing?: unknown
			}
			const total = Number(p.total) > 0 ? Number(p.total) : SFX_TOTAL
			const done = Number(p.done) > 0 ? Math.min(Number(p.done), total) : 0
			return {
				known: true,
				ready: p.ready === true || done >= total,
				done,
				total,
				missing: Array.isArray(p.missing) ? (p.missing as unknown[]).map(String) : [],
			}
		}
		if (b && typeof b.sfxReady === "function") {
			const ok = b.sfxReady() === true
			return {known: true, ready: ok, done: ok ? SFX_TOTAL : 0, total: SFX_TOTAL, missing: []}
		}
	} catch { /* 桥异常: 当作"无从判断" */ }
	return {known: false, ready: false, done: 0, total: SFX_TOTAL, missing: []}
}

/** 播放 /sfx-local/ 下的音效 (传绝对路径, 如 "/sfx-local/button_click.m4a") */
export const playSfxFile = (path: string): void => {
	if (volume <= 0) return
	const st = readSfxStatus()
	if (st.known && !st.ready) {
		// 未下载: 静默跳过。**不是错误** —— 只是还没下, 所以不给 error 级日志, 也不弹提示
		if (!warned) {
			warned = true
			console.info("[sfx] 音效未下载, 已静音; 到 设置 → 音效文件 点「下载音效」")
		}
		return
	}
	try {
		let a = cache.get(path)
		if (!a) {
			a = new Audio(path)
			a.preload = "auto"
			cache.set(path, a)
		}
		a.currentTime = 0
		void a.play().catch(() => { /* 忽略 */ })
	} catch { /* 忽略 */ }
}

/** 按键音 (dock/按钮) */
export const playSfx = (): void => playSfxFile("/sfx-local/button_click.m4a")

/* ---------------- 下载 (设置页「下载音效」按钮) ---------------- */

export interface SfxDownloadResult {
	ok: boolean
	total: number
	done: number
	failed: string[]
}

let downloadHandler: ((r: SfxDownloadResult) => void) | null = null

/** 注册下载结果回调 (设置页状态行用) */
export const setSfxDownloadHandler = (cb: ((r: SfxDownloadResult) => void) | null): void => {
	downloadHandler = cb
}

const onDownloadResult = (json: string): void => {
	try {
		const r = JSON.parse(json) as {ok?: boolean; total?: number; done?: number; failed?: unknown}
		downloadHandler?.({
			ok: r.ok === true,
			total: Number(r.total) > 0 ? Number(r.total) : SFX_TOTAL,
			done: Number(r.done) > 0 ? Number(r.done) : 0,
			failed: Array.isArray(r.failed) ? (r.failed as unknown[]).map(String) : [],
		})
	} catch { /* 忽略 */ }
}

// 原生侧只检查 window.__noriSfxDownloadRes 存在即回调 (模块加载即注册)
// ⚠ 必须挡 typeof window: 本模块会被 esbuild 打进 Node 门禁的 bundle (petAudio → sfx)
if (typeof window !== "undefined") {
	;(window as unknown as {__noriSfxDownloadRes?: (json: string) => void}).__noriSfxDownloadRes = onDownloadResult
}

/** 触发原生下载. @returns "ok" / "err:busy" / "err:nobridge" / "err:exception" */
export const downloadSfx = (): string => {
	const b = bridge()
	if (!b || typeof b.downloadSfx !== "function") return "err:nobridge"
	try { return String(b.downloadSfx() ?? "ok") } catch { return "err:exception" }
}
