import {ref} from "vue"
import {
	isStorageReady, requestStoragePermission, getStorageDir, probePublicFiles,
	hasAllFilesAccess, requestAllFilesAccess,
} from "../services/chat"

export interface StorageAccessOptions {
	notify: (text: string, ms?: number) => void
	scheduleDiary: () => void
	refreshPomodoroStorage: () => void
}

/** Public-storage state and actions; refresh and initial reads are invoked by App. */
export const useStorageAccess = (options: StorageAccessOptions) => {
	const {notify: triggerBubble, scheduleDiary, refreshPomodoroStorage} = options
	const storageReady = ref(false)
	const storagePath = ref("Download/NoriDroid")

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

	const grantStorage = () => requestStoragePermission()

	const refreshStorage = () => {
		if (!document.hidden) { window.dispatchEvent(new Event("nori-diary-updated")); scheduleDiary() }
		storageReady.value = isStorageReady()
		// 「所有文件访问权限」可能是在系统设置里刚授予的 —— 每次回前台都刷新一次,
		// 用户授权返回后设置页的「已授权 ✓」会立刻变绿, 不用重开面板。
		allFilesAccess.value = hasAllFilesAccess()
		if (!document.hidden) {
			refreshPomodoroStorage()
		}
	}

	const initializeStorage = () => {
		storagePath.value = getStorageDir()
		storageReady.value = isStorageReady()
		allFilesAccess.value = hasAllFilesAccess()
	}

	return {
		storageReady, storagePath, storageProbeMsg, allFilesAccess,
		doRequestAllFiles, doStorageProbe, grantStorage, refreshStorage, initializeStorage,
	}
}
