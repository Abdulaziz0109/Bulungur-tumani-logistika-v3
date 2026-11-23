package uz.bulungur.mmtb

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sinh
import kotlin.math.tan

data class RoutePathResult(
    val points: List<Pair<Double, Double>>,
    val distanceMeters: Double,
    val durationSeconds: Double,
    val isRoadRoute: Boolean
)

data class RenderedWidgetMap(
    val bitmap: Bitmap,
    val effectiveZoom: Int,
    val routeResult: RoutePathResult
)

/**
 * Pure Android Canvas renderer for the live home-screen widget map & shared tile/OSRM cache
 * used by both MmtbWidgetProvider and FloatingMapActivity.
 */
object WidgetMapRenderer {
    private const val TILE_SIZE = 256.0
    private const val USER_AGENT = "BulungurMMTBWidget/1.1 (Android)"
    private const val TILE_MAX_AGE_MS = 14L * 24L * 60L * 60L * 1000L

    private var lastRouteKey: String? = null
    private var lastRouteResult: RoutePathResult? = null
    private var lastRouteTimeMs: Long = 0L

    fun latLngToWorldPixel(lat: Double, lng: Double, zoom: Double): Pair<Double, Double> {
        val clampedLat = lat.coerceIn(-85.0511, 85.0511)
        val scale = TILE_SIZE * 2.0.pow(zoom)
        val x = (lng + 180.0) / 360.0 * scale
        val latRad = Math.toRadians(clampedLat)
        val y = (1.0 - ln(tan(latRad) + 1.0 / cos(latRad)) / PI) / 2.0 * scale
        return Pair(x, y)
    }

    fun worldPixelToLatLng(wx: Double, wy: Double, zoom: Double): Pair<Double, Double> {
        val scale = TILE_SIZE * 2.0.pow(zoom)
        val lng = wx / scale * 360.0 - 180.0
        val n = PI - 2.0 * PI * wy / scale
        val lat = Math.toDegrees(atan(sinh(n)))
        return Pair(lat, lng)
    }

    /**
     * Automatically picks the tightest integer zoom level (11..17) so both the user's location
     * and the entire road route to the nearest facility fit cleanly with padding:
     * far away -> zoomed out overview; getting closer -> zoomed in closely!
     */
    fun computeAutoZoom(
        points: List<Pair<Double, Double>>,
        widthPx: Int,
        heightPx: Int
    ): Int {
        if (points.isEmpty()) return 14
        var minLat = Double.MAX_VALUE
        var maxLat = -Double.MAX_VALUE
        var minLng = Double.MAX_VALUE
        var maxLng = -Double.MAX_VALUE
        for ((lat, lng) in points) {
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
            if (lng < minLng) minLng = lng
            if (lng > maxLng) maxLng = lng
        }

        val usableW = widthPx * 0.68
        val usableH = heightPx * 0.62

        for (z in 17 downTo 11) {
            val topLeft = latLngToWorldPixel(maxLat, minLng, z.toDouble())
            val bottomRight = latLngToWorldPixel(minLat, maxLng, z.toDouble())
            val spanX = kotlin.math.abs(bottomRight.first - topLeft.first)
            val spanY = kotlin.math.abs(bottomRight.second - topLeft.second)
            if (spanX <= usableW && spanY <= usableH) {
                return z
            }
        }
        return 11
    }

