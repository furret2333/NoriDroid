



import {fetchLive2dList} from "../gateway/api"

interface InstalledMeta {
	id: string
	entryBase: string
}

interface Bridge {
	download: (id: string) => void
	listInstalled: () => string
}


declare global {
	interface Window {
		NoriBridge?: Bridge
		__noriModelRes?: (json: string) => void
	}
}

const bridge = (): Bridge => {
	if (!window.NoriBridge) throw new Error("模型下载组件不可用 (NoriBridge 未注入)")
	return window.NoriBridge
}

const parseBridgeResult = (raw: string): {ok: boolean; entryBase?: string; message?: string} => {
	try {
		return JSON.parse(raw)
	} catch {
		return {ok: false, message: "原生返回格式错误"}
	}
}

export const fetchModelList = async (): Promise<{id: string; name: string}[]> => {
	const body = await fetchLive2dList()
	return body.list ?? []
}

export const listInstalled = async (): Promise<InstalledMeta[]> => {
	try {
		const raw = bridge().listInstalled()
		const arr = JSON.parse(raw)
		if (!Array.isArray(arr)) return []
		return arr.filter((i) => i && typeof i.id === "string" && typeof i.entryBase === "string")
	} catch {
		return []
	}
}

export const getInstalled = async (id: string): Promise<InstalledMeta | undefined> =>
	(await listInstalled()).find((i) => i.id === id)


/**
 * 模型下载超时 (ms)。
 * 注意: window.__noriModelRes 要等**整个下载结束**才被原生回调, 所以这个值必须覆盖
 * "下载 + 解压"全程 (模型包 12~15MB), 不能套用元数据类桥调用的 12s。
 * 取 120s: 正常网络都够; 真挂住了也不会永久卡死。
 */
const DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * 确保模型已安装并返回入口基名。
 *
 * 两个防线 (原先都没有):
 *  ① 回调占用检查: window.__noriModelRes 是**全局单例**, 并发第二次赋值会覆盖第一次的
 *    回调 → 第一个 Promise 永不 settle (之后再也切不了模型, 只能重启 App)。
 *     已经有一次下载在途时, 直接拒绝后一次, 而不是静默覆盖。
 *  ② 超时: 原生不回包 (进程重启/网络挂起/原生异常) 时, Promise 永不 settle → UI 永久转圈。
 */
export const ensureModel = async (id: string, _name: string): Promise<string> => {
	const cached = await getInstalled(id)
	if (cached?.entryBase) return cached.entryBase
	if (!window.NoriBridge) throw new Error("NoriBridge 未注入")
	if (window.__noriModelRes) throw new Error("已有模型正在下载, 请稍候")
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (fn: () => void): void => {
			if (settled) return
			settled = true
			const w = window as unknown as {__noriModelRes?: (json: string) => void}
			if (w.__noriModelRes === onRes) delete w.__noriModelRes
			clearTimeout(timer)
			fn()
		}
		const onRes = (json: string): void => {
			const res = parseBridgeResult(json)
			if (res.ok && res.entryBase) finish(() => resolve(res.entryBase as string))
			else finish(() => reject(new Error(res.message || "模型下载失败")))
		}
		window.__noriModelRes = onRes
		const timer = setTimeout(
			() => finish(() => reject(new Error("模型下载超时（网络不稳定或原生下载器无响应）"))),
			DOWNLOAD_TIMEOUT_MS,
		)
		try {
			bridge().download(id)
		} catch (e: unknown) {
			finish(() => reject(e instanceof Error ? e : new Error(String(e))))
		}
	})
}


export const modelsDirOf = (): string | null => "models"