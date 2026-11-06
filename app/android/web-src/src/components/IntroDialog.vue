<template>
	<div class="intro-mask" @click.self="introClose">
		<!-- 2026-10-01 重做（用户：「内容不变，AI 味太大」）：不再渲染 40px 大 emoji，
		     改成"她递来的一张便签" —— 左对齐 + 顶部胶带 + 标题下短强调线 + 正文左侧细色条 + 细分页条。
		     文案与数据结构一字未改；类名保持原样（测试与探针按类名找元素）。 -->
		<div class="intro">
			<span class="intro-tape" aria-hidden="true"></span>
			<div class="intro-head">
				<span class="intro-step">第 {{ introStep + 1 }} / {{ INTRO_STEPS.length }} 步</span>
				<button class="x" @click="introClose">✕</button>
			</div>
			<div class="intro-title">{{ INTRO_STEPS[introStep].title }}</div>
			<span class="intro-rule" aria-hidden="true"></span>
			<div class="intro-body">
				<p v-for="(t, i) in INTRO_STEPS[introStep].body" :key="i" class="intro-p" :class="INTRO_STEPS[introStep].tone"><template v-for="(seg, j) in introSegs(t)" :key="j"><span v-if="seg.b" class="intro-b">{{ seg.t }}</span><template v-else>{{ seg.t }}</template></template></p>
				<div v-if="introStep === 2" class="intro-api-links" aria-label="API 密钥入口">
					<button class="mini ripple intro-api-link" type="button" @click="openIntroApi(DEEPSEEK_API_KEYS_URL)">文字调用</button>
					<button class="mini ripple intro-api-link" type="button" @click="openIntroApi(QIANWEN_API_KEYS_URL)">语音输出</button>
				</div>
			</div>
			<!-- 2026-10-02 修排版（用户截图：最后一步四个按钮挤一行，右侧两个被屏幕裁掉）：
			     两个「跳转类」按钮（项目仓库 / Steam 愿望单）单独占上面一行，且允许换行
			     （窄屏放不下就自动竖排）；分页条与「上一步 / 开始使用」留在下面一行。
			     类名一律保持原样（e2e-intro / probe-clone-gate 按类名找元素）。 -->
			<div class="intro-foot">
				<div v-if="introStep >= INTRO_STEPS.length - 1" class="intro-links">
					<!-- 项目仓库（2026-10-02 用户要求）：与愿望单同款的一键跳转，保持在最左（与用户截图一致） -->
					<button class="mini ripple intro-repo" @click="openRepo">项目仓库</button>
					<!-- Steam 愿望单（2026-10-01 用户要求）：只在最后一步出现，走原生 ACTION_VIEW 打开外部浏览器 -->
					<button class="mini ripple intro-steam" @click="openSteamWishlist">加入 Steam 愿望单</button>
				</div>
				<div class="intro-nav">
					<div class="intro-dots">
						<i v-for="(s, i) in INTRO_STEPS" :key="s.title" :class="{on: i === introStep, done: i < introStep}"></i>
					</div>
					<div class="intro-btns">
						<button v-if="introStep > 0" class="mini ripple intro-prev" @click="introPrev">上一步</button>
						<button class="mini ripple intro-next" @click="introNext">{{ introStep >= INTRO_STEPS.length - 1 ? "开始使用" : "下一步" }}</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import {ref} from "vue"

const emit = defineEmits<{
	close: []
	stepChange: []
	openUrl: [url: string]
}>()

