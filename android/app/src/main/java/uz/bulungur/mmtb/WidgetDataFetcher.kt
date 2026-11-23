package uz.bulungur.mmtb

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
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

    // Smart low-battery location cache & redraw throttle keys
    private const val KEY_LAST_FIX_LAT = "last_fix_lat"
    private const val KEY_LAST_FIX_LNG = "last_fix_lng"
    private const val KEY_LAST_FIX_TIME = "last_fix_time"
    private const val KEY_RENDERED_LAT = "rendered_lat"
    private const val KEY_RENDERED_LNG = "rendered_lng"
    private const val KEY_RENDERED_TIME = "rendered_time"
    private const val KEY_RENDERED_FILTER = "rendered_filter"
    private const val KEY_LIVE_GPS = "live_gps_enabled"
    private const val KEY_MAP_ZOOM_OFFSET = "map_zoom_offset"
    private const val KEY_MAP_PROVIDER = "widget_map_provider"

    const val MAP_PROVIDER_GOOGLE = "google"
    const val MAP_PROVIDER_YANDEX = "yandex"

    private const val FIRESTORE_RUN_QUERY_URL =
        "https://firestore.googleapis.com/v1/projects/aerial-tide-389707/databases/ai-studio-eab0bc31-feff-4322-a7ef-dc4ebf4115db/documents:runQuery"

    private const val BULUNGUR_LAT = 39.7647
    private const val BULUNGUR_LNG = 67.2714

    private val locationCallbackExecutor = Executors.newSingleThreadExecutor()

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

    fun isLiveGpsEnabled(context: Context): Boolean {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_LIVE_GPS, false)
    }

    fun setLiveGpsEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_LIVE_GPS, enabled)
            .apply()
    }

    fun getMapZoomOffset(context: Context): Int {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getInt(KEY_MAP_ZOOM_OFFSET, 0)
            .coerceIn(-3, 3)
    }

    fun setMapZoomOffset(context: Context, offset: Int) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putInt(KEY_MAP_ZOOM_OFFSET, offset.coerceIn(-3, 3))
            .apply()
    }

    fun getMapProvider(context: Context): String {
        val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_MAP_PROVIDER, MAP_PROVIDER_GOOGLE)
        return if (raw == MAP_PROVIDER_YANDEX) MAP_PROVIDER_YANDEX else MAP_PROVIDER_GOOGLE
    }

    fun setMapProvider(context: Context, provider: String) {
        val normalized = if (provider.lowercase(Locale.ROOT) == MAP_PROVIDER_YANDEX) {
            MAP_PROVIDER_YANDEX
        } else {
            MAP_PROVIDER_GOOGLE
        }
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MAP_PROVIDER, normalized)
            .apply()
    }

    /**
     * Stores a fresh location received from PASSIVE_PROVIDER or an active fix.
     */
    fun saveLastKnownFix(context: Context, lat: Double, lng: Double, timestampMs: Long = System.currentTimeMillis()) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LAST_FIX_LAT, lat.toString())
            .putString(KEY_LAST_FIX_LNG, lng.toString())
            .putLong(KEY_LAST_FIX_TIME, timestampMs)
            .apply()
    }

    /**
     * Records the exact coordinates & filter last drawn on the home screen widget
     * so stationary background ticks can skip redundant UI redraws (0% CPU waste).
     */
    fun recordRenderedState(context: Context, lat: Double, lng: Double, filter: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RENDERED_LAT, lat.toString())
            .putString(KEY_RENDERED_LNG, lng.toString())
            .putLong(KEY_RENDERED_TIME, System.currentTimeMillis())
            .putString(KEY_RENDERED_FILTER, filter)
            .apply()
    }

    /**
     * Returns true if the user has moved >= minMeters from the last drawn widget location,
     * OR if the filter changed, OR if more than maxAgeMs passed since the last render.
     */
    fun shouldRedrawForLocation(
        context: Context,
        lat: Double,
        lng: Double,
        filter: String,
        minMeters: Double = 150.0,
        maxAgeMs: Long = 30 * 60 * 1000L
    ): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val prevLat = prefs.getString(KEY_RENDERED_LAT, null)?.toDoubleOrNull() ?: return true
        val prevLng = prefs.getString(KEY_RENDERED_LNG, null)?.toDoubleOrNull() ?: return true
        val prevFilter = prefs.getString(KEY_RENDERED_FILTER, null)
        val prevTime = prefs.getLong(KEY_RENDERED_TIME, 0L)

        if (prevFilter != filter) return true
        if ((System.currentTimeMillis() - prevTime) >= maxAgeMs) return true

        val movedMeters = haversineKm(prevLat, prevLng, lat, lng) * 1000.0
        return movedMeters >= minMeters
    }

    /**
     * Called by MainActivity's WebView JavaScript bridge whenever Firestore loads live locations.
     * Ensures the home screen widget always matches the exact 110+ facilities inside the app.
     */
    fun saveExternalLocationsJson(context: Context, jsonText: String): Boolean {
        val parsed = parseCachedJson(jsonText)
        if (parsed.isEmpty()) return false
        saveCache(context, parsed)
        return true
    }

    /**
     * Instant local-only snapshot (<5ms) using cached Firestore data or bundled 110-facility seed.
     * Never blocks on network or active GPS — ideal for the floating widget quick search popup.
     */
    fun loadCachedSnapshotFast(context: Context): WidgetSnapshot {
        val rawList = getLocalLocations(context)
        return buildSnapshot(context, rawList, requestFreshGps = false)
    }

    fun loadSnapshot(
        context: Context,
        forceNetwork: Boolean,
        requestFreshGps: Boolean = false
    ): WidgetSnapshot {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastFetch = prefs.getLong(KEY_CACHE_TIME, 0L)
        val cachedJson = prefs.getString(KEY_CACHE_JSON, null)
        val cachedList = parseCachedJson(cachedJson)
        // Background updates reuse cached locations for up to 6 hours to save battery & mobile data
        val cacheTtlMs = if (forceNetwork) 0L else 6 * 60 * 60 * 1000L
        val isCacheFresh = cachedList.size >= 10 &&
            (System.currentTimeMillis() - lastFetch) < cacheTtlMs

        var rawList: List<MmtbLocation> = if (!forceNetwork && isCacheFresh) {
            cachedList
        } else if (!forceNetwork && cachedList.size >= 10) {
            // Even when cache is older than 6h, refresh gently
            val fetched = fetchFromFirestore()
            if (fetched.isNotEmpty()) {
                saveCache(context, fetched)
                fetched
            } else {
                cachedList
            }
        } else {
            val fetched = fetchFromFirestore()
            if (fetched.isNotEmpty()) {
                saveCache(context, fetched)
                fetched
            } else if (cachedList.isNotEmpty()) {
                cachedList
            } else {
                loadBundledSeedLocations(context)
            }
        }

        if (rawList.isEmpty()) {
            rawList = loadBundledSeedLocations(context)
        }

        return buildSnapshot(context, rawList, requestFreshGps = requestFreshGps)
    }

    private fun getLocalLocations(context: Context): List<MmtbLocation> {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cachedJson = prefs.getString(KEY_CACHE_JSON, null)
        val cachedList = parseCachedJson(cachedJson)
        return if (cachedList.isNotEmpty()) cachedList else loadBundledSeedLocations(context)
    }

    private fun buildSnapshot(
        context: Context,
        rawList: List<MmtbLocation>,
        requestFreshGps: Boolean
    ): WidgetSnapshot {
        val (refLat, refLng, hasGps) = resolveBestLocation(context, requestFreshGps)
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
                connectTimeout = 15000
                readTimeout = 15000
                doInput = true
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                setRequestProperty("Accept", "application/json")
            }

            val body = """{"structuredQuery":{"select":{"fields":[{"fieldPath":"name"},{"fieldPath":"type"},{"fieldPath":"lat"},{"fieldPath":"lng"},{"fieldPath":"mahalla"}]},"from":[{"collectionId":"locations"}],"limit":250}}"""
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
                result.add(
                    MmtbLocation(
                        id = id,
                        name = name,
                        type = type,
                        lat = lat,
                        lng = lng,
                        mahalla = mahalla
                    )
                )
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
                val name = obj.optString("name", "").trim()
                val lat = obj.optDouble("lat", Double.NaN)
                val lng = obj.optDouble("lng", Double.NaN)
                if (name.isNotEmpty() && !lat.isNaN() && !lng.isNaN()) {
                    list.add(
                        MmtbLocation(
                            id = obj.optString("id", "loc_$i"),
                            name = name,
                            type = obj.optString("type", "").lowercase(Locale.ROOT),
                            lat = lat,
                            lng = lng,
                            mahalla = obj.optString("mahalla", "")
                        )
                    )
                }
            }
            list
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun loadBundledSeedLocations(context: Context): List<MmtbLocation> {
        return try {
            val jsonText = context.assets.open("locations_seed.json").bufferedReader(Charsets.UTF_8).use {
                it.readText()
            }
            parseCachedJson(jsonText)
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun hasLocationPermission(context: Context): Boolean {
        val hasFine = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val hasCoarse = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return hasFine || hasCoarse
    }

    @SuppressLint("MissingPermission")
    fun resolveBestLocation(
        context: Context,
        requestFreshFixIfStale: Boolean = false
    ): Triple<Double, Double, Boolean> {
        if (!hasLocationPermission(context)) {
            return Triple(BULUNGUR_LAT, BULUNGUR_LNG, false)
        }

        return try {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            val providers = mutableListOf(
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                providers.add(0, LocationManager.FUSED_PROVIDER)
            }

            var best: Location? = null
            for (provider in providers) {
                val loc = try {
                    lm?.getLastKnownLocation(provider)
                } catch (_: Exception) {
                    null
                }
                if (loc != null && (best == null || loc.time > best.time)) {
                    best = loc
                }
            }

            // Compare with our last saved passive fix (in case system cleared provider cache)
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val savedLat = prefs.getString(KEY_LAST_FIX_LAT, null)?.toDoubleOrNull()
            val savedLng = prefs.getString(KEY_LAST_FIX_LNG, null)?.toDoubleOrNull()
            val savedTime = prefs.getLong(KEY_LAST_FIX_TIME, 0L)

            val bestTime = best?.time ?: 0L
            val now = System.currentTimeMillis()
            val isStale = (now - maxOf(bestTime, savedTime)) > 90_000L

            // Only request a quick low-power single fix when explicitly requested AND cached fix is stale
            if (requestFreshFixIfStale && isStale && lm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val fresh = requestSingleLowPowerFix(lm)
                if (fresh != null) {
                    saveLastKnownFix(context, fresh.latitude, fresh.longitude, fresh.time)
                    return Triple(fresh.latitude, fresh.longitude, true)
                }
            }

            if (best != null && best.time >= savedTime) {
                saveLastKnownFix(context, best.latitude, best.longitude, best.time)
                Triple(best.latitude, best.longitude, true)
            } else if (savedLat != null && savedLng != null) {
                Triple(savedLat, savedLng, true)
            } else {
                Triple(BULUNGUR_LAT, BULUNGUR_LNG, false)
            }
        } catch (_: Exception) {
            Triple(BULUNGUR_LAT, BULUNGUR_LNG, false)
        }
    }

    /**
     * Requests a single low-power location fix (FUSED on Android 12+, NETWORK on Android 11)
     * with a strict 3.5-second cancellation timeout so the GPS chip is never left running.
     */
    @SuppressLint("MissingPermission")
    private fun requestSingleLowPowerFix(lm: LocationManager): Location? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null

        val candidateProviders = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            candidateProviders.add(LocationManager.FUSED_PROVIDER)
        }
        candidateProviders.add(LocationManager.NETWORK_PROVIDER)
        candidateProviders.add(LocationManager.GPS_PROVIDER)

        val chosenProvider = candidateProviders.firstOrNull { p ->
            try {
                lm.isProviderEnabled(p)
            } catch (_: Exception) {
                false
            }
        } ?: return null

        val resultRef = AtomicReference<Location?>(null)
        val latch = CountDownLatch(1)
        val cancelSignal = CancellationSignal()

        return try {
            lm.getCurrentLocation(
                chosenProvider,
                cancelSignal,
                locationCallbackExecutor
            ) { location ->
                resultRef.set(location)
                latch.countDown()
            }
            if (!latch.await(3500L, TimeUnit.MILLISECONDS)) {
                cancelSignal.cancel()
            }
            resultRef.get()
        } catch (_: SecurityException) {
            cancelSignal.cancel()
            null
        } catch (_: Exception) {
            cancelSignal.cancel()
            null
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
}

