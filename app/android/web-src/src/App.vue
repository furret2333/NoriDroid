<template>
	<div
		class="stage-root"
		:class="[uiSoft ? 'ui-soft' : 'ui-tide', {portrait: portraitLayout, 'keyboard-open': keyboardOpen}]"
		:style="{'--chat-keyboard-inset': keyboardInset + 'px'}"
		@pointerdown="closeChatMenusOutside"
		@touchstart.passive="onTouchStart"
		@touchmove.passive="onTouchMove"
		@touchend.passive="onTouchEnd"
		@touchcancel.passive="onTouchEnd"
	>
		
		<div ref="rippleHost" class="ripple-host"></div>

		<!-- 鎵嬫寚瑙︽懜杩借釜: 鍗婇€忔槑纾ㄧ爞灏忕櫧鐐硅窡闅忔墜鎸?-->
		<div ref="touchDotHost" class="touch-dot-host"></div>

		<!-- 鏁版嵁娴峰姩鎬佽儗鏅?(绾▼搴忔覆鏌?: 鏄熷皹/鏄熶簯婕傜Щ/缃戞牸, 浣嶄簬 Live2D 涔嬩笅 -->
		<canvas ref="dataseaCanvas" class="datasea-bg" v-show="cfg.dataseaBg"></canvas>

		<!-- 鍛戒腑鍖哄煙璋冭瘯鏄剧ず (娴嬭瘯鐢?: 瀹炴椂鏄剧ず褰撳墠瑙︽懜鍛戒腑鐨勫尯鍩?+ 鎶氭懜杩涘害/瀹屾垚娆℃暟 -->
		<div v-if="hitDebug && hitZoneText" class="hit-debug">鍛戒腑锛歿{ hitZoneText }}<span v-if="petDebugText"> 锝?{{ petDebugText }}</span></div>

		<!-- 鐣寗閽熸偓娴獥 (鎷栨嫿绉诲姩 / 鍙充笅瑙掔缉鏀?/ 鍙姌鍙? 缁勪欢鏍规埅鏂?pointer 浜嬩欢, 涓嶆儕鍔ㄦ懜澶翠笌鍙屾寚鎵嬪娍) -->
		<div v-if="pomoWidgetOn && pomo.phase !== 'idle' && panel !== 'pomo' && panel !== 'pomoStats'" ref="pomoWidgetEl" class="pomo-widget" :class="{mini: pomoMini}" :style="{left: pomoPos.x + 'px', top: pomoPos.y + 'px', width: pomoMini ? 'auto' : pomoPos.w + 'px'}" @pointerdown.stop>
			<template v-if="!pomoMini">
				<div class="pw-head" @pointerdown="onPomoDragDown" @pointermove="onPomoDragMove" @pointerup="onPomoDragUp" @pointercancel="onPomoDragUp">
					<span class="pw-tomato">馃崊</span><span>{{ pomoPhaseText }}</span>
					<button class="pw-mini-btn" title="鏀惰捣" aria-label="鏀惰捣璁℃椂鎸備欢" @pointerdown.stop @click="pomoMini = true; pomoPosSave()">鈥?/button>
				</div>
				<div class="pw-time">{{ pomoFmt }}</div>
				<div v-if="pomo.phase !== 'countUp'" class="pw-bar"><i :style="{transform: 'scaleX(' + pomoPct / 100 + ')'}"></i></div>
				<div class="pw-btns">
					<button :disabled="pomoBusy || pomo.rebootPending" @click="pomoAction('pause')">{{ pomo.paused ? '缁х画' : '鏆傚仠' }}</button>
					<button class="warn" @click="pomoWidgetStop">{{ pomo.phase === 'break' ? '缁撴潫浼戞伅' : '缁撴潫骞朵繚瀛? }}</button>
				</div>
				<i class="pw-grip" @pointerdown="onPomoRzDown" @pointermove="onPomoRzMove" @pointerup="onPomoRzUp" @pointercancel="onPomoRzUp"></i>
			</template>
			<template v-else>
                <div class="pw-mini-group"><span class="pw-mini-drag" title="鎷栧姩" @pointerdown="onPomoDragDown" @pointermove="onPomoDragMove" @pointerup="onPomoDragUp" @pointercancel="onPomoDragUp">鉅?/span><button class="pw-pill" :aria-label="pomoPhaseText + '锛屽睍寮€璁℃椂鎸備欢'" @click="pomoMini = false; pomoPosSave()"><small>{{ pomoPhaseText }}</small>{{ pomoFmt }}</button><button class="pw-mini-control" :disabled="pomoBusy || pomo.rebootPending" :aria-label="pomo.paused ? '缁х画璁℃椂' : '鏆傚仠璁℃椂'" @click="pomoAction('pause')">{{ pomo.paused ? '鈻? : '鈪? }}</button></div>
			</template>
		</div>


		
		<div ref="l2dHost" class="l2d-host"></div>

		
		<transition name="fade">
			<div v-if="touchBubble" class="touch-bubble">{{ touchBubble }}</div>
		</transition>

		
		<transition name="ai">
			<div v-if="!portraitLayout && aiBubble" class="ai-bubble">
				<div class="ai-bubble-head"><span class="ai-bubble-dot"></span>Nori</div>
				<div class="ai-bubble-txt">{{ aiBubble }}</div>
			</div>
		</transition>

		<div class="topbar" v-show="panel !== 'touch' && panel !== 'tts'">
			<button
				type="button"
				class="tag"
				:class="{locked: canvasLocked}"
				:title="canvasLocked ? '鐐瑰嚮閫夋嫨妯″瀷锛涢暱鎸夋垨鎸夌┖鏍艰В閿佺敾甯? : '鐐瑰嚮閫夋嫨妯″瀷锛涢暱鎸夋垨鎸夌┖鏍奸攣瀹氱敾甯?"
				@pointerdown="onModelTagDown"
				@pointermove="onModelTagMove"
				@pointerup="cancelModelTagPress()"
				@pointercancel="cancelModelTagPress(true)"
				@lostpointercapture="cancelModelTagPress(true)"
				@contextmenu.prevent
				@keydown.space.prevent="onModelTagSpace"
				@keyup.space.prevent
				@click="onModelTagClick"
			>
				<span>{{ currentModel?.name ?? "鈥? }}</span>
				<span class="tag-hint">{{ canvasLocked ? '宸查攣瀹?路 闀挎寜瑙ｉ攣' : '闀挎寜閿佸畾鐢诲竷' }}</span>
			</button>
			<div v-if="error" class="err" @click="error = ''">{{ error }} 鉁?/div>
			<div v-else-if="loading" class="loading">{{ loadingMsg }}</div>
		</div>

		
		<transition name="chat">
			<div v-if="portraitLayout || chatOpen" v-show="!portraitLayout || !panel" class="chat-panel" :class="{'history-open': chatOpen}">
				<transition name="ai">
					<button v-if="portraitLayout && !chatOpen && portraitReply" class="portrait-reply" type="button" title="鐐瑰嚮灞曞紑鑱婂ぉ璁板綍" @click="openPortraitHistory">
						<span v-for="(seg, i) in bubbleSegments(portraitReply)" :key="i" class="portrait-reply-text">{{ bubbleText(seg) }}</span>
					</button>
				</transition>
				<button v-if="portraitLayout" class="history-toggle" type="button" :aria-expanded="chatOpen" aria-controls="chat-history" :aria-label="chatOpen ? '鏀惰捣鑱婂ぉ璁板綍' : '灞曞紑鑱婂ぉ璁板綍'" @click="toggleChat">
					<svg viewBox="0 0 24 24" aria-hidden="true" :class="{expanded: chatOpen}"><path d="m6 15 6-6 6 6" /></svg>
				</button>
				<div id="chat-history" class="chat-history" v-show="chatOpen">
				<div class="chat-head">
					<span class="chat-title">瀵硅瘽 路 {{ curModelName }}</span>
					<button v-if="chatStreaming || touchStreaming" class="x stop" @click="stopGenerate">鈻?鍋滄鐢熸垚</button>
					<button v-if="speaking" class="x stop" @click="stopTTS()">鈻?鍋滄</button>
					<button class="x" aria-label="鏀惰捣鑱婂ぉ璁板綍" @click="chatOpen = false">鉁?/button>
				</div>
				<div ref="chatScroll" class="chat-msgs" :style="{ fontSize: chatFontPX, '--bubble-w': bubbleWidthNum + '%' }" @click="imageMenu = false">
					<div v-if="!messages.length" class="chat-empty">鍜屾垜璇寸偣浠€涔堝惂</div>
					<div
						v-for="m in messages"
						:key="msgKey(m)"
						class="bubble-wrap"
						:class="m.role"
						:data-message-ts="m.ts"
					>
						<div v-if="m.role === 'user' && messageImageUrl(m)" class="message-image-wrap">
							<img class="message-image" :src="messageImageUrl(m) ?? ''" alt="宸插彂閫佸浘鐗? />
						</div>
						<!-- 瀛樺偍/鍘嗗彶: 涓€鏉℃秷鎭? 鏄剧ず: assistant 鎸夊彞鎷嗗姘旀场, user 淇濇寔鏁存潯 -->
						<div
							v-for="(seg, j) in messageSegments(m)"
							:key="j"
							class="bubble"
						>{{ bubbleText(seg) }}</div>
					</div>
					<div v-if="(typing && !chatStreaming) || (touchStreaming && messages[messages.length - 1]?.role === 'user')" class="bubble-wrap assistant"><div class="bubble typing sea-dots"><span></span><span></span><span></span></div></div>
				</div>
				</div>
				<div v-if="pendingQueue.length" class="queue-hint">宸叉帓闃?{{ pendingQueue.length }} 鏉?/div>
				<div v-if="pendingImage" class="image-preview-row">
					<img class="image-preview" :src="pendingImage.dataUrl" alt="寰呭彂閫佸浘鐗? />
					<div class="image-preview-meta"><span>宸查€夊浘鐗?路 浠呴殢鏈潯鍙戦€?/span><button class="image-remove" title="绉婚櫎鍥剧墖" aria-label="绉婚櫎鍥剧墖" @click="pendingImage = null">鉁?/button></div>
				</div>
				<div class="chat-input">
					<input
						v-model="draft"
						:placeholder="modelReady ? '杈撳叆娑堟伅鈥? : '璇峰厛鍦ㄨ缃噷閰嶇疆 API Key 鍜屾ā鍨?"
						@focus="onComposerFocus"
						@blur="onComposerBlur"
						@keydown.enter="onInputEnter"
					/>
					<div v-if="portraitLayout" class="image-entry composer-more">
						<button class="chat-tool" type="button" title="鍥剧墖涓庢埑鎴? aria-label="鍥剧墖涓庢埑鎴? aria-haspopup="menu" :aria-expanded="imageMenu" @click="imageMenu = !imageMenu">锛?/button>
						<div v-show="imageMenu" class="image-menu" role="menu" @keydown.esc="imageMenu = false">
							<button role="menuitem" :disabled="imagePicking" @click="chooseImage('album')">{{ imagePicking ? '閫夊浘涓€? : '浠庣浉鍐岄€夊浘' }}</button>
							<button role="menuitem" :disabled="imagePicking" @click="chooseImage('camera')">鐩存帴鎷嶆憚</button>
							<button class="poke" role="menuitem" :disabled="!modelReady || typing || chatStreaming || touchStreaming" @click="imageMenu = false; pokeNori()">鎴虫埑 Nori</button>
						</div>
					</div>
					<button class="send" :class="{stop: portraitLayout && (chatStreaming || touchStreaming)}" @click="portraitLayout && (chatStreaming || touchStreaming) ? stopGenerate() : send()" :disabled="!(portraitLayout && (chatStreaming || touchStreaming)) && !draft.trim() && !pendingImage">{{ portraitLayout && (chatStreaming || touchStreaming) ? '鍋滄' : '鍙戦€? }}</button>
				</div>
				<div v-if="!portraitLayout" class="chat-tools">
					<div class="image-entry">
						<button class="chat-tool" title="娣诲姞鍥剧墖" aria-haspopup="menu" :aria-expanded="imageMenu" :disabled="imagePicking" @click="imageMenu = !imageMenu">{{ imagePicking ? '閫夊浘涓€? : '鍥剧墖' }}</button>
						<div v-if="imageMenu" class="image-menu" role="menu" @keydown.esc="imageMenu = false">
							<button role="menuitem" @click="chooseImage('album')">浠庣浉鍐岄€夊浘</button>
							<button role="menuitem" @click="chooseImage('camera')">鐩存帴鎷嶆憚</button>
						</div>
					</div>
					<button class="chat-tool poke" title="鎴虫埑 Nori锛岃亰涓€鍙? @click="pokeNori" :disabled="!modelReady || typing || chatStreaming || touchStreaming">鎴虫埑</button>
					<span class="chat-tool-hint">璇嗗浘闇€妯″瀷鏀寔</span>
				</div>
			</div>
		</transition>

		<div v-if="portraitLayout && !panel" v-show="sideRailOpen" class="side-rail-mask" @pointerdown.stop="sideRailOpen = false"></div>
		<nav v-if="portraitLayout && !panel" class="side-rail" :class="{open: sideRailOpen}" aria-label="鍔熻兘鑿滃崟" @pointerdown="onDockPress" @keydown.esc="sideRailOpen = false">
			<button class="side-rail-handle" type="button" :aria-expanded="sideRailOpen" aria-controls="side-rail-items" :aria-label="sideRailOpen ? '鏀惰捣鍔熻兘鑿滃崟' : '灞曞紑鍔熻兘鑿滃崟'" @click="sideRailOpen = !sideRailOpen; imageMenu = false">
				<svg viewBox="0 0 24 24" aria-hidden="true" :class="{expanded: sideRailOpen}"><path d="m14 6-6 6 6 6" /></svg>
			</button>
			<div id="side-rail-items" v-show="sideRailOpen" class="side-rail-items">
				<button v-for="item in portraitActions" :key="item.panel" class="side-action ripple" @click="item.panel === 'diary' ? openDiary() : openPanel(item.panel)">
					<img :src="item.icon" alt="" draggable="false" /><span>{{ item.label }}</span>
				</button>
			</div>
		</nav>

		<div class="dock" v-show="!portraitLayout && panel !== 'touch' && panel !== 'tts'" @pointerdown="onDockPress">
			<button class="fab ripple" @click="openDiary">
				<img class="fab-ico" :src="DOCK_ICONS.diary" alt="" draggable="false" />
				<span class="fab-label">鏃ヨ</span>
			</button>
			<button class="fab ripple" @click="openPanel('model')">
				<img class="fab-ico" :src="DOCK_ICONS.model" alt="" draggable="false" />
				<span class="fab-label">妯″瀷</span>
			</button>
			<button class="fab ripple" @click="openPanel('pomo')">
				<img class="fab-ico" :src="DOCK_ICONS.pomo" alt="" draggable="false" />
				<span class="fab-label">鐣寗</span>
			</button>
			<button class="fab ripple" @click="openPanel('settings')">
				<img class="fab-ico" :src="DOCK_ICONS.settings" alt="" draggable="false" />
				<span class="fab-label">璁剧疆</span>
			</button>
			<button class="fab ripple" @click="toggleChat">
				<img class="fab-ico" :src="DOCK_ICONS.chat" alt="" draggable="false" />
				<span class="fab-label">瀵硅瘽</span>
			</button>
		</div>

		
		<Transition name="fade">
		<div v-if="panel === 'touch'" class="touch-page">
			<div v-show="touchCustomExpanded" class="touch-overlay" :class="{drawing: touchDrawing, testing: touchTesting}">
				<div v-for="(t, i) in touchAreas" :key="t.id" class="touch-area-box" :class="[t.type, {selected: selectedTouchId === t.id}]" :style="[boxStyle(t), {zIndex: i + 1}]">
					<span class="ba-name">{{ t.name }}</span>
					<span v-if="touchAdjusting && selectedTouchId === t.id" class="touch-resize-handle" aria-hidden="true">鈫?/span>
				</div>
				<div v-if="touchDraft" class="touch-area-box draft" :style="boxStyle(touchDraft)"></div>
			</div>
			
			<div class="touch-top">
				<span class="touch-title">浜掑姩璁剧疆</span>
				<button class="x" aria-label="鍏抽棴浜掑姩璁剧疆" @click="closeTouchSettings">鉁?/button>
			</div>
			
			<div class="touch-editor">
				<section class="touch-intro">
					<div class="touch-intro-icon" aria-hidden="true">鈾?/div>
					<div class="touch-intro-copy">
						<b>鎽稿ご 路 榛樿浜掑姩</b>
						<span>鍦ㄦā鍨嬪ご閮ㄦ寜浣忔垨杞昏交鎶氭懜锛屼細瑙﹀彂琛ㄦ儏銆佽交鎽嗗拰鏌斿厜鍙嶉銆傚彴璇嶆湕璇昏窡闅忚闊冲悎鎴愯缃€?/span>
					</div>
				</section>
				<section class="touch-pet-options">
					<div class="touch-option-head"><b>鎽稿ご鍙嶉</b><small>榛樿寮€鍚紱鍏抽棴鍚庝粛淇濈暀澶撮儴璺熼殢</small></div>
					<div class="touch-option-grid">
						<label><span>琛ㄦ儏涓庤交鎽?/span><input type="checkbox" v-model="cfg.petTouchEnabled" @change="onPetTouchSetting" /></label>
						<label><span>鏌斿厜鐗规晥</span><input type="checkbox" v-model="cfg.petTouchEffects" @change="onPetTouchSetting" /></label>
						<label><span>鎽╂摝闊虫晥</span><input type="checkbox" v-model="cfg.petTouchSound" @change="onPetTouchSetting" /></label>
						<label><span>鍙拌瘝鏈楄</span><input type="checkbox" v-model="cfg.petTouchSpeech" @change="onPetTouchSetting" /></label>
					</div>
				</section>
				<details class="touch-custom" :open="touchCustomExpanded" @toggle="onTouchCustomToggle">
					<summary>鑷畾涔夊尯鍩?路 杩涢樁 <small>{{ touchAreas.length }} 涓尯鍩?/small></summary>
				<TouchManager
					:touches="touchAreas"
					:drawing="touchDrawing"
					:adjusting="touchAdjusting"
					:has-draft="draftReady"
					:enabled="touchEnabled"
					:testing="touchTesting"
					:cooldown-text="touchCooldownText"
					:selected-id="selectedTouchId"
					:editing-id="touchEditingId"
					:can-undo="!!deletedTouch"
					:busy="touchReplyBusy()"
					@toggle-draw="toggleTouchDraw"
					@toggle-adjust="toggleTouchAdjust"
					@toggle-testing="toggleTouchTesting"
					@set-enabled="setTouchEnabled"
					@add="onTouchAdd"
					@update="onTouchUpdate"
					@select="selectedTouchId = $event"
					@edit="beginTouchEdit"
					@preview="previewTouchEdit"
					@cancel-edit="cancelTouchEdit"
					@undo="undoTouchRemove"
					@remove="onTouchRemove"
					@test="onTouchTest"
					@reset-draft="resetTouchDraft"
				/>
				</details>
				<p v-if="touchBubble" class="touch-feedback" role="status">{{ touchBubble }}</p>
				<div v-if="touchReplyPreview" class="touch-ai-preview" aria-live="polite"><b>Nori{{ touchStreaming ? ' 路 姝ｅ湪鍥炲簲' : '' }}</b><p>{{ touchReplyPreview }}</p></div>
			</div>
		</div>
		</Transition>

		<Transition name="fade">
		<div v-if="panel === 'tts'" class="tts-page">
			<div class="tts-top">
				<span class="tts-title">璇煶鍚堟垚</span>
				<button class="x" @click="panel = ''">鉁?/button>
			</div>
			<div class="tts-body">
				<div class="tts-sec">
					<div class="tts-sec-title">寮€鍏?/div>
					<div class="field row-inline">
						<label>鍚敤璇煶鏈楄</label>
						<input type="checkbox" v-model="cfg.ttsEnabled" />
					</div>
					<div class="field">
						<label>鎻愪緵鍟?/label>
						<div class="voice-pick">
							<select v-model="cfg.ttsProvider">
								<option value="fish">Fish Audio</option>
								<option value="cosyvoice">鍗冮棶 CosyVoice</option>
							</select>
						</div>
						<div class="hint">鍒囨崲鍚庡悇鑷厤缃嫭绔嬩繚瀛? 浜掍笉褰卞搷</div>
					</div>
					<div class="field">
						<label>鏈楄闊抽噺 {{ Math.round((Number(cfg.ttsVolume) || 0) * 100) }}%锛堝簲鐢ㄥ唴锛屼笉褰卞搷绯荤粺闊抽噺锛?/label>
						<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.ttsVolume" @input="applyTtsVolume" @change="persistSettings" />
						<div class="hint">鍙皟鏁?Nori 璇磋瘽鐨勯煶閲忥紝鎵嬫満閾冨０/濯掍綋闊抽噺涓嶅彈褰卞搷</div>
					</div>
					<div class="hint">寮€鍚悗, Nori 鐨勬瘡鍙ュ洖澶嶉兘浼氭祦寮忔湕璇?/div>
				</div>

				<template v-if="cfg.ttsProvider === 'fish'">
				<div class="tts-sec">
					<div class="tts-sec-title">璐︽埛閰嶇疆</div>
					<div class="field">
						<label>Fish Audio API Key</label>
						<input v-model="cfg.ttsApiKey" type="text" autocomplete="off" spellcheck="false" placeholder="鍦?fish.audio 鎺у埗鍙拌幏鍙?(sk-...)" />
					</div>
					<div class="field">
						<label>API Base URL</label>
						<input v-model="cfg.ttsBaseUrl" type="text" autocomplete="off" spellcheck="false" />
					</div>
				</div>

				<div class="tts-sec">
					<div class="tts-sec-title">闊宠壊涓庡弬鏁?/div>
					<div class="field">
						<label>闊宠壊锛堝彲閫夛級</label>
						<div class="voice-pick">
							<select v-model="cfg.ttsReferenceId">
								<option value="">榛樿闊宠壊</option>
								<option v-for="v in voiceOptions" :key="v.id" :value="v.id">{{ v.title }}</option>
							</select>
							<button class="mini ripple" :disabled="voicesLoading" @click="loadVoices">{{ voicesLoading ? "鍔犺浇涓€? : "鍔犺浇闊宠壊" }}</button>
						</div>
						<input v-model="cfg.ttsReferenceId" type="text" autocomplete="off" spellcheck="false" placeholder="鎴栨墜鍔ㄨ緭鍏?Reference ID, 鐣欑┖鐢ㄩ粯璁ら煶鑹? />
						<div v-if="voicesMsg" class="hint" :class="{ok: voicesMsgOk, bad: !voicesMsgOk}">{{ voicesMsg }}</div>
					</div>
					<div class="field">
						<label>妯″瀷</label>
						<select v-model="cfg.ttsModel">
							<option v-for="md in FISH_MODELS" :key="md" :value="md">{{ md }}</option>
						</select>
					</div>
					<div class="field">
						<label>闊抽鏍煎紡</label>
						<select v-model="cfg.ttsFormat">
							<option v-for="f in FISH_FORMATS" :key="f" :value="f">{{ f }}</option>
						</select>
						<div class="hint">mp3 鍏煎鎬ф渶濂? pcm 寤惰繜鏈€浣?/div>
					</div>
					<div class="field">
						<label>鍒嗗潡闀垮害 {{ cfg.ttsChunkLength }}</label>
						<input type="range" min="100" max="500" step="50" v-model.number="cfg.ttsChunkLength" />
						<div class="hint">瓒婂皬棣栭煶瓒婂揩銆佸潡鏁拌秺澶?/div>
					</div>
					<div class="field">
						<label>寤惰繜妯″紡</label>
						<select v-model="cfg.ttsLatency">
							<option v-for="l in FISH_LATENCIES" :key="l" :value="l">{{ l }}</option>
						</select>
					</div>
				</div>
				</template>

				<template v-else>
				<div class="tts-sec">
					<div class="tts-sec-title">鍗冮棶 CosyVoice 閰嶇疆</div>
					<div class="field">
						<label>鍗冮棶/鐧剧偧 API Key</label>
						<input v-model="cfg.cosyApiKey" type="text" autocomplete="off" spellcheck="false" placeholder="鍦ㄧ櫨鐐兼帶鍒跺彴鑾峰彇 (sk-...)" />
					</div>
					<div class="field">
						<label>API Base URL</label>
						<input v-model="cfg.cosyBaseUrl" type="text" autocomplete="off" spellcheck="false" placeholder="https://dashscope.aliyuncs.com 鎴栧寳浜笓灞炲煙鍚? />
					</div>
					<div class="field">
						<label>妯″瀷</label>
						<select v-model="cfg.cosyModel">
							<option v-for="md in COSY_MODELS" :key="md" :value="md">{{ md }}</option>
						</select>
					</div>
					<div class="field">
						<label>闊宠壊</label>
						<div class="voice-pick">
							<select v-model="cfg.cosyVoice">
								<option v-if="!cfg.cosyCloneVoices.length" value="">鏆傛棤鍏嬮殕闊宠壊锛屽厛鍏嬮殕涓€涓?/option>
								<option v-for="v in cfg.cosyCloneVoices" :key="v.id" :value="v.id">{{ v.model ? `${v.model} 路 ${v.id}` : v.id }}{{ v.model && v.model !== cfg.cosyModel ? "锛堝綋鍓嶆ā鍨嬩笉鍙敤锛? : "" }}</option>
							</select>
						</div>
						<input v-model="cfg.cosyVoice" type="text" autocomplete="off" spellcheck="false" placeholder="鎴栨墜鍔ㄨ緭鍏ラ煶鑹?id" />
						<div v-if="cosyVoiceHint" class="hint bad">{{ cosyVoiceHint }}</div>
					</div>
					<div class="field">
						<label>璇€?{{ Number(cfg.cosyRate).toFixed(1) }}x</label>
						<input type="range" min="0.5" max="2" step="0.1" v-model.number="cfg.cosyRate" />
					</div>
					<div class="tts-sec-title">澹伴煶鍏嬮殕</div>
					<div class="field">
						<label>鍏嬮殕闊宠壊鍓嶇紑 (瀛楁瘝鏁板瓧)</label>
						<input v-model="clonePrefix" type="text" autocomplete="off" spellcheck="false" placeholder="濡?myvoice" />
					</div>
					<!-- 涓€閿厠闅嗭紙2026-10-01锛? 鍙傝€冮煶棰?*鑱旂綉涓嬭浇**锛堜笉鍐嶆墦杩?APK锛夛紝鐪佹帀"鑷繁鎵句竴娈?10~20 绉掑共闊?杩欎竴姝?-->
					<div class="field">
						<label>涓€閿厠闅嗭紙棰勮鍙傝€冮煶棰戯級</label>
						<button class="btn ripple primary" :disabled="cloneCreating" @click="openCloneGate">
							{{ cloneCreating ? "涓嬭浇/鍒涘缓涓€? : "涓€閿厠闅嗛璁鹃煶鑹? }}
						</button>
						<div class="hint">鐐规寜閽悗浼氬厛**鑱旂綉涓嬭浇**涓€娈?12.5 绉掔殑鍙傝€冮煶棰戯紙棣栨绾?3.4MB锛屼箣鍚庤蛋鏈湴缂撳瓨锛夛紝鍐嶇敱鍗冮棶鍒涘缓闊宠壊锛涢渶鍏堢瓟瀵广€屾ā鍨嬫巿鏉冮獙璇併€嶇殑闂銆傗殸 涓嬭浇婧愬湪鍥藉唴鍙兘鐩磋繛涓嶄簡锛?*鍙兘闇€瑕侀瓟娉?*銆?/div>
					</div>
					<div class="btn-row">
						<button class="btn ripple" :disabled="clonePicking" @click="doPickVoice">{{ clonePicking ? "閫夋嫨涓€? : (cloneFileName || "閫夋嫨闊抽鏂囦欢") }}</button>
						<button class="btn ripple primary" :disabled="!cloneFileName || cloneCreating" @click="doCreateClone">{{ cloneCreating ? "鍒涘缓涓€? : "鍒涘缓鍏嬮殕闊宠壊" }}</button>
					</div>
					<div class="hint">寤鸿闊抽锛?0~20 绉掞紝鈮?0MB锛學AV/MP3/M4A锛屾棤鑳屾櫙闊充箰</div>
					<div v-if="cloneFileName" class="hint">宸查€? {{ cloneFileName }}{{ cloneFileSize ? ` (${fmtSize(cloneFileSize)})` : "" }}</div>
					<div v-if="cloneMsg" class="hint" :class="{ok: cloneMsgOk, bad: !cloneMsgOk}">{{ cloneMsg }}</div>
					<div v-if="cloneStatusText" class="hint" :class="{ok: cloneStatusOk, bad: !cloneStatusOk}">{{ cloneStatusText }}</div>
					<div class="tts-sec-title">浣欓鏌ヨ</div>
					<div class="bal-grid">
						<div class="bal-item">
							<div class="bal-name">鍗冮棶 CosyVoice</div>
							<div class="bal-value" :class="{loading: balCosyLoading}">{{ balCosyLoading ? "鏌ヨ涓€? : (balCosy || "鏈煡璇?) }}</div>
						</div>
						<div class="bal-item">
							<div class="bal-name">DeepSeek</div>
							<div class="bal-value" :class="{loading: balDsLoading}">{{ balDsLoading ? "鏌ヨ涓€? : (balDs || "鏈煡璇?) }}</div>
						</div>
					</div>
					<div class="bal-btns">
						<button class="mini ripple" :disabled="balCosyLoading" @click="queryCosyBalance">鏌ヨ鍗冮棶浣欓</button>
						<button class="mini ripple" :disabled="balDsLoading" @click="queryDeepSeekBalance">鏌ヨ DeepSeek</button>
					</div>
					<div class="hint">鍗冮棶/DashScope 瀹樻柟鏈紑鏀句綑棰濇煡璇㈡帴鍙ｏ紝鑻ユ彁绀轰笉鍙敤璇峰埌鍗冮棶鎺у埗鍙拌处鍗曢〉鏌ョ湅</div>
					<div v-if="balMsg" class="hint" :class="{ok: balMsgOk, bad: !balMsgOk}">{{ balMsg }}</div>
				</div>
				</template>

				<div class="tts-sec" v-if="cfg.ttsProvider === 'fish'">
					<div class="tts-sec-title">浣欓鏌ヨ</div>
					<div class="bal-grid">
						<div class="bal-item">
							<div class="bal-name">Fish Audio</div>
							<div class="bal-value" :class="{loading: balFishLoading}">{{ balFishLoading ? "鏌ヨ涓€? : (balFish || "鏈煡璇?) }}</div>
						</div>
						<div class="bal-item">
							<div class="bal-name">DeepSeek</div>
							<div class="bal-value" :class="{loading: balDsLoading}">{{ balDsLoading ? "鏌ヨ涓€? : (balDs || "鏈煡璇?) }}</div>
						</div>
					</div>
					<div class="bal-btns">
						<button class="mini ripple" :disabled="balFishLoading" @click="queryFishBalance">鏌ヨ Fish Audio</button>
						<button class="mini ripple" :disabled="balDsLoading" @click="queryDeepSeekBalance">鏌ヨ DeepSeek</button>
					</div>
					<div class="hint">Fish Audio 鐢ㄤ笂闈㈣处鎴烽厤缃? DeepSeek 鐢ㄨ亰澶╄缃噷鐨?API Key</div>
					<div v-if="balMsg" class="hint" :class="{ok: balMsgOk, bad: !balMsgOk}">{{ balMsg }}</div>
				</div>

				<div class="tts-sec">
					<div class="tts-sec-title">鎿嶄綔</div>
					<div class="btn-row">
						<button class="btn ripple" :disabled="ttsTesting" @click="doTestTTS">{{ ttsTesting ? "娴嬭瘯涓€? : "娴嬭瘯骞惰瘯鍚? }}</button>
						<button class="btn ripple" v-if="speaking" @click="stopTTS()">鍋滄鏈楄</button>
					</div>
					<button class="btn ripple primary" @click="saveSettingsNow">淇濆瓨璁剧疆</button>
					<div v-if="ttsMsg" class="hint" :class="{ok: ttsMsgOk, bad: !ttsMsgOk}">{{ ttsMsg }}</div>
				</div>
			</div>
		</div>
		</Transition>

		<transition name="sheet">
			<div v-if="panel && panel !== 'touch' && panel !== 'tts'" class="sheet-mask" @click.self="panel = ''">
				<div class="sheet" :class="{'diary-sheet': panel === 'diary', 'focus-sheet': panel === 'pomo' || panel === 'pomoStats'}">
					<div class="sheet-head" :class="{'settings-sheet-head': panel === 'settings'}">
						<span class="sheet-title">{{ panelTitle(panel) }}</span>
						<div v-if="panel === 'settings'" class="settings-bgm-player" :class="{ 'is-playing': bgmCanSkip }">
							<span class="settings-bgm-copy">
								<b>{{ bgmQuickTrack }}</b>
								<small>{{ bgmQuickStatus }}</small>
							</span>
							<span class="settings-bgm-icon" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
							<button class="settings-bgm-control" type="button" :aria-label="bgmQuickActionLabel" :title="bgmQuickActionLabel" @click="onBgmQuickToggle"><span aria-hidden="true">{{ bgmState === 'missing' && cfg.bgmEnabled ? '鈫? : cfg.bgmEnabled ? '鈪? : '鈻? }}</span></button>
							<button class="settings-bgm-control settings-bgm-next" type="button" aria-label="鎹竴棣? title="鎹竴棣? :disabled="!bgmCanSkip" @click="onBgmNext">鈴?/button>
						</div>
						<button class="x" :aria-label="'鍏抽棴'" @click="panel = ''">鉁?/button>
					</div>
					<div class="sheet-body">
						
						<template v-if="panel === 'model'">
							<div v-if="listError" class="empty">{{ listError }}</div>
							<div v-else-if="!modelList.length" class="empty">姝ｅ湪鑾峰彇妯″瀷鍒楄〃鈥?/div>
							<div v-else class="grid">
								<div v-for="m in modelList" :key="m.id" class="mc" :class="{on: m.id === currentModelId}" @click="pick(m.id)">
									<div class="thumb"><img :src="coverUrl(m.id)" @error="hideThumb" /></div>
									<div class="mname">{{ m.name }}</div>
								</div>
							</div>
						</template>

						
						<template v-else-if="panel === 'motion'">
							<div v-if="!motions.length" class="empty">鏆傛棤鍔ㄤ綔</div>
							<div v-for="g in motions" :key="g.group" class="grp">
								<div class="grp-name">{{ g.group }}</div>
								<div class="chips">
									<button v-for="(n, i) in g.names" :key="n" class="chip ripple" @click="doMotion(g.group, i)">{{ n }}</button>
								</div>
							</div>
						</template>

						
						<template v-else-if="panel === 'expression'">
							<div v-if="!expressions.length" class="empty">鏆傛棤琛ㄦ儏</div>
							<div class="chips">
								<button class="chip w ripple" @click="l2d.stopExpression()">娓呴櫎</button>
								<button v-for="n in expressions" :key="n" class="chip ripple" @click="l2d.playExpression(n)">{{ n }}</button>
							</div>
						</template>

						
						<DiaryPanel v-else-if="panel === 'diary'" :config="cfg" :chat-busy="chatStreaming || touchStreaming" @notify="triggerBubble($event)" />

						
						<!-- 璁板繂搴?(浜岀骇鑿滃崟: 鐩爣 / 闀挎湡璁板繂 / 鍘嗗彶鎬荤粨 涓変唤鍐呭閮芥敹鍦ㄨ繖閲? -->
						<template v-else-if="panel === 'memories'">
							<!-- C: 椤堕儴缁熻琛?鈥斺€?涓€鐪肩湅鍒?鏈夋病鏈変綔搴?鏀惰捣/鍒犻櫎鐨勬潯鐩?(鐢ㄦ埛涓ゆ娌℃壘鍒板叆鍙? 鐢ㄨ繖涓В鍐冲彲鍙戠幇鎬? -->
							<div class="mem-stats">
								闀挎湡 {{ nonGoalMemories.length }} 路 鐩爣 {{ goals.length }} 路 宸蹭綔搴?{{ invalidMems.length }} 路 宸叉敹璧?{{ fadedMems.length }} 路 宸插垹闄?{{ deletedMems.length }}
							</div>
							<div v-if="!memSearch && !memFilter">
								<!-- 闄潃浣犵殑浜嬶紙鐩爣锛夆€斺€?浠庝竴绾ц缃〉鎼繘鏉?-->
								<div class="mem-sec">
									<div class="mem-sec-title">闄潃浣犵殑浜嬶紙鐩爣锛?template v-if="goals.length">锛坽{ goals.length }}锛?/template></div>
									<div v-if="!goals.length" class="hint">璁颁笅涓€涓洰鏍囷紝Nori 姣忛殧鍑犲ぉ浼氳嚜鐒跺湴闂棶杩涘睍</div>
									<div v-for="g in goals" :key="g.id" class="mem-item">
										<span class="mem-tag src" :class="{inferred: isInferred(g)}" :title="PROV_TIP">{{ memProvenance(g) }}</span>
										<span class="mem-text">馃幆 {{ g.content }}</span>
										<button class="mem-op" @click="doRemoveGoal(g.id)">鍒犻櫎</button>
									</div>
									<div class="goal-add">
										<input v-model="goalDraft" placeholder="濡傦細鑰冮泤鎬?7 鍒?/ 鍧氭寔璺戞" spellcheck="false" @keyup.enter="doAddGoal" />
										<button class="mini ripple" @click="doAddGoal">璁颁笅鐩爣</button>
									</div>
								</div>
								<!-- 鍘嗗彶鎬荤粨 鈥斺€?鍚屾牱浠庝竴绾ч〉鎼繘鏉?-->
								<div class="mem-sec">
									<div class="mem-sec-title">鍘嗗彶鎬荤粨锛坽{ memView.summaries.length }} 鏉★級</div>
									<div v-if="!memView.summaries.length" class="hint">
										鏆傛棤鎬荤粨銆傚璇濆浜嗕箣鍚庝細鑷姩鎶婃棭鏈熷璇濆帇缂╂垚鎽樿
									</div>
									<details v-for="s in memView.summaries" :key="s.id" class="mem-summary">
										<summary>{{ summaryLabel(s) }}</summary>
										<div class="mem-summary-content">{{ s.content }}</div>
									</details>
								</div>
							</div>
							<div class="mem-search-row">
								<input v-model="memSearch" class="mem-search-input" placeholder="鎼滅储璁板繂鍐呭鈥? spellcheck="false" />
								<select v-model="memFilter" class="mem-search-sel">
									<option value="">鍏ㄩ儴绫诲瀷</option>
									<option value="goal">馃幆 鐩爣</option>
									<option v-for="(lb, k) in TYPE_LABELS" :key="k" :value="k">{{ lb }}</option>
									<option value="pinned">馃搶 宸插浐瀹?/option>
								</select>
							</div>
							<div class="mem-count-hint">闀挎湡璁板繂 {{ filteredMems.length }} 鏉?template v-if="memSearch || memFilter">锛堢瓫閫夌粨鏋滐級</template></div>
							<!-- 銆屽緟鏁寸悊 N 鏉°€?P4): 璁?杩樻病杩涜蹇?杩欎欢浜嬪彲瑙?鈥斺€?鍚﹀垯鐢ㄦ埛璇村畬涓€鍙?							     浼氫互涓烘病璁颁綇 (瀹炴椂閫氶亾榛樿鍏充箣鍚庡挨鍏堕渶瑕佽繖涓氦浠?銆?							     A+B (2026-09-27 娣卞, 瀹炴満鍙嶉"鐐逛簡娌＄敤"): 鍙嶉**灏卞湴**鏄剧ず鍦ㄦ寜閽梺杈?
							     娌℃湁鍙暣鐞嗗唴瀹规椂鎸夐挳缃伆 + 鏂囨璇存竻, 涓嶅啀"鍙偣浣嗘棤浜嬪彂鐢?銆?-->
							<div class="mem-pending">
								<span v-if="memPending.pending > 0">寰呮暣鐞?{{ memPending.pending }} 鏉★紙婊?{{ memPending.threshold }} 鏉¤嚜鍔ㄦ暣鐞嗭級</span>
								<span v-else>寰呮暣鐞?0 鏉?路 鏈€杩?20 鍙ヨ繕鍦ㄦ垜鐪煎墠锛屾敀澶?25 鍙ヤ細鑷姩鏁寸悊</span>
								<button class="mini ripple" :disabled="memOrganizing || !canOrganize" @click="doOrganizeNow">{{ memOrganizing ? "鏁寸悊涓€? : (canOrganize ? "绔嬪嵆鏁寸悊" : "鏆傛棤鍙暣鐞?) }}</button>
							</div>
							<div v-if="memOrgMsg" class="hint mem-org-msg" :class="{ok: memOrgMsgOk, bad: !memOrgMsgOk}">{{ memOrgMsg }}</div>
							<div v-if="!filteredMems.length" class="empty">娌℃湁鍖归厤鐨勮蹇?/div>
							<!-- 璁板繂搴撲富瑙嗗浘 (P4): **鎸夊潡**鎺掓椂闂寸嚎 (涓€娆″巻鍙叉€荤粨瑕嗙洊鐨勪竴娈靛璇?= 涓€涓潡),
							     鍧楀唴鍐?*鎸夌被鍨嬪垎灏忚妭** 鈥斺€?涓婂崐鍙ユ槸鍧? 涓嬪崐鍙ユ部鐢ㄧ敤鎴疯鐨勭被鍨嬪垎缁勩€?							     鎼滅储/绛涢€夋椂閫€鍥炴寜绫诲瀷骞抽摵 (瑙?memSections) -->
							<div v-for="sec in memSections" :key="sec.key" class="mem-sec" :class="{ 'mem-block': sec.key !== 'flat' }">
								<div v-if="sec.title" class="mem-sec-title">{{ sec.title }}</div>
								<div v-for="sub in sec.subs" :key="sub.key" class="mem-sec mem-group">
									<div class="mem-sec-title sub">{{ sub.label }}锛坽{ sub.items.length }}锛?/div>
									<div v-for="m in sub.items" :key="m.id" class="mem-item">
										<span class="mem-tag src" :class="{inferred: isInferred(m)}" :title="PROV_TIP">{{ memProvenance(m) }}</span>
										<span class="mem-text">
											<span v-if="(m.tags ?? []).includes('goal')" class="mem-ico" title="鐩爣">馃幆</span>
											<span v-if="(m.tags ?? []).includes('pinned')" class="mem-ico" title="宸插浐瀹?>馃搶</span>
											{{ m.content }}
										</span>
										<span class="mem-sub">{{ fmtTs(m.createdAt) }} 路 閲嶈搴?{{ m.importance.toFixed(2) }}<template v-if="m.decayDays == null"> 路 涓嶆贰蹇?/template></span>
										<button class="mem-op" @click="doTogglePin(m)">{{ isPinnedId(m.id) ? "鍙栨秷鍥哄畾" : "鍥哄畾" }}</button>
										<button class="mem-op" title="鏆傛椂鍋滅敤骞朵繚鐣欙紱鎵嬪姩鏀惰捣鍚庨渶鐐广€岀暀涓嬨€嶆仮澶? @click="doFadeMemory(m)">鏀惰捣</button>
										<button class="mem-op danger" @click="doDeleteMemory(m)">鍒犻櫎</button>
									</div>
								</div>
							</div>
							<!-- 宸蹭綔搴熺殑璁板繂 (B1 璁板繂绾犳): 琚悗鏉ヨ鐨勮瘽鍙栦唬鐨勬棫璇存硶涓嶅啀娉ㄥ叆/鍙洖,
							     浣嗙暀鍦ㄥ簱閲屽瓨妗? 鐐瑰紑灏辫兘杩樺師 鈥斺€?鍒ら敊鐨勪唬浠蜂粠"姘镐箙涓?闄嶅埌"鐐逛竴涓?銆?							     C: 娌℃湁浣滃簾鏉℃椂涔熺暀涓€琛岀伆瀛楁彁绀? 璁╄繖涓姛鑳?*鍙** (鍚﹀垯鐢ㄦ埛鎵句笉鍒?銆?-->
							<details v-if="invalidMems.length && !memSearch && !memFilter" class="mem-sec mem-invalid">
								<summary class="mem-sec-title">宸蹭綔搴燂紙{{ invalidMems.length }}锛?/summary>
								<div class="hint">杩欎簺鏃ц娉曞凡琚綘鍚庢潵鐨勮瘽鍙栦唬锛孨ori 涓嶄細鍐嶇敤锛涘垽閿欎簡灏辩偣銆岃繕鍘熴€?/div>
								<div v-for="m in invalidMems" :key="m.id" class="mem-item">
									<span class="mem-text">{{ m.content }}</span>
									<span class="mem-sub">浣滃簾浜?{{ fmtTs(m.invalidAt ?? 0) }}</span>
									<button class="mem-op" @click="doRestoreInvalid(m)">杩樺師</button>
								</div>
							</details>
							<!-- C: 绌烘€佷篃鐣欎竴琛? 璁?鏀瑰彛浼氳繘鍘嗗彶"杩欎欢浜嬪彲瑙?-->
							<div v-else-if="!memSearch && !memFilter" class="mem-invalid-empty">
								宸蹭綔搴燂紙0锛壜?浣犳敼鍙ｆ椂鏃ц娉曚細鐣欏湪杩欓噷锛岄殢鏃惰兘杩樺師
							</div>
							<!-- 宸叉敹璧?(2026-09-28, 鐢ㄦ埛鐨?鏆傛椂鏀惰捣"): 鍒版湡/澶箙娌℃彁鐨勬潯鐩嚜鍔ㄦ敹鍦ㄨ繖閲屻€?							     涓庛€屽凡浣滃簾銆嶇殑鍖哄埆: 浣滃簾=琚柊璇存硶鍙栦唬; 鏀惰捣=涓嶅啀閲嶈, 浣嗗畠**鍙兘杩樻槸鐪熺殑**銆?							     涓嶆敞鍏ャ€佷笉鍙洖, 浣嗙偣銆岀暀涓嬨€嶅氨鑳芥斁鍥炵敓鏁?鈥斺€?鑷姩璺緞姘镐笉鐪熷垹銆?-->
							<details v-if="fadedMems.length && !memSearch && !memFilter" class="mem-sec mem-faded">
								<summary class="mem-sec-title">宸叉敹璧凤紙{{ fadedMems.length }}锛?/summary>
								<div class="hint">鏀惰捣琛ㄧず鏆傛椂涓嶇敤锛屽唴瀹逛粛淇濈暀銆傛墜鍔ㄦ敹璧烽渶鐐广€岀暀涓嬨€嶆仮澶嶏紱鑷姩鏀惰捣鍙湪浣犱箣鍚庨噸鏂版槑纭彁鍙婃椂鎭㈠銆?/div>
								<div v-for="m in fadedMems" :key="m.id" class="mem-item">
									<span class="mem-text">{{ m.content }}</span>
									<span class="mem-sub">{{ fadeReasonLabel(m) }} 路 鏀惰捣浜?{{ fmtTs(m.fadedAt ?? 0) }}</span>
									<button class="mem-op" @click="doRestoreFaded(m)">鐣欎笅</button>
								</div>
							</details>
							<!-- 宸插垹闄?(2026-09-28, 鍥炴敹绔?: 鎵嬪垹鐨勬潯鐩甫鍐呭鐣欏湪杩欓噷, 鍙繕鍘? 纭涓嶈鍐嶃€屾案涔呭垹闄ゃ€?-->
							<details v-if="deletedMems.length && !memSearch && !memFilter" class="mem-sec mem-deleted">
								<summary class="mem-sec-title">宸插垹闄わ紙{{ deletedMems.length }}锛?/summary>
								<div class="hint">鍒犻櫎鍚庡仠姝娇鐢紝鏃у璇濅笉浼氶噸鏂拌鍥炪€傚洖鏀剁珯鏈€澶氱暀 20 鏉★紱杩樺師淇濈暀鍒犻櫎鍓嶇姸鎬併€傛案涔呭垹闄ょЩ闄ゅ洖鏀剁珯鏉＄洰锛屼笉娓呴櫎鍘熻亰澶╂垨宸叉湁瀵煎嚭銆?/div>
								<div v-for="m in deletedMems" :key="m.id" class="mem-item">
									<span class="mem-text">{{ m.content }}</span>
									<span class="mem-sub">鍒犻櫎浜?{{ fmtTs(m.deletedAt ?? 0) }}</span>
									<button class="mem-op" @click="doRestoreDeleted(m)">杩樺師</button>
									<button class="mem-op danger" @click="doDeleteForever(m)">姘镐箙鍒犻櫎</button>
								</div>
							</details>
							<!-- 璁板繂浼樺寲 (2026-09-28, 鐢ㄦ埛鎻愮殑"鏁寸悊浼樺寲"): 浠?*浣犵暀涓嬬殑/鍒犳帀鐨?*璁板繂閲屽鍙ｅ懗,
							     鎶婄ず渚嬪啓杩涙暣鐞嗘彁绀鸿瘝銆傞粯璁ゅ叧 鈥斺€?鏃╂湡搴撻噷鑻ユ湁鍨冨溇, 瀛﹁繘鍘讳細鎶婇鍛冲浐鍖栥€?-->
							<div v-if="!memSearch && !memFilter" class="mem-sec mem-tune">
								<div class="mem-sec-title">璁板繂浼樺寲</div>
								<div class="row-inline">
									<label>鑷姩浼樺寲锛堟瘡鏂板 20 鏉¤蹇嗗埛鏂扮ず渚嬶級</label>
									<input type="checkbox" v-model="cfg.memoryAutoTuneExamples" />
								</div>
								<div class="hint">{{ tuneInfo }}</div>
								<div class="btn-row mem-tune-btns">
									<button class="mini ripple" @click="doRebuildExamples">绔嬪嵆浼樺寲</button>
									<button class="mini ripple" @click="tuneShow = !tuneShow">{{ tuneShow ? "鏀惰捣绀轰緥" : "鏌ョ湅绀轰緥" }}</button>
									<button class="mini ripple" :disabled="!tuneHas" @click="doClearExamples">娓呴櫎绀轰緥</button>
								</div>
								<div v-if="tuneShow && tuneHas" class="hint mem-tune-detail">
									<div v-if="tunePos.length">璇ヨ锛歿{ tunePos.join(" / ") }}</div>
									<div v-if="tuneNeg.length">涓嶈璁帮細{{ tuneNeg.join(" / ") }}</div>
									<div class="mem-sub">鈥?鍙槸椋庢牸绀轰緥锛屼笉杩涘璇濅笂涓嬫枃锛屽彧鍦ㄦ暣鐞嗘椂鍙戠粰妯″瀷</div>
								</div>
								<div v-else-if="tuneShow" class="hint">杩樻病鏈夌ず渚?鈥斺€?鐐广€岀珛鍗充紭鍖栥€嶇敓鎴愪竴浠斤紙璁板繂澶皯鏃朵細鍏堣烦杩囷級</div>
							</div>
							<!-- A3 (2026-10-08): 璁板繂鍋ュ悍 + **娉ㄥ叆鍙鎬?* 鈥斺€?鎶?濂规€庝箞绐佺劧璁板緱 / 涓嶈寰?浠庣寽鍙樻垚鍙煡銆?							     璁℃暟閮ㄥ垎**涓嶄緷璧?*璇婃柇寮€鍏?(闅忔椂鍙); 娉ㄥ叆**鏄庣粏**鎵嶉渶瑕佹墦寮€寮€鍏?							     (鏄庣粏鍚綘鐨勫師璇濅笌璁板繂鍐呭, 涓庢暣鐞嗚瘖鏂悓涓€闅愮鍙ｅ緞)銆?-->
							<div class="mem-sec mem-health">
								<div class="mem-sec-title">璁板繂鍋ュ悍</div>
								<div class="hint">
									鐢熸晥 <b>{{ health.active }}</b> 路 宸叉敹璧?{{ health.faded }} 路 宸蹭綔搴?{{ health.invalid }} 路 搴撻噷鍏?{{ health.total }} 鏉?									锛堝巻鍙叉€荤粨 {{ health.summaries }} 鏉?路 璁板繂鍧?{{ health.blocks }} 涓?路 鍥炴敹绔?{{ health.deleted }} 鏉★級
								</div>
								<div class="hint">
									鏈€杩戜繚瀛樻憳瑕侊細<b>{{ fmtWhen(health.lastSummaryAt) }}</b>
									<span v-if="health.lastPersistError" class="bad"> 路 {{ health.lastPersistError }}</span>
									<template v-if="health.lastOrganize">
										路 鏈杩愯鏈€鍚庝竴娆℃暣鐞嗭細<b :class="{bad: health.lastOrganize?.ok === false}">{{ /閮ㄥ垎瀹屾垚/.test(health.lastOrganize?.note ?? "") ? "閮ㄥ垎瀹屾垚" : health.lastOrganize?.ok ? "鎴愬姛" : "澶辫触" }}</b><template v-if="health.lastOrganize?.note">锛坽{ health.lastOrganize?.note }}锛?/template>
									</template>
									<template v-else>路 鏈杩愯杩樻病鏁寸悊杩?/template>
								</div>
								<div class="hint">涓婁竴杞敞鍏ワ細{{ injectSummary }}</div>
								<div v-if="(health.lastInject?.hits?.length ?? 0) > 0" class="mem-inject-hits">
									<div v-for="h in (health.lastInject?.hits ?? [])" :key="h.id" class="mem-inject-hit">
										<span class="mem-inject-score">{{ h.s.toFixed(2) }}</span>
										<span class="mem-inject-type">{{ h.t }}</span>
										<span class="mem-inject-text">{{ h.c }}</span>
										<span v-if="h.kw" class="mem-inject-kw" title="闈犲叧閿瘝/鍒悕鍛戒腑">鍒悕</span>
									</div>
								</div>
								<div v-else-if="health.lastInject" class="hint">涓婁竴杞?*涓€鏉￠兘娌℃敞鍏?*锛氭鏂囦笌鍒悕閮芥病鍛戒腑锛屾垨搴撻噷娌℃湁鐢熸晥璁板繂</div>
								<div class="btn-row mem-diag-btns">
									<button class="mini ripple" :disabled="injectN === 0" @click="doExportInject">瀵煎嚭娉ㄥ叆璁板綍</button>
								</div>
								<div class="hint mem-sub">鈥?娉ㄥ叆鏄庣粏鍚綘鐨勫師璇濅笌璁板繂鍐呭锛屽鍑哄悗璇风暀鎰忔枃浠跺幓鍚?/div>
							</div>
							<!-- 璁板繂璇婃柇 (P1銆岃娴嬮棴鐜€? 2026-09-30): 鎺掓煡"濂逛负浠€涔堣浣忎簡 / 涓轰粈涔堟病璁颁綇"鐢ㄣ€?							     榛樿鍏? 鎵撳紑鍚庢瘡娆℃暣鐞嗗湪**鍐呭瓨**閲岀暀涓€鏉¤瘉鎹?鎻愮ず璇?妯″瀷杈撳嚭/闂ㄦ鎸′笅鐨勬潯鐩?搴撶姸鎬?,
							     鐐广€屽鍑鸿蹇嗚瘖鏂€嶆墠钀界洏鍒?Download/NoriDroid/銆傞噸鍚?App 浼氭竻绌恒€?-->
							<div class="mem-sec mem-diag">
								<div class="mem-sec-title">璁板繂璇婃柇锛堟帓鏌ョ敤锛?/div>
								<div class="row-inline">
									<label>璁板綍鏁寸悊涓庢敞鍏ヨ繃绋嬶紙鏈€澶氭渶杩?{{ MAX_DIAG_RECORDS }} 娆★級</label>
									<input type="checkbox" v-model="cfg.memoryDiagnostics" @change="onDiagToggle" />
								</div>
								<div class="hint">
									鎵撳紑鍚庢瘡娆℃暣鐞嗕細鐣欎笅璇佹嵁锛氬杺缁欐ā鍨嬬殑鎻愮ず璇嶃€佹ā鍨嬪師璇濄€侀棬妲涙尅涓嬩簡浠€涔堛€佸簱閲岀幇鍦ㄥ灏戞潯銆?									宸茶褰?<b>{{ diagN }}</b> 娆★紱鍙湪鍐呭瓨閲岋紝閲嶅惎灏辨竻绌猴紝鎵€浠ュ鍑鸿鍦ㄥ悓涓€娆￠噷鍋氥€?								</div>
								<div class="btn-row mem-diag-btns">
									<button class="mini ripple" :disabled="diagN === 0" @click="doExportDiag">瀵煎嚭璁板繂璇婃柇</button>
									<button class="mini ripple" :disabled="diagN === 0" @click="doClearDiag">娓呯┖璁板綍</button>
								</div>
								<div class="hint mem-sub">鈥?璁板綍閲屽惈浣犵殑鍘熻瘽涓庤蹇嗗唴瀹癸紙璇婃柇蹇呴』濡傛锛夛紝瀵煎嚭鍚庤鐣欐剰鏂囦欢鍘诲悜</div>
							</div>
							<!-- C: 鎿嶄綔鎸夐挳澶嶅埗鍒拌蹇嗗簱椤?鈥斺€?鍘熸潵鍙湪璁剧疆涓€绾ч〉鐨勩€岃蹇嗙郴缁熴€嶅潡閲?
							     鐢ㄦ埛涓ゆ閮芥病鎵惧埌 (瀵煎嚭鎵句笉鍒板氨鏄瘉鎹?銆傘€屾竻绌恒€嶄粛鍙暀鍦ㄤ竴绾ч〉 (鐮村潖鎬ф搷浣滀笉閲嶅鍏ュ彛) -->
							<div class="btn-row mem-btns mem-btns-bottom">
								<button class="mini ripple" @click="doExportAll">瀵煎嚭</button>
								<button class="mini ripple" @click="doPruneMemories">娓呯悊浣庨璁板繂锛?0澶╂湭鎻愶級</button>
								<button class="mini ripple" @click="doRestoreMemory" :disabled="!hasBackup">鎾ら攢涓婃娓呯悊</button>
							</div>
							<div v-if="memPruneMsg" class="hint" :class="{ok: memPruneMsgOk, bad: !memPruneMsgOk}">{{ memPruneMsg }}</div>
						</template>

						
						<template v-else-if="panel === 'pomo'">
                            <PomodoroPanel :config="pomoCfg" :phase="pomo.phase" :paused="pomo.paused" :time="pomoFmt" :percent="pomoPct" :phase-text="pomoPhaseText"
                                :end-text="pomoEndText" :goal="pomo.goal || ''" :session-id="pomo.sessionId || ''" :rounds="pomo.rounds || 0" :long-every="pomo.longEvery || pomoCfg.longEvery" :cycle-enabled="pomo.phase === 'idle' ? pomoCfg.cycleEnabled : !!pomo.cycleEnabled"
                                :saved-min="pomoSummary.todayMin" :live-min="pomoLiveMin" :done="pomoSummary.todayDone" :streak="pomoSummary.streak" :ready="pomoStatsReady" :busy="pomoBusy"
                                :error="pomoError || pomoConfigError" :message="pomoMessage" :sync-text="pomoSyncText" :reminder-text="pomoReminderText" :reminder-action="pomoReminderAction"
                                :quiet-held="pomoQuietHeld" :reboot-pending="!!pomo.rebootPending" :bars="pomoWeekBars" :restore-preview="pomoRestorePreview" :confirm-stop="pomoConfirmEnd"
                                @action="pomoAction" @reminder="pomoReminderSettings" @export="pomoExport" />
                        </template>
						<template v-else-if="panel === 'pomoStats'">
							<div class="pomo-stats-toolbar"><button class="mini" @click="panel = 'pomo'">鈥?杩斿洖璁℃椂</button><span>{{ pomoStatsReady ? '姣忎竴娈靛姫鍔涳紝閮界畻鏁? : '璁板綍鏆備笉鍙敤' }}</span></div>
                            <div v-if="pomoError" class="hint">{{ pomoError }} <button class="mini" @click="pomoRefresh()">閲嶈瘯</button></div>
                            <template v-if="pomoStatsReady">
                            <div class="pomo-range"><button v-for="r in ([7,30,365] as const)" :key="r" class="pomo-rbtn" :class="{on: pomoRange === r}" @click="pomoRange = r">{{ r === 365 ? '杩戜竴骞? : `杩?${r} 澶ー }}</button></div>
                            <div class="pomo-range-overview"><b>{{ pomoRangeSummary.rangeMin }}<small> 鍒嗛挓</small></b><span>瀹屾垚 {{ pomoRangeSummary.rangeDone }} 涓?路 鍗曟棩鏈€浣?{{ pomoRangeSummary.rangeBest }} 鍒嗛挓</span></div>
                            <div v-if="pomoRange <= 30" class="pomo-bars pomo-selectable-bars" :class="{dense: pomoRange === 30}"><button v-for="d in pomoRangeBars" :key="d.day" class="pb-col" :aria-label="`${d.day}锛?{d.min} 鍒嗛挓`" @click="pomoSelectDate(d.day)"><i :style="{height: d.h + '%'}"></i><span>{{ d.label }}</span></button></div>
                            <div v-if="pomoSummary.todayRate >= 0" class="pomo-sub">浠婃棩鍊掕鏃跺畬鎴愮巼 {{ Math.round(pomoSummary.todayRate * 100) }}%<span v-if="pomoSummary.todayAvgMin > 0">骞冲潎瀹屾垚娈?{{ pomoSummary.todayAvgMin }} 鍒嗛挓</span></div>
                            <!-- 鐙珛缁熻椤? 涓€骞寸儹鍔涘浘 (鐐规牸瀛愮湅鏌愬ぉ) + 缁堣韩绱 + 鏈堝害姹囨€?-->
							<div class="settings-row">
								<label>杩戜竴骞?/label>
								<!-- 52 鍒?脳 11px 鈮?572px, 姣旈潰鏉?绾?260px)瀹?鈫?蹇呴』鏀惧彲妯粴瀹瑰櫒閲?
								     鍚﹀垯浼氭孩鍑洪潰鏉裤€俢anvas 鐢ㄥ儚绱犲昂瀵哥粯鍒? 涓嶉殢瀹瑰櫒缂╂斁銆?-->
								<div class="pomo-heat-wrap">
									<canvas
										ref="pomoHeatCanvas"
										class="pomo-heat"
										@click="onHeatClick"
									></canvas>
								</div>
								<div class="pomo-heat-legend">
									<span class="mh-label">灏?/span>
									<i v-for="lv in [1, 2, 3, 4]" :key="lv" :class="'mh-lv' + lv"></i>
									<span class="mh-label">澶?/span>
								</div>
								<div class="hint" v-if="!pomoSelectedDay">鐐逛换鎰忔牸瀛愭煡鐪嬮偅涓€澶╃殑涓撴敞鎯呭喌銆?/div>
								<label class="pomo-date-picker">閫夋嫨鏃ユ湡<input type="date" :max="pomoDayKey(pomoDate)" @change="pomoSelectDate(($event.target as HTMLInputElement).value)" /></label>
								<div class="pomo-daybox" v-if="pomoSelectedDay">
									<b>{{ pomoSelectedDay.date }}</b>
									<span>{{ pomoSelectedDay.min }} 鍒嗛挓 路 瀹屾垚 {{ pomoSelectedDay.done }} 路 涓柇 {{ pomoSelectedDay.abort }}</span>
								</div>
							</div>
							<div class="settings-row">
								<label>绱</label>
								<span class="pomo-today">
									鎬讳笓娉?{{ fmtTotalMin((pomoStats.total?.focusMin || 0) + (pomoStats.total?.countUpMin || 0)) }}
									路 瀹屾垚 {{ pomoStats.total?.done || 0 }} 涓?									<span v-if="(pomoStats.total?.countUpMin || 0) > 0"> 路 鍏朵腑姝ｅ悜 {{ fmtTotalMin(pomoStats.total?.countUpMin || 0) }}</span>
								</span>
								<div class="pomo-sub">
									<span>鏈€濂界殑涓€澶?{{ Math.round(pomoStats.best?.dayMin || 0) }} 鍒嗛挓</span>
									<span>鏈€闀胯繛缁?{{ pomoStats.best?.streak || 0 }} 澶?/span>
								</div>
							</div>
							<div class="settings-row">
								<label>杩?12 涓湀</label>
								<div class="pomo-months">
									<div v-for="m in pomoMonths" :key="m.month" class="pm-row">
										<span class="pm-name">{{ m.month.slice(2) }}</span>
										<span class="pm-bar"><i :style="{width: monthPercent(m.min, pomoMonths) + '%'}"></i></span>
										<span class="pm-val">{{ m.min }} 鍒?路 {{ m.done }} 涓?/span>
									</div>
								</div>
							</div>
							<div class="hint">鏈夋晥涓撴敞璁板綍闀挎湡淇濈暀銆傛€讳笓娉ㄥ寘鍚€掕鏃朵笌姝ｅ悜璁℃椂锛屼笉鍖呭惈浼戞伅銆?/div>
                            </template>
						</template>
						<template v-else-if="panel === 'settings'">
							<div class="settings-shell">
								<div class="settings-tabs" role="tablist" aria-label="璁剧疆绾у埆">
									<button type="button" role="tab" :aria-selected="settingsTab === 'basic'" :class="{active: settingsTab === 'basic'}" @click="settingsTab = 'basic'">鍩虹璁剧疆</button>
									<button type="button" role="tab" :aria-selected="settingsTab === 'advanced'" :class="{active: settingsTab === 'advanced'}" @click="settingsTab = 'advanced'">杩涢樁璁剧疆</button>
								</div>
								<button v-if="settingsTab === 'basic'" class="settings-intro-entry settings-basic-intro btn ripple intro-open" @click="introOpen">
									<span class="settings-intro-copy"><b>鏂版墜鏁欑▼ / 鑷磋阿</b><small>蹇€熶簡瑙?Nori 鐨勫姛鑳藉拰璁剧疆</small></span>
									<span class="settings-entry-arrow" aria-hidden="true">鈫?/span>
								</button>
								<div v-if="settingsTab === 'basic'" class="settings-basic-grid">
									<div class="settings-basic-column">
									<section class="settings-basic-group settings-basic-group-connection">
										<div class="settings-basic-heading"><h3>杩炴帴</h3><small>{{ modelReady ? '宸查厤缃? : '寰呴厤缃? }}</small></div>
										<div class="settings-row">
											<label>API Base URL</label>
											<input v-model="cfg.baseUrl" type="text" spellcheck="false" autocomplete="off" />
										</div>
										<div class="settings-row">
											<label>API Key</label>
											<input v-model="cfg.apiKey" type="text" autocomplete="off" spellcheck="false" />
										</div>
										<div class="settings-row">
											<label>妯″瀷</label>
											<div class="model-pick">
												<select v-model="cfg.model">
													<option value="" disabled>鈥?閫夋嫨妯″瀷 鈥?/option>
													<option v-for="md in modelOptions" :key="md" :value="md">{{ md }}</option>
												</select>
												<button class="mini ripple" @click="refreshModels">鍔犺浇妯″瀷</button>
											</div>
											<div v-if="modelLoadMsg" class="hint">{{ modelLoadMsg }}</div>
										</div>
									</section>
									<section class="settings-basic-group settings-basic-group-display">
										<div class="settings-basic-heading"><h3>鏄剧ず娓呮櫚搴?/h3></div>
										<div class="settings-row">
											<label>娓叉煋鍒嗚鲸鐜?{{ renderScaleNum.toFixed(1) }}x锛堝師鐢?{{ nativeDpr.toFixed(1) }}x锛?/label>
											<input type="range" min="0.5" max="3.0" step="0.1" v-model.number="cfg.renderScale" @change="applyRenderScale" />
											<div class="hint">瓒婇珮瓒婃竻鏅般€佽秺鑰楃數锛涜皟鍒板師鐢熸竻鏅板害鍙幏寰楁渶娓呮鐨勬樉绀恒€?/div>
										</div>
									</section>
									<section class="settings-basic-group settings-basic-group-music">
										<div class="settings-basic-heading"><h3>鑳屾櫙闊充箰</h3><small>{{ bgmState === 'ready' ? '璧勬簮宸插氨缁? : bgmState === 'downloading' ? `涓嬭浇涓?${bgmPct}%` : '棣栨鎾斁闇€涓嬭浇' }}</small></div>
										<div class="settings-row">
											<label>鎾斁鏇茬洰</label>
											<div class="model-pick">
												<select :value="cfg.bgmTrack" @change="onBgmTrackChange"><option value="random">闅忔満鎾斁</option><option v-for="t in BGM_TRACKS" :key="t.id" :value="t.id">{{ t.name }}</option></select>
												<button class="mini ripple" :disabled="!bgmCanSkip" @click="onBgmNext">鎹竴棣?/button>
											</div>
										</div>
										<div class="settings-row">
											<label>闊抽噺 {{ Math.round((Number(cfg.bgmVolume) || 0) * 100) }}%</label>
											<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.bgmVolume" @input="onBgmVolume" @change="persistSettings" />
										</div>
										<button v-if="bgmState === 'missing'" class="mini ripple" @click="onBgmDownload">涓嬭浇鑳屾櫙闊充箰璧勬簮</button>
										<button v-else-if="bgmState === 'downloading'" class="mini ripple" disabled>姝ｅ湪涓嬭浇 {{ bgmPct }}%</button>
									</section>
									<section class="settings-basic-group settings-basic-group-float">
										<div class="settings-basic-heading"><h3>鎮诞绐?/h3></div>
										<div class="settings-row">
											<div class="row-inline"><label>绂诲紑搴旂敤鍚庢樉绀烘偓娴獥 Nori</label><input type="checkbox" v-model="cfg.floatEnabled" @change="onFloatToggle" /></div>
											<div class="hint">{{ floatPermissionHint }}</div>
											<button class="mini ripple" @click="resetFloatWindow">閲嶇疆鎮诞绐椾綅缃拰澶у皬</button>
										</div>
									</section>
									<section class="settings-basic-group settings-basic-group-font">
										<div class="settings-basic-heading"><h3>鐣岄潰瀛椾綋</h3></div>
										<div class="settings-row">
											<div class="pomo-range">
												<button
													v-for="o in UI_FONT_OPTIONS" :key="o.value"
													class="pomo-rbtn" :class="{on: uiFontNow === o.value}"
													:style="{fontFamily: uiFontPreviewFamily(o.value)}"
													@click="setUiFont(o.value)"
												>{{ o.label }}</button>
											</div>
											<div class="hint">{{ uiFontHint }}</div>
											<div class="hint">缂哄瓧锛圙B2312 涔嬪鐨勭敓鍍诲瓧锛変細鑷姩鍥炶惤绯荤粺瀛椾綋锛涗袱涓瓧浣撻兘闅忓寘锛屾棤闇€鑱旂綉涓嬭浇</div>
										</div>
									</section>
									</div>
									<div class="settings-basic-column">
									<section class="settings-basic-group settings-basic-group-persona">
										<div class="settings-basic-heading"><h3>浜鸿涓庤闊?/h3></div>
										<div class="settings-row">
											<label>浜鸿鏂囨锛堟彁绀鸿瘝锛?/label>
											<div class="row-inline">
												<button class="mini ripple" @click="doImportPersona">瀵煎叆鏂囦欢</button>
												<button class="mini ripple" :disabled="!personaCustom" @click="doResetPersona">娓呴櫎鑷畾涔?/button>
											</div>
											<div class="hint">{{ personaStateText }}</div>
											<div v-if="personaMsg" class="hint" :class="{ok: personaMsgOk, bad: !personaMsgOk}">{{ personaMsg }}</div>
										</div>
										<div class="settings-row">
											<div class="row-inline"><label>瀹樻柟浜鸿</label><button class="mini ripple" :disabled="personaDlBusy" @click="openPersonaGate">{{ personaDlBusy ? "涓嬭浇涓€? : "涓嬭浇瀹樻柟浜鸿" }}</button></div>
											<div v-if="personaDlMsg" class="hint" :class="{ok: personaDlOk, bad: !personaDlOk}">{{ personaDlMsg }}</div>
										</div>
										<div class="settings-row settings-tts-entry">
											<button class="settings-entry-button ripple" @click="openPanel('tts')">
												<span class="settings-entry-icon" aria-hidden="true">鈼?/span>
												<span class="settings-entry-copy"><b>璇煶鍚堟垚</b><small>閰嶇疆鏈楄鏈嶅姟銆侀煶鑹蹭笌璇曞惉</small></span>
												<span class="settings-entry-arrow" aria-hidden="true">鈫?/span>
											</button>
										</div>
									</section>
									<section class="settings-basic-group settings-basic-group-preferences">
										<div class="settings-basic-heading"><h3>鏃ュ父鍋忓ソ</h3></div>
										<div class="settings-row">
											<div class="row-inline"><label>鍔ㄦ€佽儗鏅紙鏁版嵁娴凤級</label><input type="checkbox" v-model="cfg.dataseaBg" @change="onDataseaBgToggle" /></div>
										</div>
										<div class="settings-row">
											<div class="row-inline"><label>璁?Nori 鐭ラ亾鏃堕棿</label><input type="checkbox" v-model="cfg.timeAware" @change="persistSettings" /></div>
										</div>
										<div class="settings-row">
											<label>瀹夐潤妯″紡</label>
											<div class="model-pick"><select v-model="cfg.quietMode" @change="onQuietModeChange"><option value="off">鍏抽棴</option><option value="auto">鑷姩锛堟瘡鏃?23:00鈥撴鏃?8:00锛?/option><option value="manual">鎵嬪姩</option></select></div>
											<div v-if="cfg.quietMode === 'manual'" class="row-inline"><label>绔嬪嵆闈欓煶</label><input type="checkbox" v-model="cfg.quietOn" @change="onQuietToggle" /></div>
										</div>
										<div class="settings-row">
											<div class="row-inline"><label>Nori 涓诲姩鎼瘽</label><input type="checkbox" v-model="cfg.ambientEnabled" @change="onAmbientToggle" /></div>
										</div>
									</section>
									<section class="settings-basic-group settings-basic-group-touch">
										<div class="settings-basic-heading"><h3>鎽稿ご涓庤嚜瀹氫箟瑙︽懜</h3></div>
										<div class="settings-row">
											<div class="hint">璁剧疆鎽稿ご鍙嶉锛屾垨涓哄綋鍓嶆ā鍨嬮厤缃Е鎽稿尯鍩熴€?/div>
											<button class="mini ripple" @click="openPanel('touch')">鎵撳紑浜掑姩璁剧疆</button>
										</div>
									</section>
									<section class="settings-basic-group settings-basic-group-memory">
										<div class="settings-basic-heading"><h3>鏁版嵁涓庤蹇?/h3></div>
										<div class="settings-row">
											<label>鏁版嵁鐩綍</label><div class="hint ok">{{ storagePath }}</div>
										</div>
										<div class="settings-row">
											<div class="row-inline"><label>鎵€鏈夋枃浠惰闂潈闄恵{ allFilesAccess ? '锛堝凡鎺堟潈锛? : '锛堟湭鎺堟潈锛? }}</label><button class="mini ripple" @click="doRequestAllFiles">鍘绘巿鏉?/button></div>
										</div>
										<div class="settings-row">
											<label>闀挎湡璁板繂涓庡巻鍙叉憳瑕?/label>
											<!-- 鍩虹璁剧疆椤电殑鍏ュ彛璧?*鐩磋繛**锛堜笉鐪嬩篃蹇点€屽缇炪€嶅彴璇嶏紝涓€涓嬪嵆杩涳級銆?											     杩涢樁璁剧疆閲岄偅涓?.mem-enter 鎵嶄繚鐣欎笁涓嬫嫤闂ㄣ€傝繖涓笉瀵圭О鏄?2026-10-25
											     浜у搧瀹氳皟鐨勭粨鏋滐紙"缁曡繃灏辫"锛夛細鍩虹椤垫槸鏃ュ父椤烘墜鍏ュ彛锛屽埆褰?bug 琛ユ嫤闂ㄣ€?-->
											<button class="mini ripple" @click="openPanel('memories')">鎵撳紑璁板繂搴?路 {{ nonGoalMemories.length + goals.length }} 鏉?/button>
										</div>
									</section>
									</div>
								</div>
								<template v-else>
									<header class="settings-overview settings-advanced-overview">
										<div class="settings-overline">NORI CONTROL DECK</div>
										<nav class="settings-jumps" aria-label="璁剧疆鍒嗗尯">
											<a href="#settings-connection">杩炴帴</a>
											<a href="#settings-display">鏄剧ず</a>
											<a href="#settings-storage">瀛樺偍</a>
											<a href="#settings-sound">澹伴煶</a>
											<a href="#settings-memory">璁板繂</a>
											<a href="#settings-window">绐楀彛</a>
										</nav>
									</header>
								<details id="settings-connection" class="settings-section">
										<summary><span><b>杩炴帴涓庢ā鍨?/b><small>閰嶇疆 API 鍦板潃銆佸瘑閽ュ拰妯″瀷</small></span><i aria-hidden="true"></i></summary>
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
								<label>妯″瀷</label>
								<div class="model-pick">
									<select v-model="cfg.model">
										<option value="" disabled>鈥?閫夋嫨妯″瀷 鈥?/option>
										<option v-for="md in modelOptions" :key="md" :value="md">{{ md }}</option>
									</select>
									<button class="mini ripple" @click="refreshModels">鍔犺浇妯″瀷</button>
								</div>
								<div v-if="modelLoadMsg" class="hint">{{ modelLoadMsg }}</div>
							</div>
								</div>
							</details>

							<details id="settings-display" class="settings-section">
								<summary><span><b>鏄剧ず涓庢€ц兘</b><small>璋冩暣姘旀场闃呰浣撻獙鍜?Live2D 娴佺晠搴?/small></span><i aria-hidden="true"></i></summary>
								<div class="settings-section-body">
							<div class="settings-row">
								<label>姘旀场瀛椾綋 {{ bubbleScaleNum.toFixed(2) }}锛堟帹鑽?1.00锛?/label>
								<input type="range" min="0.7" max="1.8" step="0.05" v-model.number="cfg.bubbleScale" />
							</div>
							<div class="settings-row">
								<label>姘旀场瀹藉害 {{ bubbleWidthNum }}%锛堟帹鑽?82%锛?/label>
								<input type="range" min="55" max="95" step="1" v-model.number="cfg.bubbleWidth" />
								<div class="hint">瓒婄獎锛屾瘡琛屽瓧鏁拌秺灏戯紝鏍囩偣鏇村鏄撳崟鐙垚琛岋紱瑙夊緱鍙ュ彿/闂彿钀藉崟灏辫皟瀹戒竴鐐?/div>
							</div>
							<div class="settings-row">
								<label>娓叉煋甯х巼涓婇檺 {{ l2dFpsNum === 0 ? "涓嶉檺鍒? : `${l2dFpsNum} fps` }}锛堝舰璞?+ 鑳屾櫙锛?/label>
								<div class="pomo-range">
									<button
										v-for="v in L2D_FPS_OPTIONS" :key="v"
										class="pomo-rbtn" :class="{on: l2dFpsNum === v}"
										@click="setL2dFps(v)"
									>{{ l2dFpsLabel(v) }}</button>
								</div>
								<div class="hint">
									Live2D 褰㈣薄涓庢暟鎹捣鑳屾櫙姣忕鏈€澶氶噸缁樺嚑娆★紙涓よ€呭悓姝ワ紱鎮诞绐椾篃璺熼殢杩欎釜妗ｄ綅锛夈€?20Hz 灞忚 60 鐪佷竴鍗婏紱
									30/20/15 鏇寸渷鐢典絾鍔ㄤ綔涓庤儗鏅細鐣ヨ烦銆?0Hz 灞忓彧鏈夎鍒颁綆浜?60 鎵嶆湁鍖哄埆銆傞€夈€屼笉闄愩€嶆仮澶嶅師鏉ョ殑琛屼负
								</div>
							</div>
									</div>
								</details>

								<details id="settings-storage" class="settings-section">
									<summary><span><b>鏁版嵁涓庡瓨鍌?/b><small>鏌ョ湅鏂囦欢浣嶇疆鍜岃闂潈闄?/small></span><i aria-hidden="true"></i></summary>
									<div class="settings-section-body">
							<div class="settings-row">
								<label>鑱婂ぉ璁板綍瀛樺偍浣嶇疆</label>
								<!-- 2026-10-02 鏇存: 鍐欏湪**鍏叡涓嬭浇鐩綍**閲岀殑鏂囦欢锛堣亰澶?璁板繂/鏃ヨ锛夊嵏杞藉悗涓€鑸粛鍦紙绯荤粺涓嶆寜搴旂敤绉佹湁鏁版嵁娓呯悊锛夛紱
								     鐜板湪娓呭崟閲屽姞浜?hasFragileUserData, 鍗歌浇鏃朵細璇㈤棶鏄惁淇濈暀涓嬪簲鐢ㄦ暟鎹?(鍕鹃€夋墠淇濈暀)銆?-->
								<div class="hint ok">鍏叡涓嬭浇鐩綍锛歿{ storagePath }}锛堥噸瑁呭悗鑻ュ唴瀹逛笉瑙佷簡锛岃涓嬫柟銆屽瓨鍌ㄨ嚜妫€銆嶏級</div>
								<div class="row-inline">
									<label>鎵€鏈夋枃浠惰闂潈闄恵{ allFilesAccess ? "锛堝凡鎺堟潈 鉁擄級" : "锛堟湭鎺堟潈锛? }}</label>
									<button class="mini ripple" @click="doRequestAllFiles">鍘绘巿鏉?/button>
								</div>
								<div class="hint">
									鐢ㄤ簬璇诲啓 {{ storagePath }} 閲岀殑鏁版嵁鏂囦欢銆?b>鍗歌浇閲嶈鍚庡師鏈夊唴瀹硅涓嶅埌锛屽氨鏄洜涓烘病鏈夊畠</b>锛?									Android 11+ 璧凤紝鍒殑搴旂敤锛堟垨鏈簲鐢ㄦ棫瀹炰緥锛夊啓杩涘叕鍏变笅杞界洰褰曠殑鏂囦欢锛屾湰搴旂敤鏃㈠湪濯掍綋搴撻噷鐪嬩笉瑙併€佷篃涓嶈兘鐩存帴璇汇€?									鎺堜簣鍚庤繑鍥炴湰椤电偣銆岃嚜妫€銆嶏紝浼氭樉绀恒€屾墍鏈夋枃浠惰闂潈闄? 鏄€嶄笖鍐呭琚鍥炪€?								</div>
								<div class="row-inline">
									<label>瀛樺偍鑷锛堣涓嶅埌鏁版嵁鏃剁偣涓€涓嬶級</label>
									<button class="mini ripple" @click="doStorageProbe">鑷</button>
								</div>
								<pre v-if="storageProbeMsg" class="store-probe">{{ storageProbeMsg }}</pre>
								<div class="hint">鍒楀嚭鍏叡鐩綍閲屽埌搴曟湁娌℃湁鏂囦欢銆丮ediaStore 鏄惁鍙銆佽兘鍚︾洿璇?鈥斺€?鍗歌浇閲嶈鍚庢帓鏌?鍘熸湁鍐呭璇讳笉鍒?鐢?/div>
							</div>
									</div>
								</details>

								<details id="settings-sound" class="settings-section">
									<summary><span><b>澹伴煶涓庨櫔浼?/b><small>鑳屾櫙闊充箰銆侀煶鏁堝拰涓诲姩浜掑姩</small></span><i aria-hidden="true"></i></summary>
									<div class="settings-section-body">
							<div class="settings-row mem-block">
								<label>鑳屾櫙闊充箰</label>
								<div class="mem-sec">
									<div class="mem-sec-title mem-sec-title-row">
										<span>NoriOS 瀹樻柟 OST{{ bgmNowName ? ` 路 姝ｅ湪鎾斁锛?{bgmNowName}` : "" }}</span>
										<label class="bgm-toggle">
											<input type="checkbox" :checked="cfg.bgmEnabled" @change="onBgmToggle" /> 寮€鍚?										</label>
									</div>
									<div class="model-pick">
										<select :value="cfg.bgmTrack" @change="onBgmTrackChange">
											<option value="random">闅忔満鎾斁</option>
											<option v-for="t in BGM_TRACKS" :key="t.id" :value="t.id">{{ t.name }}</option>
										</select>
										<button v-if="cfg.bgmEnabled && bgmState === 'ready'" class="mini ripple" @click="onBgmNext">鎹竴棣?/button>
									</div>
									<div class="hint">
										{{ bgmState === "ready" ? "璧勬簮宸插氨缁紝闅忓紑鍏虫挱鏀? : bgmState === "downloading" ? `璧勬簮鍖呬笅杞戒腑 ${bgmPct}%` : "闊抽璧勬簮鏈笅杞斤紙绾?13MB锛岄娆￠渶鑱旂綉锛? }}
									</div>
									<button
										v-if="bgmState !== 'ready'"
										class="mini ripple"
										:disabled="bgmState === 'downloading'"
										@click="onBgmDownload"
									>{{ bgmState === "downloading" ? `涓嬭浇涓?${bgmPct}%` : "涓嬭浇鑳屾櫙闊充箰璧勬簮" }}</button>
									<button v-else class="mini ripple" @click="onBgmRedownload">閲嶆柊涓嬭浇</button>
									<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.bgmVolume" @input="onBgmVolume" @change="persistSettings" />
									<div class="hint">闊抽噺鐙珛浜庢湕璇昏闊筹紝榛樿 35% 涓嶇洊 Nori 璇磋瘽锛涘惊鐜挱鏀撅紝閫€鍚庡彴鑷姩鏆傚仠</div>
								</div>
							</div>
							<div class="settings-row">
								<label>鎸夐敭闊虫晥闊抽噺 {{ Math.round((Number(cfg.sfxVolume) || 0) * 100) }}%锛?% = 鍏抽棴锛?/label>
								<input type="range" min="0" max="1" step="0.01" v-model.number="cfg.sfxVolume" @input="onSfxVolume" @change="persistSettings" />
								<div class="hint">鐐瑰嚮搴曢儴鍔熻兘鎸夐挳鏃剁殑鎻愮ず闊?/div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>闊虫晥鏂囦欢</label>
									<button class="mini ripple" :disabled="sfxBusy" @click="doDownloadSfx">{{ sfxBtnText }}</button>
								</div>
								<div class="hint" :class="{ok: sfxMsgOk, bad: sfxMsgBad}">{{ sfxMsg }}</div>
								<div class="hint">闊虫晥涓嶅啀鎵撹繘瀹夎鍖咃紙鍖呮洿灏忥級锛岃繖閲岀偣涓€娆′笅鍒版湰鏈猴紝涔嬪悗涓€鐩寸敤鏈湴鐨勶紱娌′笅杞芥椂鎸夐敭闊充笌鐣寗閽熼煶鏁堥潤闊充絾涓嶆姤閿?/div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>鍔ㄦ€佽儗鏅紙鏁版嵁娴凤級</label>
									<input type="checkbox" v-model="cfg.dataseaBg" @change="onDataseaBgToggle" />
								</div>
								<div class="hint">鏄熷皹銆佹槦浜戝厜鏂戜笌缃戞牸鐨勭▼搴忔覆鏌擄紝鍑犱箮闆跺紑閿€锛涘叧闂悗鍥炲埌绾壊鑳屾櫙</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>璁?Nori 鐭ラ亾鏃堕棿</label>
									<input type="checkbox" v-model="cfg.timeAware" @change="persistSettings" />
								</div>
								<div class="hint">鍙戦€佹椂鎻愪緵璁惧鏃堕棿涓庡綋鍓嶆椂娈碉紝璁╅棶鍊欏拰浣滄伅璇濋鏇磋创鍚堝綋涓嬶紝骞跺尯鍒嗗巻鍙插璇濈殑鏃堕棿銆傝纭繚鎵嬫満鏃堕棿銆佹椂鍖烘纭€?/div>
							</div>
							<div class="settings-row">
								<label>瀹夐潤妯″紡</label>
								<div class="model-pick">
									<select v-model="cfg.quietMode" @change="onQuietModeChange">
										<option value="off">鍏抽棴</option>
										<option value="auto">鑷姩锛堟瘡鏃?23:00鈥撴鏃?8:00锛?/option>
										<option value="manual">鎵嬪姩</option>
									</select>
								</div>
								<div v-if="cfg.quietMode === 'manual'" class="row-inline">
									<label>绔嬪嵆闈欓煶</label>
									<input type="checkbox" v-model="cfg.quietOn" @change="onQuietToggle" />
								</div>
								<div class="hint">寮€鍚悗 Nori 涓嶄富鍔ㄦ惌璇濄€丅GM 鏆傚仠锛涗綘鍙戞秷鎭ス鐓у父鍥炲锛圱TS 鏈楄涓庢寜閿煶淇濈暀锛?/div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>Nori 涓诲姩鎼瘽</label>
									<input type="checkbox" v-model="cfg.ambientEnabled" @change="onAmbientToggle" />
								</div>
								<div class="hint">瀹夐潤鍑犲垎閽熷悗锛屽ス鍙兘浼氳交杞昏涓€鍙ワ紙鏈湴璇枡闆?token銆佷笉杩涜亰澶╄褰曪紱姣忔浼氳瘽鏈€澶氬嚑鏉★級锛涘畨闈欐ā寮忓紑鍚椂涓嶇敓鏁?/div>
							</div>
									</div>
								</details>

								<details id="settings-memory" class="settings-section">
									<summary><span><b>璁板繂涓庝簰鍔?/b><small>璁板繂绛栫暐銆佽〃鎯呴┍鍔ㄥ拰澶撮儴璺熼殢</small></span><i aria-hidden="true"></i></summary>
									<div class="settings-section-body">
							<div class="settings-row">
								<div class="row-inline">
									<label>鍛戒腑鍖哄煙璋冭瘯锛堟祴璇曠敤锛?/label>
									<input type="checkbox" v-model="hitDebug" />
								</div>
								<div class="hint">寮€鍚悗灞忓箷椤堕儴鏄剧ず褰撳墠瑙︽懜鍛戒腑鐨勫尯鍩燂紙瀹炰綋/鐣欑櫧锛変笌鎶氭懜杩涘害锛堝銆屾姎鎽?0.4/1.0s 路 瀹屾垚 2 路 閫熷害 0.42銆嶏級锛岀敤浜庨獙璇佹懜澶翠綅缃垽瀹氫笌"瀹屾垚涓€娆?鐨勬椂鏈猴紱鏄剧ず"寮傚父"璇存槑鍛戒腑缁勪欢鍑洪敊锛堜細闄勫師鍥狅級锛涙寮忎娇鐢ㄥ彲鍏抽棴</div>
							</div>
							<div class="settings-row mem-block">
								<label>璁板繂绯荤粺</label>
								<!-- 璁板繂搴撳叆鍙?(2026-09-26 鐢ㄦ埛瑕佹眰): 鍘熸潵鎶?鐩爣 / 闀挎湡璁板繂 / 鍘嗗彶鎬荤粨"涓変唤
								     鍒楄〃**瑁搁湶鍦ㄤ竴绾ц缃〉**閲? 鍙堥暱鍙堝緱寰€涓嬫粴; 鐜板湪鏀惰繘浜岀骇鑿滃崟 (panel === 'memories'),
								     杩欓噷鍙暀鍏ュ彛 + 涓嬮潰閭ｄ簺寮€鍏?鎿嶄綔鎸夐挳銆傚垪琛ㄦ湰韬湪璁板繂搴撻〉閲屾洿鍏?(甯︽悳绱?绛涢€?鏃堕棿涓庨噸瑕佸害)銆?-->
								<!-- 鐐硅繖閲屽厛缁欏弽搴?(姘旀场 + 鏈楄), 绗笁涓嬫墠鐪熺殑杩涘幓 鈥斺€?瑙?onMemEntryTap銆?								     鈿?鍙湁**杩涢樁璁剧疆**杩欎釜鍏ュ彛杩樺甫涓変笅鎷﹂棬; 鍩虹璁剧疆椤甸偅涓洿杩炲叆鍙ｆ槸鏈夋剰缁曡繃鐨?								     (2026-10-25 浜у搧瀹氳皟)锛屼袱杈逛笉瀵圭О涓嶆槸 bug銆?-->
								<button class="mini ripple mem-enter" @click="onMemEntryTap">
									璁板繂搴?路 鐩爣 / 闀挎湡璁板繂 / 鍘嗗彶鎬荤粨锛坽{ nonGoalMemories.length + goals.length }} 鏉★級 鈥?								</button>
								<div class="row-inline">
									<label>鎽樿鍚庤嚜鍔ㄨ鍓棫鑱婂ぉ璁板綍</label>
									<input type="checkbox" v-model="cfg.trimHistory" />
								</div>
								<div class="hint">寮€鍚悗, 宸插帇缂╃殑鏃ф秷鎭細浠庤亰澶╄褰曚腑绉婚櫎锛堟憳瑕佷粛淇濈暀锛夛紝閬垮厤鑱婂ぉ璁板綍鏃犻檺鑶ㄨ儉</div>
								<div class="row-inline">
									<label>鐢?AI 鎻愬彇涓庢暣鐞嗚蹇嗭紙鏇村噯锛屾帹鑽愬紑鍚級</label>
									<input type="checkbox" v-model="cfg.memoryLlmExtract" />
								</div>
								<div class="hint">鍘嗗彶鎬荤粨鏃剁敱 AI 椤烘墜鎸戝嚭璇ヨ鐨勪俊鎭紙闂茶亰銆佹彁闂€佹儏缁笉璁帮級锛屽苟鑷姩鍚堝苟閲嶅銆佷綔搴熻鏀瑰彛鐨勬棫璇存硶銆備笌鎽樿鍏辩敤鍚屼竴娆¤皟鐢紝涓嶉澶栬姳 token锛涘叧闂悗鍙潬鍏抽敭璇嶈鍒欒锛岃寰楀皯</div>
								<div class="row-inline">
									<label>姣忔潯娑堟伅閮界珛鍗虫彁鍙栬蹇嗭紙鏃х殑瀹炴椂閫氶亾锛岄粯璁ゅ叧闂級</label>
									<input type="checkbox" v-model="cfg.memoryRealtimeExtract" />
								</div>
								<div class="hint">鍏抽棴鏃讹細璁板繂鍦ㄥ巻鍙叉€荤粨鏃朵竴娆℃暣鐞嗭紙鏈€澶氭櫄鍑犲崄鏉℃秷鎭紝浣嗚皟鐢ㄩ噺灏戜竴涓暟閲忕骇锛屾敼鍙ｄ篃涓嶄細璁伴敊锛夈€傚紑鍚椂锛氭瘡鍙ラ兘鍙兘澶氳姳 1~2 娆″皬璋冪敤锛屼粎渚涘嚭闂鏃跺鐓ф帓閿?/div>
								<div class="row-inline">
									<label>鐢?AI 璇箟鍙洖璁板繂锛堟帹鑽愬紑鍚級</label>
									<input type="checkbox" v-model="cfg.smartRecall" />
								</div>
								<div class="hint">瀵硅瘽鍓嶇敤 AI 鍒ゆ柇鍝簺璁板繂鐪熸鐩稿叧锛堚€滈偅涓父鎴忊€濃啋 璁板緱浣犲枩娆㈢帺鍘熺锛夛紝姣旂函鍏抽敭璇嶅噯寰楀锛涙瘡娆″璇濆涓€娆″皬璋冪敤锛屼粙鎰?token 鍙叧</div>
								<div class="btn-row mem-btns">
									<button class="mini ripple" @click="doPruneMemories">娓呯悊浣庨璁板繂锛?0澶╂湭鎻愶級</button>
									<button class="mini ripple" @click="doClearMemory">娓呯┖鍏ㄩ儴璁板繂</button>
									<button class="mini ripple" @click="doRestoreMemory" :disabled="!hasBackup">鎾ら攢涓婃娓呯悊</button>
									<button class="mini ripple" @click="doExportAll">瀵煎嚭</button>
								</div>
								<div v-if="memPruneMsg" class="hint" :class="{ok: memPruneMsgOk, bad: !memPruneMsgOk}">{{ memPruneMsg }}</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>AI 琛ㄦ儏鏍囪锛堟帹鑽愬紑鍚級</label>
									<input type="checkbox" v-model="cfg.emotionLlm" />
								</div>
								<div class="hint">鍥炲鏈熬闄勫甫銆愯〃鎯呫€戙€愬姩浣溿€戞爣璁帮紝鐢?AI 鍒ゆ柇骞跺嵆鏃堕┍鍔ㄨ〃鎯?鍔ㄤ綔锛涘叧闂垯鐢ㄥ叧閿瘝瑙勫垯銆傛爣璁颁笉鏄剧ず銆佷笉鏈楄锛屽嚑涔庝笉澧炲姞 token</div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>DeepSeek 鎬濊€冩ā寮?/label>
									<input type="checkbox" v-model="cfg.deepseekThinking" />
								</div>
								<div class="hint">璁?DeepSeek 鍏堟€濊€冨啀鍥炵瓟锛堟洿鎱€佹洿璐?token锛夛紱浠呭 DeepSeek 绔偣鐢熸晥锛岄粯璁ゅ紑鍚紝鍏虫帀鍗虫樉寮忓叧闂?/div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>澶撮儴璺熼殢 路 宸﹀彸鍙嶅悜</label>
									<input type="checkbox" v-model="cfg.lookFlipX" />
								</div>
								<div class="row-inline">
									<label>澶撮儴璺熼殢 路 涓婁笅鍙嶅悜</label>
									<input type="checkbox" v-model="cfg.lookFlipY" />
								</div>
								<label>澶撮儴璺熼殢鐏垫晱搴?{{ Number(cfg.lookSens).toFixed(2) }}</label>
								<input type="range" min="0.1" max="0.5" step="0.05" v-model.number="cfg.lookSens" />
								<div class="hint">鎵嬫寚鏂瑰悜涓嶅灏卞嬀閫夊弽鍚戯紱璺熷緱澶倝鎴栧お璺冲氨璋冪伒鏁忓害锛堝彧褰卞搷鎽稿ご鏃剁殑璺熼殢绱ц嚧搴︼紱鏉炬墜鍚庢寜鍥哄畾鐨?杞绘嫧鎰?缂撶紦鍥炴锛屼笉闅忔妗ｄ綅鍙樺寲銆傛敼瀹岀偣淇濆瓨璁剧疆锛?/div>
							</div>
							<div class="settings-row">
								<div class="row-inline">
									<label>鍚敤 Live2D 鍙ｅ瀷</label>
									<input type="checkbox" v-model="cfg.lipSyncEnabled" @change="persistSettings" />
								</div>
								<div class="hint">榛樿鍏抽棴锛涘紑鍚悗鎸夊疄闄呮挱鏀鹃煶棰戞尟骞呴┍鍔ㄥ彛鍨嬶紝鏃犳硶鍙栧緱鍙潬鎸箙鏃朵繚鎸侀棴鍢?/div>
							</div>
									</div>
								</details>

								<details id="settings-window" class="settings-section">
									<summary><span><b>绐楀彛涓庢墜鍔?/b><small>鎺у埗鎮诞绐楀拰瑙︽懜琛屼负</small></span><i aria-hidden="true"></i></summary>
									<div class="settings-section-body">
							<div class="settings-row">
								<div class="row-inline">
									<label>绂诲紑搴旂敤鍚庢樉绀烘偓娴獥 Nori</label>
									<input type="checkbox" v-model="cfg.floatEnabled" @change="onFloatToggle" />
								</div>
								<div class="hint">寮€鍚悗锛屾寜 Home銆佸垏鍚庡彴鎴栭€€鍑哄簲鐢ㄦ椂锛孨ori 浼氱暀鍦ㄥ睆骞曚笂銆倇{ floatPermissionHint }}</div>
							</div>
							<div class="settings-row">
								<label>鎮诞绐楁覆鏌撳垎杈ㄧ巼 {{ Number(cfg.floatRenderScale).toFixed(1) }}x锛堟帹鑽?{{ nativeDpr.toFixed(1) }}x锛?/label>
								<input type="range" min="0.5" max="3.0" step="0.1" v-model.number="cfg.floatRenderScale" @change="onFloatRenderScale" />
								<div class="hint">娓叉煋鍒嗚鲸鐜囧悓涓?App锛岃秺楂樿秺娓呮櫚涔熻秺鑰楃數锛堟偓娴獥灏哄鐢ㄥ弻鎸囩缉鏀捐皟鑺傦紝鑷姩璁板繂锛?/div>
								<button class="btn ripple" @click="resetFloatWindow">閲嶇疆鎮诞绐椾綅缃拰澶у皬</button>
							</div>
							<div class="settings-row">
								<div class="row-inline label-only">鎮诞绐楄Е鎽告墜鍔?/div>
									<div class="hint">路 杞荤偣 Nori 韬綋 鈫?鎵撳紑鑱婂ぉ绐楀彛<br />路 鎸変綇骞剁Щ鍔?鈫?鐩存帴鎷栧姩妗屽疇锛屽厑璁告妸鐣欑櫧鍜岄儴鍒嗘ā鍨嬬Щ鍑哄睆骞?br />路 鍦ㄧ獥鍙ｅ唴鍙屾寚鎹忓悎 鈫?绛夋瘮璋冩暣澶у皬<br />路 鎷栧姩鍜岀偣鎸夐兘浼氶噸缃緟鏈鸿鏃?br />路 鑱婂ぉ绐楀彛锛氭嫋 鈮?鏍囬鏍忕Щ鍔紝鍙屾寚鎹忓悎缂╂斁锛岀偣閿佸舰鍥炬爣鍥哄畾浣嶇疆鍜屽ぇ灏忥紝鐐?脳 鍏抽棴<br />路 鍙湁鐐瑰嚮杈撳叆妗嗘墠鍞よ捣閿洏</div>
							</div>
									</div>
								</details>

								<details class="settings-section settings-actions">
									<summary><span><b>鏇村宸ュ叿</b><small>鍔ㄤ綔銆佽〃鎯呬笌澶栬宸ュ叿</small></span><i aria-hidden="true"></i></summary>
									<div class="settings-section-body">
										<button class="btn ripple" @click="openPanel('touch')">鎽稿ご涓庤嚜瀹氫箟瑙︽懜</button>
										<button class="btn ripple" @click="openPanel('motion')">鍔ㄤ綔鍒楄〃</button>
							<button class="btn ripple" @click="openPanel('expression')">琛ㄦ儏鍒楄〃</button>
							<button class="btn ripple" @click="toggleUiStyle">澶栬椋庢牸锛歿{ uiSoft ? "鏌斿拰闆鹃潰" : "娼睈鐜荤拑" }} 鈥?/button>
							<!-- 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 榛樿寮€锛涘叧鎺夊悗涓€涓姹傞兘涓嶅彂锛屽叧浜庨〉涔熶笉鏄剧ず浜烘暟 -->
							<div v-if="presenceReady" class="settings-row">
								<div class="row-inline"><label>鏄剧ず鍦ㄧ嚎浜烘暟锛堝尶鍚嶅績璺筹級</label><input type="checkbox" v-model="cfg.presenceEnabled" @change="onPresenceToggle" /></div>
								<div class="hint">鍖垮悕蹇冭烦锛氭瘡 5 鍒嗛挓涓婃姤涓€娆￠殢鏈哄畨瑁?ID 涓庡簲鐢ㄧ増鏈彿锛屼粎鐢ㄤ簬銆屾鍒诲湪绾?/ 浠婃棩鏉ヨ繃銆嶈鏁帮紱涓嶅惈璁惧鏍囪瘑涓庤亰澶╁唴瀹广€傚叧闂悗涓嶅啀鍙戦€佷换浣曡姹傘€?/div>
							</div>
									</div>
								</details>
								</template>

								<div class="settings-bottom-actions">
									<button class="btn ripple primary settings-save-button" @click="saveSettingsNow">淇濆瓨璁剧疆</button>
									<button class="settings-license-link mini ripple about-open" @click="openAboutPage">
										<span><b>寮€婧愯鍙?/ 鍏充簬 / 闅愮</b><small>NoriDroid 路 v{{ APP_VERSION }}</small></span>
										<span aria-hidden="true">鈫?/span>
									</button>
									<!-- 鍦ㄧ嚎浜烘暟锛?026-10-23 鐢ㄦ埛瑕佹眰锛? 鏀惧湪璁剧疆涓€绾ч〉銆佸紑婧愯鍙叆鍙ｄ笅鏂癸紝涓嶇敤鐐硅繘鍏充簬椤点€?									     鍙湁閰嶇疆浜嗚鏁版湇鍔℃椂鎵嶆樉绀猴紱鏈厤缃椂鏁村潡涓嶅嚭鐜般€?-->
									<div v-if="presenceReady" class="settings-presence">
										<span class="about-presence-dot" :class="presenceToneClass" aria-hidden="true"></span>
										姝ゅ埢鍦ㄧ嚎 <b>{{ presenceCount }}</b><template v-if="presenceToday"> 路 {{ presenceToday }}</template>
									</div>
									<div v-if="presenceReady" class="settings-presence-hint">{{ presenceStatus }}</div>
									<button v-if="presenceReady && presenceState && !presenceState.ok" class="mini ripple settings-presence-retry" @click="onPresenceRetry">绔嬪嵆閲嶈瘯</button>
								</div>
							</div>
						</template>
						<!-- 鍏充簬 / 闅愮 / 寮€婧愯鍙紙2026-10-02 鐢ㄦ埛瑕佹眰锛? 澶嶇敤鐜版湁 sheet 闈㈡澘锛堝叆鍙ｅ湪璁剧疆闈㈡澘閲岋級锛?						     鍥涘潡鍐呭缂轰竴涓嶅彲 鈥斺€?鐗堟湰+涓婃父澹版槑 / 闅愮璇存槑 / 寮€婧愯鍙?/ 鍙嶉娓犻亾銆?						     璁稿彲缁嗚妭涓庝箟鍔¤鏄庝互浠撳簱鏍?THIRD-PARTY.md 涓哄噯锛岃繖閲屽彧鏀捐鐐?+ 鎸囧悜瀹冦€?-->
						<template v-else-if="panel === 'about'">
							<div class="about-page">
								<!-- 鈶?鐗堟湰 + 涓婃父澹版槑 -->
								<div class="about-sec">
									<div class="about-h">鐗堟湰</div>
									<p class="about-p">NoriDroid <b>v{{ APP_VERSION }}</b>锛圓ndroid 妗屽疇锛欿otlin 澶栧３ + Vue 3 WebView 鍓嶇锛?/p>
									<p class="about-p">鏈」鐩?b>琛嶇敓鑷?/b> <button class="about-a" @click="openAboutUrl(UPSTREAM_REPO_URL)">erhiolab/DeepEr</button>锛屼笂娓镐互 <b>GPL-3.0</b> 鍙戝竷锛涙湰浠撳簱鏄?b>淇敼鐗?/b>锛堥噸鏋勩€佽蹇嗘ā鍧椼€佹偓娴獥銆佷竴閿厠闅嗙瓑鏀瑰姩锛夛紝鍚屾牱浠?<b>GPL-3.0</b> 鍙戝竷锛岃瑙佷粨搴撴牴鐨?LICENSE銆?/p>
									<p class="about-p">鏈」鐩粨搴擄細<button class="about-a" @click="openAboutUrl(REPO_URL)">{{ REPO_URL }}</button></p>
								</div>
								<!-- 鈶?闅愮璇存槑 -->
								<div class="about-sec">
									<div class="about-h">闅愮璇存槑</div>
									<p class="about-p">浼氳仈缃戝仛浠€涔堬細</p>
									<ul class="about-ul">
										<li>LLM 瀵硅瘽 鈥斺€?鎶婁綘鍙戠殑娑堟伅銆佷汉璁句笌鐩稿叧璁板繂鍙戝埌<b>浣犺嚜宸卞～鐨?/b> API 鍦板潃锛堥粯璁?DeepSeek 绛夛級锛屽洖澶嶄篃鐢卞畠杩斿洖</li>
										<li>TTS 鏈楄 鈥斺€?鎶婅鏈楄鐨勬枃鏈彂缁欎綘鍦ㄨ缃噷閫夌殑璇煶鏈嶅姟锛團ish Audio / 鍗冮棶锛?/li>
										<li>涓€閿厠闅?鈥斺€?鑱旂綉涓嬭浇鍙傝€冮煶棰戯紝骞舵妸瀹冧笂浼犵粰鍗冮棶鍋氶煶鑹插厠闅?/li>
										<li>璁剧疆閲岀殑銆屼笅杞介煶鏁堛€嶁€斺€?浠庣綉缁滀笅杞介煶鏁堟枃浠?/li>
										<li v-if="presenceReady">鍦ㄧ嚎浜烘暟 鈥斺€?鍖垮悕蹇冭烦锛氬彧涓婁紶<b>闅忔満瀹夎 ID + 搴旂敤鐗堟湰鍙?/b>锛?0 鍒嗛挓绐楀彛鍘婚噸銆佷粖鏃ユ寜鍖椾含鏃堕棿鍒囨棩锛夛紝涓嶅惈璁惧鏍囪瘑銆佽亰澶╁唴瀹规垨浠讳綍涓汉鏁版嵁锛涙湇鍔＄鍙瓨鍝堝笇锛孖P 浠呯敤浜庡唴瀛橀檺娴併€佷笉钀藉簱涔熶笉鎵撴棩蹇楋紱鍙湪璁剧疆閲屽叧闂?/li>
									</ul>
									<p class="about-p">闄ゆ涔嬪涓嶉噰闆嗐€佷笉涓婁紶浠讳綍鏁版嵁锛氭病鏈夌涓夋柟缁熻銆佹病鏈夊箍鍛娿€佹病鏈夊穿婧冧笂鎶?SDK锛汚PI Key 鍙瓨鍦ㄦ湰鏈鸿缃噷銆?/p>
									<p class="about-p">鏁版嵁瀛樺湪鍝細</p>
									<ul class="about-ul">
										<li>鑱婂ぉ璁板綍 / 璁板繂 / 鏃ヨ 鈫?<b>鍏叡涓嬭浇鐩綍</b> <code>Download/NoriDroid/</code>锛堣蛋绯荤粺濯掍綋搴撳啓鍏ワ紝鍒殑搴旂敤涔熺湅寰楀埌锛?/li>
										<li>浜鸿鏂囨湰 / 闊虫晥 / 鑳屾櫙闊充箰 / 妯″瀷缂撳瓨 鈫?<b>搴旂敤绉佹湁鐩綍</b>锛堝叾瀹冨簲鐢ㄨ涓嶅埌锛?/li>
									</ul>
									<p class="about-warn">鈿?鍗歌浇璇存槑锛?b>鍏叡涓嬭浇鐩綍閲岀殑鑱婂ぉ / 璁板繂 / 鏃ヨ鍗歌浇鍚庝竴鑸粛鍦?/b>锛堝畠浠洿鎺ュ啓鍦?<code>Download/NoriDroid/</code>锛岀郴缁熶笉浼氬綋鎴愬簲鐢ㄧ鏈夋暟鎹竻鎺夛紝閲嶈鍚庤繕鑳借鍒帮級锛涗絾<b>浜鸿銆佷笅杞界殑闊虫晥銆佹ā鍨嬬紦瀛樸€佸厠闅嗛煶鑹茶褰曞瓨鍦ㄥ簲鐢ㄧ鏈夌洰褰曪紝鍗歌浇浼氳娓呮帀</b>锛岄渶瑕侀噸鏂板鍏ユ垨涓嬭浇銆傜郴缁熻嫢鍦ㄥ嵏杞芥椂寮广€屾槸鍚︿繚鐣欏簲鐢ㄦ暟鎹€嶏紝鍕鹃€変繚鐣欐洿淇濋櫓銆?/p>
									<p class="about-p">鏉冮檺鐢ㄩ€旓細</p>
									<ul class="about-ul">
										<li><b>INTERNET</b> 鈥斺€?涓婇潰閭ｄ簺鑱旂綉鍔熻兘锛堝璇?/ 鏈楄 / 涓嬭浇锛?/li>
										<li><b>鎮诞绐?/b>锛圫YSTEM_ALERT_WINDOW锛夆€斺€?閫€鍑?App 鍚庤 Nori 鐣欏湪妗岄潰涓?/li>
										<li><b>閫氱煡</b>锛圥OST_NOTIFICATIONS锛夆€斺€?鐣寗閽熷埌鐐规彁閱?/li>
										<li><b>鎵€鏈夋枃浠惰闂?/b>锛圡ANAGE_EXTERNAL_STORAGE锛夆€斺€?璇诲啓鍏叡涓嬭浇鐩綍閲岀殑鑱婂ぉ / 璁板繂 / 鏃ヨ锛汚ndroid 11 璧锋病鏈夊畠灏辫涓嶅埌鏃ф暟鎹紙灏ゅ叾鏄嵏杞介噸瑁呬箣鍚庯級</li>
									</ul>
								</div>
								<!-- 鈶?寮€婧愯鍙?-->
								<div class="about-sec">
									<div class="about-h">寮€婧愯鍙?/div>
									<p class="about-p">闅忓寘鍒嗗彂鐨勭涓夋柟缁勪欢锛?/p>
									<ul class="about-ul">
										<li><b>Vue 3</b> 鈥斺€?MIT锛堝墠绔鏋讹級</li>
										<li><b>live2d-easy-control 1.0.3</b> 鈥斺€?MIT锛涙湰椤圭洰鐢?<code>scripts/patch-live2d.mjs</code> 瀵瑰畠<b>鎵撹繃琛ヤ竵锛堜慨鏀圭増锛?/b>锛屽師鐗堟潈涓庤鍙０鏄庝繚鐣欙紝鏈」鐩慨鏀圭殑閮ㄥ垎鍚屾牱鎸?GPL-3.0 鎻愪緵</li>
										<li><b>AndroidX / androidx.webkit</b> 鈥斺€?Apache-2.0锛圓ndroid 鏀寔搴擄級</li>
										<li><b>Kotlin stdlib</b> 鈥斺€?Apache-2.0锛圞otlin 鏍囧噯搴擄級</li>
										<li><b>闇為箿鏂囨シ LXGW WenKai</b> 路 <b>绔欓叿蹇箰浣?ZCOOL KuaiLe</b> 鈥斺€?<b>SIL OFL 1.1</b>锛堣缃?鈫?鍩虹璁剧疆閲岀殑鐣岄潰瀛椾綋锛夈€傞殢鍖呭垎鍙戠殑鏄?b>瀛愰泦</b>锛圙B2312 鍏ㄩ噺 + 鐣岄潰鐢ㄥ瓧锛岃 <code>scripts/subset-ui-fonts.py</code>锛夛紱璁稿彲鍏ㄦ枃鍦ㄤ粨搴?<code>src/assets/fonts/OFL-*.txt</code>銆侽FL 鍏佽鑷敱浼犳挱涓庡祵鍏ヨ蒋浠讹紝浣?b>涓嶅緱鍗曠嫭鍞崠瀛椾綋鏂囦欢</b>銆?/li>
										<li><b>Live2D Cubism Core</b>锛坙ive2dcubismcore.min.js锛夆€斺€?<b>涓撴湁璁稿彲</b>锛屼笉鏄紑婧愮粍浠躲€侰ore <b>鎸夊師鏍峰垎鍙戙€佷笉淇敼</b>锛屼篃<b>涓嶇疆浜庝細鍏佽绗笁鏂逛慨鏀圭殑寮€婧愯鍙箣涓?/b>锛涚増鏉冧笌璁稿彲澹版槑涓€寰嬩繚鐣欍€?/li>
									</ul>
									<p class="about-p">Live2D 涓撴湁杞欢璁稿彲鍗忚鍏ㄦ枃锛?/p>
									<button class="about-a ripple about-a-block" @click="openAboutUrl(LIVE2D_EULA_URL)">{{ LIVE2D_EULA_URL }}</button>
									<p class="about-p">涓嶉殢鍖呭垎鍙戯細浜鸿鏂囨湰銆侀煶鏁堛€佸弬鑰冮煶棰戙€丩ive2D 妯″瀷绱犳潗閮?b>涓嶅湪瀹夎鍖呴噷</b> 鈥斺€?鐢变娇鐢ㄨ€呰嚜宸卞鍏ユ垨鑱旂綉涓嬭浇锛岀増鏉冨綊鍚勮嚜浣滆€呮墍鏈夈€?/p>
									<p class="about-p">瀹屾暣娓呭崟涓?Live2D 鍗忚鐨勫垎鍙戜箟鍔¤鏄庤浠撳簱鏍圭洰褰曠殑 <code>THIRD-PARTY.md</code>銆?/p>
									<!-- 瀛椾綋璁稿彲鍏ㄦ枃锛?026-10-16锛? OFL 1.1 瑕佹眰鍐嶅垎鍙戞椂闄勫甫璁稿彲锛?									     杩欓噷鎶婂師鏂囨墦杩涘寘銆佸彲灏卞湴灞曞紑锛堥粯璁ゆ敹璧凤紝涓嶆墦鎵伴槄璇伙級銆?-->
									<details class="about-license">
										<summary>闇為箿鏂囨シ LXGW WenKai 路 SIL OFL 1.1 璁稿彲鍏ㄦ枃</summary>
										<pre class="about-license-text">{{ oflWenKaiText }}</pre>
									</details>
									<details class="about-license">
										<summary>绔欓叿蹇箰浣?ZCOOL KuaiLe 路 SIL OFL 1.1 璁稿彲鍏ㄦ枃</summary>
										<pre class="about-license-text">{{ oflKuaiLeText }}</pre>
									</details>
								</div>
								<!-- 鈶?鍙嶉娓犻亾 -->
								<div class="about-sec">
									<div class="about-h">鍙嶉娓犻亾</div>
									<p class="about-p">Nori 鏄€屽皬妗с€嶇敤鐖卞彂鐢靛仛鐨勫悓浜轰簩鍒涳紝娆㈣繋鏉ユ壘鎴戝弽棣?bug 鎹?鈥斺€?QQ 缇?<b>471419518</b>锛坕nori 涓€缇わ級銆?/p>
									<p class="about-p">椤圭洰浠撳簱寮€ issue 涔熷彲浠ワ細<button class="about-a" @click="openAboutUrl(REPO_URL)">{{ REPO_URL }}</button></p>
								</div>
							</div>
						</template>
					</div>
				</div>
			</div>
		</transition>

		<!-- 鏂版墜寮曞 (鍒嗘寮圭獥): 棣栨鎵撳紑 (杩樻病寤虹珛鏁版嵁鐩綍) 鑷姩寮逛竴娆? 涔嬪悗鍙敱 璁剧疆 鈫?銆屾柊鎵嬪紩瀵笺€嶉噸鏂版墦寮€銆?		     z-index 80 楂樹簬闈㈡澘(20)/璋冭瘯琛?70), 淇濊瘉浠讳綍鏃跺€欓兘鍦ㄦ渶涓婂眰銆?-->
		<transition name="sheet">
			<div v-if="introOn" class="intro-mask" @click.self="introClose">
				<!-- 2026-10-01 閲嶅仛锛堢敤鎴凤細銆屽唴瀹逛笉鍙橈紝AI 鍛冲お澶с€嶏級锛氫笉鍐嶆覆鏌?40px 澶?emoji锛?				     鏀规垚"濂归€掓潵鐨勪竴寮犱究绛? 鈥斺€?宸﹀榻?+ 椤堕儴鑳跺甫 + 鏍囬涓嬬煭寮鸿皟绾?+ 姝ｆ枃宸︿晶缁嗚壊鏉?+ 缁嗗垎椤垫潯銆?				     鏂囨涓庢暟鎹粨鏋勪竴瀛楁湭鏀癸紱绫诲悕淇濇寔鍘熸牱锛堟祴璇曚笌鎺㈤拡鎸夌被鍚嶆壘鍏冪礌锛夈€?-->
				<div class="intro">
					<span class="intro-tape" aria-hidden="true"></span>
					<div class="intro-head">
						<span class="intro-step">绗?{{ introStep + 1 }} / {{ INTRO_STEPS.length }} 姝?/span>
						<button class="x" @click="introClose">鉁?/button>
					</div>
					<div class="intro-title">{{ INTRO_STEPS[introStep].title }}</div>
					<span class="intro-rule" aria-hidden="true"></span>
					<div class="intro-body">
						<p v-for="(t, i) in INTRO_STEPS[introStep].body" :key="i" class="intro-p" :class="INTRO_STEPS[introStep].tone"><template v-for="(seg, j) in introSegs(t)" :key="j"><span v-if="seg.b" class="intro-b">{{ seg.t }}</span><template v-else>{{ seg.t }}</template></template></p>
						<div v-if="introStep === 2" class="intro-api-links" aria-label="API 瀵嗛挜鍏ュ彛">
							<button class="mini ripple intro-api-link" type="button" @click="openIntroApi(DEEPSEEK_API_KEYS_URL)">鏂囧瓧璋冪敤</button>
							<button class="mini ripple intro-api-link" type="button" @click="openIntroApi(QIANWEN_API_KEYS_URL)">璇煶杈撳嚭</button>
						</div>
					</div>
					<!-- 2026-10-02 淇帓鐗堬紙鐢ㄦ埛鎴浘锛氭渶鍚庝竴姝ュ洓涓寜閽尋涓€琛岋紝鍙充晶涓や釜琚睆骞曡鎺夛級锛?					     涓や釜銆岃烦杞被銆嶆寜閽紙椤圭洰浠撳簱 / Steam 鎰挎湜鍗曪級鍗曠嫭鍗犱笂闈竴琛岋紝涓斿厑璁告崲琛?					     锛堢獎灞忔斁涓嶄笅灏辫嚜鍔ㄧ珫鎺掞級锛涘垎椤垫潯涓庛€屼笂涓€姝?/ 寮€濮嬩娇鐢ㄣ€嶇暀鍦ㄤ笅闈竴琛屻€?					     绫诲悕涓€寰嬩繚鎸佸師鏍凤紙e2e-intro / probe-clone-gate 鎸夌被鍚嶆壘鍏冪礌锛夈€?-->
					<div class="intro-foot">
						<div v-if="introStep >= INTRO_STEPS.length - 1" class="intro-links">
							<!-- 椤圭洰浠撳簱锛?026-10-02 鐢ㄦ埛瑕佹眰锛夛細涓庢効鏈涘崟鍚屾鐨勪竴閿烦杞紝淇濇寔鍦ㄦ渶宸︼紙涓庣敤鎴锋埅鍥句竴鑷达級 -->
							<button class="mini ripple intro-repo" @click="openRepo">椤圭洰浠撳簱</button>
							<!-- Steam 鎰挎湜鍗曪紙2026-10-01 鐢ㄦ埛瑕佹眰锛夛細鍙湪鏈€鍚庝竴姝ュ嚭鐜帮紝璧板師鐢?ACTION_VIEW 鎵撳紑澶栭儴娴忚鍣?-->
							<button class="mini ripple intro-steam" @click="openSteamWishlist">鍔犲叆 Steam 鎰挎湜鍗?/button>
						</div>
						<div class="intro-nav">
							<div class="intro-dots">
								<i v-for="(s, i) in INTRO_STEPS" :key="s.title" :class="{on: i === introStep, done: i < introStep}"></i>
							</div>
							<div class="intro-btns">
								<button v-if="introStep > 0" class="mini ripple intro-prev" @click="introPrev">涓婁竴姝?/button>
								<button class="mini ripple intro-next" @click="introNext">{{ introStep >= INTRO_STEPS.length - 1 ? "寮€濮嬩娇鐢? : "涓嬩竴姝? }}</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</transition>

		<!-- 妯″瀷鎺堟潈楠岃瘉锛堢瓟棰橀棬锛?026-10-01 涓轰竴閿厠闅嗗紩鍏ワ紱2026-10-02 璧?*鍚屼竴閬撻棬**涔熷畧銆屼笅杞芥ā鍨嬨€嶏紝
		     2026-10-14 璧峰啀瀹堛€屼笅杞藉畼鏂逛汉璁俱€嶏級
		     鈥斺€?鐓х敤鎴风粰鐨勫弬鑰冨浘鍋氱殑缁撴瀯锛氭爣棰?璇存槑/闂/杈撳叆妗?鍙栨秷路楠岃瘉/搴曢儴鎻愮ず銆?		     鍙湁涓€浠藉脊绐椾笌涓€浠界姸鎬侊紙gateOn/gateKind/...锛夛紝鍔ㄤ綔闈?openGate(kind, onPass) 鍒嗗矓锛?		     clone = 寤洪煶鑹诧紙鍘熸牱锛?clone-gate 杩欏绫诲悕/鏂囨涓€瀛楁湭鏀癸紝probe-clone-gate 鐩潃锛夛紱
		     model = 鏀捐鍚庤蛋鍘熸潵鐨?鍒囨ā鍨嬧啋涓嬭浇"娴佺▼锛堣繘搴﹁繕鍦?topbar 鐨?loadingMsg 涓婏級锛?		     persona = 鏀捐鍚庝粠闈欐€佹墭绠℃媺瀹樻柟浜鸿鏂囨锛?persona-gate锛屾爣棰?璇存槑鎸夊姩浣滃垎宀旓級銆?-->
		<transition name="sheet">
			<div v-if="gateOn" class="gate-mask" :class="gateKind === 'clone' ? 'clone-gate-mask' : gateKind === 'persona' ? 'persona-gate-mask' : 'model-gate-mask'" @click.self="closeGate">
				<div class="gate" :class="gateKind === 'clone' ? 'clone-gate' : gateKind === 'persona' ? 'persona-gate' : 'model-gate'">
					<div class="gate-head">
						<span class="gate-title">{{ gateKind === "persona" ? "浜鸿鎺堟潈楠岃瘉" : "妯″瀷鎺堟潈楠岃瘉" }}</span>
						<button class="x" @click="closeGate">鉁?/button>
					</div>
					<p class="gate-desc">璇{ gateKind === "clone" ? "鍐呯疆闊宠壊" : gateKind === "persona" ? "浜鸿鏂囨" : "妯″瀷" }}鐢?<b>inori</b> 鎻愪緵锛屽洜{{ gateKind === "persona" ? "鐗规畩鎬? : "妯″瀷鐗规畩鎬? }}涓嶅彲鐩存帴鍒嗗彂锛涚瓟瀵逛笅闈㈢殑闂鍗冲彲{{ gateKind === "clone" ? "鑾峰緱浣跨敤璧勬牸" : "寮€濮嬩笅杞? }}銆?/p>
					<div class="gate-q">{{ CLONE_GATE_QUESTION }}</div>
					<input v-model="gateInput" class="gate-input" type="text" autocomplete="off" spellcheck="false" placeholder="璇疯緭鍏ョ瓟妗? @keyup.enter="doGate" />
					<div v-if="gateMsg" class="hint" :class="gateOk ? 'ok' : 'bad'">{{ gateMsg }}</div>
					<div class="gate-btns">
						<button class="mini ripple" @click="closeGate">鍙栨秷</button>
						<button class="mini ripple gate-go" :disabled="gateBusy || !gateInput.trim()" @click="doGate">{{ gateBusy ? gateBusyLabel : gateGoLabel }}</button>
					</div>
					<div class="gate-hint">{{ gateKind === "clone" ? CLONE_GATE_HINT : gateKind === "persona" ? PERSONA_GATE_HINT : MODEL_GATE_HINT }}</div>
				</div>
			</div>
		</transition>
	</div>
</template>

<script setup lang="ts">
import {memoryChatOptions, selectRecallWithinBudget} from "./services/memory/context"
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue"
import {
	createLive2D,
	readModelConfig,
	writeModelConfig,
	L2D_FPS_OPTIONS,
	normalizeFps,
	normalizeRenderScale,
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
import PomodoroPanel from "./components/PomodoroPanel.vue"
import {DEFAULT_POMO, normalizePomo, projectLiveDays, monthPercent, parsePomoBackup, pomoCsv} from "./services/pomodoro"
import {createRenderPauseState} from "./services/renderPause"
import {
	loadSettings,
	saveSettingsRaw,
	loadChat,
	persistChat,
	setChatTrimCutoff,
	flushChatPersist,
	writeFile,
	readFileState,
	fetchModels,
	sendChat,
	isStorageReady,
	requestStoragePermission,
	pickPersonaFile,
	loadCustomPersona,
	saveCustomPersona,
	downloadOfficialPersona,
	personaPrompt,
	getStorageDir,
	probePublicFiles,
	hasAllFilesAccess,
	requestAllFilesAccess,
	pickImageFile,
	captureImage,
	checkFishBalance,
	checkDeepSeekBalance,
	checkCosyBalance,
	fetchVoices,
	sendChatStream,
	cancelChatStream,
	type ChatMsg,
	type ImagePickedResult,
	type VoiceInfo,
	type CosyCloneVoice,
	normalizeCloneVoices,
} from "./services/chat"
import {
	addMemoriesFromText,
	extractMemoriesSmart,
	pruneDoneGoals,
	selectOpeningRecall,
	summarizeIfNeeded,
	notifyHistoryTrimmed,
	safeTrimDrop,
	contextHistory,
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
	buildInjectJsonl,
	clearInjects,
	injectCount,
	MAX_INJECT_RECORDS,
	memoryHealth,
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
	type MemoryHealth,
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
// 銆屾ā鍨嬫巿鏉冮獙璇併€嶇瓟棰橀棬锛?026-10-01 涓€閿厠闅?/ 2026-10-02 涔熷畧銆屼笅杞芥ā鍨嬨€嶏級: 棰樼洰/绛旀/鍒ゅ嵎閮藉湪閭ｄ釜绾ā鍧楅噷, 渚夸簬鍗曟祴
import {CLONE_GATE_QUESTION, CLONE_GATE_HINT, MODEL_GATE_HINT, PERSONA_GATE_HINT, checkCloneAnswer} from "./services/tts/clone-gate"
import {parseMarkerDelta, type ParsedMarkers} from "./services/chat/markers"
import {stripInternalPromptMetadata} from "./services/chat/replyMetadata"
// 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 鍖垮悕蹇冭烦 + 绾€昏緫鏂囨锛涙湇鍔＄瑙?services/presence/
import {
	startPresence,
	stopPresence,
	refreshPresence,
	presenceOnVisible,
	subscribePresence,
	presenceConfigured,
	presenceCountText,
	presenceTodayText,
	presenceStatusText,
	presenceTone,
	type PresenceState,
} from "./services/presence"
// 鐣岄潰鍙€夊瓧浣擄紙2026-10-15锛? system / 闇為箿鏂囨シ / 绔欓叿蹇箰浣擄紱绾€昏緫鍦?services/ui-font.ts
import {UI_FONT_OPTIONS, applyUiFont, normalizeUiFont, uiFontPreviewFamily, type UiFontChoice} from "./services/ui-font"
/* 涓や釜瀛椾綋鐨?OFL 璁稿彲**鍏ㄦ枃**锛?026-10-16锛? OFL 1.1 瑕佹眰鍐嶅垎鍙戝瓧浣撴椂闄勫甫璁稿彲锛? * 鎵€浠ヨ繖閲屼互鍘熸枃鎵撹繘鍖呫€佸湪銆屽叧浜?/ 寮€婧愯鍙€嶉〉閲屽彲灞曞紑鏌ョ湅锛堜笉鏄彧缁欎釜浠撳簱璺緞锛夈€?*/
import oflWenKaiText from "./assets/fonts/OFL-LXGWWenKai.txt?raw"
import oflKuaiLeText from "./assets/fonts/OFL-ZCOOLKuaiLe.txt?raw"
import {listDiary, ensureDiary, bufferDiarySource} from "./services/nori-diary"
import DiaryPanel from "./components/DiaryPanel.vue"
// 涓撴敞缁熻: 绾€昏緫 (鍙崟娴? 鈥斺€?姹囨€昏绠椼€佺儹鍔涘浘缃戞牸銆佷互鍙?瑕佷笉瑕佽窡 Nori 鎻?鐨勫垽瀹氶兘鍦ㄩ偅閲?import {
	summarize as pomoSummarize,
	buildFocusHint,
	buildHeatmap,
	monthlyRollup,
	migrateStats,
	addToStore,
	dayMinutes,
	shiftDay,
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
// 鎶氭懜閲囨牱鍣?(绉绘鑷綉椤电増 headPat 鐨?r8e): 鍒?妯悜涓轰富 + 澶熷揩", 绱婊?requiredMs 绠楀畬鎴愪竴娆?import {createPetStrokeDetector, DEFAULT_PET_STROKE_TUNING} from "./services/live2d/petStroke"
// 鎶氭懜闊虫晥 (绉绘鑷綉椤电増 headPat 鐨勫疄鏃跺悎鎴愰煶, 闆剁礌鏉?
import {petAudioPrime, petAudioTouch, petAudioStroke, petAudioComplete, petAudioRelease, disposePetAudio, petAudioState} from "./services/live2d/petAudio"
// "鎽稿埌澶?鐨勫垽瀹?(绉绘鑷綉椤电増 headPat 鐨勯儴浠跺垽瀹? 杩欎釜妯″瀷娌℃湁 Part9, 鏀逛负鎸夊嚑浣曟寫澶寸洅)
import {pickHeadBox, inHeadZoneHysteresis, headZoneLine, type PetPartBox} from "./services/live2d/petHeadZone"
// 鎽稿ご琛ㄦ儏: 鍙湪鎽稿埌澶存椂鎾?shy/smile(浜岄€変竴闅忔満) + 鍋滄墜 1s 鍚庡钩婊戞敹鍥?琛ㄦ儏鑷甫 0.5s 娣″嚭)
import {applyPetExpression, petExpressionName, petExpressionShowing, petExpressionHoldsLayer} from "./services/live2d/petExpression"
// 鎽稿ご鍙拌瘝: 鎽稿埌澶存椂璇翠竴鍙?10 鍙ヨ鏂欓殢鏈? 娲楃墝琚嬩笉閲嶅), 10s 鍐呭彧璇翠竴娆?鈥斺€?绾€昏緫鍦ㄦā鍧楅噷(鏈夐棬绂?
import {maybePetSpeechLine, petSpeechCount, petSpeechLastLine, petSpeechWaitMs} from "./services/live2d/petSpeech"
// 鐪ㄧ溂: 搴撳唴缃殑 CubismEyeBlink 琚?model3.json 鐨勭┖ EyeBlink 鍚嶅崟搴熸帀浜? 杩欓噷鑷繁鍋?import {installBlink, blinkCount, blinkClosureNow} from "./services/live2d/blink"
import {installLipSync} from "./services/live2d/lipSync"

type P = "model" | "motion" | "expression" | "touch" | "settings" | "tts" | "diary" | "memories" | "pomo" | "pomoStats" | "about" | ""

const l2dHost = ref<HTMLElement | null>(null)

const l2d = createLive2D()
const loading = ref(false)
const error = ref("")
const ready = ref(false)
const panel = ref<P>("")
const settingsTab = ref<"basic" | "advanced">("basic")
const currentModelId = ref<string>("")
const motions = ref<MotionGroup[]>([])
const expressions = ref<string[]>([])

const touchAreas = ref<TouchArea[]>([])
const selectedTouchId = ref<string | null>(null)
const touchCustomExpanded = ref(false)
const touchEditingId = ref<string | null>(null)
let touchEditOriginal: TouchArea | null = null
const deletedTouch = ref<{area: TouchArea; index: number} | null>(null)

/** 鍖哄煙寮€鍏虫寜妯″瀷淇濆瓨锛涜瘯鐢ㄤ粎褰撳墠椤甸潰鏈夋晥銆?*/
const touchEnabled = ref(true)
const touchTesting = ref(false)
const touchCooldownText = ref("")
const touchReplyPreview = ref("")
let touchCooldownTimer: ReturnType<typeof setTimeout> | null = null

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
const loadingMsg = ref("鍔犺浇涓€?)
const modelList = ref<{id: string; name: string}[]>([])
const listError = ref("")

const currentModel = computed(() => modelList.value.find((m) => m.id === currentModelId.value))
/**
 * 搴曟爮鍥炬爣 (2026-09-30)銆傚彇鑷綉椤电増 NoriOS 搴曟爮鐨?6 涓浘鏍囷紙鐢ㄦ埛鎸夊簭鍙风偣鍚嶇殑锛氫綘鐢绘垜鐚?绠楀姏/
 * 鍥介檯璞℃/铔嬬硶瀵瑰喅/鏂囦欢/鑷磋阿锛夛紝缂╁埌 144px 鏀惧湪 `public/icons/`锛屼綔涓?*鏈満鑷敤**绱犳潗銆? *
 * 涓轰粈涔堢敤瀛楃涓插父閲?+ `:src`锛歚public/` 閲岀殑鏂囦欢鏄師鏍疯惤鐩樼殑锛屽啓鎴愭ā鏉块噷鐨勭浉瀵硅矾寰勪細琚?Vite
 * 褰撴垚鏈湴璧勬簮鍘昏В鏋愶紙SFC 閲屼笉瀛樺湪璇ユ枃浠?鈬?鏋勫缓鎶ラ敊锛夈€傝繍琛屾椂鎸?`./icons/...` 鐩稿鏂囨。瑙ｆ瀽锛? * WebView 璧?WebViewAssetLoader锛坄/assets/web/index.html`锛夆噿 姝ｅソ鍛戒腑 `assets/web/icons/`銆? */
const DOCK_ICONS = {
	diary: "./icons/dock-diary.svg",
	model: "./icons/dock-model.svg",
	touch: "./icons/dock-touch.svg",
	pomo: "./icons/dock-pomo.svg",
	settings: "./icons/dock-settings.svg",
	chat: "./icons/dock-chat.svg",
} as const

const panelTitle = (p: P) => ({model: "閫夋嫨妯″瀷", motion: "鍔ㄤ綔鍒楄〃", expression: "琛ㄦ儏鍒楄〃", touch: "浜掑姩璁剧疆", settings: "璁剧疆", tts: "璇煶鍚堟垚", diary: "Nori 鐨勫績鎯呮棩璁?, memories: "璁板繂搴?, pomo: "鐣寗閽?, pomoStats: "涓撴敞缁熻", about: "鍏充簬 / 闅愮 / 寮€婧愯鍙?} as Record<string, string>)[p] ?? ""

/* ---------------- 鏂版墜寮曞 (鍒嗘寮圭獥) ----------------
 * 棣栨鎵撳紑 (杩樻病寤虹珛鏁版嵁鐩綍) 鑷姩寮逛竴娆? 涔嬪悗璁剧疆椤靛簳閮ㄦ湁銆屾柊鎵嬪紩瀵笺€嶆寜閽彲閲嶆柊鎵撳紑銆? * 鏂囨鏉ヨ嚜鐢ㄦ埛缁欑殑璇存槑鏂囨。, 鍙仛鍒嗘涓庢鼎鑹? 鍐呭涓嶆敼銆? */
interface IntroStep { emoji: string; title: string; body: string[]; tone?: "warn" | "ok" }
const INTRO_STEPS: IntroStep[] = [
	{
		emoji: "馃尭",
		title: "娆㈣繋鏉ュ埌 Nori 鐨勫皬涓栫晫",
		body: [
			"杩欐槸涓€涓畝闄嬬殑鏂版墜寮曞锛屼篃鏄嚑鍙ユ敞鎰忎簨椤广€?,
			"姝ら」鐩负**鍚屼汉浜屽垱**锛屼笌鍘熶綔鏃犲叧銆?,
		],
		tone: "warn",
	},
	{
		emoji: "馃洜锔?,
		title: "杩欎釜鐗堟湰鏄皝鍋氱殑",
		body: [
			"姝ょ増鏈敱**灏忔¨**锛坕nori 涓€缇?路 471419518锛夐噸鏋勩€?,
			"鍘熺増鏈负**娲辨捣**鍙?*浜撴墠瀛?*鐨勬渶鍒濈増鏈?DeepEr锛堢幇宸叉崲鍖呭悕锛屽彲鍏卞瓨锛夈€?,
		],
	},
	{
		emoji: "馃攽",
		title: "寮€濮嬪墠闇€瑕佸噯澶囦袱鏍蜂笢瑗?,
		body: [
			"API 闇€瑕佷粯璐癸紝鑷冲皯瑕佸噯澶囷細涓€涓?LLM锛堝ぇ璇█妯″瀷锛屽 DeepSeek锛? 涓€娆?TTS 璇煶妯″瀷銆?,
			"TTS 鏈?Fish Audio 鍜屽崈闂彲閫夛紝鎺ㄨ崘鍗冮棶鐨?Audio 3.1 TTS 鈥斺€?鏁堟灉涓庝环鏍奸兘寰堜笉閿欙紱闊抽鍙互鍦ㄧ兢閲岃嚜琛屾埅鍙栥€?,
			"鈿?涓嬭浇**闊抽**鍜?*妯″瀷**鍙兘闇€瑕?*榄旀硶**锛堝浗鍐呬笉涓€瀹氱洿杩炲緱涓婏級锛屼笅杞藉墠璇疯嚜澶囩綉缁滅幆澧冦€?,
			"鍑嗗濂藉悗锛屽湪銆岃缃€嶉噷濉叆 API 鍦板潃涓庡瘑閽ュ嵆鍙€?,
			"鍙﹀锛氳缃噷璇锋墦寮€銆屾墍鏈夋枃浠惰闂潈闄愩€嶃€侫ndroid 11 璧凤紝鑱婂ぉ璁板綍/璁板繂/鏃ヨ閮藉瓨鍦ㄥ叕鍏变笅杞界洰褰曪紝娌℃湁杩欎釜鏉冮檺浼氳涓嶅埌锛堝挨鍏舵槸鍗歌浇閲嶈涔嬪悗锛夈€?,
		],
		tone: "warn",
	},
	{
		emoji: "馃挰",
		title: "娆㈣繋鏉ユ壘鎴戝弽棣?bug",
		body: [
			"鍗佸垎鎰熻阿**鐧藉 Tira** 浠ュ強 **I_Nori 鍒朵綔缁?*鐨勮緵鍕や粯鍑恒€?,
			"娆㈣繋浣犱滑鎵炬垜鍙嶉 bug 鎹忥紝甯屾湜澶у鍜?Nori 瓒婃潵瓒婂ソ銆?,
		],
		tone: "ok",
	},
]
/** 鏄惁灞曠ず寮曞 */
const introOn = ref(false)
const introStep = ref(0)
/** 娈佃惤閲岀殑 **寮鸿皟** 鈫?鍒嗘娓叉煋 (涓嶇敤 v-html, 鍏嶅緱鎶婃枃妗堝綋 HTML 瑙ｆ瀽) */
const introSegs = (text: string): {t: string; b: boolean}[] =>
	text.split("**").map((t, i) => ({t, b: i % 2 === 1})).filter(s => s.t !== "")
/** 鐐硅繃銆屼笅涓€姝?寮€濮嬩娇鐢ㄣ€嶅悗灏变笉鍐嶈嚜鍔ㄥ脊 (鍏虫帀寮圭獥涔熺畻鐪嬭繃) */
const INTRO_SEEN_KEY = "intro_seen_v1"
const introOpen = (): void => { introStep.value = 0; introOn.value = true }
const introNext = (): void => {
	if (introStep.value >= INTRO_STEPS.length - 1) { introClose(); return }
	introStep.value += 1
	playSfx()          // 姝ラ鍒囨崲缁欎竴璁拌交鎸夐敭闊?(涓?dock 鎸夐敭鍚屼竴濂楅煶閲忚缃?
}
const introPrev = (): void => {
	if (introStep.value <= 0) return
	introStep.value -= 1
	playSfx()
}
const introClose = (): void => {
	introOn.value = false
	try { localStorage.setItem(INTRO_SEEN_KEY, "1") } catch { /* 蹇界暐 */ }
	// 鍏抽棴/瀹屾垚闊充笌"鎸夐敭闊?鍚屾簮, 涓嶉澶栧紩璧勬簮
	playSfx()
}

/** I_Nori 鐨?Steam 鎰挎湜鍗曪紙2026-10-01 鐢ㄦ埛缁欑殑閾炬帴锛夈€傚紩瀵兼渶鍚庝竴姝ユ湁涓€閿烦杞寜閽€? *  璧板師鐢?openExternal锛圓CTION_VIEW锛夊湪澶栭儴娴忚鍣ㄦ墦寮€锛涙ˉ涓嶆敮鎸佹椂閫€鍥?window.open銆?*/
const STEAM_WISHLIST_URL = "https://store.steampowered.com/app/4996280/I_NORI/?beta=0"
/** 椤圭洰浠撳簱锛?026-10-02 鐢ㄦ埛瑕佹眰锛夛細寮曞鏈€鍚庝竴姝ヤ竴閿烦杞紝涓?Steam 鎰挎湜鍗曞悓娆捐蛋鍘熺敓 openExternal */
const REPO_URL = "https://github.com/furret2333/NoriDroid"
const openRepo = (): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(REPO_URL)
		else window.open(REPO_URL, "_blank")
	} catch { /* 鎵撲笉寮€灏辩畻浜? 涓嶆墦鏂紩瀵?*/ }
	playSfx()
}

const openSteamWishlist = (): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(STEAM_WISHLIST_URL)
		else window.open(STEAM_WISHLIST_URL, "_blank")
	} catch { /* 鎵撲笉寮€灏辩畻浜? 涓嶆墦鏂紩瀵?*/ }
	playSfx()
}

const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys"
const QIANWEN_API_KEYS_URL = "https://platform.qianwenai.com/home/api-keys"
const openIntroApi = (url: string): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(url)
		else window.open(url, "_blank")
	} catch { /* 澶栭摼鎵撲笉寮€鏃朵笉鎵撴柇寮曞 */ }
	playSfx()
}

const hideThumb = (e: Event) => { (e.currentTarget as HTMLElement).style.visibility = "hidden" }

/* ---------------- 銆屽叧浜?/ 闅愮 / 寮€婧愯鍙€嶉〉鐢ㄥ埌鐨勫父閲忥紙2026-10-02 鐢ㄦ埛瑕佹眰锛?----------------
 * 鐗堟湰鍙凤細涓?app/android/app/build.gradle 鐨?versionName 淇濇寔涓€鑷达紙鍓嶇闅?APK 涓€璧峰彂鐗堬級銆? * 鈿?鍒嬁 web-src/package.json 鐨?version锛堣剼鎵嬫灦鐣欎笅鐨?0.1.0锛夊綋鐗堟湰鍙?鈥斺€?閭ｄ笉鏄敤鎴风湅鍒扮殑鐗堟湰銆? * 涓婃父澹版槑涓庤鍙竻鍗曞悓姝ヨ嚜浠撳簱鏍圭殑 THIRD-PARTY.md锛圓pp 閲屽彧鏀捐鐐?+ 鎸囧悜瀹冿級銆?*/
const APP_VERSION = "2.5.1"
const UPSTREAM_REPO_URL = "https://github.com/erhiolab/DeepEr"
const LIVE2D_EULA_URL = "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html"
/** 閫氱敤澶栭摼鎵撳紑锛氫笌 openRepo / openSteamWishlist 鍚屾锛堜紭鍏堝師鐢?openExternal锛屾ˉ涓嶆敮鎸佹椂閫€鍥?window.open锛夈€? *  鍏充簬椤甸噷鐨勪粨搴?/ 涓婃父 / Live2D 鍗忚閮借蛋瀹冿紝閬垮厤鍦?WebView 閲岀洿鎺ヨ烦璧般€?*/
const openAboutUrl = (url: string): void => {
	const nori = (window as unknown as {NoriChat?: {openExternal?: (u: string) => void}}).NoriChat
	try {
		if (nori && typeof nori.openExternal === "function") nori.openExternal(url)
		else window.open(url, "_blank")
	} catch { /* 鎵撲笉寮€灏辩畻浜? 涓嶆墦鏂槄璇?*/ }
	playSfx()
}
/** 鎵撳紑銆屽叧浜?/ 闅愮 / 寮€婧愯鍙€嶉〉銆傚叆鍙ｅ湪璁剧疆闈㈡澘**鏈€涓嬮潰**锛岃€?sheet 鐨勬粴鍔ㄤ綅缃槸璺ㄩ潰鏉夸繚鐣欑殑
 *  锛坄.sheet-body` 濮嬬粓鏄悓涓€涓粴鍔ㄥ鍣級鈥斺€?涓嶄富鍔ㄦ粴鍥為《閮ㄧ殑璇濓紝鐐硅繘鏉ヤ細鐩存帴钀藉湪銆屽紑婧愯鍙€嶉偅涓€灞忥紝
 *  鐢ㄦ埛鏍规湰鐪嬩笉鍒板紑澶寸殑銆岀増鏈€嶃€傛墍浠ュ垏鎹㈤潰鏉垮悗鎶婂唴瀹规粴鍥為《閮ㄣ€?*/
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
	if (touchTesting.value) {
		selectedTouchId.value = area.id
		const label = type === "swipe" ? "婊戝姩" : "鐐规寜"
		const matches = !area.gesture || area.gesture === "both" || area.gesture === type
		triggerBubble(`鍛戒腑銆?{area.name}銆?路 ${label}${matches ? "锛屾墜鍔跨鍚堣缃? : "锛屼笉绗﹀悎璇ュ尯鍩熺殑瑙﹀彂鏂瑰紡"}`)
		return false
	}
	if (touchReplyBusy()) {
		triggerBubble("Nori 姝ｅ湪鍥炲鎴栨湕璇伙紝鏈瑙︽懜浜掑姩宸茶烦杩?)
		return false
	}
	if (!modelReady.value) { triggerBubble("璇峰厛鍦ㄨ缃腑閰嶇疆 API Key 鍜屾ā鍨?); return false }
	void handleTouchTrigger(area, type)
	setTimeout(() => showTouchCooldown(area), 0)
	return true
})

const touchReplyBusy = (): boolean => Boolean(typing.value || chatStreaming.value || touchStreaming.value || speaking.value)

detector.setCooldown(10000)

const configureTouchDetector = () => {
	
	const ms = modelSize()
	detector.configure(touchEnabled.value ? touchAreas.value : [], l2d.canvas(), ms?.w ?? 0, ms?.h ?? 0)
}


const modelSize = (): {w: number; h: number} | null => {
	const m = (window as unknown as {__noriModelCanvas?: {w: number; h: number}}).__noriModelCanvas
	return m && m.w > 0 && m.h > 0 ? {w: m.w, h: m.h} : null
}

const loadTouchForModel = (id: string) => {
	cancelTouchEdit()
	deletedTouch.value = null
	selectedTouchId.value = null
	detector.destroy()
	detector.setPreview(false)
	const config = loadTouchConfig(id)
	touchAreas.value = config.touches
	touchEnabled.value = config.enabled !== false
	touchTesting.value = false
	touchDrawing.value = false
	touchAdjusting.value = false
	resetTouchDraft()
	nextTick(configureTouchDetector)
}

const saveTouch = (): boolean => {
	if (!ready.value || loading.value) { triggerBubble("璇风瓑寰呮ā鍨嬪姞杞藉畬鎴愬悗鍐嶄繚瀛樺尯鍩?); return false }
	if (currentModelId.value) {
		const cfg = loadTouchConfig(currentModelId.value)
		cfg.touches = touchAreas.value
		cfg.enabled = touchEnabled.value
		if (!saveTouchConfig(currentModelId.value, cfg)) {
			triggerBubble("淇濆瓨澶辫触锛氭湰鍦板瓨鍌ㄤ笉鍙啓锛岃閲嶈瘯", 4500)
			return false
		}
	} else {
		triggerBubble("璇峰厛鍔犺浇涓€涓ā鍨?)
		return false
	}
	configureTouchDetector()
	return true
}

const onTouchAdd = (t: {name: string; prompt: string; reactionPrompt?: string; gesture?: "tap" | "swipe" | "both"}) => {
	const d = touchDraft.value
	if (!d || d.w < 0.06 || d.h < 0.06) { triggerBubble("璇峰厛鍦ㄦā鍨嬩笂妗嗛€変竴涓煩褰㈠尯鍩?); return }
	const before = [...touchAreas.value]
	touchAreas.value = [...before, {
		id: newTouchId(), name: t.name || "鏈懡鍚?, type: "tap", gesture: t.gesture ?? "both",
		x: d.x, y: d.y, w: d.w, h: d.h, image: "", prompt: t.prompt || "", reactionPrompt: t.reactionPrompt || t.prompt || "",
	}]
	if (!saveTouch()) { touchAreas.value = before; return }
	selectedTouchId.value = touchAreas.value[touchAreas.value.length - 1]?.id ?? null
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	triggerBubble("宸叉坊鍔犺Е鎽稿尯鍩?)
}

const beginTouchEdit = (id: string) => {
	if (touchEditingId.value === id) return
	cancelTouchEdit()
	const area = touchAreas.value.find(t => t.id === id)
	if (!area) return
	touchEditOriginal = {...area}
	touchEditingId.value = id
	selectedTouchId.value = id
	touchDrawing.value = false
	touchTesting.value = false
	detector.setPreview(false)
	resetTouchDraft()
}

const cancelTouchEdit = () => {
	if (touchEditOriginal) {
		const original = touchEditOriginal
		touchAreas.value = touchAreas.value.map(t => t.id === original.id ? original : t)
	}
	touchEditOriginal = null
	touchEditingId.value = null
	drawStart = null
	drawingTarget.value = null
	movingOrigin = null
}

const previewTouchEdit = (id: string, patch: Partial<TouchArea>) => {
	if (touchEditingId.value !== id) return
	touchAreas.value = touchAreas.value.map(t => {
		if (t.id !== id) return t
		const next = {...t, ...patch}
		next.w = Math.min(1, Math.max(0.06, next.w))
		next.h = Math.min(1, Math.max(0.06, next.h))
		next.x = Math.max(0, Math.min(next.x, 1 - next.w))
		next.y = Math.max(0, Math.min(next.y, 1 - next.h))
		return next
	})
}

const onTouchUpdate = (id: string, patch: Partial<TouchArea>) => {
	if (touchEditingId.value !== id) return
	previewTouchEdit(id, patch)
	if (!saveTouch()) return
	touchEditOriginal = null
	touchEditingId.value = null
	triggerBubble("鍖哄煙宸蹭繚瀛?)
}

const onTouchRemove = (id: string) => {
	cancelTouchEdit()
	const before = [...touchAreas.value]
	const index = before.findIndex(t => t.id === id)
	if (index < 0) return
	touchAreas.value = touchAreas.value.filter(t => t.id !== id)
	if (!saveTouch()) { touchAreas.value = before; return }
	deletedTouch.value = {area: {...before[index]}, index}
	if (selectedTouchId.value === id) selectedTouchId.value = null
}

const undoTouchRemove = () => {
	const deleted = deletedTouch.value
	if (!deleted) return
	cancelTouchEdit()
	const before = touchAreas.value
	touchAreas.value = [...before.slice(0, deleted.index), deleted.area, ...before.slice(deleted.index)]
	if (!saveTouch()) { touchAreas.value = before; return }
	selectedTouchId.value = deleted.area.id
	deletedTouch.value = null
	triggerBubble("宸叉挙閿€鍒犻櫎")
}

const setTouchEnabled = (enabled: boolean) => {
	cancelTouchEdit()
	touchEnabled.value = enabled
	if (!saveTouch()) touchEnabled.value = !enabled
	if (!touchEnabled.value) { touchTesting.value = false; detector.setPreview(false) }
}

const toggleTouchTesting = () => {
	if (!touchEnabled.value) {
		triggerBubble("璇峰厛寮€鍚嚜瀹氫箟鍖哄煙")
		return
	}
	cancelTouchEdit()
	touchTesting.value = !touchTesting.value
	detector.setPreview(touchTesting.value)
	if (touchTesting.value) {
		touchDrawing.value = false
		touchAdjusting.value = false
		resetTouchDraft()
		triggerBubble("璇曠敤妯″紡宸插紑鍚細鍙鏌ュ懡涓紝涓嶄細璋冪敤 AI")
	} else {
		touchCooldownText.value = ""
		triggerBubble("宸查€€鍑鸿瘯鐢ㄦā寮?)
	}
}

const showTouchCooldown = (area: TouchArea) => {
	if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
	const tick = () => {
		const left = detector.getCooldownRemaining(area.id)
		if (left <= 0) { touchCooldownText.value = ""; touchCooldownTimer = null; return }
		touchCooldownText.value = `銆?{area.name}銆嶅凡瑙﹀彂锛?{Math.ceil(left / 1000)} 绉掑唴涓嶄細閲嶅鍥炲簲`
		touchCooldownTimer = setTimeout(tick, 250)
	}
	tick()
}

const onTouchTest = (area: TouchArea) => {
	if (!touchEnabled.value) return
	if (!ready.value || loading.value) { triggerBubble("璇峰厛鍔犺浇妯″瀷鍐嶈瘯 AI"); return }
	if (touchEditingId.value) { triggerBubble("璇峰厛淇濆瓨鎴栧彇娑堝尯鍩熺紪杈?); return }
	if (touchReplyBusy()) { triggerBubble("Nori 姝ｅ湪鍥炲鎴栨湕璇伙紝鏆傛椂涓嶈兘璇?AI"); return }
	if (detector.getCooldownRemaining(area.id) > 0) { showTouchCooldown(area); return }
	touchTesting.value = false
	detector.setPreview(false)
	detector.trigger(area, area.gesture === "swipe" ? "swipe" : "tap")
}

const onPetTouchSetting = () => {
	persistSettings()
	if (!cfg.petTouchSound) petAudioRelease()
	if (!cfg.petTouchEffects) clearPetFx()
}

const closeTouchSettings = () => {
	cancelTouchEdit()
	touchDrawing.value = false
	touchAdjusting.value = false
	touchTesting.value = false
	detector.setPreview(false)
	resetTouchDraft()
	detector.cancel()
	if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
	touchCooldownTimer = null
	touchCooldownText.value = ""
	panel.value = ""
}

const onTouchCustomToggle = (event: Event) => {
	touchCustomExpanded.value = (event.target as HTMLDetailsElement).open
	if (touchCustomExpanded.value) return
	cancelTouchEdit()
	touchDrawing.value = false
	touchAdjusting.value = false
	touchTesting.value = false
	detector.setPreview(false)
	resetTouchDraft()
}


const toggleTouchDraw = () => {
	cancelTouchEdit()
	touchTesting.value = false
	detector.setPreview(false)
	touchDrawing.value = !touchDrawing.value
	if (touchDrawing.value) touchAdjusting.value = false
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	drawStart = null
	drawDragged = false
	if (touchDrawing.value) triggerBubble("鍦ㄦā鍨嬩笂鎸変綇鎷栧姩鐢绘柊鐭╁舰")
}


const toggleTouchAdjust = () => {
	touchTesting.value = false
	detector.setPreview(false)
	touchAdjusting.value = !touchAdjusting.value
	if (touchAdjusting.value) touchDrawing.value = false
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	drawStart = null
	drawDragged = false
	if (touchAdjusting.value) triggerBubble("鐐逛綇宸叉湁鍖哄煙鍙嫋鍔ㄤ綅缃?)
}

const resetTouchDraft = () => {
	touchDraft.value = null
	draftReady.value = false
	drawingTarget.value = null
	drawDragged = false
}


import {watch as __watch} from "vue"
__watch(() => panel.value, (newVal) => {
	if (newVal !== "") cancelStageInteraction()
	if (newVal !== 'touch') {
		touchReplyPreview.value = ""
		cancelTouchEdit()
		detector.setPreview(false)
		touchDrawing.value = false
		touchAdjusting.value = false
		touchTesting.value = false
		touchCooldownText.value = ""
		if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
		touchCooldownTimer = null
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

// 绔栧睆鍥炲鐙珛浜庡巻鍙插睍寮€鐘舵€侊紱鍙繚瀛樻湰娆″睍绀猴紝涓嶆敼鑱婂ぉ鎸佷箙鍖栥€?const portraitReply = ref("")
let portraitReplyTimer: ReturnType<typeof setTimeout> | null = null
const clearPortraitReplyTimer = (): void => {
	if (portraitReplyTimer) clearTimeout(portraitReplyTimer)
	portraitReplyTimer = null
}
const schedulePortraitReplyClear = (ms?: number): void => {
	clearPortraitReplyTimer()
	if (!portraitReply.value || typing.value || chatStreaming.value || touchStreaming.value || speaking.value) return
	portraitReplyTimer = setTimeout(() => {
		portraitReply.value = ""
		portraitReplyTimer = null
	}, ms ?? Math.min(16000, Math.max(9000, portraitReply.value.length * 80)))
}
const showPortraitReply = (text: string, ms?: number): void => {
	portraitReply.value = text
	if (touchStreaming.value && panel.value === "touch") touchReplyPreview.value = text
	schedulePortraitReplyClear(ms)
}

/** 灞曠ず涓€鏉?"Nori 璇磋瘽" 姘旀场銆? *  `ms` 榛樿 9s锛圓I 鍥炲 / ambient 鎼瘽娌跨敤鍘熻涓猴級銆? *  鎽稿ご鍙拌瘝浼犳洿闀跨殑鍊硷細瀹冪殑鏀跺熬鑷繁鍋氾紙璇村畬鍗虫敹 + 鍏滃簳锛夛紝**蹇呴』**淇濊瘉杩欓噷鐨勫畾鏃跺櫒
 *  涓嶄細鏇存棭鎶婂瓧鎶规帀锛堝惁鍒?濂硅繕娌¤瀹岋紝瀛楀氨娌′簡"锛夈€?*/
const showAiBubble = (t: string, ms = 9000) => {
	aiBubble.value = t
	showPortraitReply(t, ms)
	if (aiBubbleTimer) clearTimeout(aiBubbleTimer)
	aiBubbleTimer = setTimeout(() => { aiBubble.value = "" }, ms)
}


const TAP_VERBS = ["鎴充簡鎴?, "鐐逛簡鐐?, "杞昏交鐐逛簡涓€涓?, "纰颁簡纰?, "鎴充簡涓€涓?]
const SWIPE_VERBS = ["鎽镐簡鎽?, "杞昏交鎽镐簡鎽?, "韫簡韫?, "鎶氭懜浜嗗ソ鍑犱笅", "鎻変簡鎻?]

const TOUCH_DIRECTIVE = [
	"杩欎竴娆℃槸瑙︽懜浜掑姩锛?,
	"1. 浣犲凡缁忔槸涓€涓劅瑙夌伒鏁忕殑浜? 瀹屽叏鎸夎嚜宸辩殑鏂瑰紡鏉ュ弽搴? 涓嶈澶嶈涔嬪墠璇磋繃鐨勮瘽, 涓嶈姣忔閮借鍚屼竴鍙ョ被浼肩殑璇濄€?,
	"2. 琚懜鍒颁粈涔堝湴鏂逛笉閲嶈, 閲嶇偣鏄惀閫犲綋涓嬬湡瀹炪€侀矞娲汇€佹湁鎴忕殑姘涘洿鈥斺€斿缇炪€佽垝鏈嶃€佺棐銆侀€楄叮銆佸偛濞囥€佽翰寮€鈥︹€﹂殢浣犲彂鎸? 瓒婃湁瓒ｈ秺濂姐€?,
	"3. AI 涓嶈鎶娿€屼粈涔堣鎽搞€嶈繖浠朵簨鏈烘鍦板杩版垚涓€鎴愪笉鍙樼殑鍥哄畾鍙拌瘝, 褰撲綔涓€娆¤嚜鐒跺彂鐢熺殑浜掑姩鏉ュ洖搴斻€?,
	"4. 鍙洖搴斿綋涓嬶紝鐢?1锝? 鍙ョ畝鐭嚜鐒剁殑璇濓紝涓嶄富鍔ㄥ睍寮€闀跨瘒瀵硅瘽銆?,
].join("\n")

const POKE_DIRECTIVE = [
	"鐢ㄦ埛杞昏交鎴充簡鎴充綘銆傞『鐫€杩欎釜灏忓姩浣滐紝浠庢彁渚涚殑鏃堕棿銆佽繎鍐点€佽蹇嗘垨鐩爣閲岄€変竴涓悎閫傜殑鐐癸紝鑷劧闂茶亰 1锝? 鍙ワ紱涔熷彲浠ユ拻濞囥€佸悙妲姐€佸叧蹇冩垨鍙洖搴斿綋涓嬨€?,
	"涓嶇‖濉炶儗鏅紝涓嶆満姊板杩板姩浣滐紝閬垮厤閲嶅濂楄矾銆?,
].join("\n")


const surface = (content: string) => {
	// 鏄剧ず鍘熸枃 (甯︽爣鐐? 鏇寸ǔ瀹?
	messages.value.push({role: "assistant", content, ts: Date.now()})
	showPortraitReply(content)
	persistChat(messages.value)
	if (chatOpen.value) scrollChatBottom()
	else showAiBubble(content)
}

const handleTouchTrigger = async (area: Pick<TouchArea, "name" | "prompt" | "reactionPrompt">, type: "tap" | "swipe", poke = false) => {
	if (typing.value || chatStreaming.value || touchStreaming.value || (!poke && speaking.value)) return
	const reaction = (area.reactionPrompt ?? "").trim()
	const areaName = area.name || "鏈煡鍖哄煙"
	const pool = type === "swipe" ? SWIPE_VERBS : TAP_VERBS
	const verb = pool[Math.floor(Math.random() * pool.length)]
	const text = poke ? "鐢ㄦ埛姝ｅ湪杞昏交鎴虫埑 Nori" : `鐢ㄦ埛 ${verb} Nori 鐨勩€?{areaName}銆峘
	if (!modelReady.value) { surface("璇峰厛鍦ㄣ€岃缃€嶉噷閰嶇疆 API Key 鍜屾ā鍨?); return }
	// 闃查噸鍏? 瑙︽懜瑙﹀彂瀵硅瘽杩涜涓? 鍐嶆瑙﹀彂鐩存帴蹇界暐 (閬垮厤骞跺彂娴佷簰鐩歌俯韪?
	if (touchStreaming.value) return
	if (poke) {
		ambientTouch()
		stopTTS()
	}
	if (!poke && panel.value === "touch") touchReplyPreview.value = "鈥?
	if (!chatOpen.value) showAiBubble("鈥?)
	// C1 (2026-10-08): 瑙︽懜/鎴虫埑鏄?*銆屾病鏈夊綋鍓嶆彁闂€?*鐨勫満鍚?鈥斺€?text 鏄悎鎴愭弿杩?	// 锛堛€岀敤鎴?鎽告懜 Nori鐨?澶淬€嶃€岀敤鎴锋鍦ㄨ交杞绘埑鎴?Nori銆嶏級锛屾嬁瀹冨仛鍏抽敭璇嶅彫鍥炲熀鏈繀鐒惰惤绌?	// 锛堣瘝闈㈤噸鍙犳槸鍙洖鐨勫繀瑕佹潯浠?鈬?`recallForQuery("")` 涓€绫诲繀鐒剁┖鎵嬭€屽綊锛夈€?	// openingMemoryBlock 姝ｆ槸涓鸿繖绉嶅満鍚堝啓鐨勶細鍏堟寜褰撳墠璇濋鍙洖锛屽啀琛?寮€鍦哄氨璇ョ煡閬?鐨?	// 韬唤/鏍稿績璁板繂锛坱ype=core 鎴?tags 鍚?identity/explicit锛屾垨 importance 鈮?0.8锛夈€?	// 瀹?*鍙涓嶅己鍖?*锛堜笉娑?accessCount锛夆€斺€?鎴虫埑姣忔浼氳瘽閮戒細瑙﹀彂锛岀畻寮哄寲浼氳鍚屼竴鎵归珮鍒?	// 璁板繂姘歌繙闇告锛岀湡姝ｈ繖娆¤闂埌鐨勫弽鑰屾尋涓嶈繘鏉ャ€?	const selection = selectOpeningRecall(text)
	const context: ChatMsg[] = []
	const personaText = personaPrompt()
	if (personaText) context.push({role: "system", content: personaText} as ChatMsg)
	const touchDirective = !poke && reaction
		? `${TOUCH_DIRECTIVE}\n鏈瑙︽懜鍖哄煙鏄€?{areaName}銆嶃€傜敤鎴峰笇鏈涗綘鐨勫弽搴斿弬鑰冿細${reaction}`
		: TOUCH_DIRECTIVE
	context.push({role: "system", content: poke ? POKE_DIRECTIVE : touchDirective} as ChatMsg)
	if (!poke && area.prompt) context.push({role: "system", content: `瑙︽懜鍖哄煙琛ュ厖璇存槑锛?{area.prompt}`} as ChatMsg)
	if (poke) {
		if (pomo.value.phase !== "idle") context.push({role: "system", content: `銆愬綋鍓嶇姸鎬併€戠敤鎴?{pomoPhaseText.value}锛屽彲浠ヨ交杞诲洖搴旓紝鍒偓淇冩垨鎵撴柇銆俙} as ChatMsg)
	}
	const hist = messages.value.filter(m => !m.error).slice(-14).map(({role, content, ts}) => ({role, content, ts}) as ChatMsg)
	
	const payload: ChatMsg[] = [...context, ...hist, {role: "user", content: text, ts: Date.now()}]
	if (poke) {
		messages.value.push({role: "user", content: "锛堟埑鎴筹級", ts: Date.now()})
		persistChat(messages.value)
		scrollChatBottom()
	}

	// 涓庤亰澶╄緭鍏ヤ竴鑷? 娴佸紡鐢熸垚 + 閫愬彞 TTS
	const ttsOn = isTtsReady(cfg)
	if (ttsOn) beginSpeakSession(cfg)

	touchMarkerBuf.value = "" // 鏂颁細璇濋噸缃Е鎽哥殑鏍囪璺ㄥ潡缂撳啿
	touchStreaming.value = true
	let reply = ""
	let pendingSpeech = ""
	// 瀛樺偍/鍘嗗彶鍚堝苟: 涓€娆″洖澶嶅彧瀛樹竴鏉℃秷鎭? 鏄剧ず鏃剁敱 bubbleSegments 鎷嗘垚澶氭皵娉?	let liveBubble: ChatMsg | null = null
	let streamOk = false
	// 鏈浼氳瘽鏄惁鏀跺埌杩囨爣璁?(鏈夋爣璁?鈫?鏀跺熬涓嶅啀鐢ㄦ鏂囧叧閿瘝瑕嗙洊)
	let markerDriven = false

	// 瑙︽懜瑙﹀彂鐨勫璇濈敤鐙珛 abort, 涓庤亰澶╄緭鍏ユ鐨?activeChatAbort 浜掍笉骞叉壈 (閮藉綊鍋滄鎸夐挳绠?
	stopRequested = false
	const chatAbort = new AbortController()
	activeTouchAbort = chatAbort

	const flushSpeech = () => {
		if (!ttsOn || !pendingSpeech) return
		pendingSpeech = stripInternalPromptMetadata(pendingSpeech)
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
					// 鍓ョ闅愯棌鐨勩€愯〃鎯?xxx銆戙€愬姩浣?xxx銆戞爣璁?(鏍囪涓嶆樉绀恒€佷笉鏈楄)
					const {clean, emotion, motion} = parseMarkerDelta(delta, touchMarkerBuf)
					const safeClean = stripInternalPromptMetadata(clean)
					reply = stripInternalPromptMetadata(reply + safeClean)
					pendingSpeech = stripInternalPromptMetadata(pendingSpeech + safeClean)
					flushSpeech()
					if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
					if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
					if (cfg.emotionLlm && motion) playMarkerMotion(motion)
					// 瀛樺偍鍚堝苟: 鍙洿鏂颁竴鏉?liveBubble, 鏄剧ず灞傝嚜鍔ㄦ媶澶氭皵娉?					if (!liveBubble && reply.trim()) {
						liveBubble = {role: "assistant", content: reply, ts: Date.now()}
						messages.value.push(liveBubble)
					} else if (liveBubble) {
						if (reply.trim()) liveBubble.content = reply
						else {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
					}
					if (reply.trim()) {
						showPortraitReply(reply)
						if (chatOpen.value) scrollChatBottom()
					}
				},
				onDone: (content) => {
					streamOk = true
					reply = stripInternalPromptMetadata(reply)
					// content 鍚爣璁? 浼樺厛鐢ㄥ凡鍓ョ鐨?reply; reply 涓虹┖鏃舵暣浣撳墺绂讳竴娆?(绌虹紦鍐?
					if (content && !reply.trim()) {
						const fresh = {value: ""}
						const {clean, emotion, motion} = parseMarkerDelta(content, fresh)
						reply = stripInternalPromptMetadata(clean)
						if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
						if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
						if (cfg.emotionLlm && motion) playMarkerMotion(motion)
						if (!liveBubble && reply.trim()) {
							liveBubble = {role: "assistant", content: reply, ts: Date.now()}
							messages.value.push(liveBubble)
						} else if (liveBubble) {
							liveBubble.content = reply
						}
					}
					touchMarkerBuf.value = ""
					if (liveBubble) {
						if (reply.trim()) liveBubble.content = reply
						else {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
					}
					if (reply.trim()) showPortraitReply(reply)
					else portraitReply.value = ""
					persistChat(messages.value)
					resolve()
				},
				onError: (msg) => {
					const cancelled = stopRequested || msg === "宸插仠姝?
					if (cancelled) showPortraitReply(reply)
					if (!cancelled && !reply.trim()) {
						if (liveBubble) {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
						messages.value.push({role: "assistant", content: `鈿?${msg}`, ts: Date.now(), error: true})
						showPortraitReply(`鈿?${msg}`)
					} else if (liveBubble) {
						liveBubble.content = reply
					}
					persistChat(messages.value)
					resolve()
				},
			}, cfg.deepseekThinking, chatAbort.signal, memoryChatOptions(selection, payload, cfg.timeAware))
		})

		// 鏀跺熬: 鍓╀綑鏂囨湰 + 缁撴潫鏈楄浼氳瘽
		if (ttsOn) {
			const safePendingSpeech = stripInternalPromptMetadata(pendingSpeech)
			if (safePendingSpeech.trim()) speakAppend(cfg, safePendingSpeech)
			pendingSpeech = ""
			endSpeakSession()
		}

		if (streamOk && reply) {
			// 琛ㄦ儏/鍔ㄤ綔: 娴佸紡鏍囪宸插嵆鏃堕┍鍔? 鍙湁瀹屽叏娌℃敹鍒版爣璁版椂鎵嶇敤姝ｆ枃鍏抽敭璇嶅厹搴?			if (!markerDriven) {
				triggerEmotion(reply)
				pickMotionByKeyword(reply)
			}
			void analyzeAfterReply(text, reply)
		}
		// 鑱婂ぉ闈㈡澘娌″紑鏃? 鐢ㄩ《閮ㄥ皬姘旀场鏄剧ず瀹屾暣鍥炲
		if (!chatOpen.value && reply) showAiBubble(reply)
	} catch (e: any) {
		surface(`鈿?${e?.message ?? "璇锋眰澶辫触"}`)
	} finally {
		if (activeTouchAbort === chatAbort) activeTouchAbort = null
		touchStreaming.value = false
	}
}

const pokeNori = (): void => {
	if (!modelReady.value || typing.value || touchStreaming.value || chatStreaming.value) return
	petAudioTouch()
	void handleTouchTrigger({name: "鎴虫埑", prompt: "鎴虫埑浜掑姩"}, "tap", true)
}


const toModel = (clientX: number, clientY: number): {x: number; y: number} | null => {
	const el = l2d.canvas()
	const ms = modelSize()
	if (!el) return null
	return toModelPoint(clientX, clientY, el, ms?.w ?? 0, ms?.h ?? 0)
}


let drawStart: {x: number; y: number} | null = null

let drawDragged = false

let movingOrigin: {x: number; y: number; w: number; h: number} | null = null
let resizingTouch = false


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
	
	if (touchAdjusting.value) {
		const HIT = hitTouch(P)
		if (HIT) {
			beginTouchEdit(HIT.id)
			drawStart = P
			drawingTarget.value = HIT.id
			movingOrigin = {x: HIT.t.x, y: HIT.t.y, w: HIT.t.w, h: HIT.t.h}
			const size = modelSize()
			const layout = modelLayout(l2d.canvas(), size?.w ?? 0, size?.h ?? 0)
			resizingTouch = !!layout && (HIT.t.x + HIT.t.w - P.x) * layout.w < 28 && (HIT.t.y + HIT.t.h - P.y) * layout.h < 28
			touchDraft.value = null
			draftReady.value = false
		}
		return
	}
	drawStart = P
	
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
			if (resizingTouch) {
				previewTouchEdit(t.id, {w: Math.max(0.06, Math.min(1 - t.x, movingOrigin.w + dx)), h: Math.max(0.06, Math.min(1 - t.y, movingOrigin.h + dy))})
				return
			}
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


const onDrawUp = (cancelled = false) => {
	drawStart = null
	
	if (drawingTarget.value) {
		if (cancelled && movingOrigin) previewTouchEdit(drawingTarget.value, movingOrigin)
		drawingTarget.value = null; movingOrigin = null; drawDragged = false; return
	}
	drawingTarget.value = null
	movingOrigin = null
	
	if (touchAdjusting.value) { drawDragged = false; return }
	
	const d = touchDraft.value
	if (!cancelled && d && drawDragged && d.w >= 0.06 && d.h >= 0.06) {
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
const activeStagePointers = new Set<number>()
let petOwnsGesture = false
const petFeedbackEnabled = () => cfg.petTouchEnabled || cfg.petTouchEffects || cfg.petTouchSound || cfg.petTouchSpeech
const claimPetGesture = () => { if (petFeedbackEnabled()) { petOwnsGesture = true; detector.cancel() } }

/* ---------------- 鎵嬫寚瑙︽懜杩借釜 (鍗婇€忔槑灏忕櫧鐐? ---------------- */
const touchDotHost = ref<HTMLElement | null>(null)
/** 姣忎釜娲诲姩鎵嬫寚鐨?dot 鍏冪礌 */
const touchDots = new Map<number, HTMLElement>()

/** 鎵嬫寚鎸変笅: 鍦ㄥ搴斾綅缃敓鎴愮櫧鐐?(鍐呰仈鏍峰紡, 閬垮厤 scoped CSS 涓嶄綔鐢ㄤ簬鍔ㄦ€佸厓绱? */
const spawnTouchDot = (pointerId: number, x: number, y: number) => {
	if (!touchDotHost.value) return
	let dot = touchDots.get(pointerId)
	if (!dot) {
		dot = document.createElement("div")
		// 鍐呰仈鍏ㄩ儴鏍峰紡: 鍔ㄦ€佸垱寤虹殑 div 涓嶅湪 Vue 妯℃澘涓? scoped CSS 涓嶇敓鏁?		Object.assign(dot.style, {
			position: "absolute",
			width: "22px",
			height: "22px",
			borderRadius: "50%",
			background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.4) 55%, rgba(255,255,255,0.1) 100%)",
			border: "1px solid rgba(255,255,255,0.55)",
			boxShadow: "0 0 12px rgba(255,255,255,0.35), inset 0 0 6px rgba(255,255,255,0.3)",
			opacity: "1",
			willChange: "transform",
			transition: "opacity 0.28s ease-out",
			pointerEvents: "none",
			zIndex: "50",
			left: "0",
			top: "0",
		})
		touchDotHost.value.appendChild(dot)
		touchDots.set(pointerId, dot)
	}
	dot.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
	dot.style.opacity = "1"
}

/** 鎵嬫寚绉诲姩: 鏇存柊 dot 浣嶇疆 */
const moveTouchDot = (pointerId: number, x: number, y: number) => {
	const dot = touchDots.get(pointerId)
	if (!dot) return
	dot.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
}

/** 鎵嬫寚鎶捣: 璁?dot 娣″嚭鍚庣Щ闄?*/
const removeTouchDot = (pointerId: number) => {
	const dot = touchDots.get(pointerId)
	if (!dot) return
	touchDots.delete(pointerId)
	dot.style.opacity = "0"
	// 绛夋贰鍑哄姩鐢荤粨鏉熷啀绉婚櫎 DOM
	setTimeout(() => dot.remove(), 300)
}

/* ---------------- 澶撮儴璺熼殢 + 鎶氭懜鍙嶉 ---------------- */
let headFollowActive = false
let headBase = {x: 0, y: 0}
let stroking = false
let strokeTimer: ReturnType<typeof setTimeout> | null = null
let swayRaf = 0
let swayPhase = 0
/** 鏈鎶氭懜寮€濮嬫椂鍒?(绠楀箙搴︽笎寮? 涓庝笂娆″啋鐖卞績鐨勬椂鍒?(鑺傛祦) */
let strokeStartAt = 0
let lastPetFxAt = 0

/** 鎸変綇澶氫箙杩涘叆鎶氭懜鍙嶉 (琛ㄦ儏 + 杞昏弓) */
const STROKE_DELAY = 260
/** 澶撮儴杞昏弓骞呭害璧锋墜鍊?涓婇檺/娓愬己鏃堕暱 涓庢洸绾垮嚱鏁伴兘鍦?petEffect.ts (渚夸簬闂ㄧ鍗曟祴)銆? *  鍙骞呭害闅忔姎鎽告椂闀挎笎寮? 鎽嗗姩**棰戠巼涓嶅彉** 鈥斺€?鏃х増鍥哄畾 10px/0.86Hz 琚瘎浠?鍍忛┈杈惧湪闇?,
 *  闂鍑哄湪棰戠巼鑰屼笉鏄箙搴︺€?*/
/** 杞昏弓鎽嗗姩閫熷害 (rad/甯?: 鎱㈤€熸紓绉绘劅 (鍒绘剰涓嶉殢鎶氭懜鍙樺揩) */
const SWAY_SPEED = 0.045
/** 鍐掓煍鍏夌矑瀛愮殑鑺傛祦闂撮殧 (ms) 鈥斺€?涓?petEffect 鐨勫瓨娲讳笂闄愪竴璧锋妸寮€閿€鍘嬩綇銆? *  鍒绘剰姣旂涓€鐗?220ms)鏇存參銆佷笖姣忔鍙?1 棰? 瀵嗗害浣庢墠"鏌斿拰", 涓嶄細绐佸厐銆?*/
const PET_FX_INTERVAL_MS = 260

/** 鎽稿ご琛ㄦ儏鐨勯┍鍔ㄥ惊鐜?鈥斺€?**鍙湪"姝ｅ湪灞曠ず"鏈熼棿璺?*锛屾敹鍥炲悗鑷姩鍋滐紙涓嶅父椹?rAF锛夈€? *
 *  瑙勬牸锛堢敤鎴峰畾锛? 鍙湪**鎽稿埌澶?*鏃舵挱 shy/smile 浜岄€変竴锛涘仠鎵?1 绉掑唴娌＄户缁懜灏辨敹鍥烇紱
 *  鏀跺洖闈犺〃鎯呰嚜甯︾殑 0.5s 娣″嚭 鈬?涓嶄細鏈夎烦鍙樻劅锛涚姸鎬佸彉鍖栨椂鎵嶈皟搴?鈬?涓嶄細姣忓抚閲嶇疆娣″叆銆? *  鍚嶅瓧鐨勬寫閫?瀹介檺鏈?`EXPRESSION_DENY` 杩囨护閮藉湪 `services/live2d/petExpression.ts`锛堟湁闂ㄧ鍗曟祴锛夈€?*/
let petExprRaf = 0
const startPetExpressionLoop = (): void => {
	if (petExprRaf) return
	const loop = () => {
		const petting = cfg.petTouchEnabled && stroking && onNoriHead          // 瑙勬牸 4: 鍙湁鎽稿埌澶存墠鎾?		const showing = applyPetExpression(performance.now(), petting, expressions.value, {
			play: (n) => {
				// 瑙勬牸 3(鎽稿ご浼樺厛): 椤烘墜鍙栨秷"5 绉掑洖涓€?锛屽惁鍒欏畠鍒扮偣浼?stopExpression 鎶婅繖寮犺劯娓呮帀
				cancelReturnToNeutral()
				try { l2d.playExpression(n) } catch { /* 蹇界暐 */ }
			},
			stop: () => { try { l2d.stopExpression() } catch { /* 蹇界暐 */ } },
		})
		petExprRaf = showing ? requestAnimationFrame(loop) : 0
	}
	petExprRaf = requestAnimationFrame(loop)
}

/* ---------------- 鎽稿ご鍙拌瘝 (TTS) ----------------
 * 瑙勬牸锛堢敤鎴峰畾锛? 鎽稿埌澶?鈫?浠?10 鍙ヨ鏂欓噷闅忔満璇翠竴鍙ワ紱**10s 鍐呭彧璇翠竴娆?*锛涘彧鏈夋懜鍒板ご鎵嶈銆? * 绐楀彛閿氬湪"**涓婁竴娆＄湡鐨勮浜嗚瘽**"锛堥娆℃懜澶村繀瀹氳锛夛紝鍙拌瘝琛?绐楀彛/娲楃墝琚嬮兘鍦? * `services/live2d/petSpeech.ts`锛堢函閫昏緫锛屾湁闂ㄧ锛夛紱杩欓噷鍙"璇ヤ笉璇ュ紑鍙?涓庡憟鐜般€? *
 * 鍛堢幇: 澶嶇敤 AI 閭ｅ姘旀场 `.ai-bubble`锛堣嚜甯?`鈼?Nori` 璇磋瘽浜烘爣绛?鈥斺€?閭ｅ氨鏄?濂瑰紑鍙ｄ簡"鐨勬棦鏈夎瑙夎瑷€锛夛紝
 *      **寮€鍙ｅ嚭鐜般€佽瀹屽嵆鏀?*锛堣窡 `speaking` 鐨?true鈫抐alse 杈规部 鈥斺€?`speak()` 鏄崟鍙戞湕璇伙紝
 *      鎵€浠?濂瑰湪璇寸殑灏辨槸杩欎竴鍙?锛夈€傚彟鎸備竴涓?7s 鍏滃簳: TTS 澶辫触/鏃犲０鏃?audio 姘歌繙涓嶄細 playing锛? *      鍚﹀垯姘旀场浼氫竴鐩存寕鍦ㄩ偅銆? * 涓嶈繘鑱婂ぉ璁板綍: 涓?ambient 鎼瘽鍚岃鏍硷紙鏈湴璇枡涓嶅啓鍘嗗彶銆佷笉杩涜蹇?鎽樿锛夈€? *
 * ## 涓や釜"鐪嬭捣鏉ュ儚杈硅銆佸叾瀹炰細鐪熺殑鍙戠敓"鐨勫潙锛堥兘鍦ㄨ繖閲屽鐞嗭級
 * 1. **鍏滃簳 7s 鍙兘姣?濂硅瀹?杩樻棭**锛歍TS 棣栭煶瑕?1~3s锛屾渶闀夸竴鍙?23 瀛楀張瑕?5s 宸﹀彸
 *    鈬?鏂囧瓧浼氭瘮澹伴煶鍏堟秷澶便€傛墍浠ュ埌鐐规椂**鍙杩樺湪璇村氨缁湡**锛堟渶澶氱画 3 娆★紝缁濆涓婇檺 22s锛? *    闃?playing 鍗′綇"鏃舵皵娉℃案涓嶆秷澶憋級銆? * 2. **`speaking=false` 涓嶇瓑浜?璇村畬浜?**锛氭祦寮忔挱鏀句腑闂翠細鏈夌湡鐨勯潤榛橈紙鍙ラ棿 / WebAudio 鍥為€€
 *    閫愬潡鎾?/ 缃戠粶鍗′竴涓嬶級锛宍player` 閭ｆ椂纭疄浼氭妸 playing 缃洖 false銆傛墍浠? *    鈶?"璇村畬鍗虫敹"瑕?*绛変竴涓?VOICE_TAIL 鍐嶇‘璁?*锛涒憽 闂搁棬涔熻鎶?鍒氶潤涓嬫潵 < VOICE_TAIL"褰撴垚"杩樺湪璇?
 *    鈥斺€?鍚﹀垯閭ｄ竴涓嬬殑鎽稿ご浼?`speak()` 鎵撴柇 Nori 璇村埌涓€鍗婄殑鍥炲銆? */
/** 姘旀场鍏滃簳鏃堕暱: 鐪熷嚭澹版椂鐢?璇村畬鍗虫敹"鎻愬墠鏀舵帀, 杩欎釜鍙槸鏃犲０/澶辫触鏃剁殑淇濋櫓 */
const PET_LINE_BUBBLE_FALLBACK_MS = 7000
/** 鍏滃簳鍒扮偣浣?*杩樺湪璇?*鏃剁殑缁湡姝ラ暱锛堣鏂囦欢澶村潙 1锛?*/
const PET_LINE_BUBBLE_EXTEND_MS = 5000
/** 缁湡娆℃暟涓婇檺锛堢粷瀵逛笂闄?= 7s + 3脳5s = 22s锛夆€斺€?闃?playing 鍗′綇鏃舵皵娉℃案涓嶆秷澶?*/
const PET_LINE_BUBBLE_MAX_EXTEND = 3
/** 鎽稿ご鍙拌瘝鐨?*缁濆瀛樻椿涓婇檺**锛堝厹搴?+ 鍏ㄩ儴缁湡锛?*/
const PET_LINE_BUBBLE_MAX_TOTAL_MS = PET_LINE_BUBBLE_FALLBACK_MS + PET_LINE_BUBBLE_EXTEND_MS * PET_LINE_BUBBLE_MAX_EXTEND
/** "濂瑰垰杩樺湪鍑哄０"鐨勫垽瀹氫綑閲忥紙瑙佹枃浠跺ご鍧?2锛? 娴佸紡鎾斁涓棿鐨勯潤榛樹笉瓒呰繃瀹冨氨绠?杩樺湪璇? */
const PET_LINE_VOICE_TAIL_MS = 700
/** 褰撳墠姘旀场閲屾槸涓嶆槸鎽稿ご鍙拌瘝锛堜笌 `aiBubble` 鍐呭姣斿, 閬垮厤璇竻鎺夊埆浜虹殑姘旀场锛?*/
let petLineBubble = ""
/** 杩欐潯鍙拌瘝鏄惁**鐪熺殑**鎺ㄨ繘鍒拌繃 playing 鈥斺€?娌″嚭杩囧０灏变笉绛?璇村畬", 浜ょ粰鍏滃簳 */
let petLineSpoke = false
let petLineBubbleTimer: ReturnType<typeof setTimeout> | null = null
let petLineExtend = 0
/** 鏈€杩戜竴娆?*纭疄鍦ㄥ嚭澹?*鐨勬椂鍒伙紙`Date.now()`锛夆€斺€?"濂硅繕鍦ㄨ"鐢ㄥ畠鍒? 涓嶇敤 speaking 鐨勭灛鏃跺€?*/
let lastVoiceAt = 0
/** "璇村畬鍗虫敹"鐨勭‘璁ゅ畾鏃跺櫒锛堢瓑涓€涓?VOICE_TAIL 鍐嶆敹, 瑙佹枃浠跺ご鍧?2锛?*/
let petLineVoiceTailTimer: ReturnType<typeof setTimeout> | null = null

const clearPetLineBubble = (): void => {
	if (petLineBubbleTimer) { clearTimeout(petLineBubbleTimer); petLineBubbleTimer = null }
	if (petLineVoiceTailTimer) { clearTimeout(petLineVoiceTailTimer); petLineVoiceTailTimer = null }
	if (petLineBubble && aiBubble.value === petLineBubble) aiBubble.value = ""
	if (petLineBubble && portraitReply.value === petLineBubble) {
		clearPortraitReplyTimer()
		portraitReply.value = ""
	}
	petLineBubble = ""
	petLineSpoke = false
	petLineExtend = 0
}

/** 鍏滃簳鍒扮偣锛氳繕鍦ㄨ灏辩画鏈燂紝鍚﹀垯鏀舵帀锛堣鏂囦欢澶村潙 1锛?*/
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
 * 鎽稿ご鏃跺皾璇曡涓€鍙ャ€?*鍙湪涓ゅ"纭鎽稿埌澶?鐨勮竟娌胯皟鐢?*锛堜笌 `petAudioTouch()` 鍚屾簮锛夈€? * 涓夐亾闂? 鈶?TTS 灏辩华 鈶?涓嶅湪鏈楄/鐢熸垚涓紙璺宠繃涓?*涓嶆秷鑰?*绐楀彛锛?鈶?10s 绐楀彛銆? */
const maybeSpeakPetLine = (): void => {
	// 鈶?娌￠厤 TTS 灏变笉璇达紝涓?*涓嶆秷鑰楃獥鍙?* 鈥斺€?閰嶅ソ Key 鍚庣涓€娆℃懜澶寸収鏍疯兘鍚埌
	if (!isTtsReady(cfg)) return
	// 鈶?"杩樺湪璇? = speaking 涓虹湡 **鎴?* 鍒氶潤涓嬫潵涓嶅埌 VOICE_TAIL锛堟祦寮忔挱鏀句腑闂寸殑闈欓粯, 瑙佹枃浠跺ご鍧?2锛夛紝
	//    鍐嶅姞涓?姝ｅ湪鐢熸垚鍥炲 / 姝ｅ湪鎵撳瓧" 鈫?涓€寰?*璺宠繃銆佷笉鎵撴柇**锛屼笖**涓嶆秷鑰?*绐楀彛
	//    锛堝洖澶嶈瀹屽悗鍐嶆懜涓€娆″氨鑳藉惉鍒帮紝鍙拌瘝涓嶄細鐧戒涪锛?	if (speaking.value || Date.now() - lastVoiceAt < PET_LINE_VOICE_TAIL_MS) return
	if (chatStreaming.value || touchStreaming.value || typing.value) return
	const line = maybePetSpeechLine(performance.now())
	if (!line) return
	// 鈶?鍛堢幇: 鑱婂ぉ闈㈡澘寮€鐫€鏃?*鍙嚭澹颁笉寮规皵娉?* 鈥斺€?`.ai-bubble` 鐨?z-index(58) 楂樹簬闈㈡澘(12),
	//    纭脊浼氱洊鍦ㄨ亰澶╁唴瀹逛笂锛堜笌 ambient 鐨?`if (!chatOpen.value)` 鍚屼竴鍐欐硶锛?	if (!chatOpen.value) {
		petLineBubble = line
		petLineSpoke = false
		petLineExtend = 0
		/* 缁?`showAiBubble` 涓€涓?*姣旀垜浠殑缁濆涓婇檺杩橀暱**鐨勬椂闀? 瀹冭嚜甯︾殑瀹氭椂鍣ㄥ彧璐熻矗
		   "鍒敤榛樿鐨?9s 鎻愬墠鎶规帀", 鐪熸鐨勬敹灏句氦缁?petLineFallback / 璇村畬鍗虫敹銆?		   锛堝師鏉?9s 閭ｄ釜鍊间細鍦ㄨ繖鍙ヨ繕娌¤瀹屾椂灏辨妸瀛楁竻鎺?鈥斺€?闀垮彞 + 棣栭煶鎱㈡椂鐪熶細鍙戠敓銆傦級 */
		showAiBubble(line, PET_LINE_BUBBLE_MAX_TOTAL_MS + 1000)
		if (petLineBubbleTimer) clearTimeout(petLineBubbleTimer)
		petLineBubbleTimer = setTimeout(petLineFallback, PET_LINE_BUBBLE_FALLBACK_MS)
	}
	// 鍗曞彂鏈楄锛堝唴閮ㄤ細鎵撴柇涓婁竴娈?TTS; 鍓嶉潰宸蹭繚璇佷笉鍦ㄦ湕璇讳腑锛屾墍浠ヤ笉浼氬垏鍒板埆浜猴級
	void speakTTS(cfg, line).catch(() => { /* 澶辫触宸茬敱 setTtsErrorHandler 鎻愮ず */ })
}

/* ---------------- 澶撮儴鎷栨嫿璺熼殢 (搴撳師鐢?setDragging; 鏂瑰悜/鐏垫晱搴﹀彲鍦ㄨ缃噷鐜板満璋? ---------------- */
let lookCur = {x: 0, y: 0}
let lookTarget = {x: 0, y: 0}
let lookRaf = 0
/** 娉ㄨ璧风偣鍙垵濮嬪寲涓€娆? 璺ㄨЕ鎽稿欢缁? 鏃犺烦鍙?*/
let lookInit = false

const canvasCenter = (): {x: number; y: number} => {
	const el = l2d.canvas()
	if (!el) return {x: window.innerWidth / 2, y: window.innerHeight / 2}
	return {x: el.clientWidth / 2, y: el.clientHeight / 2}
}

/** 褰撳墠 Live2D 鏈粡杩?CSS 缂╂斁鐨勬ā鍨嬫锛屾墍鏈夎绾跨洰鏍囬兘鍦ㄨ繖涓潗鏍囩郴閲岃绠椼€?*/
const modelFrame = (): {x: number; y: number; w: number; h: number} | null => {
	const el = l2d.canvas()
	if (!el) return null
	const w = el.clientWidth || window.innerWidth
	const h = el.clientHeight || window.innerHeight
	if (w <= 0 || h <= 0) return null
	const ms = modelSize()
	if (!ms?.w || !ms.h) return {x: 0, y: 0, w, h}
	const s = Math.min(w / ms.w, h / ms.h)
	return {x: (w - ms.w * s) / 2, y: (h - ms.h * s) / 2, w: ms.w * s, h: ms.h * s}
}

/**
 * 涓珛鐐?= 妯″瀷娓叉煋妗嗕腑蹇?(鐢?modelLayout 鎸夊綋鍓嶇缉鏀?鍋忕Щ瀹炴椂璁＄畻),
 * 姣旂敾甯冧腑蹇冩洿璐磋繎妯″瀷瀹為檯浣嶇疆, 宸﹀彸杈撳叆浠ュ畠涓鸿酱缁濆瀵圭О.
 */
const lookNeutral = (): {x: number; y: number} => {
	const L = modelFrame()
	if (L && L.w > 0 && L.h > 0) return {x: L.x + L.w / 2, y: L.y + L.h / 2}
	return canvasCenter()
}

/**
 * 鎷栨嫿鑼冨洿鍗婂緞: 鎸?妯″瀷瀹為檯娓叉煋妗?璁＄畻 (妗嗙煭杈?脳 0.4), 涓庣缉鏀炬棤鍏?
 * 搴撶殑鎷栨嫿鏄犲皠鏄ā鍨嬬┖闂粹€斺€斿崐寰勮嫢鎸夌敾甯冪畻, 妯″瀷灏?榛樿缂╂斁)鏃跺悓鏍疯窛绂绘槧灏勬垚宸ㄥぇ妯″瀷鍋忕Щ, 瀵艰嚧瀹氫綅涓嶅噯.
 */
const lookRangeRadius = (): number => {
	const el = l2d.canvas()
	const L = modelFrame()
	if (L && L.w > 0 && L.h > 0) return Math.min(L.w, L.h) * 0.4
	if (!el) return 200
	return Math.min(el.clientWidth, el.clientHeight) * 0.35
}

/** 鏂瑰悜缈昏浆: 鐩存帴缈昏浆褰掍竴鍖栧亸绉荤殑绗﹀彿 (鍘熺偣鍦ㄧ敾甯冧腑蹇? 瑙?toLookTarget) */

/**
 * 鎵嬫寚 鈫?娉ㄨ鐩爣: 杈撳叆褰掍竴鍖栦互"妯″瀷娓叉煋妗嗕腑蹇?涓哄绉拌酱 (缂╂斁/骞崇Щ鏃犲叧,
 * 宸﹀彸缁濆瀵圭О), 浣?*缁濆鍧愭爣浠ョ敾甯冧腑蹇冧负鍘熺偣** 鈥斺€?搴撶殑瑙掑害闆朵綅閿氬畾鍦? * device 涓績 (deviceToScreen 浠ュ畠涓?view 鍘熺偣), 鑻ョ敤妯″瀷妗嗕腑蹇冨綋闆剁偣浼氱暀涓? * 鎭掑畾鍋忚: 鏉炬墜鍥炴鍋滃湪"鐣ュ亸鐨勫Э鎬?涓? 0.5s 鍚庤 resetLook 鎷夊洖鐪熼浂浣?
 * 鑲夌溂鍙鍦拌烦涓€涓?(瀹氫綅浜屾璺?銆傞浂浣嶅繀椤讳笌搴撲竴鑷淬€? */
const toLookTarget = (x: number, y: number): {x: number; y: number} => {
	const el = l2d.canvas()
	if (!el) return {x, y}
	const L = modelFrame()
	const n = lookNeutral()
	const halfW = (L && L.w > 0 ? L.w : el.clientWidth) / 2
	const halfH = (L && L.h > 0 ? L.h : el.clientHeight) / 2
	const p = canvasPointFromClient(x, y, canvasView())
	let dx = clamp((p.x - n.x) / halfW, -1, 1)
	let dy = clamp((p.y - n.y) / halfH, -1, 1)
	// 鏂瑰悜缈昏浆: 缈昏浆鍋忕Щ绗﹀彿 (鍘熺偣鍦ㄧ敾甯冧腑蹇? 缈昏浆鍗崇粫闆朵綅闀滃儚)
	if (cfg.lookFlipX) dx = -dx
	if (cfg.lookFlipY) dy = -dy
	const R = lookRangeRadius()
	const c = canvasCenter()
	return {x: c.x + dx * R, y: c.y + dy * R}
}

/**
 * 杞绘嫧鎰熷脊绨?(甯х巼鏃犲叧, 鍗婇殣寮忔鎷夌Н鍒? 鏇夸唬鏃х殑鎸囨暟鎻掑€?:
 * - follow (鎵嬫寚鎸変綇): 杞窡闅?鈥斺€?鐏垫晱搴﹁缃槧灏勪负鍒氬害 (闃诲凹姣旀亽 0.75),
 *   澶撮儴杩芥墜甯︿竴鐐规粸鍚庝笌杞诲井杩囧啿, 鍍忚杞昏交鎷ㄥ姩鐨勭墿浣? 涓嶉粡鎵?
 * - return (鏉炬墜): 鍥哄畾浣庨€熷脊绨? 鏃犺浣曟椂/浠庝綍澶勬澗鎵嬮兘绾?1.2s 缂撶紦婕傚洖涓珛鐐?
 *   甯︿竴涓濆洖寮? 涓嶅彈鐏垫晱搴﹁缃奖鍝?(鏃у疄鐜板洖姝ｉ€熷害璺熺潃鐏垫晱搴﹁蛋, 鎽稿畬鏀跺緱澶€?.
 * 鎵嬫劅寰皟鍙姩杩欎袱缁勬暟: k 瓒婂皬瓒婄坏杞? c 瓒婂皬鍥炲脊瓒婃槑鏄? */
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
	// 娉ㄨ鐐归檺骞? 寮圭哀甯︽儻鎬? 浣?lookCur 涓嶅厑璁稿啿鍑烘槧灏勮寖鍥?(鐩爣鍦ㄥ崐寰勫湀鍐?
	// 浣嶇疆鍏佽 15% 杩囧啿浣欓噺, 寰勫悜澶栨帹閫熷害娓呴浂) 鈥斺€?鍚﹀垯蹇€熸懜澶翠細鎶婂ご鐢╄繃鐣?
	// 闄愬箙鍦嗗績 = 鐢诲竷涓績 (涓?toLookTarget 鐨勯浂浣嶅師鐐逛竴鑷?
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
	// 搴撶殑鎷栨嫿鏄犲皠鎸夌敾甯?attribute 灏哄 (瀹矫梤enderScale) 褰掍竴鍖? 浣嗚緭鍏ユ寜 脳DPR;
	// 涔樹互 renderScale/DPR 浣挎瘮渚嬫亽涓?1, 浠讳綍娓叉煋鍒嗚鲸鐜囦笅璺熸墜閮戒竴鑷淬€?	// 绯绘暟涓庡懡涓挬瀛?resizeCanvas 鍚屾簮: 浼樺厛璇诲簱瀹為檯鐢熸晥鐨?__noriRenderScale
	const rs = normalizeRenderScale(window.__noriRenderScale, normalizeRenderScale(cfg.renderScale, 1))
	const dpr = window.devicePixelRatio || 1
	const K = rs / dpr
	const distT = Math.hypot(lookTarget.x - lookCur.x, lookTarget.y - lookCur.y)
	// 鏀跺熬娣峰悎 (淇?鍗婄鍚庣獊鐒跺綊浣?): 鎱㈠脊绨х殑闀垮熬浼氳 resetLook 杩熷埌涓€绉掍互涓?
	// 搴撻浂浣嶄笌鏄犲皠闆朵綅鐨勭粏寰樊琚嫋鎴愯倝鐪煎彲瑙佺殑璺冲彉 鈥斺€?璺濈洰鏍囧緢杩戞椂鍒囧揩閫?	// 鎻掑€肩簿鍑嗚惤鐐? 澶撮儴瑙嗚褰掍腑鍚庣珛鍗?resetLook, 涓嶇暀闀垮熬绐楀彛
	if (!headFollowActive && distT < 14) {
		lookCur.x += (lookTarget.x - lookCur.x) * 0.22
		lookCur.y += (lookTarget.y - lookCur.y) * 0.22
		lookVel.x *= 0.6
		lookVel.y *= 0.6
	}
	try { l2d.lookAt(lookCur.x * K, lookCur.y * K) } catch { /* 蹇界暐 */ }
	const speed = Math.hypot(lookVel.x, lookVel.y)
	const done = !headFollowActive && distT < 0.6 && speed < 4
	if (done) {
		lookRaf = 0
		lookVel = {x: 0, y: 0}
		lookLastTs = 0
		try { l2d.resetLook() } catch { /* 蹇界暐 */ }
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
	// 鐪肩彔鐢卞簱鐨?drag 婧愰┍鍔?(涓庡ご閮ㄥ悓涓€ feed, 瑙佷笅鏂?瑙嗙嚎璺熼殢"璇存槑), 鏃犻渶鍗曠嫭椹卞姩
	// 鎸変綇涓€娈垫椂闂翠笉鏉惧紑 鈫?杩涘叆鎶氭懜鍙嶉
	if (strokeTimer) clearTimeout(strokeTimer)
	strokeTimer = setTimeout(() => {
		strokeTimer = null
		if (!headFollowActive) return
		stroking = true
		if (onNoriHead) claimPetGesture()
		// 鎽稿ご琛ㄦ儏: 浜ょ粰涓撶敤寰幆锛堝畠鑷繁鍒?鏄笉鏄懜鍒板ご"銆佸闄愭湡涓庢敹鍥烇級
		if (cfg.petTouchEnabled) startPetExpressionLoop()
		// "鍒氭懜鍒?鐨勪竴璁?(绉绘鑷綉椤电増 w8e + h8e): 鍙湪**鎽稿埌澶?*鏃跺搷/鍐?		if (onNoriHead) {
			if (cfg.petTouchSound) petAudioTouch()
			if (cfg.petTouchEffects) spawnPetTouchBurst(headBase.x, headBase.y - 10)
			// 鎽稿ご鍙拌瘝: 涓?鎽稿埌浜?鐨勯煶鏁?*鍚屾簮**锛堝悓涓€澶勮竟娌匡級鈬?璇箟澶╃劧涓€鑷? 浠ュ悗涓嶄細婕傜Щ銆?			// 绐楀彛/闅忔満/鍘婚噸閮藉湪 petSpeech.ts; 杩欓噷鍙"璇ヤ笉璇ュ紑鍙?涓庡憟鐜帮紙瑙?maybeSpeakPetLine锛夈€?			if (cfg.petTouchSpeech) maybeSpeakPetLine()
		}
		startSway()
	}, STROKE_DELAY)
}

const updateHeadLook = (x: number, y: number) => {
	if (!headFollowActive) return
	headBase = {x, y}
	if (stroking) return // 鎶氭懜涓敱 sway 鎺у埗, 閬垮厤鍜岀洰鏍囨姠
	lookTarget = toLookTarget(x, y)
}

/** 鎶氭懜鏈熼棿澶撮儴杞诲井鎽嗗姩 (妯℃嫙"琚懜寰楄垝鏈嶃€佽交杞昏弓" ) + 鍐掔埍蹇? *  骞呭害闅忚繛缁姎鎽告椂闀挎笎寮?(鏇茬嚎鍦?petEffect.ts, 鏈夊崟娴?; 棰戠巼鎭掑畾銆?*/
const startSway = () => {
	stopSway()
	swayPhase = 0
	strokeStartAt = Date.now()
	lastPetFxAt = 0
	const loop = () => {
		if (!headFollowActive || !stroking) return
		const now = Date.now()
		const amp = cfg.petTouchEnabled ? petSwayAmp(now - strokeStartAt) : 0
		swayPhase += SWAY_SPEED
		const dx = Math.sin(swayPhase) * amp
		const dy = Math.cos(swayPhase * 1.3) * amp * 0.7
		/* 鎽稿ご鏃?*淇濈暀瑙嗙嚎杩借釜**: 娉ㄨ鐩爣浠嶇劧璺熺潃鎵嬫寚(headBase), 鍙槸鍙犱竴鐐?骞呭害娓愬己"鐨勮交寰憜鍔ㄣ€?		   锛堟懜澶?浣庡ご"宸叉寜鐢ㄦ埛鍐冲畾**鍒犻櫎** 鈥斺€?瀹冭涔堜笌搴撴瘡甯у啓鐨勬敞瑙嗛€氶亾鎶㈠弬鏁般€佽涔堟寜涓嬪嵆婊′骇鐢?		     "澶撮儴瑙掑害璺冲彉"锛涚幇鍦ㄦ懜澶寸殑鍙嶉鏄?*琛ㄦ儏 + 鍙拌瘝**锛岃 petExpression.ts 涓?petSpeech.ts銆?		     瀹為檯鏁版嵁鐣欐。鍦?docs/浣庡ご鍙傛暟鎺㈤拡.md 涓?backups\浣庡ご閲嶅仛涓庡弬鏁板綊灞炴姢鏍?20260924-232222\銆傦級 */
		lookTarget = toLookTarget(headBase.x + dx, headBase.y + dy)
		// 杞婚噺鐗规晥: 浠庢墜鎸囦綅缃線涓婂啋**鏌斿厜鐧界矑瀛?* (鑺傛祦 + petEffect 鍐呴儴鏈夊瓨娲讳笂闄? 涓嶄細鍫嗙Н)銆?		// 鍙湪**鎽稿埌澶?*鏃舵墠鍐?鈥斺€?onNoriHead = 鍛戒腑瀹炰綋 涓?钀藉湪澶村甫鍐?閮ㄤ欢鍑犱綍绠楀嚭鏉ョ殑)銆?		// 鍚﹀垯鎽告墜/鎽歌剼/鍦?Nori 鏃佽竟鐨勭┖鐧藉鎸変綇閮戒細鍐掔矑瀛愩€?		// 姣忔鍙?1 棰椼€佸嘲鍊奸€忔槑搴﹀彧鏈?0.42~0.66 鈥斺€?鐩爣鏄?鐪嬪緱瑙佷絾涓嶇獊鍏€"銆?		if (cfg.petTouchEffects && onNoriHead && now - lastPetFxAt >= PET_FX_INTERVAL_MS) {
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

/* ---------------- 瑙嗙嚎璺熼殢 (鐪肩彔) ----------------
 * 璁捐璇存槑: 搴撶殑姣忓抚鏇存柊鏈韩灏变細鎶?drag 鍊煎彔鍔犺繘 ParamAngleX/Y 涓?ParamEyeBallX/Y
 * (live2dEasyControl update: addParameterValueById(EyeBallX, dragX)),
 * 鍗崇溂鐝犲ぉ鐒惰窡闅?lookAt 鐨勫杺鐐? 姝ゅ墠鎴戜滑鍙﹁捣涓€濂?gazeLoop 鐩存帴 setParam 鍐欑溂鐝?
 * 涓庡簱鐨勫彔鍔犲啓鍏ュ弻閲嶉┍鍔?鈥斺€?鏂瑰悜缈昏浆璁剧疆鍙綔鐢ㄤ簬澶撮儴 feed, 鐪肩彔涓嶈窡闅忕炕杞?
 * 涓旀澗鎵嬪悗搴撶殑 dragX 闅忓ご閮ㄦ參鍥炴鎸佺画鍙犲姞, 閫犳垚"澶村凡鍥炴銆佺溂杩樼湅鍚戜竴渚?
 * 鍗婄鍚庡張绐佺劧褰掍綅"鐨勯敊浣嶈鎰? 鐜板湪鍒犳帀鐙珛鐪肩彔椹卞姩, 鐪?澶村悓婧愬悓鍚?
 * 鍚屼竴涓?toLookTarget 鍠傜偣 (鍚柟鍚戠炕杞?妯″瀷妗嗗弬鑰冪郴), 澶╃劧鍚屾鍥炴. */

const endHeadFollow = () => {
	const wasActive = headFollowActive
	headFollowActive = false
	stroking = false
	onNoriHead = false
	if (strokeTimer) { clearTimeout(strokeTimer); strokeTimer = null }
	stopSway()
	// 鎶氭懜浼氳瘽缁撴潫: 澶嶄綅閲囨牱鍣?+ 璁╁悎鎴愰煶褰掗浂 (瀵瑰簲缃戦〉鐗堢殑 AK)銆?	// 鏀惧湪杩欓噷鑰屼笉鏄?pointerup, 鏄洜涓?婕忔帀鎶捣浜嬩欢"涔熻鑳芥敹灏俱€?	petStroke.end()
	petAudioRelease()
	if (hitDebug.value) petDebugText.value = petStrokeDebug()
	// 澶撮儴鍥炴: 鍥炲埌"鐢诲竷涓績" 鈥斺€?搴撶殑瑙掑害闆朵綅閿氬畾鍦?device 涓績, 褰掍綅鍗崇湡闆朵綅,
	// resetLook 鍙槸纭鎬х殑褰掗浂, 涓嶄細鍐嶅嚭鐜?鍏堝仠鍦ㄦ煇濮挎€併€佸崐绉掑悗璺冲洖姝ｄ腑"鐨勪簩娈佃烦
	if (wasActive) {
		lookTarget = canvasCenter()
		startLookLoop()
	}
}

const onStagePointerDown = (e: PointerEvent) => {
	const onUI = (elm: EventTarget | null): boolean =>
		!!(elm as HTMLElement)?.closest?.("button, input, textarea, select, a, summary, [role=button], .sheet, .dock, .topbar, .pet-fab, .chat-panel, .touch-editor, .touch-top, .pomo-widget, .side-rail, .side-rail-mask, .intro-mask, .gate-mask")
	if (onUI(e.target) || e.button !== 0) return
	if (panel.value !== "" && !(panel.value === "touch" && (touchDrawing.value || touchAdjusting.value || touchTesting.value))) return
	activeStagePointers.add(e.pointerId)
	stagePointers = activeStagePointers.size
	if (stagePointers === 1) petOwnsGesture = false
	try { document.querySelector<HTMLElement>(".stage-root")?.setPointerCapture(e.pointerId) } catch { /* 鏃?WebView 鍙兘涓嶆敮鎸?*/ }
	ambientTouch()
	habitRecord("touch")
	if (stagePointers > 1) { detector.cancel(); endHeadFollow(); onDrawUp(true); return }

	if (touchDrawing.value || touchAdjusting.value) {
		if (onUI(e.target)) return
		onDrawDown(e)
		return
	}
	if (touchTesting.value && panel.value === "touch") {
		if (onUI(e.target)) return
		if (stagePointers > 1) { detector.cancel(); return }
		if (!detector.hitTest(e.clientX, e.clientY)) triggerBubble("鏈懡涓嚜瀹氫箟鍖哄煙")
		detector.onPointerDown(e)
		return
	}

	if (panel.value !== "") { if (stagePointers > 1) { endHeadFollow(); detector.cancel() }; return }
	if (stagePointers > 1) { endHeadFollow(); detector.cancel(); return }

	if (onUI(e.target)) return
	// 鐣欑櫧/瀹炰綋鍛戒腑鍒嗘祦: 鍙湁鐐瑰湪妯″瀷瀹炰綋 (浠绘剰鍙閮ㄤ欢) 涓婃墠瑙﹀彂鎽稿ご鍒ゅ畾;
	// 绌虹櫧鍖哄煙 = 鍙繚鐣欑櫧鐐?绮掑瓙/瑙嗙嚎璺熼殢 (濂瑰湪鐪嬩綘鐨勬墜鎸? 浣嗕笉绠楁懜濂?
	const hit = noriHitTest(e.clientX, e.clientY)
	strokeOnModel = !!hit && hit.hit
	if (hitDebug.value) hitZoneText.value = zoneText(hit)
	spawnTouchDot(e.pointerId, e.clientX, e.clientY)
	// 鏁版嵁娴锋槦灏樼矑瀛? 瑙︽懜鍝嶅簲浠?*鎸変笅**杩欎竴鍒诲紑濮嬶紙寮哄害杩樿 350ms 娓愬叆 鈬?涓嶄細涓€纰板氨鍔級銆?	// 鏀惧湪 `onUI` 闂搁棬涔嬪悗锛氱偣闈㈡澘鎸夐挳涓嶈鎼呭姩鑳屾櫙锛堜笌鐧界偣鍚岃鐭╋級銆?	dataseaTouchStart(e.clientX, e.clientY)
	// "鎽稿埌澶? = 鍛戒腑瀹炰綋 **涓?* 钀藉湪澶村尯鍐?鈥斺€?杩欎竴鍒诲厛绠椾竴娆? 涔嬪悗鐢?pointermove 瀹炴椂鏇存柊
	// (鍘熸潵鍙湪杩欓噷绠椾竴娆? 瀵艰嚧"鎸変笂灏变竴鐩寸畻澶翠笂 / 鎸夊湪鍒灏辨€庝箞绉婚兘涓嶇畻")銆?	refreshHeadBox()
	if (strokeOnModel && touchEnabled.value && !touchReplyBusy()) detector.onPointerDown(e)
	// AudioContext 蹇呴』鍦?*鐪熷疄鐢ㄦ埛鎵嬪娍**閲岃В閿? 鎶氭懜闊虫槸鍦ㄦ寚閽堢Щ鍔?/ setTimeout 閲岃Е鍙戠殑,
	// 閭ｄ袱澶勪笉绠楁墜鍔?鈥斺€?閭ｆ椂鎵?new AudioContext() 浼氫竴鐩村仠鍦?suspended銆?	// 鎽稿埌妯″瀷灏遍鐑?涓嶅繀绛夊埌鎽稿埌澶?, 杩欐牱涔嬪悗鎵嬫寚婊戝埌澶村尯鏃跺０闊崇珛鍒诲氨鏈夈€?	if (strokeOnModel && cfg.petTouchSound) petAudioPrime()
	updateNoriHead(e.clientX, e.clientY, true)
	startHeadFollow(e.clientX, e.clientY)
}

const onStagePointerMove = (e: PointerEvent) => {
	if (stagePointers > 0 && !activeStagePointers.has(e.pointerId)) return
	// 鍙湪"宸叉寜涓?鏃舵湁鏁堬紙鎮仠/榧犳爣绉诲姩涓嶇畻瑙︽懜锛涙湭鎸変笅鏃舵槸绌烘搷浣滐級
	dataseaTouchMove(e.clientX, e.clientY)
	if (touchDrawing.value || touchAdjusting.value) { if (stagePointers === 1 && activeStagePointers.has(e.pointerId)) onDrawMove(e); return }
	if (touchTesting.value && panel.value === "touch") {
		if (stagePointers > 1) detector.cancel()
		else if (stagePointers > 0) detector.onPointerMove(e)
		return
	}
	if (hitDebug.value) {
		const now = performance.now()
		if (now - lastHitDebugT > 150) {
			lastHitDebugT = now
			hitZoneText.value = zoneText(noriHitTest(e.clientX, e.clientY))
			petDebugText.value = petStrokeDebug()
		}
	}
	if (panel.value !== "" || stagePointers > 1) { if (stagePointers > 1) detector.cancel(); return }
	moveTouchDot(e.pointerId, e.clientX, e.clientY)
	// 瀹炴椂閲嶅垽鏄惁鎽稿埌澶?(鑺傛祦 100ms) 鈥斺€?鎵嬫寚鍙互闅忔椂婊戣繘/婊戝嚭澶村尯
	updateNoriHead(e.clientX, e.clientY)
	if (strokeOnModel) detector.onPointerMove(e)
	// **蹇呴』鍏堢湡鐨勬寜鐫€**: `pointermove` 鍦ㄩ紶鏍囨偓鍋滄椂涔熶細娲惧彂 (buttons=0), 鑰屾姎鎽哥殑閲囨牱/闊虫晥/
	// 鐗规晥鍘熷厛鍙垽 `onNoriHead` 鈥斺€?浜庢槸"榧犳爣鎸囬拡鍒掕繃 Nori 澶撮《"灏变細鍐掔矑瀛愩€佸搷闊?(瀹炴満/娴忚鍣ㄥ疄娴?
	// 鎮仠 1.44s 鍐掍簡 5 棰楃矑瀛?+ 3 鐏姳 + 3 娑熸吉)銆傜敤鎴疯姹? 鍙湁鐪熸鎸変笅鎵嶈Е鍙戙€?	const pressed = stagePointers > 0
	if (pressed && onNoriHead) {
		// 鎶氭懜閲囨牱: 鍚堟牸鐨勭Щ鍔?鈫?鎽╂摝闊抽殢閫熷害鍙樺搷鍙樹寒; 绱婊?requiredMs 鈫?瀹屾垚涓€娆?		const p = petStrokePoint(e.clientX, e.clientY)
		const s = petStroke.move(performance.now(), p.x, p.y)
		if (s.qualifying) { claimPetGesture(); petLastVx = s.velocityX; if (cfg.petTouchSound) petAudioStroke(s.velocityX) }
		// 绱婊?requiredMs = 瀹屾垚涓€娆? 濂栧姳鐖嗗彂 (缃戦〉鐗?p8e) + 鍙屾闊虫晥 (缃戦〉鐗?S8e)
		if (s.completed) {
			petCompletions += 1
			if (cfg.petTouchSound) petAudioComplete()
			if (cfg.petTouchEffects) spawnPetComplete(e.clientX, e.clientY)
		}
	}
	updateHeadLook(e.clientX, e.clientY)
}

const onStagePointerUp = (e: PointerEvent) => {
	if (!activeStagePointers.delete(e.pointerId)) return
	const wasCancelled = e.type === "pointercancel" || e.type === "lostpointercapture"
	const petWasActive = petOwnsGesture
	stagePointers = activeStagePointers.size
	removeTouchDot(e.pointerId)
	// 鎶墜/鍙栨秷閮借鏀跺熬锛坧ointercancel 涔熸帴鍒拌繖閲岋級鈥斺€?鍚﹀垯鐘舵€佹満浼氫竴鐩村仠鍦?鎸夌潃"
	dataseaTouchEnd()
	strokeOnModel = false
	// **鏀跺熬蹇呴』鍦ㄩ潰鏉垮垽鏂箣鍓?*: 鍘熷厛 `panel !== ""` 鐩存帴 return, 浜庢槸"鎽稿ご閫斾腑闈㈡澘琚墦寮€銆?	// 鎶墜浜嬩欢姝ｅソ琚繖涓€鏉″悶鎺?鏃? stroking/headFollowActive 浼氭案杩滃仠鍦?true 鈥斺€?	// 涔嬪悗榧犳爣**鎮仠**鍒掕繃澶撮儴灏变細鎶?鍒氭懜鍒?鐨勯偅涓€璁?瑙﹀埌闊?+ 鐏姳娑熸吉)鍙嶅閲嶆斁銆?	// endHeadFollow 鏈韩鍙槸澶嶄綅鐘舵€?+ 璁╂敞瑙嗗洖姝? 涓庨潰鏉挎槸鍚﹀彲瑙佹棤鍏? 鏀惧湪杩欓噷涓嶄細璇激闈㈡澘閫昏緫銆?	endHeadFollow()
	if (touchDrawing.value || touchAdjusting.value) { onDrawUp(wasCancelled); return }
	if (touchTesting.value && panel.value === "touch") {
		if (wasCancelled) detector.cancel()
		else detector.onPointerUp(e)
		return
	}
	if (panel.value !== "") return
	if (wasCancelled) { detector.cancel(); return }
	if (petWasActive) {
		detector.cancel()
		return
	}
	detector.onPointerUp(e)
}

const cancelStageInteraction = () => {
	for (const id of activeStagePointers) removeTouchDot(id)
	activeStagePointers.clear()
	stagePointers = 0
	petOwnsGesture = false
	strokeOnModel = false
	endHeadFollow()
	detector.cancel()
	onDrawUp(true)
	dataseaTouchEnd()
	for (const id of Object.keys(gesture)) delete gesture[Number(id)]
}

/** 鍔犺浇/涓嬭浇涓殑瀹堝崼: pick() 鍘熷厛鏃犲畧鍗? 蹇€熺偣涓や釜妯″瀷浼氬苟鍙戜袱娆?loadModel 鈫? *  绗簩娆?ensureModel 瑕嗙洊绗竴娆＄殑鍏ㄥ眬鍥炶皟 鈫?绗竴涓?Promise 姘镐箙鎸傝捣銆? *  杩欓噷鐩存帴鎷︿綇閲嶅叆 (闈㈡澘閲岃繛鐐逛篃涓嶄細鍐嶄骇鐢熷苟鍙?銆?*/
let modelSwitching = false

const loadModel = async () => {
	const id = currentModelId.value
	if (!id) return
	if (modelSwitching) return   // 宸叉湁鍒囨崲鍦ㄩ€? 蹇界暐杩欐 (閬垮厤骞跺彂瑕嗙洊涓嬭浇鍥炶皟)
	modelSwitching = true
	// 绂荤嚎/鍒楄〃澶辫触鏃舵ā鍨嬩笉鍦?modelList 閲? 鐢?id 鍏滃簳 (鍚嶅瓧浠呯敤浜庝笅杞借繘搴︽樉绀?
	const model = modelList.value.find((m) => m.id === id)
	const name = model?.name ?? id
	loading.value = true; error.value = ""; ready.value = false
	motions.value = []; expressions.value = []
	try {
		loadingMsg.value = `涓嬭浇 ${name}鈥
		const entryBase = await ensureModel(id, name)
		loadingMsg.value = "鍔犺浇涓€?
		await l2d.destroy()
		// 鎹㈡ā鍨嬪悗閲嶇疆娉ㄨ鐘舵€?(鐪肩彔鐢卞簱 drag 婧愰┍鍔? 闅忔ā鍨嬮噸寤鸿嚜鍔ㄥ綊浣?
		lookInit = false
		lookRaf = 0
		await l2d.mount({directory: id, fileBase: entryBase}, {canvasWidth: "100%", canvasHeight: "100%", host: l2dHost.value})
		/* WebGL 涓婁笅鏂囦涪澶辨仮澶嶃€傝鑼? **鍙湁** webglcontextlost 琚?preventDefault(), 娴忚鍣ㄦ墠浼氬皾璇曟仮澶嶄笂涓嬫枃銆?		   涓荤晫闈㈡鍓嶉浂澶勭悊 (鍏ㄥ簱 4 澶勫叏鍦?FloatApp.vue) 鈬?harness 瀹炴祴: 涓㈠け浜嬩欢 defaultPrevented=false,
		   涓?*杩炴樉寮?restoreContext() 閮芥病鑳芥仮澶?* = 鍙兘閲嶅惎 App銆?		   鐪熸満涓婃伅灞?鍒囧悗鍙?鍐呭瓨鍘嬪姏閮戒細瑙﹀彂, 姒傜巼杩滈珮浜庢闈?鈥斺€?杩欒烦鐓?FloatApp.vue 琛ラ綈銆?		   姣忔 mount 閮芥槸鏂扮敾甯? 鏃х敾甯冪殑鐩戝惉闅忓畠涓€璧疯绉婚櫎, 涓嶄細绱Н銆?*/
		try {
			const cv = l2d.canvas()
			cv?.addEventListener("webglcontextlost", (e) => e.preventDefault())
			/* 鈿?涓嶈兘鐩存帴璋?loadModel(): 瀹冨紑澶存湁 `if (modelSwitching) return` 瀹堝崼銆?			   鑻ヤ笂涓嬫枃鎭㈠鏃舵濂芥湁涓€娆℃ā鍨嬪垏鎹㈠湪閫旓紝杩欐鎭㈠浼氳**闈欓粯鍚炴帀**銆佷箣鍚庡啀涔熶笉浼氶噸璇?			   鈬?褰㈣薄涓€鐩撮粦鐫€銆傛墍浠ヨ繖閲岀瓑瀹堝崼閲婃斁鍚庡啀閲嶆寕锛堟渶澶氱瓑 10s锛岃秴鏃跺氨鏀惧純杩欎竴杞級銆?*/
			cv?.addEventListener("webglcontextrestored", () => {
				const retry = (n: number): void => {
					if (!modelSwitching) { loadModel(); return }
					if (n < 20) setTimeout(() => retry(n + 1), 500)
				}
				retry(0)
			})
		} catch { /* 蹇界暐 */ }
		// 璇讳簡灏卞す涓€娆? 涓嬮檺 0.6锛堜笌鍙屾寚缂╂斁鍚屼竴鍖洪棿锛夆€斺€?鍚﹀垯浠ュ墠瀛樿繃 0.3 鐨勬満鍣ㄨ繕浼氱収鏃у姞杞?0.3
		scale.value = clamp((await readModelConfig(id, "l2d_scale", (v) => (typeof v === "number" ? v : parseFloat(String(v))), 1.12)) || 1.12, 0.6, 3)
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
		modelSwitching = false   // 閲婃斁瀹堝崼 (蹇呴』鍦?finally: 澶辫触/瓒呮椂璺緞涔熻鏀?
	}
}

/** 銆岄€夋ā鍨嬨€嶇殑钀藉湴鐐癸細璁伴€夋嫨 鈫?钀界洏 鈫?鍔犺浇锛堝凡瑁?鐩存帴鍒囷紱娌¤=璧?ensureModel 涓嬭浇锛夈€? *  鎶藉嚭鏉ユ槸鍥犱负瀹冪幇鍦ㄦ湁涓や釜鍏ュ彛锛氬凡瑁呯殑鐩存帴璧?/ 娌¤鐨勮绛夌瓟棰橀棬鏀捐銆?*/
const applyModelPick = (id: string): void => {
	currentModelId.value = id
	// 2026-09-30 淇細鎶婇€夋嫨**钀界洏**锛屽惁鍒欓噸鍚細鍥炲埌"宸茶鍒楄〃绗竴涓?锛堢敤鎴锋姤鐨?bug锛?	cfg.live2dModel = id
	persistSettings()
	panel.value = ""
	loadModel()
}

/** 鐐广€岄€夋嫨妯″瀷銆嶉噷鐨勫崱鐗囷細宸茶鐨勭洿鎺ュ垏锛?*娌¤鐨勯偅鍙紝鐐瑰畠灏辨槸瑕佷笅杞?* 鈥斺€? *  鍜屻€屼竴閿厠闅嗐€嶅悓涓€閬撱€屾ā鍨嬫巿鏉冮獙璇併€嶏紝绛斿鎵嶇湡鐨勫紑濮嬩笅杞斤紙绛旈敊/鍙栨秷閮戒笉涓嬭浇锛夈€? *  涓嬭浇閫昏緫鏈韩娌″姩锛氭斁琛屽悗浠嶆槸 loadModel 鈫?ensureModel 鈫?NoriBridge.download锛堝師鐢?ModelBridge锛? *  婧?https://fc39e5fc.pinme.dev 鏈敼锛夈€?*/
const pick = (id: string): void => {
	if (id === currentModelId.value && ready.value) return
	void (async () => {
		if (await getInstalled(id)) { applyModelPick(id); return }
		openGate("model", () => applyModelPick(id))
	})()
}

const doMotion = (group: string, i: number) => {
	void l2d.playMotionByIndex(group, i)
	// 鎵嬪姩浠庛€屽姩浣滃垪琛ㄣ€嶈Е鍙戠殑鍔ㄤ綔鍚屾牱鏄?Loop:true, 涔熶細涓€鐩翠繚鎸?鈥斺€?涓€骞跺畨鎺掑洖涓€?	scheduleReturnToNeutral(returnToNeutral)
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

/** 钀界洏(鏈疄渚嬮槻鎶栧啓)鍚庝粠纾佺洏閲嶈浇璁板繂 cache 骞跺埛鏂拌鍥?鈥斺€?鍙屽疄渚嬪彲瑙佹€?
 *  鎮诞绐楃瓑鍙︿竴 WebView 鍐欏叆鐨勬柊璁板繂, 鏈疄渚嬩笉閲嶈灏辩湅涓嶅埌 ("鎮诞绐楄亰鐨勬病璁颁綇" 鐨勬牴鍥犱箣涓€) */
const refreshMemFromDisk = () => {
	void flushMemoryPersist().then(() => {
		reloadMemory()
		refreshMemView()
	})
}

const openPanel = (p: P) => {
	sideRailOpen.value = false
	imageMenu.value = false
	if (p === "settings" && panel.value !== p) settingsTab.value = "basic"
	// 鎵撳紑/鍏抽棴浠讳綍闈㈡澘閮介噸缃?璁板繂搴撳叆鍙?鐨勮繛鍑昏鏁?鈥斺€?鍚﹀垯璁℃暟浼氳法鍦烘櫙绱Н
	// (鐢ㄦ埛鐐逛袱涓嬪叆鍙ｃ€佸幓鍒殑闈㈡澘閫涗竴鍦堛€佸洖鏉ョ偣涓€涓嬪氨鐩存帴杩涘幓浜?
	resetMemEntryGate()
	// 鎵撳紑璁剧疆/璁板繂搴撴椂: 鍏堝埛鏂?閲嶈纾佺洏)鍐嶆樉绀? 鍚﹀垯鐪嬪埌鐨勬槸鍚姩鏃剁殑鏃у揩鐓?	if (p === "settings" || p === "memories") {
		refreshMemFromDisk()
		if (p === "memories") { memSearch.value = ""; memFilter.value = "" }
	}
	if (p === "diary") scheduleDiary()
	panel.value = panel.value === p ? "" : p
}



const gesture = reactive<Record<number, {x: number; y: number}>>({})
let pinchBase = {dist: 0, midX: 0, midY: 0, scale: 1, ox: 0, oy: 0}

// 涓荤敾甯冨彧閿佷綅缃笌缂╂斁锛屼繚鐣欐姎鎽稿拰鑱婂ぉ浜掑姩锛涗笉褰卞搷鐙珛鎮诞绐椼€?const CANVAS_LOCK_KEY = "l2d_canvas_locked"
const canvasLocked = ref((() => {
	try { return localStorage.getItem(CANVAS_LOCK_KEY) === "1" } catch { return false }
})())
let modelTagTimer: ReturnType<typeof setTimeout> | null = null
let modelTagPointer: {id: number; x: number; y: number} | null = null
let modelTagClickSuppressed = false

const toggleCanvasLock = (): void => {
	canvasLocked.value = !canvasLocked.value
	for (const id of Object.keys(gesture)) delete gesture[Number(id)]
	pinchBase = {dist: 0, midX: 0, midY: 0, scale: 1, ox: 0, oy: 0}
	flushTransformSave()
	try { localStorage.setItem(CANVAS_LOCK_KEY, canvasLocked.value ? "1" : "0") } catch { /* 淇濈暀鏈鐘舵€?*/ }
}

const cancelModelTagPress = (suppressClick = false): void => {
	if (suppressClick && modelTagPointer) modelTagClickSuppressed = true
	if (modelTagTimer) clearTimeout(modelTagTimer)
	modelTagTimer = null
	modelTagPointer = null
}

const onModelTagDown = (event: PointerEvent): void => {
	if (!event.isPrimary || event.button !== 0) { cancelModelTagPress(true); return }
	cancelModelTagPress()
	modelTagClickSuppressed = false
	modelTagPointer = {id: event.pointerId, x: event.clientX, y: event.clientY}
	;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
	modelTagTimer = setTimeout(() => {
		modelTagTimer = null
		modelTagClickSuppressed = true
		toggleCanvasLock()
	}, 700)
}

const onModelTagMove = (event: PointerEvent): void => {
	const press = modelTagPointer
	if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelModelTagPress(true)
}

const onModelTagSpace = (event: KeyboardEvent): void => {
	if (!event.repeat) { cancelModelTagPress(); modelTagClickSuppressed = false; toggleCanvasLock() }
}

const onModelTagClick = (): void => {
	if (modelTagClickSuppressed) { modelTagClickSuppressed = false; return }
	openPanel("model")
}

const isUI = (t: Touch): boolean =>
	!!(t.target as HTMLElement)?.closest?.(".sheet, .chat-panel, .dock, .topbar, .side-rail, .side-rail-mask")

const onTouchStart = (e: TouchEvent) => {
	if (panel.value === "touch") return
	if (canvasLocked.value) return
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
	if (canvasLocked.value) return
	// 鍙洿鏂拌捣鎵嬫椂鐧昏鐨勭敾甯冭Е鐐癸紝涓嶈兘鎶?UI 涓婄殑鎵嬫寚閲嶆柊绠楄繘鎹忓悎銆?	for (const t of Array.from(e.touches)) {
		if (gesture[t.identifier]) gesture[t.identifier] = {x: t.clientX, y: t.clientY}
	}
	const pts = Object.values(gesture)
	if (pts.length !== 2) return
	const [a, b] = pts
	const dist = Math.hypot(a.x - b.x, a.y - b.y)
	const midX = (a.x + b.x) / 2
	const midY = (a.y + b.y) / 2
	if (pinchBase.dist > 0) {
		/* 缂╂斁涓嬮檺浠?0.3 鎻愬埌 0.6锛?026-10-05锛夈€?.3 鏃惰鑹插彧鍗犲睆骞曠害 1%锛?		   鑰?Live2D 鐢诲竷**濮嬬粓鏄暣涓鍙?*銆佷笉璺熺潃缂╂斁鍙?鈬?閭ｇ鎯呭喌涓嬬瓑浜庝负 99% 鐨勭┖鐧?		   鐓т环浠?姣忓抚娓呭睆 + 鍚堟垚"銆傚疄闄呬篃娌℃湁缂╁埌閭ｄ箞灏忕殑闇€姹傦紝鎵€浠ョ洿鎺ユ妸涓嬮檺鎶笂鏉ワ紝
		   浠庢簮澶翠笂涓嶅嚭鐜伴偅涓敾闈€傝鍥為€€灏辨妸 0.6 鏀瑰洖 0.3銆?*/
		scale.value = clamp(pinchBase.scale * (dist / pinchBase.dist), 0.6, 3)
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
	// 鎵嬪娍缁撴潫: 鎶婅妭娴佹湡闂存寕璧风殑鍙樻崲绔嬪嵆钀界洏 (鎷栧姩/缂╂斁鐨勬渶缁堜綅缃笉涓?
	flushTransformSave()
}

const flushTransformSave = (): void => {
	if (transformSaveTimer) { clearTimeout(transformSaveTimer); transformSaveTimer = null }
	if (transformDirty) { transformDirty = false; saveTransform() }
}

/** 鎷栧姩/缂╂斁涓妭娴佷繚瀛? touchmove 姣忓抚鍚屾鍐?3 涓?localStorage 閿細鎺夊抚,
 *  绉诲姩涓渶澶?400ms 钀戒竴娆＄洏, 鎵嬪娍缁撴潫 (onTouchEnd) 鍐嶅厹搴曞啓鏈€缁堝€?*/
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
const physicalViewportAvailable = (): boolean =>
	(navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches) && Math.abs(window.screen.width - window.innerWidth) <= 2 && window.screen.height >= window.innerHeight
const readPortraitLayout = (): boolean =>
	(physicalViewportAvailable() ? window.screen.height : window.innerHeight) >= window.innerWidth
const portraitLayout = ref(readPortraitLayout())
const sideRailOpen = ref(false)
const keyboardOpen = ref(false)
const keyboardInset = ref(0)
let layoutWidth = window.innerWidth
let layoutFullHeight = window.innerHeight
const portraitActions: {panel: P; label: string; icon: string}[] = [
	{panel: "diary", label: "鏃ヨ", icon: DOCK_ICONS.diary},
	{panel: "model", label: "妯″瀷", icon: DOCK_ICONS.model},
	{panel: "pomo", label: "鐣寗", icon: DOCK_ICONS.pomo},
	{panel: "settings", label: "璁剧疆", icon: DOCK_ICONS.settings},
]
const draft = ref("")
const typing = ref(false)
/** 鏄惁姝ｅ湪娴佸紡鐢熸垚鍥炲 (鐢ㄤ簬闅愯棌閲嶅鐨?鈥?姘旀场) */
const chatStreaming = ref(false)
/** 瑙︽懜瑙﹀彂瀵硅瘽鏄惁姝ｅ湪娴佸紡 (闃查噸鍏ラ攣; 鐢?ref 渚涜緭鍏ユ帓闃熺殑 watch 瑙傚療) */
const touchStreaming = ref(false)
/** 褰撳墠娴佸紡璇锋眰鐨勫彇娑堟帶鍒跺櫒 (鍋滄鐢熸垚鎸夐挳鐢? */
let activeChatAbort: AbortController | null = null
/** 瑙︽懜瑙﹀彂瀵硅瘽鐨勫彇娑堟帶鍒跺櫒 (涓庤亰澶╄緭鍏ョ殑 activeChatAbort 骞惰, 閮藉綊鍋滄鎸夐挳绠? */
let activeTouchAbort: AbortController | null = null

/** 鐣欑櫧/瀹炰綋鍛戒腑璋冭瘯 (娴嬭瘯宸ュ叿): 寮€鍚悗鍦ㄥ睆骞曢《閮ㄦ樉绀哄綋鍓嶈Е鎽稿懡涓殑鍖哄煙 */
const hitDebug = ref(false)
const hitZoneText = ref("")
/** 璋冭瘯鏄剧ず鐨勬姎鎽哥姸鎬?(杩涘害/瀹屾垚娆℃暟/閫熷害), 涓?hitZoneText 鍚屼竴澶勮妭娴佸埛鏂?*/
const petDebugText = ref("")
let strokeOnModel = false
let lastHitDebugT = 0

/* ---------------- 鎶氭懜閲囨牱涓庨煶鏁?(绉绘鑷綉椤电増 headPat) ----------------
 * 缃戦〉鐗堟妸"鎽稿ご"瀹氫箟鎴? 妯悜涓轰富 + 閫熷害澶熷揩鐨勭Щ鍔? **绱婊?1000ms 绠楀畬鎴愪竴娆?*,
 * 姣忓畬鎴愪竴娆＄粰涓€璁?瀹屾垚闊?(涔嬪墠瀹夊崜绔彧鏈?鎸変綇 260ms 灏辫繘鍏ユ姎鎽?, 娌℃湁瀹屾垚鐨勬蹇?銆? * 鍗曚綅璇存槑: 缃戦〉鐗堢敤**澶村**褰撳崟浣? 澶村寘鍥寸洅瑕佺瓑 Phase 3a 鐨勬帰娴嬮挬瀛愭墠鏈?
 * 杩欓噷鍏堢敤**灞忓箷鐭竟**褰撳崟浣? 鎵€浠?minSpeedX 鎸?澶村鈮堢煭杈圭殑 1/3"鎹㈢畻(0.05鈫?.02)銆?*/
const petStrokeTuning = {...DEFAULT_PET_STROKE_TUNING, minSpeedX: 0.02}
const petStroke = createPetStrokeDetector(() => petStrokeTuning)
/** 鏈浼氳瘽绱瀹屾垚娆℃暟 (鍙敤浜庤皟璇曟樉绀? */
let petCompletions = 0
/** 鏈€杩戜竴娆″悎鏍奸噰鏍风殑妯悜閫熷害 (鍗曚綅: 鐭竟/绉? 鍙敤浜庤皟璇曟樉绀? */
let petLastVx = 0
/** 鏈€杩戜竴娆＄畻鍑虹殑澶撮儴鐩?(model 鍧愭爣; 渚涜皟璇曟樉绀轰笌鎺㈤拡鏂█) */
let petHeadBox: PetPartBox | null = null
/** 鏈€杩戜竴娆＄畻鍑虹殑**鍏ㄦā鍨嬬洅** (model 鍧愭爣) 鈥斺€?澶村尯鍏滃簳姣斾緥闈犲畠绠?*/
let petModelBox: PetPartBox | null = null
/** 鏈€杩戜竴娆℃寜涓嬬殑妯″瀷鍧愭爣 y (璋冭瘯鏄剧ず鐢? */
let petLastModelY = NaN
/** 鍑犱綍鏄惁鍙敤 (閽╁瓙缂哄け/鎶涢敊鏃朵负 false 鈫?鍒ゅ畾鍏滃簳涓?鎸夊疄浣?) */
let petGeomOk = false
/** 鏈鎸変笅鏄惁钀藉湪**澶撮儴甯?*鍐?(瀹炰綋鍛戒腑 **涓?* 鍦ㄥご甯﹂噷)銆? *  娉ㄦ剰涓?`strokeOnModel` 鍒嗗紑: 鍚庤€呮槸"鍛戒腑瀹炰綋", 杩樿缁х画渚?*鐢ㄦ埛閰嶇疆鐨勮Е鎽稿尯**鍋氬垽瀹?鈥斺€? *  鎶婅Е鎽稿尯涔熼檺鍒舵垚"鍙湁澶?浼氳浼ゆ墜/鑲氱毊绛夊叾瀹冨尯鍩熴€?*/
let onNoriHead = false
/** 鏈€杩戜竴娆℃寜涓嬬殑澶撮儴鍒ゅ畾缁撴灉 (onNoriHead 浼氬湪 endHeadFollow 閲屾竻鎺? 杩欎釜鐣欑潃渚涜皟璇?鎺㈤拡鐪? */
let lastOnHead = false
const petStrokeUnit = (): number => Math.max(120, Math.min(window.innerWidth || 0, window.innerHeight || 0))
/** 灞忓箷鍧愭爣 鈫?閲囨牱鍣ㄥ潗鏍?(闄や互鐭竟 鈬?闃堝€间笌鍒嗚鲸鐜?鏈哄瀷鏃犲叧) */
const petStrokePoint = (x: number, y: number): {x: number; y: number} => {
	const u = petStrokeUnit()
	return {x: x / u, y: y / u}
}
/** 鍙栨ā鍨嬪嚑浣?鈫?绠楀ご鐩掋€傚嚑浣曟潵鑷ˉ涓侀挬瀛?__noriPartProbe (閮ㄤ欢鐩?+ 鍏ㄦā鍨嬬洅, 涓庡懡涓偣鍚屽潗鏍囩郴)銆? *  姣忔鎸変笅绠椾竴娆?鈥斺€?瀹炴祴寮€閿€鏄?248 涓?drawable 鐨勯《鐐归亶鍘?姣绾?, 鍙湪 pointerdown 璧颁竴娆°€?*/
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
/** 褰撳墠 canvas 鐨?CSS 鍙樻崲瑙嗗浘 (涓?relayout 鍐欒繘 canvas.style 鐨勪竴鑷? */
const canvasView = (): {w: number; h: number; scale: number; offsetX: number; offsetY: number} => ({
	w: window.innerWidth || 0,
	h: window.innerHeight || 0,
	scale: scale.value,
	offsetX: offsetX.value,
	offsetY: offsetY.value,
})

/** 灞忓箷鐐?鈫?妯″瀷鍧愭爣 (琛ヤ竵閽╁瓙), 鎷夸笉鍒拌繑鍥?null */
const noriModelPoint = (x: number, y: number): {x: number; y: number} | null => {
	const fn = (window as unknown as {__noriModelPoint?: (x: number, y: number) => {x?: number; y?: number} | null}).__noriModelPoint
	if (typeof fn !== "function") return null
	try {
		// 鍏抽敭: 鍛戒腑閽╁瓙璧板簱鐨?transformView, 瀹冧笉鐭ラ亾 canvas 涓婄殑 CSS 鍙樻崲(scale/offset),
		// 鎵€浠ュ繀椤诲厛鎶?client 鍧愭爣閫嗗彉鎹㈠洖鏈彉鎹㈢殑鐢诲竷鍧愭爣绯? 鍚﹀垯缂╂斁/骞崇Щ鍚庡垽瀹氫笌娓叉煋閿欎綅銆?		const p0 = canvasPointFromClient(x, y, canvasView())
		const p = fn(p0.x, p0.y)
		return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? {x: p.x as number, y: p.y as number} : null
	} catch {
		return null
	}
}
/** 瀹炴椂閲嶅垽"鏄惁鎽稿埌澶?鐨勮妭娴侀棿闅?(ms)銆? *  瀹炰綋鍛戒腑瑕侀亶鍘嗗叏閮?drawable, 姣忓抚(120Hz)璺戜笉鍒掔畻; 10Hz 瀵?绉昏繘鍘?绉诲嚭鏉?瀹屽叏澶熺敤, 鎵嬫劅鏃犲樊銆?*/
const PET_HEAD_CHECK_MS = 100
let lastHeadCheckAt = 0

/**
 * 瀹炴椂閲嶅垽"鏄惁鎽稿埌澶?(鍚?6% 杩熸粸), 骞跺鐞?*杩涘叆/绂诲紑鐨勮竟娌垮姩浣?*銆? *
 * ## 涓轰粈涔堝繀椤诲疄鏃? * 鍘熸潵鍙湪 `pointerdown` 绠椾竴娆?鈬?鎸変笅鏃跺湪澶翠笂灏?*鏁存鎸夊帇閮界畻澶翠笂**(绉诲紑涔熶笉鍋?,
 * 鎸変笅鏃朵笉鍦ㄥご涓婂氨**鎬庝箞绉婚兘涓嶇畻** 鈥斺€?浣犲弽棣堢殑涓や釜鐜拌薄鏄悓涓€涓師鍥犮€? * 缃戦〉鐗?`T2()` 鏄瘡涓簨浠堕兘閲嶇畻鐨? `r = hitTestParts(...)` 涓?`s = Ly(...)` 閮藉湪 move 閲岀畻,
 * 涓?宸茬粡鍦ㄦ懜"涔嬪悗鏀圭敤澶栨墿鐨?leash 妗嗗垽鏄惁杩樺湪鎽搞€? *
 * 杈规部鍔ㄤ綔:
 *  - 杩涘叆 鈫?閲囨牱浠庤繖涓€鍒诲紑濮?+ 涓€璁?鎽稿埌浜?鐨勫弽棣?瑙﹀埌闊?+ 鎺ヨЕ鐖嗗彂; 鍙湪宸茬粡杩涘叆鎶氭懜鐘舵€佹椂)
 *  - 绂诲紑 鈫?閲囨牱澶嶄綅 + 鎽╂摝闊冲綊闆?淇濈暀瀹屾垚闊崇殑绗簩娈靛熬宸?
 */
const updateNoriHead = (x: number, y: number, force = false): void => {
	const now = performance.now()
	if (!force && now - lastHeadCheckAt < PET_HEAD_CHECK_MS) return
	lastHeadCheckAt = now
	const mp = noriModelPoint(x, y)
	petLastModelY = mp ? mp.y : NaN
	let inHead = false
	if (!petGeomOk) {
		// 鍑犱綍鎷夸笉鍒? 鍏滃簳涓?鎸夊疄浣?(璋冭瘯琛屾樉绀恒€屾棤鍑犱綍鈫掓寜瀹炰綋銆?, 鍚﹀垯琛ㄧ幇涓烘€庝箞鎽搁兘娌″弽搴?		const hit = noriHitTest(x, y)
		inHead = !!hit && !!hit.hit
	} else if (mp) {
		const zone = inHeadZoneHysteresis(petHeadBox, petModelBox, mp.x, mp.y, onNoriHead)
		if (zone) {
			// **杩涘叆**鎵嶈姹傚懡涓疄浣? **宸茬粡鍦ㄦ懜**鏃跺彧瑕佹眰杩樺湪(鏈夌晫 leash 鐩掑唴鐨?澶村尯 鈥斺€?涓庣綉椤电増涓€鑷?
			// 瀹?宸茬粡鍦ㄦ懜"鐨勯樁娈靛彧鐢ㄥ鎵╃洅瀛?E8e 鍒? 涓嶅啀鏌?drawable銆?			// 灏戜簡杩欎竴鏉′細鎬庢牱: 鍦ㄥご椤堕偅绉嶅緢绐勭殑鍦版柟宸﹀彸鎽? 鎵嬫寚绋嶄竴婊戝嚭杞粨灏卞垽"澶村"鈫?			// 閲囨牱琚?end() 澶嶄綅 鈫?杩涘害姘歌繙鏀掍笉鍒?1s(瀹炴祴韪╄繃)銆?			inHead = onNoriHead ? true : !!(noriHitTest(x, y)?.hit)
		}
	}
	if (inHead === onNoriHead) return
	onNoriHead = inHead
	lastOnHead = inHead
	if (inHead) {
		const p = petStrokePoint(x, y)
		petStroke.start(performance.now(), p.x, p.y)
		// 婊戣繘澶村尯涔熻鎶婅〃鎯呭惊鐜媺璧锋潵锛堢敤鎴峰彲鑳戒粠韬綋寮€濮嬫懜銆佸啀婊戝埌澶达級
		if (cfg.petTouchEnabled) startPetExpressionLoop()
		// 宸茬粡杩涘叆鎶氭懜鐘舵€?+ **鎸囬拡鐪熺殑鎸夌潃**鎵嶈ˉ鍙嶉: pointerdown 閭ｄ竴鍒荤敱涓婃柟鐨?stroking 瀹氭椂鍣ㄨ礋璐ｃ€?		// `stagePointers > 0` 杩欓亾闂告槸 2026-09-26 鍔犵殑 鈥斺€?`pointermove` 鍦ㄩ紶鏍囨偓鍋滄椂涔熶細娲惧彂(buttons=0),
		// 鑰?杩涘叆澶村尯"杩欎釜杈规部鍘熷厛鍙湅 stroking 鈬?鎮仠鍒掕繃灏辫兘鍐掔矑瀛?鍝嶉煶(娴忚鍣ㄥ疄娴?銆?		if (stroking && stagePointers > 0) {
			claimPetGesture()
			if (cfg.petTouchSound) petAudioTouch()
			if (cfg.petTouchEffects) spawnPetTouchBurst(x, y - 10)
			// 涓庝笂闈㈠悓婧愮殑绗簩澶?纭鎽稿埌澶?杈规部锛堜粠韬綋婊戣繘澶村尯, 鎴栨寜涓嬪悗绗竴娆″垽鍒板ご锛?			if (cfg.petTouchSpeech) maybeSpeakPetLine()
		}
	} else {
		petStroke.end()
		petAudioRelease(true)
	}
}

/** 璇诲洖涓€涓ā鍨嬪弬鏁?(琛ヤ竵閽╁瓙 __noriGetParam); 閽╁瓙缂哄け/鍑洪敊杩斿洖 null */
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
	const zone = !petGeomOk ? "鏃犲嚑浣曗啋鎸夊疄浣? : onNoriHead ? "澶翠笂" : "澶村"
	const yTxt = Number.isFinite(petLastModelY) ? petLastModelY.toFixed(2) : "?"
	const lineTxt = line === null ? "?" : line.toFixed(2)
	return `鎶氭懜 ${(petStroke.progressMs / 1000).toFixed(1)}/${(petStrokeTuning.requiredMs / 1000).toFixed(1)}s 路 瀹屾垚 ${petCompletions} 路 閫熷害 ${petLastVx.toFixed(2)} 路 ${zone}(y${yTxt} 绾?{lineTxt})`
}
/** E2E / 瀹炴満璋冭瘯鎺㈤拡: 闊虫晥鍥剧姸鎬?+ 鎶氭懜閲囨牱鐘舵€?(绾, 涓嶄細寤哄浘)銆? *  瀹炴満涓婃病鏈?adb 鏃? 涔熷彲浠ュ湪鎺у埗鍙伴噷鎵嬫暡 `__noriPetDebug()` 鐪嬭繘搴︺€?*/;(window as unknown as {__noriPetDebug?: () => unknown}).__noriPetDebug = () => ({
	...petAudioState(),
	progressMs: petStroke.progressMs,
	completions: petCompletions,
	velocity: petLastVx,
	active: petStroke.active,
	/** 瀹炴椂鐨?鏄惁鎽稿埌澶? 鈥斺€?杩欐墠鏄垽瀹氭湰浣?(鎶墜鍚庝細褰?false) */
	onHead: onNoriHead,
	/** 鏈€杩戜竴娆″ご閮ㄥ喅绛栫殑蹇収 (鎶墜鍚庝笉娓? 渚涜皟璇曞鐓? */
	lastHead: lastOnHead,
	onModel: strokeOnModel,
	headBox: petHeadBox,
	modelBox: petModelBox,
	bandLine: headZoneLine(petHeadBox, petModelBox),
	geomOk: petGeomOk,
	modelY: petLastModelY,
	/** 鍙傛暟璇诲洖 (琛ヤ竵 __noriGetParam)锛歚angleY` = 搴撴瘡甯у啓鐨?娉ㄨ"閫氶亾锛堝彧璇诲鐓э級 */
	angleY: readParam("ParamAngleY"),
	/** 鐪ㄧ溂: 绱娆℃暟 + 褰撳墠闂悎閲?(0=鐫?1=鍏ㄩ棴) 鈥斺€?瀹炴満/ E2E 纭"鐪熺殑鍦ㄧ湪" */
	blinkCount: blinkCount(),
	blinkClosure: blinkClosureNow(),
	eyeLOpen: readParam("ParamEyeLOpen"),
	eyeROpen: readParam("ParamEyeROpen"),
	/** 鎽稿ご琛ㄦ儏: 褰撳墠杩欏紶鑴镐笌鏄惁鍦ㄥ睍绀?(E2E/瀹炴満纭"鎽稿ご鏃舵挱鐨勬槸 shy/smile") */
	petExpression: petExpressionName(),
	petExpressionOn: petExpressionShowing(),
	/** 鎽稿ご琛ㄦ儏鐨?*瀹㈣璇佹嵁**: 涓や釜琛ㄦ儏鍚勮嚜鐙崰鐨勫弬鏁帮紙Shy鈫扨aramCheek, Smile鈫扨aramEyeSmile锛?	 *  鈥斺€?鍙湅鎴戜滑鑷繁鐨勫彉閲忕瓑浜庤嚜璇侊紝璇诲弬鏁版墠鑳借瘉鏄?琛ㄦ儏鐪熺殑鐢熸晥浜?銆?	 *  娉? 涓嶇敤 `ParamEyeLSmile`锛堟棫 happy 鐨勭嫭鍗犲弬鏁帮級鈥斺€?瀹炴祴 ARGNori **娌℃湁杩欎釜鍙傛暟**
	 *  锛坄13_Happy.exp3.json` 寮曠敤浜嗕竴鍫嗕笉瀛樺湪鐨?`ParamBrowL*`/`ParamEyeLSmile`锛屾墍浠ユ棫瀹炵幇
	 *   鍦ㄨ繖妯″瀷涓婂嚑涔庢槸绌烘搷浣滐級銆傝繖涔熸槸"涓嶈兘闈犺〃鎯呭悕鑷瘉"鐨勫張涓€涓悊鐢便€?*/
	petExprCheek: readParam("ParamCheek"),
	petExprEyeSmile: readParam("ParamEyeSmile"),
	/** 鎽稿ご鍙拌瘝: 璇翠簡鍑犲彞 / 鏈€鍚庝竴鍙?/ 璺濈"鍙互鍐嶈"杩樺樊澶氬皯 ms(0 = 鐜板湪灏辫兘璇?銆?	 *  鍙弽鏄?*鐪熺殑寮€鍙ｈ繃**鐨勬鏁?鈥斺€?琚?姝ｅ湪鏈楄/鐢熸垚涓?璺宠繃鐨勯偅娆?*涓嶈鏁颁篃涓嶆秷鑰楃獥鍙?*銆?*/
	petSpeechCount: petSpeechCount(),
	petSpeechLast: petSpeechLastLine(),
	petSpeechWaitMs: petSpeechWaitMs(performance.now()),
	/** 褰撳墠鎸変笅鐨勬墜鎸囨暟 (stagePointers) 鈥斺€?"鎸囬拡浜嬩欢琚悶鎺?杩欑被闂鍙兘闈犲畠鐪嬪嚭鏉?*/
	pressed: stagePointers,
	/** 鎶氭懜鐘舵€佹満鐨勪笁涓唴閮ㄦ爣蹇?鈥斺€?鎺掓煡"娌℃寜涓嬩篃鍐掔壒鏁?鏃跺繀椤昏兘鐪嬪埌瀹冧滑:
	 *  stroking 鍙湪"鎸変笅鍚?260ms 浠嶅湪璺熼殢"鏃剁疆浣? 鎶墜鐢?endHeadFollow 娓呮帀銆?*/
	stroking,
	headFollow: headFollowActive,
	swayRaf: swayRaf !== 0,
})
/** E2E 鎺㈤拡: 璧?*宸蹭慨姝?*鐨勫睆骞曗啋妯″瀷鍧愭爣鎹㈢畻 (鍚?canvas CSS 鍙樻崲閫嗗彉鎹?銆? *  涓?瑙︽懜鍖鸿矾寰?(鐢?getBoundingClientRect, 鏈潵灏辫窡鐫€娓叉煋璧?鍋氫氦鍙夐獙璇? 鎵嶆姄寰椾綇
 *  "缂╂斁/骞崇Щ鍚庡垽瀹氫笌娓叉煋閿欎綅"杩欑被闂 鈥斺€?鍙湪榛樿 scale=1/offset=0 涓嬫祴鏄姄涓嶄綇鐨勩€?*/
;(window as unknown as {__noriModelPointFixed?: unknown}).__noriModelPointFixed = (x: number, y: number) => noriModelPoint(x, y)
;(window as unknown as {__noriCanvasView?: unknown}).__noriCanvasView = () => canvasView()
/** E2E 鎺㈤拡: 绮掑瓙绱鐢熸垚鏁?(纭畾鎬ц瘉鎹? 涓嶅彈绮掑瓙瀵垮懡/閲囨牱鏃舵満褰卞搷) */
;(window as unknown as {__noriPetFxSpawned?: unknown}).__noriPetFxSpawned = () => petFxSpawned()
// 鐪ㄧ溂: 瑁呬笂"搴?update() 涔嬪墠"鐨勯挬瀛?(鐢?beforeUpdate 璋冨害鍣ㄧ粺涓€鍒嗗彂)
installBlink()
/* 鍙ｅ瀷锛氶粯璁ゅ叧闂€傚紑鍚悗鍙互鎾斁鍣ㄧ姸鎬佷綔涓烘椿鍔ㄩ椄闂紱鐪熷疄鎸箙鍙敤鏃舵寜 RMS 寮€鍙ｏ紝鎸箙缂哄け鎴栬秴鏃跺垯瀹夊叏鏀跺彛銆?   鎯版€ц鍙? 姣忓抚鐜板彇 speaking.value, 鎵€浠ユ敞鍐屼竴娆″氨澶? 涓嶇敤绠?model 閲嶆寕銆?*/
installLipSync(() =>
	cfg.lipSyncEnabled
	&& (speaking.value || (window as unknown as {__noriLipForce?: boolean}).__noriLipForce === true),
)
/** 妯″瀷瀹炰綋鍛戒腑娴嬭瘯 (琛ヤ竵閽╁瓙 __noriHitTest): hit=钀藉湪妯″瀷瀹炰綋涓? err=閽╁瓙鍐呴儴寮傚父 (璋冭瘯閫忎紶), null=閽╁瓙鏈氨缁?*/
const noriHitTest = (x: number, y: number): {hit: boolean; err?: string} | null => {
	try {
		const fn = (window as unknown as {__noriHitTest?: (x: number, y: number) => {hit: boolean; err?: string} | null}).__noriHitTest
		if (typeof fn !== "function") return null
		// 鍚?noriModelPoint: 搴撶殑鍛戒腑鍒ゅ畾涓嶇煡閬?canvas 鐨?CSS 鍙樻崲, 蹇呴』鍏堥€嗗彉鎹㈠洖鏈彉鎹㈢敾甯冨潗鏍囩郴銆?		// 鍚﹀垯鍙屾寚缂╂斁/骞崇Щ妯″瀷鍚? 鍒ゅ畾浼氫笌娓叉煋鏁翠綋閿欎綅(鍦ㄦā鍨嬫梺杈圭殑绌虹櫧澶勪篃绠?鍛戒腑瀹炰綋")銆?		const p = canvasPointFromClient(x, y, canvasView())
		return fn(p.x, p.y)
	} catch {
		return null
	}
}
const zoneText = (hit: {hit: boolean; err?: string} | null): string =>
	!hit ? "鏈煡" : hit.err ? "寮傚父:" + hit.err : hit.hit ? "瀹炰綋" : "鐣欑櫧"
/** 鐢ㄦ埛鐐逛簡"鍋滄鐢熸垚": onError 閲屾嵁姝ゅ尯鍒?鐢ㄦ埛鍋滄"涓?鐪熷け璐? (涓嶅啀鍙潬鏂囨鍖归厤) */
let stopRequested = false

/** 鍋滄鐢熸垚 (鏈湴鍙栨秷 + 鍘熺敓妗?chatStop): 鍚屾椂鍋滆亰澶╂祦涓庤Е鎽歌Е鍙戞祦, 骞跺仠鏈楄 */
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
	/** 涓婃閫夌殑 Live2D 妯″瀷 id (绌?= 娌￠€夎繃 鈬?鍚姩鐢ㄥ凡瑁呭垪琛ㄧ涓€涓?銆?	 *  2026-09-30 淇細浠ュ墠娌″瓨杩欎釜锛屾崲妯″瀷鍚庨噸鍚細鍥炲埌鍒楄〃绗竴涓€?*/
	live2dModel: "",
	bubbleScale: 1,
	bubbleWidth: 82,
	renderScale: 1,
	/** Live2D 娓叉煋甯х巼妗ｄ綅 (0 = 涓嶉檺鍒?銆傛。浣嶅畾涔夎 services/live2d/frameCap.ts */
	l2dFps: 60,
	ttsEnabled: false,
	lipSyncEnabled: false,
	petTouchEnabled: true,
	petTouchEffects: true,
	petTouchSound: true,
	petTouchSpeech: true,
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
	/** 鐣岄潰瀛椾綋锛?026-10-15锛夛細system 绯荤粺榛樿 / wenkai 闇為箿鏂囨シ / kuaile 绔欓叿蹇箰浣擄紙鍚庝袱鑰呴殢鍖?OFL 瀛愰泦锛?*/
	uiFont: "system" as UiFontChoice,
	/** 璁?Nori 鐭ラ亾褰撳墠鏃堕棿锛?026-10-01锛夛細姣忔瀵硅瘽鍦ㄤ汉鏍间箣鍚庤拷鍔犱竴涓椂闂村潡锛涘叧鎺夊嵆鍥炲埌浠ュ墠 */
	timeAware: true,
	ambientEnabled: true,
	quietMode: "off",
	quietOn: false,
	cosyCloneVoices: [] as CosyCloneVoice[],
	trimHistory: true,
	memoryLlmExtract: true,
	/** 瀹炴椂(閫愬彞)璁板繂鎻愬彇: 閲嶆瀯 P3 璧烽粯璁ゅ叧, 璁板繂鐢卞巻鍙叉€荤粨涓€娆′骇鍑?(瑙?services/memory) */
	memoryRealtimeExtract: false,
	/** 鑷姩浼樺寲璁板繂绀轰緥 (榛樿鍏? 瑙佽缃噷銆岃蹇嗕紭鍖栥€嶅皬鑺? */
	memoryAutoTuneExamples: false,
	/** 璁板繂璇婃柇鏃ュ織 (榛樿鍏? 鍙暀鍐呭瓨, 瀵煎嚭鎵嶈惤鐩?鈥斺€?瑙?P1銆岃娴嬮棴鐜€? */
	memoryDiagnostics: false,
	smartRecall: true,
	emotionLlm: true,
	/** DeepSeek 鎬濊€冩ā寮? **榛樿寮€**锛?026-10-02 鐢ㄦ埛绾犳锛夈€傛湇鍔＄榛樿涔熸槸寮€鐨?
	 *  浣嗗彧鏈夋妸寮€鍏?*鏄惧紡**浼犲嚭鍘? 杩欎釜鍕鹃€夋鎵嶇湡鐨勮兘鍏虫帀瀹?鈥斺€?瑙?services/chat 鐨?resolveThinking */
	deepseekThinking: true,
	lookFlipX: false,
	lookFlipY: false,
	lookSens: 0.2,
	floatEnabled: false,
	floatBubbleW: 82,
	floatRenderScale: 2,
	/** 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 鍖垮悕蹇冭烦寮€鍏筹紝榛樿寮€锛涘叧鎺夊悗涓嶅彂浠讳綍璇锋眰 */
	presenceEnabled: true,
})

/* ---------------- 鍦ㄧ嚎浜烘暟锛?026-10-21锛屽尶鍚嶅績璺筹級 ----------------
 * 閫昏緫鍏ㄥ湪 services/presence.ts锛堝彲鍗曟祴锛夛紱杩欓噷鍙仛鏁版嵁缁戝畾銆佽缃紑鍏冲拰鐢熷懡鍛ㄦ湡鎺ョ嚎銆? * 鏈儴缃茶鏁版湇鍔★紙PRESENCE_URL 涓虹┖锛夋椂鏁村潡 UI 涓嶅嚭鐜帮紝涔熶笉鍙戣姹傘€?*/
const presenceState = ref<PresenceState | null>(null)
const presenceReady = ref(false)
const presenceNow = ref(Date.now())
let presenceUnsub: (() => void) | null = null
let presenceTickTimer = 0

const presenceCount = computed(() =>
	cfg.presenceEnabled ? presenceCountText(presenceState.value, presenceNow.value) : "宸插叧闂?,
)
const presenceToday = computed(() =>
	cfg.presenceEnabled ? presenceTodayText(presenceState.value, presenceNow.value) : "",
)
const presenceStatus = computed(() =>
	cfg.presenceEnabled
		? presenceStatusText(presenceState.value, presenceNow.value, presenceReady.value)
		: "宸插湪璁剧疆閲屽叧闂紝涓嶅彂閫佷换浣曞績璺?,
)
const presenceToneClass = computed(() => presenceTone(presenceState.value, presenceNow.value))

/** 棣栨鎺ョ嚎 / 杩愯鏃跺湴鍧€琚敞鍏ュ悗琛ユ帴绾匡紙鎺㈤拡浼氱敤 window.__noriPresenceUrl 瑕嗙洊鍦板潃锛夈€?*/
const ensurePresenceWiring = (): void => {
	presenceReady.value = presenceConfigured()
	if (!presenceReady.value) return
	if (!presenceUnsub) presenceUnsub = subscribePresence((s) => { presenceState.value = s })
	if (!presenceTickTimer) {
		presenceTickTimer = window.setInterval(() => { presenceNow.value = Date.now() }, 60_000)
	}
}

/** 璁剧疆閲岀殑寮€鍏筹細绔嬪埢鐢熸晥 + 钀界洏銆?*/
const onPresenceToggle = (): void => {
	ensurePresenceWiring()
	if (cfg.presenceEnabled) {
		startPresence(APP_VERSION)
	} else {
		stopPresence()
		presenceState.value = null
	}
	persistSettings()
}

/** 鎵嬪姩閲嶈瘯锛堣繛涓嶄笂鏃剁偣涓€涓嬶紝涓嶇敤绛?15s/60s 閫€閬匡級銆?*/
const onPresenceRetry = (): void => {
	ensurePresenceWiring()
	if (presenceReady.value) refreshPresence(APP_VERSION)
}

/* 鎺㈤拡/璋冭瘯閽╁瓙锛堟湰浠撳簱鏃㈡湁 __nori* 绾﹀畾锛?
 * 鍏堣 window.__noriPresenceUrl锛屽啀璋?window.__noriPresenceRefresh() 绔嬪嵆琛ヤ竴娆″績璺炽€? * 鐢熶骇鐜娌℃湁鍓綔鐢紙鍙槸澶氭寕涓€涓嚱鏁帮級銆?*/
;(window as unknown as {__noriPresenceRefresh?: () => void}).__noriPresenceRefresh = () => {
	ensurePresenceWiring()
	if (presenceReady.value) refreshPresence(APP_VERSION)
}



const chatFontPX = computed(() => `${14 * (Number(cfg.bubbleScale) || 1)}px`)

const bubbleScaleNum = computed(() => Number(cfg.bubbleScale) || 1)

const bubbleWidthNum = computed(() => Number(cfg.bubbleWidth) || 82)

const renderScaleNum = computed(() => normalizeRenderScale(cfg.renderScale, 1))

const nativeDpr = computed(() => Math.max(1.5, Math.min(window.devicePixelRatio || 2, 3)))


const applyRenderScale = () => {
	cfg.renderScale = normalizeRenderScale(cfg.renderScale, 1)
	l2d.setRenderScale(renderScaleNum.value)   // 鍏堝啓 __noriRenderScale (搴撲笌鍛戒腑閽╁瓙閮借瀹?
	resizeDataseaBg()                          // 鑳屾櫙鍚冨悓涓€涓棆閽? 涓婇檺 2, 鍙檷涓嶅崌 (瑙?datasea-bg.resize)
}

/* ---- 娓叉煋甯х巼妗ｄ綅锛圠ive2D 褰㈣薄 + 鏁版嵁娴疯儗鏅紝鍚屼竴涓棆閽級 ---- */
/** 褰撳墠妗ｄ綅 (闈炴硶鍊煎洖钀介粯璁ゆ。)銆? 鏄剧ず涓?涓嶉檺" */
const l2dFpsNum = computed(() => normalizeFps(cfg.l2dFps))
/** 涓€澶勭敓鏁? 褰㈣薄涓庤儗鏅?*鍏辩敤**鍚屼竴涓棬闄愶紙閮界敤 frameCap.frameThreshold 绠楋級 */
const applyL2dFps = () => {
	l2d.applyFrameCap(l2dFpsNum.value)
	setDataseaFps(l2dFpsNum.value)
}
/** 妗ｄ綅鎸夐挳鏂囨 */
const l2dFpsLabel = (v: number): string => (v === 0 ? "涓嶉檺" : `${v}`)
/** 鍒囨崲妗ｄ綅: 绔嬪嵆鐢熸晥 + 钀界洏 */
const setL2dFps = (v: number): void => {
	cfg.l2dFps = normalizeFps(v)
	applyL2dFps()
	persistSettings()
}

const curModelName = computed(() => cfg.model || "鏈厤缃ā鍨?)

const storageReady = ref(false)
const storagePath = ref("Download/NoriDroid")
/**
 * 澶栬椋庢牸: "soft" = 鍙繚鐣?*鑹叉澘**鐨勬煍鍜岄锛?*2026-10-01 璧烽粯璁?* 鈥斺€?鐢ㄦ埛瀹氱銆岄粯璁?UI 鏀规垚鏌斿拰銆嶏級;
 *            "pixel" = 缃戦〉鐗堝儚绱犻锛堢‖杈?鐩磋/鏂滅汗锛夛紝涓嶅啀浣滀负榛樿锛屼絾淇濈暀涓哄彲鍒囨崲椤瑰仛 A/B銆? *
 * 涓轰粈涔堣繕鐣欑潃寮€鍏? 涓ょ椋庢牸鐨勫彇鑸嶈鍦?*鐪熸満涓婄湅**锛屼竴涓寘閲屽甫涓ゅ鏍峰紡锛岀敤 `?ui=soft` / `?ui=pixel`
 * 鎴栬缃〉鎸夐挳鍗冲彲鍒囨崲锛屼笉蹇呮潵鍥炲埛涓ゆ鍥轰欢銆傜敤鎴锋墜鍔ㄥ垏杩囩殑璁板湪 localStorage锛坄ui_style`锛夐噷锛? * 鎵€浠?鏀归粯璁ゅ€?鍙奖鍝嶆病閫夎繃鐨勪汉銆傚彧褰卞搷 class锛屼笉鍙備笌浠讳綍涓氬姟閫昏緫銆? */
const uiSoft = ref(true)
try {
	const q = new URLSearchParams(location.search).get("ui")
	const saved = localStorage.getItem("ui_style")
	if (q === "soft" || q === "tide" || q === "pixel") uiSoft.value = q === "soft"
	else if (saved === "soft") uiSoft.value = true
	else if (saved === "tide" || saved === "pixel") uiSoft.value = false
} catch { /* 蹇界暐 */ }
const toggleUiStyle = (): void => {
	uiSoft.value = !uiSoft.value
	try { localStorage.setItem("ui_style", uiSoft.value ? "soft" : "tide") } catch { /* 蹇界暐 */ }
	playSfx()
	triggerBubble(uiSoft.value ? "澶栬锛氭煍鍜岄浘闈? : "澶栬锛氭疆姹愮幓鐠?, 2200)
}

/* ---------------- 鐣岄潰瀛椾綋锛?026-10-15 鐢ㄦ埛瑕佹眰锛?----------------
 * 涓変釜閫夐」锛氱郴缁熼粯璁?/ 闇為箿鏂囨シ / 绔欓叿蹇箰浣撱€傚悗涓や釜鏄殢鍖呯殑 OFL 瀛愰泦锛堣 ui-fonts.less锛夈€? * 杩欓噷鍙"褰撳墠閫夊摢涓?+ 鍐欒繘璁剧疆"锛涜惤 DOM 涓庡瓧浣撴爤鐢?services/ui-font.ts + ui-fonts.less 璐熻矗銆?*/
const uiFontNow = computed<UiFontChoice>(() => normalizeUiFont(cfg.uiFont))
const uiFontHint = computed<string>(() => UI_FONT_OPTIONS.find(o => o.value === uiFontNow.value)?.hint ?? "")
const setUiFont = (v: UiFontChoice): void => {
	if (uiFontNow.value === v) return
	cfg.uiFont = applyUiFont(v)
	persistSettings()
	playSfx()
	const label = UI_FONT_OPTIONS.find(o => o.value === v)?.label ?? v
	triggerBubble(`鐣岄潰瀛椾綋锛?{label}`, 2200)
}
/** 瀛樺偍鑷缁撴灉 (鍘熷 JSON, 渚夸簬鐩存帴鎴浘/澶嶅埗缁欏紑鍙戣€? */
const storageProbeMsg = ref("")
/** 鏄惁宸茶幏寰椼€屾墍鏈夋枃浠惰闂潈闄愩€?Android 11+; 璇诲啓鍏叡鐩綍瑕侀潬瀹? */
const allFilesAccess = ref(false)

/** 璺冲埌绯荤粺璁剧疆鎺堜簣銆屾墍鏈夋枃浠惰闂潈闄愩€? 鍥炴潵鏃?onVisibility 浼氶噸鏂板埛鏂扮姸鎬?*/
const doRequestAllFiles = () => {
	requestAllFilesAccess()
	triggerBubble("璇峰湪绯荤粺璁剧疆閲屾墦寮€銆屽厑璁哥鐞嗘墍鏈夋枃浠躲€嶏紝鐒跺悗杩斿洖杩欓噷鐐广€岃嚜妫€銆?, 4200)
}

/**
 * 瀛樺偍鑷: 閫愪釜闂師鐢?鍏叡鐩綍閲岃繖涓枃浠跺埌搴曚粈涔堟儏鍐?銆? * 鎺掓煡"鍗歌浇閲嶈鍚庡師鏈夊唴瀹硅涓嶅埌"鈥斺€旇鍖哄垎涓夌鎯呭喌: 鈶犵鐩樹笂鏍规湰娌℃枃浠?绯荤粺鍒犱簡)
 * 鈶℃枃浠跺湪, 浣?MediaStore 琛屼笉灞炰簬鏈簲鐢?鏈夈€屾墍鏈夋枃浠惰闂潈闄愩€嶆椂鑳界洿璇诲洖鏉? 鈶㈢洿璇昏绯荤粺鎸′綇銆? */
const doStorageProbe = () => {
	const names = ["chat.json", "memory.json", "settings.json", "nori-diary.json", "nori-diary.json.bak", "nori-diary-src.json"]
	const lines: string[] = []
	let access = allFilesAccess.value
	for (const n of names) {
		const raw = probePublicFiles(n)
		try {
			const o = JSON.parse(raw) as Record<string, unknown>
			access = !!o.allFilesAccess
			lines.push(
				`${n}\n` +
				`  纾佺洏涓婂瓨鍦? ${o.onDisk ? `鏄?${o.fileBytes} 瀛楄妭)` : "鍚?}  鍙洿璇? ${o.fileReadable ? "鏄? : "鍚?}\n` +
				`  MediaStore 鍙: ${o.inMediaStore ? `鏄?${o.mediaStoreBytes} 瀛楄妭)` : "鍚?}\n` +
				`  鎵€鏈夋枃浠惰闂潈闄? ${o.allFilesAccess ? "鏄? : "鍚?}\n` +
				`  鐩綍: ${o.dir}  瀛樺湪=${o.dirExists} 鍙=${o.dirReadable}\n` +
				`  鐩綍鍐呭: ${JSON.stringify(o.listed)}`
			)
		} catch {
			lines.push(`${n}\n  ${raw}`)
		}
	}
	allFilesAccess.value = access
	storageProbeMsg.value = lines.join("\n\n")
	storagePath.value = getStorageDir()
}

/* ---------------- 鑷畾涔変汉璁撅紙2026-10-01 鐢ㄦ埛瑕佹眰锛?---------------
 * 鐢ㄦ埛瀵煎叆鑷繁鐨勬彁绀鸿瘝鏇夸唬鍐呯疆 `nori-prompt.md`; 鍐呭瀛樺湪鏈満 `persona.md`锛堣 services/chat锛夈€? * 杩欓噷鍙**璁剧疆闈㈡澘椤堕儴閭ｈ鐨勬樉绀轰笌涓や釜鎸夐挳**; 鐪熸鍙栫敤鍝唤浜鸿鏄?chat 閲岀殑 personaPrompt()銆? * 鈿?`personaName` 鍙湪鍐呭瓨閲岋紙鏂囦欢鍚嶄笉钀界洏锛夆€斺€?閲嶅紑 App 鍚庡彧鐭ラ亾銆屾湁鑷畾涔夈€? 涓嶇煡閬撳師鏉ュ彨浠€涔堛€?*/
const personaName = ref("")
const personaCustom = ref(false)
const personaChars = ref(0)
const personaMsg = ref("")
const personaMsgOk = ref(false)
/* 瀹樻柟浜鸿涓嬭浇锛?026-10-14 鐢ㄦ埛瑕佹眰锛? 涓庛€屼笅杞芥ā鍨嬨€嶅悓涓€閬撶瓟棰橀棬锛岀瓟瀵规墠鐪熺殑鍘讳笅鎷?.md銆? *  `personaOfficial` 鍙敤鏉ユ妸鐘舵€佽鍐欐垚銆屽綋鍓嶏細瀹樻柟浜鸿銆嶁€斺€?涓庢枃浠跺悕涓€鏍峰彧鍦ㄥ唴瀛橀噷锛? *  閲嶅惎鍚庡洖钀芥樉绀烘垚銆岃嚜瀹氫箟 路 N 瀛椼€嶏紙鍐呭鏈韩鏄惤鐩樼殑锛屼笉褰卞搷鍔熻兘锛夈€?*/
const personaOfficial = ref(false)
const personaDlMsg = ref("")
const personaDlOk = ref(false)
const personaDlBusy = ref(false)

/** 鐘舵€佽鏂囨锛?026-10-01 璧?*娌℃湁鍐呯疆浜鸿**锛? 銆屾湭璁剧疆浜鸿鈥︺€?銆屽綋鍓嶏細鑷畾涔夛紙鏂囦欢鍚嶏級路 N 瀛椼€?
 *  銆屽綋鍓嶏細瀹樻柟浜鸿 路 N 瀛椼€嶏紙鏈€鍚庝竴鏉℃槸 2026-10-14 鍔犵殑涓嬭浇鍏ュ彛甯︽潵鐨勶級 */
const personaStateText = computed(() =>
	personaCustom.value
		? `褰撳墠锛?{personaOfficial.value ? "瀹樻柟浜鸿" : "鑷畾涔?}${personaName.value ? `锛?{personaName.value}锛塦 : ""} 路 ${personaChars.value} 瀛梎
		: `鏈缃汉璁?鈥斺€?鐐广€屽鍏ユ枃浠躲€嶉€変竴浠戒汉璁炬枃妗堬紝鎴栫偣銆屼笅杞藉畼鏂逛汉璁俱€嶏紙涓嶅鍏ョ殑璇?Nori 娌℃湁浜烘牸璁惧畾锛塦
)

/** 閲嶈鑷畾涔変汉璁? 鍒锋柊閭ｈ鐘舵€?(鍚姩鏃朵笌瀵煎叆/涓嬭浇/鎭㈠鍚庡悇璋冧竴娆? */
const refreshPersonaState = () => {
	const t = loadCustomPersona()
	personaCustom.value = !!t
	personaChars.value = t ? t.length : 0
	if (!t) {
		personaName.value = ""
		personaOfficial.value = false
	}
}

/** 瀵煎叆鏂囨浜鸿: 绯荤粺鏂囦欢閫夋嫨鍣?鈫?瀛?`persona.md` 鈫?涔嬪悗姣忚疆瀵硅瘽閮界敤瀹?*/
const doImportPersona = async () => {
	personaMsg.value = ""
	const r = await pickPersonaFile()
	if (!r.ok) {
		personaMsgOk.value = false
		// 鐢ㄦ埛鍦ㄧ郴缁熼€夋嫨鍣ㄩ噷鐐逛簡杩斿洖 鈥斺€?杩欎笉绠楅敊璇? 涓嶅脊姘旀场, 鍙涓€鍙?		personaMsg.value = r.message ?? "鏈€夋嫨鏂囦欢"
		return
	}
	const text = (r.text ?? "").trim()
	if (!text) {
		personaMsgOk.value = false
		personaMsg.value = "杩欎釜鏂囦欢鏄┖鐨? 娌℃湁鍙綋浜鸿鐨勫唴瀹?
		return
	}
	saveCustomPersona(text)
	personaName.value = r.name ?? ""
	personaOfficial.value = false
	refreshPersonaState()
	personaMsgOk.value = true
	personaMsg.value = `宸插鍏?${r.name ?? "浜鸿鏂囦欢"}锛?{personaChars.value} 瀛楋級`
	triggerBubble("浜鸿宸叉洿鏂帮紝涓嬫璇磋瘽灏辩収杩欎釜鏉?)
}

/** 娓呴櫎鑷畾涔変汉璁? 鎶?`persona.md` 鍐呭娓呯┖锛堟枃浠剁暀鐫€, 涓嶅垹锛涙病鏈夊唴缃汉璁惧彲鍥炶惤锛?*/
const doResetPersona = () => {
	saveCustomPersona("")
	personaOfficial.value = false
	personaDlMsg.value = ""
	refreshPersonaState()
	personaMsgOk.value = true
	personaMsg.value = ""
	triggerBubble("宸叉竻闄よ嚜瀹氫箟浜鸿")
}

/* ---------------- 瀹樻柟浜鸿涓嬭浇锛?026-10-14 鐢ㄦ埛瑕佹眰锛?---------------
 * 鍏ュ彛鍦ㄨ缃?鈫?杩炴帴涓庝汉璁?鈫掋€屽畼鏂逛汉璁俱€嶈锛堝氨鎺掑湪銆屼汉璁炬枃妗堬紙鎻愮ず璇嶏級銆嶆涓嬫柟锛夈€? * 鍜屻€屼笅杞芥ā鍨嬨€嶅畬鍏ㄥ悓涓€濂楋細鐐规寜閽?鈫?寮€銆屼汉璁炬巿鏉冮獙璇併€嶉偅閬撻 鈫?**绛斿鎵?*鍘讳笅杞斤紙绛旈敊/鍙栨秷閮戒笉涓嬶級銆? * 涓嬭浇婧愬湪 services/chat锛圥ERSONA_DOWNLOAD_URL, PinMe/IPFS 闈欐€佹墭绠★紝涓庢ā鍨?闊虫晥鍚屼竴濂楋級銆? * 涓嬪畬鐩存帴 saveCustomPersona锛? `persona.md`锛夆啋 涓嬩竴杞璇濆氨鎸夎繖浠戒汉璁捐蛋銆?*/
const openPersonaGate = (): void => {
	if (personaDlBusy.value) return
	personaDlMsg.value = ""
	openGate("persona", () => { void doDownloadOfficialPersona() })
}

/** 绛旈闂ㄦ斁琛屼箣鍚庣湡姝ｅ幓涓嬭浇锛涙枃鏈牎楠屽湪 services/chat 閲屽仛锛堢┖/瓒呭ぇ/HTML/涓嶆槸 Nori 鐨勯兘涓嶅啓鐩橈級 */
const doDownloadOfficialPersona = async (): Promise<void> => {
	personaDlBusy.value = true
	personaDlOk.value = false
	personaDlMsg.value = "涓嬭浇涓€?
	try {
		const r = await downloadOfficialPersona()
		if (!r.ok || !r.text) {
			personaDlOk.value = false
			personaDlMsg.value = r.message ?? "涓嬭浇澶辫触"
			return
		}
		saveCustomPersona(r.text)
		personaOfficial.value = true
		personaName.value = ""
		refreshPersonaState()
		personaDlOk.value = true
		personaDlMsg.value = `宸蹭笅杞藉苟鍚敤瀹樻柟浜鸿锛?{Math.round((r.bytes ?? 0) / 1024)}KB 路 ${personaChars.value} 瀛楋級`
		triggerBubble("浜鸿瑁呭ソ鍟︼紝浠庣幇鍦ㄥ紑濮嬪氨鏄疦ori浜?)
	} catch (e) {
		personaDlOk.value = false
		personaDlMsg.value = `涓嬭浇澶辫触: ${(e as Error)?.message ?? String(e)}`
	} finally {
		personaDlBusy.value = false
	}
}

const modelReady = computed(() => !!cfg.apiKey.trim() && !!cfg.model)
const toggleChat = () => {
	imageMenu.value = false
	sideRailOpen.value = false
	chatOpen.value = !chatOpen.value
	if (chatOpen.value) scrollChatBottom()
}
const openPortraitHistory = (): void => {
	chatOpen.value = true
	imageMenu.value = false
	sideRailOpen.value = false
	scrollChatBottom()
}

const scrollChatBottom = () => {
	nextTick(() => {
		const el = chatScroll.value
		if (el) el.scrollTop = el.scrollHeight
	})
}

const refreshModels = async () => {
	modelLoadMsg.value = "鍔犺浇涓€?
	const r = await fetchModels(cfg.baseUrl, cfg.apiKey)
	if (!r.ok) { modelLoadMsg.value = r.message ?? "鍔犺浇澶辫触"; return }
	modelOptions.value = r.models ?? []
	if (modelOptions.value.length && !modelOptions.value.includes(cfg.model)) cfg.model = modelOptions.value[0]
	modelLoadMsg.value = `鎵惧埌 ${modelOptions.value.length} 涓ā鍨媊
}

type PendingImage = Pick<ImagePickedResult, "dataUrl" | "mime" | "width" | "height" | "size">
type PendingChat = {text: string; image?: PendingImage}
const imageMenu = ref(false)
const imagePicking = ref(false)
const pendingImage = ref<PendingImage | null>(null)
// 鍥剧墖涓嶈繘鍏ュ巻鍙?璁板繂锛涙湰娆￠〉闈㈠彧淇濈暀鏈€杩?6 寮犵缉鐣ラ瑙堬紝閬垮厤闀胯亰绱Н base64銆?const imagePreviews = reactive(new Map<number, string>())
watch(chatOpen, (open) => { if (!open) imageMenu.value = false })
watch(panel, () => { sideRailOpen.value = false; imageMenu.value = false })

/** 杈撳叆娉曢€氬父鍙缉鐭珮搴︼紱瀹藉害鍙樺寲鎵嶈涓烘棆杞紝閬垮厤閿洏鎶婄珫灞忓垏鎴愭í灞忋€?*/
const syncChatLayout = (): void => {
	const width = window.innerWidth
	const viewport = window.visualViewport
	const height = viewport?.height ?? window.innerHeight
	const widthChanged = Math.abs(width - layoutWidth) > 2
	const physicalViewport = physicalViewportAvailable()
	// 璁剧疆椤典篃鑳藉敜璧烽敭鐩橈紱鍥炲埌鑱婂ぉ鏃朵笉鑳芥妸宸茬缉鐭殑楂樺害褰撲綔瀹屾暣瑙嗗彛銆?	const fullHeight = physicalViewport ? window.screen.height : (widthChanged ? window.innerHeight : layoutFullHeight)
	const inputFocused = !!document.activeElement?.matches(".chat-input input")
	const keyboard = height < fullHeight * 0.78 && (inputFocused || keyboardOpen.value) && (!widthChanged || physicalViewport)
	keyboardOpen.value = keyboard
	keyboardInset.value = keyboard ? Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0)) : 0
	if (!keyboard || widthChanged) {
		portraitLayout.value = readPortraitLayout()
		layoutWidth = width
		// 閿洏鍔ㄧ敾閫愬抚缂╃煭楂樺害鏃朵篃淇濈暀瀹屾暣楂樺害锛屼笉鑳介€愬抚鎶婂垽鏂熀绾跨缉灏忋€?		layoutFullHeight = keyboard ? fullHeight : (inputFocused && !widthChanged ? Math.max(layoutFullHeight, window.innerHeight) : window.innerHeight)
	}
}
const onComposerFocus = (): void => {
	imageMenu.value = false
	sideRailOpen.value = false
	syncChatLayout()
}
const onComposerBlur = (): void => { syncChatLayout() }
const closeChatMenusOutside = (event: PointerEvent): void => {
	if (!(event.target as HTMLElement)?.closest?.(".image-entry")) imageMenu.value = false
}
watch(portraitLayout, () => { sideRailOpen.value = false; imageMenu.value = false; scrollChatBottom() })

const messageImageUrl = (message: ChatMsg): string | null => imagePreviews.get(message.ts) ?? null

const messageSegments = (message: ChatMsg): string[] => {
	if (message.role === "assistant") return bubbleSegments(message.content)
	// 鏈夐瑙堟椂涓嶅啀鏄剧ず鍘嗗彶鍗犱綅绗︼紱绾浘鐗囨病鏈夋枃瀛楁皵娉°€?	const text = messageImageUrl(message) && message.content.startsWith("[鍥剧墖]")
		? message.content.slice("[鍥剧墖]".length).trimStart()
		: message.content
	return text ? [text] : []
}

const chooseImage = async (source: "album" | "camera"): Promise<void> => {
	if (imagePicking.value) return
	imageMenu.value = false
	imagePicking.value = true
	try {
		const result = source === "camera" ? await captureImage() : await pickImageFile()
		if (!result.ok || !result.dataUrl) {
			if (result.message && result.message !== "鏈€夋嫨鍥剧墖") triggerBubble(result.message, 2200)
			return
		}
		pendingImage.value = {
			dataUrl: result.dataUrl,
			mime: result.mime,
			width: result.width,
			height: result.height,
			size: result.size,
		}
	} finally {
		imagePicking.value = false
	}
}

const onInputEnter = (event: KeyboardEvent): void => {
	if (event.isComposing || event.keyCode === 229) return
	void send()
}

/** 杈撳叆鎺掗槦: 涓婁竴鏉¤繕鍦ㄧ敓鎴?(鍚Е鎽歌Е鍙戠殑瀵硅瘽) 鏃? 鏂版秷鎭厛杩涢槦鍒? 绌洪棽鍚庝緷娆″彂鍑?*/
const pendingQueue = ref<PendingChat[]>([])
let draining = false
const drainQueue = async (): Promise<void> => {
	if (draining || typing.value || chatStreaming.value || touchStreaming.value) return
	draining = true
	try {
		while (pendingQueue.value.length && !typing.value && !chatStreaming.value && !touchStreaming.value) {
			const next = pendingQueue.value.shift()
			if (next) await runSend(next.text, next.image)
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
	const image = pendingImage.value
	if (!text && !image) return
	if (!modelReady.value) {
		panel.value = "settings"
		return
	}
	draft.value = ""
	pendingImage.value = null
	// 姝ｅ繖鏃跺叆闃?(watch 浼氬湪绌洪棽鏃惰Е鍙?drain), 绌洪棽鏃剁珛鍗冲彂閫?	pendingQueue.value.push({text, image: image ?? undefined})
	await drainQueue()
}

const runSend = async (text: string, image?: PendingImage): Promise<void> => {
	const userText = text || (image ? "璇风湅鐪嬭繖寮犲浘鐗? : "")
	// 鏈楄鎵撴柇 (barge-in): 娑堟伅鐪熸鍙戝嚭鏃舵墠鍋滄湕璇?(鎵撳瓧涓嶆墦鏂?;
	// stop() 浼氬叧闂湕璇讳細璇濆苟缃?aborted, 涔嬪墠鍥炲閲屾帓闃熸湭璇荤殑鍙ュ瓙鍏ㄩ儴涓㈠純, 涓嶄細"澶嶆椿".
	// 鎺掗槦鍦烘櫙: 姣忔潯娑堟伅鍦ㄥ疄闄呭彂鍑洪偅涓€鍒绘墠鎵撴柇, 鐢熸垚涓殑鍥炲浼氬厛璇诲畬
	ambientTouch()
	habitRecord("msg")
	stopTTS()
	const imagePart: ChatMsg["parts"] = image?.dataUrl ? [{type: "text", text: userText}, {type: "image_url", image_url: {url: image.dataUrl}}] : undefined
	const userMessage: ChatMsg = {role: "user", content: imagePart ? (text ? `[鍥剧墖] ${text}` : "[鍥剧墖]") : userText, ts: Date.now()}
	messages.value.push(userMessage)
	if (image?.dataUrl) {
		imagePreviews.set(userMessage.ts, image.dataUrl)
		while (imagePreviews.size > 6) imagePreviews.delete(imagePreviews.keys().next().value!)
	}
	persistChat(messages.value)
	scrollChatBottom()

	typing.value = true
	showPortraitReply("鈥?)
	stopRequested = false
	const chatAbort = new AbortController()
	activeChatAbort = chatAbort
	try {
		// 璁板繂绯荤粺: 鎸夊綋鍓嶆秷鎭彫鍥為暱鏈熻蹇?+ 璇诲彇鍘嗗彶鎬荤粨, 娉ㄥ叆涓婁笅鏂?		// smartRecall 寮€ 鈫?LLM 璇箟鍙洖 (鏇村噯); 鍏?鈫?鍏抽敭璇嶅彫鍥?(鍏嶈垂蹇?
		const smartEnabled = cfg.smartRecall && cfg.apiKey.trim() && cfg.model.trim() && !shouldSkipLlmExtract(userText)
		const selection = await selectRecallWithinBudget(userText, smartEnabled ? async (prompt, signal) => {
			const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [{role: "system", content: prompt} as ChatMsg], false, {signal})
			if (!r.ok) throw new Error(r.message ?? "鍙洖澶辫触")
			return r.content ?? ""
		} : null, RECALL_BUDGET_MS, chatAbort.signal)
		if (chatAbort.signal.aborted) return
		const context: ChatMsg[] = []
		const personaText = personaPrompt()
		if (personaText) context.push({role: "system", content: personaText} as ChatMsg)
		// 涓撴敞鏁版嵁: 涓変釜闂搁棬閮借繃鎵嶆敞鍏?(璇濋鐩稿叧 + 鏈夊€煎緱璇寸殑 + 浠婂ぉ杩樻病鎻愯繃)銆?		// 鍒绘剰鍋氭垚"鍥炲鍐呮彁涓€鍙?鑰屼笉鏄?Ambient 涓诲姩鎼瘽 鈥斺€?鍚庤€呮瘡娆′細璇濆彧鏈?3 鏉￠绠?
		// 鐢ㄥ幓鎶ユ暟瀛楀氨鎶婇櫔浼村彉鎴愭墦鍗℃彁閱掍簡銆傛敞鍏ユ枃鏈嚜甯?鏈€澶氭彁杩欎竴浠朵簨"鐨勫厠鍒剁害鏉?
		// 鍥犱负 persona 宸插弽澶嶅己璋?2~3 鍙ヤ笂闄?(涓嶅幓鏀惧閭ｆ潯瑙勫垯)銆?		if (focusHintFresh()) {
			const fh = buildFocusHint(pomoSummary.value, userText, pomoStats.celebrated ?? {})
			if (fh.hint) {
				context.push({role: "system", content: fh.hint} as ChatMsg)
				markFocusHinted()
				if (fh.milestoneKey) markCelebrated(fh.milestoneKey)
			}
		}
		const hist: ChatMsg[] = contextHistory(messages.value).map(({role, content, ts}) => ({role, content, ts}))
		// 鍙粰鏈鐢ㄦ埛娑堟伅闄勫浘锛涘悗缁璇濈户缁娇鐢ㄧ函鏂囧瓧鍘嗗彶銆?		if (imagePart) hist[hist.length - 1] = {...userMessage, parts: imagePart}
		// 褰撳墠鏃堕棿鐢卞彂閫佸眰鍦ㄥ疄闄呭彂鍑鸿姹傛椂杩藉姞銆?		const payload = [...context, ...hist]

		// 娴佸紡 TTS: 鍚敤鏃跺紑"閫愬彞鏈楄浼氳瘽", 杈圭敓鎴愯竟鍑洪煶
		const ttsOn = isTtsReady(cfg)
		if (ttsOn) beginSpeakSession(cfg)

		chatMarkerBuf.value = "" // 鏂颁細璇濋噸缃亰澶╂爣璁拌法鍧楃紦鍐?		let reply = ""
		let pendingSpeech = ""
		// 鏈浼氳瘽鏄惁鏀跺埌杩囨爣璁?(鏈夋爣璁?鈫?鏀跺熬涓嶅啀鐢ㄦ鏂囧叧閿瘝瑕嗙洊; 鏃犳爣璁?鈫?鍏抽敭璇嶅厹搴?
		let markerDriven = false
		// 瀛樺偍/鍘嗗彶鍚堝苟: 涓€娆″洖澶嶅彧瀛樹竴鏉℃秷鎭? 鏄剧ず鏃剁敱 bubbleSegments 鎷嗘垚澶氭皵娉?		let liveBubble: ChatMsg | null = null
		let streamOk = false
		chatStreaming.value = true

		// 鍋滄鐢熸垚: 鏈湴 AbortController (鍗充娇鍘熺敓妗ヤ涪寮冨洖鍖呬篃鑳芥甯哥粨鏉? + 鍘熺敓妗?chatStop

		// 婊氬姩鑺傛祦: 闀垮洖澶嶆椂閬垮厤姣忓閲忛兘婊氬姩 (浠呰繎搴曢儴鎵嶆粴, 150ms 闄愰)
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

		// 鎶婄疮绉殑鏂囨湰鎸夊彞瀛愯竟鐣屽垏鍑烘潵, 閫愬彞杩藉姞鏈楄 (鍙湪瀹夊叏杈圭晫鍒? 涓嶅垏璇?
		const flushSpeech = () => {
			if (!ttsOn || !pendingSpeech) return
			pendingSpeech = stripInternalPromptMetadata(pendingSpeech)
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
					// 闃插尽: 涓埆浠ｇ悊浼氭妸 null 褰撳瓧绗︿覆涓嬪彂, 鐩存帴璺宠繃
					if (delta === "null") return
					// 鍓ョ闅愯棌鐨勩€愯〃鎯?xxx銆戙€愬姩浣?xxx銆戞爣璁?(鏍囪涓嶆樉绀恒€佷笉鏈楄)
					const {clean, emotion, motion} = parseMarkerDelta(delta, chatMarkerBuf)
					const safeClean = stripInternalPromptMetadata(clean)
					reply = stripInternalPromptMetadata(reply + safeClean)
					pendingSpeech = stripInternalPromptMetadata(pendingSpeech + safeClean)
					flushSpeech()
					if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
					if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
					if (cfg.emotionLlm && motion) playMarkerMotion(motion)
					// 瀛樺偍鍚堝苟: 鍙洿鏂颁竴鏉?liveBubble, 鏄剧ず灞傝嚜鍔ㄦ媶澶氭皵娉?					if (!liveBubble && reply.trim()) {
						liveBubble = {role: "assistant", content: reply, ts: Date.now()}
						messages.value.push(liveBubble)
					} else if (liveBubble) {
						if (reply.trim()) liveBubble.content = reply
						else {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
					}
					if (reply.trim()) {
						showPortraitReply(reply)
						throttledScroll()
					}
				},
				onDone: (content) => {
					streamOk = true
					chatStreaming.value = false
					reply = stripInternalPromptMetadata(reply)
					// content 鏄惈鏍囪鐨勫叏鏂? 浼樺厛鐢ㄦ祦寮忕疮绉殑宸插墺绂?reply;
					// 鑻?reply 涓虹┖ (濡傞潪娴佸紡鍥為€€), 鍒欏 content 鏁翠綋鍓ョ涓€娆?(鐢ㄧ┖缂撳啿, 閬垮厤娈嬬暀鎷兼帴)
					if (content && !reply.trim()) {
						const fresh = {value: ""}
						const {clean, emotion, motion} = parseMarkerDelta(content, fresh)
						reply = stripInternalPromptMetadata(clean)
						if (cfg.emotionLlm && (emotion || motion)) markerDriven = true
						if (cfg.emotionLlm && emotion) playMarkerEmotion(emotion)
						if (cfg.emotionLlm && motion) playMarkerMotion(motion)
						// 闈炴祦寮忓洖閫€: 鏁翠綋鍐呭浣滀负涓€鏉℃秷鎭?(鏄剧ず灞傝嚜鍔ㄦ媶澶氭皵娉?
						if (!liveBubble && reply.trim()) {
							liveBubble = {role: "assistant", content: reply, ts: Date.now()}
							messages.value.push(liveBubble)
						} else if (liveBubble) {
							liveBubble.content = reply
						}
					}
					// 鍏滃簳: 娴佸紡璺緞鑻ヤ粛鏈夋畫鐣欐湭闂悎鐨勩€?缂撳啿閲?, 璇存槑鏍囪涓嶅畬鏁? 涓㈠純涓嶆樉绀?					chatMarkerBuf.value = ""
					if (liveBubble) {
						if (reply.trim()) liveBubble.content = reply
						else {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
					}
					if (reply.trim()) showPortraitReply(reply)
					else portraitReply.value = ""
					persistChat(messages.value)
					resolve()
				},
				onError: (msg) => {
					chatStreaming.value = false
					// 鐢ㄦ埛涓诲姩鍋滄: 涓嶆樉绀洪敊璇皵娉? 鍏朵粬澶辫触涓旀棤鍐呭鏃舵樉绀?					const cancelled = stopRequested || msg === "宸插仠姝?
					if (cancelled) showPortraitReply(reply)
					if (!cancelled && !reply.trim()) {
						if (liveBubble) {
							const idx = messages.value.indexOf(liveBubble)
							if (idx >= 0) messages.value.splice(idx, 1)
							liveBubble = null
						}
						messages.value.push({role: "assistant", content: `鈿?${msg}`, ts: Date.now(), error: true})
						showPortraitReply(`鈿?${msg}`)
					} else if (liveBubble) {
						// 宸叉敹鍒伴儴鍒嗗唴瀹? 淇濈暀涓轰竴鏉℃秷鎭?						liveBubble.content = reply
					}
					persistChat(messages.value)
					resolve()
				},
			}, cfg.deepseekThinking, chatAbort.signal, memoryChatOptions(selection, payload, cfg.timeAware))
		})
		if (activeChatAbort === chatAbort) activeChatAbort = null
		if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null }

		// 鏀跺熬: 鍓╀綑鏈垚鍙ョ殑鏂囨湰 + 缁撴潫鏈楄浼氳瘽
		if (ttsOn) {
			const safePendingSpeech = stripInternalPromptMetadata(pendingSpeech)
			if (safePendingSpeech.trim()) speakAppend(cfg, safePendingSpeech)
			pendingSpeech = ""
			endSpeakSession()
		}

		typing.value = false
		scrollChatBottom()

		if (streamOk && reply) {
			// 琛ㄦ儏/鍔ㄤ綔: 娴佸紡鏍囪宸插嵆鏃堕┍鍔? 鍙湁鏈浼氳瘽瀹屽叏娌℃敹鍒版爣璁版椂鎵嶇敤姝ｆ枃鍏抽敭璇嶅厹搴?			if (!markerDriven) {
				triggerEmotion(reply)
				pickMotionByKeyword(reply)
			}
			// 璁板繂鎻愬彇: 瑙勫垯娉曞厤璐?+ LLM 鍙€夊寮?(琛ㄦ儏鍒嗘瀽宸插苟鍏ヤ富鍥炲鏍囪, 涓嶅啀鍗曠嫭璋冪敤)
			void analyzeAfterReply(userText, reply)
			// 璁板繂绯荤粺: 鍘嗗彶杩囬暱鏃剁敓鎴愭憳瑕?(鐢ㄥ甫鏍囩偣鐨勫師鏂囧帇缂? 璐ㄩ噺鏇村ソ)
			void (async () => {
				const summarized = await summarizeIfNeeded(messages.value, async (prompt) => {
					const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
						{role: "system", content: prompt} as ChatMsg,
					])
					return r.ok ? (r.content ?? "") : ""
				}, !!cfg.memoryLlmExtract)
				maybeAutoTuneExamples()   // 鑷姩浼樺寲 (寮€鍏虫墦寮€鏃?: 鏂板澶?20 鏉″氨椤烘墜鍒锋柊绀轰緥
				// 寮€鍚€岃嚜鍔ㄨ鍓€嶆椂: 鍙**宸茬粡杩涜繃鎽樿鐨勯偅娈靛墠缂€** (P5: safeTrimDrop 淇濊瘉
				// 涓嶄細鎶婅繕娌℃€荤粨鐨勬秷鎭垹鎺?鈥斺€?鍒犳帀灏辨案杩滆繘涓嶄簡璁板繂浜?, 杩戠绐楀彛鐓ф棫淇濈暀銆?				const dropN = summarized && cfg.trimHistory ? safeTrimDrop(messages.value.length) : 0
				if (dropN > 0 && bufferDiarySource(messages.value.slice(0, dropN))) {
					// 鏃ヨ绱犳潗淇濆瓨鎴愬姛鍚庢墠鑳借鍓紱澶辫触鏃朵繚鐣欏師瀵硅瘽銆?					// 鍗犱綅绗︿粛姣忔閮芥柊寤? 浣嗚亰澶╁瓨鍌ㄤ晶浼氬幓閲?(filterChatMsgs 鍙暀绗竴鏉?/
					// mergeChatLists 瀵瑰崰浣嶇鏌ラ噸) 鈥斺€?鎵€浠ュ畠涓嶄細鍦ㄧ鐩樹笂瓒婄Н瓒婂銆?					// 涓嶈鍦ㄨ繖閲?澶嶇敤鏃у崰浣嶇": 瀹冪殑 ts 浣庝簬宸茶鐨?cutoff, 閲嶈浇鏃剁収鏍蜂細琚涪鎺夈€?					const kept = messages.value.slice(dropN)
					kept.unshift({role: "system", content: "锛堟洿鏃╃殑瀵硅瘽宸插帇缂╀负鍘嗗彶鎬荤粨锛屽彲鍦ㄨ缃啋璁板繂绯荤粺鏌ョ湅锛?, ts: Date.now(), placeholder: true})
					// 閫氱煡鑱婂ぉ瀛樺偍瑁佸壀杈圭晫: 钀界洏褰掑苟鏃朵笉鍐嶆妸琚鎺夌殑鏃ф秷鎭苟鍥炴潵
					const firstReal = kept.find(m => m.role !== "system")
					if (firstReal) setChatTrimCutoff(firstReal.ts)
					messages.value = kept
					persistChat(messages.value)
					// 鐧昏琚鎺夌殑鏉℃暟 (P5): 娓告爣闈?绱宸叉憳瑕?- 绱宸茶鍓?鎹㈢畻鎴愭暟缁勪笅鏍?
					// 涓嶅啀鍍忔棫瀹炵幇閭ｆ牱璋庣О"淇濈暀鐨勯兘宸叉憳瑕? (閭ｄ細璁╄繎绔?20 鏉℃案杩滀笉琚€荤粨)
					notifyHistoryTrimmed(dropN)
					scrollChatBottom()
				}
			})().catch(e => { console.error("[mem] 鍚庡彴鏁寸悊澶辫触", e); refreshMemView() })
		}
	} finally {
		if (activeChatAbort === chatAbort) activeChatAbort = null
		typing.value = false
		scrollChatBottom()
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))


const splitReplies = (reply: string): string[] => {
	const lines = reply.split(/\n+/).map((s) => s.trim()).filter((s) => s)
	if (lines.length >= 2) return lines.map((s) => s.replace(/[銆傦紒锛??^~锛?]+$/g, ""))
	return [reply.trim()]
}

/**
 * 姘旀场鏄剧ず鏂囨湰: 缁熶竴鐪佺暐鍙锋樉绀? 闃叉琚?CSS 鏂鎷嗗紑.
 * - 杩炵画鑻辨枃鐐?(AI 鍙兘杈撳嚭 "......") 鈫?鍗曚釜涓枃鐪佺暐鍙?"鈥?
 * - 涓枃鐪佺暐鍙?(鈥︹€?鎴?路路路路路路) 鈫?鍚堝苟涓哄崟涓?"鈥?
 * 鍗曚釜瀛楃姘歌繙涓嶄細琚柇琛屾媶寮€.
 */

const bubbleText = (content: string): string =>
	stripInternalPromptMetadata(content)
		.replace(/\.{2,20}/g, "鈥?)
		.replace(/鈥2,}/g, "鈥?)
		.replace(/路{2,}/g, "鈥?)

/**
 * 鎸夊彞鎷嗘皵娉?(浠呮樉绀虹敤): 瀛樺偍閲屼竴鏉℃秷鎭? 鏄剧ず鏃舵寜鍙ユ湯鏍囩偣鍒囨垚澶氫釜鐙珛姘旀场.
 * 澶嶇敤 splitSpeechText 鐨勫垏鍒嗚鍒?(銆傦紒锛??\n鈥?, 瓒呴暱鏃犳爣鐐规鐢?MAX_BUBBLE_LEN 鍏滃簳.
 * 缁撴灉鎸夊唴瀹圭紦瀛?(鎬ц兘): 娴佸紡鏃舵瘡涓閲忛兘瑙﹀彂閲嶆覆鏌? 妯℃澘閲岀洿鎺ヨ皟鐢ㄤ細璁? * 鍏ㄩ儴鍘嗗彶娑堟伅姣忓抚閲嶅垏涓€閬?鈥斺€?闀垮璇濇墦瀛?娴佸紡杈撳嚭鍗￠】鐨勬牴婧? 鍐呭瀛楃涓? * 涓嶅彲鍙?鈫?缂撳瓨鎸夊唴瀹瑰仛閿? 鍙湁姝ｅ湪鐢熼暱鐨勯偅鏉′細閲嶇畻.
 */
const segCache = new Map<string, string[]>()
const bubbleSegments = (content: string): string[] => {
	const cleaned = stripInternalPromptMetadata(content)
	const hit = segCache.get(cleaned)
	if (hit) return hit
	const segs = computeBubbleSegments(cleaned)
	if (segCache.size > 150) segCache.clear() // 闃叉鏋侀暱瀵硅瘽涓嬬紦瀛樿啫鑳€ (鍐呭閿笉鍙灇涓惧鐢?
	segCache.set(cleaned, segs)
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
	// 闃叉寰幆: 杩唬涓婇檺 (姝ｅ父鍥炲鏈€澶氬嚑鍗佸彞)
	for (let guard = 0; guard < 200; guard++) {
		// 姘旀场鏄剧ず: 鐪佺暐鍙蜂笉褰撳彞瀛愯竟鐣?(鍚﹀垯 "鈥︹€? 浼氳鍗曠嫭鍒囧嚭/鎸ゅ埌涓嬩竴琛?
		const {sentences, rest: r} = splitSpeechText(rest, 40, false)
		for (const s of sentences) pushSeg(s.trim())
		if (!r.trim()) break
		rest = r
		// splitSpeechText 瀵?<40 瀛楃殑鏃犳爣鐐?rest 涓嶄骇鐢?sentences, 鐩存帴浣滀负鏈€鍚庝竴娈?		if (rest.length < 40) {
			pushSeg(rest.trim())
			break
		}
		// rest >= 40 瀛楁棤鏍囩偣: 涓嬩竴杞?splitSpeechText 浼氭寜寮卞垎闅旀垨鏁存鍒囧嚭 sentences
	}
	return segs.filter(Boolean)
}

/**
 * v-for 绋冲畾 key: 鎸夋秷鎭璞¤韩浠藉垎閰嶈嚜澧?id (WeakMap, 涓嶅奖鍝嶆寔涔呭寲/鍝嶅簲寮?.
 * 鏃у疄鐜扮敤鏁扮粍涓嬫爣浣?key 鈥斺€?鍒犻櫎閿欒姘旀场/瑁佸壀绉讳綅鍚庢暣娈典笅鏍囧墠绉? Vue 閿欒
 * 澶嶇敤 DOM 鑺傜偣; 鍐呭绫?key 鍙堜細闅忔祦寮忓閲忓彉鍖栧鑷磋妭鐐归噸寤?
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

/* ---------------- 璁板繂绯荤粺 UI 鐘舵€?---------------- */
/* P5 璧?杩戠淇濈暀澶氬皯鏉?杩欐鑳借澶氬皯鏉?鐢辫蹇嗘湇鍔″喅瀹?(RAW_WINDOW 涓?safeTrimDrop),
   鐣岄潰涓嶅啀鑷繁鍐欐 20 鈥斺€?涔嬪墠鐣岄潰涓庤蹇嗗眰鍚勫瓨涓€浠界獥鍙ｅぇ灏? 鏄?瑁佸壀鎶婃病鎬荤粨鐨勬秷鎭垹鎺?
   杩欑被 bug 鐨勬俯搴娿€?*/
/** 璇箟鍙洖棰勭畻 (ms): 瓒呮椂鍏堢敤鍏抽敭璇嶅厹搴曞彂閫? 璇箟缁撴灉鍚庡彴鑷鏀跺熬 */
const RECALL_BUDGET_MS = 1200
/** 鏃犳崲琛屾椂鍗曟潯姘旀场鐨勬渶澶у瓧绗︽暟 (瓒呰繃鍒欏厹搴曞垏鏂版皵娉? 30 鈫?60: 鍑忓皯鏃犳爣鐐归暱鍙? *  琚‖鍒囨垚澶氫釜姘旀场鐨勬儏鍐? CSS 宸叉敮鎸佹皵娉″唴鑷劧鎹㈣) */
const MAX_BUBBLE_LEN = 60

const memView = reactive<{memories: MemoryItem[]; summaries: MemorySummary[]}>(listAll())

/**
 * 璁板繂鍧楄鍥炬暟鎹?(P4): 鍧?+ 瑙ｆ瀽鍑虹殑鏉＄洰銆?*娴忚鎬?*鎸夊潡鎺掓椂闂寸嚎, 鍧楀唴鍐嶆寜绫诲瀷鍒嗗皬鑺傘€? * 鍒锋柊涓?memView 鍚屾 (瑙?refreshMemView)銆? */
const memBlocks = ref<MemoryBlockView[]>([])
/** 娌℃寕杩涗换浣曞潡鐨勬潯鐩?(瀹炴椂閫氶亾鍐欑殑 / 瀛橀噺鍘婚噸鍚庤鍚堝苟鎺夌殑 / 鏃╂湡鏁版嵁) */
const memUnblocked = ref<MemoryItem[]>([])
/** 銆屽緟鏁寸悊 N 鏉°€? {pending, threshold}; pending 鏀掑埌 threshold 浼氳嚜鍔ㄦ暣鐞?*/
const memPending = ref(organizeProgress([]))

const TYPE_LABELS: Record<string, string> = {
	fact: "浜嬪疄",
	preference: "鍋忓ソ",
	project: "椤圭洰",
	event: "浜嬩欢",
	relationship: "鍏崇郴",
	core: "鏍稿績",
}

const typeLabel = (t: string): string => TYPE_LABELS[t] ?? t

const summaryLabel = (s: MemorySummary): string =>
	`${new Date(s.createdAt).toLocaleString()} 路 瑕嗙洊 ${s.msgCount} 鏉℃秷鎭痐

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
	// A3: 娉ㄥ叆璁板綍鏉℃暟 + 璁板繂鍋ュ悍蹇収 (鍋ュ悍璁℃暟涓嶄緷璧栬瘖鏂紑鍏? 鎵€浠ヤ竴鐩撮兘鍒锋柊)
	injectN.value = injectCount()
	health.value = memoryHealth()
}

/* ---------------- 璁板繂绠＄悊 (鍥哄畾/鍒犻櫎) + 鎾ら攢娓呯悊 + 鐩爣闄即 + 瀵煎嚭 (A2/A3/C3/C4) ---------------- */
const goals = ref<MemoryItem[]>(listGoals())
const goalDraft = ref("")
const hasBackup = ref(hasMemoryBackup())

/**
 * 宸蹭綔搴熺殑璁板繂 (琚敼鍙?绾犳鍙栦唬鐨勯偅浜? B1): 榛樿鎶樺彔鍦ㄣ€屽凡浣滃簾銆嶉噷 鈥斺€?涓嶆敞鍏ャ€佷笉鍙備笌鍙洖,
 * 浣嗙暀鍦ㄥ簱閲? 鐢ㄦ埛鐐广€岃繕鍘熴€嶅氨鑳芥晳鍥炴潵 (璇垽鐨勪唬浠蜂粠"姘镐箙涓?闄嶅埌"鐐逛竴涓?)銆? */
const invalidMems = ref<MemoryItem[]>(listInvalidMemories())

/** 宸叉敹璧?(2026-09-28): 鍒版湡/澶箙娌℃彁琚嚜鍔ㄦ敹璧风殑鏉＄洰; 涓庛€屼綔搴熴€嶇殑鍖哄埆鏄?*娌℃湁琚帹缈?* */
const fadedMems = ref<MemoryItem[]>(listFadedMemories())
/** 宸插垹闄?(2026-09-28, 鍥炴敹绔?: 鎵嬪垹鐨勬潯鐩?甯﹀唴瀹?, 鍙繕鍘? 鏈€澶氱暀 20 鏉?*/
const deletedMems = ref<MemoryItem[]>(listDeletedMemories())

/** 璁板繂璇婃柇鏃ュ織 (P1): 鍐呭瓨閲屽凡缁忔敀浜嗗灏戞鏁寸悊鐨勮瘉鎹?(寮€鍏冲叧鐫€鏃舵亽涓?0) */
const diagN = ref<number>(diagCount())

/* ---------------- A3 (2026-10-08): 娉ㄥ叆鍙鎬?+ 璁板繂鍋ュ悍 ---------------- */

/** 宸茶褰曞灏戞**娉ㄥ叆**锛堜笌鏁寸悊璁板綍鍒嗗紑璁帮紱寮€鍏冲叧鐫€鏃舵亽涓?0锛?*/
const injectN = ref<number>(injectCount())
/** 璁板繂鍋ュ悍蹇収锛氱敓鏁?宸叉敹璧?宸蹭綔搴熴€佷笂娆℃垚鍔熸暣鐞嗐€佹湰娆¤繍琛屾渶鍚庝竴娆℃暣鐞嗙殑缁撴灉銆佷笂杞敞鍏ユ槑缁?*/
const health = ref<MemoryHealth>(memoryHealth())
const onMemoryPersist = (): void => { health.value = memoryHealth() }
onMounted(() => window.addEventListener("nori-memory-persist", onMemoryPersist))
onBeforeUnmount(() => window.removeEventListener("nori-memory-persist", onMemoryPersist))

/** 鏃跺埢鈫掍汉璇?(璇婃柇鍖哄叡鐢? 娌℃湁璁板綍鏃剁粰涓€涓槑纭殑鍗犱綅鑰屼笉鏄┖鐧? */
const fmtWhen = (t: number | null | undefined): string =>
	t ? new Date(t).toLocaleString() : "鈥?

/** 銆屼笂涓€杞敞鍏ャ€嶇殑涓€琛屾憳瑕侊細鏉ユ簮 + 鏉℃暟 + 鏃堕棿 */
const injectSummary = computed(() => {
	const r = health.value.lastInject
	if (!r) return injectN.value ? "锛堝凡璁板綍锛屼絾鏈€杩戜竴娆″凡婊氬嚭鐜舰缂撳啿锛? : "杩樻病鏈夋敞鍏ヨ褰?
	const src: Record<string, string> = {
		"keyword": "鍏抽敭璇?,
		"keyword-kw": "鍏抽敭璇嵚峰埆鍚嶅厹搴?,
		"smart-llm": "AI 璇箟鍙洖",
		"smart-fallback": "AI 澶辫触 鈫?鍏抽敭璇嶉檷绾?,
		"opening": "寮€鍦烘敞鍏?,
	}
	return `${src[r.source] ?? r.source} 路 娉ㄥ叆 ${r.hits.length}/${r.limit} 鏉?路 搴撻噷鐢熸晥 ${r.considered} 鏉?路 杩囬棬妲?${r.matched} 鏉?路 ${new Date(r.ts).toLocaleTimeString()}`
})

/** 瀵煎嚭娉ㄥ叆璁板綍 (涓庢暣鐞嗚瘖鏂垎寮€涓€涓枃浠? mem-inject-*.jsonl) */
const doExportInject = () => {
	if (!injectN.value) { triggerBubble("杩樻病鏈夋敞鍏ヨ褰?鈥斺€?鍏堟墦寮€涓婇潰鐨勫紑鍏筹紝鍐嶈亰涓€鍙?); return }
	const text = buildInjectJsonl({model: cfg.model, app: "NoriDroid"})
	const d = new Date()
	const p2 = (n: number) => String(n).padStart(2, "0")
	const name = `mem-inject-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.jsonl`
	try {
		const ok = writeFile(name, text)
		triggerBubble(ok ? `宸插鍑?${name}锛?{injectN.value} 鏉★級` : "瀵煎嚭澶辫触")
	} catch {
		triggerBubble("瀵煎嚭澶辫触")
	}
}

/** 鏀惰捣鍘熷洜鐨勪汉璇?(鍙湪杩欎竴澶勬嫾, 鍏嶅緱鏁ｈ惤) */
const fadeReasonLabel = (m: MemoryItem): string => {
	if (m.fadedReason === "lowvalue") return "澶箙娌℃彁銆佷笉澶噸瑕?
	if (m.fadedReason === "manual") return "浣犳墜鍔ㄦ敹璧风殑"
	return "鍒版湡浜嗭紙寰堜箙娌℃彁锛?
}

/** 鎶婁竴鏉¤鏀惰捣鐨勮蹇嗘斁鍥炵敓鏁?*/
const doRestoreFaded = (m: MemoryItem) => {
	if (!restoreFadedMemory(m.id)) { triggerBubble("杩欐潯宸茬粡鏀惧洖鍘讳簡"); return }
	refreshMemView()
	triggerBubble("宸茬粡鏀惧洖鐢熸晥鍟?)
}

/** 浠庡洖鏀剁珯杩樺師涓€鏉¤鍒犵殑璁板繂 */
const doRestoreDeleted = (m: MemoryItem) => {
	if (!restoreDeletedMemory(m.id)) { triggerBubble("杩欐潯宸茬粡涓嶅湪鍥炴敹绔欓噷浜?); return }
	refreshMemView()
	triggerBubble(m.invalidAt ? "宸茶繕鍘熷埌宸蹭綔搴燂紝闇€鍙﹁杩樺師鎵嶄細鐢熸晥" : m.fadedAt ? "宸茶繕鍘熷埌宸叉敹璧凤紝鐐圭暀涓嬫墠浼氱敓鏁? : "宸茶繕鍘熷埌鐢熸晥鍒楄〃")
}

/** 璁板繂浼樺寲 (鏁寸悊浼樺寲) 鐨勭晫闈㈢姸鎬? 褰撳墠绀轰緥闆?+ 鏄惁灞曞紑鏌ョ湅 */
const tuneShow = ref(false)
const tuneSet = ref<{builtAt: number; basedOn: number; pos: string[]; neg: string[]} | null>(null)
const tuneHas = computed(() => !!tuneSet.value && (tuneSet.value.pos.length > 0 || tuneSet.value.neg.length > 0))
const tunePos = computed(() => tuneSet.value?.pos ?? [])
const tuneNeg = computed(() => tuneSet.value?.neg ?? [])
const tuneInfo = computed(() => {
	const e = tuneSet.value
	if (!e || (!e.pos.length && !e.neg.length)) return "杩樻病鏈夌ず渚嬨€備緥瀛愭潵鑷敓鏁堜腑鐨勮蹇嗭紱鍒犻櫎鍜屾敹璧蜂笉浼氳嚜鍔ㄥ綋鍙嶄緥銆傜偣銆岀珛鍗充紭鍖栥€嶇敓鎴?
	return `涓婃浼樺寲锛?{fmtTs(e.builtAt)} 路 姝ｄ緥 ${e.pos.length} 鏉?/ 鍙嶄緥 ${e.neg.length} 鏉★紙鍩轰簬褰撴椂 ${e.basedOn} 鏉¤蹇嗭級`
})

/** 銆岀珛鍗充紭鍖栥€? 棣栨缁欎竴娆℃彁閱?鈥斺€?渚嬪瓙鏄粠"浣犵暀涓嬬殑璁板繂"閲屽鐨? 娌＄敤鐨勫厛鍒犳帀 */
const doRebuildExamples = () => {
	if (!tuneHas.value) {
		const ok = window.confirm(
			"渚嬪瓙鏄粠浣?*鐣欎笅鐨?*璁板繂閲屽鐨勶紝娌＄敤鐨勫厛鍒犳帀鏇村ソ 鈥斺€擻n" +
			"鍒犻櫎鍙兘鏄噸澶嶃€佽繃鏃舵垨闅愮鍘熷洜锛屼笉浼氳嚜鍔ㄥ綋鍙嶄緥锛涘厛妫€鏌ョ敓鏁堣蹇嗘槸鍚﹀噯纭€俓n\n" +
			"纭畾鐜板湪灏辩敓鎴愮ず渚嬪悧锛燂紙鍏堝彇娑堬紝鍘绘妸娌＄敤鐨勮蹇嗗垹鎺変篃琛岋級",
		)
		if (!ok) { triggerBubble("閭ｆ垜绛変綘鏁寸悊濂藉暒"); return }
	}
	const built = rebuildMemoryExamples()
	refreshMemView()
	triggerBubble(built ? "绀轰緥宸叉洿鏂帮紝鎴戠収浣犵殑鍙ｅ懗鏉ヨ" : "璁板繂杩樺お灏戯紝鍏堜笉鐢熸垚绀轰緥")
}

const doClearExamples = () => {
	clearMemoryExamples()
	refreshMemView()
	triggerBubble("绀轰緥宸叉竻闄わ紝鍥炲埌榛樿瑙勫垯")
}

/** 鑷姩浼樺寲: 姣忔鏁寸悊鎴愬姛鍚庢鏌ヤ竴娆?(鏂板 鈮?0 鏉℃墠閲嶅缓, 闆堕澶栬皟鐢? */
const maybeAutoTuneExamples = () => {
	if (!cfg.memoryAutoTuneExamples) return
	if (!shouldRebuildMemoryExamples()) return
	if (rebuildMemoryExamples()) refreshMemView()
}

/* ---------------- 璁板繂璇婃柇鏃ュ織 (P1, 2026-09-30) ---------------- */

/** 寮€鍏? 绔嬪埢鍚屾缁欒蹇嗘ā鍧?(鍏虫帀鍚庝笉鍐嶈褰? 宸茶褰曠殑涓嶆竻 鈥斺€?鐢ㄦ埛鍙兘姝ｈ瀵煎嚭) */
const onDiagToggle = () => {
	setDiagEnabled(!!cfg.memoryDiagnostics)
	persistSettings()   // 绔嬪埢钀界洏: 鍚﹀垯閲嶅惎 App 浼氬洖鍒板叧闂? 鎮诞绐椾篃璇讳笉鍒拌繖涓紑鍏?	diagN.value = diagCount()
	injectN.value = injectCount()
	health.value = memoryHealth()
	triggerBubble(cfg.memoryDiagnostics ? "寮€濮嬭褰曟暣鐞嗕笌娉ㄥ叆杩囩▼锛屽鍑哄湪鍚屼竴娆￠噷鍋氬摝" : "宸插仠姝㈣褰曪紙宸叉湁鐨勮褰曡繕鍦紝鍙互瀵煎嚭锛?)
}

/** 瀵煎嚭: 璧颁笌銆屽鍑恒€嶅悓涓€鏉?writeFile 閫氶亾 (钀藉埌 Download/NoriDroid/) */
const doExportDiag = () => {
	if (!diagN.value) { triggerBubble("杩樻病鏈夎褰?鈥斺€?鍏堟墦寮€涓婇潰鐨勫紑鍏?); return }
	const text = buildDiagJsonl({model: cfg.model, app: "NoriDroid"})
	const d = new Date()
	const name = `mem-diag-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}.jsonl`
	try {
		const ok = writeFile(name, text)
		triggerBubble(ok ? `宸插鍑?${name}锛?{diagN.value} 鏉¤褰曪級` : "瀵煎嚭澶辫触")
	} catch {
		triggerBubble("瀵煎嚭澶辫触")
	}
}

const doClearDiag = () => {
	clearDiag()
	// A3: 娉ㄥ叆璁板綍涔熷湪鍚屼竴涓紑鍏充笅鏀掔潃, 涓€骞舵竻鎺?(鍚﹀垯"娓呯┖璁板綍"鐪嬭捣鏉ユ病鐢熸晥)
	clearInjects()
	diagN.value = diagCount()
	injectN.value = injectCount()
	health.value = memoryHealth()
	triggerBubble("鏁寸悊涓庢敞鍏ヨ褰曢兘宸叉竻绌?)
}

/** 姘镐箙鍒犻櫎 (浠庡洖鏀剁珯鎶规帀): 杩欐槸**鍞竴涓嶅彲閫?*鐨勬搷浣? 鎵€浠ヨ浜屾纭 */const doDeleteForever = (m: MemoryItem) => {
	if (!window.confirm(`姘镐箙鍒犻櫎杩欐潯璁板繂锛熷垹浜嗗氨鎵句笉鍥炴潵浜嗐€俓n銆?{m.content}銆峘)) return
	deleteMemoryForever(m.id)
	refreshMemView()
	triggerBubble("宸叉案涔呭垹闄?)
}

/** 杩樺師涓€鏉¤浣滃簾鐨勮蹇?(B1) */
const doRestoreInvalid = (m: MemoryItem) => {
	if (!restoreMemory(m.id)) { triggerBubble("杩欐潯宸茬粡杩樺師杩囦簡"); return }
	refreshMemView()
	triggerBubble("宸茶繕鍘燂紝鎴戝張璁拌捣鏉ュ暒")
}

/** 闀挎湡璁板繂灞曠ず鍒楄〃: 鎺掗櫎鐩爣鏉＄洰 (鐩爣鏈変笓闂ㄧ殑"闄潃浣犵殑浜?灏忚妭, 閬垮厤涓ゅ閲嶅) */
const nonGoalMemories = computed(() =>
	memView.memories.filter(m => !(m.tags ?? []).includes("goal"))
)

/** 璁板繂搴撻〉 (鐙珛椤?: 鎼滅储 + 绫诲瀷绛涢€?*/
const memSearch = ref("")
const memFilter = ref("") // "" | 绫诲瀷 | goal | pinned
const openMemoriesPage = () => openPanel("memories")
const filteredMems = computed(() => {
	// 鐩爣鏉￠粯璁?*涓嶅湪闀挎湡璁板繂閲岄噸澶嶅嚭鐜?* 鈥斺€?瀹冧滑涓婇潰宸叉湁銆岄櫔鐫€浣犵殑浜嬨€嶅皬鑺?
	// 涓ゅ閮藉垪涓€閬嶆鏄敤鎴疯鐨?娣峰湪涓€璧?銆備絾鏄惧紡绛涢€夈€岀洰鏍囥€嶆垨鍦ㄦ悳绱㈡椂鐓у父鍙備笌,
	// 鍚﹀垯鎼滀笉鍒扮洰鏍囧唴瀹?(鎼?闆呮€?蹇呴』鑳芥壘鍒般€岃€冮泤鎬?7 鍒嗐€?銆?	const q0 = memSearch.value.trim().toLowerCase()
	let list = (memFilter.value === "goal" || q0) ? memView.memories : nonGoalMemories.value
	if (memFilter.value === "goal") list = list.filter(m => (m.tags ?? []).includes("goal"))
	else if (memFilter.value === "pinned") list = list.filter(m => (m.tags ?? []).includes("pinned"))
	else if (memFilter.value) list = list.filter(m => m.type === memFilter.value)
	if (q0) list = list.filter(m => m.content.toLowerCase().includes(q0))
	return list
})

/** 鏉ユ簮鏍囨敞璇存槑澶勭悊鏂瑰紡锛涙棫璁板綍鏉ユ簮涓嶅畬鏁达紝涓嶈兘鐩存帴绉颁负鐢ㄦ埛澹版槑銆?*/
const isInferred = (m: MemoryItem): boolean => m.sourceKind === "llm" || (m.tags ?? []).includes("llm")
const memProvenance = (m: MemoryItem): string => (isInferred(m) ? "AI 鏁寸悊" : m.sourceKind === "rule" ? "鍘熻瘽鎻愬彇" : "鏃ц褰?鎵嬪姩")
const PROV_TIP = "鍘熻瘽鎻愬彇 = 瑙勫垯鍛戒腑锛汚I 鏁寸悊 = 妯″瀷浠庡璇濈瓫鍑猴紝闇€瑕佹牳瀵癸紱鏃ц褰曠殑鏉ユ簮鍙兘涓嶅畬鏁?

/** 绫诲瀷鍦ㄨ蹇嗗簱閲岀殑灞曠ず椤哄簭 (鍒嗙粍灏忚妭鐨勫厛鍚? 鐩爣鍗曠嫭涓€鑺? 涓嶅湪姝ゅ垪) */
const TYPE_ORDER: MemoryType[] = ["core", "fact", "preference", "project", "event", "relationship"]

/**
 * 鎸夌被鍨嬪垎缁勭殑闀挎湡璁板繂 (鐢ㄦ埛 2026-09-27 瑕佹眰: "鍚岀被鍨嬫爣绛惧垎绫诲埌涓€鍧? 鐜板湪閮芥贩鍦ㄤ竴璧?)銆? * 缁勫唴淇濇寔浼犲叆椤哄簭 (閲嶈搴︿紭鍏?鈫?鏂版棫), 缁勯棿鎸?TYPE_ORDER, 绌虹粍涓嶆樉绀恒€? * P4 璧锋娊鎴愬嚱鏁? 鍧楄鍥剧殑姣忎竴鍧楀唴閮ㄤ篃鐢ㄥ畠 (鍧楀唴鎸夌被鍨嬪垎灏忚妭)銆? */
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

/** 鎼滅储/绛涢€夋€佺殑骞抽摵鍒嗙粍 (鎵句笢瑗跨殑鍦烘櫙: 涓嶆寜鏃堕棿绾? 鐩存帴鎸夌被鍨嬪垪鍑烘潵) */
const groupedMems = computed(() => groupByType(filteredMems.value))

/** 鍧楄鍥惧彲灞曠ず鐨勬潯鐩? 鐢熸晥涓?涓?涓嶆槸鐩爣 (鐩爣鏈夎嚜宸遍偅涓€鑺? */
const blockVisible = (m: MemoryItem): boolean =>
	!m.invalidAt && !m.fadedAt && !(m.tags ?? []).includes("goal")

/** 鍧楁爣棰? 銆屼富棰?路 鏃堕棿娈?路 N 鏉°€? 杩佺Щ鍧?(鏃╂湡璁板繂) 娌℃湁涓婚涓庡尯闂存椂鍙樉绀轰富棰?*/
const blockTitle = (b: MemoryBlock): string => {
	const topic = b.topic || "鏈懡鍚?
	if (!b.msgCount) return topic   // 杩佺Щ鍧? 娌℃湁"瑕嗙洊浜嗗灏戞潯娑堟伅"杩欏洖浜?	const from = fmtTs(b.fromTs)
	const to = fmtTs(b.toTs)
	// 鍚屼竴鍒嗛挓鍐呭彧鍐欎竴涓椂闂? 25 鏉℃秷鎭彲鑳藉彧璺ㄥ嚑鍗佺, 鍚﹀垯浼氭樉绀烘垚銆?2:25 ~ 22:25銆?瀹炴祴鎴浘閲屽氨鏄繖鏍?
	const range = from === to ? from : `${from} ~ ${to}`
	return `${topic} 路 ${range} 路 ${b.msgCount} 鏉″璇漙
}

/**
 * 璁板繂搴撶殑**娓叉煋璁″垝** (P4): 涓€澶勭畻瀹? 妯℃澘鍙仛涓ゅ眰寰幆, 涓嶅繀涓哄潡/骞抽摵/鏈綊绫诲悇鍐欎竴閬嶈鏍囪銆? * - 娴忚鎬? 姣忎釜璁板繂鍧椾竴鑺?(鍧楀唴鎸夌被鍨嬪垎灏忚妭) + 銆屾湭褰掔被銆嶄竴鑺?
 * - 鎼滅储/绛涢€夋€? 閫€鍥?鎸夌被鍨嬪钩閾? (鎵句笢瑗挎椂鏃堕棿绾垮弽鑰屾槸骞叉壈)銆? */
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
	if (unblocked.length) out.push({key: "unblocked", title: "鏈綊绫?, subs: unblocked})
	return out
})

/** 銆岀珛鍗虫暣鐞嗐€? 涓嶇瓑鏀掑闃堝€? 鐜板湪灏辨妸寰呮暣鐞嗙殑娑堟伅鎬荤粨鎴愭憳瑕?+ 璁板繂鍧?(鍚屼竴鏉￠摼璺? */
const memOrganizing = ref(false)
/**
 * 銆岀珛鍗虫暣鐞嗐€嶇殑鍙嶉 (A: 灏卞湴鍙嶉)銆? * 涓轰粈涔堜笉澶嶇敤涓嬮潰閭ｄ釜 `memPruneMsg`: 閭ｄ釜鎻愮ず娓叉煋鍦ㄩ潰鏉?*鏈€搴曢儴**(涓庢竻鐞?鎾ら攢鎸夐挳鍚屼竴琛?,
 * 鑰?绔嬪嵆鏁寸悊"鎸夐挳鍦ㄩ潰鏉夸笂閮?鈥斺€?鐢ㄦ埛鐐瑰畬瑙嗙嚎涓嶅線涓嬭蛋, 瀹炴祴浣撴劅灏辨槸"鐐逛簡娌″弽搴?
 * (鎺㈤拡 probe-organize-button.mjs 閲忓埌鍙嶉鍦?776/808 鈮?96% 澶?銆傛墍浠ヨ繖閲屽崟鐙竴浠界姸鎬? 灏卞湴鏄剧ず銆? */
const memOrgMsg = ref("")
const memOrgMsgOk = ref(false)
/** 鏈夋病鏈変笢瑗垮彲鏁寸悊 (B: 娌℃湁灏辨妸鎸夐挳缃伆, 鍒瀹?鍙偣浣嗘棤浜嬪彂鐢?) */
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
		maybeAutoTuneExamples()   // 鑷姩浼樺寲 (寮€鍏虫墦寮€鏃?: 鏂板澶?20 鏉″氨椤烘墜鍒锋柊绀轰緥
		refreshMemView()
		const left = memPending.value.pending
		if (summarized) {
			memOrgMsg.value = left > 0
				? `宸叉暣鐞嗕竴鎵癸紝杩樺墿 ${left} 鏉″緟鏁寸悊锛堝啀鐐逛竴娆″彲缁х画锛塦
				: "宸茬粡鏁寸悊瀹屽暒锛屽垰鎵嶈亰鐨勬垜閮借浣忎簡"
			memOrgMsgOk.value = true
		} else {
			// 璧板埌杩欓噷鏈変袱绉? 妯″瀷娌″洖鍐呭 (鏈夊彲鏁寸悊鐨勪笢瑗夸絾澶辫触浜? / 鏁寸悊鏈熼棿寰呮暣鐞嗚娓呯┖
			memOrgMsg.value = left > 0
				? "杩欐娌¤兘鏁寸悊鍑烘潵锛堟ā鍨嬫病鍥炲唴瀹癸級锛岀◢鍚庡啀璇?
				: "娌℃湁寰呮暣鐞嗙殑鍐呭 鈥斺€?鏈€杩戠殑璇濋兘杩樺湪鎴戠溂鍓嶏紝涓嶇敤鏁寸悊"
			memOrgMsgOk.value = false
		}
	} catch (e) {
		console.error("[mem] 绔嬪嵆鏁寸悊澶辫触:", e)
		memOrgMsg.value = "鏁寸悊澶辫触锛岀◢鍚庡啀璇?
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
	triggerBubble(isPinnedId(m.id) ? "宸插浐瀹氾紝杩欐潯涓嶄細娣″繕" : "宸插彇娑堝浐瀹?)
}

/**
 * 銆屾敹璧枫€嶄竴鏉¤蹇?(2026-09-29 鐢ㄦ埛瑕佹眰: 鏉＄洰琛屽師鏉ュ彧鏈夊垹闄?銆? * 鎰忓浘 = "杩欐潯鐜板湪涓嶉噸瑕侊紝浣嗗埆鍒? 鈬?杩涖€屽凡鏀惰捣銆嶏紝鐐广€岀暀涓嬨€嶆斁鍥炪€? */
const doFadeMemory = (m: MemoryItem) => {
	if (!fadeMemoryManually(m.id)) { triggerBubble("杩欐潯宸茬粡鏀惰捣鏉ヤ簡"); return }
	refreshMemView()
	triggerBubble("宸叉敹璧凤紝闅忔椂鑳藉湪銆屽凡鏀惰捣銆嶉噷鐐广€岀暀涓嬨€嶆斁鍥炴潵")
}

const doDeleteMemory = (m: MemoryItem) => {
	if (!window.confirm(`鍒犻櫎杩欐潯璁板繂锛焅n銆?{m.content}銆峔n锛堜細鍏堣繘銆屽凡鍒犻櫎銆嶏紝鑳借繕鍘燂紱鎯充笉鍒犲彧鏄殏鏃朵笉閲嶈锛屽彲浠ョ敤銆屾敹璧枫€嶏級`)) return
	deleteMemory(m.id)
	refreshMemView()
	triggerBubble("宸插垹闄わ紝鍙湪銆屽凡鍒犻櫎銆嶉噷杩樺師")
}

/** 鎾ら攢涓婃娓呯┖/娓呯悊 (鐢?before-clear 蹇収鏁翠綋杩樺師) */
const doRestoreMemory = () => {
	if (!hasMemoryBackup()) { triggerBubble("娌℃湁鍙仮澶嶇殑澶囦唤"); return }
	if (!window.confirm("鐢ㄦ渶杩戜竴娆℃竻鐞嗗墠鐨勮蹇嗚鐩栧綋鍓嶅唴瀹癸紵")) return
	restoreMemoryBackup()
	refreshMemView()
	triggerBubble("宸叉仮澶嶆竻鐞嗗墠鐨勮蹇?)
}

const doAddGoal = () => {
	const t = goalDraft.value.trim()
	if (!t) return
	addGoal(t)
	goalDraft.value = ""
	refreshMemView()
	triggerBubble("濂斤紝鎴戜細闄綘鐩潃杩欎欢浜嬬殑")
}

const doRemoveGoal = (id: string) => {
	removeGoal(id)
	refreshMemView()
}

/* ---------------- 瀵煎嚭 (C4): 璁板繂+鎬荤粨+鏃ヨ 鈫?Markdown 鏂囦欢 ---------------- */
const pad2 = (n: number): string => `${n}`.padStart(2, "0")
const localDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const fmtTs = (ts: number): string => {
	const d = new Date(ts)
	return `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const buildExportMd = (withDiary: boolean): string => {
	const lines: string[] = []
	lines.push("# DeepEr 鏁版嵁瀵煎嚭", `瀵煎嚭鏃堕棿锛?{new Date().toLocaleString()}`, "")
	const data = listAll()
	// 鐩爣鍗曠嫭涓€娈?(瀹冧滑涓嶅湪"闀挎湡璁板繂"閲岄噸澶嶅嚭鐜? 瑙佽蹇嗗簱鐨勫垎鑺傞€昏緫)
	const goalList = listGoals()
	if (goalList.length) {
		lines.push(`## 闄潃浣犵殑浜嬶紙鐩爣锛?{goalList.length} 鏉★級`)
		for (const g of goalList) lines.push(`- ${g.content} 路 ${fmtTs(g.createdAt)}`)
		lines.push("")
	}
	lines.push(`## 闀挎湡璁板繂锛?{data.memories.length} 鏉★級`)
	for (const m of data.memories) {
		const pin = (m.tags ?? []).includes("pinned") ? "锛堝凡鍥哄畾锛? : ""
		lines.push(`- [${typeLabel(m.type)}路${memProvenance(m)}] ${m.content}${pin} 路 ${fmtTs(m.createdAt)} 路 閲嶈鎬?${m.importance}`)
	}
	// 璁板繂鍧楁椂闂寸嚎 (2026-09-29 琛?: 璁╀汉鑳界湅鍑?鍝鏃堕棿鑱婁簡浠€涔?, 涔熸槸鍧楃殑鎴愬憳鍏崇郴鍑瘉
	const blocks = listBlocks()
	if (blocks.length) {
		lines.push("", `## 璁板繂鍧楁椂闂寸嚎锛?{blocks.length} 娈碉級`)
		for (const b of blocks) {
			const range = b.block.msgCount
				? `${fmtTs(b.block.fromTs)} ~ ${fmtTs(b.block.toTs)} 路 ${b.block.msgCount} 鏉″璇漙
				: "鏃╂湡璁板繂锛堣縼绉诲墠鐨勫瓨閲忥級"
			lines.push(`- ${b.block.topic || "鏈懡鍚?} 路 ${range} 路 ${b.items.filter(i => !i.invalidAt && !i.fadedAt).length} 鏉＄敓鏁坄)
		}
	}
	// 鏈綊绫?(娌℃寕杩涗换浣曞潡鐨勬潯鐩?
	const unblocked = listUnblockedMemories()
	if (unblocked.length) {
		lines.push("", `## 鏈綊绫伙紙${unblocked.length} 鏉?路 娌℃寕杩涗换浣曡蹇嗗潡锛塦)
		for (const m of unblocked) lines.push(`- [${typeLabel(m.type)}] ${m.content} 路 ${fmtTs(m.createdAt)}`)
	}
	// 宸蹭綔搴熺殑璁板繂 (B1): 瀵煎嚭瑕佸甫涓?鍘嗗彶" 鈥斺€?鐢ㄦ埛鍙兘闈犲畠澶嶇洏 she 鏄粈涔堟椂鍊欐敼鍙ｇ殑
	const invalid = listInvalidMemories()
	if (invalid.length) {
		lines.push("", `## 宸蹭綔搴熺殑璁板繂锛?{invalid.length} 鏉?路 宸茶鍚庢潵璇寸殑璇濆彇浠ｏ紝Nori 涓嶅啀浣跨敤锛塦)
		for (const m of invalid) {
			lines.push(`- [${typeLabel(m.type)}路${memProvenance(m)}] ${m.content} 路 璁颁簬 ${fmtTs(m.createdAt)} 路 浣滃簾浜?${fmtTs(m.invalidAt ?? 0)}`)
		}
	}
	// 宸叉敹璧?/ 鍥炴敹绔?(2026-09-29 琛?: 瀵煎嚭瑕佽兘褰?鍏ㄩ噺澶囦唤"鐢?鈥斺€?浠庢柊鍖呴€€鍥炴棫鍖呭墠,
	// 杩欎袱鍧楀湪鏃у寘閲屾槸鐪嬩笉瑙佺殑 (鏃т唬鐮佷笉璁?fadedAt/deletedBin), 瀵煎嚭鏄敮涓€鐨勫彇鍥炴笭閬?	const faded = listFadedMemories()
	if (faded.length) {
		lines.push("", `## 宸叉敹璧风殑璁板繂锛?{faded.length} 鏉?路 澶箙娌℃彁鎴栧埌鏈熻嚜鍔ㄦ敹璧凤紝鍙湪璁板繂搴撶偣銆岀暀涓嬨€嶆斁鍥烇級`)
		for (const m of faded) {
			lines.push(`- [${typeLabel(m.type)}] ${m.content} 路 ${fadeReasonLabel(m)} 路 鏀惰捣浜?${fmtTs(m.fadedAt ?? 0)}`)
		}
	}
	const deleted = listDeletedMemories()
	if (deleted.length) {
		lines.push("", `## 宸插垹闄わ紙鍥炴敹绔欙紝${deleted.length} 鏉?路 鍙湪璁板繂搴撶偣銆岃繕鍘熴€嶅彇鍥烇紱銆屾案涔呭垹闄ゃ€嶅悗涓嶅啀鍑虹幇锛塦)
		for (const m of deleted) {
			lines.push(`- [${typeLabel(m.type)}] ${m.content} 路 鍒犻櫎浜?${fmtTs(m.deletedAt ?? 0)}`)
		}
	}
	// 璁板繂浼樺寲绀轰緥闆?(鏁寸悊浼樺寲): 瀵煎嚭甯︿笂, 鎹㈡満/鎺掓煡鏃惰兘鐪嬪嚭"濂圭幇鍦ㄧ収浠€涔堝彛鍛宠"
	const ex = getMemoryExamples()
	if (ex && (ex.pos.length || ex.neg.length)) {
		lines.push("", `## 璁板繂浼樺寲绀轰緥锛堢敓鎴愪簬 ${fmtTs(ex.builtAt)} 路 鍩轰簬褰撴椂 ${ex.basedOn} 鏉¤蹇嗭級`)
		if (ex.pos.length) lines.push(`- 璇ヨ锛?{ex.pos.join(" / ")}`)
		if (ex.neg.length) lines.push(`- 涓嶈璁帮細${ex.neg.join(" / ")}`)
	}
	lines.push("", `## 鍘嗗彶鎬荤粨锛?{data.summaries.length} 鏉★級`)
	for (const s of data.summaries) {
		lines.push(`- ${fmtTs(s.createdAt)}锛?{s.content}`)
	}
	if (withDiary) {
		const diary = listDiary()
		lines.push("", `## Nori 鐨勬棩璁帮紙${diary.length} 绡囷級`)
		for (const e of diary) {
			lines.push(`### ${e.date} 路 ${e.mood}`, e.content, "")
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
		triggerBubble(ok ? `宸插鍑?${name}` : "瀵煎嚭澶辫触")
	} catch {
		triggerBubble("瀵煎嚭澶辫触")
	}
}

/* ---------------- 鏃ヨ锛氱┖闂叉椂鏈€澶氳ˉ涓€绡囷紝鑱婂ぉ寮€濮嬪嵆鍋滄 ---------------- */
const openDiary = () => openPanel("diary")
let diaryIdleTimer: ReturnType<typeof setTimeout> | null = null
let diaryAutoAbort: AbortController | null = null
const stopAutoDiary = () => {
	if (diaryIdleTimer) clearTimeout(diaryIdleTimer)
	diaryIdleTimer = null
	diaryAutoAbort?.abort()
}
const scheduleDiary = () => {
	if (diaryIdleTimer) clearTimeout(diaryIdleTimer)
	diaryIdleTimer = setTimeout(async () => {
		diaryIdleTimer = null
		if (document.hidden || window.__noriAppPaused || chatStreaming.value || touchStreaming.value || diaryAutoAbort || !cfg.apiKey.trim() || !cfg.model.trim()) return
		const ac = new AbortController()
		diaryAutoAbort = ac
		try {
			await ensureDiary(async (system, material) => {
				const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
					{role: "system", content: system, ts: Date.now()},
					{role: "user", content: material ?? "", ts: Date.now()},
				], false, {signal: ac.signal})
				if (!r.ok) throw new Error(r.message || "鏃ヨ鐢熸垚澶辫触锛岃绋嶅悗閲嶈瘯")
				return r.content ?? ""
			}, ac.signal)
			window.dispatchEvent(new Event("nori-diary-updated"))
		} finally { if (diaryAutoAbort === ac) diaryAutoAbort = null }
	}, 1800)
}
watch([chatStreaming, touchStreaming], ([chat, touch]) => { if (chat || touch) stopAutoDiary() })
onMounted(scheduleDiary)
onBeforeUnmount(stopAutoDiary)

const doClearMemory = () => {
	if (!window.confirm("纭畾娓呯┖鍏ㄩ儴闀挎湡璁板繂鍜屽巻鍙叉憳瑕佸悧锛?)) return
	// 娓呯┖鍓嶈嚜鍔ㄥ浠?鈫?鍙?鎾ら攢涓婃娓呯悊"涓€閿繕鍘?	backupMemoryNow()
	clearMemory()
	refreshMemView()
	triggerBubble("宸叉竻绌鸿蹇?)
}

const memPruneMsg = ref("")
const memPruneMsgOk = ref(false)

const doPruneMemories = () => {
	// 鍙湪璇ユ娓呯悊鐪熶細鍒犱笢瑗挎椂鎵嶅浠?鈥斺€?鏃犳晥娓呯悊鑻ヨ鐩栧浠?
	// 浼氭妸"娓呯┖鍓?鐨勬挙閿€鐐瑰紕涓?(涓婃娓呯┖鐨勫浠借绌烘搷浣滈《鎺?
	if (pruneStalePreview() > 0) backupMemoryNow()
	const removed = pruneStaleMemories()
	if (removed > 0) {
		refreshMemView()
		memPruneMsg.value = `宸叉敹璧?${removed} 鏉′綆棰戣蹇嗭紝鍙湪銆屽凡鏀惰捣銆嶉噷鐐广€岀暀涓嬨€嶆斁鍥瀈
		memPruneMsgOk.value = true
	} else {
		memPruneMsg.value = "娌℃湁闇€瑕佹竻鐞嗙殑浣庨璁板繂锛堥兘寰堟柊椴滄垨鏈変环鍊硷級"
		memPruneMsgOk.value = false
	}
}

/* ---------------- Fish Audio 娴佸紡 TTS UI 鐘舵€?---------------- */
const speaking = ref(false)
watch([typing, chatStreaming, touchStreaming, speaking], () => schedulePortraitReplyClear())
const ttsTesting = ref(false)
const ttsMsg = ref("")
const ttsMsgOk = ref(false)

/** 婊戝潡瀹炴椂璋冩暣"搴旂敤鍐呮湕璇婚煶閲? (鍙奖鍝嶆湰 App 鎾斁, 涓嶅姩绯荤粺闊抽噺; 鏉炬墜鏃?change 浜嬩欢钀界洏) */
const applyTtsVolume = () => setTtsVolume(Number(cfg.ttsVolume))

/* ---------------- 鑳屾櫙闊充箰 ---------------- */
const bgmNowName = ref("")
const bgmState = ref<BgmState>("missing")
const bgmPct = ref(0)
const setBgmEnabled = (enabled: boolean): void => {
	cfg.bgmEnabled = enabled
	const id = syncBgm(cfg)
	bgmNowName.value = id ? bgmNameOf(id) : bgmNameOf(cfg.bgmTrack)
	persistSettings()
}
const onBgmToggle = (e: Event): void => setBgmEnabled((e.target as HTMLInputElement).checked)
const onBgmQuickToggle = (): void => {
	if (bgmState.value === "missing" && cfg.bgmEnabled) {
		downloadBgm()
		return
	}
	setBgmEnabled(!cfg.bgmEnabled)
}
const onBgmTrackChange = (e: Event): void => {
	cfg.bgmTrack = (e.target as HTMLSelectElement).value
	const id = syncBgm(cfg)
	bgmNowName.value = id ? bgmNameOf(id) : bgmNameOf(cfg.bgmTrack)
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
 * 銆屼笅杞借儗鏅煶涔愯祫婧愩€?銆岄噸鏂颁笅杞姐€嶄袱涓寜閽殑鍏ュ彛銆? * 鈿?涓嶈鍐欐垚 `@click="downloadBgm"` 鈥斺€?Vue 浼氭妸 MouseEvent 褰撶涓€涓疄鍙備紶杩?`force`,
 * 浜嬩欢瀵硅薄鎭掍负鐪熷€?鈬?鏅€氫笅杞戒篃浼氳褰撴垚"寮哄埗閲嶄笅"锛堢綉缁滅櫧璺戜竴瓒燂級銆? */
const onBgmDownload = (): void => downloadBgm()
const onBgmRedownload = (): void => downloadBgm(true)
const onSfxVolume = (): void => setSfxVolume(Number(cfg.sfxVolume))

/* ---------------- 闊虫晥鏂囦欢 (鑱旂綉涓嬭浇, 2026-10-02) ----------------
 * 5 涓師鐗?m4a 涓嶅啀杩涘寘: 鐐广€屼笅杞介煶鏁堛€嶁啋 鍘熺敓妗ヤ笅鍒板簲鐢ㄧ鏈夌洰褰?鈫?鐢?/sfx-local/ 鎾斁
 * (缁嗚妭瑙?services/sfx.ts)銆傝繖閲屽彧绠¤缃潰鏉块偅涓€琛岀殑鐘舵€佹枃妗堛€?*/
const sfxMsg = ref("鏈笅杞斤紙鐐瑰彸杈规寜閽級")
const sfxMsgOk = ref(false)
const sfxMsgBad = ref(false)
const sfxBusy = ref(false)
const sfxTotal = ref(5)
/** 璇曡繃涓€娆?鎴栬€呭惎鍔ㄦ椂灏卞凡缁忛綈浜? 鈬?鎸夐挳鏄剧ず銆岄噸鏂颁笅杞姐€? 浠庢病涓嬭繃鎵嶆槸銆屼笅杞介煶鏁堛€?*/
const sfxTried = ref(false)
const sfxBtnText = computed((): string => {
	if (sfxBusy.value) return "涓嬭浇涓€?
	return sfxTried.value ? "閲嶆柊涓嬭浇" : "涓嬭浇闊虫晥"
})

/** 鍒锋柊鐘舵€佽 (鏈笅杞?/ 涓嬭浇涓?/ 宸蹭笅杞?N/N / 涓嬭浇澶辫触) 鈥斺€?鍥涙€侀兘鍦ㄨ繖涓€澶勬敹鍙?*/
const sfxShowStatus = (st: {ready: boolean; done: number; total: number}, failed: string[] = []): void => {
	sfxTotal.value = st.total > 0 ? st.total : 5
	if (sfxBusy.value) {
		sfxMsg.value = "涓嬭浇涓€?
		sfxMsgOk.value = false
		sfxMsgBad.value = false
		return
	}
	if (failed.length) {
		sfxTried.value = true
		// 鍏ㄩ兘娌′笅鏉?鈮?缃戠粶涓嶉€?(鍥藉唴鐩磋繛澶ф鐜囦笉琛?: 鎶婃簮绔欎竴璧峰啓鍑烘潵, 鏂逛究鎺掓煡;
		// 涓埆澶辫触灏辨妸鏂囦欢鍚嶅垪鍑烘潵 (鍝釜鍧忎簡鍐嶇偣涓€涓嬪彧琛ュ畠)
		sfxMsg.value = failed.length >= sfxTotal.value
			? `涓嬭浇澶辫触锛?{sfxTotal.value} 涓兘娌′笅鏉ワ級锛堝彲閲嶈瘯锛壜?涓嬭浇婧?${SFX_SOURCE}锛屽浗鍐呭彲鑳介渶瑕佷唬鐞?榄旀硶`
			: `涓嬭浇澶辫触锛?{failed.join("銆?)}锛堝彲閲嶈瘯锛壜?鍥藉唴鍙兘闇€瑕佷唬鐞?榄旀硶`
		sfxMsgOk.value = false
		sfxMsgBad.value = true
		return
	}
	if (st.ready) {
		sfxTried.value = true
		sfxMsg.value = `宸蹭笅杞?${sfxTotal.value}/${sfxTotal.value}`
		sfxMsgOk.value = true
		sfxMsgBad.value = false
		return
	}
	sfxMsg.value = "鏈笅杞斤紙鐐瑰彸杈规寜閽級"
	sfxMsgOk.value = false
	sfxMsgBad.value = false
}

/** 璇讳竴娆″師鐢熺姸鎬?(鍚姩鏃惰涓€娆? 涔嬪悗姣忔鎾斁鍓嶇敱 services/sfx.ts 鐜伴棶) */
const sfxRefresh = (): void => {
	const st = readSfxStatus()
	sfxShowStatus(st)
}

const doDownloadSfx = (): void => {
	if (sfxBusy.value) return
	sfxBusy.value = true
	sfxShowStatus({ready: false, done: 0, total: sfxTotal.value})
	// 涓嶅洜"宸蹭笅杞?灏辩煭璺? 鍘熺敓渚у宸插瓨鍦ㄤ笖澶у皬鍚堢悊鐨勬枃浠朵細璺宠繃, 閲嶅鐐规渶澶氭槸涓€娆℃湰鍦版牎楠?	const r = downloadSfx()
	if (r === "ok") return
	// 娌¤兘瑙﹀彂 (缃戦〉璋冭瘯娌℃湁妗?/ 涓婁竴娆¤繕鍦ㄤ笅): 鍒鎸夐挳姘歌繙鍗″湪"涓嬭浇涓€?
	sfxBusy.value = false
	sfxMsgOk.value = false
	sfxMsgBad.value = true
	sfxMsg.value = r === "err:nobridge"
		? "瑁呭埌鎵嬫満涓婃墠鑳戒笅杞斤紙缃戦〉璋冭瘯娌℃湁鍘熺敓妗ワ級"
		: r === "err:busy"
			? "涓婁竴娆′笅杞借繕鍦ㄨ繘琛岋紝绋嶇瓑涓€涓?
			: `涓嬭浇瑙﹀彂澶辫触锛?{r}锛夛紙鍙噸璇曪級`
}

/** 搴曢儴 dock 鎸夐敭闊?(鎸夊埌鎸夐挳涓婃墠鍝? 鐐圭┖鐧藉涓嶅搷); 瀹夐潤妯″紡涔熶繚鐣欐寜閿煶 */
const onDockPress = (e: PointerEvent): void => {
	if ((e.target as HTMLElement)?.closest?.(".fab, .side-action")) playSfx()
}
const onDataseaBgToggle = (): void => {
	setDataseaBgEnabled(cfg.dataseaBg)
	persistSettings()
}
const onAmbientToggle = (): void => {
	setAmbientEnabled(ambientAllowed())
	persistSettings()
}

/* ---------------- 瀹夐潤妯″紡 ----------------
 * 涓夋€? 鍏抽棴 / 鑷姩(姣忔棩 23:00鈥撴鏃?8:00) / 鎵嬪姩銆? * 鐢熸晥鏃? Nori 涓嶄富鍔ㄦ惌璇濄€丅GM 鏆傚仠; TTS 鏈楄涓庢寜閿煶/闊虫晥涓€寰嬩繚鐣? * (浣犲彂娑堟伅濂圭収甯稿洖澶? 鎿嶄綔鍙嶉闊充笉闈欓煶)銆?*/
const quietActive = (): boolean => {
	if (cfg.quietMode === "manual") return cfg.quietOn
	if (cfg.quietMode === "auto") {
		const h = new Date().getHours()
		return h >= 23 || h < 8
	}
	return false
}
const bgmQuietHold = ref(false)
const bgmQuickTrack = computed(() => bgmNowName.value || bgmNameOf(cfg.bgmTrack))
const bgmQuickActionLabel = computed(() => bgmState.value === "missing" && cfg.bgmEnabled
	? "閲嶆柊涓嬭浇鑳屾櫙闊充箰"
	: cfg.bgmEnabled ? "鏆傚仠鑳屾櫙闊充箰" : "鎾斁鑳屾櫙闊充箰")
const bgmQuickStatus = computed(() => {
	if (bgmState.value === "downloading") return `姝ｅ湪鍑嗗闊充箰 路 ${bgmPct.value}%`
	if (bgmState.value === "missing") return cfg.bgmEnabled ? "闊充箰璧勬簮鏈氨缁?路 鐐规閲嶈瘯" : "鑳屾櫙闊充箰宸叉殏鍋?
	if (cfg.bgmEnabled && bgmQuietHold.value) return "瀹夐潤妯″紡鏆傚仠涓?
	return cfg.bgmEnabled ? "姝ｅ湪寰幆鎾斁" : "鑳屾櫙闊充箰宸叉殏鍋?
})
const bgmCanSkip = computed(() => cfg.bgmEnabled && bgmState.value === "ready" && !bgmQuietHold.value)
/** ambient 鎬婚椄: 璁剧疆寮€鍏?脳 瀹夐潤妯″紡 脳 鐣寗閽熶笓娉?(鍞竴鍏ュ彛, 浠讳綍閲嶈瘎浼伴兘璧拌繖閲? */
const ambientAllowed = (): boolean => cfg.ambientEnabled && !quietActive() && !pomoFocusMuteOn
/** 鐣寗閽熶笓娉ㄦ湡闈欓煶鏄惁鐢熸晥 (澹版槑鍦ㄤ娇鐢ㄧ偣涔嬪墠: 渚?bgmHeld 涓?applyQuiet 鍒ゆ柇) */
let pomoFocusMuteOn = false
/** 鐜板湪鏄惁搴斿綋"淇濇寔瀹夐潤"(涓嶄富鍔ㄦ惌璇?/ BGM 涓嶅嚭澹?: 瀹夐潤妯″紡 鎴?鐣寗閽熶笓娉ㄦ湡闈欓煶 */
const bgmHeld = (): boolean => quietActive() || pomoFocusMuteOn
let quietTimer = 0
const applyQuiet = (): void => {
	const q = quietActive()
	bgmQuietHold.value = q || pomoFocusMuteOn
	setAmbientEnabled(ambientAllowed())
	if (q || pomoFocusMuteOn) pauseBgm()
	else if (cfg.bgmEnabled) resumeBgm()
}
const onQuietModeChange = (): void => {
	pomoSulkCancelByUser()
	applyQuiet()
	persistSettings()
}
const onQuietToggle = (): void => {
	pomoSulkCancelByUser()
	applyQuiet()
	persistSettings()
}

/* ---------------- 鐣寗閽?----------------
 * 璁℃椂鏈綋鍦ㄥ師鐢?PomodoroEngine (杩涚▼瀛樻椿鍗冲噯鐐硅Е鍙? 瀹屾垚鍙戠郴缁熼€氱煡);
 * 杩欓噷鏄仴鎺у櫒 + 鎮诞绐楄鍥?+ 鑱斿姩: 鎾姤(sfx/TTS)/姣忔棩缁熻(pomo.json)/鏀惧純闈欓煶鎯╃綒/ambient 鎶戝埗銆? * 鏃堕暱浠ュ師鐢熷崟璋冩椂閽熷揩鐓т负鍑嗭紱椤甸潰鍙睍绀猴紝鏃фˉ鍏煎 epoch 鏃堕棿鎴炽€?*/
type PomoPhase = "idle" | "focus" | "break" | "countUp"
interface PomoStateT {now?: number; days?: Record<string, number>; sessionId?: string; revision?: number; eventSeq?: number; goal?: string; rounds?: number; longEvery?: number; cycleEnabled?: boolean; isLongBreak?: boolean; rebootPending?: boolean; durationMs?: number; autoFocus?: boolean; phase: PomoPhase; paused: boolean; endAt: number; remainMs: number; focusMin: number; breakMin: number; autoBreak: boolean; startedAt: number; elapsedMs?: number; remainingMs?: number}
interface PomoDay {focusMin: number; done: number; abort: number; countUpMin: number}
interface PomoBridgeT {
    pomoDashboard?: () => string
    pomoStartPlan?: (options: string) => string
    pomoStartFree?: (goal: string) => string
    pomoReminderSettings?: (kind: string) => void
    pomoResolveReboot?: (include: boolean) => string
    pomoRestoreBackup?: (content: string) => string
    pickPomoBackup?: () => void
    pomoOpenedFromNotification?: () => boolean
	readFile?: (n: string) => string
	writeFile?: (n: string, c: string) => string
	pomoStart?: (f: number, b: number, ab: boolean) => string
	pomoStartCountUp?: () => string
	pomoPause?: () => string
	pomoResume?: () => string
	pomoStop?: () => string
    pomoStopSession?: (session: string) => string
	pomoState?: () => string
	pomoRequestNotify?: () => void
	pomoSetNotify?: (enabled: boolean) => void
	pomoStats?: () => string
	pomoMarkCelebrated?: (key: string) => string
}
const noriB = (): PomoBridgeT | null => (window as unknown as {NoriChat?: PomoBridgeT}).NoriChat ?? null

const pomo = ref<PomoStateT>({phase: "idle", paused: false, endAt: 0, remainMs: 0, focusMin: 25, breakMin: 5, autoBreak: true, startedAt: 0})
const pomoWidgetOn = ref(false)
const pomoMini = ref(false)
const pomoFocus = ref(false)
const pomoPos = ref({x: 16, y: 96, w: 260})
const pomoCfg = reactive({...DEFAULT_POMO})
const pomoStatsReady = ref(false)
const pomoError = ref("")
const pomoConfigError = ref("")
const pomoMessage = ref("")
const pomoBusy = ref(false)
const pomoSyncedAt = ref(0)
const pomoSyncPending = ref(false)
const pomoReminder = ref<{permission: boolean; channel: boolean; controlChannel?: boolean; exact: boolean; scheduleError?: string} | null>(null)
const pomoDisplayAt = ref(performance.now())
const pomoQuietHeld = ref(false)
let pomoSettingsReady = false
let pomoConfigTimer = 0
let pomoNeedsMigration = false
let pomoSettingsReadable = true
let pomoBackupContent = ""
const pomoRestorePreview = ref("")
const pomoConfirmEnd = ref(false)
const POMO_PRESETS = [
	{label: "25+5", focus: 25, break: 5},
	{label: "52+17", focus: 52, break: 17},
	{label: "90+20", focus: 90, break: 20},
	{label: "15+3", focus: 15, break: 3},
]
// 闊虫晥涓嶅啀鎵撹繘鍖?(2026-10-02): 鍏ㄩ儴璧版湰鍦扮洰褰?/sfx-local/ 渚涙祦 (璁剧疆閲屻€屼笅杞介煶鏁堛€嶄笅鍒版湰鏈?
const POMO_SFX = {start: "/sfx-local/start.m4a", complete: "/sfx-local/complete.m4a", ret: "/sfx-local/return.m4a", abandon: "/sfx-local/abandon.m4a"}
// PomoStatsFile 绫诲瀷: 澶氫簡鍙€夌殑 celebrated (閲岀▼纰? 涓?total/best (缁堣韩绱/鏈€浣宠褰?銆?// **蹇呴』鏄?reactive**: 妯℃澘鐩存帴璇?pomoStats.total / .best, 鑰?pomoDay/addToStore/migrateStats
// 閮芥槸鍘熷湴鏀硅繖涓璞?鈥斺€?鐢ㄦ櫘閫?let 鏃舵敼鍔ㄤ笉瑙﹀彂閲嶆覆鏌?(缁熻椤电殑"绱"浼氫竴鐩存樉绀哄姞杞藉墠鐨?0)銆?const pomoStats = reactive<PomoStatsFile>({v: 1, days: {}})

// 鏃ユ湡閿粺涓€鐢?services/pomo-stats 閲岀殑 dayKey (鍘熸澶勫彟鏈変竴浠藉悓瀹炵幇, 宸插垹, 閬垮厤涓ゅ婕傜Щ)
const pomoDayKey = pomoStatDayKey
const pomoDate = ref(new Date())
const pomoDay = (): PomoDay => {
	const k = pomoDayKey()
	if (!pomoStats.days[k]) pomoStats.days[k] = {focusMin: 0, done: 0, abort: 0, countUpMin: 0}
	return pomoStats.days[k]
}
const pomoApplyStats = (parsed: PomoStatsFile): void => {
    if (!parsed || typeof parsed.days !== "object" || !parsed.days || Array.isArray(parsed.days)) throw new Error("涓撴敞璁板綍鏍煎紡寮傚父")
    Object.assign(pomoStats, {v: 2, days: {}, total: undefined, best: undefined, celebrated: {}, lastEventSeq: 0}, parsed)
    pomoStatsReady.value = true
}
const pomoAcceptDashboard = (raw: string): void => {
    const result = JSON.parse(raw)
    if (result.ok === false) throw new Error(result.message || "璁板綍璇诲彇澶辫触")
    if (!result.state || !result.stats) throw new Error("璁℃椂鐘舵€佽鍙栦笉瀹屾暣")
    if (!["idle", "focus", "break", "countUp"].includes(result.state.phase)) throw new Error("璁℃椂鐘舵€佹牸寮忓紓甯?)
    pomoApplyStats(result.stats)
    pomoStateSet(JSON.stringify(result.state))
    pomoSyncPending.value = result.syncStatus !== "ok"
    pomoSyncedAt.value = Number(result.syncedAt) || 0
    pomoReminder.value = result.reminder || null
    pomoError.value = ""
}
const pomoStatsLoad = (): void => {
    try {
        const b = noriB()
        if (b?.pomoDashboard) { pomoAcceptDashboard(b.pomoDashboard()); return }
        const raw = b?.pomoStats ? b.pomoStats() : b?.readFile?.("pomo.json") || ""
        if (!raw) { if (!b?.pomoStats) { pomoStatsReady.value = true; return }; throw new Error("鏆傛椂鏃犳硶璇诲彇璁板綍") }
        const parsed = JSON.parse(raw)
        if (parsed.ok === false) throw new Error(parsed.message)
        pomoApplyStats(parsed)
        if (!b?.pomoStats && migrateStats(pomoStats)) pomoStatsSave()
        pomoError.value = ""
    } catch (e) { pomoError.value = `璁板綍鏆傛湭鏇存柊锛?{(e as Error).message}銆傚凡淇濈暀涓婃鏄剧ず銆俙 }
}
const pomoStatsSave = (): void => {
    try { if (noriB()?.writeFile?.("pomo.json", JSON.stringify(pomoStats)) !== "ok") throw new Error("鏂囦欢涓嶅彲鍐?) }
    catch (e) { pomoError.value = `璁板綍淇濆瓨澶辫触锛?{(e as Error).message}` }
}
const pomoCfgLoad = (): void => {
    try {
        const file = readFileState("settings.json")
        if (file.status === "error") { pomoSettingsReadable = false; throw new Error("璁剧疆鏆備笉鍙") }
        const settings = file.status === "ok" ? JSON.parse(file.content) : {}
        const legacy = localStorage.getItem("pomo_cfg")
        Object.assign(pomoCfg, normalizePomo(settings.pomo || (legacy ? JSON.parse(legacy) : {})))
        pomoNeedsMigration = !settings.pomo
        pomoSettingsReadable = true
        pomoConfigError.value = ""
    } catch { pomoConfigError.value = "璁剧疆鏆傛湭鎭㈠锛涜鍙栨仮澶嶅墠涓嶄細鑷姩瑕嗙洊鏃ц缃€?; pomoSettingsReadable = false }
}
watch(pomoCfg, () => {
    if (!pomoSettingsReady || !pomoSettingsReadable) return
    if (pomoConfigTimer) clearTimeout(pomoConfigTimer)
    pomoConfigTimer = window.setTimeout(() => {
        Object.assign(pomoCfg, normalizePomo(pomoCfg))
        const result = persistSettings()
        pomoConfigError.value = result === "ok" ? "" : "涓撴敞璁剧疆鏈繚瀛橈紝璇锋鏌ュ瓨鍌ㄦ潈闄愬悗閲嶈瘯銆?
        if (result === "ok") { pomoNeedsMigration = false; localStorage.removeItem("pomo_cfg") }
        pomoSyncFocus()
    }, 400)
}, {deep: true})

let pomoSnapshotAt = performance.now()

const pomoStateSet = (json: string): boolean => {
	try {
		const s = JSON.parse(json)
		if (!s || !["idle", "focus", "break", "countUp"].includes(s.phase)) { pomoError.value = s?.message || "璁℃椂鐘舵€佽鍙栧け璐ワ紝璇烽噸璇?; return false }
		const finiteMs = (v: unknown): number => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0
		pomo.value = {now: finiteMs(s.now) || Date.now(), days: s.days || {}, sessionId: s.sessionId, revision: finiteMs(s.revision), eventSeq: finiteMs(s.eventSeq), goal: String(s.goal || ""), rounds: finiteMs(s.rounds), longEvery: finiteMs(s.longEvery), cycleEnabled: !!s.cycleEnabled, isLongBreak: !!s.isLongBreak, rebootPending: !!s.rebootPending, durationMs: finiteMs(s.durationMs), autoFocus: !!s.autoFocus, phase: s.phase, paused: !!s.paused, endAt: finiteMs(s.endAt), remainMs: finiteMs(s.remainMs), focusMin: finiteMs(s.focusMin), breakMin: finiteMs(s.breakMin), autoBreak: !!s.autoBreak, startedAt: finiteMs(s.startedAt),
			...(s.elapsedMs !== undefined ? {elapsedMs: finiteMs(s.elapsedMs), remainingMs: finiteMs(s.remainingMs)} : {})}
		pomoSnapshotAt = performance.now()
        pomoDisplayAt.value = pomoSnapshotAt
        return true
	} catch { pomoError.value = "璁℃椂鐘舵€佽鍙栧け璐ワ紝璇烽噸璇?; return false }
}
const pomoSyncFocus = (): void => {
    const active = pomo.value.phase !== "idle"
    if (active && !pomoFocus.value) pomoFocusMuteStart()
    else if (!active && pomoFocus.value) pomoFocusMuteEnd()
    pomoFocus.value = active
    if (active) pomoWidgetOn.value = true
    pomoFocusMuteOn = !pomoQuietUser && (pomoSulk?.stage === "sulk" || active && (pomo.value.paused ? pomoCfg.quietPaused : pomo.value.phase === "break" ? pomoCfg.quietBreak : pomoCfg.quietFocus))
    pomoQuietHeld.value = pomoFocusMuteOn
    applyQuiet()
}

/** 鍘熺敓鎺ㄩ€佸叆鍙?(PomodoroEngine.evaluateJavascript) */
;(window as unknown as {__noriPomoEvent?: (json: string) => void}).__noriPomoEvent = (json: string) => {
	try {
		const e = JSON.parse(json)
		if (e?.type === "state") { pomoRefresh(); return }
        if (!e || e.type !== "end") return
		if (e.seq && e.seq <= pomoLastAnnounced) { pomoRefresh(); return }
		if (e.seq) pomoLastAnnounced = e.seq
		const b = noriB()
		if (b?.pomoState) pomoStateSet(b.pomoState())
		pomoSyncFocus()
		pomoStatsLoad()
		pomoUpdateDisplay()
		// 宸茬粨鏉熷緢涔呯殑鍚庡彴浜嬩欢鍙ˉ璐︼紝閬垮厤閲嶆柊鎵撳紑鏃惰繛缁挱鎶ユ棫鎻愮ず銆?		if (e.reason && e.reason !== "complete" || e.endedAt && Date.now() - e.endedAt > 15000) return
		pomoMessage.value = e.phase === "focus" ? `鏈 ${Math.round((e.elapsedMs || pomo.value.focusMin * 60000) / 60000)} 鍒嗛挓宸茶褰曪紝鍋氬緱寰堝ソ銆備粖澶╁凡绉疮 ${pomoSummary.value.todayMin} 鍒嗛挓銆俙 : "浼戞伅缁撴潫浜嗭紝鍑嗗濂藉啀缁х画銆?
		if (e.phase === "focus") {
			// 涓撴敞鍒扮偣鍚庤繘鍏ヤ紤鎭?鈥斺€?浠嶅湪涓€涓暘鑼勫懆鏈熷唴, 淇濇寔闈欓煶, 涓嶅湪杩欓噷杩樺師
			if (!b?.pomoStats) {
				const day = pomoDay()
				day.done++; day.focusMin += pomo.value.focusMin
				addToStore(pomoStats, {focusMin: pomo.value.focusMin, done: 1})
				pomoStatsSave()
			}
			if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.complete)
			if (pomoCfg.feedback !== "silent" && isTtsReady(cfg)) { try { void speakTTS(cfg, "涓撴敞瀹屾垚锛屽仛寰楀緢濂姐€備紤鎭竴涓嬪惂锛屾垜鐪嬬潃鏃堕棿銆?) } catch { /* 蹇界暐 */ } }
		} else {
			// 浼戞伅缁撴潫 = 涓€涓畬鏁寸暘鑼勮窇瀹?鈫?杩樺師杩涗笓娉ㄥ墠鐨勫畨闈欒缃?(BGM 鎭㈠)
			if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.ret)
			if (pomoCfg.feedback !== "silent" && isTtsReady(cfg)) { try { void speakTTS(cfg, "浼戞伅澶熶簡锛熷洖鏉ュ惂锛屾垜闄潃浣犮€?) } catch { /* 蹇界暐 */ } }
		}
	} catch { /* 蹇界暐 */ }
}
let pomoLastAnnounced = 0

/* 鍙涓旇繍琛屾椂姣忕鎺ㄨ繘鏄剧ず锛屽師鐢熶粎浣庨鏍″噯鍙婃牳瀵瑰埌鐐圭姸鎬併€?*/
const pomoFmt = ref("00:00")
const pomoPct = ref(0)
const pomoFmtOf = (sec: number): string => {
	const h = Math.floor(sec / 3600)
	const m = Math.floor((sec % 3600) / 60)
	const s2 = sec % 60
	const core = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}`
	return core
}
const pomoTick = (): void => {
    pomoDisplayAt.value = performance.now()
	const s = pomo.value
	if (s.phase === "idle") { pomoFmt.value = "00:00"; pomoPct.value = 0; return }
	const now = Date.now()
	const delta = s.paused ? 0 : Math.max(0, performance.now() - pomoSnapshotAt)
	if (s.phase === "countUp") {
		const el = Math.max(0, s.elapsedMs !== undefined ? s.elapsedMs + delta : s.paused ? s.remainMs : now - s.startedAt)
		pomoFmt.value = pomoFmtOf(Math.floor(el / 1000))
		pomoPct.value = 0
		return
	}
	const total = s.durationMs ? s.durationMs / 1000 : (s.phase === "focus" ? s.focusMin : s.breakMin) * 60
	const left = s.remainingMs !== undefined ? Math.max(0, Math.ceil((s.remainingMs - delta) / 1000))
		: s.paused ? Math.ceil(s.remainMs / 1000) : Math.max(0, Math.ceil((s.endAt - now) / 1000))
	pomoFmt.value = pomoFmtOf(left)
	pomoPct.value = total > 0 ? Math.min(100, Math.round(((total - left) / total) * 100)) : 0
}
let pomoTickTimer = 0
let pomoDateTimer = 0
const pomoRefresh = (stats = true): void => {
	const previousPhase = pomo.value.phase
	try { const b = noriB(); if (b?.pomoState) pomoStateSet(b.pomoState()) } catch { pomoError.value = "璁℃椂鐘舵€佹殏鏈洿鏂帮紝璇烽噸璇曘€? }
	pomoSyncFocus()
	// 鍘熺敓瀹屾垚鍥炶皟鍗充娇鏈€佽揪锛岃疆璇㈠彂鐜伴樁娈靛彉鍖栨椂涔熺珛鍗冲悓姝ヨ处鏈€?	if (stats || previousPhase !== pomo.value.phase) pomoStatsLoad()
    pomoSyncFocus()
	pomoUpdateDisplay()
}
let pomoLastCalibrated = performance.now()
const pomoUpdateDisplay = (): void => {
    pomoTick()
    const running = !document.hidden && pomo.value.phase !== "idle" && !pomo.value.paused
    if (!running && pomoTickTimer) { clearInterval(pomoTickTimer); pomoTickTimer = 0 }
    if (running && !pomoTickTimer) pomoTickTimer = window.setInterval(() => {
        pomoTick()
        if (performance.now() - pomoLastCalibrated >= 10000 || pomo.value.phase !== "countUp" && pomoFmt.value === "00:00") {
            pomoLastCalibrated = performance.now(); pomoRefresh(false)
        }
    }, 1000)
}
const pomoRefreshDate = (): void => {
	pomoDate.value = new Date()
	if (pomoDateTimer) clearTimeout(pomoDateTimer)
	if (document.hidden) { pomoDateTimer = 0; return }
	const midnight = new Date()
	midnight.setHours(24, 0, 0, 20)
	pomoDateTimer = window.setTimeout(pomoRefreshDate, Math.max(1, midnight.getTime() - Date.now()))
}

/* ---------------- 鐣寗閽熼潤闊筹細鍛ㄦ湡/鏀惧純淇濇寔/鐢ㄦ埛鎺ョ ---------------- */
const FOCUS_MUTE_KEY = "pomo_focus_mute_snapshot"
type PomoQuiet = {v?: number; mode: string; on: boolean; stage: "cycle" | "sulk"; until: number; timer: number}
let pomoSulk: PomoQuiet | null = null
let pomoQuietUser = false
const saveFocusMuteSnapshot = (): void => {
    try {
        const value = pomoQuietUser ? {stage: "user", v: 2} : pomoSulk
        if (value) localStorage.setItem(FOCUS_MUTE_KEY, JSON.stringify({...value, timer: 0}))
        else localStorage.removeItem(FOCUS_MUTE_KEY)
    } catch { /* 闈炴潈濞佺殑鏄剧ず绛栫暐蹇収 */ }
}
const clearFocusMuteSnapshot = (): void => { try { localStorage.removeItem(FOCUS_MUTE_KEY) } catch { /* ignore */ } }
const pomoFocusMuteStart = (): void => {
    if (pomoQuietUser) return
    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
    pomoSulk = {v: 2, mode: cfg.quietMode, on: cfg.quietOn, stage: "cycle", until: 0, timer: 0}
    saveFocusMuteSnapshot()
}
const pomoFocusMuteEnd = (): void => {
    if (pomoSulk?.stage === "cycle") pomoSulkRestore()
    if (pomoQuietUser) { pomoQuietUser = false; clearFocusMuteSnapshot() }
}
const pomoSulkRestore = (): void => {
    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
    // 鍙繕鍘熸棫鐗堟浘鎸佷箙鍖栨敼鍐欒繃鐨勫叏灞€璁剧疆锛涙柊鐗堟槸涓存椂瑕嗙洊绛栫暐銆?    if (pomoSulk && pomoSulk.v !== 2) { cfg.quietMode = pomoSulk.mode; cfg.quietOn = pomoSulk.on; persistSettings() }
    pomoSulk = null; pomoFocusMuteOn = false; pomoQuietHeld.value = false
    clearFocusMuteSnapshot(); applyQuiet()
}
const pomoArmSulk = (): void => {
    if (!pomoSulk || pomoSulk.stage !== "sulk" || !pomoSulk.until) return
    if (pomoSulk.timer) clearTimeout(pomoSulk.timer)
    const left = pomoSulk.until - Date.now()
    if (left <= 0) { pomoSulkRestore(); return }
    pomoSulk.timer = window.setTimeout(pomoSulkRestore, left)
}
const pomoSulkStart = (): void => {
    if (pomoQuietUser || !pomoCfg.quietFocus) return
    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
    pomoSulk = {v: 2, mode: cfg.quietMode, on: cfg.quietOn, stage: "sulk", until: pomoCfg.sulkMin > 0 ? Date.now() + pomoCfg.sulkMin * 60000 : 0, timer: 0}
    saveFocusMuteSnapshot(); pomoArmSulk()
}
const pomoSulkCancelByUser = (): void => {
    if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
    pomoSulk = null; pomoQuietUser = pomo.value.phase !== "idle"
    pomoFocusMuteOn = false; pomoQuietHeld.value = false; saveFocusMuteSnapshot()
}
const recoverFocusMuteIfNeeded = (): void => {
    try {
        const raw = localStorage.getItem(FOCUS_MUTE_KEY), snap = raw ? JSON.parse(raw) : null
        if (snap?.stage === "user") pomoQuietUser = pomo.value.phase !== "idle"
        else if (snap && ["off", "auto", "manual"].includes(snap.mode)) {
            if (snap.v !== 2) { cfg.quietMode = snap.mode; cfg.quietOn = !!snap.on; persistSettings() }
            pomoSulk = {...snap, v: 2, stage: snap.stage === "sulk" ? "sulk" : "cycle", until: Number(snap.until) || 0, timer: 0}
        }
    } catch { clearFocusMuteSnapshot() }
    if (pomo.value.phase === "idle" && pomoSulk?.stage === "cycle") pomoSulkRestore()
    pomoArmSulk(); pomoSyncFocus()
}

/* 鎿嶄綔 */
const pomoStartImpl = (f: number, b: number): void => {
	const b2 = noriB()
	if (!b2?.pomoStart) return
	pomoQuietUser = false
	b2.pomoSetNotify?.(pomoCfg.notify)
	if (!pomoStateSet(b2.pomoStartPlan ? b2.pomoStartPlan(JSON.stringify(normalizePomo({...pomoCfg, focusMin: f, breakMin: b}))) : b2.pomoStart(Math.min(120, Math.max(5, Math.round(f))), Math.min(30, Math.max(1, Math.round(b))), pomoCfg.autoBreak))) return
	pomoWidgetOn.value = true
	pomoFocusMuteStart()
	pomoSyncFocus()
	pomoStatsLoad()
	pomoUpdateDisplay()
	if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.start)
	if (pomoCfg.notify && pomoReminder.value?.permission === false) pomoMessage.value = "璁℃椂宸插紑濮嬶紱绯荤粺閫氱煡鏈紑鍚紝鍙湪寰幆涓庢彁閱掍腑寮€鍚€?
}
const pomoCountUpImpl = (): void => {
	const b = noriB()
	if (!b?.pomoStartCountUp) return
	pomoQuietUser = false
	b.pomoSetNotify?.(pomoCfg.notify)
	if (!pomoStateSet(b.pomoStartFree ? b.pomoStartFree(pomoCfg.goal) : b.pomoStartCountUp())) return
	pomoWidgetOn.value = true
	pomoFocusMuteStart()
	pomoSyncFocus()
	pomoStatsLoad()
	pomoUpdateDisplay()
	if (pomoCfg.feedback !== "silent") playSfxFile(POMO_SFX.start)
	if (pomoCfg.notify && pomoReminder.value?.permission === false) pomoMessage.value = "璁℃椂宸插紑濮嬶紱绯荤粺閫氱煡鏈紑鍚紝鍙湪寰幆涓庢彁閱掍腑寮€鍚€?
}
const pomoPauseBtn = (): void => {
	const b = noriB()
	if (!b) return
	const previousPhase = pomo.value.phase
	if (pomo.value.paused) pomoStateSet(b.pomoResume?.() || "")
	else pomoStateSet(b.pomoPause?.() || "")
	pomoSyncFocus()
	if (previousPhase !== pomo.value.phase) pomoStatsLoad()
	pomoUpdateDisplay()
}
const pomoStopBtn = (): number | undefined => {
	const b = noriB()
	if (!b?.pomoStop) return
	let r: PomoStateT & {endedPhase?: PomoPhase; elapsedMs?: number}
    const raw = b.pomoStopSession && pomo.value.sessionId ? b.pomoStopSession(pomo.value.sessionId) : b.pomoStop()
    try { r = JSON.parse(raw) } catch { throw new Error("缁撴潫缁撴灉鏃犳硶璇诲彇锛岃鍒锋柊褰撳墠璁℃椂") }
    if (!pomoStateSet(JSON.stringify(r))) { pomoRefresh(); throw new Error("缁撴潫鏈‘璁わ紝璇锋鏌ュ綋鍓嶈鏃剁姸鎬?) }
	if (r.endedPhase === "focus") pomoSulkStart()
	pomoSyncFocus()
	pomoUpdateDisplay()
	if (b.pomoStats) pomoStatsLoad()
	if (r.endedPhase === "focus") {
		if (!b.pomoStats) {
			const day = pomoDay()
			const elMin = (r.elapsedMs || 0) / 60000
			day.abort++; day.focusMin += elMin
			addToStore(pomoStats, {focusMin: elMin})
			pomoStatsSave()
		}
		if (pomoCfg.feedback === "character") playSfxFile(POMO_SFX.abandon)
		if (pomoCfg.feedback !== "silent" && isTtsReady(cfg)) { try { void speakTTS(cfg, pomoCfg.feedback === "character" ? "鈥︹€﹀ソ鍚с€? : "杩欐鏃堕棿宸茬粡璁颁笅浜嗭紝闇€瑕佹椂鍐嶇户缁€?) } catch { /* 蹇界暐 */ } }
	} else if (r.endedPhase === "countUp") {
		if (!b.pomoStats) {
			const day = pomoDay()
			const elMin = (r.elapsedMs || 0) / 60000
			day.countUpMin += elMin
			addToStore(pomoStats, {countUpMin: elMin})
			pomoStatsSave()
		}
	}
    return r.elapsedMs || 0
}
const pomoGoBtn = (): void => {
	pomoRefresh()
	if (pomo.value.phase === "focus" || pomo.value.phase === "break") { pomoStopBtn(); return }
	pomoStartImpl(pomoCfg.focusMin, pomoCfg.breakMin)
}
const pomoCountUpBtn = (): void => {
	pomoRefresh()
	if (pomo.value.phase === "countUp") { pomoStopBtn(); return }
	pomoCountUpImpl()
}
const pomoOnNotifyChange = (): void => {
	noriB()?.pomoSetNotify?.(pomoCfg.notify)
	if (pomoCfg.notify) noriB()?.pomoRequestNotify?.()
}

/* 闈㈡澘鏂囨 */
const pomoPhaseText = computed((): string => {
	if (pomo.value.phase === "focus") return pomo.value.paused ? "宸叉殏鍋?路 涓撴敞" : "涓撴敞涓?
	if (pomo.value.phase === "break") return (pomo.value.paused ? "宸叉殏鍋?路 " : "") + (pomo.value.isLongBreak ? "闀夸紤鎭? : "浼戞伅涓?)
	if (pomo.value.phase === "countUp") return pomo.value.paused ? "宸叉殏鍋?路 姝ｅ悜璁℃椂" : "姝ｅ悜璁℃椂"
	return "鏈紑濮?
})
const pomoGoLabel = computed((): string => {
	const p = pomo.value.phase
	if (p === "countUp") return "淇濆瓨骞惰浆鍊掕鏃?
	if (p === "focus") return "鏀惧純褰撳墠"
	if (p === "break") return "缁撴潫浼戞伅"
	return `寮€濮嬩笓娉?${pomoCfg.focusMin} 鍒嗛挓`
})
const pomoTodayText = computed((): string => {
	const d = pomoStats.days[pomoDayKey(pomoDate.value)]
	return `${Math.round(dayMinutes(d))} 鍒嗛挓 路 瀹屾垚 ${d?.done || 0} 路 涓柇 ${d?.abort || 0}`
})
// 娉? 鍘熷厛杩欓噷杩樻湁涓€涓浐瀹氱殑 7 澶?pomoBars, 宸茶 pomoRangeBars (7/30/365 鍙垏) 鍙栦唬骞跺垹闄?
/* ---------------- 涓撴敞缁熻: 闈㈡澘灞曠ず + 缁?Nori 鐨勫厠鍒舵敞鍏?----------------
 * 灞曠ず(闈㈡澘)涓庢敞鍏?Nori 鍙拌瘝)鍒嗗伐涓嶅悓:
 *   - 闈㈡澘缁欏嚭鍏ㄩ儴瀹㈣鏁版嵁, 鍖呮嫭瀹屾垚鐜?涓柇杩欑被"鑷垜鎵硅瘎"鎸囨爣, 鏄粰浣犺嚜宸辩湅鐨?
 *   - Nori 鍢撮噷鏈€澶氭彁涓€浠?*姝ｅ悜涓旇瘽棰樼浉鍏?*鐨勪簨, 涓斾竴澶╀竴娆?(瑙?buildFocusHint)銆? * 姹囨€昏绠椾笌娉ㄥ叆鍒ゅ畾閮藉湪 services/pomo-stats.ts (绾€昏緫, 鏈夊崟娴?銆?*/
const pomoSummary = computed<PomoSummary>(() => pomoSummarize(pomoStats.days, 7, pomoDate.value))

/* ---- 缁熻鑼冨洿鍒囨崲 (鏌辩姸鍥? 7 / 30 / 365 澶? ---- */
const pomoRange = ref<7 | 30 | 365>(7)
const pomoRangeBars = computed(() => {
	const n = pomoRange.value
	const out: {day: string; label: string; min: number; h: number}[] = []
	let max = 1
	// 鏌卞瓙澶瘑鏃跺彧鏍囬儴鍒嗘爣绛?(30 澶╂瘡 5 澶╀竴涓? 365 澶╁彧鏍囨湀浠介鏃?
	const labelStep = n <= 7 ? 1 : n <= 30 ? 5 : 30
	for (let i = n - 1; i >= 0; i--) {
		const d = shiftDay(pomoDate.value, -i)
		const k = pomoDayKey(d)
		const min = Math.round(dayMinutes(pomoStats.days[k]))
		if (min > max) max = min
		const showLabel = n <= 7 || i === 0 || (labelStep > 1 && i % labelStep === 0)
		out.push({
			day: k,
			label: showLabel ? (i === 0 ? "浠? : (n > 30 ? `${d.getMonth() + 1}鏈坄 : String(d.getDate()))) : "",
			min,
			h: 4,
		})
	}
	for (const o of out) o.h = Math.max(4, Math.round((o.min / max) * 100))
	return out
})
const pomoRangeSummary = computed<PomoSummary>(() => pomoSummarize(pomoStats.days, pomoRange.value, pomoDate.value))

/* ---- 鐙珛缁熻椤? 鐑姏鍥?+ 鐐归€夋煇澶?+ 鏈堝害姹囨€?---- */
const pomoSelectedDay = ref<{date: string; min: number; done: number; abort: number} | null>(null)
const pomoSelectDate = (date: string): void => {
    if (!date) return
    const day = pomoStats.days[date]
    pomoSelectedDay.value = {date, min: Math.round(dayMinutes(day)), done: day?.done || 0, abort: day?.abort || 0}
}
const pomoHeat = computed<Heatmap>(() => buildHeatmap(pomoStats.days, 52, pomoDate.value))
const pomoMonths = computed(() => monthlyRollup(pomoStats.days, 12, pomoDate.value))
const pomoHeatCanvas = ref<HTMLCanvasElement | null>(null)

/** 鐢荤儹鍔涘浘: 闈欐€侀噸缁?(鏁版嵁鍙樺寲鎵嶇敾), 涓嶅弬涓庨€愬抚 鈥斺€? *  閬垮厤鍜?Live2D(WebGL) / 鏁版嵁娴?2D canvas) 鎶㈠悓涓€涓?GPU銆?*/
const CELL = 9
const CELL_GAP = 2
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
	const theme = getComputedStyle(cv)
	const accent = theme.getPropertyValue("--px-cyan").trim()
	const empty = theme.getPropertyValue("--px-line").trim()
	const step = CELL + CELL_GAP
	for (let w2 = 0; w2 < hm.weeks; w2++) {
		for (let row = 0; row < 7; row++) {
			const c = hm.cells[w2 * 7 + row]
			if (!c) continue
			ctx.fillStyle = c.level === 0 ? empty : accent
			ctx.globalAlpha = [1, 0.35, 0.55, 0.78, 1][c.level]
			ctx.fillRect(w2 * step, row * step, CELL, CELL)
		}
	}
	ctx.globalAlpha = 1
}
/** 鐐圭儹鍔涘浘 鈫?閫変腑鏌愬ぉ (鍙嶇畻鍒?琛? */
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
/** 杩涘叆缁熻椤垫椂鐢讳竴娆?(闈㈡澘鎵撳紑鍚?canvas 鎵嶆湁灏哄) */
const openPomoStats = (): void => {
	pomoRefresh()
	panel.value = "pomoStats"
	void nextTick(() => drawHeatmap())
}
// 闈㈡澘寮€鐫€鏃舵暟鎹彉浜?(濡傜暘鑼勫畬鎴?鏀惧純) 鈫?閲嶇粯鐑姏鍥? 鍚﹀垯瀹冨仠鍦ㄦ棫鐘舵€?watch([pomoHeat, () => panel.value], () => {
	if (pomoSelectedDay.value) pomoSelectDate(pomoSelectedDay.value.date)
	if (panel.value === "pomoStats") void nextTick(() => drawHeatmap())
})
/** 绱鏃堕暱鐨勪汉璇濇牸寮?*/
const fmtTotalMin = (m: number): string => {
	const min = Math.round(m)
	return min >= 60 ? `${Math.floor(min / 60)} 灏忔椂 ${min % 60} 鍒哷 : `${min} 鍒嗛挓`
}

/** "浠婂ぉ宸茬粡璺?Nori 鎻愯繃涓撴敞"鐨勬棩鏈熸爣璁?(姣忓ぉ鏈€澶氭彁涓€娆? 閬垮厤杩炵潃鑱婂伐浣滃氨鍙ュ彞鎻? */
const POMO_HINT_DAY_KEY = "pomo_hint_day"
const focusHintDay = ref<string>(
	(() => { try { return localStorage.getItem(POMO_HINT_DAY_KEY) || "" } catch { return "" } })(),
)
/** 娓呮帀杩囨湡鐨?宸叉彁杩?鏍囪 (璺ㄥぉ鑷姩閲嶇疆, 鏃犻渶瀹氭椂鍣? */
const focusHintFresh = (): boolean => focusHintDay.value !== pomoStatDayKey()
const markFocusHinted = (): void => {
	focusHintDay.value = pomoStatDayKey()
	try { localStorage.setItem(POMO_HINT_DAY_KEY, focusHintDay.value) } catch { /* 蹇界暐 */ }
}

/** 閲岀▼纰?鍙簡绁濅竴娆?鐨勬爣璁版寔涔呭寲 (涓?pomo.json 鐨?celebrated 鍚屾) */
const markCelebrated = (key: string): void => {
	try {
		const b = noriB()
		if (b?.pomoMarkCelebrated) {
			const raw = b.pomoMarkCelebrated(key)
			if (raw) Object.assign(pomoStats, JSON.parse(raw))
			return
		}
		pomoStats.celebrated = {...(pomoStats.celebrated ?? {}), [key]: Date.now()}
		pomoStatsSave()
	} catch { /* 蹇界暐 */ }
}

const pomoLiveMin = computed(() => {
    const st = pomo.value
    if (!["focus", "countUp"].includes(st.phase)) return 0
    if (st.eventSeq !== undefined && st.eventSeq > (pomoStats.lastEventSeq || 0)) return 0
    let delta = st.paused ? 0 : Math.max(0, pomoDisplayAt.value - pomoSnapshotAt)
    if (st.phase === "focus") delta = Math.min(delta, st.remainingMs || 0)
    const days = projectLiveDays(st.days || {}, st.now || Date.now(), delta)
    // 鏃фˉ娌℃湁鍒嗘棩蹇収锛屼粎涓哄綋鍓嶇増鏈吋瀹规樉绀猴紝姝ｅ紡妗ュ缁堜娇鐢ㄥ垎鏃ユ暟鎹€?    return Math.floor((days[pomoDayKey(pomoDate.value)] || (!st.days || !Object.keys(st.days).length ? st.elapsedMs || 0 : 0)) / 60000)
})
const pomoEndText = computed(() => {
    const st = pomo.value
    if (st.paused) return st.rebootPending ? "绛夊緟纭绂荤嚎鏃舵" : "鏃堕棿鍋滃湪杩欓噷锛屽噯澶囧ソ鍐嶇户缁?
    if (st.phase === "idle") return ""
    if (st.phase === "countUp") return "涓嶈刀鏃堕棿锛屾寜鑷繁鐨勮妭濂忔潵"
    const remaining = Math.max(0, (st.remainingMs ?? st.remainMs) - (pomoDisplayAt.value - pomoSnapshotAt))
    const date = new Date(Date.now() + remaining)
    return `棰勮 ${date.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})} 缁撴潫${st.phase === "focus" && st.autoBreak ? " 路 闅忓悗杩涘叆浼戞伅" : ""}`
})
const pomoWeekBars = computed(() => {
    const out = Array.from({length: 7}, (_, i) => { const d = shiftDay(pomoDate.value, i - 6), day = pomoDayKey(d); return {day, label: i === 6 ? "浠婂ぉ" : ["鏃?, "涓€", "浜?, "涓?, "鍥?, "浜?, "鍏?][d.getDay()], min: Math.round(dayMinutes(pomoStats.days[day])), h: 0} })
    const max = Math.max(1, ...out.map(d => d.min)); return out.map(d => ({...d, h: d.min > 0 ? Math.max(5, d.min / max * 100) : 0}))
})
const pomoSyncText = computed(() => !pomoStatsReady.value ? "璁板綍灏氭湭璇诲彇锛岃閲嶈瘯銆? : pomoSyncPending.value
    ? "鏈満宸蹭繚瀛橈紝鍏叡鍓湰寰呭悓姝ャ€傛鏌ュ瓨鍌ㄦ潈闄愬悗鐐归噸璇曘€?
    : pomoSyncedAt.value ? `鏈満宸蹭繚瀛?路 鍏叡鍓湰鍚屾浜?${new Date(pomoSyncedAt.value).toLocaleString()}` : "璁板綍淇濆瓨鍦ㄦ湰鏈猴紱寤鸿瀹氭湡瀵煎嚭 JSON 澶囦唤銆?)
const pomoReminderAction = computed(() => !pomoReminder.value ? "" : !pomoReminder.value.permission ? "notification" : !pomoReminder.value.channel ? "channel" : pomoReminder.value.controlChannel === false ? "controlChannel" : !pomoReminder.value.exact ? "exact" : "")
const pomoReminderText = computed(() => !pomoCfg.notify ? "绯荤粺鎻愰啋宸插叧闂紝椤甸潰璁℃椂浠嶆甯搞€? : !pomoReminder.value ? "鍚庡彴鎻愰啋鍙楃郴缁熸潈闄愬拰鐪佺數绛栫暐褰卞搷銆?
    : pomoReminder.value.scheduleError ? "鍚庡彴鎻愰啋瀹夋帓澶辫触锛岃閲嶈瘯銆? : !pomoReminder.value.permission ? "閫氱煡灏氭湭鎺堟潈銆? : !pomoReminder.value.channel ? "鐣寗閽熼€氱煡娓犻亾宸插叧闂€? : pomoReminder.value.controlChannel === false ? "璁℃椂鎺у埗閫氱煡宸插叧闂紝鏆傚仠涓庣粨鏉熻鍦ㄥ簲鐢ㄥ唴鎿嶄綔銆? : !pomoReminder.value.exact ? "绮剧‘鎻愰啋鏈紑鍚紝鍚庡彴閫氱煡鍙兘寤惰繜銆? : "鎻愰啋宸插氨缁?路 鍙湪閫氱煡鏍忔殏鍋滄垨缁撴潫璁℃椂銆?)
const pomoReminderSettings = (kind: string): void => {
    try { noriB()?.pomoReminderSettings?.(kind) }
    catch { pomoError.value = "鏆傛椂鏃犳硶鎵撳紑绯荤粺鎻愰啋璁剧疆" }
}
const pomoExport = (kind: "json" | "csv"): void => {
    pomoRefresh()
    if (!pomoStatsReady.value || pomoError.value) return
    try {
        const stamp = new Date(), name = `nori-focus-${pomoDayKey(stamp)}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}${String(stamp.getSeconds()).padStart(2, "0")}.${kind}`
        const content = kind === "csv" ? pomoCsv(pomoStats) : JSON.stringify({kind: "nori-pomodoro", version: 1, exportedAt: Date.now(), stats: pomoStats}, null, 2)
        if (noriB()?.writeFile?.(name, content) !== "ok") throw new Error("鏂囦欢淇濆瓨澶辫触锛岃妫€鏌ュ瓨鍌ㄦ潈闄?)
        pomoMessage.value = `宸插鍑鸿嚦 Download/NoriDroid/${name}${pomo.value.phase !== "idle" ? "锛堝寘鍚凡缁撶畻璁板綍锛? : ""}`
    } catch (e) { pomoError.value = (e as Error).message }
}
;(window as unknown as {__noriPomoPickedRes?: (raw: string) => void}).__noriPomoPickedRes = (raw) => {
    try { const result = JSON.parse(raw); if (result.cancelled) return; if (!result.ok) throw new Error(result.message || "璇诲彇澶辫触")
        const preview = parsePomoBackup(result.content); pomoBackupContent = result.content
        pomoRestorePreview.value = `澶囦唤涓湁 ${preview.days} 澶┿€?{preview.minutes} 鍒嗛挓銆傚綋鍓嶆湁 ${Object.keys(pomoStats.days).length} 澶╄褰曪紝灏嗘暣浣撴浛鎹紱閲嶅鎭㈠鍚屼竴浠戒笉浼氬彔鍔犮€俙
    } catch(e) { pomoError.value = (e as Error).message }
}
const pomoAction = (kind: string): void => {
    if (pomoBusy.value) return
    pomoBusy.value = true; pomoMessage.value = ""
    try {
        const before = pomo.value.phase, elapsed = Math.floor((pomo.value.elapsedMs || 0) / 60000)
        if (kind === "start") pomoStartImpl(pomoCfg.focusMin, pomoCfg.breakMin)
        else if (kind === "countUp") pomoCountUpImpl()
        else if (kind === "pause") pomoPauseBtn()
        else if (kind === "stop") { pomoConfirmEnd.value = false; const saved = pomoStopBtn(); if (saved !== undefined && pomo.value.phase === "idle") pomoMessage.value = `鏈 ${Math.floor(saved / 60000)} 鍒嗛挓宸茶褰曘€傛瘡涓€娈垫姇鍏ラ兘绠楁暟銆俙 }
        else if (kind === "notify") pomoOnNotifyChange()
        else if (kind === "stats") openPomoStats()
        else if (kind === "retry") { pomoRefresh(); if (!pomoSettingsReadable) pomoCfgLoad(); if (pomoSettingsReady && pomoSettingsReadable) { const result = persistSettings(); pomoConfigError.value = result === "ok" ? "" : "璁剧疆淇濆瓨澶辫触锛岃妫€鏌ュ瓨鍌ㄦ潈闄? } }
        else if (kind === "quietRestore") { pomoSulkCancelByUser(); applyQuiet() }
        else if (kind === "rebootInclude" || kind === "rebootExclude") { const raw = noriB()?.pomoResolveReboot?.(kind === "rebootInclude"); if (raw) pomoStateSet(raw); pomoRefresh() }
        else if (kind === "import") { if (pomo.value.phase !== "idle") throw new Error("璇峰厛缁撴潫璁℃椂"); if (!noriB()?.pickPomoBackup) throw new Error("璇峰湪 Android 涓荤晫闈㈡仮澶嶅浠?); noriB()?.pickPomoBackup?.() }
        else if (kind === "cancelRestore") { pomoBackupContent = ""; pomoRestorePreview.value = "" }
        else if (kind === "restore") {
            if (!pomoBackupContent || pomo.value.phase !== "idle") throw new Error("璇峰厛缁撴潫璁℃椂骞堕噸鏂伴€夋嫨澶囦唤")
            parsePomoBackup(pomoBackupContent)
            const raw = noriB()?.pomoRestoreBackup?.(pomoBackupContent); if (!raw) throw new Error("鎭㈠鎺ュ彛涓嶅彲鐢?)
            pomoAcceptDashboard(raw); pomoRestorePreview.value = ""; pomoBackupContent = ""; pomoMessage.value = "璁板綍宸叉仮澶嶏紱鎭㈠鍓嶅壇鏈繚瀛樺湪 pomo-before-restore.json銆?
        }
        if ((kind === "start" || kind === "countUp") && before !== "idle" && before !== pomo.value.phase) pomoMessage.value = `宸蹭繚瀛樹笂涓€娈?${elapsed} 鍒嗛挓锛屾柊鐨勮鏃跺凡寮€濮嬨€俙
        else if ((kind === "start" || kind === "countUp") && before === "idle" && pomo.value.phase !== "idle" && !pomoMessage.value && pomoCfg.feedback !== "silent") pomoMessage.value = "杩欎竴娈碉紝Nori 闄綘涓€璧枫€傛寜鑷繁鐨勮妭濂忓氨濂姐€?
    } catch(e) { pomoError.value = `鎿嶄綔鏈畬鎴愶細${(e as Error).message}` }
    finally { window.setTimeout(() => { pomoBusy.value = false }, 250) }
}
const openPomoFromNotification = (): void => { panel.value = "pomo"; pomoRefresh() }
const pomoWidgetStop = (): void => {
    if (pomo.value.phase === "focus") { pomoConfirmEnd.value = true; panel.value = "pomo" }
    else pomoAction("stop")
}
watch(panel, value => { if (value !== "pomo") pomoConfirmEnd.value = false })

/* 鎮诞绐? 鎷栨嫿 + 缂╂斁 (浣嶇疆/澶у皬 localStorage 鎸佷箙鍖? 缁勪欢鏍?pointerdown.stop 鎴柇, 涓嶆儕鍔ㄦ懜澶?缂╂斁鎵嬪娍) */
const pomoWidgetEl = ref<HTMLElement | null>(null)
const pomoPosLoad = (): void => {
	try {
		const raw = localStorage.getItem("pomo_widget")
		if (raw) {
			const o = JSON.parse(raw)
			pomoPos.value = {x: Number(o.x) || 16, y: Number(o.y) || 96, w: Math.min(480, Math.max(240, Number(o.w) || 260))}
			pomoMini.value = !!o.mini
		}
	} catch { /* 蹇界暐 */ }
	pomoClampPos()
}
const pomoPosSave = (): void => {
	try { localStorage.setItem("pomo_widget", JSON.stringify({...pomoPos.value, mini: pomoMini.value})) } catch { /* 蹇界暐 */ }
}
const pomoClampPos = (): void => {
    const viewport = window.visualViewport
    const left = (viewport?.offsetLeft || 0) + 12, top = (viewport?.offsetTop || 0) + 12
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
    pomoPos.value.w = Math.min(pomoPos.value.w, Math.max(120, width - 24))
    const rect = pomoWidgetEl.value?.getBoundingClientRect()
    const w = rect?.width || (pomoMini.value ? 215 : pomoPos.value.w)
    const h = rect?.height || (pomoMini.value ? 50 : 190)
    const dock = document.querySelector<HTMLElement>(".dock")?.getBoundingClientRect()
    const bottom = dock && dock.height > 0 && dock.top > top + h ? Math.min(top + height - 24, dock.top - 12) : top + height - 24
    pomoPos.value.x = Math.max(left, Math.min(pomoPos.value.x, left + width - Math.min(w, width - 24) - 24))
    pomoPos.value.y = Math.max(top, Math.min(pomoPos.value.y, bottom - h))
}
let pomoDragSt: {px: number; py: number; x: number; y: number} | null = null
const onPomoDragDown = (e: PointerEvent): void => {
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
	pomoDragSt = {px: e.clientX, py: e.clientY, x: pomoPos.value.x, y: pomoPos.value.y}
}
const onPomoDragMove = (e: PointerEvent): void => {
	if (!pomoDragSt) return
    if (Math.hypot(e.clientX - pomoDragSt.px, e.clientY - pomoDragSt.py) < 5) return
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
    pomoClampPos()
}
const onPomoRzUp = (): void => { if (pomoRzSt) { pomoRzSt = null; pomoClampPos(); pomoPosSave() } }
watch([pomoMini, panel, pomoWidgetEl], () => { void nextTick(() => { pomoClampPos(); pomoPosSave() }) })

/* 鍒濆鍖?(setup 鏈?: 缁熻/閰嶇疆/缁勪欢浣嶇疆/妗ョ姸鎬?鏄剧ず鑺傛媿 */
pomoCfgLoad()
noriB()?.pomoSetNotify?.(pomoCfg.notify)
pomoStatsLoad()
pomoPosLoad()
try { const b0 = noriB(); if (b0?.pomoState) pomoStateSet(b0.pomoState()) } catch { /* 蹇界暐 */ }
if (pomo.value.phase !== "idle") pomoWidgetOn.value = true   // 璁℃椂涓埛鏂?閲嶈浇: 缁勪欢鑷姩鍥炴潵
pomoUpdateDisplay()
pomoRefreshDate()
window.addEventListener("resize", pomoClampPos)
window.visualViewport?.addEventListener("resize", pomoClampPos)
window.visualViewport?.addEventListener("scroll", pomoClampPos)

/* ---------------- CosyVoice 澹伴煶鍏嬮殕 ---------------- */

/** 闊宠壊鎻愮ず鏂囨; 鏃犻棶棰樻椂涓虹┖涓层€? *  涓ょ被鑷村懡闂 鈥斺€?鍚屼竴涓敊璇?InvalidParameter)鐨勪袱闈? 閮藉繀椤诲湪浣跨敤鍓嶆嫤涓?
 *  - 娌¤闊宠壊: 鏈」鐩竴寰嬬敤鑷湁鍏嬮殕闊宠壊, 涓嶇敤浠讳綍绯荤粺闊宠壊, 鐣欑┖蹇呯劧澶辫触銆? *  - 闊宠壊鏄负**鍒殑妯″瀷**鍏嬮殕鐨? 瀹樻柟鏄庣‘"涓嶈兘灏嗕竴涓ā鍨嬬殑闊宠壊涓庡彟涓€涓ā鍨嬫贩鐢?,
 *    鍒囨崲妯″瀷鍚庣户缁敤鏃у厠闅嗘槸鏈€瀹规槗韪╃殑涓€绉嶃€? *  "褰掑睘"鍙湪杩欓噷缁?cosyVoiceModelOf 绠椾竴娆?(瀹冨唴閮ㄤ細鍏堟煡璁板綍銆佸啀鐢ㄩ煶鑹?id 鍓嶇紑鍏滃簳),
 *  閬垮厤涓ゅ鍚勭畻涓€閬嶈€屾紓绉? 鍚堟垚渚?streamCosyTTS 鐢ㄥ悓涓€濂楁枃妗堟湰鍦版嫤鎴? 淇濊瘉璇存硶涓€鑷淬€? *  瀹屽叏璁や笉鍑烘潵 (涓嶅睘浜庡凡鐭ユā鍨? 灏辫繑鍥?"", 瀹佸彲灏戞彁绀轰篃涓嶈鎶ャ€?*/
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

/* ---------------- 妯″瀷鎺堟潈楠岃瘉锛堢瓟棰橀棬锛?026-10-01锛?026-10-02 鎶芥垚涓ゅ鍏辩敤锛?026-10-14 涓夊锛?----------------
   鍚屼竴閬撻棬瀹堜笁涓?瑕佽仈缃戞嬁 inori 涓滆タ"鐨勫姩浣滐細
     路 clone 鈥斺€?涓€閿厠闅嗗唴缃煶鑹诧紙鍘熸牱锛氬缓闊宠壊 鈫?杞瀹℃牳 鈫?閫変腑骞舵寔涔呭寲锛涘弬鑰冮煶棰戝悓鏍疯蛋**鑱旂綉涓嬭浇**锛?                 鍘熺敓渚ц礋璐ｄ笅杞?瑙勮寖鎴?16bit锛岃 ChatBridge.createPresetCloneVoice锛?     路 model 鈥斺€?涓嬭浇杩樻病瑁呯殑 Live2D 妯″瀷锛堣涓嬮潰 pick()锛?*绛斿鎵嶇湡鐨勫紑濮嬩笅杞?*锛?     路 persona 鈥斺€?涓嬭浇瀹樻柟浜鸿鏂囨锛堣 openPersonaGate()锛?*绛斿鎵嶅幓鎷?.md**锛?   棰橀潰/绛旀/鍒ゅ嵎鍦?services/tts/clone-gate.ts锛堝敮涓€浜嬪疄婧愶級锛涜繖閲屽彧鏀?杩欓亾闂ㄦ鍒讳负璋佸紑"銆?   寮圭獥鍙湁涓€浠斤紝鍏嬮殕閭ｈ竟鐨勭被鍚?.clone-gate)涓庢枃妗堜竴瀛楁湭鏀?鈥斺€?probe-clone-gate 鏄姢鏍忋€?*/
type GateKind = "clone" | "model" | "persona"
const gateOn = ref(false)
const gateKind = ref<GateKind>("clone")
const gateInput = ref("")
const gateMsg = ref("")
const gateOk = ref(false)
const gateBusy = ref(false)
/** 绛斿涔嬪悗鐨?鏀捐鍔ㄤ綔"锛堜笅杞芥ā鍨?/ 涓嬭浇瀹樻柟浜鸿鐢ㄥ緱涓婏細鍏虫帀寮圭獥鍐嶅幓骞查偅浠朵簨锛夈€? *  鍏嬮殕鐨勫姩浣滃氨鍦ㄩ棬閲岃窇锛堣鎶?瀹℃牳涓€?涓€鐩存樉绀哄湪寮圭獥閲岋級锛屾墍浠ュ畠鏄?null銆?*/
let gatePass: (() => void) | null = null

/** 涓绘寜閽枃妗堬細鍏嬮殕閭ｄ袱鍙ュ師鏍蜂繚鐣欙紱涓嬭浇妯″瀷涓庝笅杞戒汉璁鹃兘鎸夊姩浣滄敼鎴?楠岃瘉骞朵笅杞? */
const gateGoLabel = computed(() => (gateKind.value === "clone" ? "楠岃瘉骞跺厠闅? : "楠岃瘉骞朵笅杞?))
const gateBusyLabel = computed(() => (gateKind.value === "clone" ? "鍒涘缓涓€? : "涓嬭浇涓€?))

/** 寮€闂細娓呮帀涓婁竴娆＄殑杈撳叆/鎻愮ず銆俹nPass 鍙湪**绛斿涔嬪悗**鎵嶈璋冪敤锛堢瓟閿?鍙栨秷閮界涓嶅埌瀹冿級 */
const openGate = (kind: GateKind, onPass?: () => void): void => {
	gateKind.value = kind
	gatePass = onPass ?? null
	gateInput.value = ""
	gateMsg.value = ""
	gateOk.value = false
	gateOn.value = true
}
/** 鍙栨秷 / 鐐归伄缃?/ 鐐光湑锛氬叧闂ㄥ嵆鏀惧純锛坓atePass 涓€璧蜂涪鎺?鈬?缁濅笉浼氬伔鍋峰紑濮嬩笅杞斤級锛涘繖鐨勬椂鍊欎笉璁稿叧 */
const closeGate = (): void => {
	if (gateBusy.value) return
	gateOn.value = false
	gatePass = null
}

/** 涓€閿厠闅嗙殑鍏ュ彛鎸夐挳锛圱TS 椤碉級锛氬紑鍚屼竴閬撻棬锛岀瓟瀵瑰悗璧颁笅闈?clone 閭ｅ */
const openCloneGate = (): void => openGate("clone")

/** 涓€閿厠闅嗭細鍒ゅ嵎宸茬敱 doGate 鍋氭帀 鈫?寤洪煶鑹?鈫?杞瀹℃牳锛堜笌鎵嬪姩娴佺▼涓€鑷达級鈫?閫変腑骞舵寔涔呭寲 */
const doCloneGate = async (): Promise<void> => {
	const key = cfg.cosyApiKey?.trim() || ""
	if (!key) {
		gateOk.value = false
		gateMsg.value = "璇峰厛鍦ㄣ€岃闊炽€嶉噷濉啓鍗冮棶 API Key"
		return
	}
	gateBusy.value = true
	gateMsg.value = ""
	// 閿佸畾妯″瀷: 鍚庨潰杞鏈€闀?2 鍒嗛挓, 鏈熼棿鐢ㄦ埛鍙兘鏀逛笅鎷? 璁伴敊妯″瀷浼氳"闊宠壊鈫旀ā鍨?缁戝畾澶辩湡
	const gateModel = cfg.cosyModel || "cosyvoice-v3.5-flash"
	try {
		const r = await createPresetCloneVoice(key, gateModel, clonePrefix.value.trim() || "nori")
		if (!r.ok) {
			gateOk.value = false
			gateMsg.value = r.message ?? "鍒涘缓澶辫触"
			return
		}
		const vid = r.voice_id ?? ""
		gateOk.value = true
		gateMsg.value = "宸插垱寤猴紝绛夊緟瀹℃牳鈥?
		for (let i = 0; i < 24; i++) {
			await new Promise((res) => setTimeout(res, 5000))
			const q = await queryCloneVoice(key, vid)
			if (!q.ok) { gateOk.value = false; gateMsg.value = `鏌ヨ澶辫触: ${q.message ?? ""}`; return }
			const st = q.status ?? ""
			if (st === "OK") {
				cfg.cosyVoice = vid
				rememberCloneVoice(vid, q.target_model || gateModel)
				persistSettings()
				gateOk.value = true
				gateMsg.value = "瀹℃牳閫氳繃 鉁?宸茶涓哄綋鍓嶉煶鑹?
				triggerBubble("闊宠壊鍑嗗濂戒簡锛岃鍙ヨ瘽璇曡瘯锛?)
				setTimeout(() => { gateOn.value = false; gateBusy.value = false }, 1200)
				return
			}
			if (st === "UNDEPLOYED") {
				gateOk.value = false
				gateMsg.value = "瀹℃牳鏈€氳繃锛圲NDEPLOYED锛夛紝鎹竴娈甸煶棰戝啀璇曞惂"
				return
			}
			gateMsg.value = `瀹℃牳涓€?(${Math.min(i + 1, 24)}/24)`
		}
		gateOk.value = false
		gateMsg.value = "绛夊お涔呬簡锛岀◢鍚庡彲鍦ㄣ€岄煶鑹层€嶉噷鐪嬬湅鏈夋病鏈夊嚭鏉?
	} finally {
		gateBusy.value = false
	}
}

/** 鍒ゅ嵎锛堜袱澶勫姩浣滃叡鐢級锛氱瓟閿欏彧鎻愮ず銆?*涓嶆墽琛屼换浣曞姩浣?*锛涚瓟瀵规墠鍒嗗矓鍒板叿浣撳姩浣?*/
const doGate = async (): Promise<void> => {
	if (gateBusy.value) return
	if (!checkCloneAnswer(gateInput.value)) {
		gateOk.value = false
		gateMsg.value = "绛旀涓嶅锛屽啀鎯虫兂锝?
		return
	}
	if (gateKind.value === "clone") { await doCloneGate(); return }
	// 涓嬭浇妯″瀷 / 涓嬭浇瀹樻柟浜鸿锛氱瓟瀵瑰嵆鏀捐 鈥斺€?鍏虫帀寮圭獥锛屽墿涓嬬殑浜嬬敱 gatePass 鍘诲共
	// 锛堟ā鍨嬫槸鍥炲埌鍘熸潵鐨?鍒囨ā鍨嬧啋涓嬭浇"娴佺▼锛岃繘搴﹀湪 topbar锛涗汉璁炬槸鍘绘媺 .md 鍐嶈惤鐩橈級
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
			cloneMsg.value = r.message ?? "閫夋嫨澶辫触"
			cloneMsgOk.value = false
		}
	} finally {
		clonePicking.value = false
	}
}

/** 璁板綍/鏇存柊鏌愪釜鍏嬮殕闊宠壊鐨勬墍灞炴ā鍨?(鍚?id 瑕嗙洊, 鏂?id 杩藉姞)銆? *  蹇呴』鎸佷箙鍖栬繖涓粦瀹氬叧绯? 瀹樻柟鏄庣‘闊宠壊涓嶈兘璺ㄦā鍨嬫贩鐢? 涓嶈涓嬫潵鐢ㄦ埛涓€鎹㈡ā鍨嬪氨浼氶潤榛樼敤閿欓煶鑹层€?*/
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
			cloneMsg.value = "璇峰厛濉啓鍗冮棶 API Key"
			cloneMsgOk.value = false
			return
		}
		// 閿佸畾鍏嬮殕鐢ㄧ殑妯″瀷: 鍚庨潰杞鏈€闀?2 鍒嗛挓, 鏈熼棿鐢ㄦ埛鍙兘鏀广€屾ā鍨嬨€嶄笅鎷?
		// 璁伴敊妯″瀷浼氳"缁戝畾鍏崇郴"鐩存帴澶辩湡
		const cloneModel = cfg.cosyModel || "cosyvoice-v3.5-flash"
		const r = await createCloneVoice(key, cloneModel, clonePrefix.value.trim() || "myvoice")
		if (!r.ok) {
			cloneMsg.value = r.message ?? "鍒涘缓澶辫触"
			cloneMsgOk.value = false
			return
		}
		cloneVoiceId = r.voice_id ?? ""
		cloneMsg.value = `鍒涘缓鎴愬姛锛岀瓑寰呭鏍糕€
		cloneMsgOk.value = true
		// 杞鐘舵€佺洿鍒?OK / UNDEPLOYED (鏈€澶?~2 鍒嗛挓)
		for (let i = 0; i < 24; i++) {
			await new Promise((res) => setTimeout(res, 5000))
			const q = await queryCloneVoice(key, cloneVoiceId)
			if (!q.ok) {
				cloneStatusText.value = `鏌ヨ澶辫触: ${q.message ?? ""}`
				cloneStatusOk.value = false
				break
			}
			const st = q.status ?? ""
			if (st === "OK") {
				cloneStatusText.value = `瀹℃牳閫氳繃 鉁?宸插姞鍏ユ垜鐨勯煶鑹瞏
				cloneStatusOk.value = true
				cfg.cosyVoice = cloneVoiceId
				// 璁颁笅"杩欎釜闊宠壊鏄负鍝釜妯″瀷鍏嬮殕鐨?: 鎺ュ彛杩斿洖鐨?target_model 鏈€鏉冨▉,
				// 缂哄け鏃堕€€鍥炲厠闅嗘椂閿佸畾鐨?cloneModel (涓嶆槸褰撳墠涓嬫媺鍊?
				rememberCloneVoice(cloneVoiceId, q.target_model || cloneModel)
				persistSettings()
				break
			}
			if (st === "UNDEPLOYED") {
				cloneStatusText.value = `瀹℃牳鏈€氳繃 (UNDEPLOYED)锛岃鏇存崲闊抽閲嶈瘯`
				cloneStatusOk.value = false
				break
			}
			cloneStatusText.value = `瀹℃牳涓€?(${Math.min(i + 1, 24)}/24)`
			cloneStatusOk.value = true
		}
	} finally {
		cloneCreating.value = false
	}
}

onSpeakingChange((playing) => {
	speaking.value = playing
	// TTS 闂伩: Nori 寮€鍙ｆ湕璇绘椂鑳屾櫙闊充箰鑷姩鍘嬩綆鍒?20%, 璇村畬鎭㈠
	setBgmDucking(playing)
	/* 鎽稿ご鍙拌瘝鐨勬皵娉?璇村畬鍗虫敹" 鈥斺€?鈿?`onSpeakingChange` 鏄?*鍗曟Ы璧嬪€?*
	   锛坄player.onStateChange = cb`锛? 鎵€浠ヨ繖娈靛繀椤诲啓鍦ㄨ繖涓?*宸叉湁**鐨勫洖璋冮噷,
	   鍙﹁捣涓€娆?`onSpeakingChange(...)` 浼氭妸涓婇潰鐨?鍋滄鏈楄鎸夐挳 + BGM 闂伩"鏁翠釜瑕嗙洊鎺夈€?*/
	if (petLineVoiceTailTimer) { clearTimeout(petLineVoiceTailTimer); petLineVoiceTailTimer = null }
	if (playing) {
		lastVoiceAt = Date.now()
		if (petLineBubble) petLineSpoke = true
		return
	}
	// 鍙湁"纭疄寮€杩囧彛"鎵嶆敹; 涓€鐩存病鍑哄０(TTS 澶辫触)浜ょ粰 7s 鍏滃簳瀹氭椂鍣?	if (!petLineBubble || !petLineSpoke) return
	/* 鈿?涓嶈兘绔嬪埢鏀? `speaking=false` 鏈繀鏄?璇村畬浜? 鈥斺€?娴佸紡鎾斁涓棿鐨勯潤榛?	   锛堝彞闂?/ WebAudio 鍥為€€閫愬潡鎾?/ 缃戠粶鍗′竴涓嬶級涔熶細鎶婂畠缃洖 false,
	   绔嬪埢鏀朵細鎶婃皵娉″湪"璇村埌涓€鍗?鏃舵姽鎺夈€傜瓑涓€涓?VOICE_TAIL 鍐嶇‘璁や竴娆￠潤榛樸€?*/
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
			ttsMsg.value = "杩炴帴鎴愬姛锛屾鍦ㄨ瘯鍚€?
			ttsMsgOk.value = true
		} else {
			ttsMsg.value = r.error ?? "娴嬭瘯澶辫触"
			ttsMsgOk.value = false
		}
	} finally {
		ttsTesting.value = false
	}
}

/* ---------------- 浣欓鏌ヨ ---------------- */
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
		balMsg.value = "璇峰厛濉啓 Fish Audio API Key"
		balMsgOk.value = false
		return
	}
	balFishLoading.value = true
	balMsg.value = ""
	try {
		const r = await checkFishBalance(cfg.ttsBaseUrl, cfg.ttsApiKey)
		if (r.ok) {
			balFish.value = `浣欓 ${r.credit ?? "0"}${r.hasFreeCredit ? "锛堝惈鍏嶈垂棰濆害锛? : ""}`
			balMsg.value = "Fish Audio 浣欓鏌ヨ鎴愬姛"
			balMsgOk.value = true
		} else {
			balFish.value = ""
			balMsg.value = `Fish Audio: ${r.message ?? "鏌ヨ澶辫触"}`
			balMsgOk.value = false
		}
	} finally {
		balFishLoading.value = false
	}
}

const queryDeepSeekBalance = async () => {
	if (!(cfg.apiKey ?? "").trim()) {
		balMsg.value = "璇峰厛鍦ㄨ亰澶╄缃噷閰嶇疆 DeepSeek API Key"
		balMsgOk.value = false
		return
	}
	balDsLoading.value = true
	balMsg.value = ""
	try {
		const r = await checkDeepSeekBalance(cfg.baseUrl, cfg.apiKey)
		if (r.ok) {
			balDs.value = r.balance ?? "鏃犱綑棰濅俊鎭?
			balMsg.value = r.isAvailable === false ? "DeepSeek 璐︽埛褰撳墠涓嶅彲鐢? : "DeepSeek 浣欓鏌ヨ鎴愬姛"
			balMsgOk.value = r.isAvailable !== false
		} else {
			balDs.value = ""
			balMsg.value = `DeepSeek: ${r.message ?? "鏌ヨ澶辫触"}`
			balMsgOk.value = false
		}
	} finally {
		balDsLoading.value = false
	}
}

const queryCosyBalance = async () => {
	if (!(cfg.cosyApiKey ?? "").trim()) {
		balMsg.value = "璇峰厛濉啓鍗冮棶 API Key"
		balMsgOk.value = false
		return
	}
	balCosyLoading.value = true
	balMsg.value = ""
	try {
		const r = await checkCosyBalance(cfg.cosyBaseUrl, cfg.cosyApiKey)
		if (r.ok) {
			balCosy.value = r.balance ?? "鏃犱綑棰濅俊鎭?
			balMsg.value = "鍗冮棶浣欓鏌ヨ鎴愬姛"
			balMsgOk.value = true
		} else {
			balCosy.value = ""
			balMsg.value = `鍗冮棶: ${r.message ?? "鏌ヨ澶辫触"}`
			balMsgOk.value = false
		}
	} finally {
		balCosyLoading.value = false
	}
}

/* ---------------- 闊宠壊鍒楄〃 ---------------- */
const voiceOptions = ref<VoiceInfo[]>([])
const voicesLoading = ref(false)
const voicesMsg = ref("")
const voicesMsgOk = ref(false)

const loadVoices = async () => {
	if (!(cfg.ttsApiKey ?? "").trim()) {
		voicesMsg.value = "璇峰厛濉啓 Fish Audio API Key"
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
				? `鎵惧埌 ${voiceOptions.value.length} 涓彲鐢ㄩ煶鑹诧紙鍙樉绀哄凡璁粌鐨?TTS 闊宠壊锛塦
				: "娌℃湁鎵惧埌闊宠壊銆傚彲鍦?fish.audio 鍏嬮殕闊宠壊, 鎴栨墜鍔ㄨ緭鍏?Reference ID"
			voicesMsgOk.value = true
		} else {
			voicesMsg.value = r.message ?? "鎷夊彇闊宠壊鍒楄〃澶辫触"
			voicesMsgOk.value = false
		}
	} finally {
		voicesLoading.value = false
	}
}




/** 姝ｆ枃鍏抽敭璇?鈫?琛ㄦ儏鍚?(瑙勫垯鍦?markerRules.ts 鍏变韩) */
const detectExpression = (text: string): string | null =>
	detectExpressionByRules(text, expressions.value)

const playIdleMotionOnce = () => {
	const p = pickNeutralIdle(motions.value)
	if (p) l2d.playMotionByIndex(p.group, p.index)
}

/** 涓囪兘鍏滃簳鍔ㄤ綔: 鏄犲皠澶辫触鏃舵挱鏀?idle 寰幆鍔ㄤ綔 (涓€? 涓嶅拰琛ㄦ儏鎵撴灦) */
const playIdleFallback = () => {
	const p = pickNeutralIdle(motions.value)
	if (p) l2d.playMotionByIndex(p.group, p.index)
}

/** 鏍囪椹卞姩鐨勮〃鎯呭鐞? 鏄犲皠鎴愬姛鎾斁, 澶辫触鍒欐竻闄ゅ綋鍓嶈〃鎯?(涓嶆挱闅忔満 idle, 閬垮厤涓庡姩浣滃彔鍔?
 *  **鎽稿ご琛ㄦ儏浼樺厛**锛堢敤鎴峰畾鐨勮鏍?3锛? 姝ｅ湪鎽稿ご鏃朵笉鎶?琛ㄦ儏灞? 鈥斺€?鍚﹀垯涓€寮犲槾灏辨妸琚懜鏃剁殑鑴告崲鎺夈€?*/
const playMarkerEmotion = (word: string): void => {
	if (petExpressionHoldsLayer()) return
	const emo = resolveMarkerEmotionShared(word, expressions.value)
	if (emo) {
		try { l2d.playExpression(emo) } catch { /* 蹇界暐 */ }
	} else {
		try { l2d.stopExpression() } catch { /* 蹇界暐 */ }
	}
}

/** 鏍囪椹卞姩鐨勫姩浣滃鐞? 鏄犲皠鎴愬姛鎾斁, 澶辫触鍒欐挱 idle 涓囪兘鍏滃簳 (涓嶅拰琛ㄦ儏鎵撴灦)
 *  鎾畬缁熶竴"鍥炰腑鎬х姸鎬? 鈥斺€?妯″瀷閲屾墍鏈夊姩浣滈兘鏄?Loop:true 涓嶄細鑷繁缁撴潫,
 *  涓嶅垏鍥炲幓灏变細涓€鐩翠繚鎸?瀹炴祴: 璇淬€屽洶銆嶅悗涓€鐩寸潯鍒颁笅娆¤璇?銆?*/
const playMarkerMotion = (word: string): void => {
	const mo = resolveMarkerMotionShared(word, flatMotionNames())
	if (mo) {
		void l2d.playMotionByName(mo)
		scheduleReturnToNeutral(returnToNeutral)
	} else playIdleFallback()
}

/** 鍥炰腑鎬х姸鎬? 涓€?idle + 娓呮帀琛ㄦ儏 (鍚﹀垯銆屽洶銆嶇殑 Sleep 琛ㄦ儏浼氳鐪肩潧涓€鐩撮棴鐫€, 鐪嬬潃杩樻槸鐫?
 *  浣?*姝ｅ湪鎽稿ご鏃朵笉娓呰〃鎯?* 鈥斺€?閭ｆ槸鐢ㄦ埛瀹?鎽稿ご浼樺厛"鐨勫彟涓€鍗婏紙鍚﹀垯鍔ㄤ綔鍒扮偣鍥炰腑鎬т細鎶婅鎽哥殑鑴告姽鎺夛級銆?*/
const returnToNeutral = (): void => {
	playIdleFallback()
	if (petExpressionHoldsLayer()) return
	try { l2d.stopExpression() } catch { /* 蹇界暐 */ }
}

/** 鎵€鏈夊姩浣滃悕 (鎵佸钩鍒楄〃, 渚涘尮閰嶄笌 AI 閫夋嫨) */
const flatMotionNames = (): string[] => {
	const names: string[] = []
	for (const g of motions.value) {
		for (const n of g.names) names.push(n)
	}
	return names
}

/**
 * 鍏抽敭璇嶈鍒欓€夊姩浣滃苟鎾斁 (绔嬪嵆鍙嶉; AI 缁嗗寲鍦?analyzeAfterReply).
 * 鍛戒腑鍗虫挱鏀?(force 浼樺厛绾ц鐩栭殢鏈?idle), 鏈懡涓笉鎵撴壈. 瑙勫垯鍦?markerRules.ts 鍏变韩.
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
	if (petExpressionHoldsLayer()) { playIdleMotionOnce(); return }   // 鎽稿ご浼樺厛: 涓嶈鐩栬鎽告椂鐨勮劯
	const emo = detectExpression(text)
	if (emo) {
		l2d.playExpression(emo)
	} else {
		l2d.stopExpression()
	}
	playIdleMotionOnce()
}

/* ---------------- 娴佸紡琛ㄦ儏/鍔ㄤ綔鏍囪瑙ｆ瀽 ----------------
 * 鏂规: AI 鍦ㄥ洖澶嶆湯灏鹃檮涓婇殣钘忔爣璁?銆愯〃鎯?寮€蹇冦€戙€愬姩浣?jump銆?
 * 鍓嶇娴佸紡鎺ユ敹鏃跺嵆鏃惰В鏋愬苟鍓ョ (涓嶈繘姝ｆ枃銆佷笉杩?TTS銆佷笉鏄剧ず).
 * 鏍囪鍙兘琚綉缁滃垎鍧椾粠涓棿鍒囨柇, 鍥犳闇€瑕佽法鍧楃紦鍐?
 * 瀹炵幇宸叉娊鍙栧埌 services/chat/markers.ts (涓?App 涓庢偓娴獥姘旀场鍏辩敤).
 */

/** 鑱婂ぉ娴佸紡瀵硅瘽鐨勭嫭绔嬫爣璁扮紦鍐插璞?(涓庤Е鎽歌Е鍙戦殧绂? */
const chatMarkerBuf = {value: ""}
/** 瑙︽懜瑙﹀彂瀵硅瘽鐨勭嫭绔嬫爣璁扮紦鍐?(涓庤亰澶╂祦寮忛殧绂? 閬垮厤骞跺彂韪╄笍) */
const touchMarkerBuf = {value: ""}

/** 鏍囪璇嶆槧灏勯€昏緫鍦?services/live2d/markerRules.ts 鍏变韩 (resolveMarkerEmotion/Motion) */

/**
 * 鍚堝苟 AI 鍒嗘瀽 (琛ㄦ儏缁嗗寲 + 璁板繂鎻愬彇, 涓€娆?LLM 璋冪敤, 鐪?token 鐪佸欢杩?
 * - 琛ㄦ儏: 鍏堢敱鍏抽敭璇嶈鍒欏嵆鏃舵挱鏀? 杩欓噷鐢?AI 缁撴灉缁嗗寲/绾犳
 * - 璁板繂: 瑙勫垯缁撴灉 + AI 鎻愬彇缁撴灉鍚堝苟鍘婚噸鍏ュ簱
 */
const analyzeAfterReply = async (userText: string, _replyText: string) => {
	// 琛ㄦ儏/鍔ㄤ綔宸茬敱娴佸紡鏍囪椹卞姩, 杩欓噷鍙仛璁板繂鍐欏叆:
	// Mem0 涓ゆ寮?鈫?瑙勫垯鍏嶈垂鍏滃簳 + AI 鎻愬彇浜嬪疄 + AI 鍐崇瓥鍏ュ簱(ADD/UPDATE/DELETE/NONE),
	// 鏈夊噣鏂板/鏀瑰啓鏃剁敤姘旀场鎻愮ず (璁╃敤鎴风煡閬?Nori 璁颁綇浜嗕粈涔?.
	try {
		const llmOk = cfg.memoryLlmExtract && !!cfg.apiKey.trim() && !!cfg.model.trim()
		// 鏈€杩戝璇?(涓嶅惈褰撳墠鍙? 渚?AI 鐞嗚В鎸囦唬, 涓嶄綔涓烘彁鍙栨潵婧?		const recent = messages.value
			.filter(m => m.role === "user" || m.role === "assistant")
			.slice(-6, -1)
			.filter(m => !(m.role === "user" && m.content === userText))
			.map(m => ({role: m.role, content: m.content}))
		/** 璁板繂鐩稿叧鐨勫皬璋冪敤缁熶竴璧拌繖閲?(璁板繂鎻愬彇涓庣洰鏍囨敹灏惧叡鐢ㄥ悓涓€涓垽鎹笌绔偣) */
		const llmCall = async (prompt: string): Promise<string> => {
			const r = await sendChat(cfg.baseUrl, cfg.apiKey, cfg.model, [
				{role: "system", content: prompt} as ChatMsg,
			])
			return r.ok ? (r.content ?? "") : ""
		}
		/* 璁板繂鍐欏叆 (2026-09-27 閲嶆瀯 P3: 榛樿**涓嶅啀**閫愬彞鎻愬彇)銆?		   鐜板湪鐨勫垎宸? 杩戞湡瀵硅瘽闈犲師鏂囦笂涓嬫枃, 璁板繂鐢?姣忔鍘嗗彶鎬荤粨椤烘墜绛涘嚭"鐢熶骇
		   (瑙佷笅鏂?summarizeIfNeeded 鈫?services/memory 鐨勮蹇嗗潡閫氶亾)銆?		   鐣?memoryRealtimeExtract 寮€鍏冲彧涓哄嚭闂鑳戒竴閿垏鍥炴棫鐨勯€愬彞閫氶亾銆?*/
		if (cfg.memoryRealtimeExtract) {
			const res = await extractMemoriesSmart(
				userText,
				llmOk ? llmCall : null,
				recent,
			)
			if (res.tips.length) {
				const fmt = `璁颁綇浜嗭細${res.tips.join("銆?)}`
				triggerBubble(fmt.length > 36 ? `${fmt.slice(0, 36)}鈥 : fmt, 3200)
			}
		}
		/* 鐩爣鏀跺熬 (2026-09-27 鐢ㄦ埛瑕佹眰): 涓讳汉杩欏彞鑻ユ槑纭〃绀烘煇涓€岄櫔鐫€浣犵殑浜嬨€嶅凡瀹屾垚/宸叉斁寮?
		   鐢?LLM 鍒ゅ畾骞舵妸瀹冧粠娓呭崟閲屾憳鎺?鈥斺€?鍚﹀垯鐩爣浼氳姣?3 澶╅棶涓€娆°€佹案杩滀笉鏀跺熬銆?		   路 搴撻噷娌℃湁鐩爣鏃?*闆惰皟鐢?*(pruneDoneGoals 鍐呴儴鍏堟煡);
		   路 鍒ゅ畾澶辫触/瓒呮椂/缂栭€?id 鈫?浠€涔堥兘涓嶅垹 (瑙?memory/index.ts 鐨勬敞閲?;
		   路 涓庤蹇嗘彁鍙栧叡鐢ㄥ悓涓€涓?llmCall 鍒ゆ嵁 (閮借姹傚紑鍏冲紑鍚笖閰嶄簡 Key)銆?		   鈿?鍗曠嫭涓€娆¤皟鐢ㄨ€屼笉鏄苟杩涜蹇嗘彁鍙? 涓や欢浜嬭涔夋棤鍏? 鍚堝苟浼氫簰鐩告薄鏌? 鑰?鍒ら敊灏卞垹鐩爣"
		     灞炰簬鐢ㄦ埛鏁版嵁鎹熷け, 涓嶅€煎緱涓虹渷涓€娆¤皟鐢ㄥ啋杩欎釜闄┿€?*/
		if (llmOk) {
			try {
				const done = await pruneDoneGoals(userText, llmCall, recent)
				if (done.length) {
					const fmt = `杩欎釜鐩爣鎴戝氨鍏堟敹璧锋潵鍟︼細${done.join("銆?)}`
					triggerBubble(fmt.length > 40 ? `${fmt.slice(0, 40)}鈥 : fmt, 3600)
				}
			} catch (e) {
				console.error("[goal] pruneDoneGoals failed:", e)
			}
		}
		refreshMemView()
	} catch (e) {
		// 鍏滃簳: 瑙勫垯璁板繂
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
 * 璁板繂搴撳叆鍙ｇ殑"瀹崇緸鎷﹂棬"鐘舵€?(2026-09-27 鐢ㄦ埛瑕佹眰)銆? *
 * 鐢ㄦ埛鐐广€岃蹇嗗簱銆嶆椂鍏堝脊姘旀场 + 蹇典竴鍙ャ€岃繖鏍峰瓙鐪嬬殑璇濓紝nori 浼氬缇炵殑銆傘€? **鐐圭涓変笅鎵嶇湡鐨勮繘鍘?*銆? * 涓轰粈涔堣鏈夎繖鏉? 璁板繂搴撴槸濂圭殑"蹇冮噷璇?, 鐢ㄦ埛甯屾湜杩涘幓涔嬪墠鏈変釜褰撻潰鐨勫弽搴? 鑰屼笉鏄潤榛樼炕寮€銆? *
 * 璁℃暟澶嶄綅瑙勫垯 (涓嶈皑鎱庡氨浼氶攣姝绘垨褰㈠悓铏氳):
 *   路 `entryGateLeaveTimer`: 4 绉掓病鍐嶇偣 鈫?鍋囪鐢ㄦ埛璧板紑浜? 璁℃暟褰掗浂 (鍚﹀垯"鐐逛袱娆°€佽繃涓€浼氬効鐐逛竴娆?灏辫繘鍘讳簡);
 *   路 鎵撳紑/鍏抽棴浠讳綍闈㈡澘 (openPanel) 鈫?褰掗浂;
 *   路 鐪熸杩涘叆璁板繂搴?鈫?褰掗浂 (涓嬫鍐嶈繘瑕侀噸鏂版暟涓変笅)銆? */
const MEM_ENTRY_CLICKS = 3
const memEntryClicks = ref(0)
let memEntryLeaveTimer: ReturnType<typeof setTimeout> | null = null
const MEM_ENTRY_LEAVE_MS = 4000
const resetMemEntryGate = (): void => {
	memEntryClicks.value = 0
	if (memEntryLeaveTimer) { clearTimeout(memEntryLeaveTimer); memEntryLeaveTimer = null }
}

/** 鎽稿ご鍙拌瘝閭ｇ"椤哄彛涓€鍙?鐨勬湕璇?(涓夐亾闂? 鈶燭TS 灏辩华 鈶′笉鍦ㄦ湕璇?鐢熸垚涓?鈶㈠熬闊崇獥)銆?*/
const speakSideLine = (line: string): void => {
	if (!isTtsReady(cfg)) return
	if (speaking.value || Date.now() - lastVoiceAt < PET_LINE_VOICE_TAIL_MS) return
	if (chatStreaming.value || touchStreaming.value || typing.value) return
	void speakTTS(cfg, line).catch(() => { /* 澶辫触宸茬敱 setTtsErrorHandler 鎻愮ず */ })
}

/**
 * 鐐瑰嚮璁剧疆椤甸噷鐨勩€岃蹇嗗簱銆嶅叆鍙ｃ€? * 鍓嶄袱娆″彧缁欏弽搴?(姘旀场 + 鏈楄), 绗笁娆℃墠鐪熺殑鎵撳紑銆? */
const onMemEntryTap = (): void => {
	memEntryClicks.value += 1
	if (memEntryClicks.value >= MEM_ENTRY_CLICKS) {
		resetMemEntryGate()
		openMemoriesPage()
		return
	}
	const left = MEM_ENTRY_CLICKS - memEntryClicks.value
	/* 姘旀场鐢?*灏忔皵娉?*锛坄triggerBubble`锛屼笌銆岃浣忎簡锛氣€︺€嶅悓涓€濂楋級锛屼笉鐢?Nori 姘旀场锛?	   路 涓?璁板繂鏂板唴瀹?鐨勬彁绀鸿瑙夌粺涓€锛堢敤鎴?2026-09-27 瑕佹眰锛夛紱
	   路 灏忔皵娉?z-index 15锛岃亰澶╅潰鏉挎墦寮€鏃朵篃鐪嬪緱瑙?鈥斺€?鑰?Nori 姘旀场锛?8锛変細鐩栧湪闈㈡澘鍐呭涓娿€?*/
	triggerBubble(`杩欐牱瀛愮湅鐨勮瘽锛宯ori 浼氬缇炵殑銆傦紙杩樺樊 ${left} 涓嬶級`, 3000)
	speakSideLine("杩欐牱瀛愮湅鐨勮瘽锛宯ori 浼氬缇炵殑銆?)
	if (memEntryLeaveTimer) clearTimeout(memEntryLeaveTimer)
	memEntryLeaveTimer = setTimeout(() => { memEntryLeaveTimer = null; memEntryClicks.value = 0 }, MEM_ENTRY_LEAVE_MS)
}

/** E2E/瀹炴満璇婃柇鎺㈤拡: 鑱婂ぉ涓庤蹇嗙绾跨殑鏈€灏忕姸鎬佸揩鐓?(绾, 涓嶅缓杩炴帴)銆? *  鎺掓煡"鍙戝畬娑堟伅鍚庤蹇?鐩爣鍒ゅ畾娌″姩闈?杩欑被闂鏃? 鎺у埗鍙版暡 `__noriDiagChat()` 灏辫兘鐪嬪埌
 *  鍒板簳鏄憼娌￠厤 Key 鈶℃秷鎭病鍙戝嚭鍘?鈶㈠洖澶嶄负绌?杩樻槸 鈶ｆ彁鍙栬寮€鍏冲叧鎺変簡銆?*/
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

/** 鎸佷箙鍖栧叏閮ㄨ缃?(闈欓粯淇濆瓨; 鍐欏け璐ュ彧璁版棩蹇?鈥斺€?婊戝潡/寮€鍏宠繖绫婚珮棰戣皟鐢ㄤ笉閫傚悎寮规彁绀?銆? *  @returns 鏄惁鐪熺殑鍐欏叆鎴愬姛, 渚涙樉寮?淇濆瓨璁剧疆"鎸夐挳濡傚疄鍙嶉 */
/** 钀界洏銆侤returns 鍘熺敓 writeFile 鐨勫師濮嬭繑鍥?("ok" / "err:xxx"), 渚涗繚瀛樻寜閽瀹炴姤鍘熷洜 */
const persistSettings = (): string => {
	const raw = saveSettingsRaw({
        pomo: normalizePomo(pomoCfg),
		apiKey: cfg.apiKey,
		baseUrl: cfg.baseUrl,
		model: cfg.model,
		live2dModel: cfg.live2dModel || "",
		bubbleScale: Number(cfg.bubbleScale) || 1,
		bubbleWidth: Number(cfg.bubbleWidth) || 82,
		renderScale: renderScaleNum.value,
		l2dFps: l2dFpsNum.value,
		ttsEnabled: !!cfg.ttsEnabled,
		petTouchEnabled: cfg.petTouchEnabled !== false,
		petTouchEffects: cfg.petTouchEffects !== false,
		petTouchSound: cfg.petTouchSound !== false,
		petTouchSpeech: cfg.petTouchSpeech !== false,
		lipSyncEnabled: !!cfg.lipSyncEnabled,
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
		// 鐣岄潰瀛椾綋锛?026-10-15锛? 蹇呴』杩涜繖浠?閫愬瓧娈?鐨勮惤鐩樻竻鍗曪紝鍚﹀垯閲嶅惎灏卞洖绯荤粺瀛椾綋
		uiFont: normalizeUiFont(cfg.uiFont),
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
		/** 杩佺Щ鏍囪: 涓€鏃﹀啓杩囩洏, 璇存槑涓婇潰瀵?`deepseekThinking` 鐨勮鍙栧凡缁忔槸"鐢ㄦ埛鐪熼€夌殑鍊? */
		thinkDefaultV2: true,
		lookFlipX: !!cfg.lookFlipX,
		lookFlipY: !!cfg.lookFlipY,
		lookSens: Number(cfg.lookSens) || 0.2,
		floatEnabled: !!cfg.floatEnabled,
		floatBubbleW: Number(cfg.floatBubbleW) || 82,
		floatRenderScale: normalizeRenderScale(cfg.floatRenderScale, nativeDpr.value),
		// 鍦ㄧ嚎浜烘暟寮€鍏筹紙2026-10-21锛? 蹇呴』杩涜繖浠?閫愬瓧娈?娓呭崟锛屽惁鍒欏叧鎺夊悗閲嶅惎鍙堝彉鍥炲紑
		presenceEnabled: cfg.presenceEnabled !== false,
	})
	if (raw !== "ok") console.error("[settings] 鍐欑洏澶辫触:", raw)
	return raw
}

const saveSettingsNow = () => {
	// 濡傚疄鍙嶉: 鍐欑洏澶辫触鏃朵笉鍐嶈皫鎶?璁剧疆宸蹭繚瀛?, 鑰屼笖鎶婂師鐢熺粰鐨勭湡瀹炲師鍥犱竴骞舵樉绀?鈥斺€?	// 鍙"瀛樺偍涓嶅彲鍐?浼氭妸 err:insert / err:stream / SecurityException 绛夊樊寮傚叏鐩栨帀, 鐪熸満娌℃硶瀹氫綅銆?	const raw = persistSettings()
	applyRenderScale()
	modelLoadMsg.value = ""
	const ok = raw === "ok"
	triggerBubble(ok ? "璁剧疆宸蹭繚瀛? : `璁剧疆淇濆瓨澶辫触锛?{raw} 鈥斺€?璇锋墦寮€銆屾墍鏈夋枃浠惰闂潈闄愩€嶏紙绯荤粺璁剧疆 鈫?搴旂敤 鈫?NoriDroid 鈫?鐗规畩搴旂敤鏉冮檺锛塦, ok ? 2000 : 6000)
}

/* ---------------- 鎮诞绐?---------------- */
const floatPermission = ref<"unknown" | "granted" | "denied" | "pending" | "revoked">("unknown")
let floatEnablePending = false
const floatPermissionHint = computed(() => {
	if (floatPermission.value === "pending") return "绛夊緟绯荤粺鎺堟潈锛屾巿鏉冭繑鍥炲悗鑷姩寮€鍚€?
	if (floatPermission.value === "revoked") return "鎮诞绐楁潈闄愬凡琚挙閿€锛岃閲嶆柊寮€鍚苟鎺堟潈銆?
	if (floatPermission.value === "denied") return "灏氭湭鑾峰緱鎮诞绐楁潈闄愶紝寮€鍚椂浼氬墠寰€绯荤粺璁剧疆銆?
	if (floatPermission.value === "granted") return "鎮诞绐楁潈闄愬凡鎺堟潈銆?
	return "棣栨寮€鍚渶瑕佹巿鏉冩偓娴獥鏉冮檺銆?
})
const saveFloatEnabled = () => {
	persistSettings()
	try { window.NoriChat?.setFloatEnabled?.(!!cfg.floatEnabled) } catch { /* 蹇界暐 */ }
}
const refreshFloatPermission = () => {
	const nori = window.NoriChat
	if (!nori?.canFloat || document.hidden) return
	try {
		const granted = nori.canFloat()
		const wasEnabled = !!cfg.floatEnabled
		if (floatEnablePending) {
			cfg.floatEnabled = granted
			floatEnablePending = false
			floatPermission.value = granted ? "granted" : "denied"
			saveFloatEnabled()
		} else if (!granted && wasEnabled) {
			cfg.floatEnabled = false
			floatPermission.value = "revoked"
			saveFloatEnabled()
		} else if (granted) floatPermission.value = "granted"
		else if (floatPermission.value !== "revoked") floatPermission.value = "denied"
		if (!granted) nori.hideFloat?.()
	} catch { /* 蹇界暐 */ }
}

/** 鎺堟潈鍓嶄繚鐣欏叧闂姸鎬侊紱杩斿洖搴旂敤鍚庢牳瀵规潈闄愶紝鍐嶅惎鐢ㄥ師鐢熸爣璁般€?*/
const onFloatToggle = (event: Event) => {
	const nori = window.NoriChat
	floatEnablePending = false
	if (cfg.floatEnabled) {
		try {
			if (!nori?.canFloat?.()) {
				cfg.floatEnabled = false
				// v-model 鍚屼竴浜嬩欢鍐?true鈫抐alse 鍙兘琚悎骞朵负鏃犲彉鍖栵紝鏄惧紡杩樺師鍘熺敓澶嶉€夋銆?				if (event.target instanceof HTMLInputElement) event.target.checked = false
				floatEnablePending = !!nori?.requestFloatPermission
				floatPermission.value = floatEnablePending ? "pending" : "denied"
				saveFloatEnabled()
				triggerBubble("璇峰湪绯荤粺璁剧疆閲屽厑璁告偓娴獥鏉冮檺")
				nori?.requestFloatPermission?.()
				return
			}
			floatPermission.value = "granted"
			triggerBubble("宸插紑鍚細绂诲紑搴旂敤鍚?Nori 浼氱暀鍦ㄥ睆骞曚笂")
		} catch {
			cfg.floatEnabled = false
			if (event.target instanceof HTMLInputElement) event.target.checked = false
		}
	} else {
		try { nori?.hideFloat?.() } catch { /* 蹇界暐 */ }
	}
	saveFloatEnabled()
}

/** 鎮诞绐? 娓叉煋鍒嗚鲸鐜囪缃?鈫?淇濆瓨 + 瀹炴椂閫氱煡鎮诞绐楅〉闈?*/
const resetFloatWindow = () => {
	try {
		if (!window.NoriChat?.resetFloatWindow) return
		window.NoriChat.resetFloatWindow()
		triggerBubble("宸查噸缃紝绂诲紑搴旂敤鍚庡彲鏌ョ湅鎮诞绐?)
	} catch { triggerBubble("閲嶇疆澶辫触锛岃閲嶈瘯") }
}

const onFloatRenderScale = () => {
	cfg.floatRenderScale = normalizeRenderScale(cfg.floatRenderScale, nativeDpr.value)
	persistSettings()
	try {
		window.NoriChat?.setFloatRenderScale?.(cfg.floatRenderScale)
	} catch { /* 蹇界暐 */ }
}

// 闊宠壊閫夋嫨鍚庤嚜鍔ㄤ繚瀛?(闃叉姈, 閬垮厤鎵嬫粦杩炵画鍒囨崲鏃堕绻佸啓鏂囦欢)
let voiceSaveTimer: ReturnType<typeof setTimeout> | null = null
const saveVoicesDebounced = () => {
	if (voiceSaveTimer) clearTimeout(voiceSaveTimer)
	voiceSaveTimer = setTimeout(() => {
		voiceSaveTimer = null
		persistSettings()
	}, 600)
}
// Fish 鐨勯煶鑹?watch(() => cfg.ttsReferenceId, saveVoicesDebounced)
// 鍗冮棶鐨勬ā鍨嬩笌闊宠壊 鈥斺€?涓庝笂闈㈠悓涓€濂楅槻鎶栧啓娉曘€?// 涓嶇敤 @change 鐨勫師鍥? 鐢ㄦ埛鎵撳畬瀛楃洿鎺ュ叧闈㈡澘鏃?input 涓嶄細澶辩劍, change 鏍规湰涓嶈Е鍙? 鏀瑰姩灏变涪浜?
// watch 鍦ㄦ渶鍚庝竴娆¤緭鍏ュ悗 600ms 钀界洏, 涓嶄緷璧栧け鐒︺€?watch([() => cfg.cosyModel, () => cfg.cosyVoice], saveVoicesDebounced)

const onResize = () => {
	syncChatLayout()
	relayout()
	resizeDataseaBg()
}

const refreshStorage = () => {
	if (!document.hidden) { window.dispatchEvent(new Event("nori-diary-updated")); scheduleDiary() }
	storageReady.value = isStorageReady()
	// 銆屾墍鏈夋枃浠惰闂潈闄愩€嶅彲鑳芥槸鍦ㄧ郴缁熻缃噷鍒氭巿浜堢殑 鈥斺€?姣忔鍥炲墠鍙伴兘鍒锋柊涓€娆?
	// 鐢ㄦ埛鎺堟潈杩斿洖鍚庤缃〉鐨勩€屽凡鎺堟潈 鉁撱€嶄細绔嬪埢鍙樼豢, 涓嶇敤閲嶅紑闈㈡澘銆?	allFilesAccess.value = hasAllFilesAccess()
	if (!document.hidden) {
		if (!pomoSettingsReadable) pomoCfgLoad()
		pomoRefreshDate()
		pomoRefresh()
		pomoArmSulk()
	}
}

/**
 * 椤甸潰涓嶅彲瑙?鈬?**涓や釜娓叉煋寰幆閮藉仠**锛?026-10-02 鐢ㄦ埛鎶ャ€岃繑鍥炰富鐣岄潰涓ラ噸鎺夊抚銆嶏級銆? *
 * 涓轰粈涔堟樉寮忓仠: rAF 鍦?`document.hidden` 鏃舵湰鏉ュ氨鍋滀簡锛屼絾 Android WebView 鐨?闅愯棌"鍙鐩? * 鍒囧悗鍙?鎭睆锛?*琚埆鐨勭獥鍙ｇ洊浣?*锛堟偓娴獥銆佹皵娉″璇濇锛夋椂椤甸潰浠嶆槸 visible锛屼袱鏉″惊鐜? * 锛圠ive2D + 鏁版嵁娴凤紝瀹炴祴鍚勫崰婊′竴甯ч绠楋級浼氱収璺戜笉璇€傝€屼笖鐢ㄦ埛鐪嬪埌鐨?鎺夊抚"寰€寰€鏄?*鎸佺画鍙戠儹鍚? * 鐨勯檷棰?*锛屾墍浠?涓嶈鐢荤殑鏃跺€欎竴甯ч兘涓嶇敾"蹇呴』鏄惧紡鍐欏嚭鏉ワ紝鑰屼笉鏄緷璧栨祻瑙堝櫒瀹炵幇銆? *
 * 鎭㈠鏄嵆鏃剁殑: Live2D 鍙槸涓嶇敾锛堟ā鍨?鐢诲竷/鎵嬪娍鍛戒腑閮戒笉鍔級锛屾暟鎹捣閲嶆柊璧峰惊鐜€? */
const setStageRenderPaused = (paused: boolean): void => {
	try { l2d.pauseRender(paused) } catch { /* 蹇界暐 */ }
	try {
		if (paused) stopDataseaBg()
		else if (cfg.dataseaBg) setDataseaBgEnabled(true)
	} catch { /* 蹇界暐 */ }
}

const renderPause = createRenderPauseState(setStageRenderPaused)
const onNativeVisibility = () => {
	renderPause.setNativePaused(window.__noriAppPaused === true)
	onVisibility()
}

const onVisibility = () => {
	const paused = renderPause.setHidden(document.hidden)
	if (!paused) refreshFloatPermission()
	refreshStorage()
	// 鍒囧悗鍙? 绔嬪嵆钀界洏闃叉姈涓殑鑱婂ぉ璁板綍, 閬垮厤涓㈡渶鍚庝竴娆″啓鍏?	if (paused) {
		cancelStageInteraction()
		stopAutoDiary()
		pomoUpdateDisplay()
		pomoRefreshDate()
		flushChatPersist()
		void flushMemoryPersist()
		stopTTS()
		pauseBgm()
	} else {
		// 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 鍥炲墠鍙拌ˉ涓€娆″績璺筹紙璺濅笂娆?> 60s 鎵嶅彂锛?		if (cfg.presenceEnabled) presenceOnVisible(APP_VERSION)
		if (health.value.lastPersistError) refreshMemFromDisk()
		if (!bgmHeld()) resumeBgm()
		if (!chatStreaming.value && !touchStreaming.value) {
			// 鍒囧洖鍓嶅彴: 閲嶆柊鍔犺浇鑱婂ぉ璁板綍 鈥斺€?鎮诞绐楀璇濇鍙兘宸插啓鍏ュ叡浜殑 chat.json,
			// 涓?App 涓嶉噸寤烘椂鍐呭瓨閲屾槸鏃ф暟鎹? 蹇呴』鍒锋柊鎵嶈兘鐪嬪埌鎮诞绐楀璇?
			// 娴佸紡杩涜涓烦杩? send/handleTouchTrigger 鐨勯棴鍖呮寔鏈夋棫鏁扮粍閲岀殑 liveBubble,
			// 鏁磋〃鏇挎崲浼氳鍦ㄩ€斿洖澶嶅啓鍒拌劚绂绘覆鏌撶殑瀵硅薄涓?鈫?鏃笉涓婂睆涔熶笉钀界洏 (FE-H2)
			try { messages.value = loadChat() } catch { /* 蹇界暐 */ }
		}
	}
}

onMounted(async () => {
	window.addEventListener("resize", onResize)
	window.visualViewport?.addEventListener("resize", syncChatLayout)
	window.visualViewport?.addEventListener("scroll", syncChatLayout)
	
	document.addEventListener("pointerdown", onStagePointerDown)
	document.addEventListener("pointermove", onStagePointerMove)
	document.addEventListener("pointerup", onStagePointerUp)
	document.addEventListener("pointercancel", onStagePointerUp)
	document.addEventListener("lostpointercapture", onStagePointerUp)
	window.addEventListener("blur", cancelStageInteraction)
	
	window.addEventListener("focus", refreshStorage)
	window.addEventListener("nori-app-pause", onNativeVisibility)
	window.addEventListener("nori-app-resume", onNativeVisibility)
	document.addEventListener("visibilitychange", onVisibility)
	// TTS 鍚堟垚澶辫触鎻愮ず (涓嶆墦鏂璇?
	setTtsErrorHandler((msg) => triggerBubble(`璇煶鍚堟垚澶辫触锛?{msg}`))
	// BGM 鍔犺浇澶辫触鎻愮ず
	setBgmErrorHandler((msg) => triggerBubble(`鑳屾櫙闊充箰锛?{msg}`))

	
	const s = loadSettings()
	cfg.apiKey = s.apiKey
	cfg.baseUrl = s.baseUrl || "https://api.openai.com/v1"
	cfg.model = s.model
	// 涓婃閫夌殑 Live2D 妯″瀷 (鏃ц缃枃浠舵病鏈夎繖涓瓧娈?鈫?绌轰覆 鈬?鍚姩璧?宸茶鍒楄〃绗竴涓?)
	cfg.live2dModel = s.live2dModel ?? ""
	cfg.bubbleScale = s.bubbleScale || 1
	cfg.bubbleWidth = Number(s.bubbleWidth) || 82
	// 榛樿灏侀《 1.5x锛?026-10-05 浠?2 涓嬭皟锛? 鍙板紡/澶у睆涓婁袱灞傚悎璁″～鍏?3.206 鈫?1.297 MP(鈭?0%)銆?	// 鐢ㄦ埛鏄惧紡璁剧疆杩囩殑鍊间笉鍙楀奖鍝嶃€傜湡姝ｇ敓鏁堢殑鍊嶇巼杩樹細琚?鏈€闀胯竟涓婇檺"鍐嶅す涓€娆?瑙?live2d/index.ts)銆?	cfg.renderScale = normalizeRenderScale(s.renderScale, Math.min(nativeDpr.value, 1.5))
	// 鏃ц缃枃浠舵病鏈?l2dFps 鈫?normalizeFps 鍥炶惤鍒伴粯璁ゆ。 (60)
	cfg.l2dFps = normalizeFps(s.l2dFps)
	cfg.ttsEnabled = !!s.ttsEnabled
	// 鍙ｅ瀷榛樿鍏抽棴锛涙棫璁剧疆鏂囦欢缂哄皯璇ュ瓧娈垫椂蹇呴』淇濇寔鍏抽棴
	cfg.lipSyncEnabled = s.lipSyncEnabled === true
	cfg.petTouchEnabled = s.petTouchEnabled !== false
	cfg.petTouchEffects = s.petTouchEffects !== false
	cfg.petTouchSound = s.petTouchSound !== false
	cfg.petTouchSpeech = s.petTouchSpeech !== false
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
	cfg.timeAware = s.timeAware !== false      // 鏃ц缃枃浠舵病杩欎釜瀛楁 鈬?榛樿寮€
	cfg.ambientEnabled = s.ambientEnabled !== false
	cfg.dataseaBg = s.dataseaBg !== false
	/* 鐣岄潰瀛椾綋锛?026-10-15锛? 鑰佽缃枃浠舵病杩欎釜瀛楁 鈫?绯荤粺榛樿锛?	 * 绔嬪埢钀藉埌 <html data-ui-font>锛岄伩鍏嶉甯у厛鐢ㄧ郴缁熷瓧浣撳啀璺充竴涓嬨€?*/
	cfg.uiFont = applyUiFont(s.uiFont)
	cfg.quietMode = ["off", "auto", "manual"].includes(String(s.quietMode)) ? String(s.quietMode) : "off"
	cfg.quietOn = !!s.quietOn
	cfg.cosyCloneVoices = normalizeCloneVoices(s.cosyCloneVoices)
	cfg.trimHistory = s.trimHistory !== false
	cfg.memoryLlmExtract = !!s.memoryLlmExtract
	// 瀹炴椂閫氶亾榛樿**鍏?* (閲嶆瀯 P3): 鍙湁鏄惧紡瀛樿繃 true 鎵嶅紑 (鑰佽缃枃浠堕噷娌℃湁杩欎釜瀛楁 鈫?鍏?
	cfg.memoryRealtimeExtract = s.memoryRealtimeExtract === true
	cfg.memoryAutoTuneExamples = s.memoryAutoTuneExamples === true
	cfg.memoryDiagnostics = s.memoryDiagnostics === true
	setDiagEnabled(cfg.memoryDiagnostics)   // 璇婃柇鏃ュ織寮€鍏冲悓姝ョ粰璁板繂妯″潡 (鍏崇潃鏃跺畠闆跺紑閿€)
	cfg.smartRecall = s.smartRecall !== false
	cfg.emotionLlm = s.emotionLlm !== false
	/* 鎬濊€冩ā寮? 2026-10-02 鐢ㄦ埛绾犳涓?*榛樿寮€**銆?	 * 鑰佽缃枃浠堕噷閭ｄ釜 `false` 鏄?*鏃ч粯璁?*鑷姩鍐欒繘鍘荤殑 (persistSettings 浼氭妸鍏ㄩ儴瀛楁鍐欑洏),
	 * 涓嶄唬琛ㄧ敤鎴风殑閫夋嫨 鈥斺€?鎵€浠ユ寜 `thinkDefaultV2` 鏍囪**涓€娆℃€ц縼绉?*鎴愬紑;
	 * 杩佺Щ杩囩殑鏈哄櫒涓? 鐢ㄦ埛鎵嬪姩鍏虫帀灏辨案涔呯敓鏁?(鏍囪宸茶惤鐩? 涓嶄細鍐嶈缈诲洖鏉?銆?*/
	cfg.deepseekThinking = s.thinkDefaultV2 === true ? !!s.deepseekThinking : true
	cfg.lookFlipX = !!s.lookFlipX
	cfg.lookFlipY = !!s.lookFlipY
	cfg.lookSens = Number(s.lookSens) || 0.2
	cfg.floatEnabled = !!s.floatEnabled
	cfg.floatBubbleW = Number(s.floatBubbleW) || 82
	cfg.floatRenderScale = normalizeRenderScale(s.floatRenderScale, nativeDpr.value)
	// 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 鑰佽缃枃浠舵病杩欎釜瀛楁 鈬?榛樿寮€
	cfg.presenceEnabled = s.presenceEnabled !== false
	// 鍚屾鍘熺敓鎮诞绐楀紑鍏虫爣璁?(閫€鍑哄垽鏂敤, 涓嶄緷璧?settings.json 璇诲啓鏃跺簭)
	try { window.NoriChat?.setFloatEnabled?.(!!cfg.floatEnabled) } catch { /* 蹇界暐 */ }
	refreshFloatPermission()
	// 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 鍙湁閰嶇疆浜嗚鏁版湇鍔℃墠鎺ョ嚎/鍙戝績璺筹紱鏈厤缃椂闆惰姹?	ensurePresenceWiring()
	if (presenceReady.value && cfg.presenceEnabled) startPresence(APP_VERSION)
	// 搴旂敤鍐呮湕璇婚煶閲?(鎸夎缃垵濮嬪寲; 涔嬪悗婊戝潡鍙疄鏃惰皟鏁?
	setTtsVolume(Number(cfg.ttsVolume))
	// 鑳屾櫙闊充箰: 娉ㄥ唽璧勬簮鐘舵€佸洖璋冨悗鎭㈠鎾斁 (缂哄け鏃惰嚜鍔ㄤ笅杞? 鑷姩鎾斁琚嫤鏃舵湇鍔″唴鎸傛墜鍔块噸璇?
	setBgmStateHandler((st, pct) => {
		bgmState.value = st
		bgmPct.value = pct
		if (st === "ready") {
			const id = bgmCurrentId()
			bgmNowName.value = id ? bgmNameOf(id) : ""
		}
	})
	// 瀹夐潤妯″紡鑷剤蹇呴』鍦?syncBgm **涔嬪墠**: 鑻ヤ笂娆′笓娉ㄦ湡闂磋鏉€, settings.json 閲屾畫鐣?	// manual+on, 鑰?syncBgm 浼氱収鐫€瀹?*璧锋挱** 鈥斺€?闅忓悗 applyQuiet 鎵嶆妸瀹冩寕璧? 缁撴灉鏄?	// "鍏堝搷鍗婄鍐嶉潤闊?銆傚厛杩樺師鎴愯繘涓撴敞鍓嶇殑閰嶇疆, syncBgm 涓€寮€濮嬪氨涓嶄細鎾€?	// (鑷姩妯″紡鐨勯噸浼版斁鍦ㄥ悗闈? 姣忓垎閽熶竴娆? 璺ㄨ繃 23:00/8:00 杈圭晫鍗虫椂鍒囨崲)
    pomoSettingsReady = true
    if (pomoNeedsMigration && pomoSettingsReadable) {
        const result = persistSettings()
        if (result === "ok") { pomoNeedsMigration = false; localStorage.removeItem("pomo_cfg") }
        else pomoConfigError.value = "涓撴敞璁剧疆杩佺Щ寰呬繚瀛橈紝璇锋鏌ュ瓨鍌ㄦ潈闄愩€?
    }
    window.addEventListener("nori-open-pomo", openPomoFromNotification)
    if (noriB()?.pomoOpenedFromNotification?.()) openPomoFromNotification()
	recoverFocusMuteIfNeeded()
	pomoUpdateDisplay()
	applyQuiet()
	{
		const bgmId = syncBgm(cfg)
		bgmNowName.value = bgmId ? bgmNameOf(bgmId) : ""
	}
	// 闊虫晥鏂囦欢: 娉ㄥ唽涓嬭浇缁撴灉鍥炶皟 + **棣栨杩涘叆璇讳竴娆＄姸鎬?* (娌′笅杞芥椂璁剧疆閲屾樉绀恒€屾湭涓嬭浇銆?
	// 鎸夐敭闊抽潤榛樹笉鎾?鈥斺€?鍒ゆ柇鍦?services/sfx.ts 閲? 姣忔鎾箣鍓嶇幇闂竴娆″師鐢?
	setSfxDownloadHandler((r: SfxDownloadResult) => {
		sfxBusy.value = false
		if (r.ok) sfxShowStatus({ready: true, done: r.total, total: r.total})
		else sfxShowStatus({ready: false, done: r.done, total: r.total}, r.failed)
	})
	sfxRefresh()
	// 鏁版嵁娴峰姩鎬佽儗鏅?(璁剧疆鍙叧; rAF 鍦ㄩ殣钘忔椂澶╃劧鍋滄憜)
	habitRecord("open")
	if (cfg.dataseaBg && dataseaCanvas.value) initDataseaBg(dataseaCanvas.value)
	renderPause.setNativePaused(window.__noriAppPaused === true)
	// Background initialization may have started after an earlier native pause event.
	setStageRenderPaused(renderPause.setHidden(document.hidden))
	// Ambient 涓诲姩鎼瘽: 瀹夐潤鍑犲垎閽熷悗杞昏交璇翠竴鍙?(璇枡鏈湴, 闆?token)
	startAmbient({
		speak: (line) => {
			if (!chatOpen.value) showAiBubble(line)
		},
		goalLine: () => {
			const line = goalCarePrompt()
			if (line) {
				const m = line.match(/銆?.+?)銆?)
				return m ? `瀵逛簡锛屼綘璇磋銆?{m[1]}銆嶇殑锛岃繘灞曟€庝箞鏍峰暒锛熶笉瑕佹湁鍘嬪姏鍝︼紝鎴戝氨鏄棶闂€俙 : line
			}
			return null
		},
		idleAllowed: () =>
			panel.value === "" && !chatOpen.value && !chatStreaming.value && !touchStreaming.value && !typing.value,
	})
	quietTimer = window.setInterval(() => {
		if (cfg.quietMode === "auto") applyQuiet()
	}, 60_000)
	window.__noriRenderScale = normalizeRenderScale(renderScaleNum.value, 1)
	// 鑳屾櫙鐢诲竷鎸夎繖涓埢搴﹂噸绠椾竴娆? initDataseaBg(涓婇潰)璺戝湪瀹冧箣鍓? 閭ｆ椂杩樿涓嶅埌 __noriRenderScale
	resizeDataseaBg()
	// 鍚姩鍗冲簲鐢ㄥ抚鐜囨。浣?(璁剧疆鍔犺浇瀹屾垚鍚庢墠鏈夋晥; l2d 鐨?installFrameCap 宸茬粰榛樿妗?
	applyL2dFps()
	storagePath.value = getStorageDir()
	storageReady.value = isStorageReady()
	allFilesAccess.value = hasAllFilesAccess()
	
	if (!storageReady.value && !localStorage.getItem("storage_asked")) {
		localStorage.setItem("storage_asked", "1")
		setTimeout(grantStorage, 1200)
	}
	/* 鏂版墜寮曞: 棣栨鎵撳紑 (杩樻病寤虹珛鏁版嵁鐩綍) 涓旀病鐪嬭繃鏃惰嚜鍔ㄥ脊涓€娆°€?	 * 鍒ゆ嵁鐢?isStorageReady() 鑰屼笉鏄?memory.json 瀛樹笉瀛樺湪": 瀹冭鐨勫氨鏄?Downloads/NoriDroid 鐩綍,
	 * 鐩綍寤哄ソ鍗充负"涓嶆槸绗竴娆?銆傚闄?1.6s 鏄瓑棣栧抚/妯″瀷璧峰ご, 閬垮厤鍜屽惎鍔ㄥ姩鐢绘姠娉ㄦ剰鍔?
	 * 瀛樺偍鏉冮檺寮圭獥 (涓婇潰閭ｄ釜 setTimeout) 浼氱洊浣忓紩瀵? 鎵€浠ヨ繖閲屽埢鎰忔櫄浜庡畠銆?*/
	if (!storageReady.value && !localStorage.getItem(INTRO_SEEN_KEY)) {
		setTimeout(() => {
			if (!localStorage.getItem(INTRO_SEEN_KEY) && !introOn.value) introOpen()
		}, 1600)
	}
	const loadedChat = loadChat()
	const cleanedChat = loadedChat.map((m) => {
		if (m.role !== "assistant") return m
		const content = stripInternalPromptMetadata(m.content)
		return content === m.content ? m : {...m, content}
	}).filter((m) => m.role === "system" || m.content.trim() || m.parts?.length)
	messages.value = cleanedChat
	if (cleanedChat.length !== loadedChat.length || cleanedChat.some((m, i) => m !== loadedChat[i])) persistChat(cleanedChat)
	refreshMemView()
	window.dispatchEvent(new Event("nori-diary-updated"))
	// 鑷畾涔変汉璁剧殑閭ｈ鐘舵€?(鏈夊鍏ヨ繃灏辨樉绀恒€岃嚜瀹氫箟 路 N 瀛椼€? 鍚﹀垯鍐呯疆)
	refreshPersonaState()
	if (cfg.apiKey.trim()) refreshModels()

	// 鏈湴妯″瀷鍏堣 (鍚姩鎻愰€?: 鍏堟壂鏈湴宸茶妯″瀷绔嬪嵆寮€濮嬪姞杞? 缃戝叧鍒楄〃鍚庡彴鎷夊彇.
	// 鏃ч€昏緫 await 鑱旂綉鍒楄〃鎴愬姛鍚庢墠 loadModel 鈥斺€?寮辩綉/绂荤嚎鏃剁櫧绛夊埌瓒呮椂鎵嶈妯″瀷
	try {
		const installed = await listInstalled()
		if (installed.length) {
			// 浼樺厛鐢?*涓婃閫夌殑閭ｅ彧**锛?026-09-30 淇細浠ュ墠鍐欐 installed[0].id锛屾崲妯″瀷鍚庨噸鍚氨鍥炵涓€鍙級;
			// 浣嗗繀椤绘牎楠屽畠浠嶇劧瑁呯潃锛堟ā鍨嬪彲鑳借鍗歌浇/鎹㈡満锛夛紝鏍￠獙涓嶈繃鎵嶅洖钀藉垪琛ㄧ涓€涓€?			const saved = cfg.live2dModel
			const usable = !!saved && installed.some((m) => m.id === saved)
			currentModelId.value = usable ? saved : installed[0].id
			// 鎶?瀹為檯鐢熸晥鐨?璁板洖鍐呭瓨锛堜笉棰濆鍐欑洏锛氱瓑涓嬫淇濆瓨璁剧疆鏃惰嚜鐒惰惤鐩橈級锛?			// 杩欐牱"鍥炶惤"杩囦竴娆′箣鍚庯紝涓嬫鍚姩鐩存帴鍛戒腑銆?			cfg.live2dModel = currentModelId.value
		}
	} catch { /* 蹇界暐 */ }
	void loadModel().catch(() => { /* loadModel 鍐呴儴鏈夐敊璇彁绀?*/ })

	// 缃戝叧鍒楄〃鍚庡彴鍒锋柊: 鍙洿鏂?UI 鍒楄〃, 涓嶅啀闃诲/鍒囨崲妯″瀷鍔犺浇
	void (async () => {
		try {
			modelList.value = await fetchModelList()
			listError.value = ""
		} catch (e: any) {
			listError.value = "鑾峰彇妯″瀷鍒楄〃澶辫触: " + (e?.message ?? String(e)) + "锛堝皢浣跨敤鏈湴宸蹭笅杞界殑妯″瀷锛?
		}
	})()
})

onBeforeUnmount(async () => {
	cancelModelTagPress()
	flushTransformSave()
	window.removeEventListener("resize", onResize)
	window.visualViewport?.removeEventListener("resize", syncChatLayout)
	window.visualViewport?.removeEventListener("scroll", syncChatLayout)
	clearPortraitReplyTimer()
	if (aiBubbleTimer) clearTimeout(aiBubbleTimer)
	document.removeEventListener("pointerdown", onStagePointerDown)
	document.removeEventListener("pointermove", onStagePointerMove)
	document.removeEventListener("pointerup", onStagePointerUp)
	document.removeEventListener("pointercancel", onStagePointerUp)
	document.removeEventListener("lostpointercapture", onStagePointerUp)
	window.removeEventListener("blur", cancelStageInteraction)
	window.removeEventListener("focus", refreshStorage)
	window.removeEventListener("nori-app-pause", onNativeVisibility)
	window.removeEventListener("nori-app-resume", onNativeVisibility)
	document.removeEventListener("visibilitychange", onVisibility)
	// 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 鍋滃績璺?+ 娓?60s 鍒锋柊璁℃椂鍣?	stopPresence()
	if (presenceUnsub) { presenceUnsub(); presenceUnsub = null }
	if (presenceTickTimer) { clearInterval(presenceTickTimer); presenceTickTimer = 0 }
	if (touchBubbleTimer) clearTimeout(touchBubbleTimer)
	if (touchCooldownTimer) clearTimeout(touchCooldownTimer)
	if (voiceSaveTimer) clearTimeout(voiceSaveTimer)
	// 椤甸潰閿€姣佸墠: 钀界洏闃叉姈涓殑鑱婂ぉ璁板綍, 閬垮厤涓㈡渶鍚庝竴鏉?	flushChatPersist()
	// 椤甸潰閿€姣佸墠: 璁板繂/鎬荤粨鐨勯槻鎶栧啓鐩樹篃绔嬪嵆钀界洏 (闃蹭涪鏈€鍚庢敼鍔?
	await flushMemoryPersist()
	// 鎮诞绐楃殑鍚姩鐢?MainActivity 鐢熷懡鍛ㄦ湡缁熶竴澶勭悊锛岄〉闈㈠嵏杞戒笉閲嶅鎷夎捣銆?	// 椤甸潰閿€姣佸墠鍋滄鏈楄 / 娴佸紡鑱婂ぉ / 鑳屾櫙闊充箰
	stopTTS()
	cancelChatStream()
	pauseBgm()
	stopDataseaBg()
	stopAmbient()
	setBgmErrorHandler(null)
	if (quietTimer) { clearInterval(quietTimer); quietTimer = 0 }
	if (pomoTickTimer) { clearInterval(pomoTickTimer); pomoTickTimer = 0 }
	if (pomoSulk?.timer) clearTimeout(pomoSulk.timer)
	if (pomoDateTimer) { clearTimeout(pomoDateTimer); pomoDateTimer = 0 }
    window.removeEventListener("nori-open-pomo", openPomoFromNotification)
    if (pomoConfigTimer) clearTimeout(pomoConfigTimer)
    if (pomoSettingsReady && pomoSettingsReadable) persistSettings()
	window.removeEventListener("resize", pomoClampPos)
    window.visualViewport?.removeEventListener("resize", pomoClampPos)
    window.visualViewport?.removeEventListener("scroll", pomoClampPos)
	setTtsErrorHandler(null)
	detector.destroy()
	cancelReturnToNeutral()
	clearPetFx()
	// 鍚堟垚闊崇殑鍣０婧愭槸 loop 鐨? 涓嶆樉寮忓仠鎺? 閫€鍑洪〉闈㈠悗瀹冭繕浼氬崰鐫€闊抽鐒︾偣
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

	/* ============ 璁捐 token: 鍙栬嚜缃戦〉鐗?NoriOS 鐨?--px-* 璁捐绯荤粺 ============
	 * 鏉ユ簮: D:\norios缃戦〉鐗圽archive_0831_nori-os\os.inori.ai\assets\index-FU-0vwSE.css
	 * (缃戦〉鐗?:root 閲岀殑 --px-* 鏄潈濞佸彇鍊? 杩欓噷鏄?*閫愯壊鎼繍**, 涓嶆槸鎴戣嚜宸遍厤鐨?
	 *
	 * 瀹氫箟鍦?.stage-root 鑰屼笉鏄?:root 鈥斺€?scoped 鏍峰紡浼氱粰閫夋嫨鍣ㄥ姞 `[data-v-xxx]`,
	 * 鍐欐垚 `:root` 浼氬彉鎴?`:root[data-v-xxx]`, 鍖归厤涓嶅埌浠讳綍鍏冪礌, token 鍏ㄩ儴闈欓粯钀界┖銆?	 *
	 * 涓庢敼閫犲墠鐨勫尯鍒?(鑲夌溂鍙鐨勯儴鍒?:
	 *   路 搴曡壊浠?鐏拌摑"鏀逛负娣辫摑闃跺眰: #050912/#0f172a 鈫?--px-void/--px-bg/--px-panel/--px-panel-2
	 *   路 寮鸿皟鑹?#7dd3fc 鈫?#67e8f9(闈?: 鏁翠綋浠?鏌斿拰钃濈伆"杞负"闈掕壊鍍忕礌"鑹茬郴
	 *   路 鎻忚竟浠?rgba 鐏?鈫?涓嶉€忔槑娣辫摑 #1e335c/#2a4377 (鍍忕礌椋庣‖杈?
	 *   路 璐ㄦ劅鏀圭敤缃戦〉鐗堢殑"浜笂宸?+ 鏆椾笅鍙?纭嚫璧? 鍙栦唬鏌斿拰鍙戝厜
	 */
	--px-void: #050811;
	--px-bg: #0a1326;
	--px-panel: #0d1b33;
	--px-panel-2: #183055;             /* 鎶崌闈?(姣旂綉椤电増鐨?#142648 鐣ヤ寒, 璁?鎶捣"鐪嬪緱鍑烘潵) */
	--px-stroke: #2a4377;
	--px-line: #1e335c;
	/* ---- 浜害鎸?鍙楅檺鑹叉澘"鏀舵暃杩囦竴妗?(2026-09-26 鐢ㄦ埛鍙嶉"鍍忕礌椋庡お浜?) ----
	 * 缃戦〉鐗堝師鍊?--px-cyan(#67e8f9, 浜害0.674 / 瀵规瘮13.8:1) 涓?#d6fbff(0.905 / 18.2:1) 灞炰簬
	 * **婊″睆楂樹寒**; 鑰屽儚绱犻 UI 鐨勯€氳鍋氭硶鏄綆楗卞拰鍙楅檺鑹叉澘 (NES.css 鐨?NES 姣忎釜 sprite 鍙湁 3 鑹?,
	 * 娣辫壊涓婚涔熶笉璇ョ敤鎺ヨ繎绾櫧鐨勯珮鍏?(UX Movement / Material dark theme: 绾粦 + 楂樹寒 = 瑙嗙柌鍔?銆?	 * 鐜板湪: 寮鸿皟闄嶅埌 8.6:1銆佸嚫璧烽珮鍏夐檷鍒?11.9:1; 鏈€浜偅妗ｅ彧鐣欑粰涓绘寜閽繖绫诲崟涓?CTA銆?*/
	--px-cyan-src: #67e8f9;            /* 缃戦〉鐗堝師鍊肩暀妗?(鎯冲洖鍒板師瑙傛劅灏辨妸 --px-cyan 鎸囧洖瀹? */
	--px-hilite-src: #d6fbff;
	--px-cyan: #4fb8cc;                /* 寮鸿皟: 浜害 0.403 / 瀵规瘮 8.6:1 (鍘?0.674 / 13.8:1) */
	--px-cyan-mid: #3aa0b5;
	--px-cyan-dim: #0e7490;
	--px-cyan-deep: #062c3d;
	--px-hilite: #7fd4e6;              /* 鍑歌捣"浜笂宸?: 浜害 0.573 / 瀵规瘮 11.9:1 (鍘?0.905 / 18.2:1) */
	--px-text: #e6f1f7;                /* 姝ｆ枃: 鍘?#f8fafc 鏄?19.1:1, 鐣ラ檷鍑忓皯瀵规瘮鐤插姵 */
	--px-amber: #d9b45c;               /* 璇箟鑹插悓姝ュ幓楗卞拰, 涓庡彈闄愯壊鏉夸竴鑷?*/
	--px-amber-deep: #92400e;
	--px-magenta: #c98fd4;
	--px-magenta-deep: #701a75;
	--px-violet: #a48ad4;
	--px-violet-deep: #4c1d95;
	--px-green: #4aa87a;
	--px-red: #d4706e;
	--px-white: var(--px-text);
	--px-grey: #94a3b8;
	--px-dim: #7c8db5;

	/* 鏃ц涔?token 淇濈暀涓?*鍒悕**, 鎸囧悜鏂拌壊鏉?鈥斺€?杩欐牱宸叉湁鐨?100+ 澶?var() 寮曠敤涓嶇敤閫愪釜鏀?
	   鏁撮〉鎹㈣偆鍙彂鐢熷湪杩欎竴涓湴鏂? 涔熶笉浼氭紡鎺変换浣曚竴澶勩€?*/
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

/* ================= 澶栬椋庢牸: 鏌斿拰 (鍙繚鐣欑綉椤电増鑹叉澘) =================
 * 甯冨眬闃舵: 鎶婂儚绱犻纭紪鐮佺殑褰㈢姸鍙傛暟鏀舵暃鎴愬彉閲忋€? * 鍍忕礌椋庝笅瀹冧滑绛変簬鐜板湪鐨勭‖鍊?0 鍦嗚 / 2px 杈?/ #d6fbff 浜竟 / #050811 鏆楄竟), 鏌斿拰椋庝笅鐢变笅闈? * 鐨?`.ui-soft` 瑕嗙洊灞傛暣浣撴崲鎺夈€?*鑹叉澘涓€涓瓧閮戒笉鍔?* 鈥斺€?涓ょ椋庢牸鐨勫樊寮傚彧鍦ㄥ舰鐘朵笌璐ㄦ劅銆?*/
.ui-pixel, .ui-soft {
	--ui-radius-panel: 0px;
	--ui-radius-card: 0px;
	--ui-radius-ctl: 0px;
	--ui-radius-pill: 0px;
	--ui-line-w: 2px;
	--ui-line-c: var(--px-stroke);
	--ui-line-c-soft: var(--px-line);
	--ui-hi: var(--px-hilite);      /* 鍑歌捣"浜笂宸? */
	--ui-lo: var(--px-void);        /* 鍑歌捣"鏆椾笅鍙? */
	--ui-lift: 4px;                 /* 纭姇褰遍珮搴?*/
	/* 鈿?杩欓噷**涓嶈兘鍐?none**: 璇ュ彉閲忚鎷艰繘閫楀彿鍒嗛殧鐨勯槾褰卞垪琛?(`..., var(--ui-shadow)`),
	   `none` 涓嶆槸鍚堟硶鍒楄〃椤?鈥斺€?娴忚鍣ㄤ細**鏁存潯 box-shadow 涓㈠純**, 鍍忕礌椋庣殑鍑歌捣闈欓粯娑堝け
	   (瀹炴祴: computedStyle 鍙樻垚 none, 鎸夐挳涓嶅啀鏈夌珛浣撴劅)銆傛墍浠ョ敤"闆堕槾褰?鍗犱綅銆?*/
	--ui-shadow: 0 0 0 rgba(0, 0, 0, 0);
	/** 闈㈡澘椤堕儴閭ｄ竴閬撶粏楂樺厜 (鍍忕礌椋庣殑"浜笂宸?); 鏌斿拰椋庝笅鎹㈡垚鍏ㄩ€忔槑, 鐢?--ui-shadow 鎺ョ */
	--ui-inner-glow: var(--px-panel-2);
	/** 闈㈡澘涓嬫部閭ｄ竴閬撶‖搴曡竟 (鍍忕礌椋庣殑"鏆椾笅鍙?): 2026-10-25 鎶芥垚鍙橀噺 鈥斺€?涔嬪墠瀹冭鍐欐鎴?	 *  `0 -6px 0 0 rgba(5,8,17,0.55)` 鐨?*瀛楅潰閲?*, 鏌斿拰椋庤鐩栦笉鍒? 浜庢槸鍦嗚+鏌斿拰闃村奖鐨?	 *  闈㈡澘涓嬫部浠嶆寕鐫€鍍忕礌椋庣殑纭竟 (e2e-pixel-ui 鐨?鏌斿拰: 涓嶅啀鏈夊儚绱犲嚫璧?灏辨槸杩欎箞绾㈢殑)銆?*/
	--ui-sheet-edge: 0 -6px 0 0 rgba(5, 8, 17, 0.55);
	/** 鑳屾櫙妯＄硦寮哄害 (C4, 2026-09-27): 鍍忕礌椋庝竴寰?0 鈥斺€?`backdrop-filter` 鏄?*姣忓抚瀵硅儗鍚庢暣鍧楀尯鍩?	 *  閲嶆柊閲囨牱鍚堟垚**, 鍦?60fps + Live2D(WebGL) + 鏁版嵁娴?2D canvas) 鍚屽睆鏃舵槸瀹炴墦瀹炵殑 GPU 寮€閿€銆?	 *  鍍忕礌椋庢湰鏉ヤ篃涓嶉渶瑕佹ā绯?(鍍忕礌 UI 鐨勯€氳鍋氭硶鏄疄鑹查潰鏉?+ 纭竟)銆?*/
	--ui-blur-bubble: 0px;
	--ui-blur-chip: 0px;
	--ui-blur-mask: 0px;
	--ui-press: inset -2px -2px 0 0 var(--ui-hi), inset 2px 2px 0 0 var(--ui-lo);
}
/* ---- 鏌斿拰: 鍦嗚鍥炴潵 + 鍗婇€忔槑缁嗘弿杈?+ 鏌斿拰闃村奖; **淇濈暀鎸変笅鍑归櫡** ---- */
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
	/* 鏌斿拰椋庝笉瑕佸儚绱犻閭ｉ亾纭簳杈? 浠嶇劧鐢?闆堕槾褰?鍗犱綅 (涓嶈兘鍐?none, 鍚﹀垯鏁存潯 box-shadow 琚涪寮? */
	--ui-sheet-edge: 0 0 0 0 rgba(0, 0, 0, 0);
	/* 鏌斿拰椋庢仮澶嶄竴鐐规瘺鐜荤拑璐ㄦ劅 (姣斿師鏉ョ殑 10/14/12px 鏇寸渷): 姘旀场 6px銆佽钀芥彁绀?8px銆?	   瑕佸交搴曠渷鐢靛彲浠ユ妸杩欏嚑涓€间篃鍐?0 鈥斺€?瑙傛劅宸紓寰堝皬銆?*/
	--ui-blur-bubble: 6px;
	--ui-blur-chip: 8px;
	--ui-blur-mask: 3px;
	/* 鏌斿拰椋?*涓嶈**鍍忕礌鍑歌捣 (浜笂宸?+ 鏆椾笅鍙?, 鎹㈡垚鍑犱箮鐪嬩笉瑙佺殑鍐呮弿杈?
	   浣?*鎸変笅鍑归櫡淇濈暀** 鈥斺€?閭ｆ槸鐢ㄦ埛鏄庣‘璇?鎬濊矾涓嶉敊"鐨勯儴鍒嗐€?*/
	--ui-hi: rgba(255, 255, 255, 0.06);
	--ui-lo: rgba(0, 0, 0, 0.28);
	/* 鎸変笅鍑归櫡: 涓庡儚绱犻鍚屼竴鎬濊矾, 鎹㈡垚鏌斿拰鐨?inset 鍐呴槾褰?*/
	--ui-press: inset 0 2px 6px rgba(0, 0, 0, 0.5);
}

/* 娼睈鐜荤拑锛氬悓涓€濂楁帶浠剁殑绗簩绉嶈鎰燂紝鐢ㄦ洿娓呮櫚鐨勯潚鑹插眰娆″拰鏌斿拰娴奖鍖哄垎灞傜骇銆?*/
.ui-tide {
	--ui-radius-panel: 18px;
	--ui-radius-card: 14px;
	--ui-radius-ctl: 9px;
	--ui-radius-pill: 999px;
	--ui-line-w: 1px;
	--ui-line-c: rgba(127, 212, 230, 0.26);
	--ui-line-c-soft: rgba(127, 212, 230, 0.14);
	--ui-lift: 0px;
	--ui-shadow: 0 14px 32px rgba(2, 8, 18, 0.34), 0 0 0 1px rgba(127, 212, 230, 0.05);
	--ui-inner-glow: rgba(127, 212, 230, 0.08);
	--ui-blur-bubble: 10px;
	--ui-blur-chip: 12px;
	--ui-blur-mask: 5px;
	--ui-hi: rgba(182, 245, 242, 0.14);
	--ui-lo: rgba(0, 0, 0, 0.34);
	--ui-press: inset 0 2px 10px rgba(0, 0, 0, 0.44), 0 1px 0 rgba(255, 255, 255, 0.04);
}
.ui-tide .sheet {
	background: linear-gradient(155deg, rgba(18, 43, 61, 0.97), rgba(7, 20, 36, 0.97));
	box-shadow: 0 -10px 34px rgba(2, 8, 18, 0.42), inset 0 1px 0 rgba(182, 245, 242, 0.08);
}
.ui-tide .dock {
	background: linear-gradient(155deg, rgba(20, 48, 62, 0.86), rgba(7, 20, 35, 0.86));
	border-color: rgba(127, 212, 230, 0.3);
	box-shadow: 0 12px 34px rgba(2, 8, 18, 0.42), inset 0 1px 0 rgba(182, 245, 242, 0.12);
}
.ui-tide .fab:hover { background: rgba(127, 212, 230, 0.12); }
.ui-tide .settings-section,
.ui-tide .tts-sec {
	background: linear-gradient(155deg, rgba(24, 51, 69, 0.72), rgba(10, 27, 44, 0.72));
	border-color: rgba(127, 212, 230, 0.16);
}
.ui-tide .settings-entry-button {
	background: linear-gradient(105deg, rgba(127, 212, 230, 0.18), rgba(126, 224, 194, 0.1));
	border-color: rgba(127, 212, 230, 0.34);
}

/* 鎵嬫寚瑙︽懜杩借釜: 鍗婇€忔槑灏忕櫧鐐?*/
.touch-dot-host {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 40;
	overflow: hidden;
}
.touch-dot {
	position: absolute;
	left: 0;
	top: 0;
	width: 22px;
	height: 22px;
	border-radius: 50%;
	/* 鐧借壊娓愬彉淇濈暀楂樺厜涓庡崐閫忔槑璐ㄦ劅 */
	background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.35) 55%, rgba(255,255,255,0.08) 100%);
	border: 1px solid rgba(255,255,255,0.5);
	box-shadow: 0 0 12px rgba(255,255,255,0.35), inset 0 0 6px rgba(255,255,255,0.3);
	opacity: 1;
	transform: translate3d(0, 0, 0) translate(-50%, -50%);
	will-change: transform;
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
.touch-overlay.drawing { cursor: crosshair; }
.touch-area-box {
	position: absolute;
	box-sizing: border-box;
	border: 2px solid rgba(80, 160, 255, 0.95);
	background: rgba(80, 160, 255, 0.15);
	border-radius: var(--ui-radius-ctl);
	&.swipe { border-color: rgba(255,170,60,0.95); background: rgba(255,170,60,0.15); }
	&.frenzy { border-color: rgba(255,80,200,0.95); background: rgba(255,80,200,0.15); }
	&.draft { border-style: dashed; border-color: rgba(125,227,255,0.95); background: rgba(125,227,255,0.15); }
	&.selected { border-color: #a7f3d0; box-shadow: 0 0 0 2px rgba(110,231,183,0.28), 0 0 18px rgba(110,231,183,0.2); }
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

/* TTS 闈㈡澘鍒嗙粍 */
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
	/* 涓?.settings-row 鍚屾: 琛?number/password, 閬垮厤榛樿鐧藉簳 */
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

/* 浣欓鏌ヨ */
.bal-grid {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

/* 闊宠壊閫夋嫨琛?*/
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

/* 鎿嶄綔鎸夐挳琛?*/
.btn-row {
	display: flex;
	gap: 8px;
	.btn { flex: 1; width: auto; margin-top: 0; }
}
/* 璁板繂闈㈡澘 4 涓搷浣滄寜閽? 绐勫睆鑷姩鎹㈣ */
.btn-row.mem-btns { flex-wrap: wrap; }
.btn-row.mem-btns .mini { flex: 1 1 auto; text-align: center; }
.touch-page .touch-overlay.drawing, .touch-page .touch-overlay.testing { cursor: crosshair; }
.touch-top {
	position: absolute;
	top: 0; left: 0; right: 0;
	z-index: 3;
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
.touch-intro, .touch-pet-options {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 11px 12px;
	border: 1px solid rgba(127, 212, 230, 0.2);
	border-radius: var(--ui-radius-card);
	background: rgba(20, 37, 52, 0.72);
}
.touch-intro-icon { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 10px; color: #bdefff; background: rgba(56,189,248,0.14); font-size: 21px; }
.touch-intro-copy, .touch-option-head { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1; }
.touch-intro-copy b, .touch-option-head b { color: var(--fg); font-size: 13px; }
.touch-intro-copy span, .touch-option-head small { color: var(--fg-dim); font-size: 11px; line-height: 1.45; }
.touch-pet-options { display: block; }
.touch-option-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 9px; }
.touch-option-grid label { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 9px; background: rgba(2, 6, 23, 0.25); color: var(--fg-2); font-size: 11px; }
.touch-option-grid input { width: 17px; height: 17px; accent-color: var(--accent-strong); }
.touch-editor {
	position: absolute;
	left: 0; right: 0; bottom: 0;
	z-index: 3;
	max-height: 48vh;
	overflow-y: auto;
	pointer-events: auto;
	padding: 12px 14px calc(16px + env(safe-area-inset-bottom));
	background: linear-gradient(180deg, rgba(2,6,23,0.75) 0%, rgba(2,6,23,0.97) 100%);
	border-top: 1px solid var(--line);
	display: flex;
	flex-direction: column;
	gap: 10px;
	touch-action: pan-y;
}
.touch-custom summary { padding: 10px 0; color: var(--fg-2); font-size: 13px; cursor: pointer; }
.touch-custom summary small { color: var(--fg-dim); margin-left: 8px; }
.touch-feedback { margin: 0; font-size: 12px; color: var(--accent-strong); }
.touch-ai-preview { padding: 10px; border: 1px solid var(--line); border-radius: var(--ui-radius-card); font-size: 12px; color: var(--fg); }
.touch-ai-preview p { margin: 5px 0 0; white-space: pre-wrap; line-height: 1.6; max-height: 22vh; overflow: auto; }
.touch-resize-handle { position: absolute; right: -3px; bottom: -3px; width: 28px; height: 28px; background: #164e63; color: #a7f3d0; border: 1px solid currentColor; display: grid; place-items: center; border-radius: 4px; }
@media (orientation: landscape) and (min-width: 640px) {
	.touch-editor { left: auto; top: 58px; width: min(360px, 44vw); max-height: none; border-left: 1px solid var(--line); }
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
	/* 涓庤亰澶╂皵娉′竴鑷? 涓枃鎸夊瓧鑷劧鎹㈣ + 鏍囩偣绂佸垯 (keep-all 浼氳鏃犳爣鐐归暱鍙ョ‖鍒? */
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
.tag {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 3px;
	font-family: inherit;
	text-align: left;
	line-height: 1.2;
	cursor: pointer;
	-webkit-touch-callout: none;
}
.tag-hint {
	font-size: 10px;
	color: var(--fg-3);
	font-weight: 400;
}
.tag.locked .tag-hint { color: var(--accent); }
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
	/* 闈㈡澘鏀逛负瀹屽叏閫忔槑: 鍘绘帀鏁村潡姣涚幓鐠? 璁╄儗鏅?妯″瀷閫忓嚭鏉?
	   姘旀场鏀圭敤鑷韩鍗婇€忔槑濉厖鎵挎媴鍙鎬?(瑙佷笅), 鍥犳杩欓噷涓嶅啀闇€瑕佷换浣曡儗鏅眰.
	   鎬ц兘涓婅繖鏄噣鏀剁泭: 鍘熷厛 ::before 鐨?backdrop-filter 瑕佹瘡甯у绾﹀崐涓睆骞曞仛
	   鍖哄煙閲嶉噰鏍? 鑰屽簳涓嬬殑 Live2D(WebGL) 涓庢暟鎹捣(2D canvas) 閮藉湪閫愬抚娓叉煋, 鍏辩敤鍚屼竴涓?GPU.
	   杩炲甫鍘绘帀 border 涓?box-shadow 鈥斺€?瀹冧滑鍘熸湰鏄鍦ㄦ瘺鐜荤拑鍧椾笂鐨? 闈㈡澘閫忔槑鍚庝細鍙樻垚
	   鎮┖鐨勪竴鍦堢嚎鍜屼竴鏉℃殫甯? */
	background: transparent;
	border: none;
	/* 淇濈暀鍦嗚: border 鍘绘帀浜? 浣?overflow:hidden 闇€瑕佸畠浣滀负瑁佸壀鍗婂緞,
	   鍚﹀垯婊氬姩鍐呭浼氭孩鍑洪潰鏉胯竟鐣?*/
	border-radius: var(--ui-radius-card);
	z-index: 12;
	overflow: hidden;
}
.chat-head {
	display: flex; justify-content: space-between; align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid var(--line-soft);
}
.chat-history {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
	overflow: hidden;
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
	/* 涓枃鎸夊瓧鑷劧鎹㈣ (涓庡井淇＄瓑涓€鑷?: 涔嬪墠鐨?keep-all 浼氳鏃犳爣鐐归暱鍙ユ暣娈典笉鍙柇,
	   鍒版皵娉¤竟缂樿杩湪浠绘剰浣嶇疆纭垏 鈥斺€?杩欐鏄?闀垮彞涓棿琚己鍒舵崲琛?鐨勬牴婧?
	   line-break: strict 淇濈暀鏍囩偣绂佸垯 (銆傦紒锛熺瓑涓嶅嚭鐜板湪琛岄), 鑻辨枃闀垮崟璇嶇敱
	   overflow-wrap 鍙湪鏁磋鏀句笉涓嬫椂鎵嶆媶 */
	word-break: normal;
	line-break: strict;
	overflow-wrap: break-word;
	color: var(--fg);
}
.bubble-wrap.user .bubble {
	/* 鎵佸钩鐫€鑹?(閰嶅悎闈㈡澘绾ф瘺鐜荤拑): 姘旀场涓嶅啀鍚勮嚜寮€ backdrop-filter */
	background: linear-gradient(135deg, rgba(56, 189, 248, 0.55) 0%, rgba(99, 102, 241, 0.55) 100%);
	border: 1px solid var(--line);
	color: #fff;
	text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
	border-bottom-right-radius: 4px;
}
.bubble-wrap.assistant .bubble {
	/* 闈㈡澘閫忔槑鍚? Nori 鐨勬皵娉¤嚜宸辨壙鎷?鍙鍙堝彲閫?鐨勫钩琛?
	   搴曡壊鐢?0.62 闄嶅埌 0.34 (绾～鍏? 涓嶄骇鐢熷悎鎴愬眰, 涓嶉噰鏍疯儗鏅?鈫?闆?backdrop-filter 鎴愭湰),
	   骞惰ˉ涓€灞傛枃瀛楁姇褰?鈥斺€?鍗婇€忔槑搴曞帇鍒版ā鍨嬩寒閮ㄦ椂, 鍏夐潬搴曡壊瀵规瘮涓嶅. */
	background: rgba(30, 41, 59, 0.34);
	border: 1px solid var(--line-strong);
	color: #e8eef7;
	text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
	border-bottom-left-radius: 4px;
}
/* 瑁佸壀鍗犱綅绗? 灞呬腑寮卞寲鏄剧ず (閲嶅惎鍚庝笉鍐嶆秷澶? FE-M4) */
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
	padding: 10px 12px 4px;
	border-top: 1px solid var(--line-soft);
}
.chat-tools {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 12px 8px;
	flex-shrink: 0;
}
.chat-tool {
	min-height: 40px;
	padding: 0 12px;
	border: 1px solid var(--line-soft);
	border-radius: var(--ui-radius-ctl);
	background: var(--surface);
	color: var(--fg);
	font-size: 13px;
	white-space: nowrap;
	&:disabled { opacity: 0.4; }
}
.chat-tool-hint {
	margin-left: auto;
	color: var(--fg-dim);
	font-size: 11px;
}
.image-entry { position: relative; }
.image-menu {
	position: absolute;
	bottom: calc(100% + 6px);
	left: 0;
	z-index: 2;
	display: flex;
	flex-direction: column;
	width: 160px;
	padding: 4px;
	border: 1px solid var(--line-strong);
	border-radius: var(--ui-radius-ctl);
	background: rgba(15, 23, 42, 0.98);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	button {
		min-height: 44px;
		padding: 8px 12px;
		text-align: left;
		color: var(--fg);
		font-size: 14px;
		border-radius: var(--ui-radius-ctl);
		&:active { background: rgba(56, 189, 248, 0.16); }
	}
}
.image-preview-row {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 12px;
	flex-shrink: 0;
}
.image-preview {
	width: 56px;
	height: 56px;
	object-fit: cover;
	border-radius: var(--ui-radius-ctl);
}
.image-preview-meta {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex: 1;
	min-width: 0;
	color: var(--fg-3);
	font-size: 12px;
}
.image-remove { min-width: 40px; min-height: 40px; color: var(--fg); }
.message-image-wrap { max-width: var(--bubble-w, 82%); }
.message-image {
	display: block;
	max-width: 100%;
	width: 200px;
	max-height: 180px;
	object-fit: contain;
	border-radius: var(--ui-radius-card);
}
.queue-hint {
	padding: 5px 14px 0;
	font-size: 11px;
	color: var(--accent);
	text-align: right;
}
.chat-input input {
	flex: 1;
	min-width: 0;
	background: rgba(30, 41, 59, 0.9);
	border: 1px solid var(--line-strong);
	border-radius: var(--ui-radius-ctl);
	padding: 10px 12px;
	color: var(--fg);
	font-size: 14px;
	outline: none;
}
.chat-input .send {
	flex-shrink: 0;
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
/* ---- 鐣寗閽熸偓娴獥 ---- */
.pomo-widget {
	position: fixed;
	z-index: 18;
	box-sizing: border-box;
	max-width: calc(100vw - 24px);
	background: var(--px-panel);
	border: 1px solid var(--px-stroke);
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
	color: var(--px-cyan);
	cursor: grab;
	touch-action: none;
}
.pw-mini-btn {
	margin-left: auto;
	background: transparent;
	border: none;
	color: var(--px-grey);
	font-size: 14px;
	min-width: 44px;
	min-height: 44px;
}
.pw-tomato { font-size: 13px }
.pw-time {
	font-size: 34px;
	font-weight: 700;
	color: var(--px-white);
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
	width: 100%;
	transform-origin: left;
	background: var(--px-cyan);
	transition: transform 0.4s linear;
}
.pw-btns {
	display: flex;
	gap: 8px;
	margin-top: 10px;
}
.pw-btns button {
	min-height: 44px;
	flex: 1;
	background: rgba(255, 255, 255, 0.08);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: var(--px-text);
	border-radius: var(--ui-radius-ctl);
	padding: 7px 0;
	font-size: 13px;
}
.pw-btns button.warn { color: var(--px-red); border-color: rgba(255, 150, 130, 0.35) }
.pw-grip {
	position: absolute;
	right: 2px;
	bottom: 2px;
	width: 44px;
	height: 44px;
	cursor: nwse-resize;
	touch-action: none;
	transform: translate(12px,12px);
	background: linear-gradient(135deg, transparent 80%, var(--px-stroke) 80%);
	border-bottom-right-radius: 12px;
}
.pw-pill {
	background: transparent;
	border: none;
	color: var(--px-white);
	border-radius: var(--ui-radius-pill);
	padding: 7px 14px;
	font-size: 15px;
	font-variant-numeric: tabular-nums;
}
.pw-mini-group {display:flex;align-items:center;background:var(--px-panel);border:1px solid var(--px-stroke);border-radius:var(--ui-radius-pill);overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.pw-mini-drag {display:grid;place-items:center;width:30px;min-height:50px;color:var(--px-grey);cursor:grab;touch-action:none}
.pw-pill {display:flex;flex-direction:column;gap:3px;min-height:50px;padding:5px 10px;cursor:pointer}
.pw-pill small{font-size:9px;color:var(--px-cyan)}
.pw-mini-control{min-width:44px;min-height:50px;color:var(--px-cyan);border:0;border-left:1px solid var(--px-line);background:transparent;cursor:pointer}
.sheet.focus-sheet{margin:0 auto;width:min(460px,calc(100vw - 24px));max-width:460px;max-height:90dvh;padding:20px;box-sizing:border-box;background:var(--px-bg)}
.focus-sheet .sheet-head{margin-bottom:16px}
.focus-sheet .sheet-body{padding-right:4px;scrollbar-width:thin;scrollbar-color:var(--px-stroke) transparent}
.focus-sheet .sheet-body::-webkit-scrollbar{width:4px}.focus-sheet .sheet-body::-webkit-scrollbar-track{background:transparent}.focus-sheet .sheet-body::-webkit-scrollbar-thumb{background:var(--px-stroke);border-radius:4px}
.pomo-stats-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px;font-size:11px;color:var(--px-grey)}
.pomo-range-overview{display:flex;flex-direction:column;gap:8px;padding:18px 0;color:var(--px-grey);font-size:11px}
.pomo-range-overview b{font-size:30px;color:var(--px-white);font-weight:500}.pomo-range-overview small{font-size:12px;font-weight:400}
.pomo-date-picker{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--px-grey);margin-top:14px}.pomo-date-picker input{min-height:44px;background:var(--px-bg);color:var(--px-text);border:1px solid var(--px-stroke);border-radius:var(--ui-radius-ctl);padding:8px;color-scheme:dark}
.pomo-selectable-bars button{border:0;background:none;padding:0;cursor:pointer;min-width:0}.pomo-selectable-bars button:focus-visible{outline:1px solid var(--px-cyan)}
.focus-sheet .settings-row{padding:14px;border:1px solid var(--px-line);background:var(--px-panel);border-radius:var(--ui-radius-card);margin-bottom:14px}
.focus-sheet .pomo-months{margin-top:14px}
@media(max-width:380px){.sheet.focus-sheet{padding:15px;max-height:92dvh}}
@media(prefers-reduced-motion:reduce){.pw-bar i{transition:none}}
/* ---- 鐣寗閽熼潰鏉?---- */
.pomo-pair { display: flex; align-items: center; gap: 8px }
/* 涓庤缃潰鏉垮叾瀹冭緭鍏ユ鍚屾澶栬; 瀹藉害鎸?鍗曡涓や綅鏁?涓変綅鏁?+ 鏃犳暟瀛楃澶?瀹氫负 96px
   (鍘?84px 鏄寜鏃犲唴杈硅窛鐨勯粯璁ょ櫧搴曟瀹氱殑, 鍔犱笂 padding 鍚庢斁涓嶄笅 max=120 鐨勪笁浣嶆暟) */
.pomo-pair input {
	width: 96px;
	text-align: center;
	font-variant-numeric: tabular-nums;
}
.pomo-slash { color: var(--px-dim) }
.pomo-chips { display: flex; gap: 6px; flex-wrap: wrap }
.pomo-chip {
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: var(--px-grey);
	border-radius: var(--ui-radius-pill);
	padding: 5px 12px;
	font-size: 12px;
}
.pomo-chip.on { background: var(--px-cyan-deep); border-color: var(--px-cyan); color: var(--px-white) }
.pomo-today { color: var(--px-white); font-size: 13px }
/* 瀹屾垚鐜?骞冲潎姣忔: 娆＄骇淇℃伅, 寮卞寲鏄剧ず */
.pomo-sub { display: flex; gap: 12px; margin-top: 2px; font-size: 11px; color: var(--px-dim) }
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
.pomo-bars .pb-col i { width: 100%; max-width: 22px; border-radius: var(--ui-radius-ctl) 4px 0 0; background: linear-gradient(180deg, var(--px-cyan), var(--px-cyan-dim)) }
/* 鏌遍《甯告樉鍒嗛挓鏁? 鎵嬫満涓?hover 涓嶅彲鐢? 鍘熷厛鐨?title 绛変簬鐪嬩笉鍒?*/
.pomo-bars .pb-col .pb-val { font-size: 10px; font-weight: 600; color: var(--px-grey); margin-bottom: 2px }
.pomo-bars .pb-col span { font-size: 10px; color: var(--px-dim); margin-top: 4px }
/* 30/365 澶╂。: 鏌卞瓙鍙樼獎銆侀棿闅欏彉灏? 鍚﹀垯涓€鏍逛笉鍒?1px 鐪嬩笉娓?*/
.pomo-bars.dense { gap: 1px; padding: 6px 6px }
.pomo-bars.dense .pb-col i { max-width: 100%; border-radius: 2px 2px 0 0 }
.pomo-bars.dense .pb-col span { font-size: 8px; margin-top: 2px }
/* 鑼冨洿鍒囨崲鍣?*/
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
/* 鐑姏鍥惧鍣? 涓€骞?52 鍒楁瘮闈㈡澘瀹? 蹇呴』鍙í鍚戞粴鍔?*/
.pomo-heat-wrap { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; padding-bottom: 4px }
.pomo-heat { display: block; image-rendering: pixelated; cursor: pointer }
.pomo-heat-legend { display: flex; align-items: center; gap: 4px; margin-top: 6px; justify-content: flex-end }
.pomo-heat-legend .mh-label { font-size: 10px; color: var(--px-dim) }
.pomo-heat-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block }
.mh-lv1 { background: var(--px-cyan); opacity: .35 }
.mh-lv2 { background: var(--px-cyan); opacity: .55 }
.mh-lv3 { background: var(--px-cyan); opacity: .78 }
.mh-lv4 { background: var(--px-cyan) }
.pomo-daybox {
	display: flex; flex-direction: column; gap: 2px;
	margin-top: 6px; padding: 8px 10px;
	background: var(--px-cyan-deep);
	border: 1px solid var(--px-cyan-deep);
	border-radius: var(--ui-radius-ctl);
	b { font-size: 13px; color: var(--px-white) }
	span { font-size: 12px; color: var(--px-grey) }
}
/* 鏈堝害姹囨€绘潯 */
.pomo-months { display: flex; flex-direction: column; gap: 4px }
.pm-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--px-grey) }
.pm-name { flex: 0 0 44px; color: var(--px-dim) }
.pm-bar { flex: 1; height: 7px; border-radius: var(--ui-radius-ctl); background: var(--line-soft); overflow: hidden }
.pm-bar i { display: block; height: 100%; border-radius: var(--ui-radius-ctl); background: linear-gradient(90deg, var(--px-cyan-dim), var(--px-cyan)) }
.pm-val { flex: 0 0 92px; text-align: right }
.pomo-act { display: flex; gap: 8px; margin: 6px 0 4px }
.pomo-go {
	flex: 1;
	background: linear-gradient(135deg, var(--px-cyan-deep), rgba(126, 224, 194, 0.24));
	border: 1px solid rgba(126, 156, 216, 0.45);
	color: var(--px-white);
	border-radius: var(--ui-radius-ctl);
	padding: 10px 0;
	font-size: 14px;
}
.pomo-go.alt { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.14); color: var(--px-grey) }
.chat-enter-active, .chat-leave-active { transition: opacity 0.22s ease, transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1); }
.chat-enter-from, .chat-leave-to { opacity: 0; transform: translateY(16px); }


.dock {
	position: absolute;
	left: 50%; right: auto; bottom: calc(8px + env(safe-area-inset-bottom));
	transform: translateX(-50%);
	width: min(96vw, 480px);
	padding: 7px;
	display: grid;
	grid-auto-flow: column;
	grid-auto-columns: minmax(0, 1fr);
	gap: 5px;
	z-index: 5;
	background: rgba(7, 17, 31, 0.78);
	border: 1px solid rgba(127, 212, 230, 0.22);
	border-radius: 18px;
	box-shadow: 0 10px 28px rgba(2, 8, 18, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08);
	backdrop-filter: blur(14px);
	-webkit-backdrop-filter: blur(14px);
}
/* 搴曟爮鎸夊疄闄呭叆鍙ｆ暟閲忓潎鍒嗭紝涓嶄负宸茬Щ闄ょ殑鍏ュ彛淇濈暀绌哄垪銆?*/
.fab {
	min-width: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 3px;
	padding: 6px 2px 5px;
	border-radius: var(--ui-radius-ctl);
	background: transparent;
	color: var(--fg-2);
	font-size: 12px;
	border: 1px solid transparent;
	transition: color 0.18s ease, background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
	&:hover {
		background: rgba(127, 212, 230, 0.08);
		border-color: rgba(127, 212, 230, 0.22);
		color: var(--fg);
	}
	&:active {
		transform: translateY(1px) scale(0.97);
		background: rgba(127, 212, 230, 0.16);
	}
	&:disabled { opacity: 0.4; pointer-events: none; }
}
.fab-ico {
	width: 30px;
	height: 30px;
	display: block;
	transition: transform 0.18s ease-out, filter 0.18s ease-out;
}
.fab:hover .fab-ico { filter: drop-shadow(0 0 5px rgba(127, 212, 230, 0.48)); }
.fab:active .fab-ico { transform: scale(0.94); }
.fab-label {
	font-size: 11px;
	line-height: 1.1;
	letter-spacing: 0.2px;
}
.fab.primary {
	background: rgba(127, 212, 230, 0.16);
	color: var(--accent);
	border-color: rgba(127, 212, 230, 0.4);
	font-weight: 600;
}


.sheet-mask {
	position: fixed; inset: 0;
	background: rgba(5, 8, 17, 0.68);      /* --px-void 鍗婇€忔槑 */
	z-index: 20;
	display: flex; align-items: flex-end;
}
.sheet {
	width: 100%;
	max-height: 74vh;
	background: var(--px-panel);
	/* 鍍忕礌椋? 鐩磋 + 2px 纭弿杈?(缃戦〉鐗?.pixel-idle * 鐨?2px solid var(--px-void) 鍚屾簮) */
	border-top-left-radius: var(--ui-radius-panel);
	border-top-right-radius: var(--ui-radius-panel);
	border-top: var(--ui-line-w) solid var(--ui-line-c);
	box-shadow: inset 0 2px 0 0 var(--ui-inner-glow), var(--ui-sheet-edge), var(--ui-shadow);
	padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
	display: flex; flex-direction: column;
}
.sheet-head {
	display: flex; justify-content: space-between; align-items: center;
	padding: 8px 2px 12px;
	border-bottom: var(--ui-line-w) solid var(--ui-line-c-soft);
	margin-bottom: 12px;
	/* 2026-10-01 鍒狅細鍘熸潵杩欓噷鏈変竴灞?45掳 鎶栧姩鏉＄汗搴曠汗锛堟妱鑷綉椤电増 .pixel-dither-cyan锛夛紝
	   鐢ㄦ埛鐪嬪疄鏈烘埅鍥惧悗鍒ゅ畾"澶笐" 鈬?鍘绘帀锛屽彧淇濈暀涓嬮潰鐨勫垎闅旂嚎銆傦紙鏂瑰悜涓婁篃涓?涓嶅啀鍙傝€冪綉椤电増"涓€鑷达級 */
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
/* 銆屸枲 鍋滄鐢熸垚銆?銆屸枲 鍋滄銆嶆槸**甯︽枃瀛?*鐨勬寜閽? 涓嶈兘濂?.x 鐨勫浐瀹?32x32 鈥斺€?   鍚﹀垯 5 涓瓧鎸ゅ湪 32px 閲屼細閫愬瓧鎹㈣銆佹孩鍑鸿竟妗?(瀹炴満鎴浘灏辨槸绔栨帓鐨?鍋?姝?鐢?鎴?),
   鑰屼笖鎵撳紑璁剧疆闈㈡澘鏃惰繕浼氶€忚繃鍗婇€忔槑閬僵闇插湪闈㈡澘澶栥€傚洖閫€鐐? backups\鍋滄鐢熸垚UI-* */
.x.stop {
	width: auto; min-width: 32px; height: 32px;
	padding: 0 8px;
	white-space: nowrap;
	flex-shrink: 0;
}
.sheet-body { overflow-y: auto; flex: 1; min-height: 0; -webkit-overflow-scrolling: touch; touch-action: pan-y; }

/* 璁剧疆椤碉細淇濇寔鐜版湁鎺т欢鍜屼笟鍔′簨浠讹紝鍙敤鍒嗙粍涓庡眰绾ч檷浣庨暱鍒楄〃鐨勯槄璇昏礋鎷呫€?*/
.settings-shell {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 2px 0 14px;
	container-type: inline-size;
}
.settings-sheet-head {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	grid-template-areas: "title close" "player player";
	align-items: center;
	gap: 9px 10px;
}
.settings-sheet-head .sheet-title { grid-area: title; min-width: 0; }
.settings-sheet-head > .x { grid-area: close; }
.settings-bgm-player {
	grid-area: player;
	width: 100%;
	max-width: 300px;
	box-sizing: border-box;
	justify-self: end;
	display: grid;
	grid-template-columns: minmax(72px, 1fr) 56px 32px 32px;
	align-items: center;
	gap: 4px;
	min-width: 0;
	padding: 0;
}
.settings-bgm-icon {
	width: 52px;
	height: 20px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 3px;
}
.settings-bgm-icon i {
	width: 3px;
	height: 4px;
	flex: 0 0 auto;
	background: var(--px-amber);
	border-radius: 2px;
}
.settings-bgm-icon i:nth-child(2),
.settings-bgm-icon i:nth-child(8) { height: 7px; }
.settings-bgm-icon i:nth-child(3),
.settings-bgm-icon i:nth-child(7) { height: 10px; }
.settings-bgm-icon i:nth-child(4),
.settings-bgm-icon i:nth-child(6) { height: 14px; }
.settings-bgm-icon i:nth-child(5) { height: 17px; }
.settings-bgm-player.is-playing .settings-bgm-icon i {
	animation: settings-bgm-wave 0.85s ease-in-out infinite alternate;
}
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(1),
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(9) { animation-delay: 0s; }
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(2),
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(8) { animation-delay: 0.1s; }
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(3),
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(7) { animation-delay: 0.2s; }
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(4),
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(6) { animation-delay: 0.3s; }
.settings-bgm-player.is-playing .settings-bgm-icon i:nth-child(5) { animation-delay: 0.2s; }
@keyframes settings-bgm-wave {
	from { transform: scaleY(0.55); opacity: 0.65; }
	to { transform: scaleY(1); opacity: 1; }
}
.settings-bgm-copy {
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 1px;
}
.settings-bgm-copy small,
.settings-bgm-copy b {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.settings-bgm-copy small { color: var(--fg-dim); font-size: 10px; line-height: 1.2; }
.settings-bgm-copy b { color: var(--fg); font-size: 12px; line-height: 1.2; font-weight: 600; }
.settings-bgm-control {
	width: 32px;
	height: 32px;
	padding: 0;
	display: grid;
	place-items: center;
	color: var(--px-amber);
	font-size: 17px;
	line-height: 1;
	background: transparent;
	border: 1px solid transparent;
	border-radius: 50%;
}
.settings-bgm-control.settings-bgm-next {
	color: var(--fg-dim);
}
.settings-bgm-control:disabled { opacity: 0.38; }
.settings-bgm-control:active { transform: translateY(1px); }
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
@media (min-width: 720px) {
	.settings-sheet-head {
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas: "title player close";
		gap: 12px;
	}
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
/* 鍦ㄧ嚎浜烘暟锛?026-10-23锛? 璁剧疆涓€绾ч〉搴曢儴銆佸紑婧愯鍙叆鍙ｄ笅鏂?*/
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
	/* 鏁板瓧杈撳叆 (涓撴敞/浼戞伅鍒嗛挓) 蹇呴』涓€骞惰鐩? 鍙啓 text/password 鏃?number 浼氳惤鍥?	   WebView 鐨勯粯璁ょ櫧搴? 鍦ㄦ繁鑹查潰鏉夸笂闈炲父鍒虹溂. 灏栬鏁板瓧绠ご鍚屾牱鐢?appearance 鍘绘帀. */
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
	/* select 鍚屾牱瑕佹樉寮忚鐩? 鍘熷厛鍙粰浜?.field select, 鑰岀暘鑼?璁剧疆/鎮诞绐楅潰鏉跨殑涓嬫媺閮藉湪
	   .settings-row > .row-inline 閲? 娌¤瑕嗙洊 鈫?钀藉洖 WebView 榛樿鐧藉簳銆?	   (鎵€鏈?.row-inline 閮藉湪 .settings-row 鍐? 鏁呰繖涓€鏉″嵆鍙叏瑕嗙洊) */
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
/* 璁剧疆椤归噷鐨?寮€鍏宠": 鏍囩鍦ㄥ乏, 鍕鹃€夋鍦ㄥ彸 */
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

/* 璁板繂绯荤粺灞曠ず */
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
	/* 鏉ユ簮鏍囨敞 (B2): 銆屼綘澹版槑銆? 涓€х伆; 銆屾垜鎺ㄦ柇銆? 鍋忎富棰樿壊, 鎻愮ず"杩欐潯鏄ス鐨勭寽娴? */
	&.src { background: var(--px-panel-2); color: var(--px-grey); border-color: var(--px-line); }
	&.src.inferred { background: var(--px-cyan-deep); color: var(--px-cyan); border-color: var(--px-cyan-dim); }
}
.mem-text { flex: 1 1 auto; min-width: 110px; font-size: 13px; color: var(--fg); line-height: 1.45; word-break: break-all; }
/* 鐩爣/鍥哄畾 鍥炬爣涓嶅啀鍗犳爣绛句綅, 鐩存帴璐村湪姝ｆ枃琛岄 (B: 鏍囩澶贡 鈫?涓€琛屽彧鐣欎竴涓富鏍囩) */
.mem-ico { margin-right: 2px; }
.mem-group { margin-top: 2px; }
/* P4: 鍧楄鍥?鈥斺€?涓€涓潡 = 涓€娆″巻鍙叉€荤粨瑕嗙洊鐨勪竴娈靛璇? 鍧楁爣棰樻槸"涓婚 路 鏃堕棿娈?路 N 鏉″璇?,
   鍧楀唴灏忚妭鏍囬闄嶄竴绾?(鏇村皬鏇存贰), 璁?鍧?> 绫诲瀷"鐨勫眰绾т竴鐪肩湅寰楀嚭鏉?*/
/* 宸叉敹璧?/ 宸插垹闄?(2026-09-28): 涓庛€屽凡浣滃簾銆嶅悓涓€濂楁姌鍙犳牱寮? 浣嗗悇鑷竴涓?class 渚夸簬鍖哄垎涓?E2E 鏂█ */
.mem-faded > summary { cursor: pointer; color: var(--px-grey); }
.mem-deleted > summary { cursor: pointer; color: var(--px-grey); }
/* 璁板繂浼樺寲 (鏁寸悊浼樺寲): 涓€涓皬鑺?+ 涓変釜鎸夐挳 + 鍙睍寮€鐨勭ず渚嬮瑙?*/
.mem-tune { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-tune-btns { margin-top: 2px; }
/* 璁板繂璇婃柇 (P1): 涓庛€岃蹇嗕紭鍖栥€嶅悓涓€濂楁姌鍙犳牱寮? 鍗曠嫭涓€涓?class 渚夸簬鍖哄垎涓?E2E 鏂█ */
.mem-diag { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-diag-btns { margin-top: 2px; }
/* A3 (2026-10-08): 璁板繂鍋ュ悍 + 娉ㄥ叆鏄庣粏 鈥斺€?涓?.mem-diag 鍚屼竴濂楄瑙夊彛寰?*/
.mem-health { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--ui-line-c-soft); }
.mem-inject-hits { margin: 4px 0 2px; }
.mem-inject-hit {
	display: flex; align-items: baseline; gap: 6px;
	padding: 2px 0; font-size: 12px; line-height: 1.45;
}
.mem-inject-score {
	flex: none; min-width: 34px; text-align: right;
	color: var(--accent); font-variant-numeric: tabular-nums;
}
.mem-inject-type { flex: none; color: var(--fg-dim); font-size: 11px; }
.mem-inject-text { flex: 1 1 auto; min-width: 0; overflow-wrap: break-word; }
.mem-inject-kw {
	flex: none; padding: 0 4px; border-radius: 4px; font-size: 10px;
	color: var(--accent); background: rgba(127, 212, 230, 0.12);
}
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
/* P4: 銆屽緟鏁寸悊 N 鏉°€?銆岀珛鍗虫暣鐞嗐€嶁€斺€?璁?杩樻病杩涜蹇?鍙 (瀹炴椂閫氶亾榛樿鍏充箣鍚庣殑蹇呰浜や唬) */
.mem-pending {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	font-size: 11px; color: var(--px-grey);
	padding: 2px 0 4px;
}
/* A: 鏁寸悊鍙嶉**灏卞湴**璐村湪鎸夐挳涓嬮潰 (浠ュ墠鍐欏湪闈㈡澘鏈€搴曢儴, 鐢ㄦ埛鐪嬩笉鍒?鈬?浠ヤ负"鐐逛簡娌＄敤") */
.mem-org-msg {
	margin: 0 0 2px;
	padding: 3px 0 0;
	border-top: 1px dashed var(--ui-line-c-soft);
}
/* C: 璁板繂搴撻《閮ㄧ粺璁¤ + 绌烘€佹彁绀?+ 搴曢儴鎿嶄綔鍖?*/
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
/* 宸蹭綔搴熺殑璁板繂 (B1): 鐏颁竴妗?+ 鍐呭鍒掓帀, 涓€鐪肩湅鍑?杩欐槸鐣欐。, 涓嶆槸鐜板湪鐢熸晥鐨? */
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
/* 璁板繂搴撻〉 (鐙珛椤? */
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
/* 涓€绾ц缃〉閲岀殑"璁板繂搴?鍏ュ彛鎸夐挳 (涓変唤鍒楄〃宸叉敹杩涗簩绾ц彍鍗? 杩欓噷鍙暀鍏ュ彛) */
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

.sheet.diary-sheet { max-width: 620px; max-height: 88vh; margin-inline: auto; }
.sheet.diary-sheet .sheet-body { padding-top: 4px; }
@media (max-width: 430px) { .sheet.diary-sheet { padding: 16px 15px 20px; } }
/* ---------------- 鏂版墜寮曞 ----------------
 * 2026-10-01 閲嶅仛锛堢敤鎴凤細銆屽唴瀹逛笉鍙橈紝AI 鍛冲お澶с€嶏級銆傚師鏉ョ殑闀跨浉鏄€氱敤寮圭獥涓変欢濂楋細
 * 40px 澶?emoji + 灞呬腑鏍囬 + 鍦嗙偣鍒嗛〉 + 鏁村娓愬彉鎸夐挳锛屾鏂囪繕濂椾簡涓憡璀︽ 鈥斺€?鎹㈡垚**濂归€掓潵鐨勪竴寮犱究绛?*锛? * 宸﹀榻愩€佺焊鎰熷簳鑹层€侀《閮ㄤ竴灏忔潯鑳跺甫銆佹爣棰樹笅涓€閬撶煭寮鸿皟绾裤€佹鏂囧乏渚х粏鑹叉潯锛堟浛浠ｅ憡璀︽锛夈€? * 鍒嗛〉鏀规垚缁嗘í鏉°€佹寜閽敹鎴愬彸涓嬭灏忚嵂涓搞€?*鏂囨涓庢暟鎹竴瀛楁湭鏀?*锛岀被鍚嶄篃淇濇寔鍘熸牱锛堟祴璇?鎺㈤拡鎸夌被鍚嶆壘鍏冪礌锛夈€? * 涓ょ涓婚閮藉悆 --ui-* / --px-* 鍙橀噺锛屾墍浠ュ儚绱犻涓嬩緷鐒舵槸纭竟鐩磋銆?*/
.intro-mask {
	position: fixed; inset: 0;
	background: rgba(2, 6, 23, 0.72);
	backdrop-filter: blur(var(--ui-blur-mask));
	-webkit-backdrop-filter: blur(var(--ui-blur-mask));
	z-index: 80;                 /* 楂樹簬闈㈡澘(20)涓庤皟璇曡(70) */
	display: flex; align-items: flex-end; justify-content: center;
}
.intro {
	position: relative;
	width: ~"min(100% - 26px, 396px)";   // 鈿?蹇呴』甯?~"" 杞箟锛歀ESS 浼氬湪缂栬瘧鏈熸妸 100% - 26px 绠楁垚 74%锛屽脊绐楀氨姣旇璁＄獎 55px锛?026-10-02 淇級
	margin: 0 0 calc(30px + env(safe-area-inset-bottom));
	background: linear-gradient(180deg, #131f36 0%, var(--px-panel) 62%);
	border: var(--ui-line-w) solid var(--ui-line-c-soft);
	border-radius: var(--ui-radius-panel);
	box-shadow: inset 0 2px 0 0 var(--ui-inner-glow), var(--ui-shadow);
	padding: 20px 20px 16px;
	transform: rotate(-0.45deg);        /* 鍍忛殢鎵嬫斁鍦ㄦ涓婄殑涓€寮犵焊 */
	transition: transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1);
}
/* 椤堕儴涓€灏忔潯鑳跺甫 (绾楗? */
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
/* 鏍囬涓嬮潰閭ｉ亾鐭己璋冪嚎 */
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
	/* 璇皵鍙綋鐜板湪宸﹁壊鏉′笂 鈥斺€?涓嶅啀鎶婃暣娈垫鏂囨覆鏌撴垚鍛婅妗?*/
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
/* 2026-10-02 淇帓鐗堬細鍘熸潵鐨?.intro-foot 鏄?*鍗曡 flex**锛堝垎椤垫潯 + 4 涓寜閽悓涓€琛岋級锛?   鑰?.intro-btns .mini 鏄?white-space: nowrap锛?*涓嶄細缂?*锛夈€傚洓涓寜閽?+ 鍒嗛〉鏉℃尋涓€琛岃 鈮?13px锛?   鑰屽脊绐楀唴瀹瑰鍙湁 325px锛?96 瀹界獥鍙ｏ級/ 225px锛?60 瀹界獥鍙ｏ級/ 195px锛?20 瀹界獥鍙ｏ級
   鈬?鏁磋婧㈠嚭寮圭獥銆佸彸渚т袱涓寜閽灞忓箷瑁佹帀锛堢敤鎴锋埅鍥撅細鍙湅寰楀埌銆岄」鐩粨搴撱€嶅拰鍗婁釜銆屽姞鍏?Steam 鎰库€︺€嶏級銆?   鏀规垚涓よ锛氳烦杞被涓€琛岋紙.intro-links锛屽彲鎹㈣锛? 鍒嗛〉/缈婚〉涓€琛岋紙.intro-nav锛屽彲鎹㈣锛夈€?   娉ㄦ剰锛?*涓嶇敤 position: fixed** 鈥斺€?閭ｄ細鎶婃寜閽Щ鍑哄脊绐椼€?   锛堝彟娉細`.intro` 鐨?`width: min(100% - 26px, 396px)` 琚?LESS 鍦ㄧ紪璇戞湡绠楁垚浜?`min(74%, 396px)`锛?     寮圭獥瀹炴祴鍙湁瑙嗗彛瀹界殑 74% 鈥斺€?瑙?浜ゆ帴鏂囨。 搂21.1 鐨勮鏄庯紝鏈疆**娌″姩**瀹冦€傦級 */
.intro-foot {
	display: flex; flex-direction: column; gap: 10px;
	margin-top: 16px; padding-top: 12px;
	border-top: 1px dashed var(--ui-line-c-soft);
}
/* 璺宠浆绫绘寜閽紙椤圭洰浠撳簱 / Steam 鎰挎湜鍗曪級鍗曠嫭涓€琛岋細绐勫睆鏀句笉涓嬪氨鎹㈣锛屼换浣曟墜鏈哄搴﹂兘涓嶆孩鍑恒€佷笉琚 */
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
/* 鍒嗛〉鏉?+ 銆屼笂涓€姝?/ 寮€濮嬩娇鐢ㄣ€嶏細涔熷厑璁告崲琛岋紙鏋佺獎灞忔椂鎸夐挳鏁翠綋鎺夊埌涓嬩竴琛岋紝涓嶆í鍚戞孩鍑猴級 */
.intro-nav {
	display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px;
}
/* 鍒嗛〉: 缁嗘í鏉?(鍘熸潵鏄渾鐐? 鈥斺€?浠嶆槸 4 涓?<i>, e2e 鎸夋暟閲忔柇瑷€ */
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

/* ---------------- 妯″瀷鎺堟潈楠岃瘉锛堢瓟棰橀棬锛?026-10-01锛?026-10-02 涓ゅ鍏辩敤锛?----------------
   缁撴瀯鐓у弬鑰冨浘锛堟爣棰?璇存槑/闂/杈撳叆/鍙栨秷路楠岃瘉/搴曢儴鎻愮ず锛夛紝閰嶈壊璧版湰搴旂敤鐨勬煍鍜岄鍙橀噺銆?   鍙湁涓€浠芥牱寮忥細 clone / model 涓や釜鍔ㄤ綔閮芥寕 .gate-mask + .gate锛堝悇鑷澶栧甫涓€涓涔夌被鍚嶏紝
   鍏嬮殕閭ｄ釜 .clone-gate 淇濇寔鍘熸牱缁?probe-clone-gate 鎵惧厓绱狅級銆?*/
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
/* 瀛樺偍鑷缁撴灉 (绛夊, 鍙í鍚戞粴鍔? 鐩存帴鎴浘缁欏紑鍙戣€呯湅) */
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
		&::before { content: "鈻?"; }
	}
	&[open] summary::before { content: "鈻?"; }
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
	/* 鍍忕礌鍑歌捣 (缃戦〉鐗?.pixel-btn-primary 鍚屾閰嶆柟):
	   浜笂宸?+ 鏆椾笅鍙?+ 纭姇褰? 鎸変笅鏃跺弽杞?鈥斺€?杩欐槸"鑳戒竴鐪肩湅鍑烘崲浜嗛鏍?鐨勫叧閿?*/
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

/* 鑳屾櫙闊充箰寮€鍏?(璁剧疆闈㈡澘鍐呰仈) */
.bgm-toggle {
	display: flex;
	align-items: center;
	gap: 6px;
	color: var(--fg);
	font-size: 13px;
}

/* ---------------- 鍏充簬 / 闅愮 / 寮€婧愯鍙〉锛?026-10-02 鐢ㄦ埛瑕佹眰锛?----------------
   澶嶇敤鐜版湁 sheet 闈㈡澘锛堝叆鍙ｅ湪璁剧疆闈㈡澘搴曢儴锛夛紝鎵€浠ヨ繖閲屽彧鏈夊唴瀹规帓鐗堬細
   閰嶈壊涓€寰嬫部鐢ㄧ幇鏈?--fg-* / --px-* / --accent 鍙橀噺锛屼笉鏂伴€犻鑹层€?*/
/* 璁剧疆闈㈡澘搴曢儴鐨勫叆鍙ｈ锛?mini 鎾戞弧涓€琛岋紝瑙嗚涓婅窡涓€鎺?.btn 鍖哄垎寮€锛?*/
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
/* 灏忚妭鏍囬锛氫笌銆岃蹇嗙郴缁熴€嶇殑 .mem-sec-title 鍚屼竴濂楀彛寰勶紙accent 灏忓瓧 + 铏氱嚎涓嬭竟锛?*/
.about-h {
	font-size: 12px; font-weight: 600; color: var(--accent);
	letter-spacing: 0.6px; padding-bottom: 4px;
	border-bottom: 1px dashed var(--ui-line-c-soft);
}
.about-p { margin: 0; font-size: 13px; line-height: 1.75; color: var(--fg-2); }
.about-p b { color: var(--fg); }
/* 瀛椾綋璁稿彲鍏ㄦ枃锛?026-10-16锛? 榛樿鏀惰捣锛屽睍寮€鍚庣粰涓€鍧楀彲婊氬姩鐨勭瓑瀹芥枃鏈尯 */
.about-license {
	margin-top: 4px;
	summary {
		font-size: 12.5px; color: var(--accent); cursor: pointer;
		list-style: none; padding: 3px 0;
		&::-webkit-details-marker { display: none; }
		&::before { content: "鈻?"; }
	}
	&[open] summary::before { content: "鈻?"; }
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
/* 鈿?鍗歌浇璀﹀憡锛氭部鐢ㄥ紩瀵奸〉 warn 閭ｆ。鎻忚竟鑹诧紝鍙仛涓€鏉″乏鑹叉潯 + 娣″簳锛屼笉鎶㈢溂浣嗙湅寰楄 */
.about-warn {
	margin: 0; padding: 8px 10px;
	font-size: 13px; line-height: 1.7; color: #fbbf24;
	background: rgba(120, 53, 15, 0.28);
	border-left: 2px solid rgba(240, 190, 120, 0.5);
	border-radius: var(--ui-radius-ctl);
	b { color: #fde68a; }
}
/* 澶栭摼涓€寰嬭蛋鍘熺敓 openExternal锛堜笉鍦?WebView 閲岃烦璧帮級鈥斺€?闀跨浉鏄鍐呴摼鎺ワ紝涓嶆槸鎸夐挳銆?   inline-block + max-width:100% + break-all: 闀?URL 鍦ㄧ獎灞忎笂鑷繁鎶樿, 涓嶄細鎶婇潰鏉挎拺瀹姐€?*/
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

/* 鍦ㄧ嚎浜烘暟锛?026-10-21锛? 銆岀増鏈€嶅潡涓嬬殑涓€琛岀姸鎬?+ 涓€涓姸鎬佺偣锛坙ive/stale/off锛?*/
.about-presence { display: flex; align-items: center; gap: 6px; }
.about-presence b { color: var(--fg); font-variant-numeric: tabular-nums; }
.about-presence-dot {
	width: 7px; height: 7px; border-radius: 50%;
	background: #64748b; flex: none;
	&.live { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.7); }
	&.stale { background: #fbbf24; }
	&.off { background: #64748b; }
}
.about-presence-hint { font-size: 12px; color: var(--fg-dim); }

/* 鐢卞竷灞€鐘舵€佸尯鍒嗘í绔栧睆锛岄敭鐩樼缉鐭鍙ｆ椂涓嶅垏鎹㈡í灞忔牱寮忋€?*/
.stage-root:not(.portrait) {
	/* 鑱婂ぉ闈㈡澘: 涓嶅啀鍏ㄥ (妯睆涓嬩細妯洊鏁翠釜妯″瀷), 闈犲彸闄愬; 绔栧悜绌洪棿灏?鈫?闈㈡澘鏀鹃珮 */
	.chat-panel {
		left: auto;
		right: calc(10px + env(safe-area-inset-right, 0px));
		width: min(52vw, 520px);
		max-height: 80vh;
	}
	/* 搴曢儴 dock: 鍐呭闄愬灞呬腑 (50%-280px 涓や晶鏀惰繘), 涓嶈鎸夐挳妯法鏁翠釜灞忓箷; 鍏煎鍒樻捣宸﹀彸瀹夊叏鍖?*/
	.dock {
		bottom: calc(8px + env(safe-area-inset-bottom, 0px));
		padding-left: 7px;
		padding-right: 7px;
	}
	/* 搴曢儴寮瑰眰 (妯″瀷/鍔ㄤ綔/琛ㄦ儏/鏃ヨ/璁板繂搴?璁剧疆): 闄愬灞呬腑, 楂樺害鏀惧 */
	.sheet-mask {
		justify-content: center;
	}
	.sheet {
		width: min(64vw, 680px);
		max-height: 90vh;
	}
	/* 椤舵爮: 琛ュ乏鍙冲畨鍏ㄥ尯 (妯睆鍒樻捣/鎸栧瓟) */
	.topbar {
		padding-left: calc(14px + env(safe-area-inset-left, 0px));
		padding-right: calc(14px + env(safe-area-inset-right, 0px));
	}
}

/* 绔栧睆锛氬父椹昏緭鍏ユ爮 + 鐭巻鍙诧紱鏂版皵娉℃部鐢ㄥ師妯＄硦 token锛岀嫭绔嬭皟鏁村～鍏呫€?*/
.portrait {
	.chat-panel {
		left: calc(12px + env(safe-area-inset-left, 0px));
		right: calc(12px + env(safe-area-inset-right, 0px));
		bottom: calc(10px + env(safe-area-inset-bottom, 0px) + var(--chat-keyboard-inset, 0px));
		max-height: none;
		overflow: visible;
		border-radius: 20px;
	}
	.history-toggle {
		align-self: center;
		width: 64px;
		height: 30px;
		flex-shrink: 0;
		display: grid;
		place-items: center;
		border-radius: 12px 12px 0 0;
		background: rgba(20, 32, 48, 0.22);
		color: rgba(238, 245, 255, 0.8);
		svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform 0.18s ease; }
		svg.expanded { transform: rotate(180deg); }
	}
	.chat-history {
		flex: 0 1 auto;
		height: min(28vh, 260px);
		border: 1px solid rgba(228, 241, 255, 0.14);
		border-radius: 16px 16px 0 0;
		background: rgba(15, 26, 42, 0.22);
	}
	.chat-head { flex-shrink: 0; padding: 5px 10px; gap: 6px; }
	.chat-title { font-size: 12px; margin-right: auto; }
	.chat-head .x { font-size: 11px; padding: 4px 6px; }
	.chat-msgs { min-height: 0; padding: 8px 10px; gap: 6px; }
	.chat-input {
		flex-shrink: 0;
		align-items: stretch;
		padding: 8px;
		gap: 6px;
		border: 1px solid rgba(228, 241, 255, 0.18);
		border-radius: 18px;
		background: rgba(22, 34, 51, 0.3);
		backdrop-filter: blur(var(--ui-blur-chip));
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
	}
	.chat-input input {
		min-height: 42px;
		padding: 8px 10px;
		box-sizing: border-box;
		border-color: rgba(228, 241, 255, 0.14);
		border-radius: 12px;
		background: rgba(16, 27, 44, 0.2);
	}
	.chat-input .send { padding: 0 12px; border-radius: 12px; font-size: 13px; }
	.composer-more { display: flex; flex-shrink: 0; }
	.composer-more > .chat-tool { width: 40px; padding: 0; border-radius: 12px; font-size: 23px; font-weight: 300; background: rgba(228, 241, 255, 0.09); }
	.composer-more .image-menu { left: auto; right: 0; z-index: 3; }
	.image-menu button:disabled { opacity: 0.4; }
	.image-preview-row { padding: 5px 10px; background: rgba(16, 27, 44, 0.24); border-radius: 12px 12px 0 0; }
	.image-preview { width: 36px; height: 36px; }
	.image-preview-meta { font-size: 11px; }
	.queue-hint { padding: 4px 10px; }
	.portrait-reply {
		position: absolute;
		left: 50%;
		bottom: calc(100% + clamp(24px, 8vh, 72px));
		transform: translateX(-50%);
		width: max-content;
		max-width: calc(100% - 24px);
		padding: 10px 16px;
		border: 1px solid rgba(235, 245, 255, 0.16);
		border-radius: 18px;
		background: rgba(24, 35, 51, 0.3);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		backdrop-filter: blur(var(--ui-blur-bubble));
		color: #f2f6fc;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
		font-size: 14px;
		line-height: 1.6;
		text-align: center;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		line-break: strict;
	}
	.portrait-reply-text { display: block; max-width: min(80vw, 520px); }
	.portrait-reply.ai-enter-from, .portrait-reply.ai-leave-to { transform: translateX(-50%) translateY(8px); }
	.side-rail-mask { position: absolute; inset: 0; z-index: 15; }
	.side-rail {
		position: absolute;
		right: calc(12px + env(safe-area-inset-right, 0px));
		top: clamp(70px, 18vh, 150px);
		z-index: 16;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
		filter: drop-shadow(0 8px 18px rgba(0, 0, 0, 0.18));
	}
	.side-rail-handle {
		width: 38px;
		height: 38px;
		border: 1px solid rgba(228, 241, 255, 0.13);
		border-radius: 14px;
		background: rgba(24, 39, 53, 0.46);
		backdrop-filter: blur(var(--ui-blur-chip));
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
		color: rgba(238, 245, 255, 0.82);
		transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
		&:active { transform: scale(0.96); }
		&:focus-visible { outline: 2px solid rgba(167, 226, 255, 0.75); outline-offset: 2px; }
		svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
		svg.expanded { transform: rotate(180deg); }
	}
	.side-rail-items {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 5px;
		max-height: calc(100vh - 228px);
		overflow-y: auto;
		touch-action: pan-y;
		border: 1px solid rgba(215, 241, 241, 0.12);
		border-radius: 17px;
		background: linear-gradient(160deg, rgba(28, 44, 55, 0.72), rgba(12, 23, 38, 0.66));
		backdrop-filter: blur(var(--ui-blur-chip));
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}
	.side-action {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: flex-start;
		gap: 8px;
		width: 80px;
		min-height: 44px;
		padding: 9px 10px;
		border: 1px solid transparent;
		border-radius: 12px;
		color: rgba(238, 248, 252, 0.88);
		font-size: 12px;
		letter-spacing: 0.04em;
		transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
		img { width: 18px; height: 18px; flex-shrink: 0; opacity: 0.85; }
		&:hover, &:focus-visible { background: rgba(173, 225, 255, 0.1); border-color: rgba(196, 232, 255, 0.16); outline: none; }
		&:active { background: rgba(173, 225, 255, 0.17); transform: scale(0.96); }
	}
	&.keyboard-open {
		.chat-history { height: min(28vh, 120px); }
		.portrait-reply { bottom: calc(100% + 8px); }
		.side-rail { top: calc(12px + env(safe-area-inset-top, 0px)); }
		.side-rail-items { max-height: calc(100vh - 160px); }
	}
}
</style>
