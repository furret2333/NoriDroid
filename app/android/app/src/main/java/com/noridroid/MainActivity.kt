package com.noridroid

import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var errorView: TextView
    private lateinit var assetLoader: WebViewAssetLoader
    private val modelBridge by lazy { ModelBridge(applicationContext) }
    private val chatBridge by lazy { ChatBridge(this) }
    /** 是否处于前台 (onPause 延迟判断悬浮窗是否要启动) */
    private var isResumed = false
    /** "离开前台"的世代号: onPause 排的延迟任务只在自己这一代仍然有效时才动手 */
    private var pauseGeneration = 0

    companion object {
        
        
        private const val ENTRY_URL = "https://appassets.androidplatform.net/assets/web/index.html"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // 排查"切键盘导致应用重启": 进程内每次 onCreate 都留痕 (真重建还是进程被杀, 一看便知)
        LifecycleLog.record(
            this,
            "onCreate",
            "savedState=${savedInstanceState != null} config=${configDetail(resources.configuration)}"
        )

        webView = findViewById(R.id.webView)
        errorView = findViewById(R.id.errorView)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/bgm-local/", BgmPathHandler(java.io.File(filesDir, "bgm")))
            // 音效与 BGM 同一套本地供流: 页面播放 /sfx-local/<文件名>, 文件由 ChatBridge
            // 从远程下到 filesDir/sfx (包内已不再内置音效, 见 ChatBridge.downloadSfx)
            .addPathHandler("/sfx-local/", BgmPathHandler(java.io.File(filesDir, "sfx")))
            .build()

        webView.addJavascriptInterface(modelBridge, "NoriBridge")
        webView.addJavascriptInterface(chatBridge, "NoriChat")
        chatBridge.attach(webView)
        modelBridge.attach(webView)

        setupImmersive()
        setupWebView()
        loadPage()
    }

    private fun setupImmersive() {
        window.statusBarColor = 0xFF0F172A.toInt()
        window.navigationBarColor = 0xFF0F172A.toInt()
        runCatching {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                val controller = window.insetsController ?: return@runCatching
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsets.Type.systemBars())
            } else {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = (
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        or View.SYSTEM_UI_FLAG_FULLSCREEN
                    )
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun setupWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.databaseEnabled = true
        settings.setSupportZoom(false)
        settings.displayZoomControls = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.textZoom = 100
        webView.setBackgroundColor(0xFF0F172A.toInt())
        webView.webChromeClient = object : WebChromeClient() {
            
            override fun onConsoleMessage(message: android.webkit.ConsoleMessage?): Boolean {
                if (message?.message()?.isNotBlank() == true) {
                    android.util.Log.d("WebViewConsole", "${message.message()} [src=${message.sourceId()}:${message.lineNumber()}]")
                }
                return super.onConsoleMessage(message)
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return null
                
                serveModelFile(url.toString())?.let { return it }
                return assetLoader.shouldInterceptRequest(url)
            }

            
            private fun serveModelFile(url: String): WebResourceResponse? {
                val marker = "/live2d/"
                val idx = url.indexOf(marker)
                if (idx < 0) return null
                val rel = url.substring(idx + marker.length)
                if (rel.isBlank()) return null
                val file = File(modelBridge.modelsDir, rel)
                if (!file.exists() || !file.isFile) return null
                val stream = try { file.inputStream() } catch (_: Exception) { return null }
                val mime = mimeFor(rel)
                return WebResourceResponse(mime, null, stream)
            }

            private fun mimeFor(name: String): String = when {
                name.endsWith(".json", true) -> "application/json"
                name.endsWith(".png", true) -> "image/png"
                name.endsWith(".webp", true) -> "image/webp"
                name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
                name.endsWith(".gif", true) -> "image/gif"
                name.endsWith(".moc3", true) -> "application/octet-stream"
                else -> "application/octet-stream"
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    errorView.text = "页面加载失败: ${error?.description}\n请先执行 web-src 下的构建脚本"
                    errorView.visibility = View.VISIBLE
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                errorView.visibility = View.GONE
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            WebSettingsCompat.setForceDark(settings, WebSettingsCompat.FORCE_DARK_OFF)
        }
    }

    private fun loadPage() {
        runCatching {
            assets.open("web/index.html").close()
        }.onFailure {
            errorView.text =
                "前端资源未找到。\n请先在 web-src 目录执行:\n  pnpm install\n  pnpm build\n然后重新构建 APP。"
            errorView.visibility = View.VISIBLE
            return
        }
        webView.loadUrl(ENTRY_URL)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) setupImmersive()
    }

    /**
     * 配置变化 (旋转 / 键盘类型变化 / 密度变化 …)。
     *
     * Manifest 已把 `orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|
     * navigation|density|uiMode` 全部声明为自行处理 —— 所以系统**不再重建 Activity**, 而是回调到这里。
     * 界面本身不用手动重排: 整屏只有 WebView, 尺寸变化由页面的 `resize` 监听处理;
     * 这里只需重刷沉浸式系统栏 (旋转/配置变化后状态栏可能又冒出来)。
     *
     * 留痕的目的: 万一还有没声明的字段触发重建, 日志里能看到究竟是哪一个。
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        LifecycleLog.record(this, "onConfigurationChanged", configDetail(newConfig))
        setupImmersive()
    }

    /** 配置摘要 (只记与"键盘/布局/密度"相关的字段, 便于对照 Manifest 的 configChanges) */
    private fun configDetail(c: Configuration): String = runCatching {
        val hardKeyboard = when (c.keyboard) {
            Configuration.KEYBOARD_NOKEYS -> "nokeys"
            Configuration.KEYBOARD_QWERTY -> "qwerty"
            Configuration.KEYBOARD_12KEY -> "12key"
            else -> "undef"
        }
        val hidden = when (c.keyboardHidden) {
            Configuration.KEYBOARDHIDDEN_NO -> "no"
            Configuration.KEYBOARDHIDDEN_YES -> "yes"
            else -> "undef"
        }
        val nav = when (c.navigation) {
            Configuration.NAVIGATION_NONAV -> "nonav"
            Configuration.NAVIGATION_DPAD -> "dpad"
            Configuration.NAVIGATION_TRACKBALL -> "trackball"
            Configuration.NAVIGATION_WHEEL -> "wheel"
            else -> "undef"
        }
        val orientation = when (c.orientation) {
            Configuration.ORIENTATION_PORTRAIT -> "port"
            Configuration.ORIENTATION_LANDSCAPE -> "land"
            else -> "undef"
        }
        "keyboard=$hardKeyboard keyboardHidden=$hidden navigation=$nav orientation=$orientation " +
            "screen=${c.screenWidthDp}x${c.screenHeightDp} density=${c.densityDpi} uiMode=${c.uiMode}"
    }.getOrDefault("(unavailable)")

    override fun onPause() {
        super.onPause()
        isResumed = false
        val generation = ++pauseGeneration
        LifecycleLog.record(
            this,
            "onPause",
            "gen=$generation changingConfig=${isChangingConfigurations} finishing=${isFinishing}"
        )
        webView.onPause()
        // 应用离开前台: 悬浮窗马上要留在桌面上了 → 先让它**恢复**渲染 (与 onResume 里的暂停成对)
        setFloatPaused(false)
        // 应用离开前台 (HOME/切后台/退出): 延迟后若仍不在前台且开启了悬浮窗, 启动悬浮窗.
        // 覆盖"按 Home 退出"的情况 (onDestroy 只在真正销毁时触发)
        webView.postDelayed({
            try {
                // 此刻应用已后台: Android 8+ 后台 startService 会抛 IllegalStateException,
                // 必须在执行体里接住 —— 原实现 try 只包了 postDelayed 注册, 包不到 1.2s 后
                // 的执行体, 属于主线程崩溃点; 接住后语义 = 后台受限时本次不启动悬浮窗
                //
                // 三重防误启 (配置变化重建 / 中途回前台都不该弹悬浮窗):
                //   ① 本世代已失效 (onResume 又 ++ 过) → 说明用户回来了
                //   ② isResumed → 已经回前台
                //   ③ isChangingConfigurations → 正在为配置变化重建 (onDestroy 里也不启)
                if (generation != pauseGeneration || isResumed || isChangingConfigurations) return@postDelayed
                if (chatBridge.shouldStartFloatOnExit()) {
                    startService(Intent(this, FloatService::class.java).setAction(FloatService.ACTION_SHOW))
                }
            } catch (_: Exception) { /* 忽略 */ }
        }, 1200)
    }

    override fun onResume() {
        super.onResume()
        isResumed = true
        pauseGeneration += 1   // 作废 onPause 排的延迟体: 回到前台不该再启悬浮窗
        LifecycleLog.record(this, "onResume", "changingConfig=${isChangingConfigurations}")
        webView.onResume()
        setupImmersive()
        // 主 App 回到前台: **立刻**让悬浮窗停画, 再去 hide 它。
        //
        // 为什么不能只靠下面的 stopService: 它是延迟 400ms 执行的, 而主 WebView 的渲染循环
        // 在 onResume 这一刻就恢复了 —— 这 400ms 里两个 Live2D 实例同时渲染。
        // 实测 (headless Edge, 两个渲染器并存): 主界面 29fps → 9.5fps; 停掉悬浮窗渲染立刻回到 32fps。
        // 见 tmp-memcheck/probe-main-fps.mjs。
        setFloatPaused(true)
        // 主 App 回到前台时隐藏悬浮窗 (延迟一下, 避免退出时 onResume 误杀刚启动的 Service)
        try {
            webView.postDelayed({
                stopService(Intent(this, FloatService::class.java))
            }, 400)
        } catch (_: Exception) { /* 忽略 */ }
    }

    /**
     * 通知悬浮窗暂停/恢复渲染 (没有任何悬浮窗在显示时服务会自己收走, 见 FloatService.ACTION_SET_PAUSED)。
     * 失败一律吞掉: 悬浮窗只是"锦上添花", 绝不能因为它影响主 App 的前后台切换。
     */
    private fun setFloatPaused(paused: Boolean) {
        try {
            startService(
                Intent(this, FloatService::class.java)
                    .setAction(FloatService.ACTION_SET_PAUSED)
                    .putExtra(FloatService.EXTRA_PAUSED, paused)
            )
        } catch (_: Exception) { /* 忽略 */ }
    }

    /**
     * 销毁。
     *
     * **重建路径必须短路**: Manifest 已声明键盘等配置变化自行处理, 但仍可能有未声明的字段
     * (或系统主动重建) 走到这里。此时 Activity 正在被重建, WebView 却会被 destroy() 掉 ——
     * 表现就是"应用重启 + 聊天状态全丢"。所以 `isChangingConfigurations == true` 时:
     * 不销毁 WebView、不启悬浮窗, 让系统用同一份资源重建。
     */
    override fun onDestroy() {
        val changing = isChangingConfigurations
        LifecycleLog.record(
            this,
            "onDestroy",
            "changingConfig=$changing finishing=$isFinishing"
        )
        if (changing) {
            super.onDestroy()
            return
        }
        webView.stopLoading()
        webView.destroy()
        // 退出应用时: 若开启了悬浮窗且有权, 启动悬浮窗服务 (Nori 留在屏幕)
        try {
            if (chatBridge.shouldStartFloatOnExit()) {
                startService(Intent(this, FloatService::class.java).setAction(FloatService.ACTION_SHOW))
            }
        } catch (_: Exception) { /* 忽略 */ }
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        chatBridge.handlePickResult(requestCode, resultCode, data)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
