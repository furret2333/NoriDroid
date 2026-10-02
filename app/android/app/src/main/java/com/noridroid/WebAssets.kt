package com.noridroid

import android.content.res.AssetManager
import android.webkit.WebResourceResponse

/**
 * 静态资源兜底服务 (FloatService / FloatBubbleActivity 共用):
 * appassets.androidplatform.net/assets/xxx → assets/web/xxx, 带 CORS 头 + 正确 MIME.
 * ES Module 需要 https Origin (file:// 会被浏览器禁止) 和正确的 text/javascript MIME,
 * 否则跨 chunk 引用会被浏览器拒绝.
 */
object WebAssets {

    fun serve(assets: AssetManager, url: String): WebResourceResponse? {
        return try {
            val marker = "/assets/"
            val idx = url.indexOf(marker)
            if (idx < 0) return null
            val rel = url.substring(idx + marker.length)
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
