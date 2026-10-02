/**
 * Live2D 模型来源 (静态托管, 无 API)。
 *
 * 背景: 原网关 `api.elake.top/deeper` 已失效 (SSL 握手失败), 而它只服务模型这一件事
 * (`/live2d/list` 列表 / `/resource/download_url` 下载地址 / `/live2d/cover` 封面)。
 * 现在模型托管在一个 IPFS 静态目录上, 只有文件、没有接口, 因此:
 *   - 列表 → 写死在下面 (模型有增减时需改这里并重新打包)
 *   - 下载地址 → 由 Kotlin 侧直接拼 `<id>.zip` (见 ModelBridge.getDownloadUrl)
 *   - 封面   → 直接拼 `<id>-cover.webp`
 *
 * 好处: 少一个服务器依赖。原来网关一挂, 连模型列表都出不来。
 */

/** 模型静态托管根地址 */
const MODEL_BASE = "https://fc39e5fc.pinme.dev"

export interface Live2dSummary {
	id: string
	name: string
}

/** 可下载的模型清单 (与托管目录里的同名文件对应: `<id>.zip` / `<id>-cover.webp`) */
const MODELS: Live2dSummary[] = [
	{id: "ARGNori", name: "ARGNori"},
	{id: "Nori", name: "Nori"},
]

/** 模型列表。保留 async 签名, 调用方 (`modelStore.fetchModelList`) 无需改动。
 *  不再联网: 静态主机没有 list 接口, 且写死可避免"网关挂了列表就空"的老问题。 */
export const fetchLive2dList = async (): Promise<{list: Live2dSummary[]}> => ({list: MODELS})

/** 模型封面图地址 (`<id>-cover.webp`) */
export const coverUrl = (id: string): string =>
	`${MODEL_BASE}/${encodeURIComponent(id)}-cover.webp`
