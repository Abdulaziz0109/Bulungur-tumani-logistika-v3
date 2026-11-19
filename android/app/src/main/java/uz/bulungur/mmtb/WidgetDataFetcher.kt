package uz.bulungur.mmtb

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

data class MmtbLocation(
    val id: String,
    val name: String,
    val type: String,
    val lat: Double,
    val lng: Double,
    val mahalla: String = "",
    val distKm: Double = 0.0
)

data class WidgetSnapshot(
    val locations: List<MmtbLocation>,
    val totalMaktab: Int,
    val totalDmtt: Int,
    val hasGps: Boolean,
    val refLat: Double,
    val refLng: Double
)

object WidgetDataFetcher {
    private const val PREFS_NAME = "mmtb_widget_prefs"
    private const val KEY_CACHE_JSON = "locations_cache_json"
    private const val KEY_CACHE_TIME = "locations_cache_time"
    private const val KEY_FILTER = "active_filter"

    private const val FIRESTORE_RUN_QUERY_URL =
        "https://firestore.googleapis.com/v1/projects/aerial-tide-389707/databases/ai-studio-eab0bc31-feff-4322-a7ef-dc4ebf4115db/documents:runQuery"

    private const val BULUNGUR_LAT = 39.7647
    private const val BULUNGUR_LNG = 67.2714

