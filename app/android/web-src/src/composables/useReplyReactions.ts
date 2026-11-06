import type {Ref} from "vue"
import type {createLive2D, MotionGroup} from "../services/live2d"
import {
	detectExpressionByRules,
	detectMotionByRules,
	resolveMarkerEmotion as resolveMarkerEmotionShared,
	resolveMarkerMotion as resolveMarkerMotionShared,
	pickNeutralIdle,
} from "../services/live2d/markerRules"
import {scheduleReturnToNeutral} from "../services/live2d/motionReturn"
import {petExpressionHoldsLayer} from "../services/live2d/petExpression"

export interface ReplyReactionsOptions {
	l2d: ReturnType<typeof createLive2D>
	ready: Readonly<Ref<boolean>>
	motions: Readonly<Ref<MotionGroup[]>>
	expressions: Readonly<Ref<string[]>>
}

/** Reply-driven model reactions; App keeps model loading and lifecycle wiring. */
export const useReplyReactions = ({l2d, ready, motions, expressions}: ReplyReactionsOptions) => {
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

	return {playMarkerEmotion, playMarkerMotion, returnToNeutral, pickMotionByKeyword, triggerEmotion}
}
