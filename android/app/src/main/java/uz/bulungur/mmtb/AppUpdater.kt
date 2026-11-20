package uz.bulungur.mmtb

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

data class ReleaseInfo(
    val versionCode: Int,
    val versionName: String,
    val apkUrl: String,
    val notes: String
)

object AppUpdater {
    private val RELEASE_API_ENDPOINTS = listOf(
        "https://api.github.com/repos/Abdulaziz0109/Bulungur-tumani-logistika-v3/releases/latest",
        "https://api.github.com/repos/Abdulaziz0109/Bulungur-tumani-logistika/releases/latest"
    )

    private val executor = Executors.newSingleThreadExecutor()
    private var pendingInstallFile: File? = null

    fun checkForUpdate(activity: Activity, silentIfUpToDate: Boolean) {
        executor.execute {
            val release = fetchLatestRelease()
            activity.runOnUiThread {
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread

                if (release == null) {
                    if (!silentIfUpToDate) {
                        Toast.makeText(
                            activity,
                            "Yangilanishni tekshirib bo'lmadi. Internetni tekshiring.",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    return@runOnUiThread
                }

                if (release.versionCode > BuildConfig.VERSION_CODE) {
                    showUpdateDialog(activity, release)
                } else if (!silentIfUpToDate) {
                    Toast.makeText(
                        activity,
                        "Sizda eng so'nggi versiya (v${BuildConfig.VERSION_NAME}) o'rnatilgan!",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }
    }

    fun resumePendingInstallIfAny(activity: Activity) {
        val file = pendingInstallFile ?: return
        if (file.exists() && activity.packageManager.canRequestPackageInstalls()) {
            pendingInstallFile = null
            launchApkInstaller(activity, file)
        }
    }

    private fun fetchLatestRelease(): ReleaseInfo? {
        for (endpoint in RELEASE_API_ENDPOINTS) {
            val info = fetchReleaseFromUrl(endpoint)
            if (info != null) return info
        }
        return null
    }

    private fun fetchReleaseFromUrl(endpoint: String): ReleaseInfo? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10000
                readTimeout = 10000
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "Bulungur-MMTB-Android/${BuildConfig.VERSION_NAME}")
            }

            if (conn.responseCode !in 200..299) return null

            val body = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use {
                it.readText()
            }
            val json = JSONObject(body)
            val tagName = json.optString("tag_name", "").trim()
            val notes = json.optString("body", "").trim()
            val assets = json.optJSONArray("assets") ?: return null

            var apkUrl: String? = null
            for (i in 0 until assets.length()) {
                val asset = assets.optJSONObject(i) ?: continue
                val name = asset.optString("name", "")
                val downloadUrl = asset.optString("browser_download_url", "")
                if (name.endsWith(".apk", ignoreCase = true) && downloadUrl.startsWith("https://")) {
                    apkUrl = downloadUrl
                    break
                }
            }
            if (apkUrl == null) return null

            val remoteCode = extractVersionCode(tagName)
            if (remoteCode <= 0) return null

            ReleaseInfo(
                versionCode = remoteCode,
                versionName = tagName.removePrefix("v"),
                apkUrl = apkUrl,
                notes = notes
            )
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun extractVersionCode(tagName: String): Int {
        // Expects tags like v1.0.5 -> 5, or v12 -> 12
        val match = Regex("""(\d+)$""").find(tagName)
        return match?.groupValues?.get(1)?.toIntOrNull() ?: 0
    }

    private fun showUpdateDialog(activity: Activity, release: ReleaseInfo) {
        val message = buildString {
            append("Bulung'ur MMTB ilovasi va vidjeti uchun yangi versiya tayyor (v")
            append(release.versionName)
            append(").\nHozirgi versiya: v")
            append(BuildConfig.VERSION_NAME)
            if (release.notes.isNotBlank()) {
                append("\n\n")
                append(release.notes.take(280))
            }
        }

        AlertDialog.Builder(activity)
            .setTitle("Yangi versiya mavjud!")
            .setMessage(message)
            .setPositiveButton("Yangilash") { _, _ ->
                downloadAndInstallApk(activity, release)
            }
            .setNegativeButton("Keyinroq", null)
            .show()
    }

    private fun downloadAndInstallApk(activity: Activity, release: ReleaseInfo) {
        val paddingPx = (20 * activity.resources.displayMetrics.density).toInt()
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(paddingPx, paddingPx, paddingPx, paddingPx)
        }
        val statusText = TextView(activity).apply {
            text = "Yuklab olinmoqda... 0%"
            textSize = 14f
        }
        val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = false
            max = 100
            progress = 0
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = (12 * activity.resources.displayMetrics.density).toInt()
            }
        }
        container.addView(statusText)
        container.addView(progressBar)

        val progressDialog = AlertDialog.Builder(activity)
            .setTitle("Ilova yangilanmoqda (v${release.versionName})")
            .setView(container)
            .setCancelable(false)
            .create()
        progressDialog.show()

        executor.execute {
            val apkFile = downloadFileFollowingRedirects(
                activity = activity,
                startUrl = release.apkUrl,
                onProgress = { pct ->
                    activity.runOnUiThread {
                        if (!activity.isFinishing && progressDialog.isShowing) {
                            progressBar.progress = pct
                            statusText.text = "Yuklab olinmoqda... $pct%"
                        }
                    }
                }
            )

            activity.runOnUiThread {
                if (progressDialog.isShowing) {
                    progressDialog.dismiss()
                }
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread

                if (apkFile == null || !apkFile.exists()) {
                    Toast.makeText(
                        activity,
                        "Yangilanish faylini yuklab bo'lmadi. Qayta urinib ko'ring.",
                        Toast.LENGTH_LONG
                    ).show()
                    return@runOnUiThread
                }

                installDownloadedApk(activity, apkFile)
            }
        }
    }