    fun getSavedFilter(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_FILTER, "all") ?: "all"
    }

    fun setSavedFilter(context: Context, filter: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_FILTER, filter)
            .apply()
    }

    fun loadSnapshot(context: Context, forceNetwork: Boolean): WidgetSnapshot {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastFetch = prefs.getLong(KEY_CACHE_TIME, 0L)
        val cachedJson = prefs.getString(KEY_CACHE_JSON, null)
        val isCacheFresh = cachedJson != null && (System.currentTimeMillis() - lastFetch) < 5 * 60 * 1000L

        var rawList: List<MmtbLocation> = if (!forceNetwork && isCacheFresh) {
            parseCachedJson(cachedJson)
        } else {
            val fetched = fetchFromFirestore()
            if (fetched.isNotEmpty()) {
                saveCache(context, fetched)
                fetched
            } else {
                parseCachedJson(cachedJson)
            }
        }

        if (rawList.isEmpty()) {
            rawList = fallbackLocations()
        }

        val (refLat, refLng, hasGps) = resolveBestLocation(context)
        val withDistance = rawList.map { loc ->
            loc.copy(distKm = haversineKm(refLat, refLng, loc.lat, loc.lng))
        }.sortedBy { it.distKm }

        val totalMaktab = withDistance.count { it.type == "maktab" }
        val totalDmtt = withDistance.count { it.type == "dmtt" || it.type == "bogcha" }

        return WidgetSnapshot(
            locations = withDistance,
            totalMaktab = totalMaktab,
            totalDmtt = totalDmtt,
            hasGps = hasGps,
            refLat = refLat,
            refLng = refLng
        )
    }

    private fun fetchFromFirestore(): List<MmtbLocation> {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(FIRESTORE_RUN_QUERY_URL)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 7000
                readTimeout = 8000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            }

            val body = """{"structuredQuery":{"from":[{"collectionId":"locations"}],"limit":250}}"""
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { writer ->
                writer.write(body)
                writer.flush()
            }

            if (conn.responseCode !in 200..299) {
                return emptyList()
            }

            val responseText = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use {
                it.readText()
            }
            parseFirestoreRunQueryResponse(responseText)
        } catch (_: Exception) {
            emptyList()
        } finally {
            conn?.disconnect()
        }
    }

    private fun parseFirestoreRunQueryResponse(jsonText: String): List<MmtbLocation> {
        val result = mutableListOf<MmtbLocation>()
        val arr = JSONArray(jsonText)
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val doc = item.optJSONObject("document") ?: continue
            val docPath = doc.optString("name", "")
            val id = docPath.substringAfterLast('/', "loc_$i")
            val fields = doc.optJSONObject("fields") ?: continue

            val name = readStringField(fields, "name")
            val type = readStringField(fields, "type").lowercase(Locale.ROOT)
            val mahalla = readStringField(fields, "mahalla")
            val lat = readDoubleField(fields, "lat")
            val lng = readDoubleField(fields, "lng")

            if (name.isNotBlank() && lat != null && lng != null) {
                result.add(MmtbLocation(id = id, name = name, type = type, lat = lat, lng = lng, mahalla = mahalla))
            }
        }
        return result
    }

    private fun readStringField(fields: JSONObject, key: String): String {
        val obj = fields.optJSONObject(key) ?: return ""
        return obj.optString("stringValue", "")
    }

    private fun readDoubleField(fields: JSONObject, key: String): Double? {
        val obj = fields.optJSONObject(key) ?: return null
        if (obj.has("doubleValue")) return obj.optDouble("doubleValue")
        if (obj.has("integerValue")) return obj.optString("integerValue").toDoubleOrNull()
        return null
    }

    private fun saveCache(context: Context, list: List<MmtbLocation>) {
        val arr = JSONArray()
        for (loc in list) {
            arr.put(
                JSONObject().apply {
                    put("id", loc.id)
                    put("name", loc.name)
                    put("type", loc.type)
                    put("lat", loc.lat)
                    put("lng", loc.lng)
                    put("mahalla", loc.mahalla)
                }
            )
        }
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CACHE_JSON, arr.toString())
            .putLong(KEY_CACHE_TIME, System.currentTimeMillis())
            .apply()
    }

    private fun parseCachedJson(jsonText: String?): List<MmtbLocation> {
        if (jsonText.isNullOrBlank()) return emptyList()
        return try {
            val arr = JSONArray(jsonText)
            val list = mutableListOf<MmtbLocation>()
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                list.add(
                    MmtbLocation(
                        id = obj.optString("id", "loc_$i"),
                        name = obj.optString("name", ""),
                        type = obj.optString("type", ""),
                        lat = obj.optDouble("lat", BULUNGUR_LAT),
                        lng = obj.optDouble("lng", BULUNGUR_LNG),
                        mahalla = obj.optString("mahalla", "")
                    )
                )
            }
            list
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun resolveBestLocation(context: Context): Triple<Double, Double, Boolean> {
        val hasFine = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val hasCoarse = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasFine && !hasCoarse) {
            return Triple(BULUNGUR_LAT, BULUNGUR_LNG, false)
        }

        return try {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            var best: android.location.Location? = null
            for (provider in providers) {
                val loc = try {
                    lm?.getLastKnownLocation(provider)
                } catch (_: SecurityException) {
                    null
                }
                if (loc != null && (best == null || loc.time > best.time)) {
                    best = loc
                }
            }
            if (best != null) {
                Triple(best.latitude, best.longitude, true)
            } else {
                Triple(BULUNGUR_LAT, BULUNGUR_LNG, false)
            }
        } catch (_: Exception) {
            Triple(BULUNGUR_LAT, BULUNGUR_LNG, false)
        }
    }

    fun haversineKm(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6371.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = sin(dLat / 2).pow(2.0) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
            sin(dLng / 2).pow(2.0)
        return 2 * r * atan2(sqrt(a), sqrt(1 - a))
    }

    fun buildYandexUrl(loc: MmtbLocation, hasGps: Boolean, refLat: Double, refLng: Double): String {
        val rtext = if (hasGps) {
            String.format(Locale.US, "%.6f,%.6f~%.6f,%.6f", refLat, refLng, loc.lat, loc.lng)
        } else {
            String.format(Locale.US, "~%.6f,%.6f", loc.lat, loc.lng)
        }
        return "https://yandex.uz/maps/?rtext=$rtext&rtt=auto"
    }

    fun buildGoogleUrl(loc: MmtbLocation): String {
        return String.format(
            Locale.US,
            "https://www.google.com/maps/dir/?api=1&destination=%.6f,%.6f&travelmode=driving",
            loc.lat,
            loc.lng
        )
    }

    private fun fallbackLocations(): List<MmtbLocation> = listOf(
        MmtbLocation("f1", "9-DMTT (Bog'cha)", "dmtt", 39.7652, 67.2725, "Mehrjon MFY"),
        MmtbLocation("f2", "1-maktab", "maktab", 39.7634, 67.2770, "Bulung'ur markazi"),
        MmtbLocation("f3", "10-bog'cha", "dmtt", 39.7660, 67.2690, "Bulung'ur markazi"),
        MmtbLocation("f4", "4-maktab", "maktab", 39.7265, 67.3260, "Sho'ra")
    )
}
