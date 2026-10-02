/**
 * Live2D 渲染帧率上限 —— 与库解耦的纯逻辑, 便于单测。
 *
 * 背景: 库的渲染循环是**裸 requestAnimationFrame** —— 屏幕给多少就跑多少。系统给
 * 120Hz 时它就是常驻 120fps 全屏 WebGL, 是耗电/发热的主要来源之一。
 *
 * 节流方式: 每帧仍走 rAF (与 vsync 对齐), 只在间隔够了时才真正 update+draw。
 * 好处: 帧率落在 vsync 的整数分频上 (120→60 无余数), 不会出现 setTimeout 那种一顿
 * 一顿的抖动; 且库内 updateTime() 按真实时间推进, 少画不会让动作变慢或累积漂移。
 *
 * 【为什么容差必须是"绝对值"而不是比例】
 * 门限 = 目标间隔 − TOLERANCE_MS。容差的作用是吸收 rAF 时间抖动 (实测 <1ms 量级),
 * 抖动是**绝对量**, 所以用固定毫秒数才对。
 * 曾用比例容差 (间隔 × 0.8), 它在低帧率档会**直接失效**:
 *   目标 20fps → 间隔 50ms × 0.8 = 门限 16ms, 而 60Hz 屏一帧就 16.67ms > 16ms
 *   → 每帧都通过 → 完全不节流, 仍是 60fps。
 *   目标 15fps → 门限 12ms, 同样失效。
 * 60fps 档侥幸不出问题 (16.67 × 0.8 = 13.33 < 16.67), 所以这个坑只在加档位后才暴露。
 */

/** 门限容差 (ms): 吸收 rAF 时间抖动, 避免 60Hz 屏上因某帧早到几百微秒就误跳过一帧 */
export const L2D_FRAME_TOLERANCE_MS = 2

/** 可选帧率档位 (0 = 不限制, 等价于最早的行为)。
 *  选值原则: 都要能同时整除 60Hz 与 120Hz 的 vsync, 否则帧间隔不均会出现顿挫。
 *  40 只在 120Hz 上整除 (60/40=1.5), 故不列入, 避免"设了但实际不是那个数"的困惑。 */
export const L2D_FPS_OPTIONS = [0, 60, 30, 20, 15] as const
export type L2dFps = (typeof L2D_FPS_OPTIONS)[number]
/** 默认档位 */
export const L2D_FPS_DEFAULT: L2dFps = 60

export interface FrameCapHost {
	__noriL2dMinInterval?: number
	__noriL2dLast?: number
	/**
	 * 渲染暂停开关（2026-10-02 加）。
	 *
	 * ## 为什么需要它（用户报的「返回主界面严重掉帧」）
	 * 悬浮窗是一个**独立的 WebView**：主 App 回到前台时它并没有"自动变得不可见" ——
	 * 它还在按自己的帧率渲染，于是**两个 Live2D 实例抢同一块 GPU/CPU**
	 * （实测：主界面单独跑 29fps，旁边再跑一个 Live2D 悬浮窗就掉到 9.5fps，见
	 * `tmp-memcheck/probe-main-fps.mjs`）。原生侧 `stopService` 是异步的（延迟 400ms），
	 * 中间那段"已经不需要显示、但还活着"的时间只能靠**不画**来省。
	 *
	 * 做法刻意放在这一层：库的渲染循环本来就每帧调 `__noriL2dTick`，在这里早退即可 ——
	 * 不碰库、不碰 canvas、不碰窗口 flag、不动触摸命中；rAF 链仍然与 vsync 对齐
	 * （恢复时不会有一帧跳变），只是**一个顶点都不算、一帧都不画**。
	 */
	__noriL2dPaused?: boolean
	/** 真正画过的帧数（仅供门禁/诊断断言"暂停期间确实一帧都没画"） */
	__noriL2dDraws?: number
	__noriL2dTick?: (updater: {updateTime: () => void}, model: {update: () => void}) => void
}

/** 由目标帧率算出门限 (ms); 0 = 不限制 */
export const frameThreshold = (fps: number): number =>
	fps > 0 ? 1000 / fps - L2D_FRAME_TOLERANCE_MS : 0

/**
 * **时间戳门控**（Live2D 渲染循环与数据海背景共用同一套语义）。
 *
 * 抽成纯函数的原因：背景也要按同一个旋钮限帧，而"门限怎么算、容差留多少、边界取不取等号"
 * 这些决定只该有一份实现 —— 否则两处漂移，以后调一处忘一处。
 * （**曾经就是两份**：这里抽出来之前，`installFrameCap` 的 tick 里手写过一遍同样的判断。）
 *
 * @param now 当前时刻 (ms)
 * @param last 上一次**真正画**的时刻；undefined = 首帧
 * @param minInterval 门限 (ms)；<= 0 表示不限制
 * @returns draw=这一帧要不要画；last=要记下的新时刻（跳过时原样返回）
 *
 * ## 时钟异常时**故意选择"画"**（fail-open）
 * `now` 不是有限数（NaN/Infinity）时无法判断"是不是太早"，此时：
 * - 若选择"不画"：一旦时钟坏掉，画面会**永久冻住**（渲染循环再也不出帧）；
 * - 若选择"画"：退化成"不限制"，画面照常，只是少了节流 —— 明显更安全。
 * 所以这里返回 `draw: true`，并且**不推进 `last`**（不把 NaN 写进去污染后续判断）。
 * 需要拿 `now` 做算术的调用方（如背景要算 dt）应自己先挡非有限值，见 `datasea-bg.ts`。
 */
