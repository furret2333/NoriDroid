/**
 * 反应动作播完后自动切回**中性状态**（动作回 idle + 表情回默认）。
 *
 * ## 为什么必须手动切
 *
 * 1. 两个模型（ARGNori / Nori）里**每一个**动作的 `motion3.json` 都是 `Meta.Loop: true`
 *    （连 `02_Nod`、`05_Angry` 都是）。
 * 2. 底层 Cubism 只在动作 `isFinished()` 时才切回默认 idle（见 live2dEasyControl.js 的渲染循环），
 *    而**循环动作永远不会 finished** —— 于是它会一直保持。
 * 3. 应用侧**没有任何补救**：全项目 0 处 `setFinishedMotionHandler`，
 *    主 App 也**没有周期性待机定时器**（只有悬浮窗有 30~60s 的 `scheduleIdle`）。
 *
 * 实测现象：回复里带「困」→ Nori **一直睡到下次说话**才被下一个动作替换。
 * （严格说这不是"困"独有的：按上面的机制，任何反应动作都会一直保持。）
 *
 * ## 用法
 *
 * 每播完一个**反应**动作就调用 `scheduleReturnToNeutral(...)`；
 * 连续几个动作只会按最后一个计时（每次调用都重置）。
 * 直接铺 idle 的地方**不要**调用它（否则会无限自我重排）。
 */

/** 默认延迟。取 5s: 短于它动作看不清, 长于它又会像"卡住"。
 *  （不用各动作真实时长 —— 时长在每个 motion3.json 的 Meta 里, 前端要额外抓 N 个文件才拿得到, 不划算。） */
export const NEUTRAL_RETURN_DELAY_MS = 5000

let timer: ReturnType<typeof setTimeout> | null = null

/**
 * 计划一次"回中性状态"。重复调用会**重置**计时（所以一串动作只按最后一个算）。
 * @param returnToNeutral 回中性要做的事（通常是：播一个中性 idle + 清掉表情）
 * @param delayMs 可注入，便于测试用很短的延迟
 */
export const scheduleReturnToNeutral = (returnToNeutral: () => void, delayMs = NEUTRAL_RETURN_DELAY_MS): void => {
	cancelReturnToNeutral()
	timer = setTimeout(() => {
		timer = null
		try { returnToNeutral() } catch { /* 忽略: 回待机失败不该影响界面 */ }
	}, delayMs)
}

/** 取消待执行的"回中性状态"（离开页面 / 切模型时调用，避免定时器打到已销毁的实例） */
export const cancelReturnToNeutral = (): void => {
	if (timer !== null) {
		clearTimeout(timer)
		timer = null
	}
}

/** 仅供测试: 当前是否有待执行的计划 */
export const hasPendingReturn = (): boolean => timer !== null
