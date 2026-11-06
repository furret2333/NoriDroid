<template>
<div class="settings-shell" :class="{'settings-tide': !uiSoft}">
		<div class="settings-tabs" role="tablist" aria-label="设置级别">
			<button type="button" role="tab" :aria-selected="settingsTab === 'basic'" :class="{active: settingsTab === 'basic'}" @click="settingsTab = 'basic'">基础设置</button>
			<button type="button" role="tab" :aria-selected="settingsTab === 'advanced'" :class="{active: settingsTab === 'advanced'}" @click="settingsTab = 'advanced'">进阶设置</button>
		</div>
		<button v-if="settingsTab === 'basic'" class="settings-intro-entry settings-basic-intro btn ripple intro-open" @click="emit('introOpen')">
			<span class="settings-intro-copy"><b>新手教程 / 致谢</b><small>快速了解 Nori 的功能和设置</small></span>
			<span class="settings-entry-arrow" aria-hidden="true">→</span>
		</button>
		<div v-if="settingsTab === 'basic'" class="settings-basic-grid">
			<div class="settings-basic-column">
			<section class="settings-basic-group settings-basic-group-connection">
				<div class="settings-basic-heading"><h3>连接</h3><small>{{ modelReady ? '已配置' : '待配置' }}</small></div>
				<div class="settings-row">
					<label>API Base URL</label>
					<input v-model="cfg.baseUrl" type="text" spellcheck="false" autocomplete="off" />
				</div>
				<div class="settings-row">
					<label>API Key</label>
					<input v-model="cfg.apiKey" type="text" autocomplete="off" spellcheck="false" />
				</div>
				<div class="settings-row">
					<label>模型</label>
					<div class="model-pick">
						<select v-model="cfg.model">
							<option value="" disabled>— 选择模型 —</option>
							<option v-for="md in modelOptions" :key="md" :value="md">{{ md }}</option>
						</select>
						<button class="mini ripple" @click="emit('refreshModels')">加载模型</button>
					</div>
					<div v-if="modelLoadMsg" class="hint">{{ modelLoadMsg }}</div>
				</div>
			</section>
			<section class="settings-basic-group settings-basic-group-display">
				<div class="settings-basic-heading"><h3>显示清晰度</h3></div>
				<div class="settings-row">
					<label>渲染分辨率 {{ renderScaleNum.toFixed(1) }}x（原生 {{ nativeDpr.toFixed(1) }}x）</label>
					<input type="range" min="0.5" max="3.0" step="0.1" v-model.number="cfg.renderScale" @change="emit('applyRenderScale')" />
					<div class="hint">越高越清晰、越耗电；调到原生清晰度可获得最清楚的显示。</div>
				</div>
			</section>
			<section class="settings-basic-group settings-basic-group-music">
				<div class="settings-basic-heading"><h3>背景音乐</h3><small>{{ bgmState === 'ready' ? '资源已就绪' : bgmState === 'downloading' ? `下载中 ${bgmPct}%` : '首次播放需下载' }}</small></div>
				<div class="settings-row">
					<label>播放曲目</label>
					<div class="model-pick">
						<select :value="cfg.bgmTrack" @change="emit('bgmTrackChange', $event)"><option value="random">随机播放</option><option v-for="t in BGM_TRACKS" :key="t.id" :value="t.id">{{ t.name }}</option></select>
						<button class="mini ripple" :disabled="!bgmCanSkip" @click="emit('bgmNext')">换一首</button>
					</div>
				</div>
				<div class="settings-row">
					<label>音量 {{ Math.round((Number(cfg.bgmVolume) || 0) * 100) }}%</label>
					<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.bgmVolume" @input="emit('bgmVolume')" @change="emit('persistSettings')" />
				</div>
				<button v-if="bgmState === 'missing'" class="mini ripple" @click="emit('bgmDownload')">下载背景音乐资源</button>
				<button v-else-if="bgmState === 'downloading'" class="mini ripple" disabled>正在下载 {{ bgmPct }}%</button>
			</section>
			<section class="settings-basic-group settings-basic-group-float">
				<div class="settings-basic-heading"><h3>悬浮窗</h3></div>
				<div class="settings-row">
					<div class="row-inline"><label>离开应用后显示悬浮窗 Nori</label><input type="checkbox" v-model="cfg.floatEnabled" @change="emit('floatToggle', $event)" /></div>
					<div class="hint">{{ floatPermissionHint }}</div>
					<button class="mini ripple" @click="emit('resetFloatWindow')">重置悬浮窗位置和大小</button>
				</div>
			</section>
			<section class="settings-basic-group settings-basic-group-font">
				<div class="settings-basic-heading"><h3>界面字体</h3></div>
				<div class="settings-row">
					<div class="pomo-range">
						<button
							v-for="o in UI_FONT_OPTIONS" :key="o.value"
							class="pomo-rbtn" :class="{on: uiFontNow === o.value}"
							:style="{fontFamily: uiFontPreviewFamily(o.value)}"
							@click="emit('setUiFont', o.value)"
						>{{ o.label }}</button>
					</div>
					<div class="hint">{{ uiFontHint }}</div>
					<div class="hint">缺字（GB2312 之外的生僻字）会自动回落系统字体；两个字体都随包，无需联网下载</div>
				</div>
			</section>
			</div>
			<div class="settings-basic-column">
			<section class="settings-basic-group settings-basic-group-persona">
				<div class="settings-basic-heading"><h3>人设与语音</h3></div>
				<div class="settings-row">
					<label>人设文案（提示词）</label>
					<div class="row-inline">
						<button class="mini ripple" @click="emit('importPersona')">导入文件</button>
						<button class="mini ripple" :disabled="!personaCustom" @click="emit('resetPersona')">清除自定义</button>
					</div>
					<div class="hint">{{ personaStateText }}</div>
					<div v-if="personaMsg" class="hint" :class="{ok: personaMsgOk, bad: !personaMsgOk}">{{ personaMsg }}</div>
				</div>
				<div class="settings-row">
					<div class="row-inline"><label>官方人设</label><button class="mini ripple" :disabled="personaDlBusy" @click="emit('openPersonaGate')">{{ personaDlBusy ? "下载中…" : "下载官方人设" }}</button></div>
					<div v-if="personaDlMsg" class="hint" :class="{ok: personaDlOk, bad: !personaDlOk}">{{ personaDlMsg }}</div>
				</div>
				<div class="settings-row settings-tts-entry">
					<button class="settings-entry-button ripple" @click="emit('openPanel', 'tts')">
						<span class="settings-entry-icon" aria-hidden="true">◌</span>
						<span class="settings-entry-copy"><b>语音合成</b><small>配置朗读服务、音色与试听</small></span>
						<span class="settings-entry-arrow" aria-hidden="true">→</span>
					</button>
				</div>
			</section>
			<section class="settings-basic-group settings-basic-group-preferences">
				<div class="settings-basic-heading"><h3>日常偏好</h3></div>
				<div class="settings-row">
					<div class="row-inline"><label>动态背景</label><select v-model="cfg.backgroundMode" @change="emit('backgroundModeChange')"><option value="off">关闭</option><option value="datasea">数据海</option><option value="deep-sea">深海场景</option></select></div>
					<div v-if="cfg.backgroundMode === 'deep-sea'" class="row-inline"><label>深海画质</label><select v-model="cfg.deepseaQuality" aria-label="深海画质" @change="emit('deepseaQualityChange')"><option value="balanced">均衡</option><option value="fine">精细</option></select></div>
					<div v-if="cfg.backgroundMode === 'deep-sea'" class="hint">精细画质可能增加耗电与发热。</div>
					<div v-if="backgroundError" class="hint bad">{{ backgroundError }} <button class="mini ripple" @click="emit('retryBackground')">重试</button></div>
				</div>
				<div class="settings-row">
					<div class="row-inline"><label>让 Nori 知道时间</label><input type="checkbox" v-model="cfg.timeAware" @change="emit('persistSettings')" /></div>
				</div>
				<div class="settings-row">
					<label>安静模式</label>
					<div class="model-pick"><select v-model="cfg.quietMode" @change="emit('quietModeChange')"><option value="off">关闭</option><option value="auto">自动（每日 23:00–次日 8:00）</option><option value="manual">手动</option></select></div>
					<div v-if="cfg.quietMode === 'manual'" class="row-inline"><label>立即静音</label><input type="checkbox" v-model="cfg.quietOn" @change="emit('quietToggle')" /></div>
				</div>
				<div class="settings-row">
					<div class="row-inline"><label>Nori 主动搭话</label><input type="checkbox" v-model="cfg.ambientEnabled" @change="emit('ambientToggle')" /></div>
				</div>
			</section>
			<section class="settings-basic-group settings-basic-group-touch">
				<div class="settings-basic-heading"><h3>摸头与自定义触摸</h3></div>
				<div class="settings-row">
					<div class="hint">设置摸头反馈，或为当前模型配置触摸区域。</div>
					<button class="mini ripple" @click="emit('openPanel', 'touch')">打开互动设置</button>
				</div>
			</section>
			<section class="settings-basic-group settings-basic-group-memory">
				<div class="settings-basic-heading"><h3>数据与记忆</h3></div>
				<div class="settings-row">
					<label>数据目录</label><div class="hint ok">{{ storagePath }}</div>
				</div>
				<div class="settings-row">
					<div class="row-inline"><label>所有文件访问权限{{ allFilesAccess ? '（已授权）' : '（未授权）' }}</label><button class="mini ripple" @click="emit('requestAllFiles')">去授权</button></div>
				</div>
				<div class="settings-row">
					<label>长期记忆与历史摘要</label>
					<!-- 基础设置页的入口走**直连**（不看也念「害羞」台词，一下即进）。
					     进阶设置里那个 .mem-enter 才保留三下拦门。这个不对称是 2026-10-25
					     产品定调的结果（"绕过就行"）：基础页是日常顺手入口，别当 bug 补拦门。 -->
					<button class="mini ripple" @click="emit('openPanel', 'memories')">打开记忆库 · {{ memoryCount }} 条</button>
				</div>
			</section>
			</div>
		</div>
		<template v-else>
			<header class="settings-overview settings-advanced-overview">
				<div class="settings-overline">NORI CONTROL DECK</div>
				<nav class="settings-jumps" aria-label="设置分区">
					<a href="#settings-connection">连接</a>
					<a href="#settings-display">显示</a>
					<a href="#settings-storage">存储</a>
					<a href="#settings-sound">声音</a>
					<a href="#settings-memory">记忆</a>
					<a href="#settings-window">窗口</a>
				</nav>
			</header>
		<details id="settings-connection" class="settings-section">
				<summary><span><b>连接与模型</b><small>配置 API 地址、密钥和模型</small></span><i aria-hidden="true"></i></summary>
			<div class="settings-section-body">
	<div class="settings-row">
		<label>API Base URL</label>
		<input v-model="cfg.baseUrl" type="text" spellcheck="false" autocomplete="off" />
	</div>
	<div class="settings-row">
		<label>API Key</label>
		<input v-model="cfg.apiKey" type="text" autocomplete="off" spellcheck="false" />
	</div>
	<div class="settings-row">
		<label>模型</label>
		<div class="model-pick">
			<select v-model="cfg.model">
				<option value="" disabled>— 选择模型 —</option>
				<option v-for="md in modelOptions" :key="md" :value="md">{{ md }}</option>
			</select>
			<button class="mini ripple" @click="emit('refreshModels')">加载模型</button>
		</div>
		<div v-if="modelLoadMsg" class="hint">{{ modelLoadMsg }}</div>
	</div>
		</div>
	</details>

	<details id="settings-display" class="settings-section">
		<summary><span><b>显示与性能</b><small>调整气泡阅读体验和 Live2D 流畅度</small></span><i aria-hidden="true"></i></summary>
		<div class="settings-section-body">
	<div class="settings-row">
		<label>气泡字体 {{ bubbleScaleNum.toFixed(2) }}（推荐 1.00）</label>
		<input type="range" min="0.7" max="1.8" step="0.05" v-model.number="cfg.bubbleScale" />
	</div>
	<div class="settings-row">
		<label>气泡宽度 {{ bubbleWidthNum }}%（推荐 82%）</label>
		<input type="range" min="55" max="95" step="1" v-model.number="cfg.bubbleWidth" />
		<div class="hint">越窄，每行字数越少，标点更容易单独成行；觉得句号/问号落单就调宽一点</div>
	</div>
	<div class="settings-row">
		<label>渲染帧率上限 {{ l2dFpsNum === 0 ? "不限制" : `${l2dFpsNum} fps` }}（形象 + 背景）</label>
		<div class="pomo-range">
			<button
				v-for="v in L2D_FPS_OPTIONS" :key="v"
				class="pomo-rbtn" :class="{on: l2dFpsNum === v}"
				@click="emit('setL2dFps', v)"
			>{{ l2dFpsLabel(v) }}</button>
		</div>
		<div class="hint">
			Live2D 形象与数据海背景每秒最多重绘几次（两者同步；悬浮窗也跟随这个档位）。120Hz 屏设 60 省一半；
			30/20/15 更省电但动作与背景会略跳。60Hz 屏只有设到低于 60 才有区别。选「不限」恢复原来的行为
		</div>
	</div>
			</div>
		</details>

		<details id="settings-storage" class="settings-section">
			<summary><span><b>数据与存储</b><small>查看文件位置和访问权限</small></span><i aria-hidden="true"></i></summary>
			<div class="settings-section-body">
	<div class="settings-row">
		<label>聊天记录存储位置</label>
		<!-- 2026-10-02 更正: 写在**公共下载目录**里的文件（聊天/记忆/日记）卸载后一般仍在（系统不按应用私有数据清理）；
		     现在清单里加了 hasFragileUserData, 卸载时会询问是否保留下应用数据 (勾选才保留)。 -->
		<div class="hint ok">公共下载目录：{{ storagePath }}（重装后若内容不见了，见下方「存储自检」）</div>
		<div class="row-inline">
			<label>所有文件访问权限{{ allFilesAccess ? "（已授权 ✓）" : "（未授权）" }}</label>
			<button class="mini ripple" @click="emit('requestAllFiles')">去授权</button>
		</div>
		<div class="hint">
			用于读写 {{ storagePath }} 里的数据文件。<b>卸载重装后原有内容读不到，就是因为没有它</b>：
			Android 11+ 起，别的应用（或本应用旧实例）写进公共下载目录的文件，本应用既在媒体库里看不见、也不能直接读。
			授予后返回本页点「自检」，会显示「所有文件访问权限: 是」且内容被读回。
		</div>
		<div class="row-inline">
			<label>存储自检（读不到数据时点一下）</label>
			<button class="mini ripple" @click="emit('storageProbe')">自检</button>
		</div>
		<pre v-if="storageProbeMsg" class="store-probe">{{ storageProbeMsg }}</pre>
		<div class="hint">列出公共目录里到底有没有文件、MediaStore 是否可见、能否直读 —— 卸载重装后排查"原有内容读不到"用</div>
	</div>
			</div>
		</details>

		<details id="settings-sound" class="settings-section">
			<summary><span><b>声音与陪伴</b><small>背景音乐、音效和主动互动</small></span><i aria-hidden="true"></i></summary>
			<div class="settings-section-body">
	<div class="settings-row mem-block">
		<label>背景音乐</label>
		<div class="mem-sec">
			<div class="mem-sec-title mem-sec-title-row">
				<span>NoriOS 官方 OST{{ bgmNowName ? ` · 正在播放：${bgmNowName}` : "" }}</span>
				<label class="bgm-toggle">
					<input type="checkbox" :checked="cfg.bgmEnabled" @change="emit('bgmToggle', $event)" /> 开启
				</label>
			</div>
			<div class="model-pick">
				<select :value="cfg.bgmTrack" @change="emit('bgmTrackChange', $event)">
					<option value="random">随机播放</option>
					<option v-for="t in BGM_TRACKS" :key="t.id" :value="t.id">{{ t.name }}</option>
				</select>
				<button v-if="cfg.bgmEnabled && bgmState === 'ready'" class="mini ripple" @click="emit('bgmNext')">换一首</button>
			</div>
			<div class="hint">
				{{ bgmState === "ready" ? "资源已就绪，随开关播放" : bgmState === "downloading" ? `资源包下载中 ${bgmPct}%` : "音频资源未下载（约 13MB，首次需联网）" }}
			</div>
			<button
				v-if="bgmState !== 'ready'"
				class="mini ripple"
				:disabled="bgmState === 'downloading'"
				@click="emit('bgmDownload')"
			>{{ bgmState === "downloading" ? `下载中 ${bgmPct}%` : "下载背景音乐资源" }}</button>
			<button v-else class="mini ripple" @click="emit('bgmRedownload')">重新下载</button>
			<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.bgmVolume" @input="emit('bgmVolume')" @change="emit('persistSettings')" />
			<div class="hint">音量独立于朗读语音，默认 35% 不盖 Nori 说话；循环播放，退后台自动暂停</div>
		</div>
	</div>
	<div class="settings-row">
		<label>按键音效音量 {{ Math.round((Number(cfg.sfxVolume) || 0) * 100) }}%（0% = 关闭）</label>
		<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.sfxVolume" @input="emit('sfxVolume')" @change="emit('persistSettings')" />
		<div class="hint">点击底部功能按钮时的提示音</div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>音效文件</label>
			<button class="mini ripple" :disabled="sfxBusy" @click="emit('downloadSfx')">{{ sfxBtnText }}</button>
		</div>
		<div class="hint" :class="{ok: sfxMsgOk, bad: sfxMsgBad}">{{ sfxMsg }}</div>
		<div class="hint">音效不再打进安装包（包更小），这里点一次下到本机，之后一直用本地的；没下载时按键音与番茄钟音效静音但不报错</div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>动态背景</label>
			<select v-model="cfg.backgroundMode" @change="emit('backgroundModeChange')"><option value="off">关闭</option><option value="datasea">数据海</option><option value="deep-sea">深海场景</option></select>
		</div>
		<div v-if="cfg.backgroundMode === 'deep-sea'" class="row-inline"><label>深海画质</label><select v-model="cfg.deepseaQuality" aria-label="深海画质" @change="emit('deepseaQualityChange')"><option value="balanced">均衡</option><option value="fine">精细</option></select></div>
		<div class="hint">深海场景适合性能较好的设备，可能增加耗电与发热。</div>
		<div v-if="backgroundError" class="hint bad">{{ backgroundError }} <button class="mini ripple" @click="emit('retryBackground')">重试</button></div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>让 Nori 知道时间</label>
			<input type="checkbox" v-model="cfg.timeAware" @change="emit('persistSettings')" />
		</div>
		<div class="hint">发送时提供设备时间与当前时段，让问候和作息话题更贴合当下，并区分历史对话的时间。请确保手机时间、时区正确。</div>
	</div>
	<div class="settings-row">
		<label>安静模式</label>
		<div class="model-pick">
			<select v-model="cfg.quietMode" @change="emit('quietModeChange')">
				<option value="off">关闭</option>
				<option value="auto">自动（每日 23:00–次日 8:00）</option>
				<option value="manual">手动</option>
			</select>
		</div>
		<div v-if="cfg.quietMode === 'manual'" class="row-inline">
			<label>立即静音</label>
			<input type="checkbox" v-model="cfg.quietOn" @change="emit('quietToggle')" />
		</div>
		<div class="hint">开启后 Nori 不主动搭话、BGM 暂停；你发消息她照常回复（TTS 朗读与按键音保留）</div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>Nori 主动搭话</label>
			<input type="checkbox" v-model="cfg.ambientEnabled" @change="emit('ambientToggle')" />
		</div>
		<div class="hint">安静几分钟后，她可能会轻轻说一句（本地语料零 token、不进聊天记录；每次会话最多几条）；安静模式开启时不生效</div>
	</div>
			</div>
		</details>

		<details id="settings-memory" class="settings-section">
			<summary><span><b>记忆与互动</b><small>记忆策略、表情驱动和头部跟随</small></span><i aria-hidden="true"></i></summary>
			<div class="settings-section-body">
	<div class="settings-row">
		<div class="row-inline">
			<label>命中区域调试（测试用）</label>
			<input type="checkbox" v-model="hitDebug" />
		</div>
		<div class="hint">开启后屏幕顶部显示当前触摸命中的区域（实体/留白）与抚摸进度（如「抚摸 0.4/1.0s · 完成 2 · 速度 0.42」），用于验证摸头位置判定与"完成一次"的时机；显示"异常"说明命中组件出错（会附原因）；正式使用可关闭</div>
	</div>
	<div class="settings-row mem-block">
		<label>记忆系统</label>
		<!-- 记忆库入口 (2026-09-26 用户要求): 原来把"目标 / 长期记忆 / 历史总结"三份
		     列表**裸露在一级设置页**里, 又长又得往下滚; 现在收进二级菜单 (panel === 'memories'),
		     这里只留入口 + 下面那些开关/操作按钮。列表本身在记忆库页里更全 (带搜索/筛选/时间与重要度)。 -->
		<!-- 点这里先给反应 (气泡 + 朗读), 第三下才真的进去 —— 见 onMemEntryTap。
		     ⚠ 只有**进阶设置**这个入口还带三下拦门; 基础设置页那个直连入口是有意绕过的
		     (2026-10-25 产品定调)，两边不对称不是 bug。 -->
		<button class="mini ripple mem-enter" @click="emit('memEntryTap')">
			记忆库 · 目标 / 长期记忆 / 历史总结（{{ memoryCount }} 条） ›
		</button>
		<div class="row-inline">
			<label>摘要后自动裁剪旧聊天记录</label>
			<input type="checkbox" v-model="cfg.trimHistory" />
		</div>
		<div class="hint">开启后, 已压缩的旧消息会从聊天记录中移除（摘要仍保留），避免聊天记录无限膨胀</div>
		<div class="row-inline">
			<label>用 AI 提取与整理记忆（更准，推荐开启）</label>
			<input type="checkbox" v-model="cfg.memoryLlmExtract" />
		</div>
		<div class="hint">历史总结时由 AI 顺手挑出该记的信息（闲聊、提问、情绪不记），并自动合并重复、作废被改口的旧说法。与摘要共用同一次调用，不额外花 token；关闭后只靠关键词规则记，记得少</div>
		<div class="row-inline">
			<label>每条消息都立即提取记忆（旧的实时通道，默认关闭）</label>
			<input type="checkbox" v-model="cfg.memoryRealtimeExtract" />
		</div>
		<div class="hint">关闭时：记忆在历史总结时一次整理（最多晚几十条消息，但调用量少一个数量级，改口也不会记错）。开启时：每句都可能多花 1~2 次小调用，仅供出问题时对照排错</div>
		<div class="row-inline">
			<label>用 AI 语义召回记忆（推荐开启）</label>
			<input type="checkbox" v-model="cfg.smartRecall" />
		</div>
		<div class="hint">对话前用 AI 判断哪些记忆真正相关（“那个游戏”→ 记得你喜欢玩原神），比纯关键词准得多；每次对话多一次小调用，介意 token 可关</div>
		<div class="btn-row mem-btns">
			<button class="mini ripple" @click="emit('pruneMemories')">清理低频记忆（30天未提）</button>
			<button class="mini ripple" @click="emit('clearMemory')">清空全部记忆</button>
			<button class="mini ripple" @click="emit('restoreMemory')" :disabled="!hasBackup">撤销上次清理</button>
			<button class="mini ripple" @click="emit('exportAll')">导出</button>
		</div>
		<div v-if="memPruneMsg" class="hint" :class="{ok: memPruneMsgOk, bad: !memPruneMsgOk}">{{ memPruneMsg }}</div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>AI 表情标记（推荐开启）</label>
			<input type="checkbox" v-model="cfg.emotionLlm" />
		</div>
		<div class="hint">回复末尾附带【表情】【动作】标记，由 AI 判断并即时驱动表情/动作；关闭则用关键词规则。标记不显示、不朗读，几乎不增加 token</div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>DeepSeek 思考模式</label>
			<input type="checkbox" v-model="cfg.deepseekThinking" />
		</div>
		<div class="hint">让 DeepSeek 先思考再回答（更慢、更费 token）；仅对 DeepSeek 端点生效，默认开启，关掉即显式关闭</div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>头部跟随 · 左右反向</label>
			<input type="checkbox" v-model="cfg.lookFlipX" />
		</div>
		<div class="row-inline">
			<label>头部跟随 · 上下反向</label>
			<input type="checkbox" v-model="cfg.lookFlipY" />
		</div>
		<label>头部跟随灵敏度 {{ Number(cfg.lookSens).toFixed(2) }}</label>
		<input type="range" min="0.1" max="0.5" step="0.05" v-model.number="cfg.lookSens" />
		<div class="hint">手指方向不对就勾选反向；跟得太肉或太跳就调灵敏度（只影响摸头时的跟随紧致度；松手后按固定的"轻拨感"缓缓回正，不随此档位变化。改完点保存设置）</div>
	</div>
	<div class="settings-row">
		<div class="row-inline">
			<label>启用 Live2D 口型</label>
			<input type="checkbox" v-model="cfg.lipSyncEnabled" @change="emit('persistSettings')" />
		</div>
		<div class="hint">默认关闭；开启后按实际播放音频振幅驱动口型，无法取得可靠振幅时保持闭嘴</div>
	</div>
			</div>
		</details>

		<details id="settings-window" class="settings-section">
			<summary><span><b>窗口与手势</b><small>控制悬浮窗和触摸行为</small></span><i aria-hidden="true"></i></summary>
			<div class="settings-section-body">
	<div class="settings-row">
		<div class="row-inline">
			<label>离开应用后显示悬浮窗 Nori</label>
			<input type="checkbox" v-model="cfg.floatEnabled" @change="emit('floatToggle', $event)" />
		</div>
		<div class="hint">开启后，按 Home、切后台或退出应用时，Nori 会留在屏幕上。{{ floatPermissionHint }}</div>
	</div>
	<div class="settings-row">
		<label>悬浮窗渲染分辨率 {{ Number(cfg.floatRenderScale).toFixed(1) }}x（推荐 {{ nativeDpr.toFixed(1) }}x）</label>
		<input type="range" min="0.5" max="3.0" step="0.1" v-model.number="cfg.floatRenderScale" @change="emit('floatRenderScale')" />
		<div class="hint">渲染分辨率同主 App，越高越清晰也越耗电（悬浮窗尺寸用双指缩放调节，自动记忆）</div>
		<button class="btn ripple" @click="emit('resetFloatWindow')">重置悬浮窗位置和大小</button>
	</div>
	<div class="settings-row">
		<div class="row-inline label-only">悬浮窗触摸手势</div>
			<div class="hint">· 轻点 Nori 身体 → 打开聊天窗口<br />· 按住并移动 → 直接拖动桌宠，允许把留白和部分模型移出屏幕<br />· 在窗口内双指捏合 → 等比调整大小<br />· 拖动和点按都会重置待机计时<br />· 聊天窗口：拖 ≡ 标题栏移动，双指捏合缩放，点锁形图标固定位置和大小，点 × 关闭<br />· 只有点击输入框才唤起键盘</div>
	</div>
			</div>
		</details>

		<details class="settings-section settings-actions">
			<summary><span><b>更多工具</b><small>动作、表情与外观工具</small></span><i aria-hidden="true"></i></summary>
			<div class="settings-section-body">
				<button class="btn ripple" @click="emit('openPanel', 'touch')">摸头与自定义触摸</button>
				<button class="btn ripple" @click="emit('openPanel', 'motion')">动作列表</button>
	<button class="btn ripple" @click="emit('openPanel', 'expression')">表情列表</button>
	<button class="btn ripple" @click="emit('toggleUiStyle')">外观风格：{{ uiSoft ? "柔和雾面" : "潮汐玻璃" }} ›</button>
	<!-- 在线人数（2026-10-21）: 默认开；关掉后一个请求都不发，关于页也不显示人数 -->
	<div v-if="presenceReady" class="settings-row">
		<div class="row-inline"><label>显示在线人数（匿名心跳）</label><input type="checkbox" v-model="cfg.presenceEnabled" @change="emit('presenceToggle')" /></div>
		<div class="hint">匿名心跳：每 5 分钟上报一次随机安装 ID 与应用版本号，仅用于「此刻在线 / 今日来过」计数；不含设备标识与聊天内容。关闭后不再发送任何请求。</div>
	</div>
			</div>
		</details>
		</template>

		<div class="settings-bottom-actions">
			<button class="btn ripple primary settings-save-button" @click="emit('saveSettingsNow')">保存设置</button>
			<button class="settings-license-link mini ripple about-open" @click="emit('openAboutPage')">
				<span><b>开源许可 / 关于 / 隐私</b><small>NoriDroid · v{{ version }}</small></span>
				<span aria-hidden="true">→</span>
			</button>
			<!-- 在线人数（2026-10-23 用户要求）: 放在设置一级页、开源许可入口下方，不用点进关于页。
			     只有配置了计数服务时才显示；未配置时整块不出现。 -->
			<div v-if="presenceReady" class="settings-presence">
				<span class="about-presence-dot" :class="presenceToneClass" aria-hidden="true"></span>
				此刻在线 <b>{{ presenceCount }}</b><template v-if="presenceToday"> · {{ presenceToday }}</template>
			</div>
			<div v-if="presenceReady" class="settings-presence-hint">{{ presenceStatus }}</div>
			<button v-if="presenceReady && presenceCanRetry" class="mini ripple settings-presence-retry" @click="emit('presenceRetry')">立即重试</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import {BGM_TRACKS, type BgmState} from "../services/bgm"
