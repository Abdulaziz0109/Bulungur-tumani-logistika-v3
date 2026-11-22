package uz.bulungur.mmtb

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    companion object {
        const val BASE_URL = "https://bulungur-logistika.vercel.app"
        const val EXTRA_START_PATH = "extra_start_path"
        private const val LOCATION_PERMISSION_REQUEST = 1001
    }

    private lateinit var webView: WebView
    private lateinit var loadingOverlay: LinearLayout
    private lateinit var progressBar: ProgressBar
    private var currentLoadedPath: String? = null
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    inner class AndroidBridge {
        @JavascriptInterface
        fun syncLocations(json: String) {
            if (WidgetDataFetcher.saveExternalLocationsJson(applicationContext, json)) {
                val activeFilter = WidgetDataFetcher.getSavedFilter(applicationContext)
                val refreshIntent = Intent(applicationContext, MmtbWidgetProvider::class.java).apply {
                    action = MmtbWidgetProvider.ACTION_SET_FILTER
                    putExtra(MmtbWidgetProvider.EXTRA_FILTER, activeFilter)
                }
                applicationContext.sendBroadcast(refreshIntent)
            }
        }

        @JavascriptInterface
        fun checkForUpdate() {
            runOnUiThread {
                AppUpdater.checkForUpdate(this@MainActivity, silentIfUpToDate = false)
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return BuildConfig.VERSION_NAME
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0F172A"))
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#F8FAFC"))
        }
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        // Slim top progress bar during navigation
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 15
            isIndeterminate = false
        }
        root.addView(
            progressBar,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                8,
                Gravity.TOP
            )
        )

        // Instant dark splash overlay while the map bundle initializes on slow LTE
        loadingOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0F172A"))
            setPadding(48, 48, 48, 48)

            addView(
                TextView(this@MainActivity).apply {
                    text = "Bulung'ur MMTB"
                    setTextColor(Color.WHITE)
                    textSize = 22f
                    setTypeface(null, android.graphics.Typeface.BOLD)
                    gravity = Gravity.CENTER
                }
            )
            addView(
                TextView(this@MainActivity).apply {
                    text = "Xarita yuklanmoqda..."
                    setTextColor(Color.parseColor("#94A3B8"))
                    textSize = 13f
                    gravity = Gravity.CENTER
                    setPadding(0, 12, 0, 28)
                }
            )
            addView(ProgressBar(this@MainActivity))
            addView(
                TextView(this@MainActivity).apply {
                    text = "🔍 Oflayn tezkor qidiruv"
                    setTextColor(Color.WHITE)
                    textSize = 13f
                    setTypeface(null, android.graphics.Typeface.BOLD)
                    setBackgroundResource(R.drawable.widget_pill_active)
                    setPadding(36, 20, 36, 20)
                    val lp = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    lp.topMargin = 40
                    layoutParams = lp
                    setOnClickListener {
                        startActivity(Intent(this@MainActivity, QuickSearchActivity::class.java))
                    }
                }
            )
        }
        root.addView(
            loadingOverlay,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        setContentView(root)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.setGeolocationEnabled(true)
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.allowFileAccess = false
        settings.mediaPlaybackRequiresUserGesture = false

        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageCommitVisible(view: WebView?, url: String?) {
                super.onPageCommitVisible(view, url)
                hideLoadingOverlay()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                hideLoadingOverlay()
                progressBar.visibility = View.GONE
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                val host = uri.host?.lowercase() ?: ""
                val scheme = uri.scheme?.lowercase() ?: ""

                // Keep our own web app inside WebView
                if (host.contains("bulungur-logistika.vercel.app") ||
                    host.contains("firebaseapp.com") ||
                    host.contains("accounts.google.com")
                ) {
                    return false
                }

                // Launch Yandex Navigator, Google Maps, Telegram, phone calls natively
                if (scheme in listOf("geo", "tel", "mailto", "yandexnavi", "yandexmaps", "intent", "tg") ||
                    host.contains("yandex.") ||
                    host.contains("google.com") ||
                    host.contains("maps.app.goo.gl") ||
                    host.contains("t.me")
                ) {
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        true
                    } catch (_: Exception) {
                        false
                    }
                }
                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                if (newProgress >= 65) {
                    hideLoadingOverlay()
                }
                if (newProgress >= 100) {
                    progressBar.visibility = View.GONE
                } else {
                    progressBar.visibility = View.VISIBLE
                }
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                if (hasLocationPermission()) {
                    callback?.invoke(origin, true, false)
                } else {
                    pendingGeoOrigin = origin
                    pendingGeoCallback = callback
                    requestLocationPermission()
                }
            }
        }

        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                request.setMimeType(mimeType)
                request.addRequestHeader("User-Agent", userAgent)
                val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
                request.setTitle(fileName)
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this, "Yuklab olinmoqda: $fileName", Toast.LENGTH_SHORT).show()
            } catch (_: Exception) {
                Toast.makeText(this, "Faylni yuklab bo'lmadi", Toast.LENGTH_SHORT).show()
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })

        if (!hasLocationPermission()) {
            requestLocationPermission()
        } else {
            MmtbWidgetProvider.scheduleSmartAutoUpdates(this)
        }

        // Automatically check GitHub Releases for newer APK versions on launch
        AppUpdater.checkForUpdate(this, silentIfUpToDate = true)

        loadStartUrl(intent)
    }

    override fun onPause() {
        super.onPause()
        // Silently refresh widget with the latest local GPS fix when returning to Home screen
        if (hasLocationPermission()) {
            val tickIntent = Intent(this, MmtbWidgetProvider::class.java).apply {
                action = MmtbWidgetProvider.ACTION_PASSIVE_LOCATION
            }
            sendBroadcast(tickIntent)
        }
    }

    private fun hideLoadingOverlay() {
        if (loadingOverlay.visibility == View.VISIBLE) {
            loadingOverlay.visibility = View.GONE
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadStartUrl(intent)
    }

    private fun loadStartUrl(intent: Intent?) {
        val path = intent?.getStringExtra(EXTRA_START_PATH) ?: "/"
        val cleanPath = if (path.startsWith("/")) path else "/$path"
        if (cleanPath == currentLoadedPath && !webView.url.isNullOrBlank()) {
            return
        }
        currentLoadedPath = cleanPath
        webView.loadUrl("$BASE_URL$cleanPath")
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestLocationPermission() {
        ActivityCompat.requestPermissions(
            this,
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ),
            LOCATION_PERMISSION_REQUEST
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == LOCATION_PERMISSION_REQUEST) {
            val granted = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
            pendingGeoCallback?.invoke(pendingGeoOrigin, granted, false)
            pendingGeoCallback = null
            pendingGeoOrigin = null

            if (granted) {
                MmtbWidgetProvider.scheduleSmartAutoUpdates(this)
            }

            val refreshIntent = Intent(this, MmtbWidgetProvider::class.java).apply {
                action = MmtbWidgetProvider.ACTION_REFRESH
            }
            sendBroadcast(refreshIntent)
        }
    }
}
