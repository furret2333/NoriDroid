package com.noridroid

/**
 * 悬浮窗聊天气泡的**初始落点**计算 —— 纯函数, 不碰窗口 flag / 不碰触摸判定, 只算数.
 *
 * ## 为什么单独抽出来 (2026-10-02)
 * 用户报: 「悬浮窗打开后, 对话框嵌在 Nori 里面, 拖不出来」。
 * 根因是**单位不一致**: 页面 (FloatApp.vue) 上报的模型脚底是 CSS 像素, 而这里用的
 * `WindowManager.LayoutParams.x/y/width/height` 是**物理像素** ⇒ 顶边只算到模型身体中间。
 * 抽成纯函数 (无 Android 依赖) 是为了能在 JVM 上**真跑**单测 —— 对话框是独立 Activity 窗口,
 * 坐标在原生侧, 浏览器 (harness) 里拿不到, 只有这条链路能验:
 * `tmp-memcheck/probe-bubble-place.mjs` (编译并调用这里的 [placeBubble])。
 *
 * ## 坐标系与单位 (全是**物理像素**)
 * - [floatX] / [floatY] / [floatW] / [floatH]: 悬浮窗 (Nori 那个 OVERLAY 窗口) 的屏幕坐标与尺寸。
 * - [modelBottom]: 模型底边, **相对悬浮窗左上角**; `<= 0` = 页面还没上报 (未知)。
 * - [winW]: 对话框宽度 (调用方已按屏幕宽度钳制)。
 * - [screenLeft] / [screenTop] / [screenRight] / [screenBottom]: 屏幕可用区 (已排除状态栏/导航栏)。
 *
 * ## 约束优先级 (高 → 低)
 * 1. 对话框顶边落在模型底边**下方** ([GAP] 像素间隙) —— 不与 Nori 重叠, 一眼可见、随手能拖;
 *    模型底未知时退化成「悬浮窗底边下方」(同样不重叠)。
 * 2. 输入行落在悬浮窗底边之下 (正常两条路径都满足 `y + h >= floatY + floatH + 64`):
 *    悬浮窗是 OVERLAY (绘在 Activity 之上), 压住输入行会影响点击。
 * 3. 不超出屏幕可用区: 下方放不下先压回复区高度 (下限 [REPLY_MIN]), 再退到悬浮窗**上方**
 *    (仍不与模型重叠), 最后才钳进屏幕 (小屏 + 悬浮窗贴屏边, 正常机型走不到)。
 */

/** 对话框顶边与模型底边之间的间隙 (不贴死, 免得看着像压在一起) */
private const val GAP = 8
/** 回复区顶部内边距 (与原实现里的 "+8" 同义) */
private const val TEXT_TOP_PAD = 8
/** 输入行高度 (与 BubbleApp.vue 的输入行一致) */
private const val INPUT_H = 56
/** 回复区最大高度 (悬浮窗下方那部分) */
private const val REPLY_MAX = 300
/** 回复区最小高度 (屏幕放不下时压缩的下限; 实测输入行 57 CSS 像素 ⇒ 至少留住输入行) */
private const val REPLY_MIN = 160
/** 「顶部伸进悬浮窗底部留白」的封顶 (拉大 Nori 后留白会暴涨, 防对话框无限变长) */
private const val SAFE_TOP_CAP = 240

/** 落点结果 (物理像素)。[belowModel] 只是「是否真的落在模型下方」的记录 (日志/断言用) */
class BubbleLayout(
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
    val safeTop: Int,
    val belowModel: Boolean,
)

/**
 * 首次生成对话框时算落点。调用方 (FloatBubbleActivity) 只在**没有**用户拖过的位置记忆时调用;
 * 用户自己摆过的位置优先, 不走这里。
 */
fun placeBubble(
    floatX: Int,
    floatY: Int,
    floatW: Int,
    floatH: Int,
    modelBottom: Int,
    winW: Int,
    screenLeft: Int,
    screenTop: Int,
    screenRight: Int,
    screenBottom: Int,
): BubbleLayout {
    // 地板线: 对话框顶边不得高于它。模型底未知 → 用悬浮窗底边 (保守: 保证不压模型)
    val floorY = if (modelBottom > 0) floatY + modelBottom else floatY + floatH
    // 模型脚底到窗底的留白 = 对话框顶部可以「透过去」显示回复的区域 (封顶防暴涨)
    val safeTop = if (modelBottom > 0) (floatH - modelBottom).coerceIn(0, SAFE_TOP_CAP) else 0
    val hFull = safeTop + TEXT_TOP_PAD + INPUT_H + REPLY_MAX
    val hMin = TEXT_TOP_PAD + INPUT_H + REPLY_MIN
    val belowY = floorY + GAP
    val y: Int
    val h: Int
    when {
        // 模型下方放得下 (正常机型都走这条)
        screenBottom - belowY >= hMin -> {
            // 悬浮窗带 FLAG_LAYOUT_NO_LIMITS, 可以被拖到屏幕上方 → 地板线别把框放到屏幕外
            y = belowY.coerceAtLeast(screenTop)
            val room = screenBottom - y
            h = if (room >= hFull) hFull else room
        }
        // 下方放不下 → 挪到悬浮窗上方 (同样不与模型重叠)
        floatY - GAP - screenTop >= hMin -> {
            val room = floatY - GAP - screenTop
            h = if (room >= hFull) hFull else room
            y = floatY - GAP - h
        }
        // 上下都塞不下 (小屏且悬浮窗贴屏边) → 钳进屏幕, 至少保住输入行可见
        else -> {
            h = hMin.coerceAtMost((screenBottom - screenTop).coerceAtLeast(1))
            y = (screenBottom - h).coerceAtLeast(screenTop)
        }
    }
    val x = (floatX + (floatW - winW) / 2)
        .coerceIn(screenLeft, (screenRight - winW).coerceAtLeast(screenLeft))
    return BubbleLayout(x, y, winW, h, safeTop, y >= floorY)
}
