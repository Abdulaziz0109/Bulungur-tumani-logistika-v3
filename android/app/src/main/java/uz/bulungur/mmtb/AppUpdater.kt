package uz.bulungur.mmtb

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import org.json.JSONObject
import java.io.BufferedReader
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

    fun checkForUpdate(activity: Activity, silentIfUpToDate: Boolean) {
        executor.execute {
            val release = fetchLatestRelease()
            activity.runOnUiThread {
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread

                if (release == null) {
                    if (!silentIfUpToDate) {
                        Toast.makeText(
                            activity,
                            "Hozircha yangi versiya yo'q (v${BuildConfig.VERSION_NAME})",
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
            .setPositiveButton("Yuklab olish") { _, _ ->
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(release.apkUrl))
                    activity.startActivity(intent)
                } catch (_: Exception) {
                    Toast.makeText(activity, "Yuklab olish havolasini ochib bo'lmadi", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Keyinroq", null)
            .show()
    }
}
