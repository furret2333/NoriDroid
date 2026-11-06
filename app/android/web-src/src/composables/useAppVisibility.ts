import type {Ref} from "vue"
import type {AppSettings} from "./useAppSettings"
import {createRenderPauseState} from "../services/renderPause"
import {loadChat, flushChatPersist, type ChatMsg} from "../services/chat"
import {flushMemoryPersist} from "../services/memory"
import {stop as stopTTS} from "../services/tts"
import {pauseBgm, resumeBgm} from "../services/bgm"
import {presenceOnVisible} from "../services/presence"

export interface AppVisibilityOptions {
	version: string
	settings: () => Pick<AppSettings, "presenceEnabled">
	setStageRenderPaused: (paused: boolean) => void
	refreshFloatPermission: () => void
	refreshStorage: () => void
	cancelStageInteraction: () => void
	stopAutoDiary: () => void
	pomoUpdateDisplay: () => void
	pomoRefreshDate: () => void
	memoryHasPersistError: () => boolean
	refreshMemFromDisk: () => void
	bgmHeld: () => boolean
	chatStreaming: Ref<boolean>
	touchStreaming: Ref<boolean>
	messages: Ref<ChatMsg[]>
}

/** Returns the original handlers; App retains listener and lifecycle ordering. */
export const useAppVisibility = (options: AppVisibilityOptions) => {
	const {
		setStageRenderPaused, refreshFloatPermission, refreshStorage,
		cancelStageInteraction, stopAutoDiary, pomoUpdateDisplay, pomoRefreshDate,
		refreshMemFromDisk, bgmHeld, chatStreaming, touchStreaming, messages,
	} = options

	/**
	 * Native ownership and browser visibility independently pause both renderers.
	 * Returning to a visible document must not override a native pause.
	 */
	const renderPause = createRenderPauseState(setStageRenderPaused)
	const onNativeVisibility = () => {
		renderPause.setNativePaused(window.__noriAppPaused === true)
		onVisibility()
	}

	const onVisibility = () => {
		const paused = renderPause.setHidden(document.hidden)
		if (!paused) refreshFloatPermission()
		refreshStorage()
		// 切后台: 立即落盘防抖中的聊天记录, 避免丢最后一次写入
		if (paused) {
			cancelStageInteraction()
			stopAutoDiary()
			pomoUpdateDisplay()
			pomoRefreshDate()
			flushChatPersist()
			void flushMemoryPersist()
			stopTTS()
			pauseBgm()
		} else {
			// 在线人数（2026-10-21）: 回前台补一次心跳（距上次 > 60s 才发）
			if (options.settings().presenceEnabled) presenceOnVisible(options.version)
			if (options.memoryHasPersistError()) refreshMemFromDisk()
			if (!bgmHeld()) resumeBgm()
			if (!chatStreaming.value && !touchStreaming.value) {
				// 切回前台: 重新加载聊天记录 —— 悬浮窗对话框可能已写入共享的 chat.json,
				// 主 App 不重建时内存里是旧数据, 必须刷新才能看到悬浮窗对话.
				// 流式进行中跳过: send/handleTouchTrigger 的闭包持有旧数组里的 liveBubble,
				// 整表替换会让在途回复写到脱离渲染的对象上 → 既不上屏也不落盘 (FE-H2)
				try { messages.value = loadChat() } catch { /* 忽略 */ }
			}
		}
	}

	return {renderPause, onNativeVisibility, onVisibility}
}
