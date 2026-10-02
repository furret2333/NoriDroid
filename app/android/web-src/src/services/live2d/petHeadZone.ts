/**
 * "摸到头"的判定 —— 从 NoriOS 网页版 headPat 的**部件判定**移植过来。纯函数, 可单测。
 *
 * ## 为什么需要它
 * 安卓端原来的 `strokeOnModel` 只判"实体/留白"(逐 drawable 像素级 isHit),
 * 判不出"头" —— 摸手、摸脚也算命中实体。网页版是这么判的:
 * ```js
 * function Ly(model, x, y) {
 *   if (!model.hitTestParts(zC, x, y)) return false;      // ① 压在指定的部件上
 *   const r = model.getPartsBounds(WC);                    // ② 头部部件盒 (WC = ["Part9"])
 *   const i = r.top - (r.top - r.bottom) * skullTopBand;   // ③ band = 0.6
 *   return y >= i;                                        // ④ 落在头盒上方 60% 内
 * }
 * ```
 *
 * ## 与网页版的两处**必要**偏差（都是实测逼出来的, 见 tmp-memcheck/probe-part-bounds.mjs）
 * 1. **不能硬编码部件名**：网页版写死 `WC = ["Part9"]`，但安卓端这份 ARGNori.moc3
 *    **根本没有 Part9**（实测部件名是 Part2…Part67 里的一个子集）——
 *    两边不是同一版 moc3。所以改成**按几何挑头部盒**: 谁伸到模型最顶部, 谁就是头。
 * 2. **不能用 `getDrawableDynamicFlagIsVisible` 过滤**：网页版拿它跳过硬隐藏部件,
 *    但这套 Core 里它对大量 drawable 返回的值与画面不符（实测 Part11 的 6 个 drawable 全是 false
 *    却明明在渲染）。所以只按几何算, 不做可见性过滤 —— 隐藏部件的盒子和可见时基本重合。
 *
 * ## 实测到的数字（ARGNori, 供对照/调参）
 * 模型盒 `y ∈ [-0.566, 0.882]`（高 1.449）；最顶部部件 = `Part3` `y ∈ [0.613, 0.882]`；
 * band 0.6 ⇒ 分界线 `y = 0.721`（约在模型高度的 88.8% 处, 即"头顶往下到额头"这一段）。
 */

export interface PetPartBox {
	left: number
	right: number
	top: number
	bottom: number
}

/** 与网页版 `skullTopBand` 同值：在头部盒内取**上方 60%**（下面 40% 是脸/下巴, 不算摸头） */
export const SKULL_TOP_BAND = 0.6
/** 判定"谁是最顶部部件"的容差：顶部相差不到模型高度的这个比例, 就并进同一个头盒。
 *  0.03 是实测取的值 —— 太小会把同一顶头发的多个部件切开, 太大又会把头发以下的部件并进来。 */
export const HEAD_TOP_EPS_RATIO = 0.03

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const isBox = (b: unknown): b is PetPartBox => {
	const x = b as PetPartBox
	return !!x && Number.isFinite(x.top) && Number.isFinite(x.bottom) && Number.isFinite(x.left) && Number.isFinite(x.right)
}

/**
 * 从部件盒列表里挑出**头部盒**：伸到模型最顶部（容差内）的那些部件的并集。
 *
 * 为什么不是"与模型顶部若干比例相交的部件求并集"：实测那样做会被**竖直长条部件**污染 ——
 * 比如 `Part18 y[0.000, 0.597]` 伸进了顶部带, 于是并集被拉到 y=0, 分界线掉到胸口。
 * 用"谁最高"就天然排除了它们。
 */
export const pickHeadBox = (
	parts: readonly PetPartBox[],
	modelBox: PetPartBox | null,
	epsRatio: number = HEAD_TOP_EPS_RATIO,
): PetPartBox | null => {
	if (!modelBox || !isBox(modelBox) || !Array.isArray(parts) || !parts.length) return null
	const modelH = modelBox.top - modelBox.bottom
	if (!(modelH > 0)) return null
	const valid = parts.filter(isBox)
	if (!valid.length) return null
	let maxTop = -Infinity
	for (const p of valid) if (p.top > maxTop) maxTop = p.top
	const cut = maxTop - modelH * clamp01(epsRatio)
	let box: PetPartBox | null = null
	for (const p of valid) {
		if (p.top < cut) continue          // 没伸到顶部 → 不是头
		if (p.bottom > modelBox.top) continue  // 完全在模型盒之上 (异常数据) → 跳过
		box = box
			? {
				left: Math.min(box.left, p.left),
				right: Math.max(box.right, p.right),
				top: Math.max(box.top, p.top),
				bottom: Math.min(box.bottom, p.bottom),
			}
			: {...p}
	}
	return box
}

/**
 * 网页版的摸头带：`y >= top - (top-bottom) * band`（模型坐标, y 轴向上）。
 * `headBox` 为 null（模型没加载/几何拿不到）时**返回 false** —— 宁可门槛严一点,
 * 也不要在拿不到几何时到处乱冒粒子。
 */
export const inHeadBand = (headBox: PetPartBox | null, y: number, band: number = SKULL_TOP_BAND): boolean => {
	if (!headBox || !isBox(headBox) || !Number.isFinite(y)) return false
	const h = headBox.top - headBox.bottom
	if (!(h > 0)) return false
	return y >= headBox.top - h * clamp01(band)
}

/** 供调试显示/断言：分界线的模型 y 值 */
export const headBandLine = (headBox: PetPartBox | null, band: number = SKULL_TOP_BAND): number | null => {
	if (!headBox || !isBox(headBox)) return null
	const h = headBox.top - headBox.bottom
	if (!(h > 0)) return null
	return headBox.top - h * clamp01(band)
}

