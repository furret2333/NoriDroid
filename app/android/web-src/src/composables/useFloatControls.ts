import {computed, ref} from "vue"
import type {AppSettings} from "./useAppSettings"
import {normalizeRenderScale} from "../services/live2d/renderScale"

export interface FloatControlsOptions {
	settings: () => Pick<AppSettings, "floatEnabled" | "floatRenderScale">
	nativeDpr: () => number
	persistSettings: () => unknown
	notify: (text: string, ms?: number) => void
}

/** Native floating-window controls; mount and visibility refreshes stay explicit in App. */
export const useFloatControls = (options: FloatControlsOptions) => {
	const {settings, nativeDpr, persistSettings, notify: triggerBubble} = options
	const floatPermission = ref<"unknown" | "granted" | "denied" | "pending" | "revoked">("unknown")
	let floatEnablePending = false
	const floatPermissionHint = computed(() => {
		if (floatPermission.value === "pending") return "等待系统授权，授权返回后自动开启。"
		if (floatPermission.value === "revoked") return "悬浮窗权限已被撤销，请重新开启并授权。"
		if (floatPermission.value === "denied") return "尚未获得悬浮窗权限，开启时会前往系统设置。"
		if (floatPermission.value === "granted") return "悬浮窗权限已授权。"
		return "首次开启需要授权悬浮窗权限。"
	})
	const saveFloatEnabled = () => {
		persistSettings()
		try { window.NoriChat?.setFloatEnabled?.(!!settings().floatEnabled) } catch { /* 忽略 */ }
	}
	const refreshFloatPermission = () => {
		const nori = window.NoriChat
		if (!nori?.canFloat || document.hidden) return
		try {
			const granted = nori.canFloat()
			const wasEnabled = !!settings().floatEnabled
			if (floatEnablePending) {
				settings().floatEnabled = granted
				floatEnablePending = false
				floatPermission.value = granted ? "granted" : "denied"
				saveFloatEnabled()
			} else if (!granted && wasEnabled) {
				settings().floatEnabled = false
				floatPermission.value = "revoked"
				saveFloatEnabled()
			} else if (granted) floatPermission.value = "granted"
			else if (floatPermission.value !== "revoked") floatPermission.value = "denied"
			if (!granted) nori.hideFloat?.()
		} catch { /* 忽略 */ }
	}

	/** 授权前保留关闭状态；返回应用后核对权限，再启用原生标记。 */
	const onFloatToggle = (event: Event) => {
		const nori = window.NoriChat
		floatEnablePending = false
		if (settings().floatEnabled) {
			try {
				if (!nori?.canFloat?.()) {
					settings().floatEnabled = false
					// v-model 同一事件内 true→false 可能被合并为无变化，显式还原原生复选框。
					if (event.target instanceof HTMLInputElement) event.target.checked = false
					floatEnablePending = !!nori?.requestFloatPermission
					floatPermission.value = floatEnablePending ? "pending" : "denied"
					saveFloatEnabled()
					triggerBubble("请在系统设置里允许悬浮窗权限")
					nori?.requestFloatPermission?.()
					return
				}
				floatPermission.value = "granted"
				triggerBubble("已开启：离开应用后 Nori 会留在屏幕上")
			} catch {
				settings().floatEnabled = false
				if (event.target instanceof HTMLInputElement) event.target.checked = false
			}
		} else {
			try { nori?.hideFloat?.() } catch { /* 忽略 */ }
		}
		saveFloatEnabled()
	}

	/** 悬浮窗: 渲染分辨率设置 → 保存 + 实时通知悬浮窗页面 */
	const resetFloatWindow = () => {
		try {
			if (!window.NoriChat?.resetFloatWindow) return
			window.NoriChat.resetFloatWindow()
			triggerBubble("已重置，离开应用后可查看悬浮窗")
		} catch { triggerBubble("重置失败，请重试") }
	}

	const onFloatRenderScale = () => {
		settings().floatRenderScale = normalizeRenderScale(settings().floatRenderScale, nativeDpr())
		persistSettings()
		try {
			window.NoriChat?.setFloatRenderScale?.(settings().floatRenderScale)
		} catch { /* 忽略 */ }
	}

	return {
		floatPermission, floatPermissionHint, saveFloatEnabled, refreshFloatPermission,
		onFloatToggle, resetFloatWindow, onFloatRenderScale,
	}
}
