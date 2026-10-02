/**
 * 「库 `update()` **之前**」钩子的调度器。
 *
 * ## 为什么需要它
 * 补丁在库的参数流水线里、`this._model.update()`（算顶点）**之前**留了一个钩子：
 * `window.__noriBeforeModelUpdate`。它是**单槽位** —— 谁后装谁覆盖。
 *
 * 现在有**一个**消费者：
 *   - `blink.ts`（眨眼）
 * （"摸头低头"`petBow.ts` 曾两次挂在这里，**已按用户决定删除**：它往库每帧也在写的
 *  `ParamAngleY`/`ParamEyeBallY` 上做相加会抢参数，而按时间渐变又只是"跳变"的补丁 ——
 *  摸头的反馈改为**表情**，不经过这个钩子。
 *  调度器本身保留：它解决的"单槽位被顶掉"问题是通用的，下一个人加效果时直接用。）
 * 直接各自赋值的话，第二个会把第一个顶掉，症状是"其中一个功能**静默失效**"，
 * 而且改一处代码、另一个功能莫名其妙不工作 —— 正是最难查的那类。
 *
 * 所以由本模块独占那个槽位，消费者只管**注册**。
 *
 * ## 时序（为什么必须是这个位置）
 * 库每帧：`motions/expressions → breath → physics → lipsync → pose → this._model.update()(算顶点) → 画`。
 * `update()` 一执行顶点就定死了 ⇒ 想在画面上生效的额外参数只能加在它**之前**。
 * 加在之后（例如渲染循环的 tick 里）顶点早已算完，**画面上一点都看不出来**。
 */

export type BeforeUpdateHandler = () => void

const handlers: BeforeUpdateHandler[] = []
let installed = false

/** 注册一个"顶点计算之前"的消费者（重复注册同一函数只算一次，并自动装钩子） */
export const registerBeforeUpdate = (fn: BeforeUpdateHandler): void => {
	if (typeof fn !== "function" || handlers.includes(fn)) return
	handlers.push(fn)
	installBeforeUpdate()
}

/** 每帧被库调用：按注册顺序跑所有消费者。
 *  单个消费者抛异常**不能拖垮渲染**（否则一个效果写错就是黑屏）。 */
export const runBeforeUpdate = (): void => {
	for (const fn of handlers) {
		try { fn() } catch { /* 忽略：一个消费者出错不影响其它消费者与渲染 */ }
	}
}

/**
 * 把调度器装到钩子上（幂等）。缺 window（门禁在 Node 里跑）时静默跳过。
 * `host` 参数**仅供门禁注入**（产品侧不传）。
 *
 * ## 为什么这个槽位是**不可写**的
 * 一开始我写的是"每帧自检、被抢就夺回"—— 那是**假修复**：槽位一旦被赋值覆盖，
 * 库调用的就是别人的函数，`runBeforeUpdate` **再也不会被调用**，自检永远跑不到。
 * （真被调用的话说明没被抢，逻辑自相矛盾。）
 *
 * 所以改成从机制上防：`writable: false`。这样后来者若还按"直接赋值"的老写法接入，
 * **当场抛 TypeError**（ES module 是严格模式），而不是让眨眼**静默失效**
 * —— 那正是最难查的失败模式。正确接法是 `registerBeforeUpdate(fn)`。
 */
export const installBeforeUpdate = (host?: {__noriBeforeModelUpdate?: () => void}): void => {
	if (installed) return
	const h = host ?? (typeof window !== "undefined" ? (window as unknown as {__noriBeforeModelUpdate?: () => void}) : null)
	if (!h) return
	try {
		Object.defineProperty(h, "__noriBeforeModelUpdate", {
			value: runBeforeUpdate, writable: false, enumerable: false, configurable: true,
		})
	} catch {
		// 极端环境不支持 defineProperty 时退回普通赋值（至少功能可用）
		;(h as {__noriBeforeModelUpdate?: () => void}).__noriBeforeModelUpdate = runBeforeUpdate
	}
	/* 把**正确接法**暴露到页面上：外部工具（诊断探针 / 控制台手敲）过去是
	   `window.__noriBeforeModelUpdate = fn` 链式包装 —— 现在那样会抛错（槽位不可写），
	   所以给它们一个正规入口。配套用 `__noriBeforeUpdateCount()` 确认注册成功。 */
	;(h as unknown as {__noriRegisterBeforeUpdate?: (fn: BeforeUpdateHandler) => void}).__noriRegisterBeforeUpdate = registerBeforeUpdate
	;(h as unknown as {__noriBeforeUpdateCount?: () => number}).__noriBeforeUpdateCount = beforeUpdateHandlerCount
	installed = true
}

/** 当前注册了几个消费者 —— **仅供门禁**（产品侧不调） */
export const beforeUpdateHandlerCount = (): number => handlers.length

/** **仅供门禁**：清空注册与安装标记 */
export const __resetBeforeUpdateForTest = (): void => {
	handlers.length = 0
	installed = false
}
