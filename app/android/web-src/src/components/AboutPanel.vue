<template>
	<div class="about-page">
		<!-- ① 版本 + 上游声明 -->
		<div class="about-sec">
			<div class="about-h">版本</div>
			<p class="about-p">NoriDroid <b>v{{ version }}</b>（Android 桌宠：Kotlin 外壳 + Vue 3 WebView 前端）</p>
			<p class="about-p">本项目<b>衍生自</b> <button class="about-a" @click="emit('openUrl', UPSTREAM_REPO_URL)">erhiolab/DeepEr</button>，上游以 <b>GPL-3.0</b> 发布；本仓库是<b>修改版</b>（重构、记忆模块、悬浮窗、一键克隆等改动），同样以 <b>GPL-3.0</b> 发布，详见仓库根的 LICENSE。</p>
			<p class="about-p">本项目仓库：<button class="about-a" @click="emit('openUrl', REPO_URL)">{{ REPO_URL }}</button></p>
		</div>
		<!-- ② 隐私说明 -->
		<div class="about-sec">
			<div class="about-h">隐私说明</div>
			<p class="about-p">会联网做什么：</p>
			<ul class="about-ul">
				<li>LLM 对话 —— 把你发的消息、人设与相关记忆发到<b>你自己填的</b> API 地址（默认 DeepSeek 等），回复也由它返回</li>
				<li>TTS 朗读 —— 把要朗读的文本发给你在设置里选的语音服务（Fish Audio / 千问）</li>
				<li>一键克隆 —— 联网下载参考音频，并把它上传给千问做音色克隆</li>
				<li>设置里的「下载音效」—— 从网络下载音效文件</li>
				<li v-if="presenceReady">在线人数 —— 匿名心跳：只上传<b>随机安装 ID + 应用版本号</b>（10 分钟窗口去重、今日按北京时间切日），不含设备标识、聊天内容或任何个人数据；服务端只存哈希，IP 仅用于内存限流、不落库也不打日志；可在设置里关闭</li>
			</ul>
			<p class="about-p">除此之外不采集、不上传任何数据：没有第三方统计、没有广告、没有崩溃上报 SDK；API Key 只存在本机设置里。</p>
			<p class="about-p">数据存在哪：</p>
			<ul class="about-ul">
				<li>聊天记录 / 记忆 / 日记 → <b>公共下载目录</b> <code>Download/NoriDroid/</code>（走系统媒体库写入，别的应用也看得到）</li>
				<li>人设文本 / 音效 / 背景音乐 / 模型缓存 → <b>应用私有目录</b>（其它应用读不到）</li>
			</ul>
			<p class="about-warn">⚠ 卸载说明：<b>公共下载目录里的聊天 / 记忆 / 日记卸载后一般仍在</b>（它们直接写在 <code>Download/NoriDroid/</code>，系统不会当成应用私有数据清掉，重装后还能读到）；但<b>人设、下载的音效、模型缓存、克隆音色记录存在应用私有目录，卸载会被清掉</b>，需要重新导入或下载。系统若在卸载时弹「是否保留应用数据」，勾选保留更保险。</p>
			<p class="about-p">权限用途：</p>
			<ul class="about-ul">
				<li><b>INTERNET</b> —— 上面那些联网功能（对话 / 朗读 / 下载）</li>
				<li><b>悬浮窗</b>（SYSTEM_ALERT_WINDOW）—— 退出 App 后让 Nori 留在桌面上</li>
				<li><b>通知</b>（POST_NOTIFICATIONS）—— 番茄钟到点提醒</li>
				<li><b>所有文件访问</b>（MANAGE_EXTERNAL_STORAGE）—— 读写公共下载目录里的聊天 / 记忆 / 日记；Android 11 起没有它就读不到旧数据（尤其是卸载重装之后）</li>
			</ul>
		</div>
		<!-- ③ 开源许可 -->
		<div class="about-sec">
			<div class="about-h">开源许可</div>
			<p class="about-p">随包分发的第三方组件：</p>
			<ul class="about-ul">
				<li><b>Vue 3</b> —— MIT（前端框架）</li>
				<li><b>live2d-easy-control 1.0.3</b> —— MIT；本项目用 <code>scripts/patch-live2d.mjs</code> 对它<b>打过补丁（修改版）</b>，原版权与许可声明保留，本项目修改的部分同样按 GPL-3.0 提供</li>
				<li><b>AndroidX / androidx.webkit</b> —— Apache-2.0（Android 支持库）</li>
				<li><b>Kotlin stdlib</b> —— Apache-2.0（Kotlin 标准库）</li>
				<li><b>霞鹜文楷 LXGW WenKai</b> · <b>站酷快乐体 ZCOOL KuaiLe</b> —— <b>SIL OFL 1.1</b>（设置 → 基础设置里的界面字体）。随包分发的是<b>子集</b>（GB2312 全量 + 界面用字，见 <code>scripts/subset-ui-fonts.py</code>）；许可全文在仓库 <code>src/assets/fonts/OFL-*.txt</code>。OFL 允许自由传播与嵌入软件，但<b>不得单独售卖字体文件</b>。</li>
				<li><b>Live2D Cubism Core</b>（live2dcubismcore.min.js）—— <b>专有许可</b>，不是开源组件。Core <b>按原样分发、不修改</b>，也<b>不置于会允许第三方修改的开源许可之下</b>；版权与许可声明一律保留。</li>
			</ul>
			<p class="about-p">Live2D 专有软件许可协议全文：</p>
			<button class="about-a ripple about-a-block" @click="emit('openUrl', LIVE2D_EULA_URL)">{{ LIVE2D_EULA_URL }}</button>
			<p class="about-p">不随包分发：人设文本、音效、参考音频、Live2D 模型素材都<b>不在安装包里</b> —— 由使用者自己导入或联网下载，版权归各自作者所有。</p>
			<p class="about-p">完整清单与 Live2D 协议的分发义务说明见仓库根目录的 <code>THIRD-PARTY.md</code>。</p>
			<!-- 字体许可全文（2026-10-16）: OFL 1.1 要求再分发时附带许可，
			     这里把原文打进包、可就地展开（默认收起，不打扰阅读）。 -->
			<details class="about-license">
				<summary>霞鹜文楷 LXGW WenKai · SIL OFL 1.1 许可全文</summary>
				<pre class="about-license-text">{{ oflWenKaiText }}</pre>
			</details>
			<details class="about-license">
				<summary>站酷快乐体 ZCOOL KuaiLe · SIL OFL 1.1 许可全文</summary>
				<pre class="about-license-text">{{ oflKuaiLeText }}</pre>
			</details>
		</div>
		<!-- ④ 反馈渠道 -->
		<div class="about-sec">
			<div class="about-h">反馈渠道</div>
			<p class="about-p">Nori 是「小桧」用爱发电做的同人二创，欢迎来找我反馈 bug 捏 —— QQ 群 <b>471419518</b>（inori 一群）。</p>
			<p class="about-p">项目仓库开 issue 也可以：<button class="about-a" @click="emit('openUrl', REPO_URL)">{{ REPO_URL }}</button></p>
		</div>
	</div>
