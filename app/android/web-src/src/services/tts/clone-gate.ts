/**
 * 「模型授权验证」—— 答题门的内容（题面/答案/判卷）。
 *
 * 2026-10-01 为一键克隆内置音色引入；2026-10-02 起**同一道门**也守在「下载 Live2D 模型」前面
 * （见 App.vue 的 openGate / pick：没装的模型点一下就是要下载，答对才放行）。弹窗/状态在 App.vue，
 * 题面与答案只放在这个文件里，改一处即可。
 *
 * 为什么有这道题：内置参考音频和 Nori 的 Live2D 模型都是 inori 提供的、**不可直接分发**的东西；
 * 答对问题才解锁使用资格（跟对面那套做法一致，见交接里记的那张参考图）。
 *
 * 比较口径：先归一化（去空白、去常见标点含全角、去书名号引号、转小写）再**全等**比较 ——
 * 容忍输入法带出来的标点/空格，但**不做模糊匹配**（不许"差不多就算对"）。
 */
export const CLONE_GATE_QUESTION = "Nori 写的诗第一句？（8 字）"
export const CLONE_GATE_HINT = "懒得找答案的话请戳我…… 另外：克隆效果不一定好，建议用 audio 3.1 模型。"
/** 「下载模型」走同一道门时的底部提示 —— 题面/判卷共用上面那套，只有这句按动作分岔
 *  （克隆那句一字未改，probe-clone-gate 盯着）。 */
export const MODEL_GATE_HINT = "懒得找答案的话请戳我…… 另外：模型包十几 MB，下载前请确认网络（国内可能需要魔法）。"

/** 正确答案：8 字，与题目里的「8 字」对上 */
const ANSWER = "水母是水里的月亮"

const PUNCT = /[\s，。、！？；：,.!?;:""''‘’“”「」『』（）()［］【】\[\]《》〈〉<>·~～^_\-—–]/g

/** 归一化：去掉空白与常见标点（含全角），转小写 */
export const normalizeCloneAnswer = (s: string): string => String(s ?? "").replace(PUNCT, "").toLowerCase()

/** 判卷：只看归一化后的**全等** */
export const checkCloneAnswer = (input: string): boolean =>
	normalizeCloneAnswer(input) !== "" && normalizeCloneAnswer(input) === normalizeCloneAnswer(ANSWER)