import {L2D_FPS_OPTIONS} from "../services/live2d/frameCap"
import {UI_FONT_OPTIONS, uiFontPreviewFamily, type UiFontChoice} from "../services/ui-font"
import type {AppSettings} from "../composables/useAppSettings"

defineProps<{
	cfg: AppSettings
	version: string
	modelReady: boolean
	modelOptions: string[]
	modelLoadMsg: string
	renderScaleNum: number
	nativeDpr: number
	bubbleScaleNum: number
	bubbleWidthNum: number
	l2dFpsNum: number
	bgmState: BgmState
	bgmPct: number
	bgmCanSkip: boolean
	bgmNowName: string
	floatPermissionHint: string
	uiFontNow: UiFontChoice
	uiFontHint: string
	personaCustom: boolean
	personaStateText: string
	personaMsg: string
	personaMsgOk: boolean
	personaDlBusy: boolean
	personaDlMsg: string
	personaDlOk: boolean
	backgroundError: string
	storagePath: string
	allFilesAccess: boolean
	storageProbeMsg: string
	memoryCount: number
	hasBackup: boolean
	memPruneMsg: string
	memPruneMsgOk: boolean
	sfxBusy: boolean
	sfxBtnText: string
	sfxMsg: string
	sfxMsgOk: boolean
	sfxMsgBad: boolean
	uiSoft: boolean
	presenceReady: boolean
	presenceToneClass: string
	presenceCount: string
	presenceToday: string
	presenceStatus: string
	presenceCanRetry: boolean
}>()
const settingsTab = defineModel<"basic" | "advanced">("settingsTab", {required: true})
const hitDebug = defineModel<boolean>("hitDebug", {required: true})
const emit = defineEmits<{
	applyRenderScale: []
	clearMemory: []
	downloadSfx: []
	exportAll: []
	importPersona: []
	pruneMemories: []
	requestAllFiles: []
	resetPersona: []
	restoreMemory: []
	storageProbe: []
	introOpen: []
	ambientToggle: []
	backgroundModeChange: []
	bgmDownload: []
	bgmNext: []
	bgmRedownload: []
	bgmVolume: []
	deepseaQualityChange: []
	floatRenderScale: []
	memEntryTap: []
	presenceRetry: []
	presenceToggle: []
	quietModeChange: []
	quietToggle: []
	sfxVolume: []
	openAboutPage: []
	openPersonaGate: []
	persistSettings: []
	refreshModels: []
	resetFloatWindow: []
	retryBackground: []
	saveSettingsNow: []
	toggleUiStyle: []
	bgmToggle: [event: Event]
	bgmTrackChange: [event: Event]
	floatToggle: [event: Event]
	openPanel: [panel: "tts" | "touch" | "memories" | "motion" | "expression"]
	setUiFont: [choice: UiFontChoice]
	setL2dFps: [fps: number]
}>()
const l2dFpsLabel = (v: number): string => (v === 0 ? "不限" : String(v))
</script>