</template>

<script setup lang="ts">
import oflWenKaiText from "../assets/fonts/OFL-LXGWWenKai.txt?raw"
import oflKuaiLeText from "../assets/fonts/OFL-ZCOOLKuaiLe.txt?raw"

defineProps<{version: string; presenceReady: boolean}>()
const emit = defineEmits<{openUrl: [url: string]}>()

const REPO_URL = "https://github.com/furret2333/NoriDroid"
const UPSTREAM_REPO_URL = "https://github.com/erhiolab/DeepEr"
const LIVE2D_EULA_URL = "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html"
</script>

<style lang="less" scoped>
.ripple { position: relative; overflow: hidden; }

.about-page {
	display: flex; flex-direction: column; gap: 18px;
	padding-bottom: 4px;
}
.about-sec { display: flex; flex-direction: column; gap: 6px; }
/* 小节标题：与「记忆系统」的 .mem-sec-title 同一套口径（accent 小字 + 虚线下边） */
.about-h {
	font-size: 12px; font-weight: 600; color: var(--accent);
	letter-spacing: 0.6px; padding-bottom: 4px;
	border-bottom: 1px dashed var(--ui-line-c-soft);
}
.about-p { margin: 0; font-size: 13px; line-height: 1.75; color: var(--fg-2); }
.about-p b { color: var(--fg); }
/* 字体许可全文（2026-10-16）: 默认收起，展开后给一块可滚动的等宽文本区 */
.about-license {
	margin-top: 4px;
	summary {
		font-size: 12.5px; color: var(--accent); cursor: pointer;
		list-style: none; padding: 3px 0;
		&::-webkit-details-marker { display: none; }
		&::before { content: "▸ "; }
	}
	&[open] summary::before { content: "▾ "; }
}
.about-license-text {
	margin: 6px 0 2px; padding: 10px 12px;
	max-height: 240px; overflow: auto;
	font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
	color: var(--fg-2); background: var(--px-panel-2);
	border: 1px solid var(--px-line); border-radius: 6px;
	user-select: text; -webkit-user-select: text;
}
.about-ul {
	margin: 0; padding-left: 18px;
	display: flex; flex-direction: column; gap: 5px;
	font-size: 13px; line-height: 1.7; color: var(--fg-2);
	li { margin: 0; }
	b { color: var(--fg); }
}
.about-page code {
	font-size: 12px; color: var(--accent);
	background: var(--px-panel-2);
	border-radius: 3px; padding: 1px 4px;
	word-break: break-all;
}
/* ⚠ 卸载警告：沿用引导页 warn 那档描边色，只做一条左色条 + 淡底，不抢眼但看得见 */
.about-warn {
	margin: 0; padding: 8px 10px;
	font-size: 13px; line-height: 1.7; color: #fbbf24;
	background: rgba(120, 53, 15, 0.28);
	border-left: 2px solid rgba(240, 190, 120, 0.5);
	border-radius: var(--ui-radius-ctl);
	b { color: #fde68a; }
}
/* 外链一律走原生 openExternal（不在 WebView 里跳走）—— 长相是行内链接，不是按钮。
   inline-block + max-width:100% + break-all: 长 URL 在窄屏上自己折行, 不会把面板撑宽。 */
.about-a {
	display: inline-block; max-width: 100%;
	padding: 0; margin: 0;
	background: transparent; border: none; border-radius: 0;
	color: var(--accent); font-size: inherit; font-family: inherit;
	line-height: inherit; text-align: left; white-space: normal;
	text-decoration: underline; word-break: break-all;
	vertical-align: baseline;
}
.about-a-block { display: block; margin-top: 2px; font-size: 12px; }
</style>
