import {computed, nextTick, ref} from "vue"
import type {createLive2D, MotionGroup} from "../services/live2d"
import {readExpressionNames, readMotionGroups} from "../services/live2d/motions"
import {ensureModel, fetchModelList, getInstalled, listInstalled} from "../services/live2d/modelStore"
import type {AppSettings} from "./useAppSettings"

export interface ModelControlsOptions {
	l2d: ReturnType<typeof createLive2D>
	host: () => HTMLElement | null
	settings: () => Pick<AppSettings, "live2dModel">
	persistSettings: () => string
	closePanel: () => void
	openModelGate: (onPass: () => void) => void
	restoreTransform: (id: string) => Promise<void>
	relayout: () => void
	resetHeadLook: () => void
	loadTouchForModel: (id: string) => void
}

/** Model selection and loading. Initialization stays explicit in App's mounted sequence. */
export const useModelControls = ({
	l2d, host, settings, persistSettings, closePanel, openModelGate,
	restoreTransform, relayout, resetHeadLook, loadTouchForModel,
}: ModelControlsOptions) => {
	const loading = ref(false)
	const error = ref("")
	const ready = ref(false)
	const currentModelId = ref("")
	const motions = ref<MotionGroup[]>([])
	const expressions = ref<string[]>([])
	const loadingMsg = ref("加载中…")
	const modelList = ref<{id: string; name: string}[]>([])
	const listError = ref("")
	const currentModel = computed(() => modelList.value.find((m) => m.id === currentModelId.value))

	/** 加载/下载中的守卫: pick() 原先无守卫, 快速点两个模型会并发两次 loadModel →
	 *  第二次 ensureModel 覆盖第一次的全局回调 → 第一个 Promise 永久挂起。
	 *  这里直接拦住重入 (面板里连点也不会再产生并发)。 */
	let modelSwitching = false

	const loadModel = async () => {
		const id = currentModelId.value
		if (!id) return
		if (modelSwitching) return   // 已有切换在途: 忽略这次 (避免并发覆盖下载回调)
		modelSwitching = true
		// 离线/列表失败时模型不在 modelList 里, 用 id 兜底 (名字仅用于下载进度显示)
		const model = modelList.value.find((m) => m.id === id)
		const name = model?.name ?? id
		loading.value = true; error.value = ""; ready.value = false
		motions.value = []; expressions.value = []
		try {
			loadingMsg.value = `下载 ${name}…`
			const entryBase = await ensureModel(id, name)
			loadingMsg.value = "加载中…"
			await l2d.destroy()
			// 换模型后重置注视状态 (眼珠由库 drag 源驱动, 随模型重建自动归位)
			resetHeadLook()
			await l2d.mount({directory: id, fileBase: entryBase}, {canvasWidth: "100%", canvasHeight: "100%", host: host()})
			/* WebGL 上下文丢失恢复。规范: **只有** webglcontextlost 被 preventDefault(), 浏览器才会尝试恢复上下文。
			   主界面此前零处理 (全库 4 处全在 FloatApp.vue) ⇒ harness 实测: 丢失事件 defaultPrevented=false,
			   且**连显式 restoreContext() 都没能恢复** = 只能重启 App。
			   真机上息屏/切后台/内存压力都会触发, 概率远高于桌面 —— 这跳照 FloatApp.vue 补齐。
			   每次 mount 都是新画布, 旧画布的监听随它一起被移除, 不会累积。 */
			try {
				const cv = l2d.canvas()
				cv?.addEventListener("webglcontextlost", (e) => e.preventDefault())
				/* ⚠ 不能直接调 loadModel(): 它开头有 `if (modelSwitching) return` 守卫。
				   若上下文恢复时正好有一次模型切换在途，这次恢复会被**静默吞掉**、之后再也不会重试
				   ⇒ 形象一直黑着。所以这里等守卫释放后再重挂（最多等 10s，超时就放弃这一轮）。 */
				cv?.addEventListener("webglcontextrestored", () => {
					const retry = (n: number): void => {
						if (!modelSwitching) { loadModel(); return }
						if (n < 20) setTimeout(() => retry(n + 1), 500)
					}
					retry(0)
				})
			} catch { /* 忽略 */ }
			await restoreTransform(id)
			await nextTick()
			relayout()
			motions.value = (await readMotionGroups(id, entryBase)) ?? []
			expressions.value = await readExpressionNames(id, entryBase)
			const runtime = await l2d.getMotions()
			if (runtime && runtime.length) motions.value = runtime
			ready.value = true
			loadTouchForModel(id)
		} catch (e: any) {
			error.value = e?.message ?? String(e)
		} finally {
			loading.value = false
			modelSwitching = false   // 释放守卫 (必须在 finally: 失败/超时路径也要放)
		}
	}

	/** 「选模型」的落地点：记选择 → 落盘 → 加载（已装=直接切；没装=走 ensureModel 下载）。
	 *  抽出来是因为它现在有两个入口：已装的直接走 / 没装的要等答题门放行。 */
	const applyModelPick = (id: string): void => {
		currentModelId.value = id
		// 2026-09-30 修：把选择**落盘**，否则重启会回到"已装列表第一个"（用户报的 bug）
		settings().live2dModel = id
		persistSettings()
		closePanel()
		loadModel()
	}

	/** 点「选择模型」里的卡片：已装的直接切；**没装的那只，点它就是要下载** ——
	 *  和「一键克隆」同一道「模型授权验证」，答对才真的开始下载（答错/取消都不下载）。
	 *  下载逻辑本身没动：放行后仍是 loadModel → ensureModel → NoriBridge.download（原生 ModelBridge，
	 *  源 https://fc39e5fc.pinme.dev 未改）。 */
	const pick = (id: string): void => {
		if (id === currentModelId.value && ready.value) return
		void (async () => {
			if (await getInstalled(id)) { applyModelPick(id); return }
			openModelGate(() => applyModelPick(id))
		})()
	}

	const initializeModels = async (): Promise<void> => {
		// 本地模型先行 (启动提速): 先扫本地已装模型立即开始加载, 网关列表后台拉取.
		// 旧逻辑 await 联网列表成功后才 loadModel —— 弱网/离线时白等到超时才见模型
		try {
			const installed = await listInstalled()
			if (installed.length) {
				// 优先用**上次选的那只**（2026-09-30 修：以前写死 installed[0].id，换模型后重启就回第一只）;
				// 但必须校验它仍然装着（模型可能被卸载/换机），校验不过才回落列表第一个。
				const saved = settings().live2dModel
				const usable = !!saved && installed.some((m) => m.id === saved)
				currentModelId.value = usable ? saved : installed[0].id
				// 把"实际生效的"记回内存（不额外写盘：等下次保存设置时自然落盘），
				// 这样"回落"过一次之后，下次启动直接命中。
				settings().live2dModel = currentModelId.value
			}
		} catch { /* 忽略 */ }
		void loadModel().catch(() => { /* loadModel 内部有错误提示 */ })

		// 网关列表后台刷新: 只更新 UI 列表, 不再阻塞/切换模型加载
		void (async () => {
			try {
				modelList.value = await fetchModelList()
				listError.value = ""
			} catch (e: any) {
				listError.value = "获取模型列表失败: " + (e?.message ?? String(e)) + "（将使用本地已下载的模型）"
			}
		})()
	}

	return {
		loading, error, ready, currentModelId, motions, expressions, loadingMsg,
		modelList, listError, currentModel, loadModel, pick, initializeModels,
	}
}