interface IntroStep { emoji: string; title: string; body: string[]; tone?: "warn" | "ok" }
const INTRO_STEPS: IntroStep[] = [
	{
		emoji: "🌸",
		title: "欢迎来到 Nori 的小世界",
		body: [
			"这是一个简陋的新手引导，也是几句注意事项。",
			"此项目为**同人二创**，与原作无关。",
		],
		tone: "warn",
	},
	{
		emoji: "🛠️",
		title: "这个版本是谁做的",
		body: [
			"此版本由**小桧**（inori 一群 · 471419518）重构。",
			"原版本为**洱海**及**亓才孑**的最初版本 DeepEr（现已换包名，可共存）。",
		],
	},
	{
		emoji: "🔑",
		title: "开始前需要准备两样东西",
		body: [
			"API 需要付费，至少要准备：一个 LLM（大语言模型，如 DeepSeek）+ 一款 TTS 语音模型。",
			"TTS 有 Fish Audio 和千问可选，推荐千问的 Audio 3.1 TTS —— 效果与价格都很不错；音频可以在群里自行截取。",
			"⚠ 下载**音频**和**模型**可能需要**魔法**（国内不一定直连得上），下载前请自备网络环境。",
			"准备好后，在「设置」里填入 API 地址与密钥即可。",
			"另外：设置里请打开「所有文件访问权限」。Android 11 起，聊天记录/记忆/日记都存在公共下载目录，没有这个权限会读不到（尤其是卸载重装之后）。",
		],
		tone: "warn",
	},
	{
		emoji: "💬",
		title: "欢迎来找我反馈 bug",
		body: [
			"十分感谢**白夜 Tira** 以及 **I_Nori 制作组**的辛勤付出。",
			"欢迎你们找我反馈 bug 捏，希望大家和 Nori 越来越好。",
		],
		tone: "ok",
	},
]

const introStep = ref(0)
/** Render emphasis as text nodes, preserving the original guide copy. */
const introSegs = (text: string): {t: string; b: boolean}[] =>
	text.split("**").map((t, i) => ({t, b: i % 2 === 1})).filter(s => s.t !== "")
const introClose = (): void => emit("close")
const introNext = (): void => {
	if (introStep.value >= INTRO_STEPS.length - 1) { introClose(); return }
	introStep.value += 1
	emit("stepChange")
}
const introPrev = (): void => {
	if (introStep.value <= 0) return
	introStep.value -= 1
	emit("stepChange")
}

const STEAM_WISHLIST_URL = "https://store.steampowered.com/app/4996280/I_NORI/?beta=0"
const REPO_URL = "https://github.com/furret2333/NoriDroid"
const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys"
const QIANWEN_API_KEYS_URL = "https://platform.qianwenai.com/home/api-keys"
const openRepo = (): void => emit("openUrl", REPO_URL)
const openSteamWishlist = (): void => emit("openUrl", STEAM_WISHLIST_URL)
const openIntroApi = (url: string): void => emit("openUrl", url)
</script>

<style lang="less" scoped>
@import "../assets/style/dialog-controls.less";

