<template>
	<div
		class="stage-root"
		:class="uiSoft ? 'ui-soft' : 'ui-pixel'"
		@touchstart.passive="onTouchStart"
		@touchmove.passive="onTouchMove"
		@touchend.passive="onTouchEnd"
		@touchcancel.passive="onTouchEnd"
	>
		
		<div ref="rippleHost" class="ripple-host"></div>

		<!-- 手指触摸追踪: 半透明磨砂小白点跟随手指 -->
		<div ref="touchDotHost" class="touch-dot-host"></div>

		<!-- 数据海动态背景 (纯程序渲染): 星尘/星云漂移/网格, 位于 Live2D 之下 -->
		<canvas ref="dataseaCanvas" class="datasea-bg" v-show="cfg.dataseaBg"></canvas>

		<!-- 命中区域调试显示 (测试用): 实时显示当前触摸命中的区域 + 抚摸进度/完成次数 -->
		<div v-if="hitDebug && hitZoneText" class="hit-debug">命中：{{ hitZoneText }}<span v-if="petDebugText"> ｜ {{ petDebugText }}</span></div>

		<!-- 番茄钟悬浮窗 (拖拽移动 / 右下角缩放 / 可折叠; 组件根截断 pointer 事件, 不惊动摸头与双指手势) -->
		<div v-if="pomoWidgetOn && pomo.phase !== 'idle'" class="pomo-widget" :class="{mini: pomoMini}" :style="{left: pomoPos.x + 'px', top: pomoPos.y + 'px', width: pomoPos.w + 'px'}" @pointerdown.stop>
			<template v-if="!pomoMini">
				<div class="pw-head" @pointerdown="onPomoDragDown" @pointermove="onPomoDragMove" @pointerup="onPomoDragUp" @pointercancel="onPomoDragUp">
					<span class="pw-tomato">🍅</span><span>{{ pomoPhaseText }}</span>
					<button class="pw-mini-btn" title="收起" @click="pomoMini = true; pomoPosSave()">—</button>
				</div>
				<div class="pw-time">{{ pomoFmt }}</div>
				<div class="pw-bar"><i :style="{width: pomoPct + '%'}"></i></div>
				<div class="pw-btns">
					<button @click="pomoPauseBtn">{{ pomo.paused ? '继续' : '暂停' }}</button>
					<button class="warn" @click="pomoStopBtn">{{ pomo.phase === 'break' ? '跳过' : '放弃' }}</button>
				</div>
				<i class="pw-grip" @pointerdown="onPomoRzDown" @pointermove="onPomoRzMove" @pointerup="onPomoRzUp" @pointercancel="onPomoRzUp"></i>
			</template>
			<template v-else>
				<button class="pw-pill" @click="pomoMini = false; pomoPosSave()">🍅 {{ pomoFmt }}</button>
			</template>
		</div>


		
		<div ref="l2dHost" class="l2d-host"></div>

		
		<transition name="fade">
			<div v-if="touchBubble" class="touch-bubble">{{ touchBubble }}</div>
		</transition>

		
		<transition name="ai">
			<div v-if="aiBubble" class="ai-bubble">
				<div class="ai-bubble-head"><span class="ai-bubble-dot"></span>Nori</div>
				<div class="ai-bubble-txt">{{ aiBubble }}</div>
			</div>
		</transition>

		<div class="topbar" v-show="panel !== 'touch' && panel !== 'tts'">
			<div class="tag" @click="panel = panel === 'model' ? '' : 'model'">{{ currentModel?.name ?? "—" }}</div>
			<div v-if="error" class="err" @click="error = ''">{{ error }} ✕</div>
			<div v-else-if="loading" class="loading">{{ loadingMsg }}</div>
		</div>

		
		<transition name="chat">
			<div v-if="chatOpen" class="chat-panel">
				<div class="chat-head">
					<span class="chat-title">对话 · {{ curModelName }}</span>
					<button v-if="chatStreaming || touchStreaming" class="x stop" @click="stopGenerate">■ 停止生成</button>
					<button v-if="speaking" class="x stop" @click="stopTTS()">■ 停止</button>
					<button class="x" @click="chatOpen = false">✕</button>
				</div>
				<div ref="chatScroll" class="chat-msgs" :style="{ fontSize: chatFontPX, '--bubble-w': bubbleWidthNum + '%' }">
					<div v-if="!messages.length" class="chat-empty">和我说点什么吧</div>
					<div
						v-for="m in messages"
						:key="msgKey(m)"
						class="bubble-wrap"
						:class="m.role"
					>
						<!-- 存储/历史: 一条消息; 显示: assistant 按句拆多气泡, user 保持整条 -->
						<div
							v-for="(seg, j) in (m.role === 'assistant' ? bubbleSegments(m.content) : [m.content])"
							:key="j"
							class="bubble"
						>{{ bubbleText(seg) }}</div>
					</div>
					<div v-if="typing && !chatStreaming" class="bubble-wrap assistant"><div class="bubble typing sea-dots"><span></span><span></span><span></span></div></div>
				</div>
				<div v-if="pendingQueue.length" class="queue-hint">已排队 {{ pendingQueue.length }} 条</div>
				<div class="chat-input">
					<input
						v-model="draft"
						:placeholder="modelReady ? '输入消息…' : '请先在设置里配置 API Key 和模型'"
						@keydown.enter="send"
					/>
					<button class="send" @click="send" :disabled="!draft.trim()">发送</button>
				</div>
			</div>
		</transition>

		<div class="dock" v-show="panel !== 'touch' && panel !== 'tts'" @pointerdown="onDockPress">
			<button class="fab ripple" @click="openDiary">
				<img class="fab-ico" :src="DOCK_ICONS.diary" alt="" draggable="false" />
				<span class="fab-label">日记</span>
			</button>
			<button class="fab ripple" @click="openPanel('model')">
				<img class="fab-ico" :src="DOCK_ICONS.model" alt="" draggable="false" />
				<span class="fab-label">模型</span>
			</button>
			<button class="fab ripple" @click="openPanel('touch')">
				<img class="fab-ico" :src="DOCK_ICONS.touch" alt="" draggable="false" />
				<span class="fab-label">触摸</span>
			</button>
			<button class="fab ripple" @click="openPanel('pomo')">
				<img class="fab-ico" :src="DOCK_ICONS.pomo" alt="" draggable="false" />
				<span class="fab-label">番茄</span>
			</button>
			<button class="fab ripple" @click="openPanel('settings')">
				<img class="fab-ico" :src="DOCK_ICONS.settings" alt="" draggable="false" />
				<span class="fab-label">设置</span>
			</button>
			<button class="fab ripple" @click="toggleChat">
				<img class="fab-ico" :src="DOCK_ICONS.chat" alt="" draggable="false" />
				<span class="fab-label">对话</span>
			</button>
		</div>

		
		<Transition name="fade">
		<div v-if="panel === 'touch'" class="touch-page">
			
			<div class="touch-overlay" :class="{drawing: touchDrawing}">
				<div v-for="(t, i) in touchAreas" :key="t.id" class="touch-area-box" :class="t.type" :style="[boxStyle(t), {zIndex: i + 1}]">
					<span class="ba-name">{{ t.name }}</span>
				</div>
				<div v-if="touchDraft" class="touch-area-box draft" :style="boxStyle(touchDraft)"></div>
			</div>
			
			<div class="touch-top">
				<span class="touch-title">自定义触摸</span>
				<button class="x" @click="panel = ''">✕</button>
			</div>
			
			<div class="touch-editor">
				<TouchManager
					:touches="touchAreas"
					:drawing="touchDrawing"
					:adjusting="touchAdjusting"
					:has-draft="draftReady"
					@toggle-draw="toggleTouchDraw"
					@toggle-adjust="toggleTouchAdjust"
					@add="onTouchAdd"
					@update="onTouchUpdate"
					@remove="onTouchRemove"
					@reset-draft="resetTouchDraft"
				/>
			</div>
		</div>
		</Transition>

		<Transition name="fade">
		<div v-if="panel === 'tts'" class="tts-page">
			<div class="tts-top">
				<span class="tts-title">语音合成</span>
				<button class="x" @click="panel = ''">✕</button>
			</div>
			<div class="tts-body">
				<div class="tts-sec">
					<div class="tts-sec-title">开关</div>
					<div class="field row-inline">
						<label>启用语音朗读</label>
						<input type="checkbox" v-model="cfg.ttsEnabled" />
					</div>
					<div class="field">
						<label>提供商</label>
						<div class="voice-pick">
							<select v-model="cfg.ttsProvider">
								<option value="fish">Fish Audio</option>
								<option value="cosyvoice">千问 CosyVoice</option>
							</select>
						</div>
						<div class="hint">切换后各自配置独立保存, 互不影响</div>
					</div>
					<div class="field">
						<label>朗读音量 {{ Math.round((Number(cfg.ttsVolume) || 0) * 100) }}%（应用内，不影响系统音量）</label>
						<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.ttsVolume" @input="applyTtsVolume" @change="persistSettings" />
						<div class="hint">只调整 Nori 说话的音量，手机铃声/媒体音量不受影响</div>
					</div>
					<div class="hint">开启后, Nori 的每句回复都会流式朗读</div>
				</div>

				<template v-if="cfg.ttsProvider === 'fish'">
				<div class="tts-sec">
					<div class="tts-sec-title">账户配置</div>
					<div class="field">
						<label>Fish Audio API Key</label>
						<input v-model="cfg.ttsApiKey" type="text" autocomplete="off" spellcheck="false" placeholder="在 fish.audio 控制台获取 (sk-...)" />
					</div>
					<div class="field">
						<label>API Base URL</label>
						<input v-model="cfg.ttsBaseUrl" type="text" autocomplete="off" spellcheck="false" />
					</div>
				</div>

				<div class="tts-sec">
					<div class="tts-sec-title">音色与参数</div>
					<div class="field">
						<label>音色（可选）</label>
						<div class="voice-pick">
							<select v-model="cfg.ttsReferenceId">
								<option value="">默认音色</option>
								<option v-for="v in voiceOptions" :key="v.id" :value="v.id">{{ v.title }}</option>
							</select>
							<button class="mini ripple" :disabled="voicesLoading" @click="loadVoices">{{ voicesLoading ? "加载中…" : "加载音色" }}</button>
						</div>
						<input v-model="cfg.ttsReferenceId" type="text" autocomplete="off" spellcheck="false" placeholder="或手动输入 Reference ID, 留空用默认音色" />
						<div v-if="voicesMsg" class="hint" :class="{ok: voicesMsgOk, bad: !voicesMsgOk}">{{ voicesMsg }}</div>
					</div>
					<div class="field">
						<label>模型</label>
						<select v-model="cfg.ttsModel">
							<option v-for="md in FISH_MODELS" :key="md" :value="md">{{ md }}</option>
						</select>
					</div>
					<div class="field">
						<label>音频格式</label>
						<select v-model="cfg.ttsFormat">
							<option v-for="f in FISH_FORMATS" :key="f" :value="f">{{ f }}</option>
						</select>
						<div class="hint">mp3 兼容性最好; pcm 延迟最低</div>
					</div>
					<div class="field">
						<label>分块长度 {{ cfg.ttsChunkLength }}</label>
						<input type="range" min="100" max="500" step="50" v-model.number="cfg.ttsChunkLength" />
						<div class="hint">越小首音越快、块数越多</div>
					</div>
					<div class="field">
						<label>延迟模式</label>
						<select v-model="cfg.ttsLatency">
							<option v-for="l in FISH_LATENCIES" :key="l" :value="l">{{ l }}</option>
						</select>
					</div>
				</div>
				</template>

				<template v-else>
				<div class="tts-sec">
					<div class="tts-sec-title">千问 CosyVoice 配置</div>
					<div class="field">
						<label>千问/百炼 API Key</label>
						<input v-model="cfg.cosyApiKey" type="text" autocomplete="off" spellcheck="false" placeholder="在百炼控制台获取 (sk-...)" />
					</div>
					<div class="field">
						<label>API Base URL</label>
						<input v-model="cfg.cosyBaseUrl" type="text" autocomplete="off" spellcheck="false" placeholder="https://dashscope.aliyuncs.com 或北京专属域名" />
					</div>
					<div class="field">
						<label>模型</label>
						<select v-model="cfg.cosyModel">
							<option v-for="md in COSY_MODELS" :key="md" :value="md">{{ md }}</option>
						</select>
					</div>
					<div class="field">
						<label>音色</label>
						<div class="voice-pick">
							<select v-model="cfg.cosyVoice">
								<option v-if="!cfg.cosyCloneVoices.length" value="">暂无克隆音色，先克隆一个</option>
								<option v-for="v in cfg.cosyCloneVoices" :key="v.id" :value="v.id">{{ v.model ? `${v.model} · ${v.id}` : v.id }}{{ v.model && v.model !== cfg.cosyModel ? "（当前模型不可用）" : "" }}</option>
							</select>
						</div>
						<input v-model="cfg.cosyVoice" type="text" autocomplete="off" spellcheck="false" placeholder="或手动输入音色 id" />
						<div v-if="cosyVoiceHint" class="hint bad">{{ cosyVoiceHint }}</div>
					</div>
					<div class="field">
						<label>语速 {{ Number(cfg.cosyRate).toFixed(1) }}x</label>
						<input type="range" min="0.5" max="2" step="0.1" v-model.number="cfg.cosyRate" />
					</div>
					<div class="tts-sec-title">声音克隆</div>
					<div class="field">
						<label>克隆音色前缀 (字母数字)</label>
						<input v-model="clonePrefix" type="text" autocomplete="off" spellcheck="false" placeholder="如 myvoice" />
					</div>
					<!-- 一键克隆（2026-10-01）: 参考音频**联网下载**（不再打进 APK），省掉"自己找一段 10~20 秒干音"这一步 -->
					<div class="field">
						<label>一键克隆（预设参考音频）</label>
						<button class="btn ripple primary" :disabled="cloneCreating" @click="openCloneGate">
							{{ cloneCreating ? "下载/创建中…" : "一键克隆预设音色" }}
						</button>
						<div class="hint">点按钮后会先**联网下载**一段 12.5 秒的参考音频（首次约 3.4MB，之后走本地缓存），再由千问创建音色；需先答对「模型授权验证」的问题。⚠ 下载源在国内可能直连不了，**可能需要魔法**。</div>
					</div>
					<div class="btn-row">
						<button class="btn ripple" :disabled="clonePicking" @click="doPickVoice">{{ clonePicking ? "选择中…" : (cloneFileName || "选择音频文件") }}</button>
						<button class="btn ripple primary" :disabled="!cloneFileName || cloneCreating" @click="doCreateClone">{{ cloneCreating ? "创建中…" : "创建克隆音色" }}</button>
					</div>
					<div class="hint">建议音频：10~20 秒，≤10MB，WAV/MP3/M4A，无背景音乐</div>
					<div v-if="cloneFileName" class="hint">已选: {{ cloneFileName }}{{ cloneFileSize ? ` (${fmtSize(cloneFileSize)})` : "" }}</div>
					<div v-if="cloneMsg" class="hint" :class="{ok: cloneMsgOk, bad: !cloneMsgOk}">{{ cloneMsg }}</div>
					<div v-if="cloneStatusText" class="hint" :class="{ok: cloneStatusOk, bad: !cloneStatusOk}">{{ cloneStatusText }}</div>
					<div class="tts-sec-title">余额查询</div>
					<div class="bal-grid">
						<div class="bal-item">
							<div class="bal-name">千问 CosyVoice</div>
							<div class="bal-value" :class="{loading: balCosyLoading}">{{ balCosyLoading ? "查询中…" : (balCosy || "未查询") }}</div>
						</div>
						<div class="bal-item">
							<div class="bal-name">DeepSeek</div>
							<div class="bal-value" :class="{loading: balDsLoading}">{{ balDsLoading ? "查询中…" : (balDs || "未查询") }}</div>
						</div>
					</div>
					<div class="bal-btns">
						<button class="mini ripple" :disabled="balCosyLoading" @click="queryCosyBalance">查询千问余额</button>
						<button class="mini ripple" :disabled="balDsLoading" @click="queryDeepSeekBalance">查询 DeepSeek</button>
					</div>
					<div class="hint">千问/DashScope 官方未开放余额查询接口，若提示不可用请到千问控制台账单页查看</div>
					<div v-if="balMsg" class="hint" :class="{ok: balMsgOk, bad: !balMsgOk}">{{ balMsg }}</div>
				</div>
				</template>

				<div class="tts-sec" v-if="cfg.ttsProvider === 'fish'">
					<div class="tts-sec-title">余额查询</div>
					<div class="bal-grid">
						<div class="bal-item">
							<div class="bal-name">Fish Audio</div>
							<div class="bal-value" :class="{loading: balFishLoading}">{{ balFishLoading ? "查询中…" : (balFish || "未查询") }}</div>
						</div>
						<div class="bal-item">
							<div class="bal-name">DeepSeek</div>
							<div class="bal-value" :class="{loading: balDsLoading}">{{ balDsLoading ? "查询中…" : (balDs || "未查询") }}</div>
						</div>
					</div>
					<div class="bal-btns">
						<button class="mini ripple" :disabled="balFishLoading" @click="queryFishBalance">查询 Fish Audio</button>
						<button class="mini ripple" :disabled="balDsLoading" @click="queryDeepSeekBalance">查询 DeepSeek</button>
					</div>
					<div class="hint">Fish Audio 用上面账户配置; DeepSeek 用聊天设置里的 API Key</div>
					<div v-if="balMsg" class="hint" :class="{ok: balMsgOk, bad: !balMsgOk}">{{ balMsg }}</div>
				</div>

				<div class="tts-sec">
					<div class="tts-sec-title">操作</div>
					<div class="btn-row">
						<button class="btn ripple" :disabled="ttsTesting" @click="doTestTTS">{{ ttsTesting ? "测试中…" : "测试并试听" }}</button>
						<button class="btn ripple" v-if="speaking" @click="stopTTS()">停止朗读</button>
					</div>
					<button class="btn ripple primary" @click="saveSettingsNow">保存设置</button>
					<div v-if="ttsMsg" class="hint" :class="{ok: ttsMsgOk, bad: !ttsMsgOk}">{{ ttsMsg }}</div>
				</div>
			</div>
		</div>
		</Transition>

		<transition name="sheet">
			<div v-if="panel && panel !== 'touch' && panel !== 'tts'" class="sheet-mask" @click.self="panel = ''">
				<div class="sheet">
					<div class="sheet-head">
						<span class="sheet-title">{{ panelTitle(panel) }}</span>
						<button class="x" @click="panel = ''">✕</button>
					</div>
					<div class="sheet-body">
						
						<template v-if="panel === 'model'">
							<div v-if="listError" class="empty">{{ listError }}</div>
							<div v-else-if="!modelList.length" class="empty">正在获取模型列表…</div>
							<div v-else class="grid">
								<div v-for="m in modelList" :key="m.id" class="mc" :class="{on: m.id === currentModelId}" @click="pick(m.id)">
									<div class="thumb"><img :src="coverUrl(m.id)" @error="hideThumb" /></div>
									<div class="mname">{{ m.name }}</div>
								</div>
							</div>
						</template>

						
						<template v-else-if="panel === 'motion'">
							<div v-if="!motions.length" class="empty">暂无动作</div>
							<div v-for="g in motions" :key="g.group" class="grp">
								<div class="grp-name">{{ g.group }}</div>
								<div class="chips">
									<button v-for="(n, i) in g.names" :key="n" class="chip ripple" @click="doMotion(g.group, i)">{{ n }}</button>
								</div>
							</div>
						</template>

						
						<template v-else-if="panel === 'expression'">
							<div v-if="!expressions.length" class="empty">暂无表情</div>
							<div class="chips">
								<button class="chip w ripple" @click="l2d.stopExpression()">清除</button>
								<button v-for="n in expressions" :key="n" class="chip ripple" @click="l2d.playExpression(n)">{{ n }}</button>
							</div>
						</template>

						
						<!-- Nori 心情日记 (按日历天数查看, 可删除) -->
						<template v-else-if="panel === 'diary'">
							<div class="diary-head">
								<span class="hint">Nori 每天把和你的互动写成日记。今天还没写的话，明天打开就能看到</span>
								<div class="diary-head-btns">
									<button class="mini ripple" @click="doRefreshDiary" :disabled="diaryBusy">{{ diaryBusy ? "正在写…" : "立即写今天" }}</button>
									<button class="mini ripple" @click="doExportDiary">导出日记</button>
								</div>
							</div>
							<div class="diary-cal">
								<div class="diary-cal-head">
									<button class="mini ripple" @click="calMove(-1)">‹</button>
									<span class="diary-cal-title">{{ calYear }} 年 {{ calMonth + 1 }} 月</span>
									<button class="mini ripple" @click="calMove(1)">›</button>
								</div>
								<div class="cal-week">
									<span v-for="w in CAL_WEEKDAYS" :key="w">{{ w }}</span>
								</div>
								<div class="cal-grid">
									<template v-for="(cell, i) in calGrid" :key="i">
										<div v-if="!cell" class="cal-cell blank"></div>
										<div v-else class="cal-cell" :class="{has: !!diaryByDate[cell], sel: cell === calSelDate, today: cell === todayStr}" @click="calSelDate = cell">
											<span class="cal-day-num">{{ Number(cell.slice(8)) }}</span>
											<span v-if="diaryByDate[cell]" class="cal-dot" :class="'mood-' + moodKey(diaryByDate[cell].mood)"></span>
										</div>
									</template>
								</div>
							</div>
							<div class="diary-detail">
								<div v-if="!diaryByDate[calSelDate]" class="hint">
									这一天没有日记{{ calSelDate === todayStr ? "（聊过天明天打开就会写）" : "" }}
								</div>
								<div v-else class="diary-item">
									<div class="diary-date">
										<span class="diary-mood" :class="'mood-' + moodKey(diaryByDate[calSelDate].mood)">{{ diaryByDate[calSelDate].mood }}</span>
										<span>{{ calSelDate }}</span>
										<span v-if="diaryByDate[calSelDate].msgCount > 0" class="diary-count">聊了 {{ diaryByDate[calSelDate].msgCount }} 句</span>
										<button class="mini ripple diary-del" @click="doDeleteDiary(calSelDate)">删除这天</button>
									</div>
									<div class="diary-content">{{ diaryByDate[calSelDate].content }}</div>
								</div>
							</div>
							<div v-if="!Object.keys(diaryByDate).length" class="empty">还没有日记。多和 Nori 聊聊，明天她就会写啦</div>
						</template>

						
						<!-- 记忆库 (二级菜单: 目标 / 长期记忆 / 历史总结 三份内容都收在这里) -->
						<template v-else-if="panel === 'memories'">
							<!-- C: 顶部统计行 —— 一眼看到"有没有作废/收起/删除的条目"(用户两次没找到入口, 用这个解决可发现性) -->
							<div class="mem-stats">
								长期 {{ nonGoalMemories.length }} · 目标 {{ goals.length }} · 已作废 {{ invalidMems.length }} · 已收起 {{ fadedMems.length }} · 已删除 {{ deletedMems.length }}
							</div>
							<div v-if="!memSearch && !memFilter">
								<!-- 陪着你的事（目标）—— 从一级设置页搬进来 -->
								<div class="mem-sec">
									<div class="mem-sec-title">陪着你的事（目标）<template v-if="goals.length">（{{ goals.length }}）</template></div>
									<div v-if="!goals.length" class="hint">记下一个目标，Nori 每隔几天会自然地问问进展</div>
									<div v-for="g in goals" :key="g.id" class="mem-item">
										<span class="mem-tag src" :class="{inferred: isInferred(g)}" :title="PROV_TIP">{{ memProvenance(g) }}</span>
										<span class="mem-text">🎯 {{ g.content }}</span>
										<button class="mem-op" @click="doRemoveGoal(g.id)">删除</button>
									</div>
									<div class="goal-add">
										<input v-model="goalDraft" placeholder="如：考雅思 7 分 / 坚持跑步" spellcheck="false" @keyup.enter="doAddGoal" />
										<button class="mini ripple" @click="doAddGoal">记下目标</button>
									</div>
								</div>
								<!-- 历史总结 —— 同样从一级页搬进来 -->
								<div class="mem-sec">
									<div class="mem-sec-title">历史总结（{{ memView.summaries.length }} 条）</div>
									<div v-if="!memView.summaries.length" class="hint">
										暂无总结。对话多了之后会自动把早期对话压缩成摘要
									</div>
									<details v-for="s in memView.summaries" :key="s.id" class="mem-summary">
										<summary>{{ summaryLabel(s) }}</summary>
										<div class="mem-summary-content">{{ s.content }}</div>
									</details>
								</div>
							</div>
							<div class="mem-search-row">
								<input v-model="memSearch" class="mem-search-input" placeholder="搜索记忆内容…" spellcheck="false" />
								<select v-model="memFilter" class="mem-search-sel">
									<option value="">全部类型</option>
									<option value="goal">🎯 目标</option>
									<option v-for="(lb, k) in TYPE_LABELS" :key="k" :value="k">{{ lb }}</option>
									<option value="pinned">📌 已固定</option>
								</select>
							</div>
							<div class="mem-count-hint">长期记忆 {{ filteredMems.length }} 条<template v-if="memSearch || memFilter">（筛选结果）</template></div>
							<!-- 「待整理 N 条」(P4): 让"还没进记忆"这件事可见 —— 否则用户说完一句
							     会以为没记住 (实时通道默认关之后尤其需要这个交代)。
							     A+B (2026-09-27 深夜, 实机反馈"点了没用"): 反馈**就地**显示在按钮旁边;
							     没有可整理内容时按钮置灰 + 文案说清, 不再"可点但无事发生"。 -->
							<div class="mem-pending">
								<span v-if="memPending.pending > 0">待整理 {{ memPending.pending }} 条（满 {{ memPending.threshold }} 条自动整理）</span>
								<span v-else>待整理 0 条 · 最近 20 句还在我眼前，攒够 25 句会自动整理</span>
								<button class="mini ripple" :disabled="memOrganizing || !canOrganize" @click="doOrganizeNow">{{ memOrganizing ? "整理中…" : (canOrganize ? "立即整理" : "暂无可整理") }}</button>
							</div>
							<div v-if="memOrgMsg" class="hint mem-org-msg" :class="{ok: memOrgMsgOk, bad: !memOrgMsgOk}">{{ memOrgMsg }}</div>
							<div v-if="!filteredMems.length" class="empty">没有匹配的记忆</div>
							<!-- 记忆库主视图 (P4): **按块**排时间线 (一次历史总结覆盖的一段对话 = 一个块),
							     块内再**按类型分小节** —— 上半句是块, 下半句沿用用户要的类型分组。
							     搜索/筛选时退回按类型平铺 (见 memSections) -->
							<div v-for="sec in memSections" :key="sec.key" class="mem-sec" :class="{ 'mem-block': sec.key !== 'flat' }">
								<div v-if="sec.title" class="mem-sec-title">{{ sec.title }}</div>
								<div v-for="sub in sec.subs" :key="sub.key" class="mem-sec mem-group">
									<div class="mem-sec-title sub">{{ sub.label }}（{{ sub.items.length }}）</div>
									<div v-for="m in sub.items" :key="m.id" class="mem-item">
										<span class="mem-tag src" :class="{inferred: isInferred(m)}" :title="PROV_TIP">{{ memProvenance(m) }}</span>
										<span class="mem-text">
											<span v-if="(m.tags ?? []).includes('goal')" class="mem-ico" title="目标">🎯</span>
											<span v-if="(m.tags ?? []).includes('pinned')" class="mem-ico" title="已固定">📌</span>
											{{ m.content }}
										</span>
										<span class="mem-sub">{{ fmtTs(m.createdAt) }} · 重要度 {{ m.importance.toFixed(2) }}<template v-if="m.decayDays == null"> · 不淡忘</template></span>
										<button class="mem-op" @click="doTogglePin(m)">{{ isPinnedId(m.id) ? "取消固定" : "固定" }}</button>
										<button class="mem-op" title="先收起来：不删除，随时能「留下」放回；再说起它会自己回来" @click="doFadeMemory(m)">收起</button>
										<button class="mem-op danger" @click="doDeleteMemory(m)">删除</button>
									</div>
								</div>
							</div>
							<!-- 已作废的记忆 (B1 记忆纠正): 被后来说的话取代的旧说法不再注入/召回,
							     但留在库里存档, 点开就能还原 —— 判错的代价从"永久丢"降到"点一下"。
							     C: 没有作废条时也留一行灰字提示, 让这个功能**可见** (否则用户找不到)。 -->
							<details v-if="invalidMems.length && !memSearch && !memFilter" class="mem-sec mem-invalid">
								<summary class="mem-sec-title">已作废（{{ invalidMems.length }}）</summary>
								<div class="hint">这些旧说法已被你后来的话取代，Nori 不会再用；判错了就点「还原」</div>
								<div v-for="m in invalidMems" :key="m.id" class="mem-item">
									<span class="mem-text">{{ m.content }}</span>
									<span class="mem-sub">作废于 {{ fmtTs(m.invalidAt ?? 0) }}</span>
									<button class="mem-op" @click="doRestoreInvalid(m)">还原</button>
								</div>
							</details>
							<!-- C: 空态也留一行, 让"改口会进历史"这件事可见 -->
							<div v-else-if="!memSearch && !memFilter" class="mem-invalid-empty">
								已作废（0）· 你改口时旧说法会留在这里，随时能还原
							</div>
							<!-- 已收起 (2026-09-28, 用户的"暂时收起"): 到期/太久没提的条目自动收在这里。
							     与「已作废」的区别: 作废=被新说法取代; 收起=不再重要, 但它**可能还是真的**。
							     不注入、不召回, 但点「留下」就能放回生效 —— 自动路径永不真删。 -->
							<details v-if="fadedMems.length && !memSearch && !memFilter" class="mem-sec mem-faded">
								<summary class="mem-sec-title">已收起（{{ fadedMems.length }}）</summary>
								<div class="hint">这些是太久没提或到期自动收起来的（不是被推翻）。点「留下」就放回生效；再说一次这个话题它也会自己回来</div>
								<div v-for="m in fadedMems" :key="m.id" class="mem-item">
									<span class="mem-text">{{ m.content }}</span>
									<span class="mem-sub">{{ fadeReasonLabel(m) }} · 收起于 {{ fmtTs(m.fadedAt ?? 0) }}</span>
									<button class="mem-op" @click="doRestoreFaded(m)">留下</button>
								</div>
							</details>
							<!-- 已删除 (2026-09-28, 回收站): 手删的条目带内容留在这里, 可还原; 确认不要再「永久删除」 -->
							<details v-if="deletedMems.length && !memSearch && !memFilter" class="mem-sec mem-deleted">
								<summary class="mem-sec-title">已删除（{{ deletedMems.length }}）</summary>
								<div class="hint">你删掉的记忆会先放这里（最多留 20 条），点「还原」能救回来；确认不要了就「永久删除」</div>
								<div v-for="m in deletedMems" :key="m.id" class="mem-item">
									<span class="mem-text">{{ m.content }}</span>
									<span class="mem-sub">删除于 {{ fmtTs(m.deletedAt ?? 0) }}</span>
									<button class="mem-op" @click="doRestoreDeleted(m)">还原</button>
									<button class="mem-op danger" @click="doDeleteForever(m)">永久删除</button>
								</div>
							</details>
							<!-- 记忆优化 (2026-09-28, 用户提的"整理优化"): 从**你留下的/删掉的**记忆里学口味,
							     把示例写进整理提示词。默认关 —— 早期库里若有垃圾, 学进去会把风味固化。 -->
							<div v-if="!memSearch && !memFilter" class="mem-sec mem-tune">
								<div class="mem-sec-title">记忆优化</div>
								<div class="row-inline">
									<label>自动优化（每新增 20 条记忆刷新示例）</label>
									<input type="checkbox" v-model="cfg.memoryAutoTuneExamples" />
								</div>
								<div class="hint">{{ tuneInfo }}</div>
								<div class="btn-row mem-tune-btns">
									<button class="mini ripple" @click="doRebuildExamples">立即优化</button>
									<button class="mini ripple" @click="tuneShow = !tuneShow">{{ tuneShow ? "收起示例" : "查看示例" }}</button>
									<button class="mini ripple" :disabled="!tuneHas" @click="doClearExamples">清除示例</button>
								</div>
								<div v-if="tuneShow && tuneHas" class="hint mem-tune-detail">
									<div v-if="tunePos.length">该记：{{ tunePos.join(" / ") }}</div>
									<div v-if="tuneNeg.length">不该记：{{ tuneNeg.join(" / ") }}</div>
									<div class="mem-sub">※ 只是风格示例，不进对话上下文，只在整理时发给模型</div>
								</div>
								<div v-else-if="tuneShow" class="hint">还没有示例 —— 点「立即优化」生成一份（记忆太少时会先跳过）</div>
							</div>
							<!-- 记忆诊断 (P1「观测闭环」, 2026-09-30): 排查"她为什么记住了 / 为什么没记住"用。
							     默认关; 打开后每次整理在**内存**里留一条证据(提示词/模型输出/门槛挡下的条目/库状态),
							     点「导出记忆诊断」才落盘到 Download/NoriDroid/。重启 App 会清空。 -->
							<div class="mem-sec mem-diag">
								<div class="mem-sec-title">记忆诊断（排查用）</div>
								<div class="row-inline">
									<label>记录整理过程（最多最近 {{ MAX_DIAG_RECORDS }} 次）</label>
									<input type="checkbox" v-model="cfg.memoryDiagnostics" @change="onDiagToggle" />
								</div>
								<div class="hint">
									打开后每次整理会留下证据：喂给模型的提示词、模型原话、门槛挡下了什么、库里现在多少条。
									已记录 <b>{{ diagN }}</b> 次；只在内存里，重启就清空，所以导出要在同一次里做。
								</div>
								<div class="btn-row mem-diag-btns">
									<button class="mini ripple" :disabled="diagN === 0" @click="doExportDiag">导出记忆诊断</button>
									<button class="mini ripple" :disabled="diagN === 0" @click="doClearDiag">清空记录</button>
								</div>
								<div class="hint mem-sub">※ 记录里含你的原话与记忆内容（诊断必须如此），导出后请留意文件去向</div>
							</div>
							<!-- C: 操作按钮复制到记忆库页 —— 原来只在设置一级页的「记忆系统」块里,
							     用户两次都没找到 (导出找不到就是证据)。「清空」仍只留在一级页 (破坏性操作不重复入口) -->
							<div class="btn-row mem-btns mem-btns-bottom">
								<button class="mini ripple" @click="doExportAll">导出</button>
								<button class="mini ripple" @click="doPruneMemories">清理低频记忆（30天未提）</button>
								<button class="mini ripple" @click="doRestoreMemory" :disabled="!hasBackup">撤销上次清理</button>
							</div>
							<div v-if="memPruneMsg" class="hint" :class="{ok: memPruneMsgOk, bad: !memPruneMsgOk}">{{ memPruneMsg }}</div>
						</template>

						
						<template v-else-if="panel === 'pomo'">
							<div class="settings-row">
								<label>专注 / 休息（分钟）</label>
								<div class="pomo-pair">
									<input type="number" min="5" max="120" v-model.number="pomoCfg.focusMin" @change="pomoCfg.focusMin = Math.min(120, Math.max(5, Math.round(pomoCfg.focusMin) || 25))" />
									<span class="pomo-slash">/</span>
									<input type="number" min="1" max="30" v-model.number="pomoCfg.breakMin" @change="pomoCfg.breakMin = Math.min(30, Math.max(1, Math.round(pomoCfg.breakMin) || 5))" />
								</div>
							</div>
							<div class="settings-row">
								<label>预设</label>
								<div class="pomo-chips">
									<button v-for="p in POMO_PRESETS" :key="p.label" class="pomo-chip" :class="{on: pomoCfg.focusMin === p.focus && pomoCfg.breakMin === p.break}" @click="pomoCfg.focusMin = p.focus; pomoCfg.breakMin = p.break">{{ p.label }}</button>
								</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>专注完成自动开始休息</label>
									<input type="checkbox" v-model="pomoCfg.autoBreak" />
								</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>完成时发系统通知</label>
									<input type="checkbox" v-model="pomoCfg.notify" @change="pomoOnNotifyChange" />
								</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>放弃后安静保持（分钟）</label>
									<select v-model.number="pomoCfg.sulkMin">
										<option :value="0">手动恢复</option>
										<option :value="5">5</option>
										<option :value="10">10</option>
										<option :value="15">15</option>
									</select>
								</div>
								<div class="hint">开始专注即安静（不主动搭话、BGM 暂停，朗读与按键音保留）。放弃后继续保持这么久再自动恢复；坚持跑完则整个番茄周期结束就立即恢复。期间你手动动过静音开关，就由你接管。</div>
							</div>
							<div class="settings-row">
								<label>今日专注</label>
								<span class="pomo-today">{{ pomoTodayText }}</span>
								<!-- 完成率/平均每段: 数据本来就有 (done/abort/focusMin), 只是没展示。
								     不放进 Nori 的台词里 —— 那是"自我批评"类数据, 适合给你自己看 -->
								<div class="pomo-sub" v-if="pomoSummary.todayRate >= 0 || pomoSummary.todayAvgMin > 0">
									<span v-if="pomoSummary.todayRate >= 0">完成率 {{ Math.round(pomoSummary.todayRate * 100) }}%</span>
									<span v-if="pomoSummary.todayAvgMin > 0">平均每段 {{ pomoSummary.todayAvgMin }} 分钟</span>
								</div>
							</div>
							<div class="settings-row">
								<label>近 7 天</label>
								<span class="pomo-today">
									{{ pomoSummary.rangeMin }} 分钟 · 完成 {{ pomoSummary.rangeDone }}
									<span v-if="pomoSummary.rangeBest > 0"> · 最佳 {{ pomoSummary.rangeBest }} 分钟</span>
									<span v-if="pomoSummary.streak > 1"> · 连续 {{ pomoSummary.streak }} 天 🔥</span>
								</span>
							</div>
							<!-- 范围切换: 7 / 30 / 365 天。柱旁"全部"按钮进入独立统计页 (热力图 + 点选某天) -->
							<div class="pomo-range">
								<button
									v-for="r in ([7, 30, 365] as const)" :key="r"
									class="pomo-rbtn" :class="{on: pomoRange === r}"
									@click="pomoRange = r"
								>{{ r === 7 ? "7 天" : r === 30 ? "30 天" : "全年" }}</button>
								<button class="pomo-rbtn all" @click="openPomoStats">全部 ›</button>
							</div>
							<div class="pomo-bars" :class="{'dense': pomoRange > 30}">
								<div v-for="d in pomoRangeBars" :key="d.day" class="pb-col">
									<i :style="{height: d.h + '%'}" :title="d.min + ' 分钟'"></i>
									<!-- 柱顶常显分钟数 (原先只有 hover 才看得到, 手机上等于看不到);
									     30/365 天档太密, 只在有值时显示且字号更小 -->
									<b class="pb-val" v-if="d.min > 0 && pomoRange <= 30">{{ d.min }}</b>
									<span>{{ d.label }}</span>
								</div>
							</div>
							<div class="pomo-act">
								<button class="pomo-go" @click="pomoGoBtn">{{ pomoGoLabel }}</button>
								<button class="pomo-go alt" @click="pomoCountUpBtn">{{ pomo.phase === 'countUp' ? '停止正向' : '正向计时' }}</button>
							</div>
							<div class="hint">计时本体在应用进程内，离开界面照走；完成会响铃、播报并发系统通知（依赖悬浮窗等保活，进程被杀时仍有通知兜底）。专注中 Nori 不主动搭话。</div>
						</template>
						<template v-else-if="panel === 'pomoStats'">
							<!-- 独立统计页: 一年热力图 (点格子看某天) + 终身累计 + 月度汇总 -->
							<div class="settings-row">
								<label>近一年</label>
								<!-- 52 列 × 11px ≈ 572px, 比面板(约 260px)宽 → 必须放可横滚容器里,
								     否则会溢出面板。canvas 用像素尺寸绘制, 不随容器缩放。 -->
								<div class="pomo-heat-wrap">
									<canvas
										ref="pomoHeatCanvas"
										class="pomo-heat"
										@click="onHeatClick"
									></canvas>
								</div>
								<div class="pomo-heat-legend">
									<span class="mh-label">少</span>
									<i v-for="lv in [1, 2, 3, 4]" :key="lv" :class="'mh-lv' + lv"></i>
									<span class="mh-label">多</span>
								</div>
								<div class="hint" v-if="!pomoSelectedDay">点任意格子查看那一天的专注情况。</div>
								<div class="pomo-daybox" v-else>
									<b>{{ pomoSelectedDay.date }}</b>
									<span>{{ pomoSelectedDay.min }} 分钟 · 完成 {{ pomoSelectedDay.done }} · 中断 {{ pomoSelectedDay.abort }}</span>
								</div>
							</div>
							<div class="settings-row">
								<label>累计</label>
								<span class="pomo-today">
									专注 {{ fmtTotalMin(pomoStats.total?.focusMin || 0) }}
									· 完成 {{ pomoStats.total?.done || 0 }} 个
									<span v-if="(pomoStats.total?.countUpMin || 0) > 0"> · 正向 {{ fmtTotalMin(pomoStats.total?.countUpMin || 0) }}</span>
								</span>
								<div class="pomo-sub">
									<span>最好的一天 {{ pomoStats.best?.dayMin || 0 }} 分钟</span>
									<span>最长连续 {{ pomoStats.best?.streak || 0 }} 天</span>
								</div>
							</div>
							<div class="settings-row">
								<label>近 12 个月</label>
								<div class="pomo-months">
									<div v-for="m in pomoMonths" :key="m.month" class="pm-row">
										<span class="pm-name">{{ m.month.slice(2) }}</span>
										<span class="pm-bar"><i :style="{width: Math.min(100, Math.round((m.min / (pomoMonths[0].min || 1)) * 100)) + '%'}"></i></span>
										<span class="pm-val">{{ m.min }} 分 · {{ m.done }} 个</span>
									</div>
								</div>
							</div>
							<div class="hint">专注记录永久保留（不再按 30 天滚动删除），超过 10 年的才会被裁掉。</div>
						</template>
						<template v-else-if="panel === 'settings'">
							<!-- 自定义人设（2026-10-01 用户要求）: 放在面板**最顶上** —— 内置人设已删除, 这份就是 Nori 的唯一设定,
							     比 API Key/模型这些还靠前, 否则用户根本找不到 -->
							<div class="settings-row">
								<label>人设文案（提示词）</label>
								<div class="row-inline">
									<button class="mini ripple" @click="doImportPersona">导入文件</button>
									<button class="mini ripple" :disabled="!personaCustom" @click="doResetPersona">清除自定义</button>
								</div>
								<div class="hint">{{ personaStateText }}</div>
								<div v-if="personaMsg" class="hint" :class="{ok: personaMsgOk, bad: !personaMsgOk}">{{ personaMsg }}</div>
								<div class="hint">选一个 UTF-8 文本文件（.md/.txt，≤200KB）当人设; 只存在本机, 不上传、不进包</div>
							</div>
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
									<button class="mini ripple" @click="refreshModels">加载模型</button>
								</div>
								<div v-if="modelLoadMsg" class="hint">{{ modelLoadMsg }}</div>
							</div>
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
								<label>渲染分辨率 {{ renderScaleNum.toFixed(1) }}x（推荐用手机原生 {{ nativeDpr.toFixed(1) }}x）</label>
								<input type="range" min="0.5" max="3.0" step="0.1" v-model.number="cfg.renderScale" @change="applyRenderScale" />
								<div class="hint">越接近手机原生分辨率越清晰，耗电和发热越高；卡顿时调低即可</div>
							</div>
							<div class="settings-row">
								<label>渲染帧率上限 {{ l2dFpsNum === 0 ? "不限制" : `${l2dFpsNum} fps` }}（形象 + 背景）</label>
								<div class="pomo-range">
									<button
										v-for="v in L2D_FPS_OPTIONS" :key="v"
										class="pomo-rbtn" :class="{on: l2dFpsNum === v}"
										@click="setL2dFps(v)"
									>{{ l2dFpsLabel(v) }}</button>
								</div>
								<div class="hint">
									Live2D 形象与数据海背景每秒最多重绘几次（两者同步；悬浮窗也跟随这个档位）。120Hz 屏设 60 省一半；
									30/20/15 更省电但动作与背景会略跳。60Hz 屏只有设到低于 60 才有区别。选「不限」恢复原来的行为
								</div>
							</div>
							<div class="settings-row">
								<label>聊天记录存储位置</label>
								<!-- 2026-10-02 更正: 写在**公共下载目录**里的文件（聊天/记忆/日记）卸载后一般仍在（系统不按应用私有数据清理）；
								     现在清单里加了 hasFragileUserData, 卸载时会询问是否保留下应用数据 (勾选才保留)。 -->
								<div class="hint ok">公共下载目录：{{ storagePath }}（重装后若内容不见了，见下方「存储自检」）</div>
								<div class="row-inline">
									<label>所有文件访问权限{{ allFilesAccess ? "（已授权 ✓）" : "（未授权）" }}</label>
									<button class="mini ripple" @click="doRequestAllFiles">去授权</button>
								</div>
								<div class="hint">
									用于读写 {{ storagePath }} 里的数据文件。<b>卸载重装后原有内容读不到，就是因为没有它</b>：
									Android 11+ 起，别的应用（或本应用旧实例）写进公共下载目录的文件，本应用既在媒体库里看不见、也不能直接读。
									授予后返回本页点「自检」，会显示「所有文件访问权限: 是」且内容被读回。
								</div>
								<div class="row-inline">
									<label>存储自检（读不到数据时点一下）</label>
									<button class="mini ripple" @click="doStorageProbe">自检</button>
								</div>
								<pre v-if="storageProbeMsg" class="store-probe">{{ storageProbeMsg }}</pre>
								<div class="hint">列出公共目录里到底有没有文件、MediaStore 是否可见、能否直读 —— 卸载重装后排查"原有内容读不到"用</div>
							</div>
							<div class="settings-row mem-block">
								<label>背景音乐</label>
								<div class="mem-sec">
									<div class="mem-sec-title mem-sec-title-row">
										<span>NoriOS 官方 OST{{ bgmNowName ? ` · 正在播放：${bgmNowName}` : "" }}</span>
										<label class="bgm-toggle">
											<input type="checkbox" :checked="cfg.bgmEnabled" @change="onBgmToggle" /> 开启
										</label>
									</div>
									<div class="model-pick">
										<select :value="cfg.bgmTrack" @change="onBgmTrackChange">
											<option value="random">随机播放</option>
											<option v-for="t in BGM_TRACKS" :key="t.id" :value="t.id">{{ t.name }}</option>
										</select>
										<button v-if="cfg.bgmEnabled && bgmState === 'ready'" class="mini ripple" @click="onBgmNext">换一首</button>
									</div>
									<div class="hint">
										{{ bgmState === "ready" ? "资源已就绪，随开关播放" : bgmState === "downloading" ? `资源包下载中 ${bgmPct}%` : "音频资源未下载（约 13MB，首次需联网）" }}
									</div>
									<button
										v-if="bgmState !== 'ready'"
										class="mini ripple"
										:disabled="bgmState === 'downloading'"
										@click="onBgmDownload"
									>{{ bgmState === "downloading" ? `下载中 ${bgmPct}%` : "下载背景音乐资源" }}</button>
									<button v-else class="mini ripple" @click="onBgmRedownload">重新下载</button>
									<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.bgmVolume" @input="onBgmVolume" @change="persistSettings" />
									<div class="hint">音量独立于朗读语音，默认 35% 不盖 Nori 说话；循环播放，退后台自动暂停</div>
								</div>
							</div>
							<div class="settings-row">
								<label>按键音效音量 {{ Math.round((Number(cfg.sfxVolume) || 0) * 100) }}%（0% = 关闭）</label>
								<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.sfxVolume" @input="onSfxVolume" @change="persistSettings" />
								<div class="hint">点击底部功能按钮时的提示音</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>音效文件</label>
									<button class="mini ripple" :disabled="sfxBusy" @click="doDownloadSfx">{{ sfxBtnText }}</button>
								</div>
								<div class="hint" :class="{ok: sfxMsgOk, bad: sfxMsgBad}">{{ sfxMsg }}</div>
								<div class="hint">音效不再打进安装包（包更小），这里点一次下到本机，之后一直用本地的；没下载时按键音与番茄钟音效静音但不报错</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>动态背景（数据海）</label>
									<input type="checkbox" v-model="cfg.dataseaBg" @change="onDataseaBgToggle" />
								</div>
								<div class="hint">星尘、星云光斑与网格的程序渲染，几乎零开销；关闭后回到纯色背景</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>让 Nori 知道时间</label>
									<input type="checkbox" v-model="cfg.timeAware" @change="persistSettings" />
								</div>
								<div class="hint">每次对话都会告诉她当前时间（年月日 + 星期 + 时分 + 时区），这样她能回答「现在几点」、算得清「下周三」；关掉就回到以前（她会答不上时间）</div>
							</div>
							<div class="settings-row">
								<label>安静模式</label>
								<div class="model-pick">
									<select v-model="cfg.quietMode" @change="onQuietModeChange">
										<option value="off">关闭</option>
										<option value="auto">自动（每日 23:00–次日 8:00）</option>
										<option value="manual">手动</option>
									</select>
								</div>
								<div v-if="cfg.quietMode === 'manual'" class="row-inline">
									<label>立即静音</label>
									<input type="checkbox" v-model="cfg.quietOn" @change="onQuietToggle" />
								</div>
								<div class="hint">开启后 Nori 不主动搭话、BGM 暂停；你发消息她照常回复（TTS 朗读与按键音保留）</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>Nori 主动搭话</label>
									<input type="checkbox" v-model="cfg.ambientEnabled" @change="onAmbientToggle" />
								</div>
								<div class="hint">安静几分钟后，她可能会轻轻说一句（本地语料零 token、不进聊天记录；每次会话最多几条）；安静模式开启时不生效</div>
							</div>
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
								<!-- 点这里先给反应 (气泡 + 朗读), 第三下才真的进去 —— 见 onMemEntryTap -->
								<button class="mini ripple mem-enter" @click="onMemEntryTap">
									记忆库 · 目标 / 长期记忆 / 历史总结（{{ nonGoalMemories.length + goals.length }} 条） ›
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
									<button class="mini ripple" @click="doPruneMemories">清理低频记忆（30天未提）</button>
									<button class="mini ripple" @click="doClearMemory">清空全部记忆</button>
									<button class="mini ripple" @click="doRestoreMemory" :disabled="!hasBackup">撤销上次清理</button>
									<button class="mini ripple" @click="doExportAll">导出</button>
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
									<label>退出后显示悬浮窗 Nori</label>
									<input type="checkbox" v-model="cfg.floatEnabled" @change="onFloatToggle" />
								</div>
								<div class="hint">开启后，按返回键退出应用时，Nori 会以小悬浮窗留在屏幕上（可拖动、双指缩放）。首次开启需要授权悬浮窗权限</div>
							</div>
							<div class="settings-row">
								<label>悬浮窗渲染分辨率 {{ Number(cfg.floatRenderScale).toFixed(1) }}x（推荐 {{ nativeDpr.toFixed(1) }}x）</label>
								<input type="range" min="0.5" max="3.0" step="0.1" v-model.number="cfg.floatRenderScale" @change="onFloatRenderScale" />
								<div class="hint">渲染分辨率同主 App，越高越清晰也越耗电（悬浮窗尺寸用双指缩放调节，自动记忆）</div>
							</div>
							<div class="settings-row">
								<div class="row-inline label-only">悬浮窗触摸手势</div>
								<div class="hint">· 点 Nori 身体 → 弹出聊天气泡<br />· 在 Nori 身体上轻微滑动 → 抚摸反馈（开心表情 + 轻蹭）<br />· 按住 0.8 秒后再移动 → 移动悬浮窗（0.8 秒内移动不算拖动，防误拖）<br />· 手指快速大幅滑过 → 不弹气泡、不拖动（防误触）<br />· 双指捏合 → 调整悬浮窗大小（任意位置均可）<br />· 拖动、点按、抚摸都会重置待机小动作计时<br />· 对话框打开时：拖 ≡ 把手移动、双指捏合缩放、短按 ✕ 锁定、长按 ✕ 退出</div>
							</div>
							<button class="btn ripple" @click="openPanel('tts')">语音合成（TTS）</button>
							<button class="btn ripple" @click="openPanel('motion')">动作列表</button>
							<button class="btn ripple" @click="openPanel('expression')">表情列表</button>
							<button class="btn ripple" @click="saveSettingsNow">保存设置</button>
							<!-- 新手引导入口 (原「更新记录」已按用户要求移除) -->
							<button class="btn ripple intro-open" @click="introOpen">新手引导 / 致谢</button>
							<!-- 关于 / 隐私 / 开源许可（2026-10-02 用户要求）: 入口放设置面板最下面 ——
							     最顶上那一行是刚做完的人设行, 一律不动。点开走**现有的 sheet 面板机制**
							     (panel === 'about')，不另造窗口。 -->
							<div class="settings-row about-row">
								<button class="mini ripple about-open" @click="openAboutPage">关于 / 隐私 / 开源许可 · v{{ APP_VERSION }} ›</button>
							</div>
							<!-- 外观风格对比开关 (定稿后连同 uiSoft 一起删掉即可) -->
							<button class="btn ripple" @click="toggleUiStyle">外观风格：{{ uiSoft ? "柔和（新色板）" : "像素风" }} ›</button>
						</template>
						<!-- 关于 / 隐私 / 开源许可（2026-10-02 用户要求）: 复用现有 sheet 面板（入口在设置面板里），
						     四块内容缺一不可 —— 版本+上游声明 / 隐私说明 / 开源许可 / 反馈渠道。
						     许可细节与义务说明以仓库根 THIRD-PARTY.md 为准，这里只放要点 + 指向它。 -->
						<template v-else-if="panel === 'about'">
							<div class="about-page">
								<!-- ① 版本 + 上游声明 -->
								<div class="about-sec">
									<div class="about-h">版本</div>
									<p class="about-p">NoriDroid <b>v{{ APP_VERSION }}</b>（Android 桌宠：Kotlin 外壳 + Vue 3 WebView 前端）</p>
									<p class="about-p">本项目<b>衍生自</b> <button class="about-a" @click="openAboutUrl(UPSTREAM_REPO_URL)">erhiolab/DeepEr</button>，上游以 <b>GPL-3.0</b> 发布；本仓库是<b>修改版</b>（重构、记忆模块、悬浮窗、一键克隆等改动），同样以 <b>GPL-3.0</b> 发布，详见仓库根的 LICENSE。</p>
									<p class="about-p">本项目仓库：<button class="about-a" @click="openAboutUrl(REPO_URL)">{{ REPO_URL }}</button></p>
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
									</ul>
									<p class="about-p">除此之外不采集、不上传任何数据：没有统计、没有广告、没有崩溃上报 SDK；API Key 只存在本机设置里。</p>
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
										<li><b>Live2D Cubism Core</b>（live2dcubismcore.min.js）—— <b>专有许可</b>，不是开源组件。Core <b>按原样分发、不修改</b>，也<b>不置于会允许第三方修改的开源许可之下</b>；版权与许可声明一律保留。</li>
									</ul>
									<p class="about-p">Live2D 专有软件许可协议全文：</p>
									<button class="about-a ripple about-a-block" @click="openAboutUrl(LIVE2D_EULA_URL)">{{ LIVE2D_EULA_URL }}</button>
									<p class="about-p">不随包分发：人设文本、音效、参考音频、Live2D 模型素材都<b>不在安装包里</b> —— 由使用者自己导入或联网下载，版权归各自作者所有。</p>
									<p class="about-p">完整清单与 Live2D 协议的分发义务说明见仓库根目录的 <code>THIRD-PARTY.md</code>。</p>
								</div>
								<!-- ④ 反馈渠道 -->
								<div class="about-sec">
									<div class="about-h">反馈渠道</div>
									<p class="about-p">Nori 是「小桧」用爱发电做的同人二创，欢迎来找我反馈 bug 捏 —— QQ 群 <b>471419518</b>（inori 一群）。</p>
									<p class="about-p">项目仓库开 issue 也可以：<button class="about-a" @click="openAboutUrl(REPO_URL)">{{ REPO_URL }}</button></p>
								</div>
							</div>
						</template>
					</div>
				</div>
			</div>
		</transition>

		<!-- 新手引导 (分步弹窗): 首次打开 (还没建立数据目录) 自动弹一次; 之后可由 设置 → 「新手引导」重新打开。
		     z-index 80 高于面板(20)/调试行(70), 保证任何时候都在最上层。 -->
		<transition name="sheet">
			<div v-if="introOn" class="intro-mask" @click.self="introClose">
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
		</transition>

		<!-- 模型授权验证（答题门，2026-10-01 为一键克隆引入；2026-10-02 起**同一道门**也守「下载模型」）
		     —— 照用户给的参考图做的结构：标题/说明/问题/输入框/取消·验证/底部提示。
		     只有一份弹窗与一份状态（gateOn/gateKind/...），动作靠 openGate(kind, onPass) 分岔：
		     clone = 建音色（原样，.clone-gate 这套类名/文案一字未改，probe-clone-gate 盯着）；
		     model = 放行后走原来的"切模型→下载"流程（进度还在 topbar 的 loadingMsg 上）。 -->
		<transition name="sheet">
			<div v-if="gateOn" class="gate-mask" :class="gateKind === 'clone' ? 'clone-gate-mask' : 'model-gate-mask'" @click.self="closeGate">
				<div class="gate" :class="gateKind === 'clone' ? 'clone-gate' : 'model-gate'">
					<div class="gate-head">
						<span class="gate-title">模型授权验证</span>
						<button class="x" @click="closeGate">✕</button>
					</div>
					<p class="gate-desc">该{{ gateKind === "clone" ? "内置音色" : "模型" }}由 <b>inori</b> 提供，因模型特殊性不可直接分发；答对下面的问题即可{{ gateKind === "clone" ? "获得使用资格" : "开始下载" }}。</p>
					<div class="gate-q">{{ CLONE_GATE_QUESTION }}</div>
					<input v-model="gateInput" class="gate-input" type="text" autocomplete="off" spellcheck="false" placeholder="请输入答案" @keyup.enter="doGate" />
					<div v-if="gateMsg" class="hint" :class="gateOk ? 'ok' : 'bad'">{{ gateMsg }}</div>
					<div class="gate-btns">
						<button class="mini ripple" @click="closeGate">取消</button>
						<button class="mini ripple gate-go" :disabled="gateBusy || !gateInput.trim()" @click="doGate">{{ gateBusy ? gateBusyLabel : gateGoLabel }}</button>
					</div>
					<div class="gate-hint">{{ gateKind === "clone" ? CLONE_GATE_HINT : MODEL_GATE_HINT }}</div>
				</div>
			</div>
		</transition>
	</div>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue"
import {
	createLive2D,
	readModelConfig,
	writeModelConfig,
	L2D_FPS_OPTIONS,
	normalizeFps,
	type MotionGroup,
} from "./services/live2d"
import {applyCanvasLayout, canvasPointFromClient, clientFromCanvasPoint} from "./services/live2d/stage"
import {readMotionGroups, readExpressionNames} from "./services/live2d/motions"
import {coverUrl} from "./services/gateway/api"
import {fetchModelList, ensureModel, getInstalled, listInstalled} from "./services/live2d/modelStore"
import {
	loadTouchConfig,
	saveTouchConfig,
	newTouchId,
	type TouchArea,
} from "./services/live2d/touch"
import {TouchDetector, toModelPoint, modelLayout} from "./services/live2d/touchDetection"
import TouchManager from "./components/TouchManager.vue"
import {
	loadSettings,
	saveSettingsRaw,
	loadChat,
	persistChat,
	setChatTrimCutoff,
	flushChatPersist,
	writeFile,
	fetchModels,
	sendChat,
	isStorageReady,
	requestStoragePermission,
	pickPersonaFile,
	loadCustomPersona,
	saveCustomPersona,
	personaPrompt,
	localTimeBlock,
	getStorageDir,
	probePublicFiles,
	hasAllFilesAccess,
	requestAllFilesAccess,
	checkFishBalance,
	checkDeepSeekBalance,
	checkCosyBalance,
	fetchVoices,
	sendChatStream,
	cancelChatStream,
	type ChatMsg,
	type VoiceInfo,
	type CosyCloneVoice,
	normalizeCloneVoices,
} from "./services/chat"
import {
	addMemoriesFromText,
	extractMemoriesSmart,
	pruneDoneGoals,
	recallForQuery,
	recallForQuerySmart,
	summaryBlock,
	summarizeIfNeeded,
	notifyHistoryTrimmed,
	safeTrimDrop,
	contextHistory,
	recentTopicsBlock,
	flushMemoryPersist,
	clearMemory,
	pruneStaleMemories,
	pruneStalePreview,
	listAll,
	listInvalidMemories,
	listFadedMemories,
	listDeletedMemories,
	restoreFadedMemory,
	fadeMemoryManually,
	restoreDeletedMemory,
	deleteMemoryForever,
	getMemoryExamples,
	rebuildMemoryExamples,
	clearMemoryExamples,
	shouldRebuildMemoryExamples,
	buildDiagJsonl,
	clearDiag,
	diagCount,
	setDiagEnabled,
	MAX_DIAG_RECORDS,
	listBlocks,
	listUnblockedMemories,
	organizeProgress,
	restoreMemory,
	deleteMemory,
	pinMemory,
	backupMemoryNow,
	restoreMemoryBackup,
	hasMemoryBackup,
	listGoals,
	addGoal,
	removeGoal,
	goalCarePrompt,
	reloadMemory,
	shouldSkipLlmExtract,
	type MemoryItem,
	type MemorySummary,
	type MemoryType,
	type MemoryBlockView,
	type MemoryBlock,
} from "./services/memory"
import {
	isTtsReady,
	speak as speakTTS,
	stop as stopTTS,
	test as testTTS,
	onSpeakingChange,
	setTtsErrorHandler,
	beginSpeakSession,
	speakAppend,
	endSpeakSession,
	splitSpeechText,
	setTtsVolume,
	cosyVoiceModelOf,
} from "./services/tts"
import {FISH_MODELS, FISH_FORMATS, FISH_LATENCIES} from "./services/tts/fishaudio"
import {COSY_MODELS, COSY_NO_VOICE_ERROR, cosyVoiceModelError, pickVoiceFile, createCloneVoice, queryCloneVoice, createPresetCloneVoice} from "./services/tts/cosyvoice"
// 「模型授权验证」答题门（2026-10-01 一键克隆 / 2026-10-02 也守「下载模型」）: 题目/答案/判卷都在那个纯模块里, 便于单测
import {CLONE_GATE_QUESTION, CLONE_GATE_HINT, MODEL_GATE_HINT, checkCloneAnswer} from "./services/tts/clone-gate"
import {parseMarkerDelta, type ParsedMarkers} from "./services/chat/markers"
import {listDiary, ensureDiary, writeTodayDiary, deleteDiaryEntry, bufferDiarySource, type DiaryEntry} from "./services/nori-diary"
// 专注统计: 纯逻辑 (可单测) —— 汇总计算、热力图网格、以及"要不要跟 Nori 提"的判定都在那里
import {
	summarize as pomoSummarize,
	buildFocusHint,
	buildHeatmap,
	monthlyRollup,
	migrateStats,
	addToStore,
	dayKey as pomoStatDayKey,
	type PomoStatsFile,
	type PomoSummary,
	type Heatmap,
} from "./services/pomo-stats"
import {syncBgm, nextBgmTrack, setBgmVolume, setBgmDucking, pauseBgm, resumeBgm, bgmNameOf, bgmCurrentId, setBgmErrorHandler, setBgmStateHandler, downloadBgm, type BgmState, BGM_TRACKS} from "./services/bgm"
import {setSfxVolume, playSfx, playSfxFile, readSfxStatus, downloadSfx, setSfxDownloadHandler, SFX_SOURCE, type SfxDownloadResult} from "./services/sfx"
import {initDataseaBg, setDataseaBgEnabled, resizeDataseaBg, dataseaTouchStart, dataseaTouchMove, dataseaTouchEnd, stopDataseaBg, setDataseaFps} from "./services/datasea-bg"
import {setAmbientEnabled, ambientTouch, startAmbient, stopAmbient} from "./services/ambient"
import {habitRecord} from "./services/habit"
import {
	detectExpressionByRules,
	detectMotionByRules,
	resolveMarkerEmotion as resolveMarkerEmotionShared,
	resolveMarkerMotion as resolveMarkerMotionShared,
	pickNeutralIdle,
} from "./services/live2d/markerRules"
import {scheduleReturnToNeutral, cancelReturnToNeutral} from "./services/live2d/motionReturn"
import {spawnPetMotes, spawnPetTouchBurst, spawnPetComplete, clearPetFx, petSwayAmp, petFxSpawned} from "./services/live2d/petEffect"
// 抚摸采样器 (移植自网页版 headPat 的 r8e): 判"横向为主 + 够快", 累计满 requiredMs 算完成一次
import {createPetStrokeDetector, DEFAULT_PET_STROKE_TUNING} from "./services/live2d/petStroke"
// 抚摸音效 (移植自网页版 headPat 的实时合成音, 零素材)
import {petAudioPrime, petAudioTouch, petAudioStroke, petAudioComplete, petAudioRelease, disposePetAudio, petAudioState} from "./services/live2d/petAudio"
// "摸到头"的判定 (移植自网页版 headPat 的部件判定; 这个模型没有 Part9, 改为按几何挑头盒)
import {pickHeadBox, inHeadZoneHysteresis, headZoneLine, type PetPartBox} from "./services/live2d/petHeadZone"
// 摸头表情: 只在摸到头时播 shy/smile(二选一随机) + 停手 1s 后平滑收回(表情自带 0.5s 淡出)
import {applyPetExpression, petExpressionName, petExpressionShowing, petExpressionHoldsLayer} from "./services/live2d/petExpression"
// 摸头台词: 摸到头时说一句(10 句语料随机, 洗牌袋不重复), 10s 内只说一次 —— 纯逻辑在模块里(有门禁)
import {maybePetSpeechLine, petSpeechCount, petSpeechLastLine, petSpeechWaitMs} from "./services/live2d/petSpeech"
// 眨眼: 库内置的 CubismEyeBlink 被 model3.json 的空 EyeBlink 名单废掉了, 这里自己做
import {installBlink, blinkCount, blinkClosureNow} from "./services/live2d/blink"

type P = "model" | "motion" | "expression" | "touch" | "settings" | "tts" | "diary" | "memories" | "pomo" | "pomoStats" | "about" | ""

const l2dHost = ref<HTMLElement | null>(null)

const l2d = createLive2D()
const loading = ref(false)
const error = ref("")
const ready = ref(false)
const panel = ref<P>("")
const currentModelId = ref<string>("")
const motions = ref<MotionGroup[]>([])
const expressions = ref<string[]>([])

const touchAreas = ref<TouchArea[]>([])

const touchDrawing = ref(false)

const touchAdjusting = ref(false)

const touchDraft = ref<{x: number; y: number; w: number; h: number} | null>(null)

const draftReady = ref(false)

const drawingTarget = ref<string | null>(null)
const touchBubble = ref("")
let touchBubbleTimer: ReturnType<typeof setTimeout> | null = null
const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)

const layoutVer = ref(0)
const loadingMsg = ref("加载中…")
const modelList = ref<{id: string; name: string}[]>([])
const listError = ref("")

const currentModel = computed(() => modelList.value.find((m) => m.id === currentModelId.value))
/**
 * 底栏图标 (2026-09-30)。取自网页版 NoriOS 底栏的 6 个图标（用户按序号点名的：你画我猜/算力/
 * 国际象棋/蛋糕对决/文件/致谢），缩到 144px 放在 `public/icons/`，作为**本机自用**素材。
 *
 * 为什么用字符串常量 + `:src`：`public/` 里的文件是原样落盘的，写成模板里的相对路径会被 Vite
 * 当成本地资源去解析（SFC 里不存在该文件 ⇒ 构建报错）。运行时按 `./icons/...` 相对文档解析，
 * WebView 走 WebViewAssetLoader（`/assets/web/index.html`）⇒ 正好命中 `assets/web/icons/`。
 */
const DOCK_ICONS = {
	diary: "./icons/dock-diary.png",
	model: "./icons/dock-model.png",
	touch: "./icons/dock-touch.png",
	pomo: "./icons/dock-pomo.png",
	settings: "./icons/dock-settings.png",
	chat: "./icons/dock-chat.png",
} as const

const panelTitle = (p: P) => ({model: "选择模型", motion: "动作列表", expression: "表情列表", touch: "自定义触摸", settings: "设置", tts: "语音合成", diary: "Nori 的心情日记", memories: "记忆库", pomo: "番茄钟", pomoStats: "专注统计", about: "关于 / 隐私 / 开源许可"} as Record<string, string>)[p] ?? ""

/* ---------------- 新手引导 (分步弹窗) ----------------
 * 首次打开 (还没建立数据目录) 自动弹一次; 之后设置页底部有「新手引导」按钮可重新打开。
 * 文案来自用户给的说明文档, 只做分步与润色, 内容不改。
 */
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
			"懒得放仓库了…感觉应该不会有啥更新。",
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
/** 是否展示引导 */
const introOn = ref(false)
const introStep = ref(0)
/** 段落里的 **强调** → 分段渲染 (不用 v-html, 免得把文案当 HTML 解析) */
const introSegs = (text: string): {t: string; b: boolean}[] =>
	text.split("**").map((t, i) => ({t, b: i % 2 === 1})).filter(s => s.t !== "")
/** 点过「下一步/开始使用」后就不再自动弹 (关掉弹窗也算看过) */
const INTRO_SEEN_KEY = "intro_seen_v1"
const introOpen = (): void => { introStep.value = 0; introOn.value = true }
const introNext = (): void => {
	if (introStep.value >= INTRO_STEPS.length - 1) { introClose(); return }
	introStep.value += 1
	playSfx()          // 步骤切换给一记轻按键音 (与 dock 按键同一套音量设置)
}
const introPrev = (): void => {
	if (introStep.value <= 0) return
	introStep.value -= 1
	playSfx()
}
const introClose = (): void => {
	introOn.value = false
	try { localStorage.setItem(INTRO_SEEN_KEY, "1") } catch { /* 忽略 */ }
	// 关闭/完成音与"按键音"同源, 不额外引资源
	playSfx()
}

/** I_Nori 的 Steam 愿望单（2026-10-01 用户给的链接）。引导最后一步有一键跳转按钮。
 *  走原生 openExternal（ACTION_VIEW）在外部浏览器打开；桥不支持时退回 window.open。 */
const STEAM_WISHLIST_URL = "https://store.steampowered.com/app/4996280/I_NORI/?beta=0"
/** 项目仓库（2026-10-02 用户要求）：引导最后一步一键跳转，与 Steam 愿望单同款走原生 openExternal */
const REPO_URL = "https://github.com/furret2333/NoriDroid"
const openRepo = (): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(REPO_URL)
		else window.open(REPO_URL, "_blank")
	} catch { /* 打不开就算了, 不打断引导 */ }
	playSfx()
}

const openSteamWishlist = (): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(STEAM_WISHLIST_URL)
		else window.open(STEAM_WISHLIST_URL, "_blank")
	} catch { /* 打不开就算了, 不打断引导 */ }
	playSfx()
}

const hideThumb = (e: Event) => { (e.currentTarget as HTMLElement).style.visibility = "hidden" }

/* ---------------- 「关于 / 隐私 / 开源许可」页用到的常量（2026-10-02 用户要求） ----------------
 * 版本号：与 app/android/app/build.gradle 的 versionName 保持一致（前端随 APK 一起发版）。
 * ⚠ 别拿 web-src/package.json 的 version（脚手架留下的 0.1.0）当版本号 —— 那不是用户看到的版本。
 * 上游声明与许可清单同步自仓库根的 THIRD-PARTY.md（App 里只放要点 + 指向它）。 */
const APP_VERSION = "1.0.0"
const UPSTREAM_REPO_URL = "https://github.com/erhiolab/DeepEr"
const LIVE2D_EULA_URL = "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html"
/** 通用外链打开：与 openRepo / openSteamWishlist 同款（优先原生 openExternal，桥不支持时退回 window.open）。
 *  关于页里的仓库 / 上游 / Live2D 协议都走它，避免在 WebView 里直接跳走。 */
const openAboutUrl = (url: string): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(url)
		else window.open(url, "_blank")
	} catch { /* 打不开就算了, 不打断阅读 */ }
	playSfx()
}
/** 打开「关于 / 隐私 / 开源许可」页。入口在设置面板**最下面**，而 sheet 的滚动位置是跨面板保留的
 *  （`.sheet-body` 始终是同一个滚动容器）—— 不主动滚回顶部的话，点进来会直接落在「开源许可」那一屏，
 *  用户根本看不到开头的「版本」。所以切换面板后把内容滚回顶部。 */
const openAboutPage = (): void => {
	openPanel("about")
	void nextTick(() => {
		const body = document.querySelector<HTMLElement>(".sheet-body")
		if (body) body.scrollTop = 0
	})
}



const relayout = () => {
	applyCanvasLayout(l2d.canvas(), undefined, {
		zIndex: "1", scale: scale.value, offsetX: offsetX.value, offsetY: offsetY.value, animate: false,
	})
	
	layoutVer.value++
}




const detector = new TouchDetector((area, type) => {
	handleTouchTrigger(area, type)
})

detector.setCooldown(10000)

const configureTouchDetector = () => {
	
	const ms = modelSize()
	detector.configure(touchAreas.value, l2d.canvas(), ms?.w ?? 0, ms?.h ?? 0)
}


const modelSize = (): {w: number; h: number} | null => {
	const m = (window as unknown as {__noriModelCanvas?: {w: number; h: number}}).__noriModelCanvas
	return m && m.w > 0 && m.h > 0 ? {w: m.w, h: m.h} : null
}

const loadTouchForModel = (id: string) => {
	touchAreas.value = loadTouchConfig(id).touches
	touchDrawing.value = false
	nextTick(configureTouchDetector)
}

const saveTouch = () => {
	if (currentModelId.value) {
		const cfg = loadTouchConfig(currentModelId.value)
		cfg.touches = touchAreas.value
		saveTouchConfig(currentModelId.value, cfg)
	}
	configureTouchDetector()
}

const onTouchAdd = (t: {name: string; prompt: string}) => {
	const d = touchDraft.value
	if (!d || d.w < 0.06 || d.h < 0.06) { triggerBubble("请先在模型上框选一个矩形区域"); return }
	touchAreas.value.push({
		id: newTouchId(), name: t.name || "未命名", type: "tap",
		x: d.x, y: d.y, w: d.w, h: d.h, image: "", prompt: t.prompt,
	})
	saveTouch()
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	triggerBubble("已添加触摸区域")
}

const onTouchUpdate = (id: string, patch: Partial<TouchArea>) => {
	touchAreas.value = touchAreas.value.map(t => t.id === id ? {...t, ...patch} : t)
	saveTouch()
}

const onTouchRemove = (id: string) => {
	touchAreas.value = touchAreas.value.filter(t => t.id !== id)
	saveTouch()
}


const toggleTouchDraw = () => {
	touchDrawing.value = !touchDrawing.value
	if (touchDrawing.value) touchAdjusting.value = false
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	drawStart = null
	drawDragged = false
	if (touchDrawing.value) triggerBubble("在模型上按住拖动画新矩形")
}


const toggleTouchAdjust = () => {
	touchAdjusting.value = !touchAdjusting.value
	if (touchAdjusting.value) touchDrawing.value = false
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	drawStart = null
	drawDragged = false
	if (touchAdjusting.value) triggerBubble("点住已有区域可拖动位置")
}

const resetTouchDraft = () => {
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	drawDragged = false
}


import {watch as __watch} from "vue"
__watch(() => panel.value, (newVal) => {
	if (newVal !== 'touch') {
		touchDrawing.value = false
		touchAdjusting.value = false
		draftReady.value = false
		touchDraft.value = null
		drawingTarget.value = null
		drawStart = null
		drawDragged = false
	}
})

__watch([scale, offsetX, offsetY, ready], () => {
	nextTick(() => configureTouchDetector())
})


const triggerBubble = (msg: string, ms = 2000) => {
	touchBubble.value = msg
	if (touchBubbleTimer) clearTimeout(touchBubbleTimer)
	touchBubbleTimer = setTimeout(() => { touchBubble.value = "" }, ms)
}




const aiBubble = ref("")
let aiBubbleTimer: ReturnType<typeof setTimeout> | null = null

/** 展示一条 "Nori 说话" 气泡。
 *  `ms` 默认 9s（AI 回复 / ambient 搭话沿用原行为）。
 *  摸头台词传更长的值：它的收尾自己做（说完即收 + 兜底），**必须**保证这里的定时器
 *  不会更早把字抹掉（否则"她还没说完，字就没了"）。 */
const showAiBubble = (t: string, ms = 9000) => {
	aiBubble.value = t
	if (aiBubbleTimer) clearTimeout(aiBubbleTimer)
	aiBubbleTimer = setTimeout(() => { aiBubble.value = "" }, ms)
}


const TAP_VERBS = ["戳了戳", "点了点", "轻轻点了一下", "碰了碰", "戳了一下"]
const SWIPE_VERBS = ["摸了摸", "轻轻摸了摸", "蹭了蹭", "抚摸了好几下", "揉了揉"]

const TOUCH_DIRECTIVE = [
	"这一次是触摸互动：",
	"1. 你已经是一个感觉灵敏的人, 完全按自己的方式来反应, 不许复读之前说过的话, 不许每次都说同一句类似的话。",
	"2. 被摸到什么地方不重要, 重点是营造当下真实、鲜活、有戏的氛围——害羞、舒服、痒、逗趣、傲娇、躲开……随你发挥, 越有趣越好。",
	"3. AI 不要把「什么被摸」这件事机械地复述成一成不变的固定台词, 当作一次自然发生的互动来回应。",
].join("\n")


const surface = (content: string) => {
	// 显示原文 (带标点, 更稳定)
	messages.value.push({role: "assistant", content, ts: Date.now()})
	persistChat(messages.value)
	if (chatOpen.value) scrollChatBottom()
	else showAiBubble(content)
}

const handleTouchTrigger = async (area: TouchArea, type: "tap" | "swipe") => {
	const desc = (area.prompt && area.prompt.trim()) ? area.prompt.trim() : (area.name || "未知")
	const pool = type === "swipe" ? SWIPE_VERBS : TAP_VERBS
	const verb = pool[Math.floor(Math.random() * pool.length)]
	const text = `用户 ${verb} Nori的 ${desc}`
	if (!modelReady.value) { surface("请先在「设置」里配置 API Key 和模型"); return }
	// 防重入: 触摸触发对话进行中, 再次触发直接忽略 (避免并发流互相踩踏)
	if (touchStreaming.value) return
	if (!chatOpen.value) showAiBubble("…")
	const memoryBlock = recallForQuery(text)
	const summary = summaryBlock()
	const context: ChatMsg[] = []
	const personaText = personaPrompt()
	if (personaText) context.push({role: "system", content: personaText} as ChatMsg)
	context.push({role: "system", content: TOUCH_DIRECTIVE} as ChatMsg)
	if (summary) context.push({role: "system", content: summary} as ChatMsg)
	if (memoryBlock) context.push({role: "system", content: memoryBlock} as ChatMsg)
	// 当前时间（2026-10-01）: 放在**人格与其它 system 块之后** —— 越靠后越不伤提示词缓存
	if (cfg.timeAware) context.push({role: "system", content: localTimeBlock()} as ChatMsg)
	const hist = messages.value.filter(m => !m.error).slice(-14).map(({role, content}) => ({role, content}) as ChatMsg)
	
	const payload: ChatMsg[] = [...context, ...hist, {role: "user", content: text, ts: Date.now()}]

	// 与聊天输入一致: 流式生成 + 逐句 TTS
	const ttsOn = isTtsReady(cfg)
	if (ttsOn) beginSpeakSession(cfg)

	touchMarkerBuf.value = "" // 新会话重置触摸的标记跨块缓冲
	touchStreaming.value = true
	let reply = ""
	let pendingSpeech = ""
	// 存储/历史合并: 一次回复只存一条消息, 显示时由 bubbleSegments 拆成多气泡
	let liveBubble: ChatMsg | null = null
	let streamOk = false
	// 本次会话是否收到过标记 (有标记 → 收尾不再用正文关键词覆盖)
	let markerDriven = false

	// 触摸触发的对话用独立 abort, 与聊天输入框的 activeChatAbort 互不干扰 (都归停止按钮管)
	stopRequested = false
	const chatAbort = new AbortController()
	activeTouchAbort = chatAbort

	const flushSpeech = () => {
		if (!ttsOn || !pendingSpeech) return
		const {sentences, rest} = splitSpeechText(pendingSpeech)
		for (const s of sentences) {
			const p = s.trim()
			if (p) speakAppend(cfg, p)
		}
		pendingSpeech = rest
	}

	try {
		await new Promise<void>((resolve) => {
			sendChatStream(cfg.baseUrl, cfg.apiKey, cfg.model, payload, {
				onDelta: (delta) => {
					if (delta === "null") return
					// 剥离隐藏的【表情:xxx】【动作:xxx】标记 (标记不显示、不朗读)
					const {clean, emotion, motion} = parseMarkerDelta(delta, touchMarkerBuf)
					reply += clean
					pendingSpeech += clean
					flushSpeech()
					if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
					if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
					if (cfg.emotionLlm && motion) playMarkerMotion(motion)
					// 存储合并: 只更新一条 liveBubble, 显示层自动拆多气泡
					if (!liveBubble) {
						liveBubble = {role: "assistant", content: reply, ts: Date.now()}
						messages.value.push(liveBubble)
					} else {
						liveBubble.content = reply
					}
					if (chatOpen.value) scrollChatBottom()
				},
				onDone: (content) => {
					streamOk = true
					// content 含标记: 优先用已剥离的 reply; reply 为空时整体剥离一次 (空缓冲)
					if (content && !reply.trim()) {
						const fresh = {value: ""}
						const {clean, emotion, motion} = parseMarkerDelta(content, fresh)
						reply = clean
						if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
						if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
						if (cfg.emotionLlm && motion) playMarkerMotion(motion)
						if (!liveBubble) {
							liveBubble = {role: "assistant", content: reply, ts: Date.now()}
							messages.value.push(liveBubble)
						} else {
							liveBubble.content = reply
						}
					}
					touchMarkerBuf.value = ""
					if (liveBubble) liveBubble.content = reply
					persistChat(messages.value)
					resolve()
				},
				onError: (msg) => {
					const cancelled = stopRequested || msg === "已停止"
					if (!cancelled && !reply.trim()) {
						if (liveBubble) {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
						messages.value.push({role: "assistant", content: `⚠ ${msg}`, ts: Date.now(), error: true})
					} else if (liveBubble) {
						liveBubble.content = reply
					}
					persistChat(messages.value)
					resolve()
				},
			}, cfg.deepseekThinking, chatAbort.signal)
		})

		// 收尾: 剩余文本 + 结束朗读会话
		if (ttsOn) {
			if (pendingSpeech.trim()) speakAppend(cfg, pendingSpeech)
			pendingSpeech = ""
			endSpeakSession()
		}

		if (streamOk && reply) {
			// 表情/动作: 流式标记已即时驱动; 只有完全没收到标记时才用正文关键词兜底
			if (!markerDriven) {
				triggerEmotion(reply)
				pickMotionByKeyword(reply)
			}
			void analyzeAfterReply(text, reply)
		}
		// 聊天面板没开时: 用顶部小气泡显示完整回复
		if (!chatOpen.value && reply) showAiBubble(reply)
	} catch (e: any) {
		surface(`⚠ ${e?.message ?? "请求失败"}`)
	} finally {
		if (activeTouchAbort === chatAbort) activeTouchAbort = null
		touchStreaming.value = false
	}
}


const toModel = (clientX: number, clientY: number): {x: number; y: number} | null => {
	const el = l2d.canvas()
	const ms = modelSize()
	if (!el) return null
	return toModelPoint(clientX, clientY, el, ms?.w ?? 0, ms?.h ?? 0)
}


let drawStart: {x: number; y: number} | null = null

let drawDragged = false

let movingOrigin: {x: number; y: number} | null = null


const markDrawDragged = (P: {x: number; y: number}) => {
	if (drawDragged || !drawStart) return
	if (Math.abs(P.x - drawStart.x) > 0.025 || Math.abs(P.y - drawStart.y) > 0.025) drawDragged = true
}


const hitTouch = (p: {x: number; y: number}): {id: string; t: TouchArea} | null => {
	for (let i = touchAreas.value.length - 1; i >= 0; i--) {
		const t = touchAreas.value[i]
		if (p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h) return {id: t.id, t}
	}
	return null
}


const onDrawDown = (e: PointerEvent) => {
	if (!touchDrawing.value && !touchAdjusting.value) return
	const P = toModel(e.clientX, e.clientY)
	if (!P) return
	drawStart = P
	
	if (touchAdjusting.value) {
		const HIT = hitTouch(P)
		if (HIT) {
			drawingTarget.value = HIT.id
			movingOrigin = {x: HIT.t.x, y: HIT.t.y}
			touchDraft.value = null
			draftReady.value = false
		}
		return
	}
	
	drawingTarget.value = null
	movingOrigin = null
	drawDragged = false
	draftReady.value = false
	touchDraft.value = {x: P.x, y: P.y, w: 0, h: 0}
}


const onDrawMove = (e: PointerEvent) => {
	if (!touchDrawing.value && !touchAdjusting.value) return
	const P = toModel(e.clientX, e.clientY)
	if (!P) return
	if (!drawStart) return
	markDrawDragged(P)
	
	if (drawingTarget.value && movingOrigin) {
		const dx = P.x - drawStart.x
		const dy = P.y - drawStart.y
		const t = touchAreas.value.find(v => v.id === drawingTarget.value)
		if (t) {
			const nx = Math.max(0, Math.min(1 - t.w, movingOrigin.x + dx))
			const ny = Math.max(0, Math.min(1 - t.h, movingOrigin.y + dy))
			touchAreas.value = touchAreas.value.map(v => v.id === t.id ? {...v, x: nx, y: ny} : v)
		}
		return
	}
	
	if (!touchDrawing.value) return
	touchDraft.value = {
		x: Math.min(drawStart.x, P.x),
		y: Math.min(drawStart.y, P.y),
		w: Math.abs(P.x - drawStart.x),
		h: Math.abs(P.y - drawStart.y),
	}
}


const onDrawUp = () => {
	drawStart = null
	
	if (drawingTarget.value) { saveTouch(); drawingTarget.value = null; movingOrigin = null; drawDragged = false; return }
	drawingTarget.value = null
	movingOrigin = null
	
	if (touchAdjusting.value) { drawDragged = false; return }
	
	const d = touchDraft.value
	if (d && drawDragged && d.w >= 0.06 && d.h >= 0.06) {
		draftReady.value = true
		
		touchDrawing.value = false
	} else {
		touchDraft.value = null
	}
	drawDragged = false
}


const boxStyle = (t: {x: number; y: number; w: number; h: number}) => {
	void layoutVer.value 
	const el = l2d.canvas()
	const ms = modelSize()
	if (!el) return {}
	const R = el.getBoundingClientRect()
	if (R.width <= 0 || R.height <= 0) return {}
	const L = modelLayout(el, ms?.w ?? 0, ms?.h ?? 0)
	if (!L) return {}
	
	return {
		left: `${R.left + L.x + t.x * L.w}px`,
		top: `${R.top + L.y + t.y * L.h}px`,
		width: `${t.w * L.w}px`,
		height: `${t.h * L.h}px`,
	}
}


let stagePointers = 0

/* ---------------- 手指触摸追踪 (半透明磨砂小白点) ---------------- */
const touchDotHost = ref<HTMLElement | null>(null)
/** 每个活动手指的 dot 元素 */
const touchDots = new Map<number, HTMLElement>()

/** 手指按下: 在对应位置生成磨砂白点 (内联样式, 避免 scoped CSS 不作用于动态元素) */
const spawnTouchDot = (pointerId: number, x: number, y: number) => {
	if (!touchDotHost.value) return
	let dot = touchDots.get(pointerId)
	if (!dot) {
		dot = document.createElement("div")
		// 内联全部样式: 动态创建的 div 不在 Vue 模板中, scoped CSS 不生效
		Object.assign(dot.style, {
			position: "absolute",
			width: "22px",
			height: "22px",
			borderRadius: "50%",
			background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.4) 55%, rgba(255,255,255,0.1) 100%)",
			// 模糊走 CSS 变量: 像素风格下 --ui-blur-dot = 0px (保持"无模糊"的像素质感),
			// 柔和风格下 2px。内联样式里的 var() 同样能被继承解析 (此元素在 .stage-root 内)
			backdropFilter: "blur(var(--ui-blur-dot, 3px))",
			WebkitBackdropFilter: "blur(var(--ui-blur-dot, 3px))",
			border: "1px solid rgba(255,255,255,0.55)",
			boxShadow: "0 0 12px rgba(255,255,255,0.35), inset 0 0 6px rgba(255,255,255,0.3)",
			opacity: "1",
			transform: "translate(-50%, -50%)",
			transition: "opacity 0.28s ease-out",
			pointerEvents: "none",
			zIndex: "50",
			left: `${x}px`,
			top: `${y}px`,
		})
		touchDotHost.value.appendChild(dot)
		touchDots.set(pointerId, dot)
	}
	dot.style.left = `${x}px`
	dot.style.top = `${y}px`
	dot.style.opacity = "1"
}

/** 手指移动: 更新 dot 位置 */
const moveTouchDot = (pointerId: number, x: number, y: number) => {
	const dot = touchDots.get(pointerId)
	if (!dot) return
	dot.style.left = `${x}px`
	dot.style.top = `${y}px`
}

/** 手指抬起: 让 dot 淡出后移除 */
const removeTouchDot = (pointerId: number) => {
	const dot = touchDots.get(pointerId)
	if (!dot) return
	touchDots.delete(pointerId)
	dot.style.opacity = "0"
	// 等淡出动画结束再移除 DOM
	setTimeout(() => dot.remove(), 300)
}

/* ---------------- 头部跟随 + 抚摸反馈 ---------------- */
let headFollowActive = false
let headBase = {x: 0, y: 0}
let stroking = false
let strokeTimer: ReturnType<typeof setTimeout> | null = null
let swayRaf = 0
let swayPhase = 0
/** 本次抚摸开始时刻 (算幅度渐强) 与上次冒爱心的时刻 (节流) */
let strokeStartAt = 0
let lastPetFxAt = 0

/** 按住多久进入抚摸反馈 (表情 + 轻蹭) */
const STROKE_DELAY = 260
/** 头部轻蹭幅度起手值/上限/渐强时长 与曲线函数都在 petEffect.ts (便于门禁单测)。
 *  只让幅度随抚摸时长渐强, 摆动**频率不变** —— 旧版固定 10px/0.86Hz 被评价"像马达在震",
 *  问题出在频率而不是幅度。 */
/** 轻蹭摆动速度 (rad/帧): 慢速漂移感 (刻意不随抚摸变快) */
const SWAY_SPEED = 0.045
/** 冒柔光粒子的节流间隔 (ms) —— 与 petEffect 的存活上限一起把开销压住。
 *  刻意比第一版(220ms)更慢、且每次只 1 颗: 密度低才"柔和", 不会突兀。 */
const PET_FX_INTERVAL_MS = 260

/** 摸头表情的驱动循环 —— **只在"正在展示"期间跑**，收回后自动停（不常驻 rAF）。
 *
 *  规格（用户定）: 只在**摸到头**时播 shy/smile 二选一；停手 1 秒内没继续摸就收回；
 *  收回靠表情自带的 0.5s 淡出 ⇒ 不会有跳变感；状态变化时才调库 ⇒ 不会每帧重置淡入。
 *  名字的挑选/宽限期/`EXPRESSION_DENY` 过滤都在 `services/live2d/petExpression.ts`（有门禁单测）。 */
let petExprRaf = 0
const startPetExpressionLoop = (): void => {
	if (petExprRaf) return
	const loop = () => {
		const petting = stroking && onNoriHead          // 规格 4: 只有摸到头才播
		const showing = applyPetExpression(performance.now(), petting, expressions.value, {
			play: (n) => {
				// 规格 3(摸头优先): 顺手取消"5 秒回中性"，否则它到点会 stopExpression 把这张脸清掉
				cancelReturnToNeutral()
				try { l2d.playExpression(n) } catch { /* 忽略 */ }
			},
			stop: () => { try { l2d.stopExpression() } catch { /* 忽略 */ } },
		})
		petExprRaf = showing ? requestAnimationFrame(loop) : 0
	}
	petExprRaf = requestAnimationFrame(loop)
}

/* ---------------- 摸头台词 (TTS) ----------------
 * 规格（用户定）: 摸到头 → 从 10 句语料里随机说一句；**10s 内只说一次**；只有摸到头才说。
 * 窗口锚在"**上一次真的说了话**"（首次摸头必定说），台词表/窗口/洗牌袋都在
 * `services/live2d/petSpeech.ts`（纯逻辑，有门禁）；这里只管"该不该开口"与呈现。
 *
 * 呈现: 复用 AI 那套气泡 `.ai-bubble`（自带 `● Nori` 说话人标签 —— 那就是"她开口了"的既有视觉语言），
 *      **开口出现、说完即收**（跟 `speaking` 的 true→false 边沿 —— `speak()` 是单发朗读，
 *      所以"她在说的就是这一句"）。另挂一个 7s 兜底: TTS 失败/无声时 audio 永远不会 playing，
 *      否则气泡会一直挂在那。
 * 不进聊天记录: 与 ambient 搭话同规格（本地语料不写历史、不进记忆/摘要）。
 *
 * ## 两个"看起来像边角、其实会真的发生"的坑（都在这里处理）
 * 1. **兜底 7s 可能比"她说完"还早**：TTS 首音要 1~3s，最长一句 23 字又要 5s 左右
 *    ⇒ 文字会比声音先消失。所以到点时**只要还在说就续期**（最多续 3 次，绝对上限 22s，
 *    防"playing 卡住"时气泡永不消失）。
 * 2. **`speaking=false` 不等于"说完了"**：流式播放中间会有真的静默（句间 / WebAudio 回退
 *    逐块播 / 网络卡一下），`player` 那时确实会把 playing 置回 false。所以
 *    ① "说完即收"要**等一个 VOICE_TAIL 再确认**；② 闸门也要把"刚静下来 < VOICE_TAIL"当成"还在说"
 *    —— 否则那一下的摸头会 `speak()` 打断 Nori 说到一半的回复。
 */
/** 气泡兜底时长: 真出声时由"说完即收"提前收掉, 这个只是无声/失败时的保险 */
const PET_LINE_BUBBLE_FALLBACK_MS = 7000
/** 兜底到点但**还在说**时的续期步长（见文件头坑 1） */
const PET_LINE_BUBBLE_EXTEND_MS = 5000
/** 续期次数上限（绝对上限 = 7s + 3×5s = 22s）—— 防 playing 卡住时气泡永不消失 */
const PET_LINE_BUBBLE_MAX_EXTEND = 3
/** 摸头台词的**绝对存活上限**（兜底 + 全部续期） */
const PET_LINE_BUBBLE_MAX_TOTAL_MS = PET_LINE_BUBBLE_FALLBACK_MS + PET_LINE_BUBBLE_EXTEND_MS * PET_LINE_BUBBLE_MAX_EXTEND
/** "她刚还在出声"的判定余量（见文件头坑 2）: 流式播放中间的静默不超过它就算"还在说" */
const PET_LINE_VOICE_TAIL_MS = 700
/** 当前气泡里是不是摸头台词（与 `aiBubble` 内容比对, 避免误清掉别人的气泡） */
let petLineBubble = ""
/** 这条台词是否**真的**推进到过 playing —— 没出过声就不等"说完", 交给兜底 */
let petLineSpoke = false
let petLineBubbleTimer: ReturnType<typeof setTimeout> | null = null
let petLineExtend = 0
/** 最近一次**确实在出声**的时刻（`Date.now()`）—— "她还在说"用它判, 不用 speaking 的瞬时值 */
let lastVoiceAt = 0
/** "说完即收"的确认定时器（等一个 VOICE_TAIL 再收, 见文件头坑 2） */
let petLineVoiceTailTimer: ReturnType<typeof setTimeout> | null = null

const clearPetLineBubble = (): void => {
	if (petLineBubbleTimer) { clearTimeout(petLineBubbleTimer); petLineBubbleTimer = null }
	if (petLineVoiceTailTimer) { clearTimeout(petLineVoiceTailTimer); petLineVoiceTailTimer = null }
	if (petLineBubble && aiBubble.value === petLineBubble) aiBubble.value = ""
	petLineBubble = ""
	petLineSpoke = false
	petLineExtend = 0
}

/** 兜底到点：还在说就续期，否则收掉（见文件头坑 1） */
const petLineFallback = (): void => {
	petLineBubbleTimer = null
	if (speaking.value && petLineExtend < PET_LINE_BUBBLE_MAX_EXTEND) {
		petLineExtend += 1
		petLineBubbleTimer = setTimeout(petLineFallback, PET_LINE_BUBBLE_EXTEND_MS)
		return
	}
	clearPetLineBubble()
}

/**
 * 摸头时尝试说一句。**只在两处"确认摸到头"的边沿调用**（与 `petAudioTouch()` 同源）。
 * 三道闸: ① TTS 就绪 ② 不在朗读/生成中（跳过且**不消耗**窗口） ③ 10s 窗口。
 */
const maybeSpeakPetLine = (): void => {
	// ① 没配 TTS 就不说，且**不消耗窗口** —— 配好 Key 后第一次摸头照样能听到
	if (!isTtsReady(cfg)) return
	// ② "还在说" = speaking 为真 **或** 刚静下来不到 VOICE_TAIL（流式播放中间的静默, 见文件头坑 2），
	//    再加上"正在生成回复 / 正在打字" → 一律**跳过、不打断**，且**不消耗**窗口
	//    （回复说完后再摸一次就能听到，台词不会白丢）
	if (speaking.value || Date.now() - lastVoiceAt < PET_LINE_VOICE_TAIL_MS) return
	if (chatStreaming.value || touchStreaming.value || typing.value) return
	const line = maybePetSpeechLine(performance.now())
	if (!line) return
	// ③ 呈现: 聊天面板开着时**只出声不弹气泡** —— `.ai-bubble` 的 z-index(58) 高于面板(12),
	//    硬弹会盖在聊天内容上（与 ambient 的 `if (!chatOpen.value)` 同一写法）
	if (!chatOpen.value) {
		petLineBubble = line
		petLineSpoke = false
		petLineExtend = 0
		/* 给 `showAiBubble` 一个**比我们的绝对上限还长**的时长: 它自带的定时器只负责
		   "别用默认的 9s 提前抹掉", 真正的收尾交给 petLineFallback / 说完即收。
		   （原来 9s 那个值会在这句还没说完时就把字清掉 —— 长句 + 首音慢时真会发生。） */
		showAiBubble(line, PET_LINE_BUBBLE_MAX_TOTAL_MS + 1000)
		if (petLineBubbleTimer) clearTimeout(petLineBubbleTimer)
		petLineBubbleTimer = setTimeout(petLineFallback, PET_LINE_BUBBLE_FALLBACK_MS)
	}
	// 单发朗读（内部会打断上一段 TTS; 前面已保证不在朗读中，所以不会切到别人）
	void speakTTS(cfg, line).catch(() => { /* 失败已由 setTtsErrorHandler 提示 */ })
}

/* ---------------- 头部拖拽跟随 (库原生 setDragging; 方向/灵敏度可在设置里现场调) ---------------- */
let lookCur = {x: 0, y: 0}
let lookTarget = {x: 0, y: 0}
let lookRaf = 0
/** 注视起点只初始化一次, 跨触摸延续, 无跳变 */
let lookInit = false

const canvasCenter = (): {x: number; y: number} => {
	const el = l2d.canvas()
	if (!el) return {x: window.innerWidth / 2, y: window.innerHeight / 2}
	return {x: el.clientWidth / 2, y: el.clientHeight / 2}
}

/**
 * 中立点 = 模型渲染框中心 (由 modelLayout 按当前缩放/偏移实时计算),
 * 比画布中心更贴近模型实际位置, 左右输入以它为轴绝对对称.
 */
const lookNeutral = (): {x: number; y: number} => {
	const el = l2d.canvas()
	const ms = modelSize()
	const L = el ? modelLayout(el, ms?.w ?? 0, ms?.h ?? 0) : null
	if (L && L.w > 0 && L.h > 0) return {x: L.x + L.w / 2, y: L.y + L.h / 2}
	return canvasCenter()
}

/**
 * 拖拽范围半径: 按"模型实际渲染框"计算 (框短边 × 0.4), 与缩放无关.
 * 库的拖拽映射是模型空间——半径若按画布算, 模型小(默认缩放)时同样距离映射成巨大模型偏移, 导致定位不准.
 */
const lookRangeRadius = (): number => {
	const el = l2d.canvas()
	const ms = modelSize()
	const L = el ? modelLayout(el, ms?.w ?? 0, ms?.h ?? 0) : null
	if (L && L.w > 0 && L.h > 0) return Math.min(L.w, L.h) * 0.4
	if (!el) return 200
	return Math.min(el.clientWidth, el.clientHeight) * 0.35
}

/** 方向翻转: 直接翻转归一化偏移的符号 (原点在画布中心, 见 toLookTarget) */

/**
 * 手指 → 注视目标: 输入归一化以"模型渲染框中心"为对称轴 (缩放/平移无关,
 * 左右绝对对称), 但**绝对坐标以画布中心为原点** —— 库的角度零位锚定在
 * device 中心 (deviceToScreen 以它为 view 原点), 若用模型框中心当零点会留下
 * 恒定偏角: 松手回正停在"略偏的姿态"上, 0.5s 后被 resetLook 拉回真零位,
 * 肉眼可见地跳一下 (定位二段跳)。零位必须与库一致。
 */
const toLookTarget = (x: number, y: number): {x: number; y: number} => {
	const el = l2d.canvas()
	if (!el) return {x, y}
	const ms = modelSize()
	const L = el ? modelLayout(el, ms?.w ?? 0, ms?.h ?? 0) : null
	const n = lookNeutral()
	const halfW = (L && L.w > 0 ? L.w : el.clientWidth) / 2
	const halfH = (L && L.h > 0 ? L.h : el.clientHeight) / 2
	let dx = clamp((x - n.x) / halfW, -1, 1)
	let dy = clamp((y - n.y) / halfH, -1, 1)
	// 方向翻转: 翻转偏移符号 (原点在画布中心, 翻转即绕零位镜像)
	if (cfg.lookFlipX) dx = -dx
	if (cfg.lookFlipY) dy = -dy
	const R = lookRangeRadius()
	const c = canvasCenter()
	return {x: c.x + dx * R, y: c.y + dy * R}
}

/**
 * 轻拨感弹簧 (帧率无关, 半隐式欧拉积分; 替代旧的指数插值):
 * - follow (手指按住): 软跟随 —— 灵敏度设置映射为刚度 (阻尼比恒 0.75),
 *   头部追手带一点滞后与轻微过冲, 像被轻轻拨动的物体, 不黏手;
 * - return (松手): 固定低速弹簧, 无论何时/从何处松手都约 1.2s 缓缓漂回中立点,
 *   带一丝回弹, 不受灵敏度设置影响 (旧实现回正速度跟着灵敏度走, 摸完收得太急).
 * 手感微调只动这两组数: k 越小越绵软, c 越小回弹越明显
 */
const SPRING_RETURN = {k: 7, c: 4.4}
let lookVel = {x: 0, y: 0}
let lookLastTs = 0

const lookLoop = (ts?: number) => {
	const now = ts ?? performance.now()
	const dt = lookLastTs ? Math.min((now - lookLastTs) / 1000, 0.05) : 0.016
	lookLastTs = now
	let spring: {k: number; c: number}
	if (headFollowActive) {
		const k = 500 * (Number(cfg.lookSens) || 0.2) + 40
		spring = {k, c: 1.5 * Math.sqrt(k)}
	} else {
		spring = SPRING_RETURN
	}
	lookVel.x += ((lookTarget.x - lookCur.x) * spring.k - lookVel.x * spring.c) * dt
	lookVel.y += ((lookTarget.y - lookCur.y) * spring.k - lookVel.y * spring.c) * dt
	lookCur.x += lookVel.x * dt
	lookCur.y += lookVel.y * dt
	// 注视点限幅: 弹簧带惯性, 但 lookCur 不允许冲出映射范围 (目标在半径圈内,
	// 位置允许 15% 过冲余量, 径向外推速度清零) —— 否则快速摸头会把头甩过界.
	// 限幅圆心 = 画布中心 (与 toLookTarget 的零位原点一致)
	{
		const n = canvasCenter()
		const R = lookRangeRadius() * 1.15
		const dx = lookCur.x - n.x
		const dy = lookCur.y - n.y
		const d = Math.hypot(dx, dy)
		if (d > R && d > 0) {
			const f = R / d
			lookCur.x = n.x + dx * f
			lookCur.y = n.y + dy * f
			const vr = (lookVel.x * dx + lookVel.y * dy) / d
			if (vr > 0) {
				lookVel.x -= (vr * dx) / d
				lookVel.y -= (vr * dy) / d
			}
		}
	}
	// 库的拖拽映射按画布 attribute 尺寸 (宽×renderScale) 归一化, 但输入按 ×DPR;
	// 乘以 renderScale/DPR 使比例恒为 1, 任何渲染分辨率下跟手都一致。
	// 系数与命中钩子/resizeCanvas 同源: 优先读库实际生效的 __noriRenderScale
	const rs = Number(window.__noriRenderScale) || Number(cfg.renderScale) || 1
	const dpr = window.devicePixelRatio || 1
	const K = rs / dpr
	const distT = Math.hypot(lookTarget.x - lookCur.x, lookTarget.y - lookCur.y)
	// 收尾混合 (修"半秒后突然归位"): 慢弹簧的长尾会让 resetLook 迟到一秒以上,
	// 库零位与映射零位的细微差被拖成肉眼可见的跳变 —— 距目标很近时切快速
	// 插值精准落点, 头部视觉归中后立即 resetLook, 不留长尾窗口
	if (!headFollowActive && distT < 14) {
		lookCur.x += (lookTarget.x - lookCur.x) * 0.22
		lookCur.y += (lookTarget.y - lookCur.y) * 0.22
		lookVel.x *= 0.6
		lookVel.y *= 0.6
	}
	try { l2d.lookAt(lookCur.x * K, lookCur.y * K) } catch { /* 忽略 */ }
	const speed = Math.hypot(lookVel.x, lookVel.y)
	const done = !headFollowActive && distT < 0.6 && speed < 4
	if (done) {
		lookRaf = 0
		lookVel = {x: 0, y: 0}
		lookLastTs = 0
		try { l2d.resetLook() } catch { /* 忽略 */ }
		return
	}
	lookRaf = requestAnimationFrame(lookLoop)
}

const startLookLoop = () => { if (!lookRaf) lookRaf = requestAnimationFrame(lookLoop) }

const startHeadFollow = (x: number, y: number) => {
	if (!ready.value) return
	headFollowActive = true
	headBase = {x, y}
	if (!lookInit) {
		lookInit = true
		lookCur = canvasCenter()
	}
	lookTarget = toLookTarget(x, y)
	startLookLoop()
	// 眼珠由库的 drag 源驱动 (与头部同一 feed, 见下方"视线跟随"说明), 无需单独驱动
	// 按住一段时间不松开 → 进入抚摸反馈
	if (strokeTimer) clearTimeout(strokeTimer)
	strokeTimer = setTimeout(() => {
		strokeTimer = null
		if (!headFollowActive) return
		stroking = true
		// 摸头表情: 交给专用循环（它自己判"是不是摸到头"、宽限期与收回）
		startPetExpressionLoop()
		// "刚摸到"的一记 (移植自网页版 w8e + h8e): 只在**摸到头**时响/冒
		if (onNoriHead) {
			petAudioTouch()
			spawnPetTouchBurst(headBase.x, headBase.y - 10)
			// 摸头台词: 与"摸到了"的音效**同源**（同一处边沿）⇒ 语义天然一致, 以后不会漂移。
			// 窗口/随机/去重都在 petSpeech.ts; 这里只管"该不该开口"与呈现（见 maybeSpeakPetLine）。
			maybeSpeakPetLine()
		}
		startSway()
	}, STROKE_DELAY)
}

const updateHeadLook = (x: number, y: number) => {
	if (!headFollowActive) return
	headBase = {x, y}
	if (stroking) return // 抚摸中由 sway 控制, 避免和目标抢
	lookTarget = toLookTarget(x, y)
}

/** 抚摸期间头部轻微摆动 (模拟"被摸得舒服、轻轻蹭" ) + 冒爱心
 *  幅度随连续抚摸时长渐强 (曲线在 petEffect.ts, 有单测); 频率恒定。 */
const startSway = () => {
	stopSway()
	swayPhase = 0
	strokeStartAt = Date.now()
	lastPetFxAt = 0
	const loop = () => {
		if (!headFollowActive || !stroking) return
		const now = Date.now()
		const amp = petSwayAmp(now - strokeStartAt)
		swayPhase += SWAY_SPEED
		const dx = Math.sin(swayPhase) * amp
		const dy = Math.cos(swayPhase * 1.3) * amp * 0.7
		/* 摸头时**保留视线追踪**: 注视目标仍然跟着手指(headBase), 只是叠一点"幅度渐强"的轻微摆动。
		   （摸头"低头"已按用户决定**删除** —— 它要么与库每帧写的注视通道抢参数、要么按下即满产生
		     "头部角度跳变"；现在摸头的反馈是**表情 + 台词**，见 petExpression.ts 与 petSpeech.ts。
		     实际数据留档在 docs/低头参数探针.md 与 backups\低头重做与参数归属护栏-20260924-232222\。） */
		lookTarget = toLookTarget(headBase.x + dx, headBase.y + dy)
		// 轻量特效: 从手指位置往上冒**柔光白粒子** (节流 + petEffect 内部有存活上限, 不会堆积)。
		// 只在**摸到头**时才冒 —— onNoriHead = 命中实体 且 落在头带内(部件几何算出来的)。
		// 否则摸手/摸脚/在 Nori 旁边的空白处按住都会冒粒子。
		// 每次只 1 颗、峰值透明度只有 0.42~0.66 —— 目标是"看得见但不突兀"。
		if (onNoriHead && now - lastPetFxAt >= PET_FX_INTERVAL_MS) {
			lastPetFxAt = now
			spawnPetMotes(headBase.x, headBase.y - 10, {count: 1})
		}
		swayRaf = requestAnimationFrame(loop)
	}
	swayRaf = requestAnimationFrame(loop)
}

const stopSway = () => {
	if (swayRaf) { cancelAnimationFrame(swayRaf); swayRaf = 0 }
}

/* ---------------- 视线跟随 (眼珠) ----------------
 * 设计说明: 库的每帧更新本身就会把 drag 值叠加进 ParamAngleX/Y 与 ParamEyeBallX/Y
 * (live2dEasyControl update: addParameterValueById(EyeBallX, dragX)),
 * 即眼珠天然跟随 lookAt 的喂点. 此前我们另起一套 gazeLoop 直接 setParam 写眼珠,
 * 与库的叠加写入双重驱动 —— 方向翻转设置只作用于头部 feed, 眼珠不跟随翻转,
 * 且松手后库的 dragX 随头部慢回正持续叠加, 造成"头已回正、眼还看向一侧,
 * 半秒后又突然归位"的错位观感. 现在删掉独立眼珠驱动, 眼/头同源同向:
 * 同一个 toLookTarget 喂点 (含方向翻转/模型框参考系), 天然同步回正. */

const endHeadFollow = () => {
	const wasActive = headFollowActive
	headFollowActive = false
	stroking = false
	onNoriHead = false
	if (strokeTimer) { clearTimeout(strokeTimer); strokeTimer = null }
	stopSway()
	// 抚摸会话结束: 复位采样器 + 让合成音归零 (对应网页版的 AK)。
	// 放在这里而不是 pointerup, 是因为"漏掉抬起事件"也要能收尾。
	petStroke.end()
	petAudioRelease()
	if (hitDebug.value) petDebugText.value = petStrokeDebug()
	// 头部回正: 回到"画布中心" —— 库的角度零位锚定在 device 中心, 归位即真零位,
	// resetLook 只是确认性的归零, 不会再出现"先停在某姿态、半秒后跳回正中"的二段跳
	if (wasActive) {
		lookTarget = canvasCenter()
		startLookLoop()
	}
}

const onStagePointerDown = (e: PointerEvent) => {
	stagePointers++
	ambientTouch()
	habitRecord("touch")
	const onUI = (elm: EventTarget | null): boolean =>
		!!(elm as HTMLElement)?.closest?.(".sheet, .dock, .topbar, .pet-fab, .chat-panel, .touch-editor, .touch-top, .pomo-widget")

	if (touchDrawing.value || touchAdjusting.value) {
		if (onUI(e.target)) return
		onDrawDown(e)
		return
	}

	if (panel.value !== "") { if (stagePointers > 1) endHeadFollow(); return }
	if (stagePointers > 1) { endHeadFollow(); return }

	if (onUI(e.target)) return
	// 留白/实体命中分流: 只有点在模型实体 (任意可见部件) 上才触发摸头判定;
	// 空白区域 = 只保留白点/粒子/视线跟随 (她在看你的手指, 但不算摸她)
	const hit = noriHitTest(e.clientX, e.clientY)
	strokeOnModel = !!hit && hit.hit
	if (hitDebug.value) hitZoneText.value = zoneText(hit)
	spawnTouchDot(e.pointerId, e.clientX, e.clientY)
	// 数据海星尘粒子: 触摸响应从**按下**这一刻开始（强度还要 350ms 渐入 ⇒ 不会一碰就动）。
	// 放在 `onUI` 闸门之后：点面板按钮不该搅动背景（与白点同规矩）。
	dataseaTouchStart(e.clientX, e.clientY)
	// "摸到头" = 命中实体 **且** 落在头区内 —— 这一刻先算一次, 之后由 pointermove 实时更新
	// (原来只在这里算一次, 导致"按上就一直算头上 / 按在别处就怎么移都不算")。
	refreshHeadBox()
	if (strokeOnModel) detector.onPointerDown(e)
	// AudioContext 必须在**真实用户手势**里解锁: 抚摸音是在指针移动 / setTimeout 里触发的,
	// 那两处不算手势 —— 那时才 new AudioContext() 会一直停在 suspended。
	// 摸到模型就预热(不必等到摸到头), 这样之后手指滑到头区时声音立刻就有。
	if (strokeOnModel) petAudioPrime()
	updateNoriHead(e.clientX, e.clientY, true)
	startHeadFollow(e.clientX, e.clientY)
}

const onStagePointerMove = (e: PointerEvent) => {
	// 只在"已按下"时有效（悬停/鼠标移动不算触摸；未按下时是空操作）
	dataseaTouchMove(e.clientX, e.clientY)
	if (touchDrawing.value || touchAdjusting.value) { onDrawMove(e); return }
	if (hitDebug.value) {
		const now = performance.now()
		if (now - lastHitDebugT > 150) {
			lastHitDebugT = now
			hitZoneText.value = zoneText(noriHitTest(e.clientX, e.clientY))
			petDebugText.value = petStrokeDebug()
		}
	}
	if (panel.value !== "" || stagePointers > 1) return
	moveTouchDot(e.pointerId, e.clientX, e.clientY)
	// 实时重判是否摸到头 (节流 100ms) —— 手指可以随时滑进/滑出头区
	updateNoriHead(e.clientX, e.clientY)
	if (strokeOnModel) detector.onPointerMove(e)
	// **必须先真的按着**: `pointermove` 在鼠标悬停时也会派发 (buttons=0), 而抚摸的采样/音效/
	// 特效原先只判 `onNoriHead` —— 于是"鼠标指针划过 Nori 头顶"就会冒粒子、响音 (实机/浏览器实测:
	// 悬停 1.44s 冒了 5 颗粒子 + 3 火花 + 3 涟漪)。用户要求: 只有真正按下才触发。
	const pressed = stagePointers > 0
	if (pressed && onNoriHead) {
		// 抚摸采样: 合格的移动 → 摩擦音随速度变响变亮; 累计满 requiredMs → 完成一次
		const p = petStrokePoint(e.clientX, e.clientY)
		const s = petStroke.move(performance.now(), p.x, p.y)
		if (s.qualifying) { petLastVx = s.velocityX; petAudioStroke(s.velocityX) }
		// 累计满 requiredMs = 完成一次: 奖励爆发 (网页版 p8e) + 双段音效 (网页版 S8e)
		if (s.completed) {
			petCompletions += 1
			petAudioComplete()
			spawnPetComplete(e.clientX, e.clientY)
		}
	}
	updateHeadLook(e.clientX, e.clientY)
}

const onStagePointerUp = (e: PointerEvent) => {
	stagePointers = Math.max(0, stagePointers - 1)
	removeTouchDot(e.pointerId)
	// 抬手/取消都要收尾（pointercancel 也接到这里）—— 否则状态机会一直停在"按着"
	dataseaTouchEnd()
	strokeOnModel = false
	// **收尾必须在面板判断之前**: 原先 `panel !== ""` 直接 return, 于是"摸头途中面板被打开、
	// 抬手事件正好被这一条吞掉"时, stroking/headFollowActive 会永远停在 true ——
	// 之后鼠标**悬停**划过头部就会把"刚摸到"的那一记(触到音 + 火花涟漪)反复重放。
	// endHeadFollow 本身只是复位状态 + 让注视回正, 与面板是否可见无关, 放在这里不会误伤面板逻辑。
	endHeadFollow()
	if (touchDrawing.value || touchAdjusting.value) { onDrawUp(); return }
	if (panel.value !== "") return
	detector.onPointerUp(e)
}

/** 加载/下载中的守卫: pick() 原先无守卫, 快速点两个模型会并发两次 loadModel →
 *  第二次 ensureModel 覆盖第一次的全局回调 → 第一个 Promise 永久挂起。
 *  这里直接拦住重入 (面板里连点也不会再产生并发)。 */
let modelSwitching = false

const loadModel = async () => {
	const id = currentModelId.value
	if (!id) return
	if (modelSwitching) return   // 已有切换在途: 忽略这次 (避免并发覆盖下载回调)
	modelSwitching = true
	// 离线/列表失败时模型不在 modelList 里, 用 id 兜底 (名字仅用于下载进度显示)
	const model = modelList.value.find((m) => m.id === id)
	const name = model?.name ?? id
	loading.value = true; error.value = ""; ready.value = false
	motions.value = []; expressions.value = []
	try {
		loadingMsg.value = `下载 ${name}…`
		const entryBase = await ensureModel(id, name)
		loadingMsg.value = "加载中…"
		await l2d.destroy()
		// 换模型后重置注视状态 (眼珠由库 drag 源驱动, 随模型重建自动归位)
		lookInit = false
		lookRaf = 0
		await l2d.mount({directory: id, fileBase: entryBase}, {canvasWidth: "100%", canvasHeight: "100%", host: l2dHost.value})
		scale.value = (await readModelConfig(id, "l2d_scale", (v) => (typeof v === "number" ? v : parseFloat(String(v))), 1)) || 1
		offsetX.value = (await readModelConfig(id, "l2d_offset_x", (v) => (typeof v === "number" ? v : parseFloat(String(v))), 0)) || 0
		offsetY.value = (await readModelConfig(id, "l2d_offset_y", (v) => (typeof v === "number" ? v : parseFloat(String(v))), 0)) || 0
		await nextTick()
		relayout()
		motions.value = (await readMotionGroups(id, entryBase)) ?? []
		expressions.value = await readExpressionNames(id, entryBase)
		const runtime = await l2d.getMotions()
		if (runtime && runtime.length) motions.value = runtime
		ready.value = true
		loadTouchForModel(id)
	} catch (e: any) {
		error.value = e?.message ?? String(e)
	} finally {
		loading.value = false
		modelSwitching = false   // 释放守卫 (必须在 finally: 失败/超时路径也要放)
	}
}

/** 「选模型」的落地点：记选择 → 落盘 → 加载（已装=直接切；没装=走 ensureModel 下载）。
 *  抽出来是因为它现在有两个入口：已装的直接走 / 没装的要等答题门放行。 */
const applyModelPick = (id: string): void => {
	currentModelId.value = id
	// 2026-09-30 修：把选择**落盘**，否则重启会回到"已装列表第一个"（用户报的 bug）
	cfg.live2dModel = id
	persistSettings()
	panel.value = ""
	loadModel()
}

/** 点「选择模型」里的卡片：已装的直接切；**没装的那只，点它就是要下载** ——
 *  和「一键克隆」同一道「模型授权验证」，答对才真的开始下载（答错/取消都不下载）。
 *  下载逻辑本身没动：放行后仍是 loadModel → ensureModel → NoriBridge.download（原生 ModelBridge，
 *  源 https://fc39e5fc.pinme.dev 未改）。 */
const pick = (id: string): void => {
	if (id === currentModelId.value && ready.value) return
	void (async () => {
		if (await getInstalled(id)) { applyModelPick(id); return }
		openGate("model", () => applyModelPick(id))
	})()
}

const doMotion = (group: string, i: number) => {
	void l2d.playMotionByIndex(group, i)
	// 手动从「动作列表」触发的动作同样是 Loop:true, 也会一直保持 —— 一并安排回中性
	scheduleReturnToNeutral(returnToNeutral)
}

const playRand = () => {
	if (panel.value === "motion") { panel.value = ""; return }
	panel.value = "motion"
}

const playExpr = () => {
	if (panel.value === "expression") { panel.value = ""; return }
	if (!expressions.value.length) {
		l2d.playMotionByIndex("Idle", 0)
	} else {
		panel.value = "expression"
	}
}

/** 落盘(本实例防抖写)后从磁盘重载记忆 cache 并刷新视图 —— 双实例可见性:
 *  悬浮窗等另一 WebView 写入的新记忆, 本实例不重读就看不到 ("悬浮窗聊的没记住" 的根因之一) */
const refreshMemFromDisk = () => {
	void flushMemoryPersist().then(() => {
		reloadMemory()
		refreshMemView()
	})
}

const openPanel = (p: P) => {
	// 打开/关闭任何面板都重置"记忆库入口"的连击计数 —— 否则计数会跨场景累积
	// (用户点两下入口、去别的面板逛一圈、回来点一下就直接进去了)
	resetMemEntryGate()
	// 打开设置/记忆库时: 先刷新(重读磁盘)再显示, 否则看到的是启动时的旧快照
	if (p === "settings" || p === "memories") {
		refreshMemFromDisk()
		if (p === "memories") { memSearch.value = ""; memFilter.value = "" }
	}
	if (p === "diary") refreshDiaryView()
	panel.value = panel.value === p ? "" : p
}



const gesture = reactive<Record<number, {x: number; y: number}>>({})
let pinchBase = {dist: 0, midX: 0, midY: 0, scale: 1, ox: 0, oy: 0}


const isUI = (t: Touch): boolean =>
	!!(t.target as HTMLElement)?.closest?.(".sheet, .chat-panel, .dock, .topbar")

const onTouchStart = (e: TouchEvent) => {
	for (const t of Array.from(e.touches)) {
		if (isUI(t)) continue
		gesture[t.identifier] = {x: t.clientX, y: t.clientY}
	}
	if (Object.keys(gesture).length === 2) {
		const [a, b] = Object.values(gesture)
		pinchBase = {
			dist: Math.hypot(a.x - b.x, a.y - b.y),
			midX: (a.x + b.x) / 2,
			midY: (a.y + b.y) / 2,
			scale: scale.value,
			ox: offsetX.value,
			oy: offsetY.value,
		}
	}
}

const onTouchMove = (e: TouchEvent) => {
	for (const t of Array.from(e.touches)) gesture[t.identifier] = {x: t.clientX, y: t.clientY}
	const pts = Object.values(gesture)
	if (pts.length !== 2) return
	const [a, b] = pts
	const dist = Math.hypot(a.x - b.x, a.y - b.y)
	const midX = (a.x + b.x) / 2
	const midY = (a.y + b.y) / 2
	if (pinchBase.dist > 0) {
		scale.value = clamp(pinchBase.scale * (dist / pinchBase.dist), 0.3, 3)
	}
	
	offsetX.value = clamp(pinchBase.ox + (midX - pinchBase.midX), -500, 500)
	offsetY.value = clamp(pinchBase.oy + (midY - pinchBase.midY), -800, 400)
	relayout()
	scheduleSaveTransform()
}

const onTouchEnd = (e: TouchEvent) => {

	const liveSet = new Set(Array.from(e.touches).map((t) => t.identifier))
	for (const id of Object.keys(gesture)) {
		if (!liveSet.has(Number(id))) delete gesture[Number(id)]
	}
	if (Object.keys(gesture).length !== 2) pinchBase = {dist: 0, midX: 0, midY: 0, scale: 1, ox: 0, oy: 0}
	// 手势结束: 把节流期间挂起的变换立即落盘 (拖动/缩放的最终位置不丢)
	if (transformSaveTimer) { clearTimeout(transformSaveTimer); transformSaveTimer = null }
	if (transformDirty) { transformDirty = false; saveTransform() }
}

/** 拖动/缩放中节流保存: touchmove 每帧同步写 3 个 localStorage 键会掉帧,
 *  移动中最多 400ms 落一次盘, 手势结束 (onTouchEnd) 再兜底写最终值 */
let transformSaveTimer: ReturnType<typeof setTimeout> | null = null
let transformDirty = false
const scheduleSaveTransform = (): void => {
	transformDirty = true
	if (transformSaveTimer) return
	transformSaveTimer = setTimeout(() => {
		transformSaveTimer = null
		if (transformDirty) {
			transformDirty = false
			saveTransform()
		}
	}, 400)
}

const saveTransform = () => {
	const id = currentModelId.value
	if (!id) return
	writeModelConfig(id, "l2d_scale", scale.value)
	writeModelConfig(id, "l2d_offset_x", offsetX.value)
	writeModelConfig(id, "l2d_offset_y", offsetY.value)
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))



const rippleHost = ref<HTMLElement | null>(null)

const spawnRipple = (e: Event) => {
	const btn = (e.target as HTMLElement).closest<HTMLElement>(".ripple")
	if (!btn) return
	const rect = btn.getBoundingClientRect()
	const m = e as MouseEvent
	const span = document.createElement("span")
	const d = Math.max(rect.width, rect.height) * 2
	span.className = "ripple-el"
	span.style.width = span.style.height = `${d}px`
	span.style.left = `${m.clientX - rect.left - d / 2}px`
	span.style.top = `${m.clientY - rect.top - d / 2}px`
	btn.appendChild(span)
	setTimeout(() => span.remove(), 600)
}



const chatOpen = ref(false)
const draft = ref("")
const typing = ref(false)
/** 是否正在流式生成回复 (用于隐藏重复的"…"气泡) */
const chatStreaming = ref(false)
/** 触摸触发对话是否正在流式 (防重入锁; 用 ref 供输入排队的 watch 观察) */
const touchStreaming = ref(false)
/** 当前流式请求的取消控制器 (停止生成按钮用) */
let activeChatAbort: AbortController | null = null
/** 触摸触发对话的取消控制器 (与聊天输入的 activeChatAbort 并行, 都归停止按钮管) */
let activeTouchAbort: AbortController | null = null

/** 留白/实体命中调试 (测试工具): 开启后在屏幕顶部显示当前触摸命中的区域 */
const hitDebug = ref(false)
const hitZoneText = ref("")
/** 调试显示的抚摸状态 (进度/完成次数/速度), 与 hitZoneText 同一处节流刷新 */
const petDebugText = ref("")
let strokeOnModel = false
let lastHitDebugT = 0

/* ---------------- 抚摸采样与音效 (移植自网页版 headPat) ----------------
 * 网页版把"摸头"定义成: 横向为主 + 速度够快的移动, **累计满 1000ms 算完成一次**,
 * 每完成一次给一记"完成音"(之前安卓端只有"按住 260ms 就进入抚摸", 没有完成的概念)。
 * 单位说明: 网页版用**头宽**当单位, 头包围盒要等 Phase 3a 的探测钩子才有;
 * 这里先用**屏幕短边**当单位, 所以 minSpeedX 按"头宽≈短边的 1/3"换算(0.05→0.02)。 */
const petStrokeTuning = {...DEFAULT_PET_STROKE_TUNING, minSpeedX: 0.02}
const petStroke = createPetStrokeDetector(() => petStrokeTuning)
/** 本次会话累计完成次数 (只用于调试显示) */
let petCompletions = 0
/** 最近一次合格采样的横向速度 (单位: 短边/秒; 只用于调试显示) */
let petLastVx = 0
/** 最近一次算出的头部盒 (model 坐标; 供调试显示与探针断言) */
let petHeadBox: PetPartBox | null = null
/** 最近一次算出的**全模型盒** (model 坐标) —— 头区兜底比例靠它算 */
let petModelBox: PetPartBox | null = null
/** 最近一次按下的模型坐标 y (调试显示用) */
let petLastModelY = NaN
/** 几何是否可用 (钩子缺失/抛错时为 false → 判定兜底为"按实体") */
let petGeomOk = false
/** 本次按下是否落在**头部带**内 (实体命中 **且** 在头带里)。
 *  注意与 `strokeOnModel` 分开: 后者是"命中实体", 还要继续供**用户配置的触摸区**做判定 ——
 *  把触摸区也限制成"只有头"会误伤手/肚皮等其它区域。 */
let onNoriHead = false
/** 最近一次按下的头部判定结果 (onNoriHead 会在 endHeadFollow 里清掉, 这个留着供调试/探针看) */
let lastOnHead = false
const petStrokeUnit = (): number => Math.max(120, Math.min(window.innerWidth || 0, window.innerHeight || 0))
/** 屏幕坐标 → 采样器坐标 (除以短边 ⇒ 阈值与分辨率/机型无关) */
const petStrokePoint = (x: number, y: number): {x: number; y: number} => {
	const u = petStrokeUnit()
	return {x: x / u, y: y / u}
}
/** 取模型几何 → 算头盒。几何来自补丁钩子 __noriPartProbe (部件盒 + 全模型盒, 与命中点同坐标系)。
 *  每次按下算一次 —— 实测开销是 248 个 drawable 的顶点遍历(毫秒级), 只在 pointerdown 走一次。 */
const refreshHeadBox = (): void => {
	const probe = (window as unknown as {__noriPartProbe?: () => {ok?: boolean; parts?: {box: PetPartBox}[]; allBox?: PetPartBox} | null}).__noriPartProbe
	if (typeof probe !== "function") { petHeadBox = null; petModelBox = null; petGeomOk = false; return }
	try {
		const g = probe()
		if (!g?.ok || !Array.isArray(g.parts)) { petHeadBox = null; petModelBox = null; petGeomOk = false; return }
		petModelBox = g.allBox ?? null
		petHeadBox = pickHeadBox(g.parts.map((p) => p.box), petModelBox)
		petGeomOk = !!petModelBox
	} catch {
		petHeadBox = null
		petModelBox = null
		petGeomOk = false
	}
}
/** 当前 canvas 的 CSS 变换视图 (与 relayout 写进 canvas.style 的一致) */
const canvasView = (): {w: number; h: number; scale: number; offsetX: number; offsetY: number} => ({
	w: window.innerWidth || 0,
	h: window.innerHeight || 0,
	scale: scale.value,
	offsetX: offsetX.value,
	offsetY: offsetY.value,
})

/** 屏幕点 → 模型坐标 (补丁钩子), 拿不到返回 null */
const noriModelPoint = (x: number, y: number): {x: number; y: number} | null => {
	const fn = (window as unknown as {__noriModelPoint?: (x: number, y: number) => {x?: number; y?: number} | null}).__noriModelPoint
	if (typeof fn !== "function") return null
	try {
		// 关键: 命中钩子走库的 transformView, 它不知道 canvas 上的 CSS 变换(scale/offset),
		// 所以必须先把 client 坐标逆变换回未变换的画布坐标系, 否则缩放/平移后判定与渲染错位。
		const p0 = canvasPointFromClient(x, y, canvasView())
		const p = fn(p0.x, p0.y)
		return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? {x: p.x as number, y: p.y as number} : null
	} catch {
		return null
	}
}
/** 实时重判"是否摸到头"的节流间隔 (ms)。
 *  实体命中要遍历全部 drawable, 每帧(120Hz)跑不划算; 10Hz 对"移进去/移出来"完全够用, 手感无差。 */
const PET_HEAD_CHECK_MS = 100
let lastHeadCheckAt = 0

/**
 * 实时重判"是否摸到头"(含 6% 迟滞), 并处理**进入/离开的边沿动作**。
 *
 * ## 为什么必须实时
 * 原来只在 `pointerdown` 算一次 ⇒ 按下时在头上就**整段按压都算头上**(移开也不停),
 * 按下时不在头上就**怎么移都不算** —— 你反馈的两个现象是同一个原因。
 * 网页版 `T2()` 是每个事件都重算的: `r = hitTestParts(...)` 与 `s = Ly(...)` 都在 move 里算,
 * 且"已经在摸"之后改用外扩的 leash 框判是否还在摸。
 *
 * 边沿动作:
 *  - 进入 → 采样从这一刻开始 + 一记"摸到了"的反馈(触到音 + 接触爆发; 只在已经进入抚摸状态时)
 *  - 离开 → 采样复位 + 摩擦音归零(保留完成音的第二段尾巴)
 */
const updateNoriHead = (x: number, y: number, force = false): void => {
	const now = performance.now()
	if (!force && now - lastHeadCheckAt < PET_HEAD_CHECK_MS) return
	lastHeadCheckAt = now
	const mp = noriModelPoint(x, y)
	petLastModelY = mp ? mp.y : NaN
	let inHead = false
	if (!petGeomOk) {
		// 几何拿不到: 兜底为"按实体"(调试行显示「无几何→按实体」), 否则表现为怎么摸都没反应
		const hit = noriHitTest(x, y)
		inHead = !!hit && !!hit.hit
	} else if (mp) {
		const zone = inHeadZoneHysteresis(petHeadBox, petModelBox, mp.x, mp.y, onNoriHead)
		if (zone) {
			// **进入**才要求命中实体; **已经在摸**时只要求还在(有界 leash 盒内的)头区 —— 与网页版一致:
			// 它"已经在摸"的阶段只用外扩盒子 E8e 判, 不再查 drawable。
			// 少了这一条会怎样: 在头顶那种很窄的地方左右摸, 手指稍一滑出轮廓就判"头外"→
			// 采样被 end() 复位 → 进度永远攒不到 1s(实测踩过)。
			inHead = onNoriHead ? true : !!(noriHitTest(x, y)?.hit)
		}
	}
	if (inHead === onNoriHead) return
	onNoriHead = inHead
	lastOnHead = inHead
	if (inHead) {
		const p = petStrokePoint(x, y)
		petStroke.start(performance.now(), p.x, p.y)
		// 滑进头区也要把表情循环拉起来（用户可能从身体开始摸、再滑到头）
		startPetExpressionLoop()
		// 已经进入抚摸状态 + **指针真的按着**才补反馈: pointerdown 那一刻由上方的 stroking 定时器负责。
		// `stagePointers > 0` 这道闸是 2026-09-26 加的 —— `pointermove` 在鼠标悬停时也会派发(buttons=0),
		// 而"进入头区"这个边沿原先只看 stroking ⇒ 悬停划过就能冒粒子/响音(浏览器实测)。
		if (stroking && stagePointers > 0) {
			petAudioTouch()
			spawnPetTouchBurst(x, y - 10)
			// 与上面同源的第二处"确认摸到头"边沿（从身体滑进头区, 或按下后第一次判到头）
			maybeSpeakPetLine()
		}
	} else {
		petStroke.end()
		petAudioRelease(true)
	}
}

/** 读回一个模型参数 (补丁钩子 __noriGetParam); 钩子缺失/出错返回 null */
const readParam = (id: string): number | null => {
	const fn = (window as unknown as {__noriGetParam?: (id: string) => number | null}).__noriGetParam
	if (typeof fn !== "function") return null
	try {
		const v = fn(id)
		return typeof v === "number" && Number.isFinite(v) ? v : null
	} catch {
		return null
	}
}

const petStrokeDebug = (): string => {	const line = headZoneLine(petHeadBox, petModelBox)
	const zone = !petGeomOk ? "无几何→按实体" : onNoriHead ? "头上" : "头外"
	const yTxt = Number.isFinite(petLastModelY) ? petLastModelY.toFixed(2) : "?"
	const lineTxt = line === null ? "?" : line.toFixed(2)
	return `抚摸 ${(petStroke.progressMs / 1000).toFixed(1)}/${(petStrokeTuning.requiredMs / 1000).toFixed(1)}s · 完成 ${petCompletions} · 速度 ${petLastVx.toFixed(2)} · ${zone}(y${yTxt} 线${lineTxt})`
}
/** E2E / 实机调试探针: 音效图状态 + 抚摸采样状态 (纯读, 不会建图)。
 *  实机上没有 adb 时, 也可以在控制台里手敲 `__noriPetDebug()` 看进度。 */;(window as unknown as {__noriPetDebug?: () => unknown}).__noriPetDebug = () => ({
	...petAudioState(),
	progressMs: petStroke.progressMs,
	completions: petCompletions,
	velocity: petLastVx,
	active: petStroke.active,
	/** 实时的"是否摸到头" —— 这才是判定本体 (抬手后会归 false) */
	onHead: onNoriHead,
	/** 最近一次头部决策的快照 (抬手后不清, 供调试对照) */
	lastHead: lastOnHead,
	onModel: strokeOnModel,
	headBox: petHeadBox,
	modelBox: petModelBox,
	bandLine: headZoneLine(petHeadBox, petModelBox),
	geomOk: petGeomOk,
	modelY: petLastModelY,
	/** 参数读回 (补丁 __noriGetParam)：`angleY` = 库每帧写的"注视"通道（只读对照） */
	angleY: readParam("ParamAngleY"),
	/** 眨眼: 累计次数 + 当前闭合量 (0=睁 1=全闭) —— 实机/ E2E 确认"真的在眨" */
	blinkCount: blinkCount(),
	blinkClosure: blinkClosureNow(),
	eyeLOpen: readParam("ParamEyeLOpen"),
	eyeROpen: readParam("ParamEyeROpen"),
	/** 摸头表情: 当前这张脸与是否在展示 (E2E/实机确认"摸头时播的是 shy/smile") */
	petExpression: petExpressionName(),
	petExpressionOn: petExpressionShowing(),
	/** 摸头表情的**客观证据**: 两个表情各自独占的参数（Shy→ParamCheek, Smile→ParamEyeSmile）
	 *  —— 只看我们自己的变量等于自证，读参数才能证明"表情真的生效了"。
	 *  注: 不用 `ParamEyeLSmile`（旧 happy 的独占参数）—— 实测 ARGNori **没有这个参数**
	 *  （`13_Happy.exp3.json` 引用了一堆不存在的 `ParamBrowL*`/`ParamEyeLSmile`，所以旧实现
	 *   在这模型上几乎是空操作）。这也是"不能靠表情名自证"的又一个理由。 */
	petExprCheek: readParam("ParamCheek"),
	petExprEyeSmile: readParam("ParamEyeSmile"),
	/** 摸头台词: 说了几句 / 最后一句 / 距离"可以再说"还差多少 ms(0 = 现在就能说)。
	 *  只反映**真的开口过**的次数 —— 被"正在朗读/生成中"跳过的那次**不计数也不消耗窗口**。 */
	petSpeechCount: petSpeechCount(),
	petSpeechLast: petSpeechLastLine(),
	petSpeechWaitMs: petSpeechWaitMs(performance.now()),
	/** 当前按下的手指数 (stagePointers) —— "指针事件被吞掉"这类问题只能靠它看出来 */
	pressed: stagePointers,
	/** 抚摸状态机的三个内部标志 —— 排查"没按下也冒特效"时必须能看到它们:
	 *  stroking 只在"按下后 260ms 仍在跟随"时置位, 抬手由 endHeadFollow 清掉。 */
	stroking,
	headFollow: headFollowActive,
	swayRaf: swayRaf !== 0,
})
/** E2E 探针: 走**已修正**的屏幕→模型坐标换算 (含 canvas CSS 变换逆变换)。
 *  与"触摸区路径"(用 getBoundingClientRect, 本来就跟着渲染走)做交叉验证, 才抓得住
 *  "缩放/平移后判定与渲染错位"这类问题 —— 只在默认 scale=1/offset=0 下测是抓不住的。 */
;(window as unknown as {__noriModelPointFixed?: unknown}).__noriModelPointFixed = (x: number, y: number) => noriModelPoint(x, y)
;(window as unknown as {__noriCanvasView?: unknown}).__noriCanvasView = () => canvasView()
/** E2E 探针: 粒子累计生成数 (确定性证据, 不受粒子寿命/采样时机影响) */
;(window as unknown as {__noriPetFxSpawned?: unknown}).__noriPetFxSpawned = () => petFxSpawned()
// 眨眼: 装上"库 update() 之前"的钩子 (由 beforeUpdate 调度器统一分发)
installBlink()
/** 模型实体命中测试 (补丁钩子 __noriHitTest): hit=落在模型实体上, err=钩子内部异常 (调试透传), null=钩子未就绪 */
const noriHitTest = (x: number, y: number): {hit: boolean; err?: string} | null => {
	try {
		const fn = (window as unknown as {__noriHitTest?: (x: number, y: number) => {hit: boolean; err?: string} | null}).__noriHitTest
		if (typeof fn !== "function") return null
		// 同 noriModelPoint: 库的命中判定不知道 canvas 的 CSS 变换, 必须先逆变换回未变换画布坐标系。
		// 否则双指缩放/平移模型后, 判定会与渲染整体错位(在模型旁边的空白处也算"命中实体")。
		const p = canvasPointFromClient(x, y, canvasView())
		return fn(p.x, p.y)
	} catch {
		return null
	}
}
const zoneText = (hit: {hit: boolean; err?: string} | null): string =>
	!hit ? "未知" : hit.err ? "异常:" + hit.err : hit.hit ? "实体" : "留白"
/** 用户点了"停止生成": onError 里据此区分"用户停止"与"真失败" (不再只靠文案匹配) */
let stopRequested = false

/** 停止生成 (本地取消 + 原生桥 chatStop): 同时停聊天流与触摸触发流, 并停朗读 */
const stopGenerate = () => {
	stopRequested = true
	if (activeChatAbort) {
		activeChatAbort.abort()
		activeChatAbort = null
	}
	if (activeTouchAbort) {
		activeTouchAbort.abort()
		activeTouchAbort = null
	}
	stopTTS()
	cancelChatStream()
}
const messages = ref<ChatMsg[]>([])
const dataseaCanvas = ref<HTMLCanvasElement | null>(null)
const chatScroll = ref<HTMLElement | null>(null)
const modelOptions = ref<string[]>([])
const modelLoadMsg = ref("")

const cfg = reactive({
	apiKey: "",
	baseUrl: "https://api.openai.com/v1",
	model: "",
	/** 上次选的 Live2D 模型 id (空 = 没选过 ⇒ 启动用已装列表第一个)。
	 *  2026-09-30 修：以前没存这个，换模型后重启会回到列表第一个。 */
	live2dModel: "",
	bubbleScale: 1,
	bubbleWidth: 82,
	renderScale: 1,
	/** Live2D 渲染帧率档位 (0 = 不限制)。档位定义见 services/live2d/frameCap.ts */
	l2dFps: 60,
	ttsEnabled: false,
	ttsProvider: "fish" as "fish" | "cosyvoice",
	ttsApiKey: "",
	ttsBaseUrl: "https://api.fish.audio",
	ttsReferenceId: "",
	ttsModel: "s2.1-pro",
	ttsFormat: "mp3",
	ttsChunkLength: 120,
	ttsLatency: "balanced",
	cosyApiKey: "",
	cosyBaseUrl: "https://dashscope.aliyuncs.com",
	cosyModel: "cosyvoice-v3.5-flash",
	cosyVoice: "",
	cosyRate: 1,
	ttsVolume: 1,
	bgmEnabled: false,
	bgmTrack: "random",
	bgmVolume: 0.35,
	sfxVolume: 0.5,
	dataseaBg: true,
	/** 让 Nori 知道当前时间（2026-10-01）：每次对话在人格之后追加一个时间块；关掉即回到以前 */
	timeAware: true,
	ambientEnabled: true,
	quietMode: "off",
	quietOn: false,
	cosyCloneVoices: [] as CosyCloneVoice[],
	trimHistory: true,
	memoryLlmExtract: true,
	/** 实时(逐句)记忆提取: 重构 P3 起默认关, 记忆由历史总结一次产出 (见 services/memory) */
	memoryRealtimeExtract: false,
	/** 自动优化记忆示例 (默认关; 见设置里「记忆优化」小节) */
	memoryAutoTuneExamples: false,
	/** 记忆诊断日志 (默认关; 只留内存, 导出才落盘 —— 见 P1「观测闭环」) */
	memoryDiagnostics: false,
	smartRecall: true,
	emotionLlm: true,
	/** DeepSeek 思考模式: **默认开**（2026-10-02 用户纠正）。服务端默认也是开的,
	 *  但只有把开关**显式**传出去, 这个勾选框才真的能关掉它 —— 见 services/chat 的 resolveThinking */
	deepseekThinking: true,
	lookFlipX: false,
	lookFlipY: false,
	lookSens: 0.2,
	floatEnabled: false,
	floatBubbleW: 82,
	floatRenderScale: 2,
})


const chatFontPX = computed(() => `${14 * (Number(cfg.bubbleScale) || 1)}px`)

const bubbleScaleNum = computed(() => Number(cfg.bubbleScale) || 1)

const bubbleWidthNum = computed(() => Number(cfg.bubbleWidth) || 82)

const renderScaleNum = computed(() => Number(cfg.renderScale) || 1)

const nativeDpr = computed(() => Math.max(1.5, Math.min(window.devicePixelRatio || 2, 3)))


const applyRenderScale = () => l2d.setRenderScale(renderScaleNum.value)

/* ---- 渲染帧率档位（Live2D 形象 + 数据海背景，同一个旋钮） ---- */
/** 当前档位 (非法值回落默认档)。0 显示为"不限" */
const l2dFpsNum = computed(() => normalizeFps(cfg.l2dFps))
/** 一处生效: 形象与背景**共用**同一个门限（都用 frameCap.frameThreshold 算） */
const applyL2dFps = () => {
	l2d.applyFrameCap(l2dFpsNum.value)
	setDataseaFps(l2dFpsNum.value)
}
/** 档位按钮文案 */
const l2dFpsLabel = (v: number): string => (v === 0 ? "不限" : `${v}`)
/** 切换档位: 立即生效 + 落盘 */
const setL2dFps = (v: number): void => {
	cfg.l2dFps = normalizeFps(v)
	applyL2dFps()
	persistSettings()
}

const curModelName = computed(() => cfg.model || "未配置模型")

const storageReady = ref(false)
const storagePath = ref("Download/NoriDroid")
/**
 * 外观风格: "soft" = 只保留**色板**的柔和风（**2026-10-01 起默认** —— 用户定稿「默认 UI 改成柔和」）;
 *            "pixel" = 网页版像素风（硬边/直角/斜纹），不再作为默认，但保留为可切换项做 A/B。
 *
 * 为什么还留着开关: 两种风格的取舍要在**真机上看**，一个包里带两套样式，用 `?ui=soft` / `?ui=pixel`
 * 或设置页按钮即可切换，不必来回刷两次固件。用户手动切过的记在 localStorage（`ui_style`）里，
 * 所以"改默认值"只影响没选过的人。只影响 class，不参与任何业务逻辑。
 */
const uiSoft = ref(true)
try {
	const q = new URLSearchParams(location.search).get("ui")
	const saved = localStorage.getItem("ui_style")
	if (q === "soft" || q === "pixel") uiSoft.value = q === "soft"
	else if (saved === "soft") uiSoft.value = true
} catch { /* 忽略 */ }
const toggleUiStyle = (): void => {
	uiSoft.value = !uiSoft.value
	try { localStorage.setItem("ui_style", uiSoft.value ? "soft" : "pixel") } catch { /* 忽略 */ }
	playSfx()
	triggerBubble(uiSoft.value ? "外观：柔和（新色板）" : "外观：像素风", 2200)
}
/** 存储自检结果 (原始 JSON, 便于直接截图/复制给开发者) */
const storageProbeMsg = ref("")
/** 是否已获得「所有文件访问权限」(Android 11+; 读写公共目录要靠它) */
const allFilesAccess = ref(false)

/** 跳到系统设置授予「所有文件访问权限」; 回来时 onVisibility 会重新刷新状态 */
const doRequestAllFiles = () => {
	requestAllFilesAccess()
	triggerBubble("请在系统设置里打开「允许管理所有文件」，然后返回这里点「自检」", 4200)
}

/**
 * 存储自检: 逐个问原生"公共目录里这个文件到底什么情况"。
 * 排查"卸载重装后原有内容读不到"——要区分三种情况: ①磁盘上根本没文件(系统删了)
 * ②文件在, 但 MediaStore 行不属于本应用(有「所有文件访问权限」时能直读回来) ③直读被系统挡住。
 */
const doStorageProbe = () => {
	const names = ["chat.json", "memory.json", "settings.json", "diary.json"]
	const lines: string[] = []
	let access = allFilesAccess.value
	for (const n of names) {
		const raw = probePublicFiles(n)
		try {
			const o = JSON.parse(raw) as Record<string, unknown>
			access = !!o.allFilesAccess
			lines.push(
				`${n}\n` +
				`  磁盘上存在: ${o.onDisk ? `是(${o.fileBytes} 字节)` : "否"}  可直读: ${o.fileReadable ? "是" : "否"}\n` +
				`  MediaStore 可见: ${o.inMediaStore ? `是(${o.mediaStoreBytes} 字节)` : "否"}\n` +
				`  所有文件访问权限: ${o.allFilesAccess ? "是" : "否"}\n` +
				`  目录: ${o.dir}  存在=${o.dirExists} 可读=${o.dirReadable}\n` +
				`  目录内容: ${JSON.stringify(o.listed)}`
			)
		} catch {
			lines.push(`${n}\n  ${raw}`)
		}
	}
	allFilesAccess.value = access
	storageProbeMsg.value = lines.join("\n\n")
	storagePath.value = getStorageDir()
}

/* ---------------- 自定义人设（2026-10-01 用户要求）----------------
 * 用户导入自己的提示词替代内置 `nori-prompt.md`; 内容存在本机 `persona.md`（见 services/chat）。
 * 这里只管**设置面板顶部那行的显示与两个按钮**; 真正取用哪份人设是 chat 里的 personaPrompt()。
 * ⚠ `personaName` 只在内存里（文件名不落盘）—— 重开 App 后只知道「有自定义」, 不知道原来叫什么。 */
const personaName = ref("")
const personaCustom = ref(false)
const personaChars = ref(0)
const personaMsg = ref("")
const personaMsgOk = ref(false)

/** 状态行文案（2026-10-01 起**没有内置人设**）: 「未设置人设…」/「当前：自定义（文件名）· N 字」 */
const personaStateText = computed(() =>
	personaCustom.value
		? `当前：自定义${personaName.value ? `（${personaName.value}）` : ""} · ${personaChars.value} 字`
		: `未设置人设 —— 点「导入文件」选一份人设文案（不导入的话 Nori 没有人格设定）`
)

/** 重读自定义人设, 刷新那行状态 (启动时与导入/恢复后各调一次) */
const refreshPersonaState = () => {
	const t = loadCustomPersona()
	personaCustom.value = !!t
	personaChars.value = t ? t.length : 0
	if (!t) personaName.value = ""
}

/** 导入文案人设: 系统文件选择器 → 存 `persona.md` → 之后每轮对话都用它 */
const doImportPersona = async () => {
	personaMsg.value = ""
	const r = await pickPersonaFile()
	if (!r.ok) {
		personaMsgOk.value = false
		// 用户在系统选择器里点了返回 —— 这不算错误, 不弹气泡, 只说一句
		personaMsg.value = r.message ?? "未选择文件"
		return
	}
	const text = (r.text ?? "").trim()
	if (!text) {
		personaMsgOk.value = false
		personaMsg.value = "这个文件是空的, 没有可当人设的内容"
		return
	}
	saveCustomPersona(text)
	personaName.value = r.name ?? ""
	refreshPersonaState()
	personaMsgOk.value = true
	personaMsg.value = `已导入 ${r.name ?? "人设文件"}（${personaChars.value} 字）`
	triggerBubble("人设已更新，下次说话就照这个来")
}

/** 清除自定义人设: 把 `persona.md` 内容清空（文件留着, 不删；没有内置人设可回落） */
const doResetPersona = () => {
	saveCustomPersona("")
	refreshPersonaState()
	personaMsgOk.value = true
	personaMsg.value = ""
	triggerBubble("已清除自定义人设")
}

const modelReady = computed(() => !!cfg.apiKey.trim() && !!cfg.model)
const toggleChat = () => {
	chatOpen.value = !chatOpen.value
	if (chatOpen.value) scrollChatBottom()
}

const scrollChatBottom = () => {
	nextTick(() => {
		const el = chatScroll.value
		if (el) el.scrollTop = el.scrollHeight
	})
}

const refreshModels = async () => {
	modelLoadMsg.value = "加载中…"
	const r = await fetchModels(cfg.baseUrl, cfg.apiKey)
	if (!r.ok) { modelLoadMsg.value = r.message ?? "加载失败"; return }
	modelOptions.value = r.models ?? []
	if (modelOptions.value.length && !modelOptions.value.includes(cfg.model)) cfg.model = modelOptions.value[0]
	modelLoadMsg.value = `找到 ${modelOptions.value.length} 个模型`
}

/** 输入排队: 上一条还在生成 (含触摸触发的对话) 时, 新消息先进队列, 空闲后依次发出 */
const pendingQueue = ref<string[]>([])
let draining = false
const drainQueue = async (): Promise<void> => {
	if (draining || typing.value || chatStreaming.value || touchStreaming.value) return
	draining = true
	try {
		while (pendingQueue.value.length && !typing.value && !chatStreaming.value && !touchStreaming.value) {
			const next = pendingQueue.value.shift()
			if (next) await runSend(next)
		}
	} finally {
		draining = false
	}
}
watch([typing, chatStreaming, touchStreaming], () => {
	if (pendingQueue.value.length) void drainQueue()
})

const send = async (): Promise<void> => {
	const text = draft.value.trim()
	if (!text) return
	if (!modelReady.value) {
		panel.value = "settings"
		return
	}
	draft.value = ""
	// 正忙时入队 (watch 会在空闲时触发 drain), 空闲时立即发送
	pendingQueue.value.push(text)
	await drainQueue()
}

const runSend = async (text: string): Promise<void> => {
	// 朗读打断 (barge-in): 消息真正发出时才停朗读 (打字不打断);
	// stop() 会关闭朗读会话并置 aborted, 之前回复里排队未读的句子全部丢弃, 不会"复活".
	// 排队场景: 每条消息在实际发出那一刻才打断, 生成中的回复会先读完
	ambientTouch()
	habitRecord("msg")
	stopTTS()
	messages.value.push({role: "user", content: text, ts: Date.now()})
	persistChat(messages.value)
	scrollChatBottom()

	typing.value = true
	try {
		// 记忆系统: 按当前消息召回长期记忆 + 读取历史总结, 注入上下文
		// smartRecall 开 → LLM 语义召回 (更准); 关 → 关键词召回 (免费快)
		let memoryBlock = ""
		// 记忆召回 (发送延迟优化): 语义召回是一次 LLM 调用, 原先阻塞在首字之前最坏 3s.
		// ① 寒暄/过短消息直接走关键词召回 (这类消息也不需要记忆);
		// ② 语义召回只等 RECALL_BUDGET_MS, 超时先用关键词兜底发送,
		//    迟到的语义结果在后台自行完成强化写库, 不阻塞也不浪费
		const llmRecallCall = async (prompt: string): Promise<string> => {
			const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
				{role: "system", content: prompt} as ChatMsg,
			])
			return r.ok ? (r.content ?? "") : ""
		}
		if (cfg.smartRecall && cfg.apiKey.trim() && cfg.model.trim() && !shouldSkipLlmExtract(text)) {
			const smart = recallForQuerySmart(text, llmRecallCall).catch(() => "")
			const fast = new Promise<string>((resolve) =>
				setTimeout(() => resolve(recallForQuery(text)), RECALL_BUDGET_MS)
			)
			memoryBlock = await Promise.race([smart, fast])
			void smart.catch(() => { /* 已用关键词兜底, 后台自行收尾 */ })
		} else {
			memoryBlock = recallForQuery(text)
		}
		const summary = summaryBlock()
		const context: ChatMsg[] = []
		const personaText = personaPrompt()
		if (personaText) context.push({role: "system", content: personaText} as ChatMsg)
		if (summary) context.push({role: "system", content: summary} as ChatMsg)
		if (memoryBlock) context.push({role: "system", content: memoryBlock} as ChatMsg)
		// 近况注入 (P5): 最近聊过的话题 —— 指代类提问 ("那个游戏") 与情感连贯的抓手;
		// 摘要已由 summaryBlock 注入, 这里只给块主题, 不重复灌摘要
		const recentTopics = recentTopicsBlock()
		if (recentTopics) context.push({role: "system", content: recentTopics} as ChatMsg)
		// 目标陪伴: 有超过 3 天没被关心的目标时注入提示, 让 Nori 自然地问问进展
		const goalCare = goalCarePrompt()
		if (goalCare) context.push({role: "system", content: goalCare} as ChatMsg)
		// 专注数据: 三个闸门都过才注入 (话题相关 + 有值得说的 + 今天还没提过)。
		// 刻意做成"回复内提一句"而不是 Ambient 主动搭话 —— 后者每次会话只有 3 条预算,
		// 用去报数字就把陪伴变成打卡提醒了。注入文本自带"最多提这一件事"的克制约束,
		// 因为 persona 已反复强调 2~3 句上限 (不去放宽那条规则)。
		if (focusHintFresh()) {
			const fh = buildFocusHint(pomoSummary.value, text, pomoStats.celebrated ?? {})
			if (fh.hint) {
				context.push({role: "system", content: fh.hint} as ChatMsg)
				markFocusHinted()
				if (fh.milestoneKey) markCelebrated(fh.milestoneKey)
			}
		}
		const hist = contextHistory(messages.value).map(({role, content}) => ({role, content}) as ChatMsg)
		// 当前时间（2026-10-01）: 追加在人格/摘要/记忆/近况/目标/专注这些 system 块之后
		if (cfg.timeAware) context.push({role: "system", content: localTimeBlock()} as ChatMsg)
		const payload = [...context, ...hist]

		// 流式 TTS: 启用时开"逐句朗读会话", 边生成边出音
		const ttsOn = isTtsReady(cfg)
		if (ttsOn) beginSpeakSession(cfg)

		chatMarkerBuf.value = "" // 新会话重置聊天标记跨块缓冲
		let reply = ""
		let pendingSpeech = ""
		// 本次会话是否收到过标记 (有标记 → 收尾不再用正文关键词覆盖; 无标记 → 关键词兜底)
		let markerDriven = false
		// 存储/历史合并: 一次回复只存一条消息, 显示时由 bubbleSegments 拆成多气泡
		let liveBubble: ChatMsg | null = null
		let streamOk = false
		chatStreaming.value = true

		// 停止生成: 本地 AbortController (即使原生桥丢弃回包也能正常结束) + 原生桥 chatStop
		stopRequested = false
		const chatAbort = new AbortController()
		activeChatAbort = chatAbort

		// 滚动节流: 长回复时避免每增量都滚动 (仅近底部才滚, 150ms 限频)
		let lastScrollAt = 0
		let scrollTimer: ReturnType<typeof setTimeout> | null = null
		const throttledScroll = () => {
			const el = chatScroll.value
			if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 120) return
			const now = Date.now()
			if (now - lastScrollAt > 150) {
				lastScrollAt = now
				scrollChatBottom()
			} else if (!scrollTimer) {
				scrollTimer = setTimeout(() => {
					scrollTimer = null
					lastScrollAt = Date.now()
					scrollChatBottom()
				}, 150)
			}
		}

		// 把累积的文本按句子边界切出来, 逐句追加朗读 (只在安全边界切, 不切词)
		const flushSpeech = () => {
			if (!ttsOn || !pendingSpeech) return
			const {sentences, rest} = splitSpeechText(pendingSpeech)
			for (const s of sentences) {
				const p = s.trim()
				if (p) speakAppend(cfg, p)
			}
			pendingSpeech = rest
		}

		await new Promise<void>((resolve) => {
			sendChatStream(cfg.baseUrl, cfg.apiKey, cfg.model, payload, {
				onDelta: (delta) => {
					// 防御: 个别代理会把 null 当字符串下发, 直接跳过
					if (delta === "null") return
					// 剥离隐藏的【表情:xxx】【动作:xxx】标记 (标记不显示、不朗读)
					const {clean, emotion, motion} = parseMarkerDelta(delta, chatMarkerBuf)
					reply += clean
					pendingSpeech += clean
					flushSpeech()
					if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
					if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
					if (cfg.emotionLlm && motion) playMarkerMotion(motion)
					// 存储合并: 只更新一条 liveBubble, 显示层自动拆多气泡
					if (!liveBubble) {
						liveBubble = {role: "assistant", content: reply, ts: Date.now()}
						messages.value.push(liveBubble)
					} else {
						liveBubble.content = reply
					}
					throttledScroll()
				},
				onDone: (content) => {
					streamOk = true
					chatStreaming.value = false
					// content 是含标记的全文: 优先用流式累积的已剥离 reply;
					// 若 reply 为空 (如非流式回退), 则对 content 整体剥离一次 (用空缓冲, 避免残留拼接)
					if (content && !reply.trim()) {
						const fresh = {value: ""}
						const {clean, emotion, motion} = parseMarkerDelta(content, fresh)
						reply = clean
						if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
						if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
						if (cfg.emotionLlm && motion) playMarkerMotion(motion)
						// 非流式回退: 整体内容作为一条消息 (显示层自动拆多气泡)
						if (!liveBubble) {
							liveBubble = {role: "assistant", content: reply, ts: Date.now()}
							messages.value.push(liveBubble)
						} else {
							liveBubble.content = reply
						}
					}
					// 兜底: 流式路径若仍有残留未闭合的【(缓冲里), 说明标记不完整, 丢弃不显示
					chatMarkerBuf.value = ""
					if (liveBubble) liveBubble.content = reply
					persistChat(messages.value)
					resolve()
				},
				onError: (msg) => {
					chatStreaming.value = false
					// 用户主动停止: 不显示错误气泡; 其他失败且无内容时显示
					const cancelled = stopRequested || msg === "已停止"
					if (!cancelled && !reply.trim()) {
						if (liveBubble) {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
						messages.value.push({role: "assistant", content: `⚠ ${msg}`, ts: Date.now(), error: true})
					} else if (liveBubble) {
						// 已收到部分内容: 保留为一条消息
						liveBubble.content = reply
					}
					persistChat(messages.value)
					resolve()
				},
			}, cfg.deepseekThinking, chatAbort.signal)
		})
		if (activeChatAbort === chatAbort) activeChatAbort = null
		if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null }

		// 收尾: 剩余未成句的文本 + 结束朗读会话
		if (ttsOn) {
			if (pendingSpeech.trim()) speakAppend(cfg, pendingSpeech)
			pendingSpeech = ""
			endSpeakSession()
		}

		typing.value = false
		scrollChatBottom()

		if (streamOk && reply) {
			// 表情/动作: 流式标记已即时驱动; 只有本次会话完全没收到标记时才用正文关键词兜底
			if (!markerDriven) {
				triggerEmotion(reply)
				pickMotionByKeyword(reply)
			}
			// 记忆提取: 规则法免费 + LLM 可选增强 (表情分析已并入主回复标记, 不再单独调用)
			void analyzeAfterReply(text, reply)
			// 记忆系统: 历史过长时生成摘要 (用带标点的原文压缩, 质量更好)
			void (async () => {
				const summarized = await summarizeIfNeeded(messages.value, async (prompt) => {
					const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
						{role: "system", content: prompt} as ChatMsg,
					])
					return r.ok ? (r.content ?? "") : ""
				}, !!cfg.memoryLlmExtract)
				maybeAutoTuneExamples()   // 自动优化 (开关打开时): 新增够 20 条就顺手刷新示例
				// 开启「自动裁剪」时: 只裁**已经进过摘要的那段前缀** (P5: safeTrimDrop 保证
				// 不会把还没总结的消息删掉 —— 删掉就永远进不了记忆了), 近端窗口照旧保留。
				const dropN = summarized && cfg.trimHistory ? safeTrimDrop(messages.value.length) : 0
				if (dropN > 0) {
					// 裁剪前把将被裁掉的消息备份进日记源缓冲 (FE-M5): 日记素材不随裁剪消失
					bufferDiarySource(messages.value.slice(0, dropN))
					// 占位符仍每次都新建, 但聊天存储侧会去重 (filterChatMsgs 只留第一条 /
					// mergeChatLists 对占位符查重) —— 所以它不会在磁盘上越积越多。
					// 不要在这里"复用旧占位符": 它的 ts 低于已设的 cutoff, 重载时照样会被丢掉。
					const kept = messages.value.slice(dropN)
					kept.unshift({role: "system", content: "（更早的对话已压缩为历史总结，可在设置→记忆系统查看）", ts: Date.now(), placeholder: true})
					// 通知聊天存储裁剪边界: 落盘归并时不再把被裁掉的旧消息并回来
					const firstReal = kept.find(m => m.role !== "system")
					if (firstReal) setChatTrimCutoff(firstReal.ts)
					messages.value = kept
					persistChat(messages.value)
					// 登记被裁掉的条数 (P5): 游标靠"累计已摘要 - 累计已裁剪"换算成数组下标,
					// 不再像旧实现那样谎称"保留的都已摘要" (那会让近端 20 条永远不被总结)
					notifyHistoryTrimmed(dropN)
					scrollChatBottom()
				}
			})()
		}
	} finally {
		typing.value = false
		scrollChatBottom()
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))


const splitReplies = (reply: string): string[] => {
	const lines = reply.split(/\n+/).map((s) => s.trim()).filter((s) => s)
	if (lines.length >= 2) return lines.map((s) => s.replace(/[。！？!?^~，,]+$/g, ""))
	return [reply.trim()]
}

/**
 * 气泡显示文本: 统一省略号显示, 防止被 CSS 断行拆开.
 * - 连续英文点 (AI 可能输出 "......") → 单个中文省略号 "…"
 * - 中文省略号 (…… 或 ······) → 合并为单个 "…"
 * 单个字符永远不会被断行拆开.
 */
const bubbleText = (content: string): string =>
	content
		.replace(/\.{2,20}/g, "…")
		.replace(/…{2,}/g, "…")
		.replace(/·{2,}/g, "…")

/**
 * 按句拆气泡 (仅显示用): 存储里一条消息, 显示时按句末标点切成多个独立气泡.
 * 复用 splitSpeechText 的切分规则 (。！？!?\n…), 超长无标点段用 MAX_BUBBLE_LEN 兜底.
 * 结果按内容缓存 (性能): 流式时每个增量都触发重渲染, 模板里直接调用会让
 * 全部历史消息每帧重切一遍 —— 长对话打字/流式输出卡顿的根源. 内容字符串
 * 不可变 → 缓存按内容做键, 只有正在生长的那条会重算.
 */
const segCache = new Map<string, string[]>()
const bubbleSegments = (content: string): string[] => {
	const hit = segCache.get(content)
	if (hit) return hit
	const segs = computeBubbleSegments(content)
	if (segCache.size > 150) segCache.clear() // 防止极长对话下缓存膨胀 (内容键不可枚举复用)
	segCache.set(content, segs)
	return segs
}

const computeBubbleSegments = (content: string): string[] => {
	const raw = content ?? ""
	const segs: string[] = []
	let rest = raw
	const pushSeg = (t: string): void => {
		if (!t.trim()) return
		if (t.length > MAX_BUBBLE_LEN) {
			for (let i = 0; i < t.length; i += MAX_BUBBLE_LEN) {
				segs.push(t.slice(i, i + MAX_BUBBLE_LEN))
			}
		} else {
			segs.push(t)
		}
	}
	// 防死循环: 迭代上限 (正常回复最多几十句)
	for (let guard = 0; guard < 200; guard++) {
		// 气泡显示: 省略号不当句子边界 (否则 "……" 会被单独切出/挤到下一行)
		const {sentences, rest: r} = splitSpeechText(rest, 40, false)
		for (const s of sentences) pushSeg(s.trim())
		if (!r.trim()) break
		rest = r
		// splitSpeechText 对 <40 字的无标点 rest 不产生 sentences, 直接作为最后一段
		if (rest.length < 40) {
			pushSeg(rest.trim())
			break
		}
		// rest >= 40 字无标点: 下一轮 splitSpeechText 会按弱分隔或整段切出 sentences
	}
	return segs.filter(Boolean)
}

/**
 * v-for 稳定 key: 按消息对象身份分配自增 id (WeakMap, 不影响持久化/响应式).
 * 旧实现用数组下标作 key —— 删除错误气泡/裁剪移位后整段下标前移, Vue 错误
 * 复用 DOM 节点; 内容类 key 又会随流式增量变化导致节点重建.
 */
const msgIdMap = new WeakMap<ChatMsg, number>()
let msgIdSeq = 0
const msgKey = (m: ChatMsg): number => {
	let id = msgIdMap.get(m)
	if (id === undefined) {
		id = ++msgIdSeq
		msgIdMap.set(m, id)
	}
	return id
}

/* ---------------- 记忆系统 UI 状态 ---------------- */
/* P5 起"近端保留多少条/这次能裁多少条"由记忆服务决定 (RAW_WINDOW 与 safeTrimDrop),
   界面不再自己写死 20 —— 之前界面与记忆层各存一份窗口大小, 是"裁剪把没总结的消息删掉"
   这类 bug 的温床。 */
/** 语义召回预算 (ms): 超时先用关键词兜底发送, 语义结果后台自行收尾 */
const RECALL_BUDGET_MS = 1200
/** 无换行时单条气泡的最大字符数 (超过则兜底切新气泡; 30 → 60: 减少无标点长句
 *  被硬切成多个气泡的情况, CSS 已支持气泡内自然换行) */
const MAX_BUBBLE_LEN = 60

const memView = reactive<{memories: MemoryItem[]; summaries: MemorySummary[]}>(listAll())

/**
 * 记忆块视图数据 (P4): 块 + 解析出的条目。**浏览态**按块排时间线, 块内再按类型分小节。
 * 刷新与 memView 同步 (见 refreshMemView)。
 */
const memBlocks = ref<MemoryBlockView[]>([])
/** 没挂进任何块的条目 (实时通道写的 / 存量去重后被合并掉的 / 早期数据) */
const memUnblocked = ref<MemoryItem[]>([])
/** 「待整理 N 条」: {pending, threshold}; pending 攒到 threshold 会自动整理 */
const memPending = ref(organizeProgress([]))

const TYPE_LABELS: Record<string, string> = {
	fact: "事实",
	preference: "偏好",
	project: "项目",
	event: "事件",
	relationship: "关系",
	core: "核心",
}

const typeLabel = (t: string): string => TYPE_LABELS[t] ?? t

const summaryLabel = (s: MemorySummary): string =>
	`${new Date(s.createdAt).toLocaleString()} · 覆盖 ${s.msgCount} 条消息`

const refreshMemView = () => {
	const data = listAll()
	memView.memories = data.memories
	memView.summaries = data.summaries
	invalidMems.value = listInvalidMemories()
	fadedMems.value = listFadedMemories()
	deletedMems.value = listDeletedMemories()
	tuneSet.value = getMemoryExamples()
	goals.value = listGoals()
	hasBackup.value = hasMemoryBackup()
	memBlocks.value = listBlocks()
	memUnblocked.value = listUnblockedMemories()
	memPending.value = organizeProgress(messages.value)
	diagN.value = diagCount()
}

/* ---------------- 记忆管理 (固定/删除) + 撤销清理 + 目标陪伴 + 导出 (A2/A3/C3/C4) ---------------- */
const goals = ref<MemoryItem[]>(listGoals())
const goalDraft = ref("")
const hasBackup = ref(hasMemoryBackup())

/**
 * 已作废的记忆 (被改口/纠正取代的那些, B1): 默认折叠在「已作废」里 —— 不注入、不参与召回,
 * 但留在库里, 用户点「还原」就能救回来 (误判的代价从"永久丢"降到"点一下")。
 */
const invalidMems = ref<MemoryItem[]>(listInvalidMemories())

/** 已收起 (2026-09-28): 到期/太久没提被自动收起的条目; 与「作废」的区别是**没有被推翻** */
const fadedMems = ref<MemoryItem[]>(listFadedMemories())
/** 已删除 (2026-09-28, 回收站): 手删的条目(带内容), 可还原; 最多留 20 条 */
const deletedMems = ref<MemoryItem[]>(listDeletedMemories())

/** 记忆诊断日志 (P1): 内存里已经攒了多少次整理的证据 (开关关着时恒为 0) */
const diagN = ref<number>(diagCount())

/** 收起原因的人话 (只在这一处拼, 免得散落) */
const fadeReasonLabel = (m: MemoryItem): string => {
	if (m.fadedReason === "lowvalue") return "太久没提、不太重要"
	if (m.fadedReason === "manual") return "你手动收起的"
	return "到期了（很久没提）"
}

/** 把一条被收起的记忆放回生效 */
const doRestoreFaded = (m: MemoryItem) => {
	if (!restoreFadedMemory(m.id)) { triggerBubble("这条已经放回去了"); return }
	refreshMemView()
	triggerBubble("已经放回生效啦")
}

/** 从回收站还原一条被删的记忆 */
const doRestoreDeleted = (m: MemoryItem) => {
	if (!restoreDeletedMemory(m.id)) { triggerBubble("这条已经不在回收站里了"); return }
	refreshMemView()
	triggerBubble("已还原，我又记起来啦")
}

/** 记忆优化 (整理优化) 的界面状态: 当前示例集 + 是否展开查看 */
const tuneShow = ref(false)
const tuneSet = ref<{builtAt: number; basedOn: number; pos: string[]; neg: string[]} | null>(null)
const tuneHas = computed(() => !!tuneSet.value && (tuneSet.value.pos.length > 0 || tuneSet.value.neg.length > 0))
const tunePos = computed(() => tuneSet.value?.pos ?? [])
const tuneNeg = computed(() => tuneSet.value?.neg ?? [])
const tuneInfo = computed(() => {
	const e = tuneSet.value
	if (!e || (!e.pos.length && !e.neg.length)) return "还没有示例。例子来自你「保留的」记忆（该记）和你「删掉的」记忆（不该记），点「立即优化」生成"
	return `上次优化：${fmtTs(e.builtAt)} · 正例 ${e.pos.length} 条 / 反例 ${e.neg.length} 条（基于当时 ${e.basedOn} 条记忆）`
})

/** 「立即优化」: 首次给一次提醒 —— 例子是从"你留下的记忆"里学的, 没用的先删掉 */
const doRebuildExamples = () => {
	if (!tuneHas.value) {
		const ok = window.confirm(
			"例子是从你**留下的**记忆里学的，没用的先删掉更好 ——\n" +
			"删掉的会当反例，教它别再记那类；留着不管的话，垃圾会被学成风格、越滚越多。\n\n" +
			"确定现在就生成示例吗？（先取消，去把没用的记忆删掉也行）",
		)
		if (!ok) { triggerBubble("那我等你整理好啦"); return }
	}
	const built = rebuildMemoryExamples()
	refreshMemView()
	triggerBubble(built ? "示例已更新，我照你的口味来记" : "记忆还太少，先不生成示例")
}

const doClearExamples = () => {
	clearMemoryExamples()
	refreshMemView()
	triggerBubble("示例已清除，回到默认规则")
}

/** 自动优化: 每次整理成功后检查一次 (新增 ≥20 条才重建, 零额外调用) */
const maybeAutoTuneExamples = () => {
	if (!cfg.memoryAutoTuneExamples) return
	if (!shouldRebuildMemoryExamples()) return
	if (rebuildMemoryExamples()) refreshMemView()
}

/* ---------------- 记忆诊断日志 (P1, 2026-09-30) ---------------- */

/** 开关: 立刻同步给记忆模块 (关掉后不再记录, 已记录的不清 —— 用户可能正要导出) */
const onDiagToggle = () => {
	setDiagEnabled(!!cfg.memoryDiagnostics)
	persistSettings()   // 立刻落盘: 否则重启 App 会回到关闭, 悬浮窗也读不到这个开关
	diagN.value = diagCount()
	triggerBubble(cfg.memoryDiagnostics ? "开始记录整理过程，导出在同一次里做哦" : "已停止记录（已有的记录还在，可以导出）")
}

/** 导出: 走与「导出」同一条 writeFile 通道 (落到 Download/NoriDroid/) */
const doExportDiag = () => {
	if (!diagN.value) { triggerBubble("还没有记录 —— 先打开上面的开关"); return }
	const text = buildDiagJsonl({model: cfg.model, app: "NoriDroid"})
	const d = new Date()
	const name = `mem-diag-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}.jsonl`
	try {
		const ok = writeFile(name, text)
		triggerBubble(ok ? `已导出 ${name}（${diagN.value} 条记录）` : "导出失败")
	} catch {
		triggerBubble("导出失败")
	}
}

const doClearDiag = () => {
	clearDiag()
	diagN.value = diagCount()
	triggerBubble("记录已清空")
}

/** 永久删除 (从回收站抹掉): 这是**唯一不可逆**的操作, 所以要二次确认 */const doDeleteForever = (m: MemoryItem) => {
	if (!window.confirm(`永久删除这条记忆？删了就找不回来了。\n「${m.content}」`)) return
	deleteMemoryForever(m.id)
	refreshMemView()
	triggerBubble("已永久删除")
}

/** 还原一条被作废的记忆 (B1) */
const doRestoreInvalid = (m: MemoryItem) => {
	if (!restoreMemory(m.id)) { triggerBubble("这条已经还原过了"); return }
	refreshMemView()
	triggerBubble("已还原，我又记起来啦")
}

/** 长期记忆展示列表: 排除目标条目 (目标有专门的"陪着你的事"小节, 避免两处重复) */
const nonGoalMemories = computed(() =>
	memView.memories.filter(m => !(m.tags ?? []).includes("goal"))
)

/** 记忆库页 (独立页): 搜索 + 类型筛选 */
const memSearch = ref("")
const memFilter = ref("") // "" | 类型 | goal | pinned
const openMemoriesPage = () => openPanel("memories")
const filteredMems = computed(() => {
	// 目标条默认**不在长期记忆里重复出现** —— 它们上面已有「陪着你的事」小节,
	// 两处都列一遍正是用户说的"混在一起"。但显式筛选「目标」或在搜索时照常参与,
	// 否则搜不到目标内容 (搜"雅思"必须能找到「考雅思 7 分」)。
	const q0 = memSearch.value.trim().toLowerCase()
	let list = (memFilter.value === "goal" || q0) ? memView.memories : nonGoalMemories.value
	if (memFilter.value === "goal") list = list.filter(m => (m.tags ?? []).includes("goal"))
	else if (memFilter.value === "pinned") list = list.filter(m => (m.tags ?? []).includes("pinned"))
	else if (memFilter.value) list = list.filter(m => m.type === memFilter.value)
	if (q0) list = list.filter(m => m.content.toLowerCase().includes(q0))
	return list
})

/** 展示列表: 记忆来源标注 (B2) —— 「你声明」= 从你的原话里直接记下的规则命中;
 *  「我推断」= Nori 用模型从对话里推断出来的 (tag=llm)。用户要求"分清哪句是我说的、
 *  哪句是她猜的", 因为推断错的条目最该被纠正。 */
const isInferred = (m: MemoryItem): boolean => (m.tags ?? []).includes("llm")
const memProvenance = (m: MemoryItem): string => (isInferred(m) ? "我推断" : "你声明")
const PROV_TIP = "你声明 = 从你原话里直接记下的；我推断 = Nori 自己推断出来的，错了可以删/纠正"

/** 类型在记忆库里的展示顺序 (分组小节的先后; 目标单独一节, 不在此列) */
const TYPE_ORDER: MemoryType[] = ["core", "fact", "preference", "project", "event", "relationship"]

/**
 * 按类型分组的长期记忆 (用户 2026-09-27 要求: "同类型标签分类到一块, 现在都混在一起")。
 * 组内保持传入顺序 (重要度优先 → 新旧), 组间按 TYPE_ORDER, 空组不显示。
 * P4 起抽成函数: 块视图的每一块内部也用它 (块内按类型分小节)。
 */
const groupByType = (items: MemoryItem[]): {type: string; label: string; items: MemoryItem[]}[] => {
	const buckets = new Map<string, MemoryItem[]>()
	for (const m of items) {
		const list = buckets.get(m.type)
		if (list) list.push(m)
		else buckets.set(m.type, [m])
	}
	const out: {type: string; label: string; items: MemoryItem[]}[] = []
	for (const t of [...TYPE_ORDER, ...[...buckets.keys()].filter(k => !TYPE_ORDER.includes(k as MemoryType))]) {
		const items = buckets.get(t)
		if (items?.length) out.push({type: t, label: typeLabel(t), items})
	}
	return out
}

/** 搜索/筛选态的平铺分组 (找东西的场景: 不按时间线, 直接按类型列出来) */
const groupedMems = computed(() => groupByType(filteredMems.value))

/** 块视图可展示的条目: 生效中 且 不是目标 (目标有自己那一节) */
const blockVisible = (m: MemoryItem): boolean =>
	!m.invalidAt && !m.fadedAt && !(m.tags ?? []).includes("goal")

/** 块标题: 「主题 · 时间段 · N 条」; 迁移块 (早期记忆) 没有主题与区间时只显示主题 */
const blockTitle = (b: MemoryBlock): string => {
	const topic = b.topic || "未命名"
	if (!b.msgCount) return topic   // 迁移块: 没有"覆盖了多少条消息"这回事
	const from = fmtTs(b.fromTs)
	const to = fmtTs(b.toTs)
	// 同一分钟内只写一个时间: 25 条消息可能只跨几十秒, 否则会显示成「22:25 ~ 22:25」(实测截图里就是这样)
	const range = from === to ? from : `${from} ~ ${to}`
	return `${topic} · ${range} · ${b.msgCount} 条对话`
}

/**
 * 记忆库的**渲染计划** (P4): 一处算完, 模板只做两层循环, 不必为块/平铺/未归类各写一遍行标记。
 * - 浏览态: 每个记忆块一节 (块内按类型分小节) + 「未归类」一节;
 * - 搜索/筛选态: 退回"按类型平铺" (找东西时时间线反而是干扰)。
 */
const memSections = computed<{key: string; title: string; subs: {key: string; label: string; items: MemoryItem[]}[]}[]>(() => {
	const toSubs = (items: MemoryItem[]) =>
		groupByType(items).map(g => ({key: g.type, label: g.label, items: g.items}))
	if (memSearch.value || memFilter.value) {
		const subs = toSubs(filteredMems.value)
		return subs.length ? [{key: "flat", title: "", subs}] : []
	}
	const out: {key: string; title: string; subs: {key: string; label: string; items: MemoryItem[]}[]}[] = []
	for (const v of memBlocks.value) {
		const subs = toSubs(v.items.filter(blockVisible))
		if (subs.length) out.push({key: v.block.id, title: blockTitle(v.block), subs})
	}
	const unblocked = toSubs(memUnblocked.value.filter(blockVisible))
	if (unblocked.length) out.push({key: "unblocked", title: "未归类", subs: unblocked})
	return out
})

/** 「立即整理」: 不等攒够阈值, 现在就把待整理的消息总结成摘要 + 记忆块 (同一条链路) */
const memOrganizing = ref(false)
/**
 * 「立即整理」的反馈 (A: 就地反馈)。
 * 为什么不复用下面那个 `memPruneMsg`: 那个提示渲染在面板**最底部**(与清理/撤销按钮同一行),
 * 而"立即整理"按钮在面板上部 —— 用户点完视线不往下走, 实测体感就是"点了没反应"
 * (探针 probe-organize-button.mjs 量到反馈在 776/808 ≈ 96% 处)。所以这里单独一份状态, 就地显示。
 */
const memOrgMsg = ref("")
const memOrgMsgOk = ref(false)
/** 有没有东西可整理 (B: 没有就把按钮置灰, 别让它"可点但无事发生") */
const canOrganize = computed(() => memPending.value.pending > 0)
const doOrganizeNow = async () => {
	if (memOrganizing.value || !canOrganize.value) return
	memOrganizing.value = true
	memOrgMsg.value = ""
	try {
		const summarized = await summarizeIfNeeded(messages.value, async (prompt) => {
			const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
				{role: "system", content: prompt} as ChatMsg,
			])
			return r.ok ? (r.content ?? "") : ""
		}, !!cfg.memoryLlmExtract, true)
		maybeAutoTuneExamples()   // 自动优化 (开关打开时): 新增够 20 条就顺手刷新示例
		refreshMemView()
		const left = memPending.value.pending
		if (summarized) {
			memOrgMsg.value = left > 0
				? `已整理一批，还剩 ${left} 条待整理（再点一次可继续）`
				: "已经整理完啦，刚才聊的我都记住了"
			memOrgMsgOk.value = true
		} else {
			// 走到这里有两种: 模型没回内容 (有可整理的东西但失败了) / 整理期间待整理被清空
			memOrgMsg.value = left > 0
				? "这次没能整理出来（模型没回内容），稍后再试"
				: "没有待整理的内容 —— 最近的话都还在我眼前，不用整理"
			memOrgMsgOk.value = false
		}
	} catch (e) {
		console.error("[mem] 立即整理失败:", e)
		memOrgMsg.value = "整理失败，稍后再试"
		memOrgMsgOk.value = false
	} finally {
		memOrganizing.value = false
	}
}

const isPinnedId = (id: string): boolean => {
	const m = memView.memories.find(x => x.id === id)
	return !!(m && (m.tags ?? []).includes("pinned"))
}

const doTogglePin = (m: MemoryItem) => {
	pinMemory(m.id, !isPinnedId(m.id))
	refreshMemView()
	triggerBubble(isPinnedId(m.id) ? "已固定，这条不会淡忘" : "已取消固定")
}

/**
 * 「收起」一条记忆 (2026-09-29 用户要求: 条目行原来只有删除)。
 * 意图 = "这条现在不重要，但别删" ⇒ 进「已收起」，可一键「留下」；再说起它会自动放回。
 */
const doFadeMemory = (m: MemoryItem) => {
	if (!fadeMemoryManually(m.id)) { triggerBubble("这条已经收起来了"); return }
	refreshMemView()
	triggerBubble("已收起，随时能在「已收起」里点「留下」放回来")
}

const doDeleteMemory = (m: MemoryItem) => {
	if (!window.confirm(`删除这条记忆？\n「${m.content}」\n（会先进「已删除」，能还原；想不删只是暂时不重要，可以用「收起」）`)) return
	deleteMemory(m.id)
	refreshMemView()
	triggerBubble("已删除，可在「已删除」里还原")
}

/** 撤销上次清空/清理 (用 before-clear 快照整体还原) */
const doRestoreMemory = () => {
	if (!hasMemoryBackup()) { triggerBubble("没有可恢复的备份"); return }
	if (!window.confirm("用最近一次清理前的记忆覆盖当前内容？")) return
	restoreMemoryBackup()
	refreshMemView()
	triggerBubble("已恢复清理前的记忆")
}

const doAddGoal = () => {
	const t = goalDraft.value.trim()
	if (!t) return
	addGoal(t)
	goalDraft.value = ""
	refreshMemView()
	triggerBubble("好，我会陪你盯着这件事的")
}

const doRemoveGoal = (id: string) => {
	removeGoal(id)
	refreshMemView()
}

/* ---------------- 导出 (C4): 记忆+总结+日记 → Markdown 文件 ---------------- */
const pad2 = (n: number): string => `${n}`.padStart(2, "0")
const localDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const fmtTs = (ts: number): string => {
	const d = new Date(ts)
	return `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const buildExportMd = (withDiary: boolean): string => {
	const lines: string[] = []
	lines.push("# DeepEr 数据导出", `导出时间：${new Date().toLocaleString()}`, "")
	const data = listAll()
	// 目标单独一段 (它们不在"长期记忆"里重复出现, 见记忆库的分节逻辑)
	const goalList = listGoals()
	if (goalList.length) {
		lines.push(`## 陪着你的事（目标，${goalList.length} 条）`)
		for (const g of goalList) lines.push(`- ${g.content} · ${fmtTs(g.createdAt)}`)
		lines.push("")
	}
	lines.push(`## 长期记忆（${data.memories.length} 条）`)
	for (const m of data.memories) {
		const pin = (m.tags ?? []).includes("pinned") ? "（已固定）" : ""
		lines.push(`- [${typeLabel(m.type)}·${memProvenance(m)}] ${m.content}${pin} · ${fmtTs(m.createdAt)} · 重要性 ${m.importance}`)
	}
	// 记忆块时间线 (2026-09-29 补): 让人能看出"哪段时间聊了什么", 也是块的成员关系凭证
	const blocks = listBlocks()
	if (blocks.length) {
		lines.push("", `## 记忆块时间线（${blocks.length} 段）`)
		for (const b of blocks) {
			const range = b.block.msgCount
				? `${fmtTs(b.block.fromTs)} ~ ${fmtTs(b.block.toTs)} · ${b.block.msgCount} 条对话`
				: "早期记忆（迁移前的存量）"
			lines.push(`- ${b.block.topic || "未命名"} · ${range} · ${b.items.filter(i => !i.invalidAt && !i.fadedAt).length} 条生效`)
		}
	}
	// 未归类 (没挂进任何块的条目)
	const unblocked = listUnblockedMemories()
	if (unblocked.length) {
		lines.push("", `## 未归类（${unblocked.length} 条 · 没挂进任何记忆块）`)
		for (const m of unblocked) lines.push(`- [${typeLabel(m.type)}] ${m.content} · ${fmtTs(m.createdAt)}`)
	}
	// 已作废的记忆 (B1): 导出要带上"历史" —— 用户可能靠它复盘 she 是什么时候改口的
	const invalid = listInvalidMemories()
	if (invalid.length) {
		lines.push("", `## 已作废的记忆（${invalid.length} 条 · 已被后来说的话取代，Nori 不再使用）`)
		for (const m of invalid) {
			lines.push(`- [${typeLabel(m.type)}·${memProvenance(m)}] ${m.content} · 记于 ${fmtTs(m.createdAt)} · 作废于 ${fmtTs(m.invalidAt ?? 0)}`)
		}
	}
	// 已收起 / 回收站 (2026-09-29 补): 导出要能当"全量备份"用 —— 从新包退回旧包前,
	// 这两块在旧包里是看不见的 (旧代码不认 fadedAt/deletedBin), 导出是唯一的取回渠道
	const faded = listFadedMemories()
	if (faded.length) {
		lines.push("", `## 已收起的记忆（${faded.length} 条 · 太久没提或到期自动收起，可在记忆库点「留下」放回）`)
		for (const m of faded) {
			lines.push(`- [${typeLabel(m.type)}] ${m.content} · ${fadeReasonLabel(m)} · 收起于 ${fmtTs(m.fadedAt ?? 0)}`)
		}
	}
	const deleted = listDeletedMemories()
	if (deleted.length) {
		lines.push("", `## 已删除（回收站，${deleted.length} 条 · 可在记忆库点「还原」取回；「永久删除」后不再出现）`)
		for (const m of deleted) {
			lines.push(`- [${typeLabel(m.type)}] ${m.content} · 删除于 ${fmtTs(m.deletedAt ?? 0)}`)
		}
	}
	// 记忆优化示例集 (整理优化): 导出带上, 换机/排查时能看出"她现在照什么口味记"
	const ex = getMemoryExamples()
	if (ex && (ex.pos.length || ex.neg.length)) {
		lines.push("", `## 记忆优化示例（生成于 ${fmtTs(ex.builtAt)} · 基于当时 ${ex.basedOn} 条记忆）`)
		if (ex.pos.length) lines.push(`- 该记：${ex.pos.join(" / ")}`)
		if (ex.neg.length) lines.push(`- 不该记：${ex.neg.join(" / ")}`)
	}
	lines.push("", `## 历史总结（${data.summaries.length} 条）`)
	for (const s of data.summaries) {
		lines.push(`- ${fmtTs(s.createdAt)}：${s.content}`)
	}
	if (withDiary) {
		const diary = listDiary()
		lines.push("", `## Nori 的日记（${diary.length} 篇）`)
		for (const e of diary) {
			lines.push(`### ${e.date} · ${e.mood}`, e.content, "")
		}
	}
	return lines.join("\n")
}

const exportFileName = (): string =>
	`deeper-export-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.md`

const doExportAll = () => {
	try {
		const name = exportFileName()
		const ok = writeFile(name, buildExportMd(true))
		triggerBubble(ok ? `已导出 ${name}` : "导出失败")
	} catch {
		triggerBubble("导出失败")
	}
}

const doExportDiary = () => {
	try {
		const name = exportFileName()
		const ok = writeFile(name, buildExportMd(false))
		triggerBubble(ok ? `已导出 ${name}` : "导出失败")
	} catch {
		triggerBubble("导出失败")
	}
}

/* ---------------- Nori 心情日记 (按日历天数查看) ---------------- */
const CAL_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]
const diaryEntries = ref<DiaryEntry[]>(listDiary())
const diaryBusy = ref(false)
/** 日历当前显示的年/月 (month: 0-11) 与选中的一天 */
const calYear = ref(new Date().getFullYear())
const calMonth = ref(new Date().getMonth())
const calSelDate = ref("")
const todayStr = ref(localDay(new Date()))

/** date → 当天日记 (一天一篇) */
const diaryByDate = computed<Record<string, DiaryEntry>>(() => {
	const map: Record<string, DiaryEntry> = {}
	for (const e of diaryEntries.value) map[e.date] = e
	return map
})

/** 当月日历格子 (null = 占位空格, 否则 YYYY-MM-DD; 周日开头) */
const calGrid = computed<(string | null)[]>(() => {
	const first = new Date(calYear.value, calMonth.value, 1)
	const offset = first.getDay()
	const days = new Date(calYear.value, calMonth.value + 1, 0).getDate()
	const cells: (string | null)[] = []
	for (let i = 0; i < offset; i++) cells.push(null)
	for (let d = 1; d <= days; d++) {
		cells.push(`${calYear.value}-${pad2(calMonth.value + 1)}-${pad2(d)}`)
	}
	return cells
})

const calMove = (step: number) => {
	let m = calMonth.value + step
	let y = calYear.value
	if (m < 0) { m = 11; y -= 1 }
	else if (m > 11) { m = 0; y += 1 }
	calYear.value = y
	calMonth.value = m
}

/** 日历跳到某一天 (写今天/补写昨天后定位到对应天) */
const jumpCalTo = (date: string) => {
	const parts = date.split("-")
	const y = Number(parts[0])
	const m = Number(parts[1])
	if (!y || !m) return
	calYear.value = y
	calMonth.value = m - 1
	calSelDate.value = date
}

/** 情绪 → CSS class key */
const moodKey = (mood: string): string => {
	if (mood === "开心" || mood === "兴奋") return "happy"
	if (mood === "难过") return "sad"
	if (mood === "孤单") return "lonely"
	return "calm"
}

const refreshDiaryView = () => {
	diaryEntries.value = listDiary()
	todayStr.value = localDay(new Date())
	// 只在"还没选过任何一天"时默认到今天 (翻历史月份时刷新不跳回)
	if (!calSelDate.value) {
		calSelDate.value = todayStr.value
		const d = new Date()
		calYear.value = d.getFullYear()
		calMonth.value = d.getMonth()
	}
}

/** 删除某一天的日记 */
const doDeleteDiary = (date: string) => {
	if (!window.confirm(`删除 ${date} 的日记？删了就没有了`)) return
	deleteDiaryEntry(date)
	refreshDiaryView()
	triggerBubble("已删除")
}

/** 写日记的 LLM 调用 (复用主对话配置) */
const diaryLlmCall = async (prompt: string): Promise<string> => {
	if (!cfg.apiKey.trim() || !cfg.model.trim()) return ""
	const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
		{role: "system", content: prompt} as ChatMsg,
	])
	return r.ok ? (r.content ?? "") : ""
}

/** 打开日记面板时刷新 + 惰性补写昨天 (与手动写互斥, diaryBusy 防并发) */
const openDiary = () => {
	openPanel("diary")
	refreshDiaryView()
	if (diaryBusy.value) return // 正在写 → 跳过, 避免两个 LLM 调用抢回调
	// 后台补写 (不阻塞打开); 补写成功 (如补了昨天/今天) → 日历跳到那天
	if (cfg.apiKey.trim() && cfg.model.trim()) {
		diaryBusy.value = true
		void ensureDiary(diaryLlmCall)
			.then((date) => { if (date) jumpCalTo(date) })
			.finally(() => { diaryBusy.value = false; refreshDiaryView() })
	}
}

/** 手动"立即写今天" */
const doRefreshDiary = async () => {
	if (diaryBusy.value) return
	diaryBusy.value = true
	try {
		if (!cfg.apiKey.trim() || !cfg.model.trim()) {
			triggerBubble("请先在设置里配置 API Key 和模型")
			return
		}
		const r = await writeTodayDiary(diaryLlmCall)
		refreshDiaryView()
		if (r === "ok") jumpCalTo(todayStr.value)
		triggerBubble(
			r === "ok" ? "今天的日记写好啦"
				: r === "empty" ? "今天还没有对话，等聊过再写吧"
					: "日记保存失败：存储不可写（请检查存储权限）",
			r === "failed" ? 4000 : 2000,
		)
	} finally {
		diaryBusy.value = false
	}
}

const doClearMemory = () => {
	if (!window.confirm("确定清空全部长期记忆和历史摘要吗？")) return
	// 清空前自动备份 → 可"撤销上次清理"一键还原
	backupMemoryNow()
	clearMemory()
	refreshMemView()
	triggerBubble("已清空记忆")
}

const memPruneMsg = ref("")
const memPruneMsgOk = ref(false)

const doPruneMemories = () => {
	// 只在该次清理真会删东西时才备份 —— 无效清理若覆盖备份,
	// 会把"清空前"的撤销点弄丢 (上次清空的备份被空操作顶掉)
	if (pruneStalePreview() > 0) backupMemoryNow()
	const removed = pruneStaleMemories()
	if (removed > 0) {
		refreshMemView()
		memPruneMsg.value = `已清理 ${removed} 条低频记忆（30 天未提及且不重要的）`
		memPruneMsgOk.value = true
	} else {
		memPruneMsg.value = "没有需要清理的低频记忆（都很新鲜或有价值）"
		memPruneMsgOk.value = false
	}
}

/* ---------------- Fish Audio 流式 TTS UI 状态 ---------------- */
const speaking = ref(false)
const ttsTesting = ref(false)
const ttsMsg = ref("")
const ttsMsgOk = ref(false)

/** 滑块实时调整"应用内朗读音量" (只影响本 App 播放, 不动系统音量; 松手时 change 事件落盘) */
const applyTtsVolume = () => setTtsVolume(Number(cfg.ttsVolume))

/* ---------------- 背景音乐 ---------------- */
const bgmNowName = ref("")
const bgmState = ref<BgmState>("missing")
const bgmPct = ref(0)
const onBgmToggle = (e: Event): void => {
	// 控件是单向 :checked 绑定, 必须从事件取值回写 cfg (否则点击永远无效)
	cfg.bgmEnabled = (e.target as HTMLInputElement).checked
	const id = syncBgm(cfg)
	bgmNowName.value = id ? bgmNameOf(id) : ""
	persistSettings()
}
const onBgmTrackChange = (e: Event): void => {
	cfg.bgmTrack = (e.target as HTMLSelectElement).value
	const id = syncBgm(cfg)
	bgmNowName.value = id ? bgmNameOf(id) : bgmNowName.value
	persistSettings()
}
const onBgmVolume = (): void => {
	setBgmVolume(Number(cfg.bgmVolume))
	persistSettings()
}
const onBgmNext = (): void => {
	bgmNowName.value = bgmNameOf(nextBgmTrack())
}
/**
 * 「下载背景音乐资源」/「重新下载」两个按钮的入口。
 * ⚠ 不要写成 `@click="downloadBgm"` —— Vue 会把 MouseEvent 当第一个实参传进 `force`,
 * 事件对象恒为真值 ⇒ 普通下载也会被当成"强制重下"（网络白跑一趟）。
 */
const onBgmDownload = (): void => downloadBgm()
const onBgmRedownload = (): void => downloadBgm(true)
const onSfxVolume = (): void => setSfxVolume(Number(cfg.sfxVolume))

/* ---------------- 音效文件 (联网下载, 2026-10-02) ----------------
 * 5 个原版 m4a 不再进包: 点「下载音效」→ 原生桥下到应用私有目录 → 用 /sfx-local/ 播放
 * (细节见 services/sfx.ts)。这里只管设置面板那一行的状态文案。 */
const sfxMsg = ref("未下载（点右边按钮）")
const sfxMsgOk = ref(false)
const sfxMsgBad = ref(false)
const sfxBusy = ref(false)
const sfxTotal = ref(5)
/** 试过一次(或者启动时就已经齐了) ⇒ 按钮显示「重新下载」; 从没下过才是「下载音效」 */
const sfxTried = ref(false)
const sfxBtnText = computed((): string => {
	if (sfxBusy.value) return "下载中…"
	return sfxTried.value ? "重新下载" : "下载音效"
})

/** 刷新状态行 (未下载 / 下载中 / 已下载 N/N / 下载失败) —— 四态都在这一处收口 */
const sfxShowStatus = (st: {ready: boolean; done: number; total: number}, failed: string[] = []): void => {
	sfxTotal.value = st.total > 0 ? st.total : 5
	if (sfxBusy.value) {
		sfxMsg.value = "下载中…"
		sfxMsgOk.value = false
		sfxMsgBad.value = false
		return
	}
	if (failed.length) {
		sfxTried.value = true
		// 全都没下来 ≈ 网络不通 (国内直连大概率不行): 把源站一起写出来, 方便排查;
		// 个别失败就把文件名列出来 (哪个坏了再点一下只补它)
		sfxMsg.value = failed.length >= sfxTotal.value
			? `下载失败（${sfxTotal.value} 个都没下来）（可重试）· 下载源 ${SFX_SOURCE}，国内可能需要代理/魔法`
			: `下载失败：${failed.join("、")}（可重试）· 国内可能需要代理/魔法`
		sfxMsgOk.value = false
		sfxMsgBad.value = true
		return
	}
	if (st.ready) {
		sfxTried.value = true
		sfxMsg.value = `已下载 ${sfxTotal.value}/${sfxTotal.value}`
		sfxMsgOk.value = true
		sfxMsgBad.value = false
		return
	}
	sfxMsg.value = "未下载（点右边按钮）"
	sfxMsgOk.value = false
	sfxMsgBad.value = false
}

/** 读一次原生状态 (启动时读一次; 之后每次播放前由 services/sfx.ts 现问) */
const sfxRefresh = (): void => {
	const st = readSfxStatus()
	sfxShowStatus(st)
}

const doDownloadSfx = (): void => {
	if (sfxBusy.value) return
	sfxBusy.value = true
	sfxShowStatus({ready: false, done: 0, total: sfxTotal.value})
	// 不因"已下载"就短路: 原生侧对已存在且大小合理的文件会跳过, 重复点最多是一次本地校验
	const r = downloadSfx()
	if (r === "ok") return
	// 没能触发 (网页调试没有桥 / 上一次还在下): 别让按钮永远卡在"下载中…"
	sfxBusy.value = false
	sfxMsgOk.value = false
	sfxMsgBad.value = true
	sfxMsg.value = r === "err:nobridge"
		? "装到手机上才能下载（网页调试没有原生桥）"
		: r === "err:busy"
			? "上一次下载还在进行，稍等一下"
			: `下载触发失败（${r}）（可重试）`
}

/** 底部 dock 按键音 (按到按钮上才响, 点空白处不响); 安静模式也保留按键音 */
const onDockPress = (e: PointerEvent): void => {
	if ((e.target as HTMLElement)?.closest?.(".fab")) playSfx()
}
const onDataseaBgToggle = (): void => {
	setDataseaBgEnabled(cfg.dataseaBg)
	persistSettings()
}
const onAmbientToggle = (): void => {
	setAmbientEnabled(ambientAllowed())
	persistSettings()
}

/* ---------------- 安静模式 ----------------
 * 三态: 关闭 / 自动(每日 23:00–次日 8:00) / 手动。
 * 生效时: Nori 不主动搭话、BGM 暂停; TTS 朗读与按键音/音效一律保留
 * (你发消息她照常回复; 操作反馈音不静音)。 */
const quietActive = (): boolean => {
	if (cfg.quietMode === "manual") return cfg.quietOn
	if (cfg.quietMode === "auto") {
		const h = new Date().getHours()
		return h >= 23 || h < 8
	}
	return false
}
/** ambient 总闸: 设置开关 × 安静模式 × 番茄钟专注 (唯一入口, 任何重评估都走这里) */
const ambientAllowed = (): boolean => cfg.ambientEnabled && !quietActive() && !pomoFocus.value
/** 番茄钟专注期静音是否生效 (声明在使用点之前: 供 bgmHeld 与 applyQuiet 判断) */
let pomoFocusMuteOn = false
/** 现在是否应当"保持安静"(不主动搭话 / BGM 不出声): 安静模式 或 番茄钟专注期静音 */
const bgmHeld = (): boolean => quietActive() || pomoFocusMuteOn
let quietTimer = 0
const applyQuiet = (): void => {
	const q = quietActive()
	setAmbientEnabled(ambientAllowed())
	if (q || pomoFocusMuteOn) pauseBgm()
	else if (cfg.bgmEnabled) resumeBgm()
}
const onQuietModeChange = (): void => {
	pomoSulkCancelByUser()
	clearFocusMuteSnapshot()   // 用户显式改了静音设置 → 作废专注静音快照 (以用户为准)
	applyQuiet()
	persistSettings()
}
const onQuietToggle = (): void => {
	pomoSulkCancelByUser()
	clearFocusMuteSnapshot()
	applyQuiet()
	persistSettings()
}

/* ---------------- 番茄钟 ----------------
 * 计时本体在原生 PomodoroEngine (进程存活即准点触发, 完成发系统通知);
 * 这里是遥控器 + 悬浮窗视图 + 联动: 播报(sfx/TTS)/每日统计(pomo.json)/放弃静音惩罚/ambient 抑制。
 * 状态以 epoch 时间戳为准 (endAt/startedAt), WebView 端不做累加计数, 无漂移。 */
type PomoPhase = "idle" | "focus" | "break" | "countUp"
interface PomoStateT {phase: PomoPhase; paused: boolean; endAt: number; remainMs: number; focusMin: number; breakMin: number; autoBreak: boolean; startedAt: number}
interface PomoDay {focusMin: number; done: number; abort: number; countUpMin: number}
interface PomoBridgeT {
	readFile?: (n: string) => string
	writeFile?: (n: string, c: string) => string
	pomoStart?: (f: number, b: number, ab: boolean) => string
	pomoStartCountUp?: () => string
	pomoPause?: () => string
	pomoResume?: () => string
	pomoStop?: () => string
	pomoState?: () => string
	pomoRequestNotify?: () => void
}
const noriB = (): PomoBridgeT | null => (window as unknown as {NoriChat?: PomoBridgeT}).NoriChat ?? null

const pomo = ref<PomoStateT>({phase: "idle", paused: false, endAt: 0, remainMs: 0, focusMin: 25, breakMin: 5, autoBreak: true, startedAt: 0})
const pomoWidgetOn = ref(false)
const pomoMini = ref(false)
const pomoFocus = ref(false)
const pomoPos = ref({x: 16, y: 96, w: 260})
const pomoCfg = reactive({autoBreak: true, notify: true, sulkMin: 10, focusMin: 25, breakMin: 5})
const POMO_PRESETS = [
	{label: "25+5", focus: 25, break: 5},
	{label: "52+17", focus: 52, break: 17},
	{label: "90+20", focus: 90, break: 20},
	{label: "15+3", focus: 15, break: 3},
]
// 音效不再打进包 (2026-10-02): 全部走本地目录 /sfx-local/ 供流 (设置里「下载音效」下到本机)
const POMO_SFX = {start: "/sfx-local/start.m4a", complete: "/sfx-local/complete.m4a", ret: "/sfx-local/return.m4a", abandon: "/sfx-local/abandon.m4a"}
// PomoStatsFile 类型: 多了可选的 celebrated (里程碑) 与 total/best (终身累计/最佳记录)。
// **必须是 reactive**: 模板直接读 pomoStats.total / .best, 而 pomoDay/addToStore/migrateStats
// 都是原地改这个对象 —— 用普通 let 时改动不触发重渲染 (统计页的"累计"会一直显示加载前的 0)。
const pomoStats = reactive<PomoStatsFile>({v: 1, days: {}})

// 日期键统一用 services/pomo-stats 里的 dayKey (原此处另有一份同实现, 已删, 避免两处漂移)
const pomoDayKey = pomoStatDayKey
const pomoDay = (): PomoDay => {
	const k = pomoDayKey()
	if (!pomoStats.days[k]) pomoStats.days[k] = {focusMin: 0, done: 0, abort: 0, countUpMin: 0}
	return pomoStats.days[k]
}
const pomoStatsLoad = (): void => {
	try {
		const raw = noriB()?.readFile?.("pomo.json") || ""
		const parsed = raw ? JSON.parse(raw) : null
		// 原地替换内容 (不能 pomoStats = parsed: 它是 reactive, 换掉引用会丢掉响应性)
		if (parsed && parsed.days) Object.assign(pomoStats, parsed)
	} catch { /* 忽略 */ }
	// 迁移: 补 total/best (旧文件没有), 并按 10 年防御上限裁剪。
	// 注意这里**不再**按 30 天滚动删除 —— 用户要求永久保留往日数据。
	if (migrateStats(pomoStats)) pomoStatsSave()
}
const pomoStatsSave = (): void => {
	try { noriB()?.writeFile?.("pomo.json", JSON.stringify(pomoStats)) } catch { /* 忽略 */ }
}
const pomoCfgLoad = (): void => {
	try {
		const raw = localStorage.getItem("pomo_cfg")
		if (raw) Object.assign(pomoCfg, JSON.parse(raw))
		pomoCfg.focusMin = Math.min(120, Math.max(5, Number(pomoCfg.focusMin) || 25))
		pomoCfg.breakMin = Math.min(30, Math.max(1, Number(pomoCfg.breakMin) || 5))
		pomoCfg.sulkMin = Math.min(15, Math.max(0, Number(pomoCfg.sulkMin) || 0))
	} catch { /* 忽略 */ }
}
watch(pomoCfg, () => {
	try { localStorage.setItem("pomo_cfg", JSON.stringify(pomoCfg)) } catch { /* 忽略 */ }
}, {deep: true})

const pomoStateSet = (json: string): void => {
	try {
		const s = JSON.parse(json)
		if (!s || !s.phase) return
		pomo.value = {phase: s.phase, paused: !!s.paused, endAt: Number(s.endAt) || 0, remainMs: Number(s.remainMs) || 0, focusMin: Number(s.focusMin) || 25, breakMin: Number(s.breakMin) || 5, autoBreak: !!s.autoBreak, startedAt: Number(s.startedAt) || 0}
	} catch { /* 忽略 */ }
}
const pomoSyncFocus = (): void => {
	const f = pomo.value.phase === "focus" || pomo.value.phase === "countUp"
	if (f !== pomoFocus.value) {
		pomoFocus.value = f
		// 专注开始 → 立即静音 (等价于在设置里打开"立即静音", 但带快照, 专注结束自动还原);
		// 专注结束 → 还原进专注前的安静设置。
		// 注: 进入休息时 f 仍为 true, 所以静音会一直持续到整个番茄跑完或放弃 ——
		// 与"惩罚静音"的时长语义一致, 不会在专注到点那一刻把音乐放出来。
		if (f) pomoFocusMuteStart()
		else pomoFocusMuteEnd()
		setAmbientEnabled(ambientAllowed())
	}
}

/** 原生推送入口 (PomodoroEngine.evaluateJavascript) */
;(window as unknown as {__noriPomoEvent?: (json: string) => void}).__noriPomoEvent = (json: string) => {
	try {
		const e = JSON.parse(json)
		if (!e || e.type !== "end") return
		const b = noriB()
		if (b?.pomoState) pomoStateSet(b.pomoState())
		pomoSyncFocus()
		const day = pomoDay()
		if (e.phase === "focus") {
			// 专注到点后进入休息 —— 仍在一个番茄周期内, 保持静音, 不在这里还原
			day.done++; day.focusMin += pomo.value.focusMin
			addToStore(pomoStats, {focusMin: pomo.value.focusMin, done: 1})
			pomoStatsSave()
			playSfxFile(POMO_SFX.complete)
			if (pomo.value.phase === "break") window.setTimeout(() => playSfxFile(POMO_SFX.ret), 1200)
			if (isTtsReady(cfg)) { try { void speakTTS(cfg, "专注完成，做得很好。休息一下吧，我看着时间。") } catch { /* 忽略 */ } }
		} else {
			// 休息结束 = 一个完整番茄跑完 → 还原进专注前的安静设置 (BGM 恢复)
			pomoFocusMuteEnd()
			pomoSulkRestoreIfAny()
			playSfxFile(POMO_SFX.ret)
			if (isTtsReady(cfg)) { try { void speakTTS(cfg, "休息够了？回来吧，我陪着你。") } catch { /* 忽略 */ } }
		}
	} catch { /* 忽略 */ }
}

/* 显示计时 (500ms 轮询, 剩余由 epoch 推算) */
const pomoFmt = ref("00:00")
const pomoPct = ref(0)
const pomoFmtOf = (sec: number, plus = false): string => {
	const h = Math.floor(sec / 3600)
	const m = Math.floor((sec % 3600) / 60)
	const s2 = sec % 60
	const core = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}`
	return plus ? "+" + core : core
}
const pomoTick = (): void => {
	const s = pomo.value
	if (s.phase === "idle") { pomoFmt.value = "00:00"; pomoPct.value = 0; return }
	const now = Date.now()
	if (s.phase === "countUp") {
		const el = Math.max(0, s.paused ? s.remainMs : now - s.startedAt)
		pomoFmt.value = pomoFmtOf(Math.floor(el / 1000), true)
		pomoPct.value = 100
		return
	}
	const total = (s.phase === "focus" ? s.focusMin : s.breakMin) * 60
	const left = s.paused ? Math.ceil(s.remainMs / 1000) : Math.max(0, Math.ceil((s.endAt - now) / 1000))
	pomoFmt.value = pomoFmtOf(left)
	pomoPct.value = total > 0 ? Math.min(100, Math.round(((total - left) / total) * 100)) : 0
}
let pomoTickTimer = 0

/* ---------------- 番茄钟静音 (专注开始即静音) ----------------
 * 快照进专注前的安静设置 → 立即静音; 专注结束 (跑完/正向停止) 还原。
 * 与"放弃静音惩罚"共用同一套快照与 UI, 但两者**互不覆盖**:
 *   - pomoFocusMuteOn: 专注期静音是否生效 (由专注状态驱动, 覆盖整个番茄周期含休息);
 *   - pomoSulk:        放弃惩罚的快照 (由 pomoSulkStart/Restore 驱动)。
 * 放弃时 pomoFocusMuteOn 仍为真 → pomoSulkStart 保留已有快照不再新建,
 * 于是"开始即静音、放弃后继续安静"是同一个快照, 行为与原方案一致。
 * 注: pomoFocusMuteOn 的声明在使用点之前 (见 applyQuiet/bgmHeld 附近)。
 */
/** 专注开始: 立即静音。
 *  已是"手动静音"态时**只维持、不建快照** —— 因为无法区分这两种情形:
 *    ① 用户本来就开着立即静音 (结束时应保持静音);
 *    ② App 在专注中途被重启, 页面重载后 pomoFocusMuteOn 归零、而 quietMode 已是
 *       manual+on (原生计时器仍在跑) —— 此时若建快照, 记下的就是"静音中",
 *       专注结束后会还原成静音, 音乐再也不恢复。
 *  两种情形下"保持静音"都不会做错, 所以选择不建快照。 */
const pomoFocusMuteStart = (): void => {
	if (pomoFocusMuteOn) return
	pomoFocusMuteOn = true
	if (cfg.quietMode === "manual" && cfg.quietOn) return
	const snap = {mode: cfg.quietMode as "off" | "auto" | "manual", on: cfg.quietOn}
	pomoSulk = {...snap, timer: 0}
	saveFocusMuteSnapshot(snap)   // 落盘: 专注期间被杀也能在下次启动还原
	cfg.quietMode = "manual"
	cfg.quietOn = true
	applyQuiet()
}
/** 专注结束: 还原进专注前的安静设置 */
const pomoFocusMuteEnd = (): void => {
	if (!pomoFocusMuteOn) return
	pomoFocusMuteOn = false
	pomoSulkRestoreIfAny()
}

/* 专注静音快照的持久化 (localStorage)。
 * 为什么必须持久化: 进入专注会把 quietMode 改成 manual+on 并 persistSettings() 写进磁盘,
 * 而快照(模块级 pomoSulk/pomoFocusMuteOn)随进程消失。若 App 在专注期间被杀再重开:
 *   pomoFocusMuteOn=false 但 quietMode 已是 manual+on
 *   → pomoFocusMuteStart 的"已是静音态就提前 return"命中 → 永远没有快照
 *   → 专注结束后 pomoSulkRestoreIfAny() 无物可还原 → 静音永久卡住
 *     (表现: BGM 再也不响、Nori 再也不主动搭话)
 * 所以把"进入专注前是什么状态"落盘, 启动时据此自愈。 */
const FOCUS_MUTE_KEY = "pomo_focus_mute_snapshot"
type QuietSnapshot = {mode: "off" | "auto" | "manual"; on: boolean}
const saveFocusMuteSnapshot = (snap: QuietSnapshot): void => {
	try { localStorage.setItem(FOCUS_MUTE_KEY, JSON.stringify(snap)) } catch { /* 忽略 */ }
}
const clearFocusMuteSnapshot = (): void => {
	try { localStorage.removeItem(FOCUS_MUTE_KEY) } catch { /* 忽略 */ }
}
/** 启动自愈: 存在残留快照 = 上次专注期间被中断 → 还原之后再 applyQuiet。
 *  必须在 onMounted 的 applyQuiet() 之前调用, 否则会先按"卡住的静音态"应用一次。 */
const recoverFocusMuteIfNeeded = (): void => {
	try {
		const raw = localStorage.getItem(FOCUS_MUTE_KEY)
		if (!raw) return
		const snap = JSON.parse(raw) as QuietSnapshot
		if (snap && (snap.mode === "off" || snap.mode === "auto" || snap.mode === "manual")) {
			cfg.quietMode = snap.mode
			cfg.quietOn = !!snap.on
		}
	} catch { /* 忽略 */ }
	clearFocusMuteSnapshot()
}

/* 放弃静音惩罚: 快照当前安静设置 → manual+on; 期间用户动过开关则由用户接管, 恢复写回设置 */
let pomoSulk: {mode: "off" | "auto" | "manual"; on: boolean; timer: number} | null = null
const pomoSulkStart = (): void => {
	// 专注期静音的快照还挂着 → 它就是"进专注前"的快照, 保留即可, 不要覆盖
	if (pomoFocusMuteOn) return
	if (cfg.quietMode === "manual" && cfg.quietOn) return
	const sulk: {mode: "off" | "auto" | "manual"; on: boolean; timer: number} = {mode: cfg.quietMode as "off" | "auto" | "manual", on: cfg.quietOn, timer: 0}
	pomoSulk = sulk
	cfg.quietMode = "manual"
	cfg.quietOn = true
	applyQuiet()
	if (pomoCfg.sulkMin > 0) sulk.timer = window.setTimeout(pomoSulkRestore, pomoCfg.sulkMin * 60000)
}
const pomoSulkRestore = (): void => {
	if (!pomoSulk) return
	if (pomoSulk.timer) clearTimeout(pomoSulk.timer)
	cfg.quietMode = pomoSulk.mode
	cfg.quietOn = pomoSulk.on
	applyQuiet()
	persistSettings()
	pomoSulk = null
	clearFocusMuteSnapshot()   // 已还原: 清掉落盘快照, 避免下次启动误自愈
}
/** 惩罚期内用户手动碰了静音 → 撤销自动恢复 (保留用户的选择) */
const pomoSulkCancelByUser = (): void => {
	if (!pomoSulk) return
	if (pomoSulk.timer) clearTimeout(pomoSulk.timer)
	pomoSulk = null
	// 用户接管了静音状态: 落盘快照必须作废, 否则下次启动自愈会把他的选择改回去
	clearFocusMuteSnapshot()
}
/** 恢复快照 (若存在): 专注结束 / 惩罚到点 / 正向计时结束共用 */
const pomoSulkRestoreIfAny = (): void => { if (pomoSulk) pomoSulkRestore() }

/* 操作 */
const pomoStartImpl = (f: number, b: number): void => {
	const b2 = noriB()
	if (!b2?.pomoStart) return
	pomoStateSet(b2.pomoStart(Math.min(120, Math.max(1, Math.round(f))), Math.min(30, Math.max(1, Math.round(b))), pomoCfg.autoBreak))
	pomoWidgetOn.value = true
	pomoSyncFocus()
	playSfxFile(POMO_SFX.start)
	if (pomoCfg.notify) b2.pomoRequestNotify?.()
}
const pomoCountUpImpl = (): void => {
	const b = noriB()
	if (!b?.pomoStartCountUp) return
	pomoStateSet(b.pomoStartCountUp())
	pomoWidgetOn.value = true
	pomoSyncFocus()
	playSfxFile(POMO_SFX.start)
	if (pomoCfg.notify) b.pomoRequestNotify?.()
}
const pomoPauseBtn = (): void => {
	const b = noriB()
	if (!b) return
	if (pomo.value.paused) pomoStateSet(b.pomoResume?.() || "")
	else pomoStateSet(b.pomoPause?.() || "")
}
const pomoStopBtn = (): void => {
	const b = noriB()
	if (!b?.pomoStop) return
	let r: PomoStateT & {endedPhase?: PomoPhase; elapsedMs?: number}
	try { r = JSON.parse(b.pomoStop()) } catch { return }
	pomoStateSet(JSON.stringify(r))
	pomoSyncFocus()
	const day = pomoDay()
	if (r.endedPhase === "focus") {
		const elMin = Math.round((r.elapsedMs || 0) / 60000)
		day.abort++; day.focusMin += elMin
		addToStore(pomoStats, {focusMin: elMin})
		pomoStatsSave()
		playSfxFile(POMO_SFX.abandon)
		if (isTtsReady(cfg)) { try { void speakTTS(cfg, "……好吧。") } catch { /* 忽略 */ } }
		pomoSulkStart()
	} else if (r.endedPhase === "countUp") {
		pomoSulkRestoreIfAny()
		const elMin = Math.round((r.elapsedMs || 0) / 60000)
		day.countUpMin += elMin
		addToStore(pomoStats, {countUpMin: elMin})
		pomoStatsSave()
	}
}
const pomoGoBtn = (): void => {
	if (pomo.value.phase === "focus" || pomo.value.phase === "break") { pomoStopBtn(); return }
	pomoStartImpl(pomoCfg.focusMin, pomoCfg.breakMin)
}
const pomoCountUpBtn = (): void => {
	if (pomo.value.phase === "countUp") { pomoStopBtn(); return }
	pomoCountUpImpl()
}
const pomoOnNotifyChange = (): void => { if (pomoCfg.notify) noriB()?.pomoRequestNotify?.() }

/* 面板文案 */
const pomoPhaseText = computed((): string => {
	if (pomo.value.phase === "focus") return pomo.value.paused ? "已暂停 · 专注" : "专注中"
	if (pomo.value.phase === "break") return pomo.value.paused ? "已暂停 · 休息" : "休息中"
	return "正向计时"
})
const pomoGoLabel = computed((): string => {
	const p = pomo.value.phase
	if (p === "focus" || p === "break" || p === "countUp") return "放弃当前"
	return `开始专注 ${pomoCfg.focusMin} 分钟`
})
const pomoTodayText = computed((): string => {
	const d = pomoStats.days[pomoDayKey()]
	return `${(d?.focusMin || 0) + (d?.countUpMin || 0)} 分钟 · 完成 ${d?.done || 0} · 中断 ${d?.abort || 0}`
})
// 注: 原先这里还有一个固定的 7 天 pomoBars, 已被 pomoRangeBars (7/30/365 可切) 取代并删除

/* ---------------- 专注统计: 面板展示 + 给 Nori 的克制注入 ----------------
 * 展示(面板)与注入(Nori 台词)分工不同:
 *   - 面板给出全部客观数据, 包括完成率/中断这类"自我批评"指标, 是给你自己看的;
 *   - Nori 嘴里最多提一件**正向且话题相关**的事, 且一天一次 (见 buildFocusHint)。
 * 汇总计算与注入判定都在 services/pomo-stats.ts (纯逻辑, 有单测)。 */
const pomoSummary = computed<PomoSummary>(() => pomoSummarize(pomoStats.days, 7))

/* ---- 统计范围切换 (柱状图: 7 / 30 / 365 天) ---- */
const pomoRange = ref<7 | 30 | 365>(7)
const pomoRangeBars = computed(() => {
	const n = pomoRange.value
	const out: {day: string; label: string; min: number; h: number}[] = []
	let max = 1
	// 柱子太密时只标部分标签 (30 天每 5 天一个, 365 天只标月份首日)
	const labelStep = n <= 7 ? 1 : n <= 30 ? 5 : 30
	for (let i = n - 1; i >= 0; i--) {
		const d = new Date(Date.now() - i * 86400000)
		const k = pomoDayKey(d)
		const min = (pomoStats.days[k]?.focusMin || 0) + (pomoStats.days[k]?.countUpMin || 0)
		if (min > max) max = min
		const showLabel = i === 0 || (labelStep > 1 && i % labelStep === 0)
		out.push({
			day: k,
			label: showLabel ? (i === 0 ? "今" : (n > 30 ? `${d.getMonth() + 1}月` : String(d.getDate()))) : "",
			min,
			h: 4,
		})
	}
	for (const o of out) o.h = Math.max(4, Math.round((o.min / max) * 100))
	return out
})
const pomoRangeSummary = computed<PomoSummary>(() => pomoSummarize(pomoStats.days, pomoRange.value))

/* ---- 独立统计页: 热力图 + 点选某天 + 月度汇总 ---- */
const pomoSelectedDay = ref<{date: string; min: number; done: number; abort: number} | null>(null)
const pomoHeat = computed<Heatmap>(() => buildHeatmap(pomoStats.days, 52))
const pomoMonths = computed(() => monthlyRollup(pomoStats.days, 12))
const pomoHeatCanvas = ref<HTMLCanvasElement | null>(null)

/** 画热力图: 静态重绘 (数据变化才画), 不参与逐帧 ——
 *  避免和 Live2D(WebGL) / 数据海(2D canvas) 抢同一个 GPU。 */
const CELL = 9
const CELL_GAP = 2
const HEAT_COLORS = ["rgba(148,163,184,0.10)", "rgba(103,183,255,0.35)", "rgba(103,183,255,0.55)", "rgba(103,183,255,0.78)", "rgba(103,183,255,1)"]
const drawHeatmap = (): void => {
	const cv = pomoHeatCanvas.value
	if (!cv) return
	const hm = pomoHeat.value
	const dpr = Math.min(window.devicePixelRatio || 1, 2)
	const w = hm.weeks * (CELL + CELL_GAP)
	const hgt = 7 * (CELL + CELL_GAP)
	cv.width = Math.round(w * dpr)
	cv.height = Math.round(hgt * dpr)
	cv.style.width = `${w}px`
	cv.style.height = `${hgt}px`
	const ctx = cv.getContext("2d")
	if (!ctx) return
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, w, hgt)
	const step = CELL + CELL_GAP
	for (let w2 = 0; w2 < hm.weeks; w2++) {
		for (let row = 0; row < 7; row++) {
			const c = hm.cells[w2 * 7 + row]
			ctx.fillStyle = c ? HEAT_COLORS[c.level] : "transparent"
			if (!c) continue
			ctx.fillRect(w2 * step, row * step, CELL, CELL)
		}
	}
}
/** 点热力图 → 选中某天 (反算列/行) */
const onHeatClick = (e: MouseEvent): void => {
	const cv = pomoHeatCanvas.value
	if (!cv) return
	const rect = cv.getBoundingClientRect()
	const step = CELL + CELL_GAP
	const col = Math.floor((e.clientX - rect.left) / step)
	const row = Math.floor((e.clientY - rect.top) / step)
	if (col < 0 || col >= pomoHeat.value.weeks || row < 0 || row > 6) return
	const c = pomoHeat.value.cells[col * 7 + row]
	if (!c) return
	const d = pomoStats.days[c.date]
	pomoSelectedDay.value = {date: c.date, min: c.min, done: d?.done || 0, abort: d?.abort || 0}
}
/** 进入统计页时画一次 (面板打开后 canvas 才有尺寸) */
const openPomoStats = (): void => {
	panel.value = "pomoStats"
	void nextTick(() => drawHeatmap())
}
// 面板开着时数据变了 (如番茄完成/放弃) → 重绘热力图, 否则它停在旧状态
watch([pomoHeat, () => panel.value], () => {
	if (panel.value === "pomoStats") void nextTick(() => drawHeatmap())
})
/** 累计时长的人话格式 */
const fmtTotalMin = (m: number): string => (m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`)

/** "今天已经跟 Nori 提过专注"的日期标记 (每天最多提一次, 避免连着聊工作就句句提) */
const POMO_HINT_DAY_KEY = "pomo_hint_day"
const focusHintDay = ref<string>(
	(() => { try { return localStorage.getItem(POMO_HINT_DAY_KEY) || "" } catch { return "" } })(),
)
/** 清掉过期的"已提过"标记 (跨天自动重置, 无需定时器) */
const focusHintFresh = (): boolean => focusHintDay.value !== pomoStatDayKey()
const markFocusHinted = (): void => {
	focusHintDay.value = pomoStatDayKey()
	try { localStorage.setItem(POMO_HINT_DAY_KEY, focusHintDay.value) } catch { /* 忽略 */ }
}

/** 里程碑"只庆祝一次"的标记持久化 (与 pomo.json 的 celebrated 同步) */
const markCelebrated = (key: string): void => {
	try {
		pomoStats.celebrated = {...(pomoStats.celebrated ?? {}), [key]: Date.now()}
		pomoStatsSave()
	} catch { /* 忽略 */ }
}

/* 悬浮窗: 拖拽 + 缩放 (位置/大小 localStorage 持久化; 组件根 pointerdown.stop 截断, 不惊动摸头/缩放手势) */
const pomoPosLoad = (): void => {
	try {
		const raw = localStorage.getItem("pomo_widget")
		if (raw) {
			const o = JSON.parse(raw)
			pomoPos.value = {x: Number(o.x) || 16, y: Number(o.y) || 96, w: Math.min(480, Math.max(240, Number(o.w) || 260))}
			pomoMini.value = !!o.mini
		}
	} catch { /* 忽略 */ }
	pomoClampPos()
}
const pomoPosSave = (): void => {
	try { localStorage.setItem("pomo_widget", JSON.stringify({...pomoPos.value, mini: pomoMini.value})) } catch { /* 忽略 */ }
}
const pomoClampPos = (): void => {
	pomoPos.value.x = Math.min(Math.max(4, pomoPos.value.x), Math.max(4, window.innerWidth - pomoPos.value.w - 4))
	pomoPos.value.y = Math.min(Math.max(4, pomoPos.value.y), Math.max(4, window.innerHeight - 150))
}
let pomoDragSt: {px: number; py: number; x: number; y: number} | null = null
const onPomoDragDown = (e: PointerEvent): void => {
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
	pomoDragSt = {px: e.clientX, py: e.clientY, x: pomoPos.value.x, y: pomoPos.value.y}
}
const onPomoDragMove = (e: PointerEvent): void => {
	if (!pomoDragSt) return
	pomoPos.value.x = pomoDragSt.x + e.clientX - pomoDragSt.px
	pomoPos.value.y = pomoDragSt.y + e.clientY - pomoDragSt.py
	pomoClampPos()
}
const onPomoDragUp = (): void => { if (pomoDragSt) { pomoDragSt = null; pomoPosSave() } }
let pomoRzSt: {px: number; w: number} | null = null
const onPomoRzDown = (e: PointerEvent): void => {
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
	pomoRzSt = {px: e.clientX, w: pomoPos.value.w}
}
const onPomoRzMove = (e: PointerEvent): void => {
	if (!pomoRzSt) return
	pomoPos.value.w = Math.min(480, Math.max(240, pomoRzSt.w + e.clientX - pomoRzSt.px))
}
const onPomoRzUp = (): void => { if (pomoRzSt) { pomoRzSt = null; pomoPosSave() } }

/* 初始化 (setup 期): 统计/配置/组件位置/桥状态/显示节拍 */
pomoStatsLoad()
pomoCfgLoad()
pomoPosLoad()
try { const b0 = noriB(); if (b0?.pomoState) pomoStateSet(b0.pomoState()) } catch { /* 忽略 */ }
if (pomo.value.phase !== "idle") pomoWidgetOn.value = true   // 计时中刷新/重载: 组件自动回来
pomoTick()
pomoTickTimer = window.setInterval(pomoTick, 500)
window.addEventListener("resize", pomoClampPos)

/* ---------------- CosyVoice 声音克隆 ---------------- */

/** 音色提示文案; 无问题时为空串。
 *  两类致命问题 —— 同一个错误(InvalidParameter)的两面, 都必须在使用前拦下:
 *  - 没设音色: 本项目一律用自有克隆音色, 不用任何系统音色, 留空必然失败。
 *  - 音色是为**别的模型**克隆的: 官方明确"不能将一个模型的音色与另一个模型混用",
 *    切换模型后继续用旧克隆是最容易踩的一种。
 *  "归属"只在这里经 cosyVoiceModelOf 算一次 (它内部会先查记录、再用音色 id 前缀兜底),
 *  避免两处各算一遍而漂移; 合成侧 streamCosyTTS 用同一套文案本地拦截, 保证说法一致。
 *  完全认不出来 (不属于已知模型) 就返回 "", 宁可少提示也不误报。 */
const cosyVoiceHint = computed(() => {
	const v = (cfg.cosyVoice ?? "").trim()
	if (!v) return COSY_NO_VOICE_ERROR
	const vm = cosyVoiceModelOf(cfg)
	return vm && vm !== cfg.cosyModel ? cosyVoiceModelError(v, vm, cfg.cosyModel) : ""
})

const clonePrefix = ref("myvoice")
const cloneFileName = ref("")
const cloneFileSize = ref(0)
const clonePicking = ref(false)
const cloneCreating = ref(false)
const cloneMsg = ref("")
const cloneMsgOk = ref(false)
const cloneStatusText = ref("")
const cloneStatusOk = ref(false)
let cloneVoiceId = ""

/* ---------------- 模型授权验证（答题门，2026-10-01；2026-10-02 抽成两处共用） ----------------
   同一道门守两个"要联网拿 inori 东西"的动作：
     · clone —— 一键克隆内置音色（原样：建音色 → 轮询审核 → 选中并持久化；参考音频同样走**联网下载**，
                 原生侧负责下载+规范成 16bit，见 ChatBridge.createPresetCloneVoice）
     · model —— 下载还没装的 Live2D 模型（见下面 pick()：**答对才真的开始下载**）
   题面/答案/判卷在 services/tts/clone-gate.ts（唯一事实源）；这里只放"这道门此刻为谁开"。
   弹窗只有一份，克隆那边的类名(.clone-gate)与文案一字未改 —— probe-clone-gate 是护栏。 */
type GateKind = "clone" | "model"
const gateOn = ref(false)
const gateKind = ref<GateKind>("clone")
const gateInput = ref("")
const gateMsg = ref("")
const gateOk = ref(false)
const gateBusy = ref(false)
/** 答对之后的"放行动作"（目前只有下载模型用得上：关掉弹窗再走原来的"切模型→下载"流程）。
 *  克隆的动作就在门里跑（要把"审核中…"一直显示在弹窗里），所以它是 null。 */
let gatePass: (() => void) | null = null

/** 主按钮文案：克隆那两句原样保留；下载模型按动作改成"验证并下载" */
const gateGoLabel = computed(() => (gateKind.value === "clone" ? "验证并克隆" : "验证并下载"))
const gateBusyLabel = computed(() => (gateKind.value === "clone" ? "创建中…" : "下载中…"))

/** 开门：清掉上一次的输入/提示。onPass 只在**答对之后**才被调用（答错/取消都碰不到它） */
const openGate = (kind: GateKind, onPass?: () => void): void => {
	gateKind.value = kind
	gatePass = onPass ?? null
	gateInput.value = ""
	gateMsg.value = ""
	gateOk.value = false
	gateOn.value = true
}
/** 取消 / 点遮罩 / 点✕：关门即放弃（gatePass 一起丢掉 ⇒ 绝不会偷偷开始下载）；忙的时候不许关 */
const closeGate = (): void => {
	if (gateBusy.value) return
	gateOn.value = false
	gatePass = null
}

/** 一键克隆的入口按钮（TTS 页）：开同一道门，答对后走下面 clone 那套 */
const openCloneGate = (): void => openGate("clone")

/** 一键克隆：判卷已由 doGate 做掉 → 建音色 → 轮询审核（与手动流程一致）→ 选中并持久化 */
const doCloneGate = async (): Promise<void> => {
	const key = cfg.cosyApiKey?.trim() || ""
	if (!key) {
		gateOk.value = false
		gateMsg.value = "请先在「语音」里填写千问 API Key"
		return
	}
	gateBusy.value = true
	gateMsg.value = ""
	// 锁定模型: 后面轮询最长 2 分钟, 期间用户可能改下拉, 记错模型会让"音色↔模型"绑定失真
	const gateModel = cfg.cosyModel || "cosyvoice-v3.5-flash"
	try {
		const r = await createPresetCloneVoice(key, gateModel, clonePrefix.value.trim() || "nori")
		if (!r.ok) {
			gateOk.value = false
			gateMsg.value = r.message ?? "创建失败"
			return
		}
		const vid = r.voice_id ?? ""
		gateOk.value = true
		gateMsg.value = "已创建，等待审核…"
		for (let i = 0; i < 24; i++) {
			await new Promise((res) => setTimeout(res, 5000))
			const q = await queryCloneVoice(key, vid)
			if (!q.ok) { gateOk.value = false; gateMsg.value = `查询失败: ${q.message ?? ""}`; return }
			const st = q.status ?? ""
			if (st === "OK") {
				cfg.cosyVoice = vid
				rememberCloneVoice(vid, q.target_model || gateModel)
				persistSettings()
				gateOk.value = true
				gateMsg.value = "审核通过 ✅ 已设为当前音色"
				triggerBubble("音色准备好了，说句话试试？")
				setTimeout(() => { gateOn.value = false; gateBusy.value = false }, 1200)
				return
			}
			if (st === "UNDEPLOYED") {
				gateOk.value = false
				gateMsg.value = "审核未通过（UNDEPLOYED），换一段音频再试吧"
				return
			}
			gateMsg.value = `审核中… (${Math.min(i + 1, 24)}/24)`
		}
		gateOk.value = false
		gateMsg.value = "等太久了，稍后可在「音色」里看看有没有出来"
	} finally {
		gateBusy.value = false
	}
}

/** 判卷（两处动作共用）：答错只提示、**不执行任何动作**；答对才分岔到具体动作 */
const doGate = async (): Promise<void> => {
	if (gateBusy.value) return
	if (!checkCloneAnswer(gateInput.value)) {
		gateOk.value = false
		gateMsg.value = "答案不对，再想想～"
		return
	}
	if (gateKind.value === "clone") { await doCloneGate(); return }
	// 下载模型：答对即放行 —— 关掉弹窗，进度/状态回到原来的模型加载流程（topbar 的"下载 X…"）
	const pass = gatePass
	gateOn.value = false
	gatePass = null
	gateOk.value = false
	gateMsg.value = ""
	pass?.()
}

const fmtSize = (n: number): string =>
	n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`

const doPickVoice = async () => {
	clonePicking.value = true
	cloneMsg.value = ""
	try {
		const r = await pickVoiceFile()
		if (r.ok) {
			cloneFileName.value = r.name ?? "audio"
			cloneFileSize.value = r.size ?? 0
			cloneMsg.value = ""
		} else {
			cloneMsg.value = r.message ?? "选择失败"
			cloneMsgOk.value = false
		}
	} finally {
		clonePicking.value = false
	}
}

/** 记录/更新某个克隆音色的所属模型 (同 id 覆盖, 新 id 追加)。
 *  必须持久化这个绑定关系: 官方明确音色不能跨模型混用, 不记下来用户一换模型就会静默用错音色。 */
const rememberCloneVoice = (id: string, model: string): void => {
	const vid = (id ?? "").trim()
	if (!vid) return
	const m = (model ?? "").trim()
	const list = cfg.cosyCloneVoices ?? []
	const i = list.findIndex((x) => x?.id === vid)
	if (i < 0) cfg.cosyCloneVoices = [...list, {id: vid, model: m}]
	else if (m && list[i].model !== m) cfg.cosyCloneVoices = list.map((x, k) => (k === i ? {...x, model: m} : x))
}

const doCreateClone = async () => {
	if (!cloneFileName.value) return
	cloneCreating.value = true
	cloneMsg.value = ""
	cloneStatusText.value = ""
	try {
		const key = cfg.cosyApiKey?.trim() || ""
		if (!key) {
			cloneMsg.value = "请先填写千问 API Key"
			cloneMsgOk.value = false
			return
		}
		// 锁定克隆用的模型: 后面轮询最长 2 分钟, 期间用户可能改「模型」下拉,
		// 记错模型会让"绑定关系"直接失真
		const cloneModel = cfg.cosyModel || "cosyvoice-v3.5-flash"
		const r = await createCloneVoice(key, cloneModel, clonePrefix.value.trim() || "myvoice")
		if (!r.ok) {
			cloneMsg.value = r.message ?? "创建失败"
			cloneMsgOk.value = false
			return
		}
		cloneVoiceId = r.voice_id ?? ""
		cloneMsg.value = `创建成功，等待审核…`
		cloneMsgOk.value = true
		// 轮询状态直到 OK / UNDEPLOYED (最多 ~2 分钟)
		for (let i = 0; i < 24; i++) {
			await new Promise((res) => setTimeout(res, 5000))
			const q = await queryCloneVoice(key, cloneVoiceId)
			if (!q.ok) {
				cloneStatusText.value = `查询失败: ${q.message ?? ""}`
				cloneStatusOk.value = false
				break
			}
			const st = q.status ?? ""
			if (st === "OK") {
				cloneStatusText.value = `审核通过 ✅ 已加入我的音色`
				cloneStatusOk.value = true
				cfg.cosyVoice = cloneVoiceId
				// 记下"这个音色是为哪个模型克隆的": 接口返回的 target_model 最权威,
				// 缺失时退回克隆时锁定的 cloneModel (不是当前下拉值)
				rememberCloneVoice(cloneVoiceId, q.target_model || cloneModel)
				persistSettings()
				break
			}
			if (st === "UNDEPLOYED") {
				cloneStatusText.value = `审核未通过 (UNDEPLOYED)，请更换音频重试`
				cloneStatusOk.value = false
				break
			}
			cloneStatusText.value = `审核中… (${Math.min(i + 1, 24)}/24)`
			cloneStatusOk.value = true
		}
	} finally {
		cloneCreating.value = false
	}
}

onSpeakingChange((playing) => {
	speaking.value = playing
	// TTS 闪避: Nori 开口朗读时背景音乐自动压低到 20%, 说完恢复
	setBgmDucking(playing)
	/* 摸头台词的气泡"说完即收" —— ⚠ `onSpeakingChange` 是**单槽赋值**
	   （`player.onStateChange = cb`）, 所以这段必须写在这个**已有**的回调里,
	   另起一次 `onSpeakingChange(...)` 会把上面的"停止朗读按钮 + BGM 闪避"整个覆盖掉。 */
	if (petLineVoiceTailTimer) { clearTimeout(petLineVoiceTailTimer); petLineVoiceTailTimer = null }
	if (playing) {
		lastVoiceAt = Date.now()
		if (petLineBubble) petLineSpoke = true
		return
	}
	// 只有"确实开过口"才收; 一直没出声(TTS 失败)交给 7s 兜底定时器
	if (!petLineBubble || !petLineSpoke) return
	/* ⚠ 不能立刻收: `speaking=false` 未必是"说完了" —— 流式播放中间的静默
	   （句间 / WebAudio 回退逐块播 / 网络卡一下）也会把它置回 false,
	   立刻收会把气泡在"说到一半"时抹掉。等一个 VOICE_TAIL 再确认一次静默。 */
	petLineVoiceTailTimer = setTimeout(() => {
		petLineVoiceTailTimer = null
		if (!speaking.value && Date.now() - lastVoiceAt >= PET_LINE_VOICE_TAIL_MS) clearPetLineBubble()
	}, PET_LINE_VOICE_TAIL_MS)
})

const doTestTTS = async () => {
	ttsTesting.value = true
	ttsMsg.value = ""
	try {
		const r = await testTTS(cfg)
		if (r.ok) {
			ttsMsg.value = "连接成功，正在试听…"
			ttsMsgOk.value = true
		} else {
			ttsMsg.value = r.error ?? "测试失败"
			ttsMsgOk.value = false
		}
	} finally {
		ttsTesting.value = false
	}
}

/* ---------------- 余额查询 ---------------- */
const balFish = ref("")
const balDs = ref("")
const balCosy = ref("")
const balFishLoading = ref(false)
const balDsLoading = ref(false)
const balCosyLoading = ref(false)
const balMsg = ref("")
const balMsgOk = ref(false)

const queryFishBalance = async () => {
	if (!(cfg.ttsApiKey ?? "").trim()) {
		balMsg.value = "请先填写 Fish Audio API Key"
		balMsgOk.value = false
		return
	}
	balFishLoading.value = true
	balMsg.value = ""
	try {
		const r = await checkFishBalance(cfg.ttsBaseUrl, cfg.ttsApiKey)
		if (r.ok) {
			balFish.value = `余额 ${r.credit ?? "0"}${r.hasFreeCredit ? "（含免费额度）" : ""}`
			balMsg.value = "Fish Audio 余额查询成功"
			balMsgOk.value = true
		} else {
			balFish.value = ""
			balMsg.value = `Fish Audio: ${r.message ?? "查询失败"}`
			balMsgOk.value = false
		}
	} finally {
		balFishLoading.value = false
	}
}

const queryDeepSeekBalance = async () => {
	if (!(cfg.apiKey ?? "").trim()) {
		balMsg.value = "请先在聊天设置里配置 DeepSeek API Key"
		balMsgOk.value = false
		return
	}
	balDsLoading.value = true
	balMsg.value = ""
	try {
		const r = await checkDeepSeekBalance(cfg.baseUrl, cfg.apiKey)
		if (r.ok) {
			balDs.value = r.balance ?? "无余额信息"
			balMsg.value = r.isAvailable === false ? "DeepSeek 账户当前不可用" : "DeepSeek 余额查询成功"
			balMsgOk.value = r.isAvailable !== false
		} else {
			balDs.value = ""
			balMsg.value = `DeepSeek: ${r.message ?? "查询失败"}`
			balMsgOk.value = false
		}
	} finally {
		balDsLoading.value = false
	}
}

const queryCosyBalance = async () => {
	if (!(cfg.cosyApiKey ?? "").trim()) {
		balMsg.value = "请先填写千问 API Key"
		balMsgOk.value = false
		return
	}
	balCosyLoading.value = true
	balMsg.value = ""
	try {
		const r = await checkCosyBalance(cfg.cosyBaseUrl, cfg.cosyApiKey)
		if (r.ok) {
			balCosy.value = r.balance ?? "无余额信息"
			balMsg.value = "千问余额查询成功"
			balMsgOk.value = true
		} else {
			balCosy.value = ""
			balMsg.value = `千问: ${r.message ?? "查询失败"}`
			balMsgOk.value = false
		}
	} finally {
		balCosyLoading.value = false
	}
}

/* ---------------- 音色列表 ---------------- */
const voiceOptions = ref<VoiceInfo[]>([])
const voicesLoading = ref(false)
const voicesMsg = ref("")
const voicesMsgOk = ref(false)

const loadVoices = async () => {
	if (!(cfg.ttsApiKey ?? "").trim()) {
		voicesMsg.value = "请先填写 Fish Audio API Key"
		voicesMsgOk.value = false
		return
	}
	voicesLoading.value = true
	voicesMsg.value = ""
	try {
		const r = await fetchVoices(cfg.ttsBaseUrl, cfg.ttsApiKey)
		if (r.ok) {
			voiceOptions.value = r.voices ?? []
			voicesMsg.value = voiceOptions.value.length
				? `找到 ${voiceOptions.value.length} 个可用音色（只显示已训练的 TTS 音色）`
				: "没有找到音色。可在 fish.audio 克隆音色, 或手动输入 Reference ID"
			voicesMsgOk.value = true
		} else {
			voicesMsg.value = r.message ?? "拉取音色列表失败"
			voicesMsgOk.value = false
		}
	} finally {
		voicesLoading.value = false
	}
}




/** 正文关键词 → 表情名 (规则在 markerRules.ts 共享) */
const detectExpression = (text: string): string | null =>
	detectExpressionByRules(text, expressions.value)

const playIdleMotionOnce = () => {
	const p = pickNeutralIdle(motions.value)
	if (p) l2d.playMotionByIndex(p.group, p.index)
}

/** 万能兜底动作: 映射失败时播放 idle 循环动作 (中性, 不和表情打架) */
const playIdleFallback = () => {
	const p = pickNeutralIdle(motions.value)
	if (p) l2d.playMotionByIndex(p.group, p.index)
}

/** 标记驱动的表情处理: 映射成功播放, 失败则清除当前表情 (不播随机 idle, 避免与动作叠加)
 *  **摸头表情优先**（用户定的规格 3）: 正在摸头时不抢"表情层" —— 否则一张嘴就把被摸时的脸换掉。 */
const playMarkerEmotion = (word: string): void => {
	if (petExpressionHoldsLayer()) return
	const emo = resolveMarkerEmotionShared(word, expressions.value)
	if (emo) {
		try { l2d.playExpression(emo) } catch { /* 忽略 */ }
	} else {
		try { l2d.stopExpression() } catch { /* 忽略 */ }
	}
}

/** 标记驱动的动作处理: 映射成功播放, 失败则播 idle 万能兜底 (不和表情打架)
 *  播完统一"回中性状态" —— 模型里所有动作都是 Loop:true 不会自己结束,
 *  不切回去就会一直保持(实测: 说「困」后一直睡到下次说话)。 */
const playMarkerMotion = (word: string): void => {
	const mo = resolveMarkerMotionShared(word, flatMotionNames())
	if (mo) {
		void l2d.playMotionByName(mo)
		scheduleReturnToNeutral(returnToNeutral)
	} else playIdleFallback()
}

/** 回中性状态: 中性 idle + 清掉表情 (否则「困」的 Sleep 表情会让眼睛一直闭着, 看着还是睡)
 *  但**正在摸头时不清表情** —— 那是用户定"摸头优先"的另一半（否则动作到点回中性会把被摸的脸抹掉）。 */
const returnToNeutral = (): void => {
	playIdleFallback()
	if (petExpressionHoldsLayer()) return
	try { l2d.stopExpression() } catch { /* 忽略 */ }
}

/** 所有动作名 (扁平列表, 供匹配与 AI 选择) */
const flatMotionNames = (): string[] => {
	const names: string[] = []
	for (const g of motions.value) {
		for (const n of g.names) names.push(n)
	}
	return names
}

/**
 * 关键词规则选动作并播放 (立即反馈; AI 细化在 analyzeAfterReply).
 * 命中即播放 (force 优先级覆盖随机 idle), 未命中不打扰. 规则在 markerRules.ts 共享.
 */
const pickMotionByKeyword = (text: string): void => {
	if (!ready.value || !motions.value.length) return
	const hit = detectMotionByRules(text, flatMotionNames())
	if (hit) {
		void l2d.playMotionByName(hit)
		scheduleReturnToNeutral(returnToNeutral)
	}
}

const triggerEmotion = (text: string) => {
	if (!ready.value) return
	if (petExpressionHoldsLayer()) { playIdleMotionOnce(); return }   // 摸头优先: 不覆盖被摸时的脸
	const emo = detectExpression(text)
	if (emo) {
		l2d.playExpression(emo)
	} else {
		l2d.stopExpression()
	}
	playIdleMotionOnce()
}

/* ---------------- 流式表情/动作标记解析 ----------------
 * 方案: AI 在回复末尾附上隐藏标记 【表情:开心】【动作:jump】,
 * 前端流式接收时即时解析并剥离 (不进正文、不进 TTS、不显示).
 * 标记可能被网络分块从中间切断, 因此需要跨块缓冲.
 * 实现已抽取到 services/chat/markers.ts (主 App 与悬浮窗气泡共用).
 */

/** 聊天流式对话的独立标记缓冲对象 (与触摸触发隔离) */
const chatMarkerBuf = {value: ""}
/** 触摸触发对话的独立标记缓冲 (与聊天流式隔离, 避免并发踩踏) */
const touchMarkerBuf = {value: ""}

/** 标记词映射逻辑在 services/live2d/markerRules.ts 共享 (resolveMarkerEmotion/Motion) */

/**
 * 合并 AI 分析 (表情细化 + 记忆提取, 一次 LLM 调用, 省 token 省延迟)
 * - 表情: 先由关键词规则即时播放, 这里用 AI 结果细化/纠正
 * - 记忆: 规则结果 + AI 提取结果合并去重入库
 */
const analyzeAfterReply = async (userText: string, _replyText: string) => {
	// 表情/动作已由流式标记驱动, 这里只做记忆写入:
	// Mem0 两段式 → 规则免费兜底 + AI 提取事实 + AI 决策入库(ADD/UPDATE/DELETE/NONE),
	// 有净新增/改写时用气泡提示 (让用户知道 Nori 记住了什么).
	try {
		const llmOk = cfg.memoryLlmExtract && !!cfg.apiKey.trim() && !!cfg.model.trim()
		// 最近对话 (不含当前句) 供 AI 理解指代, 不作为提取来源
		const recent = messages.value
			.filter(m => m.role === "user" || m.role === "assistant")
			.slice(-6, -1)
			.filter(m => !(m.role === "user" && m.content === userText))
			.map(m => ({role: m.role, content: m.content}))
		/** 记忆相关的小调用统一走这里 (记忆提取与目标收尾共用同一个判据与端点) */
		const llmCall = async (prompt: string): Promise<string> => {
			const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
				{role: "system", content: prompt} as ChatMsg,
			])
			return r.ok ? (r.content ?? "") : ""
		}
		/* 记忆写入 (2026-09-27 重构 P3: 默认**不再**逐句提取)。
		   现在的分工: 近期对话靠原文上下文, 记忆由"每次历史总结顺手筛出"生产
		   (见下方 summarizeIfNeeded → services/memory 的记忆块通道)。
		   留 memoryRealtimeExtract 开关只为出问题能一键切回旧的逐句通道。 */
		if (cfg.memoryRealtimeExtract) {
			const res = await extractMemoriesSmart(
				userText,
				llmOk ? llmCall : null,
				recent,
			)
			if (res.tips.length) {
				const fmt = `记住了：${res.tips.join("、")}`
				triggerBubble(fmt.length > 36 ? `${fmt.slice(0, 36)}…` : fmt, 3200)
			}
		}
		/* 目标收尾 (2026-09-27 用户要求): 主人这句若明确表示某个「陪着你的事」已完成/已放弃,
		   由 LLM 判定并把它从清单里摘掉 —— 否则目标会被每 3 天问一次、永远不收尾。
		   · 库里没有目标时**零调用**(pruneDoneGoals 内部先查);
		   · 判定失败/超时/编造 id → 什么都不删 (见 memory/index.ts 的注释);
		   · 与记忆提取共用同一个 llmCall 判据 (都要求开关开启且配了 Key)。
		   ⚠ 单独一次调用而不是并进记忆提取: 两件事语义无关, 合并会互相污染, 而"判错就删目标"
		     属于用户数据损失, 不值得为省一次调用冒这个险。 */
		if (llmOk) {
			try {
				const done = await pruneDoneGoals(userText, llmCall, recent)
				if (done.length) {
					const fmt = `这个目标我就先收起来啦：${done.join("、")}`
					triggerBubble(fmt.length > 40 ? `${fmt.slice(0, 40)}…` : fmt, 3600)
				}
			} catch (e) {
				console.error("[goal] pruneDoneGoals failed:", e)
			}
		}
		refreshMemView()
	} catch (e) {
		// 兜底: 规则记忆
		console.error("[mem] extractMemoriesSmart failed:", e)
		try {
			addMemoriesFromText(userText)
		} catch (e2) {
			console.error("[mem] fallback addMemoriesFromText failed:", e2)
		}
		refreshMemView()
	}
}

/**
 * 记忆库入口的"害羞拦门"状态 (2026-09-27 用户要求)。
 *
 * 用户点「记忆库」时先弹气泡 + 念一句「这样子看的话，nori 会害羞的。」, **点第三下才真的进去**。
 * 为什么要有这条: 记忆库是她的"心里话", 用户希望进去之前有个当面的反应, 而不是静默翻开。
 *
 * 计数复位规则 (不谨慎就会锁死或形同虚设):
 *   · `entryGateLeaveTimer`: 4 秒没再点 → 假设用户走开了, 计数归零 (否则"点两次、过一会儿点一次"就进去了);
 *   · 打开/关闭任何面板 (openPanel) → 归零;
 *   · 真正进入记忆库 → 归零 (下次再进要重新数三下)。
 */
const MEM_ENTRY_CLICKS = 3
const memEntryClicks = ref(0)
let memEntryLeaveTimer: ReturnType<typeof setTimeout> | null = null
const MEM_ENTRY_LEAVE_MS = 4000
const resetMemEntryGate = (): void => {
	memEntryClicks.value = 0
	if (memEntryLeaveTimer) { clearTimeout(memEntryLeaveTimer); memEntryLeaveTimer = null }
}

/** 摸头台词那种"顺口一句"的朗读 (三道闸: ①TTS 就绪 ②不在朗读/生成中 ③尾音窗)。 */
const speakSideLine = (line: string): void => {
	if (!isTtsReady(cfg)) return
	if (speaking.value || Date.now() - lastVoiceAt < PET_LINE_VOICE_TAIL_MS) return
	if (chatStreaming.value || touchStreaming.value || typing.value) return
	void speakTTS(cfg, line).catch(() => { /* 失败已由 setTtsErrorHandler 提示 */ })
}

/**
 * 点击设置页里的「记忆库」入口。
 * 前两次只给反应 (气泡 + 朗读), 第三次才真的打开。
 */
const onMemEntryTap = (): void => {
	memEntryClicks.value += 1
	if (memEntryClicks.value >= MEM_ENTRY_CLICKS) {
		resetMemEntryGate()
		openMemoriesPage()
		return
	}
	const left = MEM_ENTRY_CLICKS - memEntryClicks.value
	/* 气泡用**小气泡**（`triggerBubble`，与「记住了：…」同一套），不用 Nori 气泡：
	   · 与"记忆新内容"的提示视觉统一（用户 2026-09-27 要求）；
	   · 小气泡 z-index 15，聊天面板打开时也看得见 —— 而 Nori 气泡（58）会盖在面板内容上。 */
	triggerBubble(`这样子看的话，nori 会害羞的。（还差 ${left} 下）`, 3000)
	speakSideLine("这样子看的话，nori 会害羞的。")
	if (memEntryLeaveTimer) clearTimeout(memEntryLeaveTimer)
	memEntryLeaveTimer = setTimeout(() => { memEntryLeaveTimer = null; memEntryClicks.value = 0 }, MEM_ENTRY_LEAVE_MS)
}

/** E2E/实机诊断探针: 聊天与记忆管线的最小状态快照 (纯读, 不建连接)。
 *  排查"发完消息后记忆/目标判定没动静"这类问题时, 控制台敲 `__noriDiagChat()` 就能看到
 *  到底是①没配 Key ②消息没发出去 ③回复为空 还是 ④提取被开关关掉了。 */
;(window as unknown as {__noriDiagChat?: () => unknown}).__noriDiagChat = () => ({
	hasKey: !!cfg.apiKey.trim(),
	model: cfg.model,
	baseUrl: cfg.baseUrl,
	memoryLlmExtract: !!cfg.memoryLlmExtract,
	chatOpen: chatOpen.value,
	typing: typing.value,
	chatStreaming: chatStreaming.value,
	msgCount: messages.value.length,
	lastRoles: messages.value.slice(-4).map(m => `${m.role}:${String(m.content).slice(0, 20)}`),
	hasStreamBridge: typeof (window as unknown as {NoriChat?: {chatStream?: unknown}}).NoriChat?.chatStream === "function",
})

const grantStorage = () => requestStoragePermission()

/** 持久化全部设置 (静默保存; 写失败只记日志 —— 滑块/开关这类高频调用不适合弹提示)。
 *  @returns 是否真的写入成功, 供显式"保存设置"按钮如实反馈 */
/** 落盘。@returns 原生 writeFile 的原始返回 ("ok" / "err:xxx"), 供保存按钮如实报原因 */
const persistSettings = (): string => {
	const raw = saveSettingsRaw({
		apiKey: cfg.apiKey,
		baseUrl: cfg.baseUrl,
		model: cfg.model,
		live2dModel: cfg.live2dModel || "",
		bubbleScale: Number(cfg.bubbleScale) || 1,
		bubbleWidth: Number(cfg.bubbleWidth) || 82,
		renderScale: renderScaleNum.value,
		l2dFps: l2dFpsNum.value,
		ttsEnabled: !!cfg.ttsEnabled,
		bgmEnabled: !!cfg.bgmEnabled,
		bgmTrack: cfg.bgmTrack || "random",
		ttsProvider: cfg.ttsProvider === "cosyvoice" ? "cosyvoice" : "fish",
		ttsApiKey: cfg.ttsApiKey,
		ttsBaseUrl: cfg.ttsBaseUrl,
		ttsReferenceId: cfg.ttsReferenceId,
		ttsModel: cfg.ttsModel,
		ttsFormat: cfg.ttsFormat,
		ttsChunkLength: Number(cfg.ttsChunkLength) || 120,
		ttsLatency: cfg.ttsLatency,
		cosyApiKey: cfg.cosyApiKey,
		cosyBaseUrl: cfg.cosyBaseUrl,
		cosyModel: cfg.cosyModel,
		cosyVoice: cfg.cosyVoice,
		cosyRate: Number(cfg.cosyRate) || 1,
		ttsVolume: Number.isFinite(Number(cfg.ttsVolume)) ? Math.min(1, Math.max(0, Number(cfg.ttsVolume))) : 1,
		bgmVolume: Number.isFinite(Number(cfg.bgmVolume)) ? Math.min(1, Math.max(0, Number(cfg.bgmVolume))) : 0.35,
		sfxVolume: Number.isFinite(Number(cfg.sfxVolume)) ? Math.min(1, Math.max(0, Number(cfg.sfxVolume))) : 0.5,
		dataseaBg: !!cfg.dataseaBg,
		timeAware: cfg.timeAware !== false,
		ambientEnabled: !!cfg.ambientEnabled,
		quietMode: cfg.quietMode,
		quietOn: !!cfg.quietOn,
		cosyCloneVoices: normalizeCloneVoices(cfg.cosyCloneVoices),
		trimHistory: !!cfg.trimHistory,
		memoryLlmExtract: !!cfg.memoryLlmExtract,
		memoryRealtimeExtract: !!cfg.memoryRealtimeExtract,
		memoryAutoTuneExamples: !!cfg.memoryAutoTuneExamples,
		memoryDiagnostics: !!cfg.memoryDiagnostics,
		smartRecall: !!cfg.smartRecall,
		emotionLlm: !!cfg.emotionLlm,
		deepseekThinking: !!cfg.deepseekThinking,
		/** 迁移标记: 一旦写过盘, 说明上面对 `deepseekThinking` 的读取已经是"用户真选的值" */
		thinkDefaultV2: true,
		lookFlipX: !!cfg.lookFlipX,
		lookFlipY: !!cfg.lookFlipY,
		lookSens: Number(cfg.lookSens) || 0.2,
		floatEnabled: !!cfg.floatEnabled,
		floatBubbleW: Number(cfg.floatBubbleW) || 82,
		floatRenderScale: Number(cfg.floatRenderScale) || nativeDpr.value,
	})
	if (raw !== "ok") console.error("[settings] 写盘失败:", raw)
	return raw
}

const saveSettingsNow = () => {
	// 如实反馈: 写盘失败时不再谎报"设置已保存", 而且把原生给的真实原因一并显示 ——
	// 只说"存储不可写"会把 err:insert / err:stream / SecurityException 等差异全盖掉, 真机没法定位。
	const raw = persistSettings()
	applyRenderScale()
	modelLoadMsg.value = ""
	const ok = raw === "ok"
	triggerBubble(ok ? "设置已保存" : `设置保存失败：${raw} —— 请打开「所有文件访问权限」（系统设置 → 应用 → NoriDroid → 特殊应用权限）`, ok ? 2000 : 6000)
}

/* ---------------- 悬浮窗 ---------------- */
/** 悬浮窗开关切换: 只保存设置 + 记录原生标记; 悬浮窗在退出应用后才显示 (不占用主 App 使用) */
const onFloatToggle = () => {
	persistSettings()
	const nori = window.NoriChat
	if (!nori) return
	try { nori.setFloatEnabled?.(!!cfg.floatEnabled) } catch { /* 忽略 */ }
	if (cfg.floatEnabled) {
		try {
			if (!nori.canFloat?.()) {
				triggerBubble("请在系统设置里允许悬浮窗权限")
				nori.requestFloatPermission?.()
				return
			}
			triggerBubble("已开启：退出应用后 Nori 会留在桌面")
		} catch { /* 忽略 */ }
	} else {
		try { nori.hideFloat?.() } catch { /* 忽略 */ }
	}
}

/** 悬浮窗: 渲染分辨率设置 → 保存 + 实时通知悬浮窗页面 */
const onFloatRenderScale = () => {
	persistSettings()
	try {
		window.NoriChat?.setFloatRenderScale?.(Number(cfg.floatRenderScale) || 2)
	} catch { /* 忽略 */ }
}

// 音色选择后自动保存 (防抖, 避免手滑连续切换时频繁写文件)
let voiceSaveTimer: ReturnType<typeof setTimeout> | null = null
const saveVoicesDebounced = () => {
	if (voiceSaveTimer) clearTimeout(voiceSaveTimer)
	voiceSaveTimer = setTimeout(() => {
		voiceSaveTimer = null
		persistSettings()
	}, 600)
}
// Fish 的音色
watch(() => cfg.ttsReferenceId, saveVoicesDebounced)
// 千问的模型与音色 —— 与上面同一套防抖写法。
// 不用 @change 的原因: 用户打完字直接关面板时 input 不会失焦, change 根本不触发, 改动就丢了;
// watch 在最后一次输入后 600ms 落盘, 不依赖失焦。
watch([() => cfg.cosyModel, () => cfg.cosyVoice], saveVoicesDebounced)

const onResize = () => {
	relayout()
	resizeDataseaBg()
}

const refreshStorage = () => {
	storageReady.value = isStorageReady()
	// 「所有文件访问权限」可能是在系统设置里刚授予的 —— 每次回前台都刷新一次,
	// 用户授权返回后设置页的「已授权 ✓」会立刻变绿, 不用重开面板。
	allFilesAccess.value = hasAllFilesAccess()
}

/**
 * 页面不可见 ⇒ **两个渲染循环都停**（2026-10-02 用户报「返回主界面严重掉帧」）。
 *
 * 为什么显式停: rAF 在 `document.hidden` 时本来就停了，但 Android WebView 的"隐藏"只覆盖
 * 切后台/息屏；**被别的窗口盖住**（悬浮窗、气泡对话框）时页面仍是 visible，两条循环
 * （Live2D + 数据海，实测各占满一帧预算）会照跑不误。而且用户看到的"掉帧"往往是**持续发热后
 * 的降频**，所以"不该画的时候一帧都不画"必须显式写出来，而不是依赖浏览器实现。
 *
 * 恢复是即时的: Live2D 只是不画（模型/画布/手势命中都不动），数据海重新起循环。
 */
const setStageRenderPaused = (paused: boolean): void => {
	try { l2d.pauseRender(paused) } catch { /* 忽略 */ }
	try {
		if (paused) stopDataseaBg()
		else if (cfg.dataseaBg) setDataseaBgEnabled(true)
	} catch { /* 忽略 */ }
}

const onVisibility = () => {
	refreshStorage()
	// 切后台: 立即落盘防抖中的聊天记录, 避免丢最后一次写入
	if (document.hidden) {
		flushChatPersist()
		stopTTS()
		pauseBgm()
		setStageRenderPaused(true)
	} else {
		setStageRenderPaused(false)
		if (!bgmHeld()) resumeBgm()
		if (!chatStreaming.value && !touchStreaming.value) {
			// 切回前台: 重新加载聊天记录 —— 悬浮窗对话框可能已写入共享的 chat.json,
			// 主 App 不重建时内存里是旧数据, 必须刷新才能看到悬浮窗对话.
			// 流式进行中跳过: send/handleTouchTrigger 的闭包持有旧数组里的 liveBubble,
			// 整表替换会让在途回复写到脱离渲染的对象上 → 既不上屏也不落盘 (FE-H2)
			try { messages.value = loadChat() } catch { /* 忽略 */ }
		}
	}
}

onMounted(async () => {
	window.addEventListener("resize", onResize)
	
	document.addEventListener("pointerdown", onStagePointerDown)
	document.addEventListener("pointermove", onStagePointerMove)
	document.addEventListener("pointerup", onStagePointerUp)
	document.addEventListener("pointercancel", onStagePointerUp)
	
	window.addEventListener("focus", refreshStorage)
	document.addEventListener("visibilitychange", onVisibility)
	// TTS 合成失败提示 (不打断对话)
	setTtsErrorHandler((msg) => triggerBubble(`语音合成失败：${msg}`))
	// BGM 加载失败提示
	setBgmErrorHandler((msg) => triggerBubble(`背景音乐：${msg}`))

	
	const s = loadSettings()
	cfg.apiKey = s.apiKey
	cfg.baseUrl = s.baseUrl || "https://api.openai.com/v1"
	cfg.model = s.model
	// 上次选的 Live2D 模型 (旧设置文件没有这个字段 → 空串 ⇒ 启动走"已装列表第一个")
	cfg.live2dModel = s.live2dModel ?? ""
	cfg.bubbleScale = s.bubbleScale || 1
	cfg.bubbleWidth = Number(s.bubbleWidth) || 82
	cfg.renderScale = s.renderScale || nativeDpr.value
	// 旧设置文件没有 l2dFps → normalizeFps 回落到默认档 (60)
	cfg.l2dFps = normalizeFps(s.l2dFps)
	cfg.ttsEnabled = !!s.ttsEnabled
	cfg.bgmEnabled = !!s.bgmEnabled
	cfg.bgmTrack = s.bgmTrack || "random"
	cfg.ttsProvider = s.ttsProvider === "cosyvoice" ? "cosyvoice" : "fish"
	cfg.ttsApiKey = s.ttsApiKey ?? ""
	cfg.ttsBaseUrl = s.ttsBaseUrl || "https://api.fish.audio"
	cfg.ttsReferenceId = s.ttsReferenceId ?? ""
	cfg.ttsModel = s.ttsModel || "s2.1-pro"
	cfg.ttsFormat = s.ttsFormat || "mp3"
	cfg.ttsChunkLength = s.ttsChunkLength || 120
	cfg.ttsLatency = s.ttsLatency || "balanced"
	cfg.cosyApiKey = s.cosyApiKey ?? ""
	cfg.cosyBaseUrl = s.cosyBaseUrl || "https://dashscope.aliyuncs.com"
	cfg.cosyModel = s.cosyModel || "cosyvoice-v3.5-flash"
	cfg.cosyVoice = s.cosyVoice ?? ""
	cfg.cosyRate = Number(s.cosyRate) || 1
	cfg.ttsVolume = Number.isFinite(Number(s.ttsVolume)) ? Math.min(1, Math.max(0, Number(s.ttsVolume))) : 1
	cfg.bgmVolume = Number.isFinite(Number(s.bgmVolume)) ? Math.min(1, Math.max(0, Number(s.bgmVolume))) : 0.35
	cfg.sfxVolume = Number.isFinite(Number(s.sfxVolume)) ? Math.min(1, Math.max(0, Number(s.sfxVolume))) : 0.5
	setSfxVolume(Number(cfg.sfxVolume))
	cfg.dataseaBg = s.dataseaBg !== false
	cfg.timeAware = s.timeAware !== false      // 旧设置文件没这个字段 ⇒ 默认开
	cfg.ambientEnabled = s.ambientEnabled !== false
	cfg.dataseaBg = s.dataseaBg !== false
	cfg.quietMode = ["off", "auto", "manual"].includes(String(s.quietMode)) ? String(s.quietMode) : "off"
	cfg.quietOn = !!s.quietOn
	cfg.cosyCloneVoices = normalizeCloneVoices(s.cosyCloneVoices)
	cfg.trimHistory = s.trimHistory !== false
	cfg.memoryLlmExtract = !!s.memoryLlmExtract
	// 实时通道默认**关** (重构 P3): 只有显式存过 true 才开 (老设置文件里没有这个字段 → 关)
	cfg.memoryRealtimeExtract = s.memoryRealtimeExtract === true
	cfg.memoryAutoTuneExamples = s.memoryAutoTuneExamples === true
	cfg.memoryDiagnostics = s.memoryDiagnostics === true
	setDiagEnabled(cfg.memoryDiagnostics)   // 诊断日志开关同步给记忆模块 (关着时它零开销)
	cfg.smartRecall = s.smartRecall !== false
	cfg.emotionLlm = s.emotionLlm !== false
	/* 思考模式: 2026-10-02 用户纠正为**默认开**。
	 * 老设置文件里那个 `false` 是**旧默认**自动写进去的 (persistSettings 会把全部字段写盘),
	 * 不代表用户的选择 —— 所以按 `thinkDefaultV2` 标记**一次性迁移**成开;
	 * 迁移过的机器上, 用户手动关掉就永久生效 (标记已落盘, 不会再被翻回来)。 */
	cfg.deepseekThinking = s.thinkDefaultV2 === true ? !!s.deepseekThinking : true
	cfg.lookFlipX = !!s.lookFlipX
	cfg.lookFlipY = !!s.lookFlipY
	cfg.lookSens = Number(s.lookSens) || 0.2
	cfg.floatEnabled = !!s.floatEnabled
	cfg.floatBubbleW = Number(s.floatBubbleW) || 82
	cfg.floatRenderScale = Number(s.floatRenderScale) || nativeDpr.value
	// 同步原生悬浮窗开关标记 (退出判断用, 不依赖 settings.json 读写时序)
	try { window.NoriChat?.setFloatEnabled?.(!!cfg.floatEnabled) } catch { /* 忽略 */ }
	// 应用内朗读音量 (按设置初始化; 之后滑块可实时调整)
	setTtsVolume(Number(cfg.ttsVolume))
	// 背景音乐: 注册资源状态回调后恢复播放 (缺失时自动下载; 自动播放被拦时服务内挂手势重试)
	setBgmStateHandler((st, pct) => {
		bgmState.value = st
		bgmPct.value = pct
		if (st === "ready") {
			const id = bgmCurrentId()
			bgmNowName.value = id ? bgmNameOf(id) : ""
		}
	})
	// 安静模式自愈必须在 syncBgm **之前**: 若上次专注期间被杀, settings.json 里残留
	// manual+on, 而 syncBgm 会照着它**起播** —— 随后 applyQuiet 才把它挂起, 结果是
	// "先响半秒再静音"。先还原成进专注前的配置, syncBgm 一开始就不会播。
	// (自动模式的重估放在后面, 每分钟一次, 跨过 23:00/8:00 边界即时切换)
	recoverFocusMuteIfNeeded()
	applyQuiet()
	{
		const bgmId = syncBgm(cfg)
		bgmNowName.value = bgmId ? bgmNameOf(bgmId) : ""
	}
	// 音效文件: 注册下载结果回调 + **首次进入读一次状态** (没下载时设置里显示「未下载」,
	// 按键音静默不播 —— 判断在 services/sfx.ts 里, 每次播之前现问一次原生)
	setSfxDownloadHandler((r: SfxDownloadResult) => {
		sfxBusy.value = false
		if (r.ok) sfxShowStatus({ready: true, done: r.total, total: r.total})
		else sfxShowStatus({ready: false, done: r.done, total: r.total}, r.failed)
	})
	sfxRefresh()
	// 数据海动态背景 (设置可关; rAF 在隐藏时天然停摆)
	habitRecord("open")
	if (cfg.dataseaBg && dataseaCanvas.value) initDataseaBg(dataseaCanvas.value)
	// Ambient 主动搭话: 安静几分钟后轻轻说一句 (语料本地, 零 token)
	startAmbient({
		speak: (line) => {
			if (!chatOpen.value) showAiBubble(line)
		},
		goalLine: () => {
			const line = goalCarePrompt()
			if (line) {
				const m = line.match(/「(.+?)」/)
				return m ? `对了，你说要「${m[1]}」的，进展怎么样啦？不要有压力哦，我就是问问。` : line
			}
			return null
		},
		idleAllowed: () =>
			panel.value === "" && !chatOpen.value && !chatStreaming.value && !touchStreaming.value && !typing.value,
	})
	quietTimer = window.setInterval(() => {
		if (cfg.quietMode === "auto") applyQuiet()
	}, 60_000)
	window.__noriRenderScale = renderScaleNum.value
	// 启动即应用帧率档位 (设置加载完成后才有效; l2d 的 installFrameCap 已给默认档)
	applyL2dFps()
	storagePath.value = getStorageDir()
	storageReady.value = isStorageReady()
	allFilesAccess.value = hasAllFilesAccess()
	
	if (!storageReady.value && !localStorage.getItem("storage_asked")) {
		localStorage.setItem("storage_asked", "1")
		setTimeout(grantStorage, 1200)
	}
	/* 新手引导: 首次打开 (还没建立数据目录) 且没看过时自动弹一次。
	 * 判据用 isStorageReady() 而不是"memory.json 存不存在": 它读的就是 Downloads/NoriDroid 目录,
	 * 目录建好即为"不是第一次"。宽限 1.6s 是等首帧/模型起头, 避免和启动动画抢注意力;
	 * 存储权限弹窗 (上面那个 setTimeout) 会盖住引导, 所以这里刻意晚于它。 */
	if (!storageReady.value && !localStorage.getItem(INTRO_SEEN_KEY)) {
		setTimeout(() => {
			if (!localStorage.getItem(INTRO_SEEN_KEY) && !introOn.value) introOpen()
		}, 1600)
	}
	messages.value = loadChat()
	refreshMemView()
	refreshDiaryView()
	// 自定义人设的那行状态 (有导入过就显示「自定义 · N 字」, 否则内置)
	refreshPersonaState()
	if (cfg.apiKey.trim()) refreshModels()

	// 本地模型先行 (启动提速): 先扫本地已装模型立即开始加载, 网关列表后台拉取.
	// 旧逻辑 await 联网列表成功后才 loadModel —— 弱网/离线时白等到超时才见模型
	try {
		const installed = await listInstalled()
		if (installed.length) {
			// 优先用**上次选的那只**（2026-09-30 修：以前写死 installed[0].id，换模型后重启就回第一只）;
			// 但必须校验它仍然装着（模型可能被卸载/换机），校验不过才回落列表第一个。
			const saved = cfg.live2dModel
			const usable = !!saved && installed.some((m) => m.id === saved)
			currentModelId.value = usable ? saved : installed[0].id
			// 把"实际生效的"记回内存（不额外写盘：等下次保存设置时自然落盘），
			// 这样"回落"过一次之后，下次启动直接命中。
			cfg.live2dModel = currentModelId.value
		}
	} catch { /* 忽略 */ }
	void loadModel().catch(() => { /* loadModel 内部有错误提示 */ })

	// 网关列表后台刷新: 只更新 UI 列表, 不再阻塞/切换模型加载
	void (async () => {
		try {
			modelList.value = await fetchModelList()
			listError.value = ""
		} catch (e: any) {
			listError.value = "获取模型列表失败: " + (e?.message ?? String(e)) + "（将使用本地已下载的模型）"
		}
	})()
})

onBeforeUnmount(async () => {
	window.removeEventListener("resize", onResize)
	document.removeEventListener("pointerdown", onStagePointerDown)
	document.removeEventListener("pointermove", onStagePointerMove)
	document.removeEventListener("pointerup", onStagePointerUp)
	document.removeEventListener("pointercancel", onStagePointerUp)
	window.removeEventListener("focus", refreshStorage)
	document.removeEventListener("visibilitychange", onVisibility)
	if (touchBubbleTimer) clearTimeout(touchBubbleTimer)
	if (voiceSaveTimer) clearTimeout(voiceSaveTimer)
	// 页面销毁前: 落盘防抖中的聊天记录, 避免丢最后一条
	flushChatPersist()
	// 页面销毁前: 记忆/总结的防抖写盘也立即落盘 (防丢最后改动)
	await flushMemoryPersist()
	// 退出时: 若开启了悬浮窗, 启动悬浮窗服务 (应用关闭但 Nori 留在屏幕)
	try {
		if (cfg.floatEnabled) window.NoriChat?.showFloat?.()
	} catch { /* 忽略 */ }
	// 页面销毁前停止朗读 / 流式聊天 / 背景音乐
	stopTTS()
	cancelChatStream()
	pauseBgm()
	stopDataseaBg()
	stopAmbient()
	setBgmErrorHandler(null)
	if (quietTimer) { clearInterval(quietTimer); quietTimer = 0 }
	if (pomoTickTimer) { clearInterval(pomoTickTimer); pomoTickTimer = 0 }
	if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
	window.removeEventListener("resize", pomoClampPos)
	setTtsErrorHandler(null)
	detector.destroy()
	cancelReturnToNeutral()
	clearPetFx()
	// 合成音的噪声源是 loop 的: 不显式停掉, 退出页面后它还会占着音频焦点
	disposePetAudio()
	await l2d.destroy()
})
</script>

<style lang="less" scoped>
.stage-root {
	position: fixed;
	inset: 0;
	background:
		radial-gradient(ellipse at 50% 40%, var(--px-panel-2) 0%, var(--px-bg) 55%, var(--px-void) 100%);
	overflow: hidden;
	touch-action: none;
	user-select: none;

	/* ============ 设计 token: 取自网页版 NoriOS 的 --px-* 设计系统 ============
	 * 来源: D:\norios网页版\archive_0831_nori-os\os.inori.ai\assets\index-FU-0vwSE.css
	 * (网页版 :root 里的 --px-* 是权威取值, 这里是**逐色搬运**, 不是我自己配的)
	 *
	 * 定义在 .stage-root 而不是 :root —— scoped 样式会给选择器加 `[data-v-xxx]`,
	 * 写成 `:root` 会变成 `:root[data-v-xxx]`, 匹配不到任何元素, token 全部静默落空。
	 *
	 * 与改造前的区别 (肉眼可见的部分):
	 *   · 底色从"灰蓝"改为深蓝阶层: #050912/#0f172a → --px-void/--px-bg/--px-panel/--px-panel-2
	 *   · 强调色 #7dd3fc → #67e8f9(青): 整体从"柔和蓝灰"转为"青色像素"色系
	 *   · 描边从 rgba 灰 → 不透明深蓝 #1e335c/#2a4377 (像素风硬边)
	 *   · 质感改用网页版的"亮上左 + 暗下右"硬凸起, 取代柔和发光
	 */
	--px-void: #050811;
	--px-bg: #0a1326;
	--px-panel: #0d1b33;
	--px-panel-2: #183055;             /* 抬升面 (比网页版的 #142648 略亮, 让"抬起"看得出来) */
	--px-stroke: #2a4377;
	--px-line: #1e335c;
	/* ---- 亮度按"受限色板"收敛过一档 (2026-09-26 用户反馈"像素风太亮") ----
	 * 网页版原值 --px-cyan(#67e8f9, 亮度0.674 / 对比13.8:1) 与 #d6fbff(0.905 / 18.2:1) 属于
	 * **满屏高亮**; 而像素风 UI 的通行做法是低饱和受限色板 (NES.css 的 NES 每个 sprite 只有 3 色),
	 * 深色主题也不该用接近纯白的高光 (UX Movement / Material dark theme: 纯黑 + 高亮 = 视疲劳)。
	 * 现在: 强调降到 8.6:1、凸起高光降到 11.9:1; 最亮那档只留给主按钮这类单个 CTA。 */
	--px-cyan-src: #67e8f9;            /* 网页版原值留档 (想回到原观感就把 --px-cyan 指回它) */
	--px-hilite-src: #d6fbff;
	--px-cyan: #4fb8cc;                /* 强调: 亮度 0.403 / 对比 8.6:1 (原 0.674 / 13.8:1) */
	--px-cyan-mid: #3aa0b5;
	--px-cyan-dim: #0e7490;
	--px-cyan-deep: #062c3d;
	--px-hilite: #7fd4e6;              /* 凸起"亮上左": 亮度 0.573 / 对比 11.9:1 (原 0.905 / 18.2:1) */
	--px-text: #e6f1f7;                /* 正文: 原 #f8fafc 是 19.1:1, 略降减少对比疲劳 */
	--px-amber: #d9b45c;               /* 语义色同步去饱和, 与受限色板一致 */
	--px-amber-deep: #92400e;
	--px-magenta: #c98fd4;
	--px-magenta-deep: #701a75;
	--px-violet: #a48ad4;
	--px-violet-deep: #4c1d95;
	--px-green: #4aa87a;
	--px-red: #d4706e;
	--px-white: var(--px-text);
	--px-grey: #94a3b8;
	--px-dim: #475569;

	/* 旧语义 token 保留为**别名**, 指向新色板 —— 这样已有的 100+ 处 var() 引用不用逐个改,
	   整页换肤只发生在这一个地方, 也不会漏掉任何一处。 */
	--surface: var(--px-panel);
	--surface-raise: #12233f;
	--line-strong: var(--px-stroke);
	--line: var(--px-line);
	--line-soft: #16294a;
	--fg: var(--px-white);
	--fg-2: #cbd5e1;
	--fg-3: var(--px-grey);
	--fg-dim: var(--px-dim);
	--accent: var(--px-cyan);
	--accent-strong: var(--px-cyan-mid);
}

.ripple-host { display: none; }

/* ================= 外观风格: 柔和 (只保留网页版色板) =================
 * 布局阶段: 把像素风硬编码的形状参数收敛成变量。
 * 像素风下它们等于现在的硬值(0 圆角 / 2px 边 / #d6fbff 亮边 / #050811 暗边), 柔和风下由下面
 * 的 `.ui-soft` 覆盖层整体换掉。**色板一个字都不动** —— 两种风格的差异只在形状与质感。 */
.ui-pixel, .ui-soft {
	--ui-radius-panel: 0px;
	--ui-radius-card: 0px;
	--ui-radius-ctl: 0px;
	--ui-radius-pill: 0px;
	--ui-line-w: 2px;
	--ui-line-c: var(--px-stroke);
	--ui-line-c-soft: var(--px-line);
	--ui-hi: var(--px-hilite);      /* 凸起"亮上左" */
	--ui-lo: var(--px-void);        /* 凸起"暗下右" */
	--ui-lift: 4px;                 /* 硬投影高度 */
	/* ⚠ 这里**不能写 none**: 该变量被拼进逗号分隔的阴影列表 (`..., var(--ui-shadow)`),
	   `none` 不是合法列表项 —— 浏览器会**整条 box-shadow 丢弃**, 像素风的凸起静默消失
	   (实测: computedStyle 变成 none, 按钮不再有立体感)。所以用"零阴影"占位。 */
	--ui-shadow: 0 0 0 rgba(0, 0, 0, 0);
	/** 面板顶部那一道细高光 (像素风的"亮上左"); 柔和风下换成全透明, 由 --ui-shadow 接管 */
	--ui-inner-glow: var(--px-panel-2);
	/** 背景模糊强度 (C4, 2026-09-27): 像素风一律 0 —— `backdrop-filter` 是**每帧对背后整块区域
	 *  重新采样合成**, 在 60fps + Live2D(WebGL) + 数据海(2D canvas) 同屏时是实打实的 GPU 开销。
	 *  像素风本来也不需要模糊 (像素 UI 的通行做法是实色面板 + 硬边)。 */
	--ui-blur-dot: 0px;
	--ui-blur-bubble: 0px;
	--ui-blur-chip: 0px;
	--ui-blur-mask: 0px;
	--ui-press: inset -2px -2px 0 0 var(--ui-hi), inset 2px 2px 0 0 var(--ui-lo);
}
/* ---- 柔和: 圆角回来 + 半透明细描边 + 柔和阴影; **保留按下凹陷** ---- */
.ui-soft {
	--ui-radius-panel: 20px;
	--ui-radius-card: 12px;
	--ui-radius-ctl: 10px;
	--ui-radius-pill: 999px;
	--ui-line-w: 1px;
	--ui-line-c: rgba(148, 163, 184, 0.18);
	--ui-line-c-soft: rgba(148, 163, 184, 0.12);
	--ui-lift: 0px;
	--ui-shadow: 0 2px 10px rgba(0, 0, 0, 0.38);
	--ui-inner-glow: rgba(0, 0, 0, 0);
	/* 柔和风恢复一点毛玻璃质感 (比原来的 10/14/12px 更省): 气泡 6px、角落提示 8px、触点 2px。
	   要彻底省电可以把这几个值也写 0 —— 观感差异很小。 */
	--ui-blur-dot: 2px;
	--ui-blur-bubble: 6px;
	--ui-blur-chip: 8px;
	--ui-blur-mask: 3px;
	/* 柔和风**不要**像素凸起 (亮上左 + 暗下右), 换成几乎看不见的内描边;
	   但**按下凹陷保留** —— 那是用户明确说"思路不错"的部分。 */
	--ui-hi: rgba(255, 255, 255, 0.06);
	--ui-lo: rgba(0, 0, 0, 0.28);
	/* 按下凹陷: 与像素风同一思路, 换成柔和的 inset 内阴影 */
	--ui-press: inset 0 2px 6px rgba(0, 0, 0, 0.5);
}

/* 手指触摸追踪: 半透明磨砂小白点 */
.touch-dot-host {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 40;
	overflow: hidden;
}
.touch-dot {
	position: absolute;
	width: 22px;
	height: 22px;
	border-radius: 50%;
	/* 半透明磨砂质感: 白色渐变 + 模糊 */
	background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.35) 55%, rgba(255,255,255,0.08) 100%);
	backdrop-filter: blur(var(--ui-blur-dot));
	-webkit-backdrop-filter: blur(var(--ui-blur-dot));
	border: 1px solid rgba(255,255,255,0.5);
	box-shadow: 0 0 12px rgba(255,255,255,0.35), inset 0 0 6px rgba(255,255,255,0.3);
	opacity: 1;
	transform: translate(-50%, -50%) scale(1);
	transition: opacity 0.28s ease-out;
	pointer-events: none;
}


.l2d-host {
	position: absolute;
	inset: 0;
	z-index: 1;
	pointer-events: none;
	overflow: hidden;
}


.touch-overlay {
	position: absolute;
	inset: 0;
	z-index: 2;
	pointer-events: none;
}
.touch-overlay.drawing { z-index: 40; cursor: crosshair; }
.touch-area-box {
	position: absolute;
	box-sizing: border-box;
	border: 2px solid rgba(80, 160, 255, 0.95);
	background: rgba(80, 160, 255, 0.15);
	border-radius: var(--ui-radius-ctl);
	&.swipe { border-color: rgba(255,170,60,0.95); background: rgba(255,170,60,0.15); }
	&.frenzy { border-color: rgba(255,80,200,0.95); background: rgba(255,80,200,0.15); }
	&.draft { border-style: dashed; border-color: rgba(125,227,255,0.95); background: rgba(125,227,255,0.15); }
}


.touch-page {
	position: fixed;
	inset: 0;
	z-index: 15;
	background: rgba(2, 6, 23, 0.35);
	pointer-events: none; 
	touch-action: none;
}
.tts-page {
	position: fixed;
	inset: 0;
	z-index: 15;
	background: rgba(2, 6, 23, 0.5);
	display: flex;
	flex-direction: column;
}
.tts-top {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: calc(12px + env(safe-area-inset-top)) 14px 10px;
	background: linear-gradient(180deg, rgba(2,6,23,0.7) 0%, rgba(2,6,23,0) 100%);
}
.tts-title {
	font-size: 16px; font-weight: 600; color: var(--fg);
	text-shadow: 0 0 12px rgba(56, 189, 248, 0.35);
}
.tts-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 4px 16px calc(20px + env(safe-area-inset-bottom));
	-webkit-overflow-scrolling: touch;
	touch-action: pan-y;
}
.tts-empty {
	color: var(--fg-dim);
	font-size: 14px;
	text-align: center;
}

/* TTS 面板分组 */
.tts-sec {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px 14px;
	border-radius: var(--ui-radius-card);
	background: rgba(15, 23, 42, 0.55);
	border: 1px solid var(--line-soft);
}
.tts-sec-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--accent);
	letter-spacing: 0.5px;
}
.field {
	display: flex;
	flex-direction: column;
	gap: 6px;
	label { font-size: 13px; color: var(--fg-2); }
	/* 与 .settings-row 同款: 补 number/password, 避免默认白底 */
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
.field.row-inline {
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent-strong); }
}

/* 余额查询 */
.bal-grid {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

/* 音色选择行 */
.voice-pick {
	display: flex;
	gap: 8px;
	align-items: center;
	select { flex: 1; }
	.mini { flex-shrink: 0; }
}
.bal-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 10px 12px;
	border-radius: var(--ui-radius-ctl);
	background: rgba(30, 41, 59, 0.7);
	border: 1px solid var(--line);
}
.bal-name {
	font-size: 13px;
	color: var(--fg-3);
	flex-shrink: 0;
}
.bal-value {
	font-size: 14px;
	font-weight: 600;
	color: #4ade80;
	text-align: right;
	word-break: break-all;
	&.loading { color: #fbbf24; }
}
.bal-btns {
	display: flex;
	gap: 8px;
	.mini { flex: 1; }
}

/* 操作按钮行 */
.btn-row {
	display: flex;
	gap: 8px;
	.btn { flex: 1; width: auto; margin-top: 0; }
}
/* 记忆面板 4 个操作按钮: 窄屏自动换行 */
.btn-row.mem-btns { flex-wrap: wrap; }
.btn-row.mem-btns .mini { flex: 1 1 auto; text-align: center; }
.touch-page .touch-overlay.drawing { cursor: crosshair; }
.touch-top {
	position: absolute;
	top: 0; left: 0; right: 0;
	z-index: 1;
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: calc(12px + env(safe-area-inset-top)) 14px 10px;
	pointer-events: auto;
	background: linear-gradient(180deg, rgba(2,6,23,0.7) 0%, rgba(2,6,23,0) 100%);
}
.touch-title {
	font-size: 16px; font-weight: 600; color: var(--fg);
	text-shadow: 0 0 12px rgba(56, 189, 248, 0.35);
}
.touch-editor {
	position: absolute;
	left: 0; right: 0; bottom: 0;
	z-index: 1;
	max-height: 48vh;
	overflow-y: auto;
	pointer-events: auto;
	padding: 12px 14px calc(16px + env(safe-area-inset-bottom));
	background: linear-gradient(180deg, rgba(2,6,23,0.75) 0%, rgba(2,6,23,0.97) 100%);
	border-top: 1px solid var(--line);
}
.ba-name {
	position: absolute;
	left: 4px; top: 4px;
	font-size: 10px;
	line-height: 1;
	color: #fff;
	padding: 2px 5px;
	border-radius: var(--ui-radius-ctl);
	background: rgba(0,0,0,0.45);
	max-width: calc(100% - 8px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}


.touch-bubble {
	position: absolute;
	left: 50%;
	top: 18%;
	transform: translateX(-50%);
	z-index: 60;
	padding: 10px 16px;
	border-radius: var(--ui-radius-pill);
	background: rgba(15, 23, 42, 0.85);
	border: 1px solid rgba(56, 189, 248, 0.5);
	color: var(--fg);
	font-size: 14px;
	backdrop-filter: blur(var(--ui-blur-bubble));
	box-shadow: 0 8px 24px rgba(0,0,0,0.4);
	white-space: nowrap;
	max-width: 80%;
	overflow: hidden;
	text-overflow: ellipsis;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }


.ai-bubble {
	position: absolute;
	left: 12px; right: 12px;
	bottom: calc(92px + env(safe-area-inset-bottom));
	z-index: 58;
	max-height: 34vh;
	overflow-y: auto;
	padding: 12px 16px;
	border-radius: var(--ui-radius-card);
	background: rgba(15, 23, 42, 0.92);
	border: 1px solid rgba(56, 189, 248, 0.45);
	box-shadow: 0 10px 32px rgba(0,0,0,0.45);
	backdrop-filter: blur(var(--ui-blur-bubble));
	pointer-events: none;
}
.ai-bubble-txt {
	color: var(--fg);
	font-size: 15px;
	line-height: 1.55;
	white-space: pre-wrap;
	/* 与聊天气泡一致: 中文按字自然换行 + 标点禁则 (keep-all 会让无标点长句硬切) */
	word-break: normal;
	line-break: strict;
	overflow-wrap: break-word;
}
.ai-enter-active, .ai-leave-active { transition: opacity 0.24s ease, transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); }
.ai-enter-from, .ai-leave-to { opacity: 0; transform: translateY(14px) scale(0.98); }

.topbar {
	position: absolute;
	top: 0; left: 0; right: 0;
	padding: calc(10px + env(safe-area-inset-top)) 14px 8px;
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
	z-index: 4;
	pointer-events: none;
}
.tag, .loading, .err {
	pointer-events: auto;
	padding: 6px 12px;
	border-radius: var(--ui-radius-pill);
	background: rgba(15, 23, 42, 0.55);
	border: 1px solid var(--line-strong);
	font-size: 13px;
	color: var(--fg);
	backdrop-filter: blur(var(--ui-blur-chip));
}
.err { color: #fecaca; border-color: rgba(248, 113, 113, 0.5); background: rgba(127, 29, 29, 0.5); }


.ripple {
	position: relative;
	overflow: hidden;
}
.ripple-el {
	position: absolute;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.35);
	transform: scale(0);
	animation: ripple-exp 0.55s ease-out forwards;
	pointer-events: none;
}
@keyframes ripple-exp {
	to { transform: scale(1); opacity: 0; }
}


.chat-panel {
	position: absolute;
	left: 10px; right: 10px;
	bottom: calc(86px + env(safe-area-inset-bottom));
	max-height: 58vh;
	display: flex;
	flex-direction: column;
	/* 面板改为完全透明: 去掉整块毛玻璃, 让背景/模型透出来.
	   气泡改用自身半透明填充承担可读性 (见下), 因此这里不再需要任何背景层.
	   性能上这是净收益: 原先 ::before 的 backdrop-filter 要每帧对约半个屏幕做
	   区域重采样, 而底下的 Live2D(WebGL) 与数据海(2D canvas) 都在逐帧渲染, 共用同一个 GPU.
	   连带去掉 border 与 box-shadow —— 它们原本是框在毛玻璃块上的, 面板透明后会变成
	   悬空的一圈线和一条暗带. */
	background: transparent;
	border: none;
	/* 保留圆角: border 去掉了, 但 overflow:hidden 需要它作为裁剪半径,
	   否则滚动内容会溢出面板边界 */
	border-radius: var(--ui-radius-card);
	z-index: 12;
	overflow: hidden;
}
.chat-head {
	display: flex; justify-content: space-between; align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid var(--line-soft);
}
.chat-title { font-size: 14px; font-weight: 600; color: var(--fg); }
.chat-msgs {
	flex: 1; min-height: 120px; overflow-y: auto;
	padding: 12px 14px;
	display: flex; flex-direction: column; gap: 8px;
	line-height: 1.5;
	-webkit-overflow-scrolling: touch;
	touch-action: pan-y;
}
.chat-empty { text-align: center; color: var(--fg-dim); font-size: 13px; }
.bubble-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; animation: msg-land 0.26s ease-out both; }
@keyframes msg-land {
	0% { opacity: 0; transform: translateY(10px) scale(0.97); }
	100% { opacity: 1; transform: none; }
}
.bubble-wrap.user { align-items: flex-end; }
.bubble-wrap.assistant { align-items: flex-start; }
.bubble {
	min-width: 0;
	max-width: var(--bubble-w, 82%);
	padding: 9px 12px;
	border-radius: var(--ui-radius-card);
	font-size: 1em;
	white-space: pre-wrap;
	/* 中文按字自然换行 (与微信等一致): 之前的 keep-all 会让无标点长句整段不可断,
	   到气泡边缘被迫在任意位置硬切 —— 这正是"长句中间被强制换行"的根源;
	   line-break: strict 保留标点禁则 (。！？等不出现在行首), 英文长单词由
	   overflow-wrap 只在整行放不下时才拆 */
	word-break: normal;
	line-break: strict;
	overflow-wrap: break-word;
	color: var(--fg);
}
.bubble-wrap.user .bubble {
	/* 扁平着色 (配合面板级毛玻璃): 气泡不再各自开 backdrop-filter */
	background: linear-gradient(135deg, rgba(56, 189, 248, 0.55) 0%, rgba(99, 102, 241, 0.55) 100%);
	border: 1px solid var(--line);
	color: #fff;
	text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
	border-bottom-right-radius: 4px;
}
.bubble-wrap.assistant .bubble {
	/* 面板透明后, Nori 的气泡自己承担"可读又可透"的平衡:
	   底色由 0.62 降到 0.34 (纯填充, 不产生合成层, 不采样背景 → 零 backdrop-filter 成本),
	   并补一层文字投影 —— 半透明底压到模型亮部时, 光靠底色对比不够. */
	background: rgba(30, 41, 59, 0.34);
	border: 1px solid var(--line-strong);
	color: #e8eef7;
	text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
	border-bottom-left-radius: 4px;
}
/* 裁剪占位符: 居中弱化显示 (重启后不再消失, FE-M4) */
.bubble-wrap.system { align-items: center; }
.bubble-wrap.system .bubble {
	background: transparent;
	border: none;
	color: var(--fg-dim);
	font-size: 12px;
}
.bubble-wrap.assistant .bubble.typing { color: var(--fg-3); }
.chat-input {
	display: flex; gap: 8px;
	padding: 10px 12px;
	border-top: 1px solid var(--line-soft);
}
.queue-hint {
	padding: 5px 14px 0;
	font-size: 11px;
	color: var(--accent);
	text-align: right;
}
.chat-input input {
	flex: 1;
	background: rgba(30, 41, 59, 0.9);
	border: 1px solid var(--line-strong);
	border-radius: var(--ui-radius-ctl);
	padding: 10px 12px;
	color: var(--fg);
	font-size: 14px;
	outline: none;
}
.chat-input .send {
	padding: 0 16px;
	border-radius: var(--ui-radius-ctl);
	background: linear-gradient(135deg, var(--accent-strong) 0%, #6366f1 100%);
	color: #fff;
	font-size: 14px;
	font-weight: 600;
	&:disabled { opacity: 0.4; }
}
.ai-bubble-head {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 11px;
	color: var(--accent);
	margin-bottom: 4px;
}
.ai-bubble-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--accent-strong);
	box-shadow: 0 0 8px rgba(56, 189, 248, 0.9);
}
.sea-dots {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: sea-dot 1.2s ease-in-out infinite;
		&:nth-child(2) { animation-delay: 0.15s; }
		&:nth-child(3) { animation-delay: 0.3s; }
	}
}
@keyframes sea-dot {
	0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
	30% { opacity: 1; transform: translateY(-3px); }
}
.datasea-bg {
	position: fixed;
	inset: 0;
	width: 100%;
	height: 100%;
	z-index: 0;
	pointer-events: none;
	background: radial-gradient(120% 90% at 50% 30%, rgba(23, 42, 74, 0.92) 0%, rgba(10, 17, 32, 0.97) 55%, rgba(4, 8, 18, 0.99) 100%);
}
.hit-debug {
	position: fixed;
	top: calc(10px + env(safe-area-inset-top));
	left: 50%;
	transform: translateX(-50%);
	z-index: 70;
	pointer-events: none;
	max-width: 92vw;
	white-space: normal;
	word-break: break-all;
	text-align: center;
	line-height: 1.4;
	background: rgba(0, 0, 0, 0.72);
	color: #fbbf24;
	border: 1px solid rgba(251, 191, 36, 0.5);
	border-radius: var(--ui-radius-pill);
	padding: 4px 14px;
	font-size: 12px;
}
/* ---- 番茄钟悬浮窗 ---- */
.pomo-widget {
	position: fixed;
	z-index: 40;
	background: rgba(10, 16, 32, 0.86);
	border: 1px solid rgba(126, 156, 216, 0.28);
	border-radius: var(--ui-radius-card);
	box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
	padding: 10px 12px 14px;
	touch-action: none;
	user-select: none;
}
.pomo-widget.mini { background: transparent; border: none; box-shadow: none; padding: 0 }
.pw-head {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	color: #9fb2d8;
	cursor: grab;
	touch-action: none;
}
.pw-mini-btn {
	margin-left: auto;
	background: transparent;
	border: none;
	color: #9fb2d8;
	font-size: 14px;
	padding: 0 4px;
}
.pw-tomato { font-size: 13px }
.pw-time {
	font-size: 34px;
	font-weight: 700;
	color: #e8eefc;
	text-align: center;
	margin: 6px 0 6px;
	font-variant-numeric: tabular-nums;
	letter-spacing: 1px;
}
.pw-bar {
	height: 5px;
	border-radius: var(--ui-radius-pill);
	background: rgba(255, 255, 255, 0.09);
	overflow: hidden;
}
.pw-bar i {
	display: block;
	height: 100%;
	border-radius: var(--ui-radius-pill);
	background: linear-gradient(90deg, #67b7ff, #7ee0c2);
	transition: width 0.4s linear;
}
.pw-btns {
	display: flex;
	gap: 8px;
	margin-top: 10px;
}
.pw-btns button {
	flex: 1;
	background: rgba(255, 255, 255, 0.08);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: #dbe6ff;
	border-radius: var(--ui-radius-ctl);
	padding: 7px 0;
	font-size: 13px;
}
.pw-btns button.warn { color: #ffb4a8; border-color: rgba(255, 150, 130, 0.35) }
.pw-grip {
	position: absolute;
	right: 2px;
	bottom: 2px;
	width: 18px;
	height: 18px;
	cursor: nwse-resize;
	touch-action: none;
	background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.25) 50%);
	border-bottom-right-radius: 12px;
}
.pw-pill {
	background: rgba(10, 16, 32, 0.86);
	border: 1px solid rgba(126, 156, 216, 0.28);
	color: #e8eefc;
	border-radius: var(--ui-radius-pill);
	padding: 7px 14px;
	font-size: 15px;
	font-variant-numeric: tabular-nums;
}
/* ---- 番茄钟面板 ---- */
.pomo-pair { display: flex; align-items: center; gap: 8px }
/* 与设置面板其它输入框同款外观; 宽度按"单行两位数/三位数 + 无数字箭头"定为 96px
   (原 84px 是按无内边距的默认白底框定的, 加上 padding 后放不下 max=120 的三位数) */
.pomo-pair input {
	width: 96px;
	text-align: center;
	font-variant-numeric: tabular-nums;
}
.pomo-slash { color: #7c8db5 }
.pomo-chips { display: flex; gap: 6px; flex-wrap: wrap }
.pomo-chip {
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: #c6d4f2;
	border-radius: var(--ui-radius-pill);
	padding: 5px 12px;
	font-size: 12px;
}
.pomo-chip.on { background: rgba(103, 183, 255, 0.22); border-color: rgba(103, 183, 255, 0.55); color: #eaf3ff }
.pomo-today { color: #e8eefc; font-size: 13px }
/* 完成率/平均每段: 次级信息, 弱化显示 */
.pomo-sub { display: flex; gap: 12px; margin-top: 2px; font-size: 11px; color: #7c8db5 }
.pomo-bars {
	display: flex;
	align-items: flex-end;
	gap: 8px;
	height: 74px;
	padding: 6px 10px;
	background: rgba(255, 255, 255, 0.04);
	border-radius: var(--ui-radius-ctl);
	margin: 4px 0 8px;
}
.pomo-bars .pb-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100% }
.pomo-bars .pb-col i { width: 100%; max-width: 22px; border-radius: var(--ui-radius-ctl) 4px 0 0; background: linear-gradient(180deg, #67b7ff, #5a7fd6) }
/* 柱顶常显分钟数: 手机上 hover 不可用, 原先的 title 等于看不到 */
.pomo-bars .pb-col .pb-val { font-size: 10px; font-weight: 600; color: #a9bde6; margin-bottom: 2px }
.pomo-bars .pb-col span { font-size: 10px; color: #7c8db5; margin-top: 4px }
/* 30/365 天档: 柱子变窄、间隙变小, 否则一根不到 1px 看不清 */
.pomo-bars.dense { gap: 1px; padding: 6px 6px }
.pomo-bars.dense .pb-col i { max-width: 100%; border-radius: 2px 2px 0 0 }
.pomo-bars.dense .pb-col span { font-size: 8px; margin-top: 2px }
/* 范围切换器 */
.pomo-range { display: flex; gap: 6px; margin: 2px 0 6px }
.pomo-rbtn {
	flex: 1;
	padding: 6px 0;
	border-radius: var(--ui-radius-card);
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: #c6d4f2;
	font-size: 12px;
	&.on { background: rgba(103, 183, 255, 0.22); border-color: rgba(103, 183, 255, 0.55); color: #e8f2ff }
	&.all { flex: 0 0 auto; padding: 6px 12px; color: var(--accent) }
}
/* 热力图容器: 一年 52 列比面板宽, 必须可横向滚动 */
.pomo-heat-wrap { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; padding-bottom: 4px }
.pomo-heat { display: block; image-rendering: pixelated; cursor: pointer }
.pomo-heat-legend { display: flex; align-items: center; gap: 4px; margin-top: 6px; justify-content: flex-end }
.pomo-heat-legend .mh-label { font-size: 10px; color: #7c8db5 }
.pomo-heat-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block }
.mh-lv1 { background: rgba(103, 183, 255, 0.35) }
.mh-lv2 { background: rgba(103, 183, 255, 0.55) }
.mh-lv3 { background: rgba(103, 183, 255, 0.78) }
.mh-lv4 { background: rgba(103, 183, 255, 1) }
.pomo-daybox {
	display: flex; flex-direction: column; gap: 2px;
	margin-top: 6px; padding: 8px 10px;
	background: rgba(103, 183, 255, 0.10);
	border: 1px solid rgba(103, 183, 255, 0.28);
	border-radius: var(--ui-radius-ctl);
	b { font-size: 13px; color: #e8f2ff }
	span { font-size: 12px; color: #a9bde6 }
}
/* 月度汇总条 */
.pomo-months { display: flex; flex-direction: column; gap: 4px }
.pm-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #a9bde6 }
.pm-name { flex: 0 0 44px; color: #7c8db5 }
.pm-bar { flex: 1; height: 7px; border-radius: var(--ui-radius-ctl); background: var(--line-soft); overflow: hidden }
.pm-bar i { display: block; height: 100%; border-radius: var(--ui-radius-ctl); background: linear-gradient(90deg, #5a7fd6, #67b7ff) }
.pm-val { flex: 0 0 92px; text-align: right }
.pomo-act { display: flex; gap: 8px; margin: 6px 0 4px }
.pomo-go {
	flex: 1;
	background: linear-gradient(135deg, rgba(103, 183, 255, 0.3), rgba(126, 224, 194, 0.24));
	border: 1px solid rgba(126, 156, 216, 0.45);
	color: #eef4ff;
	border-radius: var(--ui-radius-ctl);
	padding: 10px 0;
	font-size: 14px;
}
.pomo-go.alt { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.14); color: #c6d4f2 }
.chat-enter-active, .chat-leave-active { transition: opacity 0.22s ease, transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1); }
.chat-enter-from, .chat-leave-to { opacity: 0; transform: translateY(16px); }


.dock {
	position: absolute;
	left: 0; right: 0; bottom: 0;
	padding: 10px 10px calc(12px + env(safe-area-inset-bottom));
	display: grid;
	grid-template-columns: repeat(6, 1fr);
	gap: 6px;
	z-index: 5;
	background: linear-gradient(180deg, rgba(4, 8, 18, 0) 0%, rgba(6, 13, 28, 0.5) 45%, rgba(6, 13, 28, 0.88) 100%);
}
/* 底栏按钮 (2026-09-30 图标化): 面板样式**不变** (仍是像素面板 + 主题变量), 里面改成"图标在上、文字在下" */
.fab {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	padding: 6px 2px 5px;
	border-radius: var(--ui-radius-ctl);
	background: var(--px-panel-2);
	color: var(--px-white);
	font-size: 12px;
	border: var(--ui-line-w) solid var(--ui-line-c);
	box-shadow: inset 2px 2px 0 0 var(--ui-hi), inset -2px -2px 0 0 var(--ui-lo), 0 var(--ui-lift) 0 0 var(--ui-lo), var(--ui-shadow);
	transition: none;
	&:active {
		transform: translateY(2px);
		box-shadow: var(--ui-press), 0 calc(var(--ui-lift) / 2) 0 0 var(--ui-lo);
	}
	&:disabled { opacity: 0.4; pointer-events: none; }
}
.fab-ico {
	width: 38px;
	height: 38px;
	display: block;
	transition: transform 0.08s ease-out;
}
.fab:active .fab-ico { transform: translateY(1px) scale(0.95); }
.fab-label {
	font-size: 12px;
	line-height: 1.1;
	letter-spacing: 0.5px;
}
.fab.primary {
	/* 受限色板的做法: 最亮那一档**只给一个地方** —— 这里的主按钮 */
	background: var(--px-cyan-src);
	color: var(--px-void);
	box-shadow: inset 2px 2px 0 0 var(--px-hilite-src), inset -2px -2px 0 0 var(--px-cyan-dim), 0 4px 0 0 var(--px-void);
	font-weight: 600;
	border-color: rgba(255,255,255,0.15);
}


.sheet-mask {
	position: fixed; inset: 0;
	background: rgba(5, 8, 17, 0.68);      /* --px-void 半透明 */
	z-index: 20;
	display: flex; align-items: flex-end;
}
.sheet {
	width: 100%;
	max-height: 74vh;
	background: var(--px-panel);
	/* 像素风: 直角 + 2px 硬描边 (网页版 .pixel-idle * 的 2px solid var(--px-void) 同源) */
	border-top-left-radius: var(--ui-radius-panel);
	border-top-right-radius: var(--ui-radius-panel);
	border-top: var(--ui-line-w) solid var(--ui-line-c);
	box-shadow: inset 0 2px 0 0 var(--ui-inner-glow), 0 -6px 0 0 rgba(5, 8, 17, 0.55), var(--ui-shadow);
	padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
	display: flex; flex-direction: column;
}
.sheet-head {
	display: flex; justify-content: space-between; align-items: center;
	padding: 8px 2px 12px;
	border-bottom: var(--ui-line-w) solid var(--ui-line-c-soft);
	margin-bottom: 12px;
	/* 2026-10-01 删：原来这里有一层 45° 抖动条纹底纹（抄自网页版 .pixel-dither-cyan），
	   用户看实机截图后判定"太丑" ⇒ 去掉，只保留下面的分隔线。（方向上也与"不再参考网页版"一致） */
}
.sheet-title { font-size: 16px; font-weight: 600; color: var(--px-white); letter-spacing: 0.5px; }
.x {
	width: 32px; height: 32px; border-radius: var(--ui-radius-ctl);
	color: var(--px-white);
	background: var(--px-panel-2);
	border: var(--ui-line-w) solid var(--ui-line-c);
	box-shadow: inset -2px -2px 0 0 var(--ui-lo), inset 2px 2px 0 0 var(--ui-hi), var(--ui-shadow);
	&:active { box-shadow: var(--ui-press); }
}
/* 「■ 停止生成」/「■ 停止」是**带文字**的按钮, 不能套 .x 的固定 32x32 ——
   否则 5 个字挤在 32px 里会逐字换行、溢出边框 (实机截图就是竖排的"停/止/生/成"),
   而且打开设置面板时还会透过半透明遮罩露在面板外。回退点: backups\停止生成UI-* */
.x.stop {
	width: auto; min-width: 32px; height: 32px;
	padding: 0 8px;
	white-space: nowrap;
	flex-shrink: 0;
}
.sheet-body { overflow-y: auto; flex: 1; min-height: 0; -webkit-overflow-scrolling: touch; touch-action: pan-y; }

.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.mc {
	border-radius: var(--ui-radius-card); overflow: hidden;
	background: rgba(30, 41, 59, 0.6);
	border: 2px solid transparent;
	cursor: pointer;
	.thumb { width: 100%; height: 130px; background: #1e293b; }
	img { width: 100%; height: 130px; object-fit: cover; display: block; }
	&.on { border-color: var(--accent-strong); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); }
}
.mname { padding: 8px 10px 10px; font-size: 14px; color: var(--fg); }

.empty { padding: 24px 0; text-align: center; color: var(--fg-dim); font-size: 14px; }
.grp { margin-bottom: 14px; }
.grp-name { font-size: 13px; color: var(--fg-3); padding: 6px 2px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
	padding: 7px 12px; border-radius: var(--ui-radius-ctl);
	position: relative; overflow: hidden;
	background: var(--px-panel-2);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	color: var(--px-white); font-size: 13px;
	box-shadow: inset 1px 1px 0 0 var(--ui-hi);
	&:active { background: var(--px-panel); }
}
.chip.w { background: rgba(146, 64, 14, 0.35); border-color: var(--px-red); color: #fecaca; }


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
/* 设置项里的"开关行": 标签在左, 勾选框在右 */
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
.mini {
	padding: 9px 14px;
	border-radius: var(--ui-radius-ctl);
	background: var(--px-panel-2);
	color: var(--px-white);
	font-size: 13px;
	border: var(--ui-line-w) solid var(--ui-line-c);
	white-space: nowrap;
	box-shadow: inset 2px 2px 0 0 var(--ui-hi), inset -2px -2px 0 0 var(--ui-lo), var(--ui-shadow);
	&:active { box-shadow: var(--ui-press); }
}
.hint { font-size: 12px; color: var(--fg-3); }
.hint.ok { color: #4ade80; }
.hint.bad { color: #fbbf24; }
.label-only {
	label { font-size: 13px; color: var(--fg-2); font-weight: 600; }
}
.label-only + .hint { line-height: 1.7; }

/* 记忆系统展示 */
.mem-block {
	border-top: 1px dashed var(--line-strong);
	padding-top: 12px;
}
.mem-sec { display: flex; flex-direction: column; gap: 6px; }
.mem-sec-title {
	font-size: 12px; font-weight: 600; color: var(--accent);
	margin-top: 4px;
}
.mem-item {
	display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px;
	background: var(--px-panel);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	padding: 8px 10px;
	box-shadow: inset 2px 2px 0 0 rgba(20, 38, 72, 0.7);
}
.mem-tag {
	flex-shrink: 0;
	font-size: 10px; line-height: 16px;
	padding: 0 7px; border-radius: var(--ui-radius-ctl);
	border: 1px solid var(--px-line);
	background: var(--px-panel-2); color: var(--px-grey);
	&.core { background: var(--px-amber-deep); color: var(--px-amber); border-color: var(--px-amber); }
	&.fact { background: var(--px-cyan-deep); color: var(--px-cyan); border-color: var(--px-cyan-dim); }
	&.preference { background: var(--px-magenta-deep); color: var(--px-magenta); border-color: var(--px-magenta); }
	&.project { background: #064e3b; color: var(--px-green); border-color: var(--px-green); }
	&.event { background: rgba(251, 146, 60, 0.18); color: #fdba74; }
	&.relationship { background: rgba(244, 114, 182, 0.18); color: #f9a8d4; }
	/* 来源标注 (B2): 「你声明」= 中性灰; 「我推断」= 偏主题色, 提示"这条是她的猜测" */
	&.src { background: var(--px-panel-2); color: var(--px-grey); border-color: var(--px-line); }
	&.src.inferred { background: var(--px-cyan-deep); color: var(--px-cyan); border-color: var(--px-cyan-dim); }
}
.mem-text { flex: 1 1 auto; min-width: 110px; font-size: 13px; color: var(--fg); line-height: 1.45; word-break: break-all; }
/* 目标/固定 图标不再占标签位, 直接贴在正文行首 (B: 标签太乱 → 一行只留一个主标签) */
.mem-ico { margin-right: 2px; }
.mem-group { margin-top: 2px; }
/* P4: 块视图 —— 一个块 = 一次历史总结覆盖的一段对话; 块标题是"主题 · 时间段 · N 条对话",
   块内小节标题降一级 (更小更淡), 让"块 > 类型"的层级一眼看得出来 */
/* 已收起 / 已删除 (2026-09-28): 与「已作废」同一套折叠样式, 但各自一个 class 便于区分与 E2E 断言 */
.mem-faded > summary { cursor: pointer; color: var(--px-grey); }
.mem-deleted > summary { cursor: pointer; color: var(--px-grey); }
/* 记忆优化 (整理优化): 一个小节 + 三个按钮 + 可展开的示例预览 */
.mem-tune { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-tune-btns { margin-top: 2px; }
/* 记忆诊断 (P1): 与「记忆优化」同一套折叠样式, 单独一个 class 便于区分与 E2E 断言 */
.mem-diag { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-diag-btns { margin-top: 2px; }
.mem-tune-detail { line-height: 1.6; }
.mem-block {
	margin-top: 6px;
	padding: 6px 8px 8px;
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	background: color-mix(in srgb, var(--px-panel-2) 55%, transparent);
}
.mem-block > .mem-sec-title { margin-top: 0; }
.mem-sec-title.sub {
	font-size: 11px; font-weight: 500;
	color: var(--px-grey);
	margin-top: 2px;
}
/* P4: 「待整理 N 条」+「立即整理」—— 让"还没进记忆"可见 (实时通道默认关之后的必要交代) */
.mem-pending {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	font-size: 11px; color: var(--px-grey);
	padding: 2px 0 4px;
}
/* A: 整理反馈**就地**贴在按钮下面 (以前写在面板最底部, 用户看不到 ⇒ 以为"点了没用") */
.mem-org-msg {
	margin: 0 0 2px;
	padding: 3px 0 0;
	border-top: 1px dashed var(--ui-line-c-soft);
}
/* C: 记忆库顶部统计行 + 空态提示 + 底部操作区 */
.mem-stats {
	font-size: 11px; color: var(--px-grey);
	padding: 2px 0 4px;
	border-bottom: 1px dashed var(--ui-line-c-soft);
	margin-bottom: 4px;
}
.mem-invalid-empty {
	font-size: 11px; color: var(--px-grey); opacity: 0.85;
	padding: 4px 0 2px;
}
.mem-btns-bottom { margin-top: 8px; }
/* 已作废的记忆 (B1): 灰一档 + 内容划掉, 一眼看出"这是留档, 不是现在生效的" */
.mem-invalid {
	& > summary { cursor: pointer; color: var(--px-grey); }
	.mem-item { opacity: 0.72; }
	.mem-text { text-decoration: line-through; text-decoration-color: var(--px-grey); }
}
.mem-op {
	flex-shrink: 0;
	font-size: 10px; line-height: 1;
	padding: 5px 8px;
	border-radius: var(--ui-radius-ctl);
	background: var(--px-panel-2); color: var(--px-white);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	box-shadow: inset 1px 1px 0 0 var(--ui-hi);
	&:active { background: var(--px-panel); }
	&.danger { background: rgba(146, 64, 14, 0.4); color: #fecaca; border-color: var(--px-red); }
}
/* 记忆库页 (独立页) */
.mem-sec-title-row {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	.mem-view-all { font-size: 11px; padding: 3px 8px; }
}
.mem-search-row {
	display: flex; gap: 6px; margin-bottom: 8px;
	.mem-search-input {
		flex: 1; min-width: 0;
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-card);
		color: var(--fg); font-size: 12px;
		padding: 7px 9px;
	}
	.mem-search-sel {
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-card);
		color: var(--fg-2); font-size: 12px;
		padding: 6px 4px;
	}
}
.mem-count-hint { font-size: 11px; color: var(--fg-dim); margin: 0 0 6px 2px; }
/* 一级设置页里的"记忆库"入口按钮 (三份列表已收进二级菜单, 这里只留入口) */
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
.mem-sub {
	width: 100%;
	font-size: 10px; color: var(--fg-dim);
}
.mem-tag.pinned { background: rgba(56, 189, 248, 0.2); color: var(--accent); }
.mem-tag.goal { background: rgba(251, 191, 36, 0.18); padding: 0 4px; }
.goal-add {
	display: flex; gap: 6px; margin-top: 2px;
	input {
		flex: 1; min-width: 0;
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid var(--line-strong);
		border-radius: var(--ui-radius-card);
		color: var(--fg); font-size: 12px;
		padding: 6px 8px;
	}
	button { flex-shrink: 0; }
}

/* 日记日历视图 */
.diary-head-btns { display: flex; gap: 6px; }
.diary-cal {
	background: rgba(15, 23, 42, 0.45);
	border: 1px solid var(--line-soft);
	border-radius: var(--ui-radius-ctl);
	padding: 8px;
	margin-bottom: 10px;
	.diary-cal-head {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: 6px;
		.diary-cal-title { font-size: 13px; font-weight: 600; color: var(--fg); }
	}
	.cal-week {
		display: grid; grid-template-columns: repeat(7, 1fr);
		span { text-align: center; font-size: 10px; color: var(--fg-dim); padding: 2px 0; }
	}
	.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
	.cal-cell {
		position: relative;
		aspect-ratio: 1;
		display: flex; align-items: center; justify-content: center;
		border-radius: var(--ui-radius-card);
		font-size: 12px; color: var(--fg-2);
		&.blank { background: transparent; }
		&.has { cursor: pointer; }
		&.today .cal-day-num { color: var(--accent); font-weight: 700; }
		&.sel { background: rgba(125, 211, 252, 0.22); outline: 1px solid rgba(125, 211, 252, 0.7); color: #fff; }
		.cal-dot {
			position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
			width: 5px; height: 5px; border-radius: 50%;
			&.mood-happy { background: #fde047; }
			&.mood-calm { background: var(--fg-3); }
			&.mood-lonely { background: #93c5fd; }
			&.mood-sad { background: #a5b4fc; }
		}
	}
}
.diary-detail { .diary-item { margin-bottom: 0; } }
.diary-del { margin-left: auto; }
.diary-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.diary-item {
	background: rgba(30, 41, 59, 0.65);
	border: 1px solid var(--line);
	border-radius: var(--ui-radius-ctl);
	padding: 10px 12px;
	margin-bottom: 10px;
}
.diary-date {
	display: flex; align-items: center; gap: 8px;
	font-size: 11px; color: var(--fg-3);
}
.diary-mood {
	font-size: 11px; padding: 1px 8px; border-radius: var(--ui-radius-pill);
	&.mood-happy { background: rgba(250, 204, 21, 0.2); color: #fde047; }
	&.mood-calm { background: var(--line); color: var(--fg-2); }
	&.mood-lonely { background: rgba(96, 165, 250, 0.2); color: #93c5fd; }
	&.mood-sad { background: var(--line-strong); color: #a5b4fc; }
}
.diary-count { margin-left: auto; font-size: 11px; color: var(--fg-dim); }
.diary-content {
	margin-top: 6px;
	font-size: 14px; color: var(--fg); line-height: 1.7;
	white-space: pre-wrap;
}
/* ---------------- 新手引导 ----------------
 * 2026-10-01 重做（用户：「内容不变，AI 味太大」）。原来的长相是通用弹窗三件套：
 * 40px 大 emoji + 居中标题 + 圆点分页 + 整宽渐变按钮，正文还套了个告警框 —— 换成**她递来的一张便签**：
 * 左对齐、纸感底色、顶部一小条胶带、标题下一道短强调线、正文左侧细色条（替代告警框）、
 * 分页改成细横条、按钮收成右下角小药丸。**文案与数据一字未改**，类名也保持原样（测试/探针按类名找元素）。
 * 两种主题都吃 --ui-* / --px-* 变量，所以像素风下依然是硬边直角。 */
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
.intro-open { color: var(--accent); }

/* ---------------- 模型授权验证（答题门，2026-10-01；2026-10-02 两处共用） ----------------
   结构照参考图（标题/说明/问题/输入/取消·验证/底部提示），配色走本应用的柔和风变量。
   只有一份样式： clone / model 两个动作都挂 .gate-mask + .gate（各自额外带一个语义类名，
   克隆那个 .clone-gate 保持原样给 probe-clone-gate 找元素）。 */
.gate-mask {
	position: absolute; inset: 0; z-index: 60;
	display: flex; align-items: center; justify-content: center;
	padding: 22px;
	background: rgba(4, 10, 20, 0.62);
	backdrop-filter: blur(3px);
}
.gate {
	width: 100%; max-width: 340px;
	padding: 18px 18px 14px;
	background: var(--panel, rgba(12, 22, 38, 0.96));
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-panel);
	box-shadow: var(--ui-shadow);
	color: var(--fg);
}
.gate-head {
	display: flex; align-items: center; justify-content: space-between;
	margin-bottom: 10px;
}
.gate-title {
	font-size: 16px; font-weight: 700; letter-spacing: 0.02em;
	color: var(--accent);
}
.gate-desc {
	margin: 0 0 12px; font-size: 12.5px; line-height: 1.7; color: var(--fg-dim);
	b { color: var(--fg); font-weight: 600; }
}
.gate-q {
	margin-bottom: 10px;
	font-size: 14px; font-weight: 700; line-height: 1.5;
}
.gate-input {
	width: 100%; box-sizing: border-box;
	padding: 10px 12px;
	background: var(--px-void);
	color: var(--fg);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	font-size: 13.5px;
	outline: none;
	&:focus { border-color: var(--accent); }
}
.gate-btns {
	margin-top: 12px;
	display: flex; align-items: center; justify-content: flex-end; gap: 8px;
	.mini {
		padding: 9px 16px; border-radius: var(--ui-radius-ctl);
		font-size: 13.5px; line-height: 1;
		background: transparent; color: var(--fg-dim);
		border: var(--ui-line-w) solid var(--ui-line-c-soft);
	}
	.gate-go {
		background: var(--accent); color: #06121f; font-weight: 600;
		border-color: transparent; box-shadow: var(--ui-shadow);
		&:disabled { opacity: 0.5; }
	}
}
.gate-hint {
	margin-top: 12px; padding-top: 10px;
	border-top: var(--ui-line-w) solid var(--ui-line-c-soft);
	font-size: 11.5px; line-height: 1.65; color: var(--fg-dim);
}
/* 存储自检结果 (等宽, 可横向滚动; 直接截图给开发者看) */
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
.mem-summary {
	background: var(--px-panel);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-ctl);
	padding: 8px 10px;
	summary {
		font-size: 12px; color: var(--accent); cursor: pointer; user-select: none;
		list-style: none;
		&::-webkit-details-marker { display: none; }
		&::before { content: "▸ "; }
	}
	&[open] summary::before { content: "▾ "; }
}
.mem-summary-content {
	margin-top: 8px;
	font-size: 13px; color: var(--fg); line-height: 1.6;
	max-height: 160px; overflow-y: auto;
	-webkit-overflow-scrolling: touch;
	touch-action: pan-y;
}
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

.sheet-enter-active, .sheet-leave-active {
	transition: opacity 0.22s ease;
	.sheet { transition: transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1); }
}
.sheet-enter-from, .sheet-leave-to {
	opacity: 0;
	.sheet { transform: translateY(100%); }
}

/* 背景音乐开关 (设置面板内联) */
.bgm-toggle {
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--fg);
	font-size: 13px;
}

/* ---------------- 关于 / 隐私 / 开源许可页（2026-10-02 用户要求） ----------------
   复用现有 sheet 面板（入口在设置面板底部），所以这里只有内容排版：
   配色一律沿用现有 --fg-* / --px-* / --accent 变量，不新造颜色。 */
/* 设置面板底部的入口行（.mini 撑满一行，视觉上跟一排 .btn 区分开） */
.about-row { padding: 4px 2px 10px; }
.about-open {
	width: 100%; text-align: left;
	background: transparent; color: var(--accent);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
}
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

/* ---------------- 横屏适配 (竖屏外观完全不变) ---------------- */
@media (orientation: landscape) {
	/* 聊天面板: 不再全宽 (横屏下会横盖整个模型), 靠右限宽; 竖向空间小 → 面板放高 */
	.chat-panel {
		left: auto;
		right: calc(10px + env(safe-area-inset-right, 0px));
		width: min(52vw, 520px);
		max-height: 80vh;
	}
	/* 底部 dock: 内容限宽居中 (50%-280px 两侧收进), 不让按钮横跨整个屏幕; 兼容刘海左右安全区 */
	.dock {
		padding-left: calc(max(10px, 50% - 280px) + env(safe-area-inset-left, 0px));
		padding-right: calc(max(10px, 50% - 280px) + env(safe-area-inset-right, 0px));
	}
	/* 底部弹层 (模型/动作/表情/日记/记忆库/设置): 限宽居中, 高度放宽 */
	.sheet-mask {
		justify-content: center;
	}
	.sheet {
		width: min(64vw, 680px);
		max-height: 90vh;
	}
	/* 顶栏: 补左右安全区 (横屏刘海/挖孔) */
	.topbar {
		padding-left: calc(14px + env(safe-area-inset-left, 0px));
		padding-right: calc(14px + env(safe-area-inset-right, 0px));
	}
}
</style>