    private fun downloadFileFollowingRedirects(
        activity: Activity,
        startUrl: String,
        onProgress: (Int) -> Unit
    ): File? {
        var currentUrl = startUrl
        var conn: HttpURLConnection? = null
        return try {
            var redirects = 0
            while (redirects < 6) {
                conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    connectTimeout = 15000
                    readTimeout = 30000
                    setRequestProperty("User-Agent", "Bulungur-MMTB-Android/${BuildConfig.VERSION_NAME}")
                }
                val code = conn.responseCode
                if (code in listOf(301, 302, 303, 307, 308)) {
                    val nextLocation = conn.getHeaderField("Location") ?: return null
                    conn.disconnect()
                    currentUrl = nextLocation
                    redirects++
                } else {
                    break
                }
            }

            val activeConn = conn ?: return null
            if (activeConn.responseCode !in 200..299) return null

            val totalBytes = activeConn.contentLengthLong
            val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
            if (!dir.exists()) dir.mkdirs()
            val outFile = File(dir, "Bulungur-MMTB-update.apk")
            if (outFile.exists()) outFile.delete()

            activeConn.inputStream.use { input ->
                FileOutputStream(outFile).use { output ->
                    val buffer = ByteArray(16 * 1024)
                    var downloaded = 0L
                    var lastPct = -1
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        output.write(buffer, 0, read)
                        downloaded += read
                        if (totalBytes > 0) {
                            val pct = ((downloaded * 100) / totalBytes).toInt().coerceIn(0, 100)
                            if (pct != lastPct) {
                                lastPct = pct
                                onProgress(pct)
                            }
                        }
                    }
                }
            }
            outFile
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun installDownloadedApk(activity: Activity, apkFile: File) {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            pendingInstallFile = apkFile
            Toast.makeText(
                activity,
                "Yangilash uchun ushbu ilovaga ruxsatni yoqing va orqaga qayting",
                Toast.LENGTH_LONG
            ).show()
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${activity.packageName}")
            )
            activity.startActivity(intent)
            return
        }
        launchApkInstaller(activity, apkFile)
    }

    private fun launchApkInstaller(activity: Activity, apkFile: File) {
        try {
            val contentUri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                apkFile
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(contentUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(
                activity,
                "O'rnatish oynasini ochib bo'lmadi",
                Toast.LENGTH_LONG
            ).show()
        }
    }
}