<style lang="less" scoped>
@import "../assets/style/dialog-controls.less";

.settings-shell {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 2px 0 14px;
	container-type: inline-size;
}
.settings-tabs {
	position: sticky;
	top: 0;
	z-index: 3;
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 4px;
	padding: 4px;
	background: var(--px-panel);
	border-bottom: 1px solid var(--line-soft);
}
.settings-tabs button {
	min-height: 38px;
	padding: 7px 10px;
	color: var(--fg-dim);
	font-size: 13px;
	background: transparent;
	border: 1px solid transparent;
	border-radius: var(--ui-radius-ctl);
}
.settings-tabs button.active {
	color: var(--fg);
	font-weight: 650;
	background: rgba(127, 212, 230, 0.12);
	border-color: rgba(127, 212, 230, 0.38);
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.settings-basic-grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	align-items: start;
	gap: 9px;
}
.settings-basic-column { display: contents; }
.settings-basic-group-connection { order: 1; }
.settings-basic-group-persona { order: 2; }
.settings-basic-group-display { order: 3; }
.settings-basic-group-preferences { order: 4; }
.settings-basic-group-touch { order: 5; }
.settings-basic-group-music { order: 6; }
.settings-basic-group-memory { order: 7; }
.settings-basic-group-float { order: 8; }
.settings-basic-group-font { order: 9; }
.settings-basic-group {
	min-width: 0;
	border: 1px solid var(--line-soft);
	border-radius: var(--ui-radius-card);
	background: rgba(13, 25, 44, 0.66);
	overflow: hidden;
}
.settings-basic-group-music { border-top: 2px solid var(--px-amber); }
.settings-basic-heading {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 11px 12px 5px;
}
.settings-basic-heading h3 {
	min-width: 0;
	margin: 0;
	color: var(--fg);
	font-size: 14px;
	font-weight: 650;
}
.settings-basic-heading small {
	flex: 0 1 auto;
	color: var(--fg-dim);
	font-size: 10px;
	text-align: right;
}
.settings-basic-group > .settings-row {
	padding: 9px 12px;
}
.settings-basic-group > .settings-row + .settings-row {
	border-top: 1px solid rgba(148, 163, 184, 0.09);
}
.settings-basic-group > .settings-row input[type=text] { width: 100%; box-sizing: border-box; }
.settings-basic-group .model-pick { min-width: 0; }
.settings-basic-group .model-pick select { min-width: 0; }
@container (min-width: 600px) {
	.settings-basic-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.settings-basic-column {
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 9px;
	}
	.settings-basic-group-font > .settings-row { padding-top: 6px; padding-bottom: 6px; }
	.settings-basic-group-font .hint { display: none; }
}

