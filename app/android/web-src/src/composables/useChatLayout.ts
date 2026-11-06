import {nextTick, ref, watch, type Ref} from "vue"

interface ChatLayoutOptions {
	panel: Readonly<Ref<string>>
	scrollElement: () => HTMLElement | null | undefined
}

/** Chat visibility and keyboard layout; App controls viewport listener timing. */
export const useChatLayout = ({panel, scrollElement}: ChatLayoutOptions) => {
	const chatOpen = ref(false)
	const physicalViewportAvailable = (): boolean =>
		(navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches) && Math.abs(window.screen.width - window.innerWidth) <= 2 && window.screen.height >= window.innerHeight
	const readPortraitLayout = (): boolean =>
		(physicalViewportAvailable() ? window.screen.height : window.innerHeight) >= window.innerWidth
	const portraitLayout = ref(readPortraitLayout())
	const sideRailOpen = ref(false)
	const keyboardOpen = ref(false)
	const keyboardInset = ref(0)
	const imageMenu = ref(false)
	let layoutWidth = window.innerWidth
	let layoutFullHeight = window.innerHeight

	const scrollChatBottom = (): void => {
		nextTick(() => {
			const el = scrollElement()
			if (el) el.scrollTop = el.scrollHeight
		})
	}
	const toggleChat = (): void => {
		imageMenu.value = false
		sideRailOpen.value = false
		chatOpen.value = !chatOpen.value
		if (chatOpen.value) scrollChatBottom()
	}
	const openPortraitHistory = (): void => {
		chatOpen.value = true
		imageMenu.value = false
		sideRailOpen.value = false
		scrollChatBottom()
	}

	// A keyboard can shorten the viewport past landscape proportions without rotation.
	const syncChatLayout = (): void => {
		const width = window.innerWidth
		const viewport = window.visualViewport
		const height = viewport?.height ?? window.innerHeight
		const widthChanged = Math.abs(width - layoutWidth) > 2
		const physicalViewport = physicalViewportAvailable()
		const fullHeight = physicalViewport ? window.screen.height : (widthChanged ? window.innerHeight : layoutFullHeight)
		const inputFocused = !!document.activeElement?.matches(".chat-input input")
		const keyboard = height < fullHeight * 0.78 && (inputFocused || keyboardOpen.value) && (!widthChanged || physicalViewport)
		keyboardOpen.value = keyboard
		keyboardInset.value = keyboard ? Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0)) : 0
		if (!keyboard || widthChanged) {
			portraitLayout.value = readPortraitLayout()
			layoutWidth = width
			// Keep the full-height baseline throughout the keyboard animation.
			layoutFullHeight = keyboard ? fullHeight : (inputFocused && !widthChanged ? Math.max(layoutFullHeight, window.innerHeight) : window.innerHeight)
		}
	}
	const onComposerFocus = (): void => {
		imageMenu.value = false
		sideRailOpen.value = false
		syncChatLayout()
	}
	const onComposerBlur = (): void => { syncChatLayout() }
	const closeChatMenusOutside = (event: PointerEvent): void => {
		if (!(event.target as HTMLElement)?.closest?.(".image-entry")) imageMenu.value = false
	}
	watch(chatOpen, (open) => { if (!open) imageMenu.value = false })
	watch(panel, () => { sideRailOpen.value = false; imageMenu.value = false })
	watch(portraitLayout, () => { sideRailOpen.value = false; imageMenu.value = false; scrollChatBottom() })

	const bindChatViewport = (): void => {
		window.visualViewport?.addEventListener("resize", syncChatLayout)
		window.visualViewport?.addEventListener("scroll", syncChatLayout)
	}
	const unbindChatViewport = (): void => {
		window.visualViewport?.removeEventListener("resize", syncChatLayout)
		window.visualViewport?.removeEventListener("scroll", syncChatLayout)
	}
	return {
		chatOpen, portraitLayout, sideRailOpen, keyboardOpen, keyboardInset, imageMenu,
		toggleChat, openPortraitHistory, scrollChatBottom, syncChatLayout,
		onComposerFocus, onComposerBlur, closeChatMenusOutside, bindChatViewport, unbindChatViewport,
	}
}
