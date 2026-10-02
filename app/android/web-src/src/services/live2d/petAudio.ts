/**
 * 抚摸音效 —— 从 NoriOS 网页版 headPat 移植的**实时合成音**。完全没有音频素材。
 *
 * ## 出处（可复查）
 * `os.inori.ai/assets/NormalApp-Co7fh3WA.js`:
 *   - `EK()` @2429859 建图   - `x8e()` @2430905 参数刷新   - `ky()/RK()/AK()/w8e()/S8e()` @2432638
 *   - 常量 @2432760: `xK=3 m8e=1.4 g8e=0.03 wK=0.06 E4=140 El=0.05 SK=1200 MK=3200 TK=5200 Py=350 w2=8000 v8e=11500 b8e=2`
 *
 * ## 信号链（与网页版逐节点一致）
 * ```
 * 白噪声(2s 循环)
 *   ├─ highpass 1200 → highpass 3200 → peaking 5200(Q0.9,+4dB) → lowpass 8000..11500 ─┐
 *   └─ lowpass 350 → lowpass 350 → gain(soundBodyGain) ───────────────────────────────┴→ strokeGain → master
 * ```
 * 所有频点 × `soundFreqScale(0.4)`（实际落在约 480/1280/2080/140Hz）。
 * 听感 = **沙沙的摩擦声**；摸得越快 → `strokeGain` 越大、lowpass 开得越大 → 越响越亮。
 * 松手后 `HOLD_MS(140ms)` 内没有新采样就自动归零，避免"手指停了声音还在"。
 *
 * ## 三处触发（与网页版同名函数一一对应）
 * | 本模块 | 网页版 | 时机 | 包络 |
 * |---|---|---|---|
 * | `petAudioTouch()` | `w8e()` | 刚摸到 | (0.35, 亮度 0.15) |
 * | `petAudioStroke(v)` | `RK(v)` | 抚摸中随速度 | `(|v|/满量程)^1.4` |
 * | `petAudioComplete()` | `S8e()` | 完成一次 | (0.5) → 150ms 后 (0.4) |
 * | `petAudioRelease()` | `AK()` | 松手/丢命中 | 归零 |
 *
 * ## 与网页版的**有意偏差**（都在常量旁写了原因）
 * 1. **音量基数**：网页版 `master = soundLevel = 0.05`，但它接在自己的 sfx 总线上，总线增益未知；
 *    这里直接用可听电平 `PET_AUDIO_LEVEL`，再乘 App 现有的 `sfxVolume` 设置。
 *    实机觉得偏大/偏小，只需改这一个常量。
 * 2. **速度单位**：网页版速度是"头宽/秒"（其 Debug 面板标签写明），阈值的量纲跟头宽绑死。
 *    安卓端 Head 包围盒要等 Phase 3a 的探测钩子才有，所以这里用**屏幕短边**当单位，
 *    `PET_AUDIO_VX_FULL` 是按"头宽 ≈ 短边的 1/3"换算出来的饱和值。
 * 3. 网页版的 `Ert()`（剧本用的正弦"呼噜"驱动）**没有移植** —— 安卓端没有调用方，
 *    不做死代码（真要用了再加）。
 */

import {getSfxVolume} from "../sfx"

/** master 电平基数（**不是**网页版的 0.05，原因见文件头偏差 1）；最终还会乘 sfxVolume */
export const PET_AUDIO_LEVEL = 0.35
/** 速度满量程（单位: 屏幕短边/秒）。网页版是 3 头宽/秒 ≈ 1 短边/秒 */
export const PET_AUDIO_VX_FULL = 1.0
/** "刚摸到"的包络（= 网页版 w8e 的 ky(0.35, 0.15)） */
export const PET_TOUCH_PROFILE = {level: 0.35, brightness: 0.15}
/** "完成一次"的包络（= 网页版 S8e 的 ky(0.5, 0.3)） */
export const PET_COMPLETE_PROFILE = {level: 0.5, brightness: 0.3}
/** "完成一次"第二段的延迟与包络（= 网页版 setTimeout(..., 150) 后的 ky(0.4, 0.3)） */
export const PET_COMPLETE_ECHO_MS = 150
export const PET_COMPLETE_ECHO_PROFILE = {level: 0.4, brightness: 0.3}

/* ---- 网页版常量（名字沿用原变量名, 方便对照） ---- */
const FREQ_SCALE = 0.4      // soundFreqScale
const BODY_GAIN = 0.5       // soundBodyGain
const NOISE_SECONDS = 2     // b8e
const HP1 = 1200            // SK
const HP2 = 3200            // MK
const PEAK = 5200           // TK
const BODY_LP = 350         // Py
const LP_MIN = 8000         // w2
const LP_MAX = 11500        // v8e
const ATTACK_TAU = 0.03     // g8e
const RELEASE_TAU = 0.06    // wK
const PARAM_TAU = 0.05      // El
const HOLD_MS = 140         // E4
const VX_EXP = 1.4          // m8e

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const nowMs = (): number => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now())

