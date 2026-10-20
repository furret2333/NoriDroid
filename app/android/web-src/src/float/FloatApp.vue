<script setup lang="ts">
/**
 * 悬浮窗应用: 渲染 Live2D Nori + 加载状态.
 * 可拖动、双指缩放; 尺寸/位置自动记忆.
 * 表演: 聊天气泡传来的 【表情:xxx】【动作:xxx】 标记驱动 Nori 表情/动作 (与主 App 同规则);
 *       无互动一段时间后自动播中性待机动作.
 * 模型区域: 上报模型身体矩形给原生 → 只在模型身上点按才弹聊天气泡 (透明区不误触).
 */
import {onBeforeUnmount, onMounted, ref} from "vue"
import {createLive2D, normalizeFps, normalizeRenderScale} from "../services/live2d"
import {listInstalled} from "../services/live2d/modelStore"
import {readMotionGroups, readExpressionNames} from "../services/live2d/motions"
import {installFloatingGeometry} from "./modelGeometry"
import {
	resolveMarkerEmotion, resolveMarkerMotion, pickNeutralIdle,
	detectExpressionByRules, detectMotionByRules,
} from "../services/live2d/markerRules"
import {scheduleReturnToNeutral, cancelReturnToNeutral} from "../services/live2d/motionReturn"
import {loadSettings} from "../services/chat"

const l2d = createLive2D()
const status = ref("")
const MODEL_KEY = "float_model_id"
/** 模型可用表情/动作名 (映射标记用) */
let exprNames: string[] = []
let motionGroups: {group: string; names: string[]}[] = []
let motionNames: string[] = []
/** 待机定时器 */
let idleTimer: ReturnType<typeof setTimeout> | null = null
let renderPaused = false
let disposed = false
let geometrySoon: ReturnType<typeof setTimeout> | undefined
let geometrySettled: ReturnType<typeof setTimeout> | undefined
let geometry: ReturnType<typeof installFloatingGeometry> | undefined
let performanceRevision = 0

declare global {
	interface Window {
		__noriSetRenderScale?: (s: number) => void
		__noriModelCanvas?: {w: number; h: number}
		__noriRefresh?: () => void
		__noriPlayMarker?: (emotion: string, motion: string) => void
		__noriPlayByText?: (text: string) => void
		__noriTouchActive?: () => void
		/** 暂停/恢复渲染 (原生 FloatService.ACTION_SET_PAUSED 调用; 见 window.__noriSetPaused 说明) */
		__noriSetPaused?: (paused: boolean) => void
	}
}

/** 页面自己变成 hidden (WebView 被切走/息屏) 时兜底暂停 —— 与原生指令同一个入口 */
const onVis = (): void => { window.__noriSetPaused?.(document.hidden) }

/** 刷新能力列表 (模型挂载后读取一次) */
const refreshCapabilities = async (spec: {directory: string; fileBase: string}) => {
	try {
		const [exprs, motions] = await Promise.all([
			readExpressionNames(spec.directory, spec.fileBase),
			readMotionGroups(spec.directory, spec.fileBase),
		])
		exprNames = exprs ?? []
		motionGroups = motions ?? []
		motionNames = []
		for (const g of motionGroups) for (const n of g.names) motionNames.push(n)
	} catch { /* 忽略 */ }
}

/** 待机小动作: 长时间无互动 → 随机播一个中性 idle 动作 */
const scheduleIdle = () => {
	if (idleTimer) clearTimeout(idleTimer)
	if (renderPaused || disposed) { idleTimer = null; return }
	idleTimer = setTimeout(() => {
		idleTimer = null
		try {
			const p = pickNeutralIdle(motionGroups)
			if (p) returnToNeutral()
		} catch { /* 忽略 */ }
		// 播完再排下一次 (30~60s 随机)
		scheduleIdle()
	}, 30000 + Math.random() * 30000)
}

/** 回中性状态: 中性 idle + 清掉表情。
 *  模型里所有动作都是 Loop:true 不会自己结束, 播完反应动作必须主动切回来
 *  (实测: 说「困」后一直睡到下次说话)。 */
const returnToNeutral = (): void => {
	const revision = ++performanceRevision
	void (async () => {
		if (geometry && !await geometry.protect()) return
		if (disposed || renderPaused || revision !== performanceRevision) return
		const p = pickNeutralIdle(motionGroups)
		if (p) await l2d.playMotionByIndex(p.group, p.index)
		if (disposed || revision !== performanceRevision) return
		l2d.stopExpression()
		geometry?.neutral()
	})().catch(() => { /* Keep the conservative window on failure. */ })
}