.settings-overview {
	padding: 4px 4px 2px;
}
.settings-overline {
	font-size: 10px;
	letter-spacing: 1.8px;
	color: var(--accent);
	font-weight: 700;
}
.settings-overview-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-top: 5px;
}
.settings-overview-row > div:first-child {
	min-width: 0;
	flex: 1 1 auto;
}
.settings-overview h2 {
	font-size: 23px;
	line-height: 1.2;
	font-weight: 650;
	letter-spacing: 0.02em;
	color: var(--fg);
}
.settings-overview p {
	margin-top: 4px;
	font-size: 12px;
	line-height: 1.55;
	color: var(--fg-dim);
}
.settings-overview-subtitle {
	font-size: 13px !important;
	color: var(--accent) !important;
	letter-spacing: 0.08em;
}
.settings-overview-quote {
	max-width: 250px;
	font-size: 11px !important;
	line-height: 1.6 !important;
	color: var(--fg-dim) !important;
}
.settings-overview-visual {
	position: relative;
	flex: 0 0 clamp(132px, 34%, 210px);
	height: 150px;
	margin: -28px 0 -20px;
	transform: translateX(-30px);
	overflow: hidden;
	pointer-events: none;
}
.settings-overview-visual img {
	position: absolute;
	inset: 0;
	width: 150%;
	height: 150%;
	object-fit: contain;
	object-position: right center;
	transform: translate(-30%, -8%);
	filter: drop-shadow(0 10px 20px rgba(7, 20, 38, 0.4));
}
.settings-intro-entry {
	width: 100%;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-top: 12px;
	padding: 10px 12px;
	text-align: left;
	background: rgba(127, 212, 230, 0.08);
	border: 1px solid rgba(127, 212, 230, 0.25);
	color: var(--fg);
}
.settings-basic-intro { margin-top: 0; }
.settings-intro-copy {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}
.settings-intro-copy b { font-size: 13px; color: var(--accent); }
.settings-intro-copy small { font-size: 11px; color: var(--fg-dim); }
.settings-entry-arrow { flex: 0 0 auto; color: var(--accent); font-size: 18px; }
.settings-jumps {
	display: flex;
	gap: 6px;
	margin-top: 12px;
	overflow-x: auto;
	padding-bottom: 2px;
	scrollbar-width: none;
}
.settings-jumps::-webkit-scrollbar { display: none; }
.settings-jumps a {
	flex: 0 0 auto;
	padding: 6px 10px;
	border: 1px solid var(--line-soft);
	border-radius: var(--ui-radius-ctl);
	background: rgba(15, 23, 42, 0.42);
	color: var(--fg-2);
	font-size: 11px;
	text-decoration: none;
}
.settings-jumps a:active {
	border-color: var(--accent-strong);
	color: var(--accent);
}
.settings-section {
	margin: 0;
	border: 1px solid var(--line-soft);
	border-radius: var(--ui-radius-card);
	background: linear-gradient(180deg, rgba(19, 34, 57, 0.78), rgba(13, 25, 44, 0.74));
	overflow: hidden;
}
.settings-section > summary {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 12px 13px;
	list-style: none;
	cursor: pointer;
	user-select: none;
}
.settings-section > summary::-webkit-details-marker { display: none; }
.settings-section > summary > span {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}
.settings-section > summary b {
	font-size: 14px;
	font-weight: 650;
	color: var(--fg);
}
.settings-section > summary small {
	font-size: 11px;
	line-height: 1.35;
	color: var(--fg-dim);
}
.settings-section > summary i {
	width: 9px;
	height: 9px;
	flex: 0 0 auto;
	border-right: 1.5px solid var(--accent);
	border-bottom: 1.5px solid var(--accent);
	transform: rotate(45deg) translateY(-2px);
	transition: transform 0.2s ease;
}
.settings-section[open] > summary {
	border-bottom: 1px solid var(--line-soft);
	background: rgba(127, 212, 230, 0.055);
}
.settings-section[open] > summary i {
	transform: rotate(225deg) translate(-1px, -1px);
}
.settings-section-body {
	padding: 1px 12px 10px;
}
.settings-section-body > .settings-row + .settings-row {
	border-top: 1px solid rgba(148, 163, 184, 0.09);
}
.settings-section-body > .settings-row {
	padding-left: 0;
	padding-right: 0;
}
.settings-actions .settings-section-body {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding-top: 9px;
}
.settings-actions .btn:first-child { margin-top: 0; }
.settings-entry-row {
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}
.settings-entry-row > div { min-width: 0; }
.settings-entry-button {
	width: 100%;
	min-width: 0;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 11px 12px;
	text-align: left;
	border-radius: var(--ui-radius-ctl);
	color: var(--accent);
	background: rgba(127, 212, 230, 0.08);
	border-color: rgba(127, 212, 230, 0.32);
	box-shadow: 0 8px 18px rgba(2, 8, 18, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.settings-tts-entry { padding-top: 12px; padding-bottom: 12px; }
.settings-entry-icon {
	width: 28px;
	height: 28px;
	flex: 0 0 auto;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 9px;
	background: rgba(127, 212, 230, 0.14);
	color: var(--accent);
	font-size: 19px;
	line-height: 1;
}
.settings-entry-copy {
	min-width: 0;
	flex: 1 1 auto;
	display: flex;
	flex-direction: column;
	gap: 2px;
}
.settings-entry-copy b { color: var(--fg); font-size: 13px; font-weight: 650; }
.settings-entry-copy small { color: var(--fg-dim); font-size: 11px; line-height: 1.35; }
.settings-entry-arrow { flex: 0 0 auto; color: var(--accent); font-size: 20px; line-height: 1; }
.settings-bottom-actions {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin-top: 2px;
	padding: 12px 10px 2px;
	border-top: 1px solid var(--line-soft);
}
.settings-save-button { width: 100%; }
.settings-license-link {
	width: 100%;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 10px 12px;
	text-align: left;
	background: transparent;
	color: var(--fg-2);
	border-color: var(--line-soft);
}
.settings-license-link > span:first-child {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}
.settings-license-link b { color: var(--accent); font-size: 12px; }
.settings-license-link small { color: var(--fg-dim); font-size: 10px; }
.settings-license-link > span:last-child { flex: 0 0 auto; color: var(--accent); font-size: 17px; }
/* 在线人数（2026-10-23）: 设置一级页底部、开源许可入口下方 */
.settings-presence {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 4px 2px 0;
	font-size: 12px;
	color: var(--fg-2);
	b { color: var(--fg); font-variant-numeric: tabular-nums; }
}
.settings-presence-hint {
	padding: 0 2px;
	font-size: 10.5px;
	line-height: 1.5;
	text-align: center;
	color: var(--fg-dim);
	word-break: break-all;
}
.settings-presence-retry { align-self: center; }

.pomo-range { display: flex; gap: 6px; margin: 2px 0 6px }

.pomo-rbtn {
	min-height:44px;
	flex: 1;
	padding: 6px 0;
	border-radius: var(--ui-radius-card);
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: var(--px-grey);
	font-size: 12px;
	&.on { background: var(--px-cyan-deep); border-color: var(--px-cyan); color: var(--px-white) }
	&.all { flex: 0 0 auto; padding: 6px 12px; color: var(--accent) }
}

.settings-row {
	padding: 10px 2px;
	display: flex; flex-direction: column; gap: 6px;
	label { font-size: 13px; color: var(--fg-2); }
	/* 数字输入 (专注/休息分钟) 必须一并覆盖: 只写 text/password 时 number 会落回
	   WebView 的默认白底, 在深色面板上非常刺眼. 尖角数字箭头同样用 appearance 去掉. */
	input[type=text], input[type=password], input[type=number] {
		background: rgba(30, 41, 59, 0.9);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-ctl);
		padding: 10px 12px;
		color: var(--fg);
		font-size: 14px;
		outline: none;
	}
	input[type=number] { -webkit-appearance: none; appearance: textfield; }
	/* select 同样要显式覆盖: 原先只给了 .field select, 而番茄/设置/悬浮窗面板的下拉都在
	   .settings-row > .row-inline 里, 没被覆盖 → 落回 WebView 默认白底。
	   (所有 .row-inline 都在 .settings-row 内, 故这一条即可全覆盖) */
	select {
		background: rgba(30, 41, 59, 0.9);
		color: var(--fg);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-ctl);
		padding: 10px 12px;
		font-size: 14px;
	}
	input[type=range] { width: 100%; accent-color: var(--accent-strong); }
}