/**
 * **纯函数**：抚摸速度 → 音效包络。抽出来是为了让 Node 门禁能断言
 * （真去建 AudioContext 的话，headless/Node 都测不了）。
 * 与网页版 `RK()` 等价：`e = clamp(|v|/xK)`，`level = e^1.4`，`brightness = e`。
 *
 * **与网页版的偏差**：非有限输入（NaN / ±Infinity）**一律静音**。
 * 网页版这里没有守卫 —— NaN 会一路算成 NaN 直接喂给 `setTargetAtTime`（节点行为未定义），
 * `Infinity` 则夹到满音量。宁可静音，也不要一个"卡在最大声"的节点。
 */
export const petSoundProfile = (vx: number): {level: number; brightness: number} => {
	if (!Number.isFinite(vx)) return {level: 0, brightness: 0}
	const e = clamp01(Math.abs(vx) / PET_AUDIO_VX_FULL)
	return {level: Math.pow(e, VX_EXP), brightness: e}
}

interface PetAudioGraph {
	ctx: AudioContext
	source: AudioBufferSourceNode
	hp1: BiquadFilterNode
	hp2: BiquadFilterNode
	peak: BiquadFilterNode
	lowpass: BiquadFilterNode
	bodyLpA: BiquadFilterNode
	bodyLpB: BiquadFilterNode
	bodyGain: GainNode
	strokeGain: GainNode
	master: GainNode
}

let graph: PetAudioGraph | null = null
let holdTimer = 0
let echoTimer = 0
let lastKickAt = 0

const ensureGraph = (): PetAudioGraph | null => {
	if (graph) return graph
	try {
		const w = window as unknown as {AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext}
		const Ctor = w.AudioContext || w.webkitAudioContext
		if (!Ctor) return null
		const ctx = new Ctor()
		// 白噪声缓冲 (网页版: createBuffer + Math.random()*2-1, loop=true)
		const len = Math.max(1, Math.floor(NOISE_SECONDS * ctx.sampleRate))
		const buf = ctx.createBuffer(1, len, ctx.sampleRate)
		const data = buf.getChannelData(0)
		for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1
		const source = ctx.createBufferSource()
		source.buffer = buf
		source.loop = true
		const bq = (type: BiquadFilterType, freq: number, q: number, gain?: number): BiquadFilterNode => {
			const f = ctx.createBiquadFilter()
			f.type = type
			f.frequency.value = freq * FREQ_SCALE
			f.Q.value = q
			if (gain !== undefined) f.gain.value = gain
			return f
		}
		// Q=-3 是网页版原值 (负 Q = 削弱谐振), 照抄
		const hp1 = bq("highpass", HP1, -3)
		const hp2 = bq("highpass", HP2, -3)
		const peak = bq("peaking", PEAK, 0.9, 4)
		const lowpass = bq("lowpass", LP_MAX, -3)
		const bodyLpA = bq("lowpass", BODY_LP, -3)
		const bodyLpB = bq("lowpass", BODY_LP, -3)
		const bodyGain = ctx.createGain()
		bodyGain.gain.value = BODY_GAIN
		const strokeGain = ctx.createGain()
		strokeGain.gain.value = 0      // 包络起点: 静音
		const master = ctx.createGain()
		master.gain.value = 0

		source.connect(hp1)
		hp1.connect(hp2)
		hp2.connect(peak)
		peak.connect(lowpass)
		lowpass.connect(strokeGain)
		source.connect(bodyLpA)
		bodyLpA.connect(bodyLpB)
		bodyLpB.connect(bodyGain)
		bodyGain.connect(strokeGain)
		strokeGain.connect(master)
		master.connect(ctx.destination)
		source.start()

		graph = {ctx, source, hp1, hp2, peak, lowpass, bodyLpA, bodyLpB, bodyGain, strokeGain, master}
		return graph
	} catch {
		return null
	}
}

/** 每次 kick 都重读一遍设置与参数 (对应网页版 x8e), 所以改音量/改档位**立即生效** */
const applyParams = (g: PetAudioGraph, brightness: number): void => {
	const now = g.ctx.currentTime
	const t = PARAM_TAU
	const vol = PET_AUDIO_LEVEL * clamp01(getSfxVolume())
	g.master.gain.setTargetAtTime(vol, now, t)
	g.bodyGain.gain.setTargetAtTime(BODY_GAIN, now, t)
	g.hp1.frequency.setTargetAtTime(HP1 * FREQ_SCALE, now, t)
	g.hp2.frequency.setTargetAtTime(HP2 * FREQ_SCALE, now, t)
	g.peak.frequency.setTargetAtTime(PEAK * FREQ_SCALE, now, t)
	g.bodyLpA.frequency.setTargetAtTime(BODY_LP * FREQ_SCALE, now, t)
	g.bodyLpB.frequency.setTargetAtTime(BODY_LP * FREQ_SCALE, now, t)
	g.lowpass.frequency.setTargetAtTime((LP_MIN + (LP_MAX - LP_MIN) * clamp01(brightness)) * FREQ_SCALE, now, t)
}

