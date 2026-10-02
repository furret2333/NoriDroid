package com.noridroid

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream


class ModelBridge(private val appContext: Context) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private val ioExecutor: ExecutorService = Executors.newCachedThreadPool()

    fun attach(v: WebView) { webView = v }

    companion object {
        /** 模型静态托管根地址 (IPFS 目录, 无 API)。
         *  原网关 api.elake.top 已失效 (SSL 握手失败), 且该网关只服务模型这一件事,
         *  故整体改为静态直链: `<id>.zip` / `<id>-cover.webp` 两个约定路径。 */
        private const val MODEL_BASE = "https://fc39e5fc.pinme.dev"
        const val MODELS_ROOT = "models"
        // 每个模型 id 一把静态锁: download 跑在多线程池上, 同 id 并发会在 deleteRecursively()
        // 与写文件之间互踩, 损坏模型目录且无自愈. 静态 = 跨实例生效 (主界面/悬浮窗各有
        // 一个 ModelBridge 实例, 各带自己的线程池).
        private val downloadLocks = java.util.concurrent.ConcurrentHashMap<String, Any>()
    }

    private fun lockFor(id: String): Any = downloadLocks.computeIfAbsent(id) { Any() }

    val modelsDir: File

        get() = File(appContext.filesDir, MODELS_ROOT)


    @android.webkit.JavascriptInterface
    fun download(id: String) {
        ioExecutor.execute {
            val json = synchronized(lockFor(id)) {
                runCatching {
                    val modelDir = modelsDir.resolve(safeSegment(id))
                    val existing = findEntryBase(modelDir)
                    if (existing != null) return@runCatching ok(existing)
                    val url = getDownloadUrl(id)
                    ok(installZipStreaming(id, url))
                }.getOrElse { e ->
                    err(e.message ?: "下载失败")
                }
            }
            postToJs("__noriModelRes", json)
        }
    }

    private fun postToJs(fn: String, json: String) {
        mainHandler.post {
            runCatching {
                webView?.evaluateJavascript("window.$fn && window.$fn(${JSONObject.quote(json)})", null)
            }
        }
    }

    
    @android.webkit.JavascriptInterface
    fun listInstalled(): String {
        val arr = JSONArray()
        runCatching {
            val root = modelsDir
            root.listFiles()?.forEach { dir ->
                dir.takeIf { it.isDirectory }?.let { d ->
                    findEntryBase(d)?.let { base ->
                        arr.put(JSONObject().put("id", d.name).put("entryBase", base))
                    }
                }
            }
        }
        return arr.toString()
    }

    
    @android.webkit.JavascriptInterface
    fun delete(id: String) {
        runCatching { modelsDir.resolve(safeSegment(id)).deleteRecursively() }
    }

    
    private fun findEntryBase(modelDir: File): String? {
        if (!modelDir.isDirectory) return null
        return modelDir.walkTopDown()
            .filter { it.isFile && it.name.endsWith("model3.json", true) }
            .mapNotNull { f ->
                val rel = f.toRelativeString(modelDir).replace('\\', '/')
                val parts = rel.split("/").filter { it.isNotEmpty() }
                val base = when {
                    parts.isEmpty()-> null
                    parts.size <= 1 -> f.name.removeSuffix(".model3.json")
                    else -> parts[0]
                }
                base?.takeIf { it.isNotBlank() }
            }
            .minByOrNull { depthOfEntry(modelDir, it) }
    }

    
    private fun depthOfEntry(modelDir: File, entryBase: String): Int {
        val dir = modelDir.resolve(safeSegment(entryBase))
        val f = File(dir, "$entryBase.model3.json")
        return if (f.exists()) 0 else 1
    }

    /** 模型 zip 直链。原来是"先请求网关拿下发地址"再下载, 现在静态托管直接拼:
     *  少一次网络往返、少一个失败点 (网关挂了就完全下不了模型)。 */
    private fun getDownloadUrl(id: String): String = "$MODEL_BASE/${encode(id)}.zip"

    /** 流式下载到文件: 边下边写 (64KB 缓冲), 不再把整个 zip 读进内存 ——
     *  原实现 readBytes() 峰值内存 ≈ 包体大小, 几十 MB 的模型包在大内存占用时直接 OOM */
    private fun downloadToFile(url: String, out: File) {
        val u = URL(url)
        val conn = (u.openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
        }
        try {
            if (conn.responseCode !in 200..299) throw RuntimeException("下载 ZIP 失败: HTTP ${conn.responseCode}")
            val outPath = out.canonicalFile.toPath()
            conn.inputStream.use { input ->
                java.nio.file.Files.newOutputStream(outPath).use { fos ->
                    input.copyTo(fos, 64 * 1024)
                    fos.flush()
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 流式安装: zip 落到临时文件后分两遍处理 (只扫条目名 / 逐条流式解压),
     * 任何条目都不整包进内存; 解压先进暂存目录, 成功后再换名 —— 解压中途失败
     * 不会像旧实现那样留下"删了旧的、新的只有一半"的损坏目录.
     */
    private fun installZipStreaming(id: String, url: String): String {
        val target = modelsDir.resolve(safeSegment(id))
        val tmp = File(modelsDir, "${safeSegment(id)}.download.tmp")
        val staging = File(modelsDir, "${safeSegment(id)}.install.tmp")
        try {
            modelsDir.mkdirs()
            downloadToFile(url, tmp)
            // 第一遍: 只读条目名, 选最浅的 .model3.json 作入口 (与旧实现同一选择规则)
            var best: String? = null
            ZipInputStream(tmp.inputStream().buffered()).use { zip ->
                var e = zip.nextEntry
                while (e != null) {
                    if (!e.isDirectory) {
                        val name = sanitize(e.name)
                        if (name.endsWith(".model3.json", true)) {
                            val cur = best
                            if (cur == null || name.count { c -> c == '/' } < cur.count { c -> c == '/' }) best = name
                        }
                    }
                    zip.closeEntry()
                    e = zip.nextEntry
                }
            }
            val bestPath = best ?: throw RuntimeException("模型包缺少 .model3.json")
            val parts = bestPath.split("/")
            val entryBase = parts[parts.size - 1].removeSuffix(".model3.json").trim()
            if (entryBase.isEmpty()) throw RuntimeException("模型入口名无效")
            val prefix = parts.dropLast(1).joinToString("/")
            // 第二遍: 流式解压到暂存目录 (逐条边读边写, 不缓存条目内容)
            if (staging.exists()) staging.deleteRecursively()
            staging.mkdirs()
            val outBase = File(staging, safeSegment(entryBase))
            ZipInputStream(tmp.inputStream().buffered()).use { zip ->
                var e = zip.nextEntry
                while (e != null) {
                    if (!e.isDirectory) {
                        var rel = sanitize(e.name)
                        if (prefix.isNotEmpty() && rel.startsWith("$prefix/")) rel = rel.removePrefix("$prefix/")
                        val out = outBase.resolve(sanitizeSegments(rel, entryBase))
                        out.parentFile?.mkdirs()
                        if (isSafeChild(out, staging)) {
                            FileOutputStream(out).use { o -> zip.copyTo(o) }
                        }
                    }
                    zip.closeEntry()
                    e = zip.nextEntry
                }
            }
            if (staging.walkTopDown().none { it.isFile }) throw RuntimeException("模型包为空或解压失败")
            // 原子换名: 校验通过才动现有目录
            if (target.exists()) target.deleteRecursively()
            if (!staging.renameTo(target)) {
                staging.copyRecursively(target, overwrite = true)
                staging.deleteRecursively()
            }
            return entryBase
        } finally {
            tmp.delete()
            staging.deleteRecursively()
        }
    }

    private fun isSafeChild(f: File, root: File): Boolean {
        return try {
            f.canonicalFile.toPath().startsWith(root.canonicalFile.toPath())
        } catch (_: Exception) {
            false
        }
    }

    private fun sanitizeSegments(rel: String, entryBase: String): String {
        val segs = rel.split("/").filter { it.isNotEmpty() && it != "." && it != ".." }
        return sanitize(segs.joinToString("/"))
    }

    private fun sanitize(raw: String): String = raw.replace("\\", "/")

    private fun safeSegment(s: String): String = s.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private fun encode(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    private fun ok(entryBase: String): String =
        JSONObject().put("ok", true).put("entryBase", entryBase).toString()

    private fun err(msg: String): String =
        JSONObject().put("ok", false).put("message", msg).toString()
}