.row-inline {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	label { font-size: 13px; color: var(--fg-2); flex: 1; }
	input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent-strong); flex-shrink: 0; }
}

.model-pick { display: flex; gap: 8px; align-items: center; }

.model-pick select {
	flex: 1;
	background: rgba(30, 41, 59, 0.9);
	color: var(--fg);
	border: 1px solid var(--line-strong);
	border-radius: var(--ui-radius-ctl);
	padding: 10px;
	font-size: 14px;
}

.label-only {
	label { font-size: 13px; color: var(--fg-2); font-weight: 600; }
}

.label-only + .hint { line-height: 1.7; }

.mem-block {
	margin-top: 6px;
	padding: 6px 8px 8px;
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	background: color-mix(in srgb, var(--px-panel-2) 55%, transparent);
}

.mem-enter {
	width: 100%;
	text-align: left;
	padding: 9px 10px;
	background: rgba(56, 189, 248, 0.10);
	border: 1px solid rgba(56, 189, 248, 0.28);
	border-radius: var(--ui-radius-ctl);
	color: var(--accent);
	font-size: 12px;
}

.store-probe {
	margin: 6px 0 0;
	padding: 8px 10px;
	background: var(--px-void);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	font-size: 11px; line-height: 1.6;
	color: var(--px-cyan);
	white-space: pre;
	overflow-x: auto;
	max-height: 46vh; overflow-y: auto;
	-webkit-overflow-scrolling: touch;
}

