package com.noridroid

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.File

/**
 * 本地音频资源路径处理器: 从应用私有目录 (filesDir/bgm) 提供音频流.
 * 页面 (https://appassets.androidplatform.net) 以 /bgm-local/<文件名> 访问,
 * 音频由 ChatBridge 的下载器从远程拉取解压后落在这里.
 * 它只做"root 目录内的音频文件 → WebResourceResponse"这一件事, 所以音效也用同一个:
 * /sfx-local/ 指到 filesDir/sfx (见 MainActivity 注册处与 ChatBridge.downloadSfx).
 */
class BgmPathHandler(private val root: File) : WebViewAssetLoader.PathHandler {

    override fun handle(path: String): WebResourceResponse? {
        return try {
            val rel = path.removePrefix("/")
            if (rel.isEmpty() || rel.contains("..")) return null
            val f = File(root, rel)
            if (!f.isFile || f.length() <= 0L) return null
            // 防穿越: canonical 路径必须仍在根目录内
            if (!f.canonicalPath.startsWith(root.canonicalPath)) return null
            val mime = when {
                rel.endsWith(".mp3", true) -> "audio/mpeg"
                rel.endsWith(".m4a", true) -> "audio/mp4"
                rel.endsWith(".ogg", true) -> "audio/ogg"
                rel.endsWith(".wav", true) -> "audio/wav"
                else -> return null
            }
            WebResourceResponse(mime, null, f.inputStream())
        } catch (_: Exception) {
            null
        }
    }
}
