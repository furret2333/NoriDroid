









export type TouchType = "tap" | "swipe" | "frenzy"

export interface TouchArea {
	id: string
	name: string
	type: TouchType
	/** 允许触发的手势；缺失时按 both 读取旧配置。 */
	gesture?: "tap" | "swipe" | "both"
	
	x: number
	y: number
	w: number
	h: number
	image: string
	/** 旧版区域说明字段。保留以兼容已有配置，新的 AI 反应要求写入 reactionPrompt。 */
	prompt: string
	/** 希望 AI 对触摸作出的反应；不再拼进部位名称。 */
	reactionPrompt?: string
}

export interface ModelRenderConfig {
	scale: number
	posX: number
	posY: number
}

export interface ModelTouchConfig {
	version: number
	enabled: boolean
	render: ModelRenderConfig
	name: string
	image: string
	touches: TouchArea[]
}

const defaultConfig = (): ModelTouchConfig => ({
	version: 2,
	enabled: true,
	render: {scale: 1.0, posX: 0.0, posY: 0.0},
	name: "",
	image: "",
	touches: [],
})

const uid = () => `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`


export const loadTouchConfig = (modelId: string): ModelTouchConfig => {
	try {
		const raw = localStorage.getItem(`l2d_touch_${modelId}`)
		if (!raw) return defaultConfig()
		const data = JSON.parse(raw)
		return {
			...defaultConfig(),
			...data,
			render: {...defaultConfig().render, ...data?.render},
			enabled: data?.enabled !== false,
			touches: Array.isArray(data?.touches) ? data.touches.filter((touch: Partial<TouchArea> | null) =>
				touch && typeof touch.id === "string" && [touch.x, touch.y, touch.w, touch.h].every(Number.isFinite)
			).map((touch: TouchArea) => ({
				...touch,
				gesture: touch.gesture === "tap" || touch.gesture === "swipe" ? touch.gesture : "both",
				// 旧 prompt 是区域描述，保留原文，不当成新的 AI 反应指令。
				reactionPrompt: typeof touch.reactionPrompt === "string" ? touch.reactionPrompt : "",
			})) : [],
		}
	} catch {
		return defaultConfig()
	}
}


export const saveTouchConfig = (modelId: string, cfg: ModelTouchConfig): boolean => {
	try {
		localStorage.setItem(`l2d_touch_${modelId}`, JSON.stringify({...cfg, version: 2}))
		return true
	} catch { return false }
}


export const newTouchId = (): string => uid()

export {defaultConfig}
