package com.noridroid

import android.app.Activity
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.ZipInputStream


class ChatBridge(private val appContext: Context) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private val ioExecutor: ExecutorService = Executors.newCachedThreadPool()

    private val cr get() = appContext.contentResolver

    fun attach(v: WebView) { webView = v; PomodoroEngine.ensure(appContext); PomodoroEngine.attach(v) }

    // ---- 番茄钟 (计时本体在 PomodoroEngine; 同步返回状态 JSON) ----

    @android.webkit.JavascriptInterface
    fun pomoStart(focusMin: Int, breakMin: Int, autoBreak: Boolean): String =
        PomodoroEngine.start(appContext, focusMin, breakMin, autoBreak)

    @android.webkit.JavascriptInterface
    fun pomoStartCountUp(): String = PomodoroEngine.startCountUp(appContext)

    @android.webkit.JavascriptInterface
    fun pomoPause(): String = PomodoroEngine.pause(appContext)

    @android.webkit.JavascriptInterface
    fun pomoResume(): String = PomodoroEngine.resume(appContext)

    /** 放弃/结束: 返回带 endedPhase + elapsedMs 的状态 */
    @android.webkit.JavascriptInterface
    fun pomoStop(): String = PomodoroEngine.stop(appContext)

    @android.webkit.JavascriptInterface
    fun pomoState(): String = PomodoroEngine.state(appContext)

    /** 完成通知需要 POST_NOTIFICATIONS(API33+): 从主界面发起时顺带请求一次 */
    @android.webkit.JavascriptInterface
    fun pomoRequestNotify() {
        mainHandler.post {
            runCatching {
                val act = appContext as? android.app.Activity ?: return@post
                if (Build.VERSION.SDK_INT >= 33 &&
                    act.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                ) {
                    act.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1002)
                }
            }
        }
    }

    @android.webkit.JavascriptInterface
    fun isStorageReady(): Boolean {
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return true
        return appContext.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    
    @android.webkit.JavascriptInterface
    fun requestStoragePermission() {
        mainHandler.post {
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                (appContext as? Activity)?.requestPermissions(
                    arrayOf(
                        android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
                        android.Manifest.permission.READ_EXTERNAL_STORAGE
                    ),
                    1001
                )
            }
        }
    }

    
    @android.webkit.JavascriptInterface
    fun getStorageDir(): String = "Download/NoriDroid"

    

    /** 本应用在公共下载目录下的子目录 (媒体库里 RELATIVE_PATH 带结尾斜杠) */
    private fun ownRelativePath(): String = "${Environment.DIRECTORY_DOWNLOADS}/NoriDroid"

    private fun isOwnPath(rp: String?): Boolean =
        rp != null && rp.trimEnd('/').equals(ownRelativePath(), ignoreCase = true)

    /* ---------------- 「所有文件访问权限」(MANAGE_EXTERNAL_STORAGE) ----------------
     * ## 为什么必须靠它 (2026-09-26 实机自检的结论, 不是推测)
     * 用户截图里的自检输出:
     *   chat.json   磁盘上存在: 是(5436 字节)  可直读: 否  MediaStore 可见: 否
     *   memory.json 磁盘上存在: 是(2512 字节)  可直读: 否  MediaStore 可见: 否
     *   目录 /storage/emulated/11/Download/NoriDroid 存在=true 可读=true  目录内容: []
     * 即: **文件还在, 但 MediaStore 看不到 (行不属于本应用) + File 直读被分区存储挡住**。
     * Android 11+ 起 `/sdcard/Download` 下"别的应用写的文件"对本应用既不可见也不可读,
     * 光靠 READ_EXTERNAL_STORAGE / READ_MEDIA_* 都拿不到 (那些只覆盖媒体类型)。
     * 非 root 机器上唯一真正能读到它们的办法就是 MANAGE_EXTERNAL_STORAGE。
     * (对个人自用 App 完全可行; 上架商店会被拒, 但这个项目不上架。)
     */
    private fun hasAllFilesAccess(): Boolean = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        else false
    }.getOrDefault(false)

    private fun useDirectFile(): Boolean = hasAllFilesAccess()

    /** 是否已获得「所有文件访问权限」(前端用来显示状态/决定要不要引导去授权) */
    @android.webkit.JavascriptInterface
    fun hasAllFilesAccessJs(): Boolean = hasAllFilesAccess()

    /** 跳到系统的「所有文件访问权限」设置页 (授予后返回本应用即可生效) */
    @android.webkit.JavascriptInterface
    fun requestAllFilesAccess() {
        mainHandler.post {
            runCatching {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return@runCatching
                val it = android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    android.net.Uri.parse("package:${appContext.packageName}")
                ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                appContext.startActivity(it)
            }.onFailure {
                // 个别 ROM 没有带包名的那个 Action → 退回"所有文件访问"总列表
                runCatching {
                    appContext.startActivity(
                        android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
            }
        }
    }

    /** 用 File 直读/直写公共目录 (仅在拿到「所有文件访问权限」后调用; 见 useDirectFile) */
    private fun readFileDirect(n: String): String = runCatching {
        val f = File(legacyDir(), n)
        if (f.isFile) f.readText() else ""
    }.getOrDefault("")

    private fun writeFileDirect(n: String, content: String): String = runCatching {
        val dir = legacyDir()
        if (!dir.isDirectory) dir.mkdirs()
        // 先写临时文件再改名: 中途被杀不会留下半截 JSON (MediaStore 那条路是覆盖写, 没有这个保护)
        val tmp = File(dir, "$n.tmp")
        tmp.writeText(content)
        val dst = File(dir, n)
        if (dst.exists()) dst.delete()
        if (!tmp.renameTo(dst)) { tmp.copyTo(dst, overwrite = true); tmp.delete() }
        "ok"
    }.getOrElse { "err:${it.message}" }

    /** 公共下载目录的**真实路径** (直读用; 与 ownRelativePath 指向同一处, 只是 File 形式) */
    @Suppress("DEPRECATION")
    private fun publicDownloadsDir(): File =
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)

    /*
     * ---------- 下面这段是"为什么会读不到"的完整记录, 改动前请先读 ----------
     *
     * 数据是用 MediaStore 写进 `Download/NoriDroid/` 的, 而 MediaStore 是**按所有者隔离**的:
     * `query` 只能看到**本应用**写入的行。卸载 / 清除数据 / 换签名重装之后, 磁盘上的文件还在
     * (文件管理器里看得见), 但那些行已不属于当前应用:
     *   · Android 10+ 卸载时通常已把应用自己写入共享存储的文件**一起删掉**;
     *   · 若是用别的包名 (如旧版 DeepER) 或旧签名写的, 行属于**另一个应用**, 本应用查不到;
     *   · 就算是同一包名, 重装后也不再看得到旧实例的行。
     * 结果就是 `findOwnFileUri()` 返回 null → `readFile` 返回空串 → 界面表现为"内容全没了"。
     * (`isStorageReady()` 在 API29+ 恒为 true, 所以界面**不会**提示权限问题, 只会静默读到空。)
     *
     * **实机自检结论 (2026-09-26, 用户 Android 16 截图)**: 光是"MediaStore → File 兜底"**不够** ——
     *   chat.json   磁盘上存在: 是(5436 字节)  可直读: 否  MediaStore 可见: 否
     *   memory.json 磁盘上存在: 是(2512 字节)  可直读: 否  MediaStore 可见: 否
     *   目录 /storage/emulated/11/Download/NoriDroid 存在=true 可读=true  目录内容: []
     * 即两条路都堵死。Android 11+ 对 `/sdcard/Download` 下"别的应用写的文件"既不给 MediaStore 行,
     * 也不给直接 File 读 —— READ_EXTERNAL_STORAGE / READ_MEDIA_* 都覆盖不到非媒体文件。
     *
     * ⇒ 所以最终方案是申请 **MANAGE_EXTERNAL_STORAGE**(所有文件访问权限), 拿到后 read/write
     *   全部走 [readFileDirect] / [writeFileDirect] **直接文件路径**, 绕开 MediaStore 的所有者隔离。
     *   官方文档确认该权限在 Android 16 仍然有效, 且明确授予 direct file path 读写能力
     *   (https://developer.android.com/training/data-storage/manage-all-files, 页面 2026-09-16 更新)。
     *   MediaStore 那条路保留为"没授权时"的退路。
     */

    /**
     * 把"磁盘上有、MediaStore 里没有(或不是本应用的)"文件登记进 Downloads 集合, 返回其 uri。
     * 拿不到就返回 null —— 调用方据此退回"普通新建", 行为与改动前一致, 不会更糟。
     *
     * 为什么要登记而不是以后一直直读: 后续的"原地覆盖写入"要靠 MediaStore 的 uri
     * (`openOutputStream(..., "wt")`); 只读不登记的话每次保存都会新 insert 出一个副本。
     */
    private fun importIntoMediaStore(n: String, text: String, modifiedMs: Long): Uri? = runCatching {
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val cv = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, n)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
            put(MediaStore.MediaColumns.RELATIVE_PATH, ownRelativePath())
            if (modifiedMs > 0) put(MediaStore.MediaColumns.DATE_MODIFIED, modifiedMs / 1000)
        }
        val uri = cr.insert(collection, cv) ?: return null
        cr.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray(Charsets.UTF_8)) } ?: return null
        uri
    }.getOrNull()

    /**
     * 在**本应用自己的目录里**按确切文件名定位那一行; 找不到返回 null。
     *
     * 为什么必须带目录判断 (2026-09-22 实机踩坑):
     *   原实现只按 DISPLAY_NAME 全盘查 + DATE_ADDED DESC 取第一条, 于是会命中**其它目录**
     *   甚至别的应用留下的同名文件; 而 writeFile 拿到它之后无条件 delete ——
     *     · 删到非本应用的行 → SecurityException, 被 runCatching 吞成 "err:" → 界面显示"保存失败"
     *     · 删不掉又照常 insert → MediaStore 自动改名成 `xxx (1).json`, 应用永远读不到,
     *       实测真机上 `Download/NoriDroid/` 已堆积一堆这种垃圾副本
     *   所以定位必须限定 RELATIVE_PATH, 且不再"删了重建"(见 writeFile)。
     */
    private fun findOwnFileUri(name: String): Uri? {
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val sel = "${MediaStore.MediaColumns.DISPLAY_NAME}=?"
        val proj = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.RELATIVE_PATH)
        val cur = cr.query(collection, proj, sel, arrayOf(name), "${MediaStore.MediaColumns.DATE_ADDED} DESC")
        cur.use { c ->
            if (c == null) return null
            val idIdx = c.getColumnIndex(MediaStore.MediaColumns._ID)
            val rpIdx = c.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
            while (c.moveToNext()) {
                val rp = if (rpIdx >= 0) c.getString(rpIdx) else null
                if (isOwnPath(rp)) return ContentUris.withAppendedId(collection, c.getLong(idIdx))
            }
        }
        return null
    }

    @android.webkit.JavascriptInterface
    fun readFile(name: String): String {
        val n = safeName(name)
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // ⓪ 拿到「所有文件访问权限」→ 直接读文件路径。
                //    这条路绕开 MediaStore 的所有者隔离, 是**卸载重装后把旧数据读回来**的唯一办法
                //    (实机自检: 文件在磁盘上, 但 MediaStore 看不到、无权限时也读不到)。
                if (useDirectFile()) {
                    val viaFile = readFileDirect(n)
                    if (viaFile.isNotEmpty()) return viaFile
                }
                // ① 正常路径: 本应用自己的 MediaStore 行
                val uri = findOwnFileUri(n)
                if (uri != null) {
                    val txt = cr.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                    if (txt.isNotEmpty()) return txt
                }
                // ② 兜底: MediaStore 看不到 (卸载重装/别的包名写过/被系统清掉了行) 时直读公共目录
                //    (无「所有文件访问权限」时这一步通常会被系统挡回空串 —— 自检里会如实显示)
                val viaFile = readFileDirect(n)
                if (viaFile.isNotEmpty()) {
                    // 顺手登记回 MediaStore, 之后读写都走正常路径 (失败也不影响本次读取)
                    importIntoMediaStore(n, viaFile, File(legacyDir(), n).lastModified())
                }
                viaFile
            } else {
                val f = File(legacyDir(), n)
                if (f.isFile) f.readText() else ""
            }
        }.getOrElse { "" }
    }

    /** 退出应用时是否应启动悬浮窗 (原生开关标记 或 settings.json 的 floatEnabled) */
    fun shouldStartFloatOnExit(): Boolean {
        return runCatching {
            val prefEnabled = appContext.getSharedPreferences("float_enabled_prefs", Context.MODE_PRIVATE)
                .getBoolean("float_enabled", false)
            val fileEnabled = runCatching {
                val raw = readFile("settings.json")
                if (raw.isBlank()) false
                else JSONObject(raw).optBoolean("floatEnabled", false)
            }.getOrDefault(false)
            (prefEnabled || fileEnabled) &&
                android.provider.Settings.canDrawOverlays(appContext)
        }.getOrDefault(false)
    }

    @android.webkit.JavascriptInterface
    fun writeFile(name: String, content: String): String {
        val n = safeName(name)
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val bytes = content.toByteArray(Charsets.UTF_8)
                // ⓪ 拿到「所有文件访问权限」→ 直接写文件路径 (临时文件 + 改名, 防半截 JSON)。
                //    读也走直读 (见 readFile), 两边同一份文件, 不会再出现"MediaStore 与磁盘两份副本"。
                if (useDirectFile()) return writeFileDirect(n, content)
                // 1) 本应用目录里已有同名文件 → **原地覆盖**
                //    不再"删了重建": 那既可能误删别人的同名行(抛 SecurityException → 表现为"保存失败"),
                //    也会在删不掉时 insert 出 `xxx (1).json` 这种应用永远读不到的垃圾副本。
                val existing = findOwnFileUri(n)
                if (existing != null) {
                    cr.openOutputStream(existing, "wt")?.use { it.write(bytes) } ?: return "err:stream"
                    return "ok"
                }
                // 2) MediaStore 里没有, 但**磁盘上有** (卸载重装 / 别的包名写过 / 行被系统清掉):
                //    先把磁盘内容登记进来, 再原地覆盖 —— 否则会 insert 出 `xxx (1).json`,
                //    从此"每次保存都是新文件, 但读的永远是旧的那行", 与本次用户反馈同源。
                val onDisk = File(legacyDir(), n)
                if (onDisk.isFile && onDisk.canRead()) {
                    val prior = runCatching { onDisk.readText() }.getOrDefault("")
                    val adopted = importIntoMediaStore(n, prior, onDisk.lastModified())
                    if (adopted != null) {
                        cr.openOutputStream(adopted, "wt")?.use { it.write(bytes) } ?: return "err:stream"
                        return "ok"
                    }
                }
                // 3) 都没有 → 新建
                val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                val cv = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, n)
                    put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, ownRelativePath())
                }
                val uri = cr.insert(collection, cv) ?: return "err:insert"
                // 若这个名字已被"本应用看不见的行"占用, MediaStore 会**悄悄改名**成 `xxx (1).json`.
                // 那等于写了个本应用永远读不到的文件, 必须发现并如实报出来 (而不是假装成功)。
                val actual = runCatching {
                    cr.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) c.getString(0) else null
                    }
                }.getOrNull()
                if (actual != null && actual != n) {
                    val fix = ContentValues().apply { put(MediaStore.MediaColumns.DISPLAY_NAME, n) }
                    val renamed = runCatching { cr.update(uri, fix, null, null) > 0 }.getOrDefault(false)
                    if (!renamed) return "err:nameTaken:$actual"
                }
                cr.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: return "err:stream"
                "ok"
            } else {
                if (!isStorageReady()) return "err:perm"
                val dir = legacyDir(); dir.mkdirs()
                File(dir, n).writeText(content)
                "ok"
            }
        }.getOrElse { "err:${it.message}" }
    }

    @android.webkit.JavascriptInterface
    fun appendMemory(text: String): String {
        val cur = readFile(MEMORY_FILE).trim()
        return writeFile(MEMORY_FILE, (if (cur.isEmpty()) "" else "$cur\n") + text.trim())
    }

    @android.webkit.JavascriptInterface
    fun readMemory(): String = readFile(MEMORY_FILE)

    /**
     * **直读可行性探针** (实机自查用, 只读不写): 告诉我"公共目录里的文件到底能不能被读到、为什么"。
     *
     * 为什么需要它: 兜底直读依赖"应用能直接 File 读 Download/NoriDroid/", 这一点在不同
     * Android 版本/厂商 ROM 上并不一致 (Android 11+ 起对 Download 集合有额外限制)。
     * 本机没有真机/模拟器, 只能把结论交给设备——**不做假设**。
     *
     * @return JSON: 该文件在 MediaStore 是否可见 / 磁盘上是否存在 / 是否能读 / 读到多少字节 /
     *         目录是否可列举 / 顺带给出同目录其它文件名 (便于发现 `xxx (1).json` 这类垃圾副本)
     */
    @android.webkit.JavascriptInterface
    fun probePublicFiles(name: String): String {
        val n = safeName(name)
        return runCatching {
            val dir = legacyDir()
            val f = File(dir, n)
            val mediaStoreUri = findOwnFileUri(n)
            var mediaBytes = -1
            if (mediaStoreUri != null) {
                mediaBytes = runCatching {
                    cr.openInputStream(mediaStoreUri)?.use { it.readBytes().size } ?: -1
                }.getOrDefault(-1)
            }
            val listed = runCatching { dir.listFiles()?.map { it.name }?.sorted() ?: emptyList<String>() }
                .getOrDefault(emptyList())
            JSONObject()
                .put("sdk", Build.VERSION.SDK_INT)
                .put("dir", dir.absolutePath)
                .put("dirExists", dir.isDirectory)
                .put("dirReadable", dir.canRead())
                /** 是否已拿到「所有文件访问权限」—— 这一项为 true 时读/写都走文件路径, 数据必定能读回 */
                .put("allFilesAccess", hasAllFilesAccess())
                .put("useDirectFile", useDirectFile())
                .put("inMediaStore", mediaStoreUri != null)
                .put("mediaStoreBytes", mediaBytes)
                .put("onDisk", f.isFile)
                .put("fileReadable", f.canRead())
                .put("fileBytes", if (f.isFile) f.length() else -1)
                .put("fileHead", runCatching { f.readText().take(80) }.getOrDefault(""))
                .put("listed", JSONArray(listed))
                .toString()
        }.getOrElse { "err:${it.message}" }
    }

    private fun legacyDir(): File = File(
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
        "NoriDroid"
    )

    private fun safeName(name: String): String =
        name.replace(Regex("[^A-Za-z0-9._-]"), "_").takeIf { it.isNotBlank() } ?: "data"

    

    @android.webkit.JavascriptInterface
    fun fetchModels(baseUrl: String, apiKey: String) {
        ioExecutor.execute {
            postToJs("__noriModelsRes", fetchModelsSync(baseUrl, apiKey))
        }
    }

    @android.webkit.JavascriptInterface
    fun chat(baseUrl: String, apiKey: String, model: String, messagesJson: String, thinkingMode: String) {
        ioExecutor.execute {
            postToJs("__noriChatRes", chatSync(baseUrl, apiKey, model, messagesJson, thinkingMode))
        }
    }

    
    private val chatToken = AtomicLong(0)

    
    @android.webkit.JavascriptInterface
    fun chatStream(baseUrl: String, apiKey: String, model: String, messagesJson: String, thinkingMode: String) {
        val token = chatToken.incrementAndGet()
        ioExecutor.execute {
            chatStreamSync(token, baseUrl, apiKey, model, messagesJson, thinkingMode)
        }
    }

    
    @android.webkit.JavascriptInterface
    fun chatStop() {
        chatToken.incrementAndGet()
    }

    
    private fun postChat(fn: String, json: String, token: Long) {
        mainHandler.post {
            if (token != chatToken.get()) return@post
            runCatching {
                webView?.evaluateJavascript("window.$fn && window.$fn(${JSONObject.quote(json)})", null)
            }
        }
    }

    
    private fun chatStreamSync(token: Long, baseUrl: String, apiKey: String, model: String, messagesJson: String, thinkingMode: String) {
        try {
            val base = normalizeBase(baseUrl)
            val req = JSONObject()
                .put("model", model)
                .put("messages", JSONArray(messagesJson))
                .put("stream", true)
            // DeepSeek 思考模式: 前端已按"端点含 deepseek"算好三态 (见 web 侧 resolveThinking)。
            // 「关」也要显式传 disabled —— DeepSeek 的默认是**打开**的, 不传等于不生效。
            putThinking(req, thinkingMode)
            val conn = open(base + "/chat/completions", "POST", apiKey, "application/json", req.toString())
            val code = conn.responseCode
            if (code !in 200..299) {
                val msg = runCatching { conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) } }.getOrElse { "" }
                postChat("__noriChatError", JSONObject().put("message", "HTTP $code ${msg.orEmpty().take(300)}").toString(), token)
                conn.disconnect()
                return
            }
            val reader = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
            var sse = false
            var first = true
            val full = StringBuilder()
            while (token == chatToken.get()) {
                val line = reader.readLine() ?: break
                val t = line.trim()
                if (t.isEmpty()) continue
                if (t.startsWith(":")) continue
                if (first) {
                    sse = t.startsWith("data:")
                    first = false
                }
                if (!sse) {
                    full.append(t)
                    continue
                }
                if (!t.startsWith("data:")) continue
                val payload = t.removePrefix("data:").trim()
                if (payload == "[DONE]") break
                try {
                    val json = JSONObject(payload)
                    val deltaObj = json.optJSONArray("choices")
                        ?.optJSONObject(0)
                        ?.optJSONObject("delta")
                    // 只接受真正的字符串增量; content 为 null 或缺省 (角色声明/空增量) 直接跳过,
                    // 避免 org.json 把显式 null 变成字符串 "null" 打进正文
                    val content = deltaObj?.opt("content")
                    if (content is String && content.isNotBlank()) {
                        full.append(content)
                        postChat("__noriChatDelta", content, token)
                    }
                } catch (_: Exception) {
                    // 跳过无法解析的 SSE 行
                }
            }
            if (token != chatToken.get()) {
                postChat("__noriChatError", JSONObject().put("message", "已停止").toString(), token)
                return
            }
            var resultText = full.toString()
            if (!sse) {
                // 非 SSE 响应 (兼容某些代理): 整段 JSON 解析
                val json = JSONObject(full.toString())
                if (json.has("error")) {
                    val err = json.optJSONObject("error")?.optString("message") ?: json.optString("error")
                    postChat("__noriChatError", JSONObject().put("message", err.ifBlank { "接口返回错误" }).toString(), token)
                    return
                }
                val content = json.optJSONArray("choices")
                    ?.optJSONObject(0)
                    ?.optJSONObject("message")
                    ?.optString("content")
                    .orEmpty()
                if (content.isNotBlank()) {
                    resultText = content
                    postChat("__noriChatDelta", content, token)
                }
            }
            postChat("__noriChatDone", JSONObject().put("ok", true).put("content", resultText).toString(), token)
        } catch (e: Exception) {
            if (token == chatToken.get()) {
                postChat("__noriChatError", JSONObject().put("message", e.message ?: "流式请求失败").toString(), token)
            }
        }
    }

    
    @android.webkit.JavascriptInterface
    fun checkFishBalance(apiKey: String, baseUrl: String) {
        ioExecutor.execute {
            postToJs("__noriFishBalanceRes", checkFishBalanceSync(apiKey, baseUrl))
        }
    }

    
    @android.webkit.JavascriptInterface
    fun checkDeepSeekBalance(apiKey: String, baseUrl: String) {
        ioExecutor.execute {
            postToJs("__noriDeepseekBalanceRes", checkDeepSeekBalanceSync(apiKey, baseUrl))
        }
    }

    
    private val ttsToken = AtomicLong(0)

    
    @android.webkit.JavascriptInterface
    fun ttsStream(
        baseUrl: String,
        apiKey: String,
        model: String,
        referenceId: String,
        format: String,
        chunkLength: Int,
        latency: String,
        text: String
    ) {
        val token = ttsToken.incrementAndGet()
        ioExecutor.execute {
            ttsStreamSync(token, baseUrl, apiKey, model, referenceId, format, chunkLength, latency, text)
        }
    }

    
    @android.webkit.JavascriptInterface
    fun ttsStop() {
        ttsToken.incrementAndGet()
    }

    
    private fun postTts(fn: String, json: String, token: Long) {
        mainHandler.post {
            if (token != ttsToken.get()) return@post
            runCatching {
                webView?.evaluateJavascript("window.$fn && window.$fn(${JSONObject.quote(json)})", null)
            }
        }
    }

    
    @android.webkit.JavascriptInterface
    fun listVoices(apiKey: String, baseUrl: String) {
        ioExecutor.execute {
            postToJs("__noriVoicesRes", listVoicesSync(apiKey, baseUrl))
        }
    }

    
    private fun listVoicesSync(apiKey: String, baseUrl: String): String {
        return runCatching {
            val base = normalizeBase(baseUrl).removeSuffix("/v1")
            
            val conn = open("$base/model?self=true&page_size=50&sort_by=score", "GET", apiKey, null, null)
            val body = conn.readBody()
            val json = JSONObject(body)
            val items = json.optJSONArray("items") ?: JSONArray()
            val voices = JSONArray()
            for (i in 0 until items.length()) {
                val o = items.optJSONObject(i) ?: continue
                if (o.optString("type", "") != "tts") continue
                if (o.optString("state", "") != "trained") continue
                val id = o.optString("_id", "")
                if (id.isBlank()) continue
                val title = o.optString("title", id)
                voices.put(JSONObject().put("id", id).put("title", title))
            }
            JSONObject().put("ok", true).put("voices", voices).toString()
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "拉取音色列表失败").toString()
        }
    }

    
    private fun ttsStreamSync(
        token: Long,
        baseUrl: String,
        apiKey: String,
        model: String,
        referenceId: String,
        format: String,
        chunkLength: Int,
        latency: String,
        text: String
    ) {
        if (text.isBlank()) {
            postTts("__noriTtsError", JSONObject().put("message", "TTS 文本为空").toString(), token)
            return
        }
        try {
            val base = normalizeBase(baseUrl)
            val req = JSONObject()
                .put("text", text)
                .put("format", if (format.isBlank()) "mp3" else format)
                .put("streaming", true)
                .put("chunk_length", if (chunkLength in 100..500) chunkLength else 120)
                .put("latency", if (latency.isBlank()) "normal" else latency)
            if (referenceId.isNotBlank()) req.put("reference_id", referenceId)
            val headers = if (model.isNotBlank()) mapOf("model" to model) else null
            val conn = open(base + "/v1/tts", "POST", apiKey, "application/json", req.toString(), headers)
            val code = conn.responseCode
            if (code !in 200..299) {
                val msg = runCatching { conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) } }.getOrElse { "" }
                postTts("__noriTtsError", JSONObject().put("message", "HTTP $code ${msg.orEmpty().take(200)}").toString(), token)
                conn.disconnect()
                return
            }
            
            conn.inputStream.use { input ->
                val buf = ByteArray(16 * 1024)
                while (token == ttsToken.get()) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    val b64 = android.util.Base64.encodeToString(
                        if (n == buf.size) buf else buf.copyOf(n),
                        android.util.Base64.NO_WRAP
                    )
                    postTts("__noriTtsChunk", b64, token)
                }
            }
            if (token != ttsToken.get()) {
                postTts("__noriTtsError", JSONObject().put("message", "已停止").toString(), token)
            } else {
                postTts("__noriTtsDone", JSONObject().put("ok", true).toString(), token)
            }
        } catch (e: Exception) {
            if (token == ttsToken.get()) {
                postTts("__noriTtsError", JSONObject().put("message", e.message ?: "TTS 网络请求失败").toString(), token)
            }
        }
    }

    /* ---------------- 千问 CosyVoice (SSE 流式) ---------------- */

    private val cosyToken = AtomicLong(0)

    
    @android.webkit.JavascriptInterface
    fun cosyTtsStream(
        baseUrl: String,
        apiKey: String,
        model: String,
        voice: String,
        format: String,
        sampleRate: Int,
        rate: Double,
        text: String
    ) {
        val token = cosyToken.incrementAndGet()
        ioExecutor.execute {
            cosyTtsStreamSync(token, baseUrl, apiKey, model, voice, format, sampleRate, rate, text)
        }
    }

    
    @android.webkit.JavascriptInterface
    fun cosyTtsStop() {
        cosyToken.incrementAndGet()
    }

    
    private fun postCosy(fn: String, json: String, token: Long) {
        mainHandler.post {
            if (token != cosyToken.get()) return@post
            runCatching {
                webView?.evaluateJavascript("window.$fn && window.$fn(${JSONObject.quote(json)})", null)
            }
        }
    }

    
    private fun cosyTtsStreamSync(
        token: Long,
        baseUrl: String,
        apiKey: String,
        model: String,
        voice: String,
        format: String,
        sampleRate: Int,
        rate: Double,
        text: String
    ) {
        if (text.isBlank()) {
            postCosy("__noriTtsError", JSONObject().put("message", "TTS 文本为空").toString(), token)
            return
        }
        // 不使用系统音色: 音色留空必须明确报错, 不能兜底成某个系统音色名。
        // 音色名是分模型的 (v3-flash 的"龙小淳"是 longxiaochun_v3, v2 是 longxiaochun_v2,
        // qwen-audio 系是 longanhuan_v3.1 这种写法), 裸 longxiaochun 对任何模型都无效,
        // 发出去只会换回一句 Engine error [411], 不点明原因。
        //
        // 注意: 这是 Web 侧 streamCosyTTS 之外的最后一道兜底, 正常情况下走不到 (Web 先拦)。
        // 文案与 web-src/src/services/tts/cosyvoice.ts 的 COSY_NO_VOICE_ERROR 保持一致 ——
        // 跨语言没法共用常量, 改一边时另一边要一起改, 否则两处说法会漂移。
        // "音色与模型不匹配"不在这里判: 那是 voiceId→model 的绑定关系, 只有 Web 侧有。
        if (voice.isBlank()) {
            postCosy("__noriTtsError", JSONObject().put("message", "未设置音色：本项目不使用系统音色，请先在下方「声音克隆」创建专属音色，或填入已有的克隆音色 id").toString(), token)
            return
        }
        try {
            val base = normalizeBase(baseUrl).removeSuffix("/v1")
            val fmt = if (format.isBlank()) "mp3" else format
            val sr = if (sampleRate in 8000..48000) sampleRate else 24000
            val rt = if (rate in 0.5..2.0) rate else 1.0
            val req = JSONObject()
                .put("model", if (model.isBlank()) "cosyvoice-v3.5-flash" else model)
                .put("input", JSONObject()
                    .put("text", text)
                    .put("voice", voice)
                    .put("format", fmt)
                    .put("sample_rate", sr)
                    .put("rate", rt))
                // 兼容旧版 DashScope 参数位置: 新旧网关各认各的, 两个都发最稳
                .put("parameters", JSONObject()
                    .put("format", fmt)
                    .put("sample_rate", sr)
                    .put("rate", rt))
            val headers = mapOf("X-DashScope-SSE" to "enable")
            val conn = open(base + "/api/v1/services/audio/tts/SpeechSynthesizer", "POST", apiKey, "application/json", req.toString(), headers)
            val code = conn.responseCode
            if (code !in 200..299) {
                val msg = runCatching { conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) } }.getOrElse { "" }
                postCosy("__noriTtsError", JSONObject().put("message", "HTTP $code ${msg.orEmpty().take(200)}").toString(), token)
                conn.disconnect()
                return
            }
            val reader = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
            // 收到的音频 base64 总量 (用于判断是否真的拿到了音频)
            var audioLen = 0L
            // 非流式响应的整包 JSON (部分网关不认 SSE 头, 返回单条 JSON)
            val wholeBody = StringBuilder()
            // 事件里的音频 URL (SSE 或整包响应里 audio.url)
            var audioUrl = ""
            // 解析一条事件里的音频: 兼容 output.audio 为 字符串(base64) 或 对象 {data,url}
            fun consumeEvent(payload: String): Boolean {
                val json = JSONObject(payload)
                val output = json.optJSONObject("output")
                    ?: json.optJSONObject("payload")?.optJSONObject("output")
                    ?: return false
                val errObj = output.optJSONObject("error")
                if (errObj != null) {
                    postCosy("__noriTtsError", JSONObject().put("message", errObj.optString("message", "CosyVoice 合成失败")).toString(), token)
                    return true
                }
                val audio = output.opt("audio")
                val b64 = when (audio) {
                    is JSONObject -> audio.optString("data", "")
                    is String -> audio
                    else -> ""
                }
                if (b64.isNotBlank()) {
                    audioLen += b64.length
                    postCosy("__noriTtsChunk", b64, token)
                } else if (audio is JSONObject) {
                    val u = audio.optString("url", "")
                    if (u.isNotBlank()) audioUrl = u
                }
                return output.optString("finish_reason", "") == "stop"
            }
            var stop = false
            while (token == cosyToken.get() && !stop) {
                val line = reader.readLine() ?: break
                val t = line.trim()
                if (t.isEmpty() || t.startsWith(":")) continue
                var payload = t
                if (t.startsWith("data:")) payload = t.removePrefix("data:").trim()
                if (payload == "[DONE]") break
                try {
                    stop = consumeEvent(payload)
                } catch (_: Exception) {
                    // 非 JSON 行 (如 event: xxx) 忽略; JSON 但结构不对则收进整包兜底
                    if (!t.startsWith("data:")) wholeBody.append(payload)
                }
            }
            // 兜底 1: 整条非流式 JSON 响应 (output.audio.url 下载 或 data 内联)
            if (audioLen == 0L && token == cosyToken.get() && wholeBody.isNotBlank()) {
                try {
                    stop = consumeEvent(wholeBody.toString())
                } catch (_: Exception) {
                    // 忽略
                }
            }
            // 兜底 2: 只有音频 URL 时下载并回传
            if (audioLen == 0L && token == cosyToken.get()) {
                if (audioUrl.isBlank()) {
                    audioUrl = runCatching {
                        JSONObject(wholeBody.toString()).optJSONObject("output")?.optJSONObject("audio")?.optString("url", "").orEmpty()
                    }.getOrElse { "" }
                }
                if (audioUrl.isNotBlank()) {
                    val bytes = downloadBytes(audioUrl)
                    if (bytes != null && bytes.isNotEmpty()) {
                        audioLen += bytes.size
                        postCosy("__noriTtsChunk", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP), token)
                    }
                }
            }
            if (token != cosyToken.get()) {
                postCosy("__noriTtsError", JSONObject().put("message", "已停止").toString(), token)
            } else {
                // 连接成功且流程正常结束: 即使音频为空 (如极短文本/纯标点) 也按成功结束处理,
                // 避免聊天逐句朗读时因个别空音频句误报"失败"。是否真的拿到音频由前端测试逻辑判断。
                postCosy("__noriTtsDone", JSONObject().put("ok", true).put("bytes", audioLen).toString(), token)
            }
        } catch (e: Exception) {
            if (token == cosyToken.get()) {
                postCosy("__noriTtsError", JSONObject().put("message", e.message ?: "CosyVoice 网络请求失败").toString(), token)
            }
        }
    }

    
    /* ---------------- 悬浮窗控制 ---------------- */

    /** 检查悬浮窗权限是否已授权 */
    @android.webkit.JavascriptInterface
    fun canFloat(): Boolean {
        return runCatching {
            val act = appContext as? Activity
            act != null && android.provider.Settings.canDrawOverlays(act)
        }.getOrDefault(false)
    }

    /** 打开悬浮窗权限设置页 */
    @android.webkit.JavascriptInterface
    fun requestFloatPermission() {
        mainHandler.post {
            try {
                val act = appContext as? Activity ?: return@post
                val intent = Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${act.packageName}")
                )
                act.startActivity(intent)
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    /** 启动悬浮窗服务 (应用上下文: 应用退出后悬浮窗内也可控制) */
    @android.webkit.JavascriptInterface
    fun showFloat() {
        mainHandler.post {
            try {
                if (!android.provider.Settings.canDrawOverlays(appContext)) return@post
                val intent = Intent(appContext, FloatService::class.java).setAction(FloatService.ACTION_SHOW)
                appContext.startService(intent)
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    /** 关闭悬浮窗服务 */
    @android.webkit.JavascriptInterface
    fun hideFloat() {
        mainHandler.post {
            try {
                val intent = Intent(appContext, FloatService::class.java).setAction(FloatService.ACTION_HIDE)
                appContext.startService(intent)
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    /** 记录"退出后显示悬浮窗"开关 (原生 SharedPreferences, 退出判断不依赖 settings.json) */
    @android.webkit.JavascriptInterface
    fun setFloatEnabled(enable: Boolean) {
        mainHandler.post {
            try {
                appContext.getSharedPreferences("float_enabled_prefs", Context.MODE_PRIVATE)
                    .edit().putBoolean("float_enabled", enable).apply()
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    /** 悬浮窗聊天气泡: 关闭 (finish FloatBubbleActivity) */
    @android.webkit.JavascriptInterface
    fun closeFloatBubble() {
        mainHandler.post {
            try {
                (appContext as? Activity)?.finish()
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    /** 悬浮窗页面: 上报模型脚底 Y (相对悬浮窗窗口) → 对话框顶部贴住 Nori 脚底 */
    @android.webkit.JavascriptInterface
    fun setFloatModelFeet(feetY: Int) {
        FloatService.modelFeetY = feetY
    }

    /** 悬浮窗页面: 上报模型身体矩形 (相对悬浮窗窗口, 物理像素) → 只在模型身上点按才弹气泡 */
    @android.webkit.JavascriptInterface
    fun setFloatModelRect(l: Int, t: Int, r: Int, b: Int) {
        FloatService.modelRect = intArrayOf(l, t, r, b)
    }

    /** 聊天气泡: 表情/动作标记 → 转发给悬浮窗 Nori 播放 (主 App 同规则驱动表演) */
    @android.webkit.JavascriptInterface
    fun playFloatMarker(emotion: String, motion: String) {
        mainHandler.post {
            try {
                val intent = Intent(appContext, FloatService::class.java)
                    .setAction(FloatService.ACTION_PLAY_MARKER)
                    .putExtra("emotion", emotion)
                    .putExtra("motion", motion)
                appContext.startService(intent)
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    /** 聊天气泡: 回复正文关键词兜底表演 (标记缺失时, 与主 App 关键词规则一致) */
    @android.webkit.JavascriptInterface
    fun playFloatByText(text: String) {
        mainHandler.post {
            try {
                val intent = Intent(appContext, FloatService::class.java)
                    .setAction(FloatService.ACTION_PLAY_BY_TEXT)
                    .putExtra("text", text)
                appContext.startService(intent)
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    /** 悬浮窗: 渲染分辨率设置 (x) → 通知悬浮窗页面实时生效 */
    @android.webkit.JavascriptInterface
    fun setFloatRenderScale(scale: Double) {
        mainHandler.post {
            try {
                val intent = Intent(appContext, FloatService::class.java)
                    .setAction(FloatService.ACTION_RENDER_SCALE)
                    .putExtra("scale", scale)
                appContext.startService(intent)
            } catch (_: Exception) { /* 忽略 */ }
        }
    }

    private fun checkFishBalanceSync(apiKey: String, baseUrl: String): String {
        return runCatching {
            
            val base = normalizeBase(baseUrl).removeSuffix("/v1")
            val conn = open("$base/wallet/self/api-credit", "GET", apiKey, null, null)
            val body = conn.readBody()
            val json = JSONObject(body)
            val credit = json.optString("credit", "")
            JSONObject()
                .put("ok", true)
                .put("credit", credit)
                .put("hasFreeCredit", json.optBoolean("has_free_credit", false))
                .toString()
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "查询 Fish Audio 余额失败").toString()
        }
    }

    
    private fun checkDeepSeekBalanceSync(apiKey: String, baseUrl: String): String {
        return runCatching {
            
            val base = normalizeBase(baseUrl)
                .removeSuffix("/chat/completions")
                .removeSuffix("/v1")
            val conn = open("$base/user/balance", "GET", apiKey, null, null)
            val body = conn.readBody()
            val json = JSONObject(body)
            val infos = json.optJSONArray("balance_infos")
            val lines = StringBuilder()
            if (infos != null) {
                for (i in 0 until infos.length()) {
                    val o = infos.optJSONObject(i) ?: continue
                    val cur = o.optString("currency", "")
                    val total = o.optString("total_balance", "")
                    val granted = o.optString("granted_balance", "")
                    val topped = o.optString("topped_up_balance", "")
                    if (lines.length > 0) lines.append("\n")
                    lines.append("$cur 总余额 $total（赠送 $granted + 充值 $topped）")
                }
            }
            JSONObject()
                .put("ok", true)
                .put("isAvailable", json.optBoolean("is_available", true))
                .put("balance", if (lines.isEmpty()) "无余额信息" else lines.toString())
                .toString()
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "查询 DeepSeek 余额失败").toString()
        }
    }

    /* ---------------- 千问 (DashScope) 余额查询 ----------------
     * 千问官方没有公开的 HTTP 余额查询接口 (仅控制台可看)。
     * 这里尝试常见的 accounts/balance 端点: 自建网关可能实现,
     * 官方端点则返回明确提示, 引导用户去控制台查看。
     */
    @android.webkit.JavascriptInterface
    fun checkCosyBalance(apiKey: String, baseUrl: String) {
        ioExecutor.execute {
            postToJs("__noriCosyBalanceRes", checkCosyBalanceSync(apiKey, baseUrl))
        }
    }

    private fun checkCosyBalanceSync(apiKey: String, baseUrl: String): String {
        val base = normalizeBase(baseUrl).removeSuffix("/v1")
        // 依次尝试常见端点
        val endpoints = listOf(
            "$base/api/v1/accounts/balance",
            "$base/api/v1/user/balance",
            "$base/accounts/balance",
        )
        var lastMsg = "未找到余额接口"
        for (ep in endpoints) {
            val r = runCatching {
                val conn = open(ep, "GET", apiKey, null, null)
                val code = conn.responseCode
                val body = runCatching {
                    if (code in 200..299) conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
                    else conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                }.getOrElse { "" }
                conn.disconnect()
                Triple(code, body, "")
            }.getOrElse { Triple(-1, "", it.message ?: "网络错误") }
            val (code, body, errMsg) = r
            if (code in 200..299) {
                return runCatching {
                    val json = JSONObject(body)
                    // 兼容多种字段命名
                    val out = json.optJSONObject("data") ?: json
                    val balance = out.optString("current_balance", "")
                        .ifBlank { out.optString("balance", "") }
                        .ifBlank { out.optString("available_balance", "") }
                        .ifBlank { out.optString("total_balance", "") }
                    JSONObject()
                        .put("ok", true)
                        .put("balance", balance.ifBlank { body.take(200) })
                        .toString()
                }.getOrElse {
                    JSONObject().put("ok", true).put("balance", body.take(200)).toString()
                }
            }
            lastMsg = if (code == 404) "官方未开放余额查询接口" else "HTTP $code ${body.take(120)}"
            if (code != 404) break
        }
        return JSONObject()
            .put("ok", false)
            .put("message", "千问/DashScope 官方未提供公开余额查询接口。请在千问控制台(账单页)查看余额。($lastMsg)")
            .toString()
    }

    private fun postToJs(fn: String, json: String) {
        mainHandler.post {
            runCatching {
                webView?.evaluateJavascript(
                    "window.$fn && window.$fn(${JSONObject.quote(json)})",
                    null
                )
            }
        }
    }

    private fun fetchModelsSync(baseUrl: String, apiKey: String): String {
        return runCatching {
            val base = normalizeBase(baseUrl)
            val conn = open(base + "/models", "GET", apiKey, null, null)
            val body = conn.readBody()
            val json = JSONObject(body)
            val arr = json.optJSONArray("data") ?: JSONArray()
            val names = JSONArray()
            for (i in 0 until arr.length()) {
                val id = arr.optJSONObject(i)?.optString("id")
                if (!id.isNullOrBlank()) names.put(id)
            }
            JSONObject().put("ok", true).put("models", names).toString()
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "拉取模型失败").toString()
        }
    }

    private fun chatSync(baseUrl: String, apiKey: String, model: String, messagesJson: String, thinkingMode: String): String {
        return runCatching {
            val base = normalizeBase(baseUrl)
            val req = JSONObject()
                .put("model", model)
                .put("messages", JSONArray(messagesJson))
                .put("stream", false)
            putThinking(req, thinkingMode)
            val conn = open(base + "/chat/completions", "POST", apiKey, "application/json", req.toString())
            val body = conn.readBody()
            val json = JSONObject(body)
            if (json.has("error")) {
                val err = json.optJSONObject("error")?.optString("message") ?: json.optString("error")
                return JSONObject().put("ok", false).put("message", err.ifBlank { "接口返回错误" }).toString()
            }
            val content = json.optJSONArray("choices")
                ?.optJSONObject(0)
                ?.optJSONObject("message")
                ?.optString("content")
                .orEmpty()
            JSONObject().put("ok", true).put("content", content).toString()
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "请求失败").toString()
        }
    }

    /**
     * DeepSeek 思考模式开关写进请求体。前端算好三态传过来（见 web 侧 `resolveThinking`）:
     * - `"enabled"`  → `thinking:{type:"enabled"}`
     * - `"disabled"` → `thinking:{type:"disabled"}` （**默认是开的**, 所以"关"必须显式传, 否则不生效）
     * - 其它/空串     → 不写这个字段 (非 DeepSeek 端点的请求体里绝不能出现它, 那是 DeepSeek 专有扩展)
     *
     * 只认这两个字面量: 前端传错值时宁可"不写", 也不要往别人的 API 上塞未知字段。
     */
    private fun putThinking(req: JSONObject, thinkingMode: String) {
        if (thinkingMode == "enabled" || thinkingMode == "disabled") {
            req.put("thinking", JSONObject().put("type", thinkingMode))
        }
    }

    private fun normalizeBase(base: String): String {
        var b = base.trim()
        if (b.isEmpty()) b = "https://api.openai.com/v1"
        b = b.trimEnd('/')
        if (b.endsWith("/chat/completions")) b = b.removeSuffix("/chat/completions")
        if (!b.startsWith("http")) b = "https://$b"
        return b
    }

    private fun open(url: String, method: String, apiKey: String, contentType: String?, body: String?, extraHeaders: Map<String, String>? = null): HttpURLConnection {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            requestMethod = method
            if (apiKey.isNotBlank()) setRequestProperty("Authorization", "Bearer $apiKey")
            if (contentType != null) setRequestProperty("Content-Type", contentType)
            
            if (extraHeaders != null) {
                for ((k, v) in extraHeaders) setRequestProperty(k, v)
            }
        }
        if (body != null) {
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        return conn
    }

    private fun HttpURLConnection.readBody(): String {
        return try {
            if (responseCode in 200..299) inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            else {
                val msg = runCatching { errorStream.use { it.readBytes().toString(Charsets.UTF_8) } }.getOrElse { "" }
                throw RuntimeException("HTTP ${responseCode} $msg".trim())
            }
        } finally {
            disconnect()
        }
    }

    /* ---------------- 千问 CosyVoice 声音克隆 ---------------- */

    /** 系统文件选择器选音频 (结果回传 __noriVoicePickedRes) */
    @android.webkit.JavascriptInterface
    fun pickVoiceFile() {
        mainHandler.post {
            try {
                val act = appContext as? Activity ?: return@post
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "audio/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                act.startActivityForResult(intent, REQ_PICK_VOICE)
            } catch (e: Exception) {
                postToJs("__noriVoicePickedRes", JSONObject().put("ok", false).put("message", e.message ?: "打开文件选择器失败").toString())
            }
        }
    }

    /* ---------------- 自定义文案人设 (2026-10-01 用户要求) ---------------- */

    /** 系统文件选择器选**文本文件**当人设提示词 (结果回传 __noriPersonaPickedRes)
     *
     *  与选音频那条**完全分开**: 请求码/回调名都不同, 免得两条流程互相抢结果。
     *  文本类没有干净的单一 MIME, 所以 type 先给文本通配再补 EXTRA_MIME_TYPES ——
     *  各家文件管理器实现不一, 给太窄会让 .md/.txt 直接灰掉选不中。
     *  (⚠ 注释里别写 text 加斜杠星号, Kotlin 的块注释会嵌套, 会把后面整段代码吃进注释里) */
    @android.webkit.JavascriptInterface
    fun pickPersonaFile() {
        mainHandler.post {
            try {
                val act = appContext as? Activity ?: return@post
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "text/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/*", "application/json", "application/octet-stream"))
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                act.startActivityForResult(intent, REQ_PICK_PERSONA)
            } catch (e: Exception) {
                postToJs("__noriPersonaPickedRes", JSONObject().put("ok", false).put("message", e.message ?: "打开文件选择器失败").toString())
            }
        }
    }

    /** 人设文件上限 200KB: 提示词再长也没用, 挡住误选的大文件把 WebView 卡死 */
    private val personaMaxBytes = 200 * 1024

    /** 读文本人设的结果 (请求码已由 handlePickResult 分流到这里) */
    private fun handlePersonaPickResult(resultCode: Int, data: Intent?) {
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            postToJs("__noriPersonaPickedRes", JSONObject().put("ok", false).put("message", "未选择文件").toString())
            return
        }
        val uri = data.data!!
        val name = runCatching {
            cr.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull().orEmpty().ifBlank { "persona.txt" }
        // 边读边卡上限: 超了立刻停, 不把整个文件读进内存再说
        val buf = java.io.ByteArrayOutputStream()
        try {
            val ins = cr.openInputStream(uri) ?: throw RuntimeException("读不到文件内容")
            ins.use {
                val chunk = ByteArray(16 * 1024)
                while (true) {
                    val n = it.read(chunk)
                    if (n < 0) break
                    buf.write(chunk, 0, n)
                    if (buf.size() > personaMaxBytes) break
                }
            }
        } catch (e: Exception) {
            postToJs("__noriPersonaPickedRes", JSONObject().put("ok", false).put("message", e.message ?: "读取文件失败").toString())
            return
        }
        val bytes = buf.toByteArray()
        if (bytes.size > personaMaxBytes) {
            // 不报读到的字节数: 读是**卡着上限**停的, 那个数字不是文件的真实大小, 报出来只会让人困惑
            postToJs("__noriPersonaPickedRes", JSONObject().put("ok", false)
                .put("message", "文件太大（超过 200KB 上限）").toString())
            return
        }
        // 严格 UTF-8 解码 (REPORT 而不是替换成 U+FFFD): 二进制文件/GBK 文本在这里被挡住,
        // 而不是把一堆乱码当人设存下来 —— 那会让人完全看不出哪里错了。
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(bytes))
                .toString()
        } catch (e: Exception) {
            postToJs("__noriPersonaPickedRes", JSONObject().put("ok", false)
                .put("message", "这不是 UTF-8 文本文件（请在电脑上另存为 UTF-8 再导入）").toString())
            return
        }
        postToJs("__noriPersonaPickedRes", JSONObject()
            .put("ok", true)
            .put("name", name)
            .put("size", bytes.size)
            .put("text", text)
            .toString())
    }

    /** MainActivity.onActivityResult 转发到这里 */
    fun handlePickResult(requestCode: Int, resultCode: Int, data: Intent?) {
        // 文本人设那条要**先**分流: 下面那句是「不是音频就返回」, 放在它后面永远轮不到
        if (requestCode == REQ_PICK_PERSONA) {
            handlePersonaPickResult(resultCode, data)
            return
        }
        if (requestCode != REQ_PICK_VOICE) return
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            postToJs("__noriVoicePickedRes", JSONObject().put("ok", false).put("message", "未选择文件").toString())
            return
        }
        val uri = data.data!!
        val name = runCatching {
            cr.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull().orEmpty().ifBlank { "voice_sample.audio" }
        val mime = cr.getType(uri) ?: "audio/mpeg"
        val size = runCatching { cr.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: 0L }.getOrDefault(0L)
        pickedVoiceUri = uri
        postToJs("__noriVoicePickedRes", JSONObject()
            .put("ok", true)
            .put("name", name)
            .put("mime", mime)
            .put("size", size)
            .toString())
    }

    private var pickedVoiceUri: Uri? = null

    /** 创建克隆音色: 上传音频 (getPolicy→OSS) → create_voice → 返回 voice_id */
    @android.webkit.JavascriptInterface
    fun createCloneVoice(apiKey: String, targetModel: String, prefix: String) {
        ioExecutor.execute {
            postToJs("__noriCloneCreateRes", createCloneVoiceSync(apiKey, targetModel, prefix))
        }
    }

    /** 一键克隆的参考音频下载地址（用户 2026-10-01 指定，音频不再打进包里） */
    private val presetVoiceUrl = "https://cb04914b.pinme.dev"

    /**
     * 一键克隆: 参考音频改为**联网下载**（2026-10-01 用户要求），包里不再内置音频。
     *
     * 为什么改：内置两份音频让 APK 多 2.4MB；而且"把一段来源不明的人声打包进对外发布的包里"
     * 有版权风险（见桌面《公开发布计划》第三节）。改成运行时下载 ⇒ 包更小、责任更清楚。
     *
     * 流程：下载（首次；之后走 filesDir 缓存）→ 规范成官方要求的 16-bit WAV →
     * 与手动克隆**完全同一套**上传/建音色流程（cloneFromBytes）。
     * 回调名 `__noriClonePresetRes`（与手动流程的 `__noriCloneCreateRes` 分开，免互相抢）。
     * ⚠ 那个地址在国内可能直连不了 —— 新手引导里已注明"下载音频与模型可能需要魔法"，失败时也会明确提示。
     */
    @android.webkit.JavascriptInterface
    fun createPresetCloneVoice(apiKey: String, targetModel: String, prefix: String) {
        ioExecutor.execute {
            val result = runCatching {
                cloneFromBytes(apiKey, targetModel, prefix, ensurePresetVoice())
            }.getOrElse { e ->
                JSONObject().put("ok", false)
                    .put("message", "参考音频下载失败：${e.message ?: "网络错误"}（国内可能需要代理/魔法）").toString()
            }
            postToJs("__noriClonePresetRes", result)
        }
    }

    /** 取参考音频：优先本地缓存，没有就下载。**下载并校验通过后才落盘**（避免半截文件被当成缓存）。 */
    private fun ensurePresetVoice(): ByteArray {
        val f = java.io.File(appContext.filesDir, "preset-voice.wav")
        if (f.isFile && f.length() > 100 * 1024) {
            val cached = runCatching { f.readBytes() }.getOrNull()
            if (cached != null && isWav(cached)) return normalizeWav16(cached)
        }
        val conn = (java.net.URL(presetVoiceUrl).openConnection() as java.net.HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 20_000
            readTimeout = 90_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "NoriDroid")
        }
        val code = conn.responseCode
        if (code !in 200..299) { conn.disconnect(); throw IllegalStateException("HTTP $code") }
        val data = conn.inputStream.use { it.readBytes() }
        conn.disconnect()
        if (data.size < 1024) throw IllegalStateException("文件太小（${data.size} 字节）")
        if (!isWav(data)) throw IllegalStateException("拿到的不是 WAV（服务端可能返回了网页）")
        runCatching { f.writeBytes(data) }        // 缓存失败不影响本次使用
        return normalizeWav16(data)
    }

    private fun isWav(b: ByteArray): Boolean =
        b.size > 44 && b[0] == 0x52.toByte() && b[1] == 0x49.toByte() && b[2] == 0x46.toByte() && b[3] == 0x46.toByte()

    /**
     * 把 WAV 规范成官方要求的 16-bit PCM（声音复刻文档：Format = WAV (16-bit)）。
     * 只做**位深**转换：不重采样、不混声道、不动电平 —— 之前实测"动得越多克隆效果越差"。
     * 已经是 16-bit、或结构不认识、或 fmt≠1(PCM) 的，一律原样返回（交给接口判断，不在这里瞎猜）。
     */
    private fun normalizeWav16(src: ByteArray): ByteArray {
        return runCatching {
            if (src.size < 44) return src
            var p = 12
            var fmtOff = -1; var fmtLen = 0; var dataOff = -1; var dataLen = 0
            while (p + 8 <= src.size) {
                val id = String(src, p, 4, Charsets.US_ASCII)
                val len = le32(src, p + 4)
                val body = p + 8
                if (id == "fmt ") { fmtOff = body; fmtLen = len }
                if (id == "data") { dataOff = body; dataLen = minOf(len, src.size - body) }
                if (len < 0) return src
                p = body + len + (len and 1)
            }
            if (fmtOff < 0 || dataOff < 0 || fmtLen < 16 || dataLen <= 0) return src
            val format = le16(src, fmtOff)
            val channels = le16(src, fmtOff + 2)
            val sampleRate = le32(src, fmtOff + 4)
            val bits = le16(src, fmtOff + 14)
            /* WAVE_FORMAT_EXTENSIBLE(0xFFFE) 的真实格式藏在扩展区 SubFormat GUID 的头两个字节里。
               实测用户托管的那份就是这种（24bit 扩展头）—— 只认 fmt==1 会导致"该转的没转"，
               于是 24bit 原样上传、规格不符。这里把扩展格式还原出来再判断。 */
            val realFormat = if (format == 0xFFFE && fmtLen >= 40) le16(src, fmtOff + 24) else format
            if (realFormat != 1 || bits != 24 || channels < 1 || sampleRate <= 0) return src
            val frames = dataLen / (channels * 3)
            if (frames <= 0) return src
            val dataBytes = frames * channels * 2
            val out = ByteArray(44 + dataBytes)
            "RIFF".toByteArray().copyInto(out, 0)
            putLe32(out, 4, 36 + dataBytes)
            "WAVE".toByteArray().copyInto(out, 8)
            "fmt ".toByteArray().copyInto(out, 12)
            putLe32(out, 16, 16)
            putLe16(out, 20, 1)
            putLe16(out, 22, channels)
            putLe32(out, 24, sampleRate)
            putLe32(out, 28, sampleRate * channels * 2)
            putLe16(out, 32, channels * 2)
            putLe16(out, 34, 16)
            "data".toByteArray().copyInto(out, 36)
            putLe32(out, 40, dataBytes)
            var si = dataOff
            var di = 44
            for (i in 0 until frames * channels) {
                out[di] = src[si + 1]          // 24bit 小端 → 取高 16 位（等于 /256，符号不变）
                out[di + 1] = src[si + 2]
                si += 3; di += 2
            }
            out
        }.getOrDefault(src)
    }

    private fun le16(b: ByteArray, o: Int): Int = (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8)
    private fun le32(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8) or
            ((b[o + 2].toInt() and 0xff) shl 16) or ((b[o + 3].toInt() and 0xff) shl 24)
    private fun putLe16(b: ByteArray, o: Int, v: Int) {
        b[o] = (v and 0xff).toByte(); b[o + 1] = ((v shr 8) and 0xff).toByte()
    }
    private fun putLe32(b: ByteArray, o: Int, v: Int) {
        b[o] = (v and 0xff).toByte(); b[o + 1] = ((v shr 8) and 0xff).toByte()
        b[o + 2] = ((v shr 16) and 0xff).toByte(); b[o + 3] = ((v shr 24) and 0xff).toByte()
    }

    /** 打开外部链接（新手引导里的 Steam 愿望单等）。只放行 http/https，避免被页面里的怪 URL 拿去启动别的组件 */
    @android.webkit.JavascriptInterface
    fun openExternal(url: String) {
        val u = url.trim()
        if (!u.startsWith("http://") && !u.startsWith("https://")) return
        mainHandler.post {
            runCatching {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                appContext.startActivity(intent)
            }
        }
    }

    private fun createCloneVoiceSync(apiKey: String, targetModel: String, prefix: String): String {
        return runCatching {
            val uri = pickedVoiceUri
            if (uri == null) return@runCatching JSONObject().put("ok", false).put("message", "请先选择音频文件").toString()
            val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching JSONObject().put("ok", false).put("message", "读取音频文件失败").toString()
            if (bytes.isEmpty()) return@runCatching JSONObject().put("ok", false).put("message", "音频文件为空").toString()
            cloneFromBytes(apiKey, targetModel, prefix, bytes)
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "创建克隆音色失败").toString()
        }
    }

    /** 上传 + 建音色的公共部分：手动选文件与"一键克隆（内置音频）"都走这里 */
    private fun cloneFromBytes(apiKey: String, targetModel: String, prefix: String, bytes: ByteArray): String {
        return runCatching {
            if (bytes.size > 10 * 1024 * 1024) return@runCatching JSONObject().put("ok", false).put("message", "音频文件超过 10MB 限制").toString()
            val mdl = targetModel.ifBlank { "cosyvoice-v3.5-flash" }
            val pfx = prefix.ifBlank { "nori" }.replace(Regex("[^a-zA-Z0-9]"), "").take(10)
            if (pfx.isEmpty()) return@runCatching JSONObject().put("ok", false).put("message", "音色前缀只能包含字母和数字").toString()

            // 1. 获取上传凭证
            val policyUrl = "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=" + URLEncoder.encode(mdl, "UTF-8")
            val policyConn = open(policyUrl, "GET", apiKey, null, null)
            val policyBody = policyConn.readBody()
            val policyData = JSONObject(policyBody).optJSONObject("data")
                ?: return@runCatching JSONObject().put("ok", false).put("message", "获取上传凭证失败: ${policyBody.take(300)}").toString()
            val uploadHost = policyData.optString("upload_host", "")
            val uploadDir = policyData.optString("upload_dir", "")
            if (uploadHost.isBlank() || uploadDir.isBlank()) return@runCatching JSONObject().put("ok", false).put("message", "上传凭证不完整").toString()

            // 2. 上传到 OSS (multipart/form-data)
            val key = "$uploadDir/${System.currentTimeMillis()}.${extOf(mimeOf(bytes))}"
            val boundary = "----NoriClone${System.currentTimeMillis()}"
            val uploadConn = (URL(uploadHost).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 30_000
                readTimeout = 60_000
                doOutput = true
                setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            }
            val out = uploadConn.outputStream
            fun formField(name: String, value: String) {
                out.write("--$boundary\r\n".toByteArray())
                out.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
                out.write(value.toByteArray())
                out.write("\r\n".toByteArray())
            }
            formField("OSSAccessKeyId", policyData.optString("oss_access_key_id", ""))
            formField("Signature", policyData.optString("signature", ""))
            formField("policy", policyData.optString("policy", ""))
            formField("key", key)
            formField("x-oss-object-acl", policyData.optString("x_oss_object_acl", ""))
            formField("x-oss-forbid-overwrite", policyData.optString("x_oss_forbid_overwrite", ""))
            formField("success_action_status", "200")
            out.write("--$boundary\r\n".toByteArray())
            out.write("Content-Disposition: form-data; name=\"file\"; filename=\"${key.substringAfterLast('/')}\"\r\n".toByteArray())
            out.write("Content-Type: ${mimeOf(bytes)}\r\n\r\n".toByteArray())
            out.write(bytes)
            out.write("\r\n--$boundary--\r\n".toByteArray())
            out.flush()
            out.close()
            val upCode = uploadConn.responseCode
            val upBody = runCatching { uploadConn.inputStream?.use { it.readBytes().toString(Charsets.UTF_8) } }.getOrElse { "" }
            uploadConn.disconnect()
            if (upCode !in 200..299) return@runCatching JSONObject().put("ok", false).put("message", "上传音频失败 HTTP $upCode $upBody".take(300)).toString()

            // 3. 创建克隆音色 (oss:// 需要 X-DashScope-OssResourceResolve: enable)
            val req = JSONObject()
                .put("model", "voice-enrollment")
                .put("input", JSONObject()
                    .put("action", "create_voice")
                    .put("target_model", mdl)
                    .put("prefix", pfx)
                    .put("url", "oss://$key"))
            val headers = mapOf("X-DashScope-OssResourceResolve" to "enable")
            val conn = open("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", "POST", apiKey, "application/json", req.toString(), headers)
            val code = conn.responseCode
            val body = runCatching {
                if (code in 200..299) conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
                else conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            }.getOrElse { "" }
            conn.disconnect()
            if (code !in 200..299) return@runCatching JSONObject().put("ok", false).put("message", "创建克隆音色失败 HTTP $code ${body.take(300)}").toString()
            val voiceId = JSONObject(body).optJSONObject("output")?.optString("voice_id", "").orEmpty()
            if (voiceId.isBlank()) return@runCatching JSONObject().put("ok", false).put("message", "创建响应缺少 voice_id: ${body.take(300)}").toString()
            JSONObject().put("ok", true).put("voice_id", voiceId).toString()
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "创建克隆音色失败").toString()
        }
    }

    /** 查询克隆音色状态 (DEPLOYING/OK/UNDEPLOYED) */
    @android.webkit.JavascriptInterface
    fun queryCloneVoice(apiKey: String, voiceId: String) {
        ioExecutor.execute {
            postToJs("__noriCloneQueryRes", queryCloneVoiceSync(apiKey, voiceId))
        }
    }

    private fun queryCloneVoiceSync(apiKey: String, voiceId: String): String {
        return runCatching {
            val req = JSONObject()
                .put("model", "voice-enrollment")
                .put("input", JSONObject().put("action", "query_voice").put("voice_id", voiceId))
            val conn = open("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", "POST", apiKey, "application/json", req.toString())
            val code = conn.responseCode
            val body = runCatching {
                if (code in 200..299) conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
                else conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            }.getOrElse { "" }
            conn.disconnect()
            if (code !in 200..299) return@runCatching JSONObject().put("ok", false).put("message", "HTTP $code ${body.take(200)}").toString()
            val out = JSONObject(body).optJSONObject("output")
            JSONObject()
                .put("ok", true)
                .put("status", out?.optString("status", "").orEmpty())
                .put("target_model", out?.optString("target_model", "").orEmpty())
                .toString()
        }.getOrElse { e ->
            JSONObject().put("ok", false).put("message", e.message ?: "查询克隆音色失败").toString()
        }
    }

    private fun mimeOf(bytes: ByteArray): String = when {
        bytes.size >= 4 && bytes[0] == 0x52.toByte() && bytes[1] == 0x49.toByte() && bytes[2] == 0x46.toByte() && bytes[3] == 0x46.toByte() -> "audio/wav"
        bytes.size >= 4 && bytes[0] == 0x4f.toByte() && bytes[1] == 0x67.toByte() && bytes[2] == 0x67.toByte() && bytes[3] == 0x53.toByte() -> "audio/ogg"
        bytes.size >= 4 && bytes[0] == 0x66.toByte() && bytes[1] == 0x74.toByte() && bytes[2] == 0x79.toByte() && bytes[3] == 0x70.toByte() -> "audio/mp4"
        bytes.size >= 3 && bytes[0] == 0x49.toByte() && bytes[1] == 0x44.toByte() && bytes[2] == 0x33.toByte() -> "audio/mpeg"
        bytes.size >= 2 && bytes[0] == 0xff.toByte() && (bytes[1].toInt() and 0xe0) == 0xe0 -> "audio/mpeg"
        else -> "audio/mpeg"
    }

    private fun extOf(mime: String): String = when (mime) {
        "audio/wav" -> "wav"
        "audio/ogg" -> "ogg"
        "audio/mp4" -> "m4a"
        else -> "mp3"
    }

    /** 下载完整音频 (CosyVoice 非流式响应给的是临时 URL) */
    private fun downloadBytes(url: String): ByteArray? {
        return runCatching {
            val conn = open(url, "GET", "", null, null)
            try {
                if (conn.responseCode in 200..299) conn.inputStream.use { it.readBytes() } else null
            } finally {
                conn.disconnect()
            }
        }.getOrNull()
    }

    /* ---------------- 背景音乐资源: 远程下载 + 解压 + 本地状态 ----------------
     * APK 不打包音频; 首次开启/打开 App 时从 BGM_URL 拉取 zip, 解压到应用私有目录
     * (filesDir/bgm, 覆盖升级保留). 播放由 WebViewAssetLoader 的 /bgm-local/ 路径
     * 处理器 (BgmPathHandler) 直接从该目录供流. */

    private val bgmDir: File get() = File(appContext.filesDir, "bgm")

    private fun bgmExpectedFiles(): List<String> =
        listOf("bgm_memory.mp3", "bgm1.m4a", "nori_daily_manifold.mp3")

    private fun bgmAllReady(): Boolean =
        bgmExpectedFiles().all { val f = File(bgmDir, it); f.isFile && f.length() > 0L }

    private fun postBgm(fn: String, json: String) {
        mainHandler.post {
            runCatching {
                webView?.evaluateJavascript("window.$fn && window.$fn(${JSONObject.quote(json)})", null)
            }
        }
    }

    /** 查询背景音乐资源状态 (JSON: ready / missing[]) */
    @android.webkit.JavascriptInterface
    fun bgmStatus(): String {
        return runCatching {
            val missing = bgmExpectedFiles().filter { !(File(bgmDir, it).isFile && File(bgmDir, it).length() > 0L) }
            JSONObject()
                .put("ready", missing.isEmpty())
                .put("missing", JSONArray(missing))
                .toString()
        }.getOrElse {
            JSONObject().put("ready", false).put("missing", JSONArray(bgmExpectedFiles())).toString()
        }
    }

    /** 触发下载 (异步; 进度/结果经 window.__noriBgmRes 回调: stage = progress/done/error) */
    @android.webkit.JavascriptInterface
    fun bgmDownload(): String {
        if (!BGM_DOWNLOADING.compareAndSet(false, true)) return "err:busy"
        ioExecutor.execute {
            var lastErr: Exception? = null
            var ok = false
            // 主链接直出 zip; 兜底再试一次 <url>/bgm.zip
            for (url in listOf(BGM_URL, "$BGM_URL/bgm.zip")) {
                try {
                    downloadAndInstallBgm(url)
                    ok = true
                    break
                } catch (e: Exception) {
                    lastErr = e
                }
            }
            BGM_DOWNLOADING.set(false)
            if (ok) {
                postBgm("__noriBgmRes", JSONObject().put("stage", "done").put("ready", true).toString())
            } else {
                postBgm(
                    "__noriBgmRes",
                    JSONObject().put("stage", "error").put("message", lastErr?.message ?: "下载失败").toString()
                )
            }
        }
        return "ok"
    }

    private fun downloadAndInstallBgm(url: String) {
        bgmDir.mkdirs()
        val tmpZip = File(appContext.cacheDir, "bgm_pack.zip")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
        }
        try {
            if (conn.responseCode !in 200..299) throw RuntimeException("下载失败: HTTP ${conn.responseCode}")
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                FileOutputStream(tmpZip).use { out ->
                    val buf = ByteArray(64 * 1024)
                    var read = 0L
                    var lastPct = -5
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        read += n
                        if (total > 0) {
                            val pct = (read * 100 / total).toInt()
                            if (pct >= lastPct + 5) {
                                lastPct = pct
                                postBgm("__noriBgmRes", JSONObject().put("stage", "progress").put("pct", pct).toString())
                            }
                        }
                    }
                    out.flush()
                }
            }
            // 校验 zip 魔数 (PK), 防止把错误页存成音频包
            java.io.RandomAccessFile(tmpZip, "r").use { raf ->
                val head = ByteArray(2)
                raf.readFully(head)
                if (head[0] != 'P'.code.toByte() || head[1] != 'K'.code.toByte()) {
                    throw RuntimeException("下载内容不是有效的资源包")
                }
            }
            // 解压: 仅取音频条目, 文件名清洗 (与 ModelBridge 同一手法)
            ZipInputStream(tmpZip.inputStream().buffered()).use { zip ->
                var e = zip.nextEntry
                while (e != null) {
                    if (!e.isDirectory) {
                        val name = e.name.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._-]"), "_")
                        if (name.endsWith(".mp3") || name.endsWith(".m4a")) {
                            FileOutputStream(File(bgmDir, name)).use { o -> zip.copyTo(o) }
                        }
                    }
                    zip.closeEntry()
                    e = zip.nextEntry
                }
            }
            if (!bgmAllReady()) throw RuntimeException("资源包内缺少预期音频文件")
        } finally {
            conn.disconnect()
            tmpZip.delete()
        }
    }

    /* ---------------- 按键/番茄钟音效: 远程下载 + 本地供流 ----------------
     * APK **不再打包** assets/sfx (2026-10-02 起): 合成版用户听了觉得差, 原版改成联网下载,
     * 于是包更小、也不再把音效素材分发给公众. 5 个原版 m4a 逐个下到应用私有目录
     * (filesDir/sfx, 覆盖升级保留), 播放由 WebViewAssetLoader 的 /sfx-local/ 路径处理器
     * 供流 —— 与背景音乐的 /bgm-local/ 是**同一套**(同一个 BgmPathHandler, 只是 root 不同).
     *
     * ⚠ 下载源的坑: **文件名写错也返回 HTTP 200** —— 实测 /NOPE.m4a 回 200 + 251KB 的 HTML
     * 首页(Content-Type: text/html). 所以每个文件三条校验一起过才算成功:
     *   ① HTTP 200 ② Content-Type 含 audio 或 video/mp4 ③ 大小 > 500B 且 ≈ 期望值 ±5%
     * 落盘前再看一眼二进制头(ftyp 在偏移 4). 内容不对就当这个文件失败 ——
     * **绝不能把 HTML 存成音效**(存下来只会变成"点了没声"这种最难查的毛病).
     */

    private val sfxDir: File get() = File(appContext.filesDir, "sfx")

    /** 文件名 → 期望字节数 (下载源上的原版大小, 用于 ±5% 校验) */
    private fun sfxExpected(): Map<String, Long> = linkedMapOf(
        "button_click.m4a" to 2113L,
        "start.m4a" to 19571L,
        "complete.m4a" to 25127L,
        "return.m4a" to 3824L,
        "abandon.m4a" to 6394L
    )

    /** 单个音效是否已就绪: 存在 + 不是空壳 + 大小与期望值相符 (±5%) */
    private fun sfxFileOk(f: File, expect: Long): Boolean =
        f.isFile && f.length() > 500L && kotlin.math.abs(f.length() - expect) <= expect / 20

    private fun sfxMissing(): List<String> =
        sfxExpected().filter { (name, expect) -> !sfxFileOk(File(sfxDir, name), expect) }.keys.toList()

    /** 音效资源状态 (JSON: ready / done / total / missing[]) —— 前端据此决定"能不能放"与设置页显示 */
    @android.webkit.JavascriptInterface
    fun sfxStatus(): String {
        return runCatching {
            val missing = sfxMissing()
            JSONObject()
                .put("ready", missing.isEmpty())
                .put("done", sfxExpected().size - missing.size)
                .put("total", sfxExpected().size)
                .put("missing", JSONArray(missing))
                .toString()
        }.getOrElse {
            JSONObject()
                .put("ready", false)
                .put("done", 0)
                .put("total", sfxExpected().size)
                .put("missing", JSONArray(sfxExpected().keys.toList()))
                .toString()
        }
    }

    /** 音效是否全部就绪 (Boolean 版) */
    @android.webkit.JavascriptInterface
    fun sfxReady(): Boolean = sfxMissing().isEmpty()

    /**
     * 下载 5 个音效 (异步, 结束后回调 window.__noriSfxDownloadRes: ok/total/done/failed[]).
     * - 已存在且大小合理的文件**跳过** (重复点「下载音效」不该重复下载)
     * - **个别失败不影响其它**: 逐个下、逐个校验, 失败的只把文件名记进 failed
     * @return "ok" / "err:busy"(已有下载在跑)
     */
    @android.webkit.JavascriptInterface
    fun downloadSfx(): String {
        if (!SFX_DOWNLOADING.compareAndSet(false, true)) return "err:busy"
        ioExecutor.execute {
            val failed = JSONArray()
            var done = 0
            runCatching { sfxDir.mkdirs() }
            for ((name, expect) in sfxExpected()) {
                val target = File(sfxDir, name)
                if (sfxFileOk(target, expect)) {
                    done += 1
                    continue
                }
                target.delete()   // 半截文件 / 上一次落盘的 HTML 首页, 一律先清掉
                if (downloadOneSfx(name, expect, target)) done += 1 else failed.put(name)
            }
            SFX_DOWNLOADING.set(false)
            postToJs(
                "__noriSfxDownloadRes",
                JSONObject()
                    .put("ok", failed.length() == 0)
                    .put("total", sfxExpected().size)
                    .put("done", done)
                    .put("failed", failed)
                    .toString()
            )
        }
        return "ok"
    }

    /** 下载 + 校验**单个**音效 (校验不过返回 false, 目标文件保持不存在) */
    private fun downloadOneSfx(name: String, expect: Long, target: File): Boolean {
        val tmp = File(appContext.cacheDir, "sfx_dl_$name")
        tmp.delete()
        val conn = (URL("$SFX_BASE/$name").openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            instanceFollowRedirects = true
        }
        return try {
            val verified = runCatching { fetchSfx(conn, expect, tmp) }.getOrDefault(false)
            if (!verified) false
            // cache 与 files 同属应用私有目录 (同一分区), rename 一般直接成功; 万一不行再拷一次
            else tmp.renameTo(target) ||
                runCatching { tmp.copyTo(target, overwrite = true); true }.getOrDefault(false)
        } finally {
            conn.disconnect()
            tmp.delete()
        }
    }

    /** 读响应 → 落临时文件 → 校验 (HTTP/类型/大小/魔数)。任何一条不过都返回 false */
    private fun fetchSfx(conn: HttpURLConnection, expect: Long, tmp: File): Boolean {
        if (conn.responseCode !in 200..299) return false
        // ⚠ 名字写错时是 200 + text/html, 类型这一条必须查
        val ctype = conn.contentType.orEmpty().lowercase()
        if (!ctype.contains("audio") && !ctype.contains("video/mp4")) return false
        conn.inputStream.use { input -> FileOutputStream(tmp).use { out -> input.copyTo(out, 64 * 1024) } }
        val size = tmp.length()
        if (size <= 500L) return false
        if (kotlin.math.abs(size - expect) > expect / 20) return false
        // 二进制头: m4a 的 ftyp 盒在偏移 4 (在前 12 字节的 4..8 位置里找)
        val head = ByteArray(12)
        val read = java.io.RandomAccessFile(tmp, "r").use { raf -> raf.read(head) }
        if (read < 8) return false
        for (i in 4..8) {
            if (i + 3 >= head.size) break
            if (head[i] == 'f'.code.toByte() && head[i + 1] == 't'.code.toByte() &&
                head[i + 2] == 'y'.code.toByte() && head[i + 3] == 'p'.code.toByte()
            ) return true
        }
        return false
    }

    companion object {
        private const val MEMORY_FILE = "memory.txt"
        private const val REQ_PICK_VOICE = 2001
        /** 选文本人设的请求码 (0x9A72 = 39538, 与上面的音频选择器离得够远, 不会撞) */
        private const val REQ_PICK_PERSONA = 0x9A72
        private const val BGM_URL = "https://add5ddd5.pinme.dev"
        /** 音效下载源: 5 个原版 m4a 就在根目录 (文件名写错也回 200, 见上面校验) */
        private const val SFX_BASE = "https://59f06f75.pinme.dev"
        /** 音效下载互斥锁: static = 跨 ChatBridge 实例生效 (与 BGM_DOWNLOADING 同理) */
        private val SFX_DOWNLOADING = AtomicBoolean(false)
        /** 下载互斥锁: static = 跨 ChatBridge 实例生效 (Activity 重建后旧下载线程仍在跑,
         *  防止新旧两个线程同时写同一个临时文件) */
        private val BGM_DOWNLOADING = AtomicBoolean(false)
    }
}
