/**
 * 界面可选字体（2026-10-15 用户要求）：系统默认 / 霞鹜文楷 / 站酷快乐体。
 *
 * 后两者是**随包的 OFL 1.1 子集**（`src/assets/fonts/*.woff2`，由 `scripts/subset-ui-fonts.py`
 * 从全量字体裁出来：GB2312 全量 6763 字 + App 源码里出现过的所有字 + 基本拉丁/标点）。
 * GB2312 之外的生僻字由字体栈后面的系统字体兜底 —— 不会显示成方块，也不会出现空白。
 *
 * 分工：这里只回答"当前选了哪个 / 怎么落到 DOM 上"；具体字形与字体栈在
 * `assets/style/ui-fonts.less`（按 `<html data-ui-font="…">` 切 `--ui-font`）。
 * 本模块**不 import 任何东西**（Node 侧门禁会直接 import 它做单测，不能碰 DOM/window）。
 */

export type UiFontChoice = "system" | "wenkai" | "kuaile"

export interface UiFontOption {
	value: UiFontChoice
	label: string
	hint: string
}

/** 设置界面里的三个选项（顺序 = 显示顺序） */
export const UI_FONT_OPTIONS: UiFontOption[] = [
	{value: "system", label: "系统默认", hint: "跟随设备：Windows 是 Segoe UI / 雅黑，手机上是各家厂商字体（现在的样子）"},
	{value: "wenkai", label: "霞鹜文楷", hint: "楷体，笔画轻、留白大，安静温润，最像「陪着你说话」；随包约 1.5 MB"},
	{value: "kuaile", label: "站酷快乐体", hint: "圆润手写感，更活泼可爱；随包约 0.8 MB"},
]

/** 认不出来的值（老设置文件 / 手改坏了）一律当系统默认 */
export const normalizeUiFont = (v: unknown): UiFontChoice =>
	v === "wenkai" || v === "kuaile" ? v : "system"

/**
 * 把选择写到 `<html data-ui-font="…">`；CSS 按这个属性切 `--ui-font`。
 * Node 侧没有 document（门禁单测会调它），所以必须容错。
 * @returns 归一化后的选择（调用方可以顺手写回设置）
 */
export const applyUiFont = (v: unknown): UiFontChoice => {
	const choice = normalizeUiFont(v)
	try {
		if (typeof document !== "undefined" && document.documentElement) {
			document.documentElement.setAttribute("data-ui-font", choice)
		}
	} catch { /* 忽略：拿不到 DOM 也不该让界面挂掉 */ }
	return choice
}

/** 选项按钮自己用哪套字体渲染（设置里当场就能看出差别）；系统默认那项直接继承 */
export const uiFontPreviewFamily = (v: UiFontChoice): string =>
	v === "wenkai" ? '"Nori WenKai"' : v === "kuaile" ? '"Nori KuaiLe"' : "inherit"