/**
 * 在**真实用户手势**里解锁 AudioContext。
 * 必须由 pointerdown 这类手势调用：抚摸音是在 pointermove / setTimeout 里触发的，
 * 那两处不算用户手势，此时 new AudioContext() 会停在 suspended、resume() 也会被拒。
 * 所以按下先 prime 一次（已建好则只做 resume）。
 */
export const petAudioPrime = (): void => {
	const g = ensureGraph()
	if (!g) return
	try {
		if (g.ctx.state === "suspended") void g.ctx.resume().catch(() => { /* 忽略 */ })
	} catch { /* 忽略 */ }
}

const scheduleHoldRelease = (g: PetAudioGraph): void => {
	if (holdTimer) window.clearTimeout(holdTimer)
	holdTimer = window.setTimeout(() => {
		holdTimer = 0
		// 这段时间里没有新的 kick 才归零 (对应网页版 y8e 的 time 检查)
		if (nowMs() - lastKickAt < HOLD_MS - 10) return
		try { g.strokeGain.gain.setTargetAtTime(0, g.ctx.currentTime, RELEASE_TAU) } catch { /* 忽略 */ }
	}, HOLD_MS)
}

const kick = (level: number, brightness: number): void => {
	const g = ensureGraph()
	if (!g) return
	if (clamp01(getSfxVolume()) <= 0) { petAudioRelease(); return }   // 静音: 不推节点
	if (g.ctx.state === "suspended") void g.ctx.resume().catch(() => { /* 忽略 */ })
	applyParams(g, brightness)
	try {
		g.strokeGain.gain.setTargetAtTime(clamp01(level), g.ctx.currentTime, ATTACK_TAU)
		lastKickAt = nowMs()
		scheduleHoldRelease(g)
	} catch { /* 忽略 */ }
}

/** 刚摸到 (网页版 w8e) */
export const petAudioTouch = (): void => kick(PET_TOUCH_PROFILE.level, PET_TOUCH_PROFILE.brightness)

/** 抚摸中：速度越大越响越亮 (网页版 RK) */
export const petAudioStroke = (velocityX: number): void => {
	const p = petSoundProfile(velocityX)
	kick(p.level, p.brightness)
}

/** 完成一次 (网页版 S8e): 双段 */
export const petAudioComplete = (): void => {
	kick(PET_COMPLETE_PROFILE.level, PET_COMPLETE_PROFILE.brightness)
	if (echoTimer) window.clearTimeout(echoTimer)
	echoTimer = window.setTimeout(() => {
		echoTimer = 0
		kick(PET_COMPLETE_ECHO_PROFILE.level, PET_COMPLETE_ECHO_PROFILE.brightness)
	}, PET_COMPLETE_ECHO_MS)
}

/** 松手 / 命中丢失 (网页版 AK): 归零并取消待触发的回声。
 *  `keepEcho = true` 用于"手指移出头区"这种**中途**离开 —— 完成音的第二段(150ms 后)是奖励的尾巴,
 *  让它放完; 抬手/卸载才全清。 */
export const petAudioRelease = (keepEcho = false): void => {
	if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = 0 }
	if (!keepEcho && echoTimer) { window.clearTimeout(echoTimer); echoTimer = 0 }
	const g = graph
	if (!g) return
	try { g.strokeGain.gain.setTargetAtTime(0, g.ctx.currentTime, RELEASE_TAU) } catch { /* 忽略 */ }
}

/** 卸载时调用：停掉噪声源并关掉上下文（否则退出页面后噪声源仍占着音频焦点） */export const disposePetAudio = (): void => {
	const g = graph
	graph = null
	if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = 0 }
	if (echoTimer) { window.clearTimeout(echoTimer); echoTimer = 0 }
	if (!g) return
	try { g.source.stop() } catch { /* 忽略 */ }
	try { void g.ctx.close() } catch { /* 忽略 */ }
}

/** 调试/E2E 用：图是否已建、当前生效音量（不建图，纯读） */
export const petAudioState = (): {ready: boolean; volume: number; level: number} => ({
	ready: !!graph,
	volume: clamp01(getSfxVolume()),
	level: PET_AUDIO_LEVEL,
})
