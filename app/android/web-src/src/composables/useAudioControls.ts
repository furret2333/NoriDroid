import {computed, ref} from "vue"
import {
	syncBgm, nextBgmTrack, setBgmVolume, pauseBgm, resumeBgm, bgmNameOf, bgmCurrentId,
	setBgmErrorHandler, setBgmStateHandler, downloadBgm, type BgmState,
} from "../services/bgm"
import {setSfxVolume, readSfxStatus, downloadSfx, setSfxDownloadHandler, SFX_SOURCE, type SfxDownloadResult} from "../services/sfx"
import {setAmbientEnabled} from "../services/ambient"
import type {AppSettings} from "./useAppSettings"

interface AudioControlsOptions {
	cfg: AppSettings
	persistSettings: () => string
	notify: (message: string, ms?: number) => void
	pomoFocusMuted: () => boolean
	cancelPomoSulk: () => void
}

/** UI audio controls; App explicitly preserves native, TTS and foreground ordering. */
export const useAudioControls = ({cfg, persistSettings, notify, pomoFocusMuted, cancelPomoSulk}: AudioControlsOptions) => {
	const bgmNowName = ref("")
	const bgmState = ref<BgmState>("missing")
	const bgmPct = ref(0)
	const setBgmEnabled = (enabled: boolean): void => {
		cfg.bgmEnabled = enabled
		const id = syncBgm(cfg)
		bgmNowName.value = id ? bgmNameOf(id) : bgmNameOf(cfg.bgmTrack)
		persistSettings()
	}
	const onBgmToggle = (e: Event): void => setBgmEnabled((e.target as HTMLInputElement).checked)
	const onBgmQuickToggle = (): void => {
		if (bgmState.value === "missing" && cfg.bgmEnabled) {
			downloadBgm()
			return
		}
		setBgmEnabled(!cfg.bgmEnabled)
	}
	const onBgmTrackChange = (e: Event): void => {
		cfg.bgmTrack = (e.target as HTMLSelectElement).value
		const id = syncBgm(cfg)
		bgmNowName.value = id ? bgmNameOf(id) : bgmNameOf(cfg.bgmTrack)
		persistSettings()
	}
	const onBgmVolume = (): void => {
		setBgmVolume(Number(cfg.bgmVolume))
		persistSettings()
	}
	const onBgmNext = (): void => {
		bgmNowName.value = bgmNameOf(nextBgmTrack())
	}
	/**
	 * 「下载背景音乐资源」/「重新下载」两个按钮的入口。
	 * ⚠ 不要写成 `@click="downloadBgm"` —— Vue 会把 MouseEvent 当第一个实参传进 `force`,
	 * 事件对象恒为真值 ⇒ 普通下载也会被当成"强制重下"（网络白跑一趟）。
	 */
	const onBgmDownload = (): void => downloadBgm()
	const onBgmRedownload = (): void => downloadBgm(true)
	const onSfxVolume = (): void => setSfxVolume(Number(cfg.sfxVolume))

	/* ---------------- 音效文件 (联网下载, 2026-10-02) ----------------
	 * 5 个原版 m4a 不再进包: 点「下载音效」→ 原生桥下到应用私有目录 → 用 /sfx-local/ 播放
	 * (细节见 services/sfx.ts)。这里只管设置面板那一行的状态文案。 */
	const sfxMsg = ref("未下载（点右边按钮）")
	const sfxMsgOk = ref(false)
	const sfxMsgBad = ref(false)
	const sfxBusy = ref(false)
	const sfxTotal = ref(5)
	/** 试过一次(或者启动时就已经齐了) ⇒ 按钮显示「重新下载」; 从没下过才是「下载音效」 */
	const sfxTried = ref(false)
	const sfxBtnText = computed((): string => {
		if (sfxBusy.value) return "下载中…"
		return sfxTried.value ? "重新下载" : "下载音效"
	})

	/** 刷新状态行 (未下载 / 下载中 / 已下载 N/N / 下载失败) —— 四态都在这一处收口 */
	const sfxShowStatus = (st: {ready: boolean; done: number; total: number}, failed: string[] = []): void => {
		sfxTotal.value = st.total > 0 ? st.total : 5
		if (sfxBusy.value) {
			sfxMsg.value = "下载中…"
			sfxMsgOk.value = false
			sfxMsgBad.value = false
			return
		}
		if (failed.length) {
			sfxTried.value = true
			// 全都没下来 ≈ 网络不通 (国内直连大概率不行): 把源站一起写出来, 方便排查;
			// 个别失败就把文件名列出来 (哪个坏了再点一下只补它)
			sfxMsg.value = failed.length >= sfxTotal.value
				? `下载失败（${sfxTotal.value} 个都没下来）（可重试）· 下载源 ${SFX_SOURCE}，国内可能需要代理/魔法`
				: `下载失败：${failed.join("、")}（可重试）· 国内可能需要代理/魔法`
			sfxMsgOk.value = false
			sfxMsgBad.value = true
			return
		}
		if (st.ready) {
			sfxTried.value = true
			sfxMsg.value = `已下载 ${sfxTotal.value}/${sfxTotal.value}`
			sfxMsgOk.value = true
			sfxMsgBad.value = false
			return
		}
		sfxMsg.value = "未下载（点右边按钮）"
		sfxMsgOk.value = false
		sfxMsgBad.value = false
	}

	/** 读一次原生状态 (启动时读一次; 之后每次播放前由 services/sfx.ts 现问) */
	const sfxRefresh = (): void => {
		const st = readSfxStatus()
		sfxShowStatus(st)
	}

	const doDownloadSfx = (): void => {
		if (sfxBusy.value) return
		sfxBusy.value = true
		sfxShowStatus({ready: false, done: 0, total: sfxTotal.value})
		// 不因"已下载"就短路: 原生侧对已存在且大小合理的文件会跳过, 重复点最多是一次本地校验
		const r = downloadSfx()
		if (r === "ok") return
		// 没能触发 (网页调试没有桥 / 上一次还在下): 别让按钮永远卡在"下载中…"
		sfxBusy.value = false
		sfxMsgOk.value = false
		sfxMsgBad.value = true
		sfxMsg.value = r === "err:nobridge"
			? "装到手机上才能下载（网页调试没有原生桥）"
			: r === "err:busy"
				? "上一次下载还在进行，稍等一下"
				: `下载触发失败（${r}）（可重试）`
	}

	const onAmbientToggle = (): void => {
		setAmbientEnabled(ambientAllowed())
		persistSettings()
	}

	/* ---------------- 安静模式 ----------------
	 * 三态: 关闭 / 自动(每日 23:00–次日 8:00) / 手动。
	 * 生效时: Nori 不主动搭话、BGM 暂停; TTS 朗读与按键音/音效一律保留
	 * (你发消息她照常回复; 操作反馈音不静音)。 */
	const quietActive = (): boolean => {
		if (cfg.quietMode === "manual") return cfg.quietOn
		if (cfg.quietMode === "auto") {
			const h = new Date().getHours()
			return h >= 23 || h < 8
		}
		return false
	}
	const bgmQuietHold = ref(false)
	const bgmQuickTrack = computed(() => bgmNowName.value || bgmNameOf(cfg.bgmTrack))
	const bgmQuickActionLabel = computed(() => bgmState.value === "missing" && cfg.bgmEnabled
		? "重新下载背景音乐"
		: cfg.bgmEnabled ? "暂停背景音乐" : "播放背景音乐")
	const bgmQuickStatus = computed(() => {
		if (bgmState.value === "downloading") return `正在准备音乐 · ${bgmPct.value}%`
		if (bgmState.value === "missing") return cfg.bgmEnabled ? "音乐资源未就绪 · 点此重试" : "背景音乐已暂停"
		if (cfg.bgmEnabled && bgmQuietHold.value) return "安静模式暂停中"
		return cfg.bgmEnabled ? "正在循环播放" : "背景音乐已暂停"
	})
	const bgmCanSkip = computed(() => cfg.bgmEnabled && bgmState.value === "ready" && !bgmQuietHold.value)
	/** ambient 总闸: 设置开关 × 安静模式 × 番茄钟专注 (唯一入口, 任何重评估都走这里) */
	const ambientAllowed = (): boolean => cfg.ambientEnabled && !quietActive() && !pomoFocusMuted()
	/** 现在是否应当"保持安静"(不主动搭话 / BGM 不出声): 安静模式 或 番茄钟专注期静音 */
	const bgmHeld = (): boolean => quietActive() || pomoFocusMuted()
	let quietTimer = 0
	const applyQuiet = (): void => {
		const q = quietActive()
		bgmQuietHold.value = q || pomoFocusMuted()
		setAmbientEnabled(ambientAllowed())
		if (q || pomoFocusMuted()) pauseBgm()
		else if (cfg.bgmEnabled) resumeBgm()
	}
	const onQuietModeChange = (): void => {
		cancelPomoSulk()
		applyQuiet()
		persistSettings()
	}
	const onQuietToggle = (): void => {
		cancelPomoSulk()
		applyQuiet()
		persistSettings()
	}


	/** Register before settings hydrate, matching the main window's previous startup order. */
	const registerBgmErrorHandler = (): void => {
		setBgmErrorHandler((msg) => notify(`背景音乐：${msg}`))
	}

	/** Register before Pomodoro recovery, then restore BGM only after applyQuiet(). */
	const registerBgmStateHandler = (): void => {
		setBgmStateHandler((st, pct) => {
			bgmState.value = st
			bgmPct.value = pct
			if (st === "ready") {
				const id = bgmCurrentId()
				bgmNowName.value = id ? bgmNameOf(id) : ""
			}
		})
	}
	const restoreBgm = (): void => {
		const bgmId = syncBgm(cfg)
		bgmNowName.value = bgmId ? bgmNameOf(bgmId) : ""
	}

	const initializeSfxControls = (): void => {
		setSfxDownloadHandler((r: SfxDownloadResult) => {
			sfxBusy.value = false
			if (r.ok) sfxShowStatus({ready: true, done: r.total, total: r.total})
			else sfxShowStatus({ready: false, done: r.done, total: r.total}, r.failed)
		})
		sfxRefresh()
	}

	/** Start after Ambient initialization so automatic quiet mode keeps its original cadence. */
	const startQuietTimer = (): void => {
		quietTimer = window.setInterval(() => {
			if (cfg.quietMode === "auto") applyQuiet()
		}, 60_000)
	}

	const disposeAudioControls = (): void => {
		setBgmErrorHandler(null)
		if (quietTimer) { clearInterval(quietTimer); quietTimer = 0 }
	}

	return {
		bgmNowName, bgmState, bgmPct, bgmQuietHold,
		bgmQuickTrack, bgmQuickActionLabel, bgmQuickStatus, bgmCanSkip,
		onBgmToggle, onBgmQuickToggle, onBgmTrackChange, onBgmVolume,
		onBgmNext, onBgmDownload, onBgmRedownload, onSfxVolume,
		sfxMsg, sfxMsgOk, sfxMsgBad, sfxBusy, sfxBtnText, sfxRefresh, sfxShowStatus, doDownloadSfx,
		onAmbientToggle, quietActive, ambientAllowed, bgmHeld, applyQuiet, onQuietModeChange, onQuietToggle,
		registerBgmErrorHandler, registerBgmStateHandler, restoreBgm, initializeSfxControls, startQuietTimer, disposeAudioControls,
	}
}