    fun fetchRoadRoute(
        fromLat: Double,
        fromLng: Double,
        destLat: Double,
        destLng: Double,
        destId: String,
        allowNetwork: Boolean = true
    ): RoutePathResult {
        val roundedKey = String.format(
            Locale.US,
            "%.4f,%.4f->%s",
            fromLat,
            fromLng,
            destId
        )
        val now = System.currentTimeMillis()
        val cached = lastRouteResult
        if (cached != null && lastRouteKey == roundedKey && (now - lastRouteTimeMs) < 3 * 60 * 1000L) {
            return cached
        }

        val fallbackDist = WidgetDataFetcher.haversineKm(fromLat, fromLng, destLat, destLng) * 1000.0
        val fallback = RoutePathResult(
            points = listOf(Pair(fromLat, fromLng), Pair(destLat, destLng)),
            distanceMeters = fallbackDist,
            durationSeconds = fallbackDist / 9.0,
            isRoadRoute = false
        )

        if (!allowNetwork || fallbackDist < 25.0) {
            return fallback
        }

        var conn: HttpURLConnection? = null
        return try {
            val urlStr = String.format(
                Locale.US,
                "https://router.project-osrm.org/route/v1/driving/%.6f,%.6f;%.6f,%.6f?overview=simplified&geometries=geojson",
                fromLng,
                fromLat,
                destLng,
                destLat
            )
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 4500
                readTimeout = 4500
                setRequestProperty("User-Agent", USER_AGENT)
            }
            if (conn.responseCode !in 200..299) {
                return fallback
            }
            val text = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use {
                it.readText()
            }
            val json = JSONObject(text)
            val routes = json.optJSONArray("routes") ?: return fallback
            if (routes.length() == 0) return fallback
            val route = routes.getJSONObject(0)
            val dist = route.optDouble("distance", fallbackDist)
            val dur = route.optDouble("duration", fallbackDist / 9.0)
            val geom = route.optJSONObject("geometry") ?: return fallback
            val coords = geom.optJSONArray("coordinates") ?: return fallback

            val pts = ArrayList<Pair<Double, Double>>(coords.length())
            for (i in 0 until coords.length()) {
                val c = coords.optJSONArray(i) ?: continue
                if (c.length() >= 2) {
                    pts.add(Pair(c.getDouble(1), c.getDouble(0)))
                }
            }
            if (pts.size < 2) return fallback

            val res = RoutePathResult(
                points = pts,
                distanceMeters = dist,
                durationSeconds = dur,
                isRoadRoute = true
            )
            lastRouteKey = roundedKey
            lastRouteResult = res
            lastRouteTimeMs = now
            res
        } catch (_: Exception) {
            fallback
        } finally {
            conn?.disconnect()
        }
    }

    fun loadTileBitmap(
        context: Context,
        zoom: Int,
        tileX: Int,
        tileY: Int,
        allowNetwork: Boolean = true
    ): Bitmap? {
        val maxTile = 1 shl zoom
        if (tileY < 0 || tileY >= maxTile) return null
        val wrappedX = ((tileX % maxTile) + maxTile) % maxTile

        val cacheDir = File(context.cacheDir, "map_tiles/$zoom/$wrappedX")
        val tileFile = File(cacheDir, "$tileY.png")

        if (tileFile.exists() && tileFile.length() > 100L) {
            val age = System.currentTimeMillis() - tileFile.lastModified()
            if (age < TILE_MAX_AGE_MS || !allowNetwork) {
                val decoded = BitmapFactory.decodeFile(tileFile.absolutePath)
                if (decoded != null) return decoded
            }
        }

        if (!allowNetwork) return null

        val urls = listOf(
            "https://a.basemaps.cartocdn.com/rastertiles/voyager/$zoom/$wrappedX/$tileY.png",
            "https://tile.openstreetmap.org/$zoom/$wrappedX/$tileY.png"
        )

        for (tileUrl in urls) {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(tileUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 3500
                    readTimeout = 3500
                    setRequestProperty("User-Agent", USER_AGENT)
                }
                if (conn.responseCode in 200..299) {
                    val bytes = conn.inputStream.use { it.readBytes() }
                    if (bytes.size > 100) {
                        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (bmp != null) {
                            try {
                                cacheDir.mkdirs()
                                FileOutputStream(tileFile).use { fos ->
                                    fos.write(bytes)
                                }
                            } catch (_: Exception) {
                                // Ignore cache write failure
                            }
                            return bmp
                        }
                    }
                }
            } catch (_: Exception) {
                // Try fallback provider
            } finally {
                conn?.disconnect()
            }
        }

        return if (tileFile.exists()) BitmapFactory.decodeFile(tileFile.absolutePath) else null
    }

    /**
     * Renders a crisp RGB_565 (~380 KB, Binder-safe) map bitmap with real tiles,
     * road route polyline, auto-zoom framing, user blue GPS dot, and nearest facility pin.
     */
    fun renderWidgetMapBitmap(
        context: Context,
        snapshot: WidgetSnapshot,
        nearest: MmtbLocation?,
        nearbyOthers: List<MmtbLocation>,
        zoomOffset: Int,
        widthPx: Int = 600,
        heightPx: Int = 320
    ): RenderedWidgetMap {
        val routeResult = if (nearest != null) {
            fetchRoadRoute(
                fromLat = snapshot.refLat,
                fromLng = snapshot.refLng,
                destLat = nearest.lat,
                destLng = nearest.lng,
                destId = nearest.id,
                allowNetwork = true
            )
        } else {
            RoutePathResult(
                points = listOf(Pair(snapshot.refLat, snapshot.refLng)),
                distanceMeters = 0.0,
                durationSeconds = 0.0,
                isRoadRoute = false
            )
        }

        val framePoints = if (nearest != null) {
            routeResult.points + Pair(snapshot.refLat, snapshot.refLng) + Pair(nearest.lat, nearest.lng)
        } else {
            listOf(Pair(snapshot.refLat, snapshot.refLng))
        }

        val autoZoom = computeAutoZoom(framePoints, widthPx, heightPx)
        val zoom = (autoZoom + zoomOffset).coerceIn(10, 17)

        // Center on the bounding box of the route so both origin and destination are nicely framed
        var minLat = Double.MAX_VALUE
        var maxLat = -Double.MAX_VALUE
        var minLng = Double.MAX_VALUE
        var maxLng = -Double.MAX_VALUE
        for ((lat, lng) in framePoints) {
            minLat = min(minLat, lat)
            maxLat = max(maxLat, lat)
            minLng = min(minLng, lng)
            maxLng = max(maxLng, lng)
        }
        val centerLat = (minLat + maxLat) / 2.0
        val centerLng = (minLng + maxLng) / 2.0

        val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.RGB_565)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.parseColor("#E2E8F0"))

        val centerWorld = latLngToWorldPixel(centerLat, centerLng, zoom.toDouble())
        val originWorldX = centerWorld.first - widthPx / 2.0
        val originWorldY = centerWorld.second - heightPx / 2.0

        // 1. Draw stitched map tiles
        val startTileX = floor(originWorldX / TILE_SIZE).toInt()
        val endTileX = floor((originWorldX + widthPx) / TILE_SIZE).toInt()
        val startTileY = floor(originWorldY / TILE_SIZE).toInt()
        val endTileY = floor((originWorldY + heightPx) / TILE_SIZE).toInt()

        val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG)
        var drawnAnyTile = false
        for (tx in startTileX..endTileX) {
            for (ty in startTileY..endTileY) {
                val tileBmp = loadTileBitmap(context, zoom, tx, ty, allowNetwork = true)
                if (tileBmp != null) {
                    val left = (tx * TILE_SIZE - originWorldX).toFloat()
                    val top = (ty * TILE_SIZE - originWorldY).toFloat()
                    canvas.drawBitmap(tileBmp, left, top, tilePaint)
                    tileBmp.recycle()
                    drawnAnyTile = true
                }
            }
        }

        // Subtle offline grid fallback when tiles can't load
        if (!drawnAnyTile) {
            canvas.drawColor(Color.parseColor("#1E293B"))
            val gridPaint = Paint().apply {
                color = Color.parseColor("#334155")
                strokeWidth = 1f
            }
            var gx = 0f
            while (gx < widthPx) {
                canvas.drawLine(gx, 0f, gx, heightPx.toFloat(), gridPaint)
                gx += 48f
            }
            var gy = 0f
            while (gy < heightPx) {
                canvas.drawLine(0f, gy, widthPx.toFloat(), gy, gridPaint)
                gy += 48f
            }
        }

        fun toScreen(lat: Double, lng: Double): Pair<Float, Float> {
            val wp = latLngToWorldPixel(lat, lng, zoom.toDouble())
            return Pair((wp.first - originWorldX).toFloat(), (wp.second - originWorldY).toFloat())
        }

        // 2. Draw secondary nearby markers for spatial context
        val otherFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        val otherStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.WHITE
            strokeWidth = 2.5f
        }
        for (loc in nearbyOthers.take(12)) {
            if (nearest != null && loc.id == nearest.id) continue
            val (sx, sy) = toScreen(loc.lat, loc.lng)
            if (sx < -12f || sx > widthPx + 12f || sy < -12f || sy > heightPx + 12f) continue
            otherFillPaint.color = when (loc.type) {
                "maktab" -> Color.parseColor("#38BDF8")
                "dmtt", "bogcha" -> Color.parseColor("#FB7185")
                else -> Color.parseColor("#34D399")
            }
            canvas.drawCircle(sx, sy, 6f, otherFillPaint)
            canvas.drawCircle(sx, sy, 6f, otherStrokePaint)
        }

        // 3. Draw road route polyline
        if (routeResult.points.size >= 2) {
            val path = Path()
            routeResult.points.forEachIndexed { idx, (lat, lng) ->
                val (sx, sy) = toScreen(lat, lng)
                if (idx == 0) path.moveTo(sx, sy) else path.lineTo(sx, sy)
            }

            val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = Color.WHITE
                strokeWidth = 11f
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
            }
            val routePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = if (routeResult.isRoadRoute) Color.parseColor("#0284C7") else Color.parseColor("#F59E0B")
                strokeWidth = 6.5f
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
                if (!routeResult.isRoadRoute) {
                    pathEffect = DashPathEffect(floatArrayOf(12f, 10f), 0f)
                }
            }
            canvas.drawPath(path, haloPaint)
            canvas.drawPath(path, routePaint)
        }

        // 4. Draw User GPS Dot
        val (ux, uy) = toScreen(snapshot.refLat, snapshot.refLng)
        val userHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#442563EB")
            style = Paint.Style.FILL
        }
        val userWhitePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            style = Paint.Style.FILL
        }
        val userCorePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#2563EB")
            style = Paint.Style.FILL
        }
        canvas.drawCircle(ux, uy, 17f, userHaloPaint)
        canvas.drawCircle(ux, uy, 10f, userWhitePaint)
        canvas.drawCircle(ux, uy, 7f, userCorePaint)

        // 5. Draw Nearest Destination Pin + Crisp Label Pill
        if (nearest != null) {
            val (dx, dy) = toScreen(nearest.lat, nearest.lng)
            val pinColor = when (nearest.type) {
                "maktab" -> Color.parseColor("#0EA5E9")
                "dmtt", "bogcha" -> Color.parseColor("#EF4444")
                else -> Color.parseColor("#10B981")
            }
            val pinShadow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor("#55000000")
            }
            val pinWhite = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE
            }
            val pinFill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = pinColor
            }
            canvas.drawCircle(dx, dy + 2f, 13f, pinShadow)
            canvas.drawCircle(dx, dy, 12.5f, pinWhite)
            canvas.drawCircle(dx, dy, 9.5f, pinFill)
            canvas.drawCircle(dx, dy, 3.5f, pinWhite)

            // Compact name + road distance pill above pin
            val distKm = if (routeResult.isRoadRoute && routeResult.distanceMeters > 0) {
                routeResult.distanceMeters / 1000.0
            } else {
                nearest.distKm
            }
            val labelText = String.format(Locale.US, "%s · %.1f km", nearest.name, distKm)
            val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE
                textSize = 20f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            }
            val textW = textPaint.measureText(labelText)
            val padX = 14f
            val boxW = textW + padX * 2
            val boxH = 32f
            val rawLeft = dx - boxW / 2f
            val boxLeft = rawLeft.coerceIn(8f, max(8f, widthPx - boxW - 50f))
            val boxTop = (dy - 18f - boxH).coerceIn(8f, max(8f, heightPx - boxH - 36f))
            val pillRect = RectF(boxLeft, boxTop, boxLeft + boxW, boxTop + boxH)

            val pillBg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor("#DD0F172A")
            }
            val pillBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = pinColor
                strokeWidth = 2f
            }
            canvas.drawRoundRect(pillRect, 14f, 14f, pillBg)
            canvas.drawRoundRect(pillRect, 14f, 14f, pillBorder)
            canvas.drawText(labelText, boxLeft + padX, boxTop + 22f, textPaint)
        }

        return RenderedWidgetMap(
            bitmap = bitmap,
            effectiveZoom = zoom,
            routeResult = routeResult
        )
    }
}
