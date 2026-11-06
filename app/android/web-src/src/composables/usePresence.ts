import {computed, ref} from "vue"
import {
	startPresence, stopPresence, refreshPresence, subscribePresence, presenceConfigured,
	presenceCountText, presenceTodayText, presenceStatusText, presenceTone, type PresenceState,
} from "../services/presence"

interface PresenceOptions {
	enabled: () => boolean
	version: string
	persistSettings: () => string
}

export const usePresence = (options: PresenceOptions) => {
	const presenceState = ref<PresenceState | null>(null)
	const presenceReady = ref(false)
	const presenceNow = ref(Date.now())
	let presenceUnsub: (() => void) | null = null
	let presenceTickTimer = 0

	const presenceCount = computed(() =>
		options.enabled() ? presenceCountText(presenceState.value, presenceNow.value) : "已关闭",
	)
	const presenceToday = computed(() =>
		options.enabled() ? presenceTodayText(presenceState.value, presenceNow.value) : "",
	)
	const presenceStatus = computed(() =>
		options.enabled()
			? presenceStatusText(presenceState.value, presenceNow.value, presenceReady.value)
			: "已在设置里关闭，不发送任何心跳",
	)
	const presenceToneClass = computed(() => presenceTone(presenceState.value, presenceNow.value))

	/** 首次接线 / 运行时地址被注入后补接线（探针会用 window.__noriPresenceUrl 覆盖地址）。 */
	const ensurePresenceWiring = (): void => {
		presenceReady.value = presenceConfigured()
		if (!presenceReady.value) return
		if (!presenceUnsub) presenceUnsub = subscribePresence((s) => { presenceState.value = s })
		if (!presenceTickTimer) {
			presenceTickTimer = window.setInterval(() => { presenceNow.value = Date.now() }, 60_000)
		}
	}

	/** 设置里的开关：立刻生效 + 落盘。 */
	const onPresenceToggle = (): void => {
		ensurePresenceWiring()
		if (options.enabled()) {
			startPresence(options.version)
		} else {
			stopPresence()
			presenceState.value = null
		}
		options.persistSettings()
	}

	/** 手动重试（连不上时点一下，不用等 15s/60s 退避）。 */
	const onPresenceRetry = (): void => {
		ensurePresenceWiring()
		if (presenceReady.value) refreshPresence(options.version)
	}

	/* 探针/调试钩子（本仓库既有 __nori* 约定）:
	 * 先设 window.__noriPresenceUrl，再调 window.__noriPresenceRefresh() 立即补一次心跳。
	 * 生产环境没有副作用（只是多挂一个函数）。 */
	;(window as unknown as {__noriPresenceRefresh?: () => void}).__noriPresenceRefresh = () => {
		ensurePresenceWiring()
		if (presenceReady.value) refreshPresence(options.version)
	}

	const disposePresence = (): void => {
		stopPresence()
		if (presenceUnsub) { presenceUnsub(); presenceUnsub = null }
		if (presenceTickTimer) { clearInterval(presenceTickTimer); presenceTickTimer = 0 }
	}
	return {presenceState, presenceReady, presenceCount, presenceToday, presenceStatus, presenceToneClass, ensurePresenceWiring, onPresenceToggle, onPresenceRetry, disposePresence}
}
