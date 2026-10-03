package com.noridroid

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/**
 * 静态资源兜底服务 (FloatService / FloatBubbleActivity 共用):
 * appassets.androidplatform.net/assets/xxx → assets/web/xxx, 带 CORS 头 + 正确 MIME.
 * ES Module 需要 https Origin (file:// 会被浏览器禁止) 和正确的 text/javascript MIME,
 * 否则跨 chunk 引用会被浏览器拒绝.
 */
object WebAssets {

    const val APP_HOST = "appassets.androidplatform.net"

    fun isAllowedUrl(url: String): Boolean = isAllowedUrl(Uri.parse(url))

    fun isAllowedUrl(uri: Uri): Boolean =
        uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(APP_HOST, ignoreCase = true)

    fun blockedResponse(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

    fun serve(assets: AssetManager, url: String): WebResourceResponse? {
        return try {
            val uri = Uri.parse(url)
            if (!isAllowedUrl(uri)) return null
            val path = uri.path ?: return null
            val marker = "/assets/"
            if (!path.startsWith(marker)) return null
            val rel = path.removePrefix(marker)
            if (rel.isBlank()) return null
            val stream = assets.open("web/$rel")
            WebResourceResponse(
                mimeFor(rel), "utf-8", 200, "OK",
                mapOf(
                    "Access-Control-Allow-Origin" to "*",
                    "Cache-Control" to "no-cache",
                ),
                stream,
            )
        } catch (_: Exception) {
            null
        }
    }

    fun mimeFor(name: String): String = when {
        name.endsWith(".js", true) || name.endsWith(".mjs", true) -> "text/javascript"
        name.endsWith(".css", true) -> "text/css"
        name.endsWith(".html", true) -> "text/html"
        name.endsWith(".json", true) -> "application/json"
        name.endsWith(".png", true) -> "image/png"
        name.endsWith(".webp", true) -> "image/webp"
        name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
        name.endsWith(".gif", true) -> "image/gif"
        name.endsWith(".woff2", true) -> "font/woff2"
        else -> "application/octet-stream"
    }
}