/**
 * **头区兜底比例**：模型顶部这个比例以内也算"头"（与头盒**取并集**）。
 *
 * ## 为什么必须有它（实机反馈逼出来的）
 * 网页版 `skullTopBand = 0.6` 是针对**它自己那份 moc3 的部件切法**调出来的；
 * 而"部件怎么切"因模型而异。安卓这份 ARGNori 实测：
 *   - 最顶部部件 `Part3 y[0.613, 0.882]` 是**下巴到头顶的整个头** ⇒ 按 0.6 取上方 60%
 *     会把**脸**整个排除（分界线 0.721）；
 *   - 两侧双马尾 `Part7/8 y[0.420, 0.683]` 更低，更是全在带外。
 * 结果就是摸脸/摸头发**一直判"头外"**。
 *
 * 实测"头 + 脸 + 双马尾"整体落在 `y >= 0.42` 一带（约为模型顶部 32%），
 * 而肩/胸在 `y <= 0.40`（`Part50 y[0.191,0.397]`）⇒ 0.32 正好切在肩线附近。
 */
export const HEAD_ZONE_RATIO = 0.32

/**
 * 头区判定线 = **头盒带线与模型顶部比例线两者中更低的那个**（即两个区域的并集）。
 * 模型盒拿不到时退化为头盒带线；两者都拿不到才返回 null。
 */
export const headZoneLine = (
	headBox: PetPartBox | null,
	modelBox: PetPartBox | null,
	band: number = SKULL_TOP_BAND,
	ratio: number = HEAD_ZONE_RATIO,
): number | null => {
	const a = headBandLine(headBox, band)
	let b: number | null = null
	if (modelBox && isBox(modelBox)) {
		const h = modelBox.top - modelBox.bottom
		if (h > 0) b = modelBox.top - h * clamp01(ratio)
	}
	if (a === null) return b
	if (b === null) return a
	return Math.min(a, b)
}

/** 是否落在"头区"（头盒 ∪ 模型顶部比例）。几何全拿不到时返回 false —— 由调用方决定要不要兜底。 */
export const inHeadZone = (
	headBox: PetPartBox | null,
	modelBox: PetPartBox | null,
	y: number,
	band: number = SKULL_TOP_BAND,
	ratio: number = HEAD_ZONE_RATIO,
): boolean => {
	if (!Number.isFinite(y)) return false
	const line = headZoneLine(headBox, modelBox, band, ratio)
	return line !== null && y >= line
}

/**
 * 迟滞（leash）比例：**已经摸上之后**允许手指往下移开这么多模型高度，还不算"离开"。
 * 取 6%（用户定）—— 太小会在分界线上抖动导致反复开关，太大就变成"明明移开了还算头上"。
 *
 * 出处：网页版 `E8e()` 在"已经在摸"的阶段不再用原来的头带，而是用一个**外扩的盒子**
 * （`leashHeadWidths = 0.75` 个头宽）判"还在摸"，出框才 `Nu()` 结束。
 */
export const HEAD_LEASH_RATIO = 0.06
/** leash 盒的**额外边距**（模型高度的比例）：允许手指略微越过模型轮廓/头顶一点点。
 *  只给 2% —— 它同时是"往上移出"与"往左右移出"的界限, 给大了就又变成"移到很远处还算摸头"。 */
export const HEAD_LEASH_MARGIN_RATIO = 0.02

/**
 * 头区判定（带迟滞）。**进入用严格线；已经在区内则用有界的 leash 盒**。
 *
 * ## 为什么要迟滞
 * 手指停在分界线附近时，模型自己会呼吸/摆动，坐标会在两侧反复跳，
 * 不迟滞就会"粒子忽有忽无、音效忽响忽停"。
 *
 * ## 为什么"留驻"必须是个**有界的盒子**（实机 bug）
 * 第一版把留驻做成"只看 y 的一条线"（`y >= 线 − 迟滞`）—— **没有上界、也没有左右界**。
 * 于是摸完头后手指往上/往旁边挪进**空白区**，只要 y 还在线上方就继续算"摸头"，
 * 一直到抬手才取消（用户反馈："摸完头后突然移到很远处还是会判定摸头，3-4 秒后才取消"）。
 * 网页版的 `E8e` 本来就 x/y 都有界（头部包围盒外扩 0.75 头宽），是我抄漏了边界。
 *
 * 留驻盒 = `x ∈ [模型左−边距, 模型右+边距]`、`y ∈ [线−迟滞, 模型顶+边距]`。
 */
export const inHeadZoneHysteresis = (
	headBox: PetPartBox | null,
	modelBox: PetPartBox | null,
	x: number,
	y: number,
	wasIn: boolean,
	band: number = SKULL_TOP_BAND,
	ratio: number = HEAD_ZONE_RATIO,
	leash: number = HEAD_LEASH_RATIO,
	margin: number = HEAD_LEASH_MARGIN_RATIO,
): boolean => {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return false
	const line = headZoneLine(headBox, modelBox, band, ratio)
	if (line === null) return false
	// 进入: 严格线（是否命中实体由调用方再判）
	if (!wasIn) return y >= line
	// 留驻: 有界的 leash 盒
	if (!modelBox || !isBox(modelBox)) return false
	const h = modelBox.top - modelBox.bottom
	if (!(h > 0)) return false
	const m = h * clamp01(margin)
	return (
		x >= modelBox.left - m &&
		x <= modelBox.right + m &&
		y >= line - h * clamp01(leash) &&
		y <= modelBox.top + m
	)
}
