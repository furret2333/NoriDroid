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

    /**
     * 额外放行的**子资源/接口主机**（2026-10-15 修「下载官方人设」的 Failed to fetch）。
     *
     * 背景：`shouldInterceptRequest` 会把不在白名单里的请求一律回成空响应，
     * 于是前端 `fetch()` 只会抛 `TypeError: Failed to fetch`。
     * 模型 / 音效 / 背景音乐都走**原生桥**（Kotlin 直接发请求），所以一直没暴露；
     * 人设文案是唯一在 WebView 里直接 fetch 的静态资源，就踩到了。
     *
     * ⚠ 2026-10-16 改成**基础域名**（含子域）：这个静态托管的子域换过三次
     *   （fc39e5fc / 59f06f75 / cb04914b），写死单个子域时换源就会再踩一次同样的坑。
     *
     * 口径：这里只放行**子资源**；页面导航（shouldOverrideUrlLoading / onPageStarted）
     * 仍然只允许 appassets，不会因为这份清单把外部网页放进来。
     * ⚠ 与 `services/chat/index.ts` 的 `PERSONA_DOWNLOAD_URL` 必须落在这些域里
     *   （`verify-apk-bundle` 有断言盯着）。
     */
    private val ALLOWED_SUBRESOURCE_DOMAINS = setOf(
        "pinme.dev",
        // 2026-10-23: 在线人数心跳优先走 WebView fetch（Chromium 网络栈）；
        // 原生 HttpURLConnection 到 Supabase 会 connection reset，浏览器却正常。
        // 只放行本项目这一个 Supabase host，不加整段 supabase.co。
        "xztoatqtnlehfauywosa.supabase.co",
    )

    /** 主机是否属于上面那份域名（精确匹配或子域） */
    private fun domainAllowed(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return ALLOWED_SUBRESOURCE_DOMAINS.any { h == it || h.endsWith(".$it") }
    }

    /** 子资源请求是否放行：appassets 本身 + 上面那份显式域名（一律要求 https） */
    fun isAllowedSubresource(url: String): Boolean = isAllowedSubresource(Uri.parse(url))

    fun isAllowedSubresource(uri: Uri): Boolean =
        isAllowedUrl(uri) || (uri.scheme.equals("https", ignoreCase = true) && domainAllowed(uri.host))

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