.intro-mask {
	position: fixed; inset: 0;
	background: rgba(2, 6, 23, 0.72);
	backdrop-filter: blur(var(--ui-blur-mask));
	-webkit-backdrop-filter: blur(var(--ui-blur-mask));
	z-index: 80;                 /* 高于面板(20)与调试行(70) */
	display: flex; align-items: flex-end; justify-content: center;
}
.intro {
	position: relative;
	width: ~"min(100% - 26px, 396px)";   // ⚠ 必须带 ~"" 转义：LESS 会在编译期把 100% - 26px 算成 74%，弹窗就比设计窄 55px（2026-10-02 修）
	margin: 0 0 calc(30px + env(safe-area-inset-bottom));
	background: linear-gradient(180deg, #131f36 0%, var(--px-panel) 62%);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-panel);
	box-shadow: inset 0 2px 0 0 var(--ui-inner-glow), var(--ui-shadow);
	padding: 20px 20px 16px;
	transform: rotate(-0.45deg);        /* 像随手放在桌上的一张纸 */
	transition: transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1);
}
/* 顶部一小条胶带 (纯装饰) */
.intro-tape {
	position: absolute; top: -8px; left: 50%;
	width: 72px; height: 17px; margin-left: -36px;
	transform: rotate(-2deg);
	background: linear-gradient(180deg, rgba(127, 212, 230, 0.20), rgba(127, 212, 230, 0.09));
	border-left: 1px dashed rgba(127, 212, 230, 0.32);
	border-right: 1px dashed rgba(127, 212, 230, 0.32);
	border-radius: 2px;
}
.intro-head {
	display: flex; justify-content: space-between; align-items: center;
	margin-bottom: 10px;
}
.intro-step {
	font-size: 11px; color: var(--fg-dim);
	letter-spacing: 1.2px; font-variant-numeric: tabular-nums;
}
.intro-title {
	font-size: 19px; font-weight: 600; color: var(--fg);
	text-align: left; line-height: 1.35;
}
/* 标题下面那道短强调线 */
.intro-rule {
	display: block; width: 34px; height: 3px; margin: 9px 0 15px;
	background: var(--accent); border-radius: 2px; opacity: 0.85;
}
.intro-body {
	max-height: 44vh; overflow-y: auto;
	-webkit-overflow-scrolling: touch; touch-action: pan-y;
}
.intro-p {
	font-size: 13.5px; line-height: 1.78; color: var(--fg-2);
	margin: 0 0 11px; padding-left: 12px;
	border-left: 2px solid rgba(148, 163, 184, 0.22);
	&:last-child { margin-bottom: 0; }
	/* 语气只体现在左色条上 —— 不再把整段正文渲染成告警框 */
	&.warn { border-left-color: rgba(240, 190, 120, 0.5); }
	&.ok { border-left-color: rgba(127, 212, 230, 0.5); }
}
.intro-b { color: var(--fg); font-weight: 600; }
.intro-api-links {
	display: flex; flex-wrap: wrap; gap: 8px;
	margin: 13px 0 2px 14px;
	.intro-api-link {
		flex: 1 1 120px; min-width: 0;
		padding: 8px 12px; border-radius: var(--ui-radius-ctl);
		font-size: 13px; line-height: 1.15;
		color: var(--accent); background: rgba(127, 212, 230, 0.08);
		border: var(--ui-line-w) solid rgba(127, 212, 230, 0.42);
	}
}
/* 2026-10-02 修排版：原来的 .intro-foot 是**单行 flex**（分页条 + 4 个按钮同一行），
   而 .intro-btns .mini 是 white-space: nowrap（**不会缩**）。四个按钮 + 分页条挤一行要 ≈513px，
   而弹窗内容宽只有 325px（496 宽窗口）/ 225px（360 宽窗口）/ 195px（320 宽窗口）
   ⇒ 整行溢出弹窗、右侧两个按钮被屏幕裁掉（用户截图：只看得到「项目仓库」和半个「加入 Steam 愿…」）。
   改成两行：跳转类一行（.intro-links，可换行）+ 分页/翻页一行（.intro-nav，可换行）。
   注意：**不用 position: fixed** —— 那会把按钮移出弹窗。
   （另注：`.intro` 的 `width: min(100% - 26px, 396px)` 被 LESS 在编译期算成了 `min(74%, 396px)`，
     弹窗实测只有视口宽的 74% —— 见 交接文档 §21.1 的说明，本轮**没动**它。） */
.intro-foot {
	display: flex; flex-direction: column; gap: 10px;
	margin-top: 16px; padding-top: 12px;
	border-top: 1px dashed var(--ui-line-c-soft);
}
/* 跳转类按钮（项目仓库 / Steam 愿望单）单独一行：窄屏放不下就换行，任何手机宽度都不溢出、不被裁 */
.intro-links {
	display: flex; flex-wrap: wrap; gap: 8px;
	.mini {
		flex: 1 1 auto; text-align: center;
		padding: 9px 14px; border-radius: var(--ui-radius-ctl);
		font-size: 13.5px; line-height: 1;
		background: transparent; color: var(--fg-dim);
		border: var(--ui-line-w) solid var(--ui-line-c-soft);
	}
}
/* 分页条 + 「上一步 / 开始使用」：也允许换行（极窄屏时按钮整体掉到下一行，不横向溢出） */
.intro-nav {
	display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px;
}
/* 分页: 细横条 (原来是圆点) —— 仍是 4 个 <i>, e2e 按数量断言 */
.intro-dots {
	display: flex; gap: 5px;
	i {
		width: 13px; height: 2px; border-radius: 1px;
		background: rgba(148, 163, 184, 0.28);
		transition: background 0.2s ease, width 0.2s ease;
		&.done { background: rgba(127, 212, 230, 0.38); }
		&.on { width: 22px; background: var(--accent); }
	}
}
.intro-btns {
	margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
	.mini {
		padding: 9px 18px; border-radius: var(--ui-radius-ctl);
		font-size: 13.5px; line-height: 1;
	}
	.intro-prev {
		background: transparent; color: var(--fg-dim);
		border: var(--ui-line-w) solid var(--ui-line-c-soft);
	}
	.intro-next {
		background: var(--accent); color: #06121f; font-weight: 600;
		border: var(--ui-line-w) solid transparent;
		box-shadow: var(--ui-shadow);
	}
}
</style>