.bgm-toggle {
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--fg);
	font-size: 13px;
}

.about-open {
	width: 100%; text-align: left;
	background: transparent; color: var(--accent);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
}

.about-presence-dot {
	width: 7px; height: 7px; border-radius: 50%;
	background: #64748b; flex: none;
	&.live { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.7); }
	&.stale { background: #fbbf24; }
	&.off { background: #64748b; }
}

.intro-open { color: var(--accent); }

.btn {
	width: 100%; margin-top: 10px;
	padding: 12px; border-radius: var(--ui-radius-ctl);
	position: relative; overflow: hidden;
	background: var(--px-panel-2);
	color: var(--px-white); font-size: 14px;
	border: var(--ui-line-w) solid var(--ui-line-c);
	/* 像素凸起 (网页版 .pixel-btn-primary 同款配方):
	   亮上左 + 暗下右 + 硬投影, 按下时反转 —— 这是"能一眼看出换了风格"的关键 */
	box-shadow: inset 2px 2px 0 0 var(--ui-hi), inset -2px -2px 0 0 var(--ui-lo), 0 var(--ui-lift) 0 0 var(--ui-lo), var(--ui-shadow);
	&:active {
		transform: translateY(2px);
		box-shadow: var(--ui-press), 0 calc(var(--ui-lift) / 2) 0 0 var(--ui-lo);
	}
}

.btn-row {
	display: flex;
	gap: 8px;
	.btn { flex: 1; width: auto; margin-top: 0; }
}

.btn-row.mem-btns { flex-wrap: wrap; }

.btn-row.mem-btns .mini { flex: 1 1 auto; text-align: center; }

.settings-tide .settings-section {
	background: linear-gradient(155deg, rgba(24, 51, 69, 0.72), rgba(10, 27, 44, 0.72));
	border-color: rgba(127, 212, 230, 0.16);
}

.settings-tide .settings-entry-button {
	background: linear-gradient(105deg, rgba(127, 212, 230, 0.18), rgba(126, 224, 194, 0.1));
	border-color: rgba(127, 212, 230, 0.34);
}
</style>