export const frameGate = (now: number, last: number | undefined, minInterval: number): {draw: boolean; last: number} => {
	const safeLast = typeof last === "number" && Number.isFinite(last) ? last : undefined
	if (!Number.isFinite(now)) return {draw: true, last: safeLast ?? 0}
	if (!(minInterval > 0)) return {draw: true, last: now}
	if (safeLast === undefined) return {draw: true, last: now}
	return now - safeLast < minInterval ? {draw: false, last: safeLast} : {draw: true, last: now}
}

/** dt 封顶的基准值 (ms)：60fps 下相当于放过 3 帧，足够吸收抖动又不会瞬移。
 *  **必须声明在 frameDtCapMs 之前** —— 它是那个函数的默认参数值，声明在后会踩 TDZ。 */
export const L2D_DT_CAP_BASE_MS = 50

/**
 * **被限帧的循环里，dt 的封顶值该是多少**（ms）。
 *
 * 这个坑不看不知道：背景粒子按"真实帧间时长"移动，而它原本把 dt 夹在 50ms。
 * 一旦把帧率限到 15fps，帧间隔变 66.7ms > 50ms ⇒ **每帧都被夹掉**，粒子速度掉到 75%。
 * 所以封顶必须跟着门限走：至少放到门限的 2 倍，同时保留"长时间挂起后不要瞬移"的作用。
 *
 * @param minIntervalMs 门限 (ms)；<= 0（不限制）时用基准值
 * @param baseMs 基准封顶
 */
export const frameDtCapMs = (minIntervalMs: number, baseMs = L2D_DT_CAP_BASE_MS): number =>
	Math.max(baseMs, (Number.isFinite(minIntervalMs) ? minIntervalMs : 0) * 2)

/** 归一化档位: 非法/缺失值回落到默认档 */
export const normalizeFps = (v: unknown): L2dFps => {
	const n = Number(v)
	return (L2D_FPS_OPTIONS as readonly number[]).includes(n) ? (n as L2dFps) : L2D_FPS_DEFAULT
}

/**
 * 设置帧率 (运行时可改)。会复位计时基准, 让新档位**下一帧就生效**。
 * @param host 通常传 window
 * @param fps 目标帧率; 0 = 不限制
 */
export const setFrameCap = (host: FrameCapHost, fps: number): void => {
	host.__noriL2dMinInterval = frameThreshold(fps)
	host.__noriL2dLast = undefined
}

/**
 * 暂停 / 恢复渲染（运行时可改）。**恢复时复位计时基准**，下一帧立刻生效。
 *
 * 暂停期间：`__noriL2dTick` 立即返回 —— 不算顶点、不画、也不推进库的动作时钟
 * （`updateTime` 不调用），所以恢复时动作是从暂停那一刻接着走，不会"跳一段"。
 * rAF 链本身不停（与 vsync 对齐，代价只是一个空回调），因此恢复没有延迟。
 *
 * @param host 通常传 window
 * @param paused true = 暂停渲染（画面上保留最后一帧）
 */
export const setRenderPaused = (host: FrameCapHost, paused: boolean): void => {
	host.__noriL2dPaused = !!paused
	host.__noriL2dLast = undefined
}

/**
 * 装上节流钩子。补丁后的库优先调用 host.__noriL2dTick, 缺失时自动退回原行为。
 * @param host 通常传 window; 单测可传普通对象
 * @param fps 初始档位
 * @param now 时钟注入, 默认 performance.now —— 单测传假时钟以精确控制 vsync 节奏
 */
export const installFrameCap = (
	host: FrameCapHost,
	fps: number = L2D_FPS_DEFAULT,
	now: () => number = () => performance.now(),
): void => {
	setFrameCap(host, fps)
	host.__noriL2dTick = (updater, model) => {
		// 暂停: 一个字都不做（悬浮窗在主 App 前台 / 页面不可见时）—— 见 __noriL2dPaused
		if (host.__noriL2dPaused) return
		// 门控**必须**走共用的 frameGate（这里以前手写过一遍同样的判断，两处会漂移；
		// 而且那份没有时钟异常保护：now() 若给出 NaN 会把 __noriL2dLast 写成 NaN，
		// 之后 `NaN - last < iv` 恒为 false ⇒ **门控永久失效、跑满刷新率**）
		const gate = frameGate(now(), host.__noriL2dLast, host.__noriL2dMinInterval || 0)
		host.__noriL2dLast = gate.last
		if (!gate.draw) return
		updater.updateTime()
		model.update()
		host.__noriL2dDraws = (host.__noriL2dDraws || 0) + 1
		// 注: 这里**不能**挂"额外参数"类效果 —— `model.update()` 里已经把顶点算完了,
		// 之后再改参数画面上看不出来(而且下一帧会被重载覆盖)。额外参数要在**库的参数流水线里、
		// `this._model.update()` 之前**加, 见 blink.ts 与补丁 param-inject。
	}
}
