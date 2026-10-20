package com.noridroid

/** 所有边界都是屏幕物理像素；与 dp/CSS 的换算只发生在调用方。 */
data class FloatingBounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width get() = (right - left).coerceAtLeast(1)
    val height get() = (bottom - top).coerceAtLeast(1)
}

data class FloatingFrame(val x: Int, val y: Int, val width: Int, val height: Int)

data class FloatingModelGeometry(
    val generation: Long, val revision: Long, val width: Int, val height: Int,
    val crop: IntArray, val hit: IntArray, val feet: Int, val precise: Boolean,
)

/** Reject stale mounts/resizes and malformed rectangles before they reach WindowManager. */
fun acceptsFloatingGeometry(report: FloatingModelGeometry, generation: Long, revision: Long, width: Int, height: Int): Boolean {
    fun valid(rect: IntArray) = rect.size == 4 && rect[0] >= 0 && rect[1] >= 0 &&
        rect[2] > rect[0] && rect[3] > rect[1] && rect[2] <= report.width && rect[3] <= report.height
    return report.generation == generation && report.revision > revision &&
        report.width in 1..100000 && report.height in 1..100000 &&
        kotlin.math.abs(report.width.toLong() - width) <= 3 && kotlin.math.abs(report.height.toLong() - height) <= 3 &&
        valid(report.crop) && valid(report.hit) && report.feet in 0..report.height &&
        report.crop[0] <= report.hit[0] && report.crop[1] <= report.hit[1] &&
        report.crop[2] >= report.hit[2] && report.crop[3] >= report.hit[3]
}

/** 允许画布留白和部分模型移出屏幕，仅保留一块模型矩形供用户拖回；不缩小画布、不吸边。 */
fun positionFloatingModel(
    x: Int, y: Int, width: Int, height: Int, rect: IntArray?, bounds: FloatingBounds, minVisible: Int,
): FloatingFrame {
    val model = modelWindowCrop(width, height, rect, 0)
    val keepW = minVisible.coerceIn(1, minOf(model.width, bounds.width))
    val keepH = minVisible.coerceIn(1, minOf(model.height, bounds.height))
    return FloatingFrame(
        x.coerceIn(bounds.left + keepW - model.x - model.width, bounds.left + bounds.width - keepW - model.x),
        y.coerceIn(bounds.top + keepH - model.y - model.height, bounds.top + bounds.height - keepH - model.y),
        width.coerceAtLeast(1), height.coerceAtLeast(1),
    )
}

fun fitFloatingWindow(
    x: Int, y: Int, width: Int, height: Int, bounds: FloatingBounds, snapDistance: Int = 0,
): FloatingFrame {
    val w = width.coerceIn(1, bounds.width)
    val h = height.coerceIn(1, bounds.height)
    val maxX = bounds.left + bounds.width - w
    var px = x.coerceIn(bounds.left, maxX)
    val py = y.coerceIn(bounds.top, bounds.top + bounds.height - h)
    if (snapDistance > 0) {
        val leftGap = px - bounds.left
        val rightGap = maxX - px
        if (minOf(leftGap, rightGap) <= snapDistance) {
            px = if (leftGap <= rightGap) bounds.left else maxX
        }
    }
    return FloatingFrame(px, py, w, h)
}

/** 裁掉画布外侧留白。矩形内的透明像素仍属于模型窗口，不宣称逐像素穿透。 */
fun modelWindowCrop(width: Int, height: Int, rect: IntArray?, padding: Int): FloatingFrame {
    val w = width.coerceAtLeast(1)
    val h = height.coerceAtLeast(1)
    if (rect == null || rect.size < 4 || rect[2] <= rect[0] || rect[3] <= rect[1] ||
        rect[2] <= 0 || rect[3] <= 0 || rect[0] >= w || rect[1] >= h) {
        return FloatingFrame(0, 0, w, h)
    }
    val pad = padding.coerceAtLeast(0)
    val left = (rect[0].coerceIn(0, w) - pad).coerceIn(0, w - 1)
    val top = (rect[1].coerceIn(0, h) - pad).coerceIn(0, h - 1)
    val right = (rect[2].coerceIn(0, w).toLong() + pad).coerceIn((left + 1).toLong(), w.toLong()).toInt()
    val bottom = (rect[3].coerceIn(0, h).toLong() + pad).coerceIn((top + 1).toLong(), h.toLong()).toInt()
    return FloatingFrame(left, top, right - left, bottom - top)
}

/** 先约束统一比例，再算宽高；屏幕太小时优先容纳窗口，不拉扁模型。 */
fun scaleFloatingSize(
    width: Int, height: Int, ratio: Float, minWidth: Int, minHeight: Int, maxWidth: Int, maxHeight: Int,
): Pair<Int, Int> {
    val w = width.coerceAtLeast(1)
    val h = height.coerceAtLeast(1)
    val upper = minOf(maxWidth.coerceAtLeast(1).toFloat() / w, maxHeight.coerceAtLeast(1).toFloat() / h)
    val lower = maxOf(minWidth.coerceAtLeast(1).toFloat() / w, minHeight.coerceAtLeast(1).toFloat() / h).coerceAtMost(upper)
    val scale = (if (ratio.isFinite() && ratio > 0f) ratio else 1f).coerceIn(lower, upper)
    return kotlin.math.round(w * scale).toInt().coerceIn(1, maxWidth.coerceAtLeast(1)) to
        kotlin.math.round(h * scale).toInt().coerceIn(1, maxHeight.coerceAtLeast(1))
}