/** 窗口尺寸变化 → 重新上报脚底 + 模型区域 (具名: 需要在卸载时解绑) */
const onWinResize = (): void => {
	clearTimeout(geometrySoon)
	clearTimeout(geometrySettled)
	const report = () => { if (!disposed) geometry?.resize() }
	geometrySoon = setTimeout(report, 100)
	geometrySettled = setTimeout(report, 400)
}

onMounted(async () => {
	try {
		const installed = await listInstalled()
		if (!installed.length) {
			status.value = "没有已安装的模型"
			return
		}
		// 2026-09-30：主 App 的选择是**权威**（存在 settings.json 的 live2dModel 里）；
		// localStorage 只是同一 WebView 里的快速镜像。此前主界面不落盘、悬浮窗只认自己的键，
		// 两边可能显示不同的模型 —— 现在优先跟主 App 走，读不到才退回旧键 / 第一个。
		let savedId = ""
		try { savedId = loadSettings().live2dModel ?? "" } catch { /* 忽略 */ }
		const lastId = savedId || localStorage.getItem(MODEL_KEY)
		const chosen = installed.find((i) => i.id === lastId) ?? installed[0]
		localStorage.setItem(MODEL_KEY, chosen.id)
		const spec = {directory: chosen.id, fileBase: chosen.entryBase}
		const cropModelKey = chosen.revision ? JSON.stringify([chosen.id, chosen.entryBase, chosen.revision]) : undefined
		const nativeDpr = Math.max(1.5, Math.min(window.devicePixelRatio || 2, 3))
		// Keep the float window's value locally so a queued remount cannot inherit
		// a scale written by another WebView through the global hook.
		let floatRenderScale = nativeDpr
		try { floatRenderScale = normalizeRenderScale(loadSettings().floatRenderScale, nativeDpr) } catch { /* 忽略 */ }

		/** 挂载/重挂模型 (重挂 = 新建画布+新 WebGL 上下文, 可救回 flags 改动导致的画面丢失) */
		/* 并发重入守卫。webglcontextrestored 与原生推来的 __noriRefresh 是两条独立入口,
		   同时到达时两个 mountModel 会交错 (都 await destroy → 都 await mount) ⇒ 叠出两套画布/上下文。
		   harness 实测: 连调两次 __noriRefresh() 后 canvas 数 1 → 2。
		   ⚠ 用**时间戳**而不是布尔值: 库的 load 有 60s 超时, 但 destroy 没有; 若 destroy 永久挂起,
		   布尔标志会一直是 true ⇒ 之后所有重挂(含上下文恢复)都被挡死。超时后允许再次进入。 */
		let mountingSince = 0
		const MOUNT_GUARD_MS = 15000
		const mountModel = async () => {
			if (mountingSince && Date.now() - mountingSince < MOUNT_GUARD_MS) return
			mountingSince = Date.now()
			try {
				// 重挂前必须先停掉上一个实例的渲染循环: 库里 load() 会新建模型与新的 rAF 循环,
				// 旧循环的 _isShow 还是 true ⇒ 不 stop() 就是**两个循环一起画**
				// (主界面 App.vue 的 loadModel 一直是 destroy() 后再 mount, 悬浮窗漏了这一步)
				geometry?.stop()
				geometry = installFloatingGeometry(cropModelKey)
				delete window.__noriVisibleBounds
				await l2d.destroy()
				await l2d.mount(spec, {canvasWidth: "100%", canvasHeight: "100%", host: null})
				try { l2d.playMotionByIndex("Idle", 0) } catch { /* 忽略 */ }
				try { l2d.setRenderScale(floatRenderScale) } catch { /* 忽略 */ }
				// WebGL 上下文丢失时 preventDefault 保持可恢复 (surface 重建常见)
				try {
					const cv = l2d.canvas()
					const mountedGeometry = geometry
					cv?.addEventListener("webglcontextlost", (e) => {
						e.preventDefault()
						mountedGeometry?.contextLost()
					})
					cv?.addEventListener("webglcontextrestored", () => { mountModel() })
				} catch { /* 忽略 */ }
				await refreshCapabilities(spec)
				geometry?.start()
				scheduleIdle()
			} catch { /* 忽略 */ } finally { mountingSince = 0 }
		}

		await mountModel()
		// 渲染分辨率: 读主 App 设置 + 支持原生实时推送
		try {
			const st = loadSettings()
			floatRenderScale = normalizeRenderScale(st.floatRenderScale, floatRenderScale)
			l2d.setRenderScale(floatRenderScale)
			// 帧率档位与主界面**共用同一个设置项** (悬浮窗是独立 WebView, 不读就只会用默认档)
			l2d.applyFrameCap(normalizeFps(st.l2dFps))
		} catch { l2d.setRenderScale(floatRenderScale) }
		window.__noriSetRenderScale = (s: number) => {
			floatRenderScale = normalizeRenderScale(s, floatRenderScale)
			l2d.setRenderScale(floatRenderScale)
		}
		/**
		 * 暂停 / 恢复渲染 —— 由原生侧的**主 App 前后台**驱动（FloatService.ACTION_SET_PAUSED）。
		 *
		 * 为什么悬浮窗需要这个: 它是一个独立 WebView，主 App 回前台时它并不会自动"不可见",
		 * 而是继续按自己的帧率画 —— 两个 Live2D 实例抢 GPU/CPU，主界面帧率实测从 29 掉到 9.5
		 * （tmp-memcheck/probe-main-fps.mjs）。原生那边 `stopService` 是延迟 400ms 才执行的，
		 * 这中间只能靠"不画"来省；而且只要服务因为别的原因活着（气泡在前台等），
		 * 没有这个开关就会一直白烧电。
		 *
		 * 暂停只是不画（模型、画布、手势命中都不动），恢复是即时的。
		 */
		window.__noriSetPaused = (p: boolean) => {
			renderPaused = !!p
			geometry?.pause()
			try {
				if (p) {
					cancelReturnToNeutral()
					if (idleTimer) clearTimeout(idleTimer)
					idleTimer = null
				}
				l2d.pauseRender(!!p)
				if (!p) scheduleIdle()
			} catch { /* 忽略 */ }
		}
		/** 兜底: 页面自己变成 hidden (WebView 被切走/息屏) 时也停 —— 监听在下面与 resize 一起挂 */
		// 原生改完悬浮窗 flags 后调用: 重挂模型救回画面 (Nori 约 1 秒后重新出现)
		window.__noriRefresh = () => { mountModel() }
		// 聊天气泡驱动 Nori 表演: 表情/动作标记 → 播放对应模型动作 (与主 App 同规则)
		const playResolved = (emotion: string | null, motion: string | null, clearExpression: boolean) => {
			if (!emotion && !motion && !clearExpression) return
			const revision = ++performanceRevision
			void (async () => {
				if (geometry && !await geometry.protect()) return
				if (disposed || renderPaused || revision !== performanceRevision) return
				cancelReturnToNeutral()
				if (emotion) l2d.playExpression(emotion)
				else if (clearExpression) l2d.stopExpression()
				if (motion) {
					await l2d.playMotionByName(motion)
					if (revision !== performanceRevision || disposed) return
				}
				scheduleReturnToNeutral(returnToNeutral)
			})().catch(() => { /* Retain safe bounds if playback fails. */ })
		}
		window.__noriPlayMarker = (emotion: string, motion: string) => {
			playResolved(emotion ? resolveMarkerEmotion(emotion, exprNames) : null,
				motion ? resolveMarkerMotion(motion, motionNames) : null, !!emotion)
		}
		window.__noriPlayByText = (text: string) => {
			playResolved(detectExpressionByRules(text, exprNames), detectMotionByRules(text, motionNames), false)
		}
		window.__noriTouchActive = () => { scheduleIdle() }
		// 模型脚底: 等渲染稳定后上报 (对话框贴脚底用)
		onWinResize()
		// 窗口尺寸变化 (捏合拉大/缩小悬浮窗) → 重新上报脚底+模型区域
		// 具名函数: 原先用匿名箭头, onBeforeUnmount 无法解绑, 每次挂载累积一个监听器
		window.addEventListener("resize", onWinResize)
		document.addEventListener("visibilitychange", onVis)
		onVis()   // 页面一开始就是 hidden 的情况 (WebView 还没显示) 也要对齐一次
	} catch (e: any) {
		status.value = `失败: ${e?.message ?? String(e)}`
	}
})

onBeforeUnmount(() => {
	disposed = true
	geometry?.stop()
	performanceRevision++
	clearTimeout(geometrySoon)
	clearTimeout(geometrySettled)
	if (idleTimer) clearTimeout(idleTimer)
	cancelReturnToNeutral()
	window.removeEventListener("resize", onWinResize)
	document.removeEventListener("visibilitychange", onVis)
})
</script>

<template>
	<div class="float-root">
		<div v-if="status" class="float-status">{{ status }}</div>
	</div>
</template>

<style lang="less" scoped>
.float-root {
	position: fixed;
	inset: 0;
	background: transparent;
	overflow: visible;
	user-select: none;
	-webkit-user-select: none;
	-webkit-touch-callout: none;
	-webkit-tap-highlight-color: transparent;
}
.float-status {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	color: #fff;
	font-size: 12px;
	text-align: center;
	padding: 8px;
	background: rgba(15,23,42,0.85);
	white-space: pre-wrap;
}
</style>
