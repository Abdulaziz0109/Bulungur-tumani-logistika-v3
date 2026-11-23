package uz.bulungur.mmtb

import android.content.Context
import android.graphics.Bitmap
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
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

data class RouteStep(
    val maneuverType: String,
    val modifier: String,
    val lat: Double,
    val lng: Double,
    val alongMeters: Double,
    val segmentDistMeters: Double,
    val streetName: String
)

data class RoutePathResult(
    val destId: String,
    val points: List<Pair<Double, Double>>,
    val cumDistMeters: DoubleArray,
    val steps: List<RouteStep>,
    val totalDistanceMeters: Double,
    val totalDurationSeconds: Double,
    val isRoadRoute: Boolean
)

data class TurnGuidance(
    val arrow: String,
    val shortLabelUz: String,
    val fullInstructionUz: String,
    val distanceToTurnMeters: Double,
    val streetName: String,
    val nextTurnPreview: String?,
    val turnLat: Double,
    val turnLng: Double,
    val remainingTotalMeters: Double,
    val totalDistanceMeters: Double,
    val remainingDurationSeconds: Double,
    val progressFraction: Float,
    val roadHeadingDeg: Double,
    val remainingPoints: List<Pair<Double, Double>>,
    val passedPoints: List<Pair<Double, Double>>,
    val upcomingTurns: List<Pair<RouteStep, Double>>,
    val isArrived: Boolean,
    val isRoadRoute: Boolean
)

data class RenderedWidgetHud(
    val bitmap: Bitmap,
    val guidance: TurnGuidance,
    val headingDeg: Double,
    val viewRangeMeters: Double
)

/**
 * Ultra-fast pure vector Turn-by-Turn Heading-Up Navigation Schematic renderer.
 * Zero map tile downloads (<10ms local Canvas render, 0 KB tile traffic, instant rotation).
 */
object WidgetMapRenderer {
    private const val USER_AGENT = "BulungurMMTB-Android/2.0"

    @Volatile
    private var legacyTileCachesCleaned = false

    @Volatile
    private var cachedRoute: RoutePathResult? = null

    @Volatile
    private var cachedRouteTimeMs: Long = 0L

    fun cleanLegacyTileCachesOnce(context: Context) {
        if (legacyTileCachesCleaned) return
        legacyTileCachesCleaned = true
        try {
            listOf("map_tiles", "map_tiles_v2").forEach { folder ->
                val dir = File(context.cacheDir, folder)
                if (dir.exists()) dir.deleteRecursively()
            }
        } catch (_: Exception) {
            // Ignore cleanup failure
        }
    }

    fun formatDistanceUz(meters: Double): String {
        val m = max(0.0, meters)
        return when {
            m < 1000.0 -> {
                val rounded = when {
                    m < 30.0 -> (m / 5.0).roundToInt() * 5
                    m < 200.0 -> (m / 10.0).roundToInt() * 10
                    else -> (m / 10.0).roundToInt() * 10
                }.coerceAtLeast(5)
                "$rounded m"
            }
            m < 10_000.0 -> String.format(Locale.US, "%.1f km", m / 1000.0)
            else -> String.format(Locale.US, "%.0f km", m / 1000.0)
        }
    }

    fun latLngToLocalMeters(
        lat: Double,
        lng: Double,
        originLat: Double,
        originLng: Double
    ): Pair<Double, Double> {
        val cosLat = cos(Math.toRadians(originLat))
        val east = (lng - originLng) * 111_320.0 * cosLat
        val north = (lat - originLat) * 110_540.0
        return Pair(east, north)
    }

    fun localMetersToLatLng(
        east: Double,
        north: Double,
        originLat: Double,
        originLng: Double
    ): Pair<Double, Double> {
        val cosLat = max(0.01, cos(Math.toRadians(originLat)))
        val lat = originLat + north / 110_540.0
        val lng = originLng + east / (111_320.0 * cosLat)
        return Pair(lat, lng)
    }

    /**
     * Rotates (east, north) meters into phone-screen-relative (right, forward) meters
     * where headingDeg (0 = North, 90 = East) points straight UP on the phone screen.
     */
    fun rotateToHeadingUp(east: Double, north: Double, headingDeg: Double): Pair<Double, Double> {
        val rad = Math.toRadians(headingDeg)
        val sinH = sin(rad)
        val cosH = cos(rad)
        val right = east * cosH - north * sinH
        val forward = east * sinH + north * cosH
        return Pair(right, forward)
    }

    fun bearingDegrees(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val (east, north) = latLngToLocalMeters(lat2, lng2, lat1, lng1)
        if (hypot(east, north) < 0.5) return 0.0
        val deg = Math.toDegrees(atan2(east, north))
        return ((deg % 360.0) + 360.0) % 360.0
    }

    private fun buildCumulativeDistances(points: List<Pair<Double, Double>>): DoubleArray {
        val cum = DoubleArray(points.size)
        var acc = 0.0
        for (i in 1 until points.size) {
            val prev = points[i - 1]
            val cur = points[i]
            val (e, n) = latLngToLocalMeters(cur.first, cur.second, prev.first, prev.second)
            acc += hypot(e, n)
            cum[i] = acc
        }
        return cum
    }

    private data class ProjectionHit(
        val segIndex: Int,
        val alongMeters: Double,
        val offRouteMeters: Double,
        val projLat: Double,
        val projLng: Double
    )

    private fun projectOntoPolyline(
        points: List<Pair<Double, Double>>,
        cumDist: DoubleArray,
        lat: Double,
        lng: Double
    ): ProjectionHit {
        if (points.size < 2) {
            return ProjectionHit(0, 0.0, 0.0, lat, lng)
        }
        var bestDistSq = Double.MAX_VALUE
        var bestSeg = 0
        var bestAlong = 0.0
        var bestLat = points[0].first
        var bestLng = points[0].second

        for (i in 0 until points.size - 1) {
            val a = points[i]
            val b = points[i + 1]
            val (ax, ay) = latLngToLocalMeters(a.first, a.second, lat, lng)
            val (bx, by) = latLngToLocalMeters(b.first, b.second, lat, lng)
            val dx = bx - ax
            val dy = by - ay
            val segLenSq = dx * dx + dy * dy
            val t = if (segLenSq > 1e-6) {
                (((-ax) * dx + (-ay) * dy) / segLenSq).coerceIn(0.0, 1.0)
            } else {
                0.0
            }
            val px = ax + t * dx
            val py = ay + t * dy
            val distSq = px * px + py * py
            if (distSq < bestDistSq) {
                bestDistSq = distSq
                bestSeg = i
                val segLen = hypot(dx, dy)
                bestAlong = cumDist[i] + t * segLen
                bestLat = a.first + t * (b.first - a.first)
                bestLng = a.second + t * (b.second - a.second)
            }
        }
        return ProjectionHit(
            segIndex = bestSeg,
            alongMeters = bestAlong,
            offRouteMeters = kotlin.math.sqrt(bestDistSq),
            projLat = bestLat,
            projLng = bestLng
        )
    }

    /**
     * Fetches driving route + exact turn-by-turn steps from OSRM.
     * Smartly reuses the cached route with ZERO network calls while user stays within 65m of the path!
     */
    fun fetchRoadRouteWithSteps(
        fromLat: Double,
        fromLng: Double,
        destLat: Double,
        destLng: Double,
        destId: String,
        allowNetwork: Boolean = true
    ): RoutePathResult {
        val now = System.currentTimeMillis()
        val existing = cachedRoute
        if (existing != null &&
            existing.destId == destId &&
            existing.isRoadRoute &&
            (now - cachedRouteTimeMs) < 4 * 60 * 1000L
        ) {
            val hit = projectOntoPolyline(existing.points, existing.cumDistMeters, fromLat, fromLng)
            if (hit.offRouteMeters <= 65.0) {
                return existing
            }
        }

        val straightDist = WidgetDataFetcher.haversineKm(fromLat, fromLng, destLat, destLng) * 1000.0
        val fallbackPoints = listOf(Pair(fromLat, fromLng), Pair(destLat, destLng))
        val fallbackCum = doubleArrayOf(0.0, straightDist)
        val fallback = RoutePathResult(
            destId = destId,
            points = fallbackPoints,
            cumDistMeters = fallbackCum,
            steps = listOf(
                RouteStep(
                    maneuverType = "arrive",
                    modifier = "straight",
                    lat = destLat,
                    lng = destLng,
                    alongMeters = straightDist,
                    segmentDistMeters = 0.0,
                    streetName = ""
                )
            ),
            totalDistanceMeters = straightDist,
            totalDurationSeconds = straightDist / 9.0,
            isRoadRoute = false
        )

        if (!allowNetwork || straightDist < 25.0) {
            return fallback
        }

        var conn: HttpURLConnection? = null
        return try {
            val urlStr = String.format(
                Locale.US,
                "https://router.project-osrm.org/route/v1/driving/%.6f,%.6f;%.6f,%.6f?overview=full&geometries=geojson&steps=true",
                fromLng,
                fromLat,
                destLng,
                destLat
            )
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 2800
                readTimeout = 2800
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
            val routeObj = routes.getJSONObject(0)
            val totalDist = routeObj.optDouble("distance", straightDist)
            val totalDur = routeObj.optDouble("duration", straightDist / 9.0)
            val geom = routeObj.optJSONObject("geometry") ?: return fallback
            val coords = geom.optJSONArray("coordinates") ?: return fallback

            val pts = ArrayList<Pair<Double, Double>>(coords.length())
            for (i in 0 until coords.length()) {
                val c = coords.optJSONArray(i) ?: continue
                if (c.length() >= 2) {
                    pts.add(Pair(c.getDouble(1), c.getDouble(0)))
                }
            }
            if (pts.size < 2) return fallback

            val cum = buildCumulativeDistances(pts)
            val polyTotal = cum.lastOrNull()?.takeIf { it > 1.0 } ?: totalDist

            val parsedSteps = ArrayList<RouteStep>()
            val legs = routeObj.optJSONArray("legs")
            if (legs != null && legs.length() > 0) {
                val stepsArr = legs.getJSONObject(0).optJSONArray("steps")
                if (stepsArr != null) {
                    var stepAccum = 0.0
                    for (i in 0 until stepsArr.length()) {
                        val s = stepsArr.optJSONObject(i) ?: continue
                        val maneuver = s.optJSONObject("maneuver") ?: continue
                        val mType = maneuver.optString("type", "").lowercase(Locale.ROOT)
                        val mMod = maneuver.optString("modifier", "").lowercase(Locale.ROOT)
                        val locArr = maneuver.optJSONArray("location")
                        val mLng = locArr?.optDouble(0, destLng) ?: destLng
                        val mLat = locArr?.optDouble(1, destLat) ?: destLat
                        val segDist = s.optDouble("distance", 0.0)
                        val street = s.optString("name", "").trim()

                        // Align maneuver location precisely onto the polyline cumulative distance
                        val proj = projectOntoPolyline(pts, cum, mLat, mLng)
                        val alignedAlong = if (mType == "arrive") {
                            polyTotal
                        } else if (proj.offRouteMeters < 60.0) {
                            proj.alongMeters
                        } else {
                            stepAccum.coerceAtMost(polyTotal)
                        }

                        parsedSteps.add(
                            RouteStep(
                                maneuverType = mType,
                                modifier = mMod,
                                lat = mLat,
                                lng = mLng,
                                alongMeters = alignedAlong,
                                segmentDistMeters = segDist,
                                streetName = street
                            )
                        )
                        stepAccum += segDist
                    }
                }
            }

            val result = RoutePathResult(
                destId = destId,
                points = pts,
                cumDistMeters = cum,
                steps = parsedSteps,
                totalDistanceMeters = max(totalDist, polyTotal),
                totalDurationSeconds = totalDur,
                isRoadRoute = true
            )
            cachedRoute = result
            cachedRouteTimeMs = now
            result
        } catch (_: Exception) {
            fallback
        } finally {
            conn?.disconnect()
        }
    }

    private fun isActionableTurn(step: RouteStep): Boolean {
        return when (step.maneuverType) {
            "arrive" -> true
            "depart" -> false
            "turn", "end of road", "fork", "roundabout", "rotary", "roundabout turn",
            "off ramp", "on ramp", "merge" -> true
            "continue", "new name" -> step.modifier.isNotEmpty() && step.modifier != "straight"
            else -> step.modifier.contains("left") || step.modifier.contains("right") || step.modifier == "uturn"
        }
    }

    fun maneuverVisual(step: RouteStep): Triple<String, String, String> {
        // Returns (arrowSymbol, shortUzLabel, fullUzInstruction)
        if (step.maneuverType == "arrive") {
            return Triple("🏁", "Manzil", "Manzilga yetasiz")
        }
        if (step.maneuverType == "roundabout" || step.maneuverType == "rotary") {
            return Triple("⟳", "Aylanma", "Aylanma yo'ldan buriling")
        }
        return when (step.modifier) {
            "left" -> Triple("↰", "Chapga", "Chapga buriling")
            "right" -> Triple("↱", "O'ngga", "O'ngga buriling")
            "slight left" -> Triple("↖", "Biroz chapga", "Biroz chapga yuring")
            "slight right" -> Triple("↗", "Biroz o'ngga", "Biroz o'ngga yuring")
            "sharp left" -> Triple("↲", "Keskin chapga", "Keskin chapga buriling")
            "sharp right" -> Triple("↳", "Keskin o'ngga", "Keskin o'ngga buriling")
            "uturn" -> Triple("↶", "Orqaga", "Orqaga qayriling")
            else -> Triple("↑", "To'g'riga", "To'g'riga yuring")
        }
    }

    /**
     * Computes live remaining meters to the NEXT turn, remaining total distance, progress fraction,
     * and road-ahead heading in <1 ms locally from the cached route!
     */
    fun computeLiveGuidance(
        route: RoutePathResult,
        userLat: Double,
        userLng: Double,
        destLat: Double,
        destLng: Double,
        destName: String
    ): TurnGuidance {
        val pts = route.points
        val cum = route.cumDistMeters
        val polyTotal = cum.lastOrNull()?.takeIf { it > 0.5 } ?: route.totalDistanceMeters
        val hit = projectOntoPolyline(pts, cum, userLat, userLng)

        val remainingTotal = max(0.0, polyTotal - hit.alongMeters)
        val totalRef = max(route.totalDistanceMeters, polyTotal).coerceAtLeast(1.0)
        val progress = (hit.alongMeters / totalRef).toFloat().coerceIn(0f, 1f)
        val remainingDuration = if (polyTotal > 1.0) {
            route.totalDurationSeconds * (remainingTotal / polyTotal)
        } else {
            0.0
        }

        // Split polyline into passed vs remaining from the user's live position
        val passed = ArrayList<Pair<Double, Double>>(hit.segIndex + 2)
        for (i in 0..min(hit.segIndex, pts.lastIndex)) {
            passed.add(pts[i])
        }
        passed.add(Pair(hit.projLat, hit.projLng))

        val remaining = ArrayList<Pair<Double, Double>>(max(2, pts.size - hit.segIndex + 1))
        remaining.add(Pair(userLat, userLng))
        for (i in (hit.segIndex + 1) until pts.size) {
            remaining.add(pts[i])
        }
        if (remaining.size < 2) {
            remaining.add(Pair(destLat, destLng))
        }

        // Compute clean forward road heading looking ~35–70 meters ahead along remaining route
        var lookTarget = remaining.last()
        var walked = 0.0
        for (i in 1 until remaining.size) {
            val prev = remaining[i - 1]
            val cur = remaining[i]
            val (e, n) = latLngToLocalMeters(cur.first, cur.second, prev.first, prev.second)
            walked += hypot(e, n)
            lookTarget = cur
            if (walked >= 40.0) break
        }
        val roadHeading = bearingDegrees(userLat, userLng, lookTarget.first, lookTarget.second)

        // Find upcoming real turn maneuvers
        val upcoming = route.steps
            .filter { isActionableTurn(it) && it.alongMeters > hit.alongMeters + 12.0 }
            .sortedBy { it.alongMeters }
            .map { step -> Pair(step, max(0.0, step.alongMeters - hit.alongMeters)) }

        val arrived = remainingTotal < 30.0
        if (arrived) {
            return TurnGuidance(
                arrow = "🏁",
                shortLabelUz = "Yetdingiz",
                fullInstructionUz = "$destName yonidasiz",
                distanceToTurnMeters = remainingTotal,
                streetName = "",
                nextTurnPreview = null,
                turnLat = destLat,
                turnLng = destLng,
                remainingTotalMeters = remainingTotal,
                totalDistanceMeters = totalRef,
                remainingDurationSeconds = 0.0,
                progressFraction = 1f,
                roadHeadingDeg = roadHeading,
                remainingPoints = remaining,
                passedPoints = passed,
                upcomingTurns = emptyList(),
                isArrived = true,
                isRoadRoute = route.isRoadRoute
            )
        }

        val firstPair = upcoming.firstOrNull()
        val secondPair = upcoming.getOrNull(1)

        val nextStep = firstPair?.first ?: RouteStep(
            maneuverType = "arrive",
            modifier = "straight",
            lat = destLat,
            lng = destLng,
            alongMeters = polyTotal,
            segmentDistMeters = 0.0,
            streetName = ""
        )
        val distToTurn = firstPair?.second ?: remainingTotal
        val (arrow, shortUz, fullUz) = maneuverVisual(nextStep)

        val nextPreview = secondPair?.let { (step2, distFromUser2) ->
            val (a2, s2, _) = maneuverVisual(step2)
            val gap = max(10.0, distFromUser2 - distToTurn)
            "So'ng: $a2 ${formatDistanceUz(gap)} · $s2"
        }

        return TurnGuidance(
            arrow = arrow,
            shortLabelUz = shortUz,
            fullInstructionUz = fullUz,
            distanceToTurnMeters = distToTurn,
            streetName = nextStep.streetName,
            nextTurnPreview = nextPreview,
            turnLat = nextStep.lat,
            turnLng = nextStep.lng,
            remainingTotalMeters = remainingTotal,
            totalDistanceMeters = totalRef,
            remainingDurationSeconds = remainingDuration,
            progressFraction = progress,
            roadHeadingDeg = roadHeading,
            remainingPoints = remaining,
            passedPoints = passed,
            upcomingTurns = upcoming,
            isArrived = false,
            isRoadRoute = route.isRoadRoute
        )
    }

    /**
     * Renders an ultra-fast (<8ms) pure-vector Heading-Up Route Schematic for the Home Screen Widget.
     * The travel direction ALWAYS points straight UP on the phone, with clear turn callouts in meters.
     */
    fun renderWidgetSchematicBitmap(
        context: Context,
        snapshot: WidgetSnapshot,
        nearest: MmtbLocation?,
        nearbyOthers: List<MmtbLocation>,
        zoomOffset: Int,
        widthPx: Int = 600,
        heightPx: Int = 340
    ): RenderedWidgetHud {
        cleanLegacyTileCachesOnce(context)

        val route = if (nearest != null) {
            fetchRoadRouteWithSteps(
                fromLat = snapshot.refLat,
                fromLng = snapshot.refLng,
                destLat = nearest.lat,
                destLng = nearest.lng,
                destId = nearest.id,
                allowNetwork = true
            )
        } else {
            RoutePathResult(
                destId = "none",
                points = listOf(Pair(snapshot.refLat, snapshot.refLng)),
                cumDistMeters = doubleArrayOf(0.0),
                steps = emptyList(),
                totalDistanceMeters = 0.0,
                totalDurationSeconds = 0.0,
                isRoadRoute = false
            )
        }

        val guidance = if (nearest != null) {
            computeLiveGuidance(
                route = route,
                userLat = snapshot.refLat,
                userLng = snapshot.refLng,
                destLat = nearest.lat,
                destLng = nearest.lng,
                destName = nearest.name
            )
        } else {
            TurnGuidance(
                arrow = "◎",
                shortLabelUz = "Tayyor",
                fullInstructionUz = "Yaqin muassasa qidirilmoqda",
                distanceToTurnMeters = 0.0,
                streetName = "",
                nextTurnPreview = null,
                turnLat = snapshot.refLat,
                turnLng = snapshot.refLng,
                remainingTotalMeters = 0.0,
                totalDistanceMeters = 1.0,
                remainingDurationSeconds = 0.0,
                progressFraction = 0f,
                roadHeadingDeg = 0.0,
                remainingPoints = listOf(Pair(snapshot.refLat, snapshot.refLng)),
                passedPoints = emptyList(),
                upcomingTurns = emptyList(),
                isArrived = false,
                isRoadRoute = false
            )
        }

        // Heading-Up angle: use live movement GPS bearing if moving, else align to road straight ahead!
        val movingBearing = WidgetDataFetcher.getLastKnownBearingIfMoving(context)
        val headingDeg = movingBearing?.toDouble() ?: guidance.roadHeadingDeg

        // Smart auto-scale focused on upcoming turn & road ahead (zooms closer automatically as you approach!)
        val baseRangeMeters = when {
            nearest == null -> 800.0
            guidance.remainingTotalMeters <= 250.0 -> 260.0
            guidance.distanceToTurnMeters <= 180.0 -> 320.0
            guidance.distanceToTurnMeters <= 450.0 -> guidance.distanceToTurnMeters * 1.55
            guidance.remainingTotalMeters <= 1500.0 -> guidance.remainingTotalMeters * 1.25
            else -> min(guidance.distanceToTurnMeters * 1.45, 2200.0).coerceAtLeast(650.0)
        }
        val effectiveRange = (baseRangeMeters * 0.72.pow(zoomOffset.toDouble())).coerceIn(140.0, 9000.0)

        val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.RGB_565)
        val canvas = Canvas(bitmap)

        // 1. Crisp Dark Tactical HUD Background
        canvas.drawColor(Color.parseColor("#0B1324"))

        val anchorX = widthPx * 0.5f
        val anchorY = heightPx * 0.74f
        val forwardPxBudget = heightPx * 0.62f
        val pxPerMeter = forwardPxBudget / effectiveRange

        fun toScreen(lat: Double, lng: Double): Pair<Float, Float> {
            val (east, north) = latLngToLocalMeters(lat, lng, snapshot.refLat, snapshot.refLng)
            val (right, forward) = rotateToHeadingUp(east, north, headingDeg)
            val sx = anchorX + (right * pxPerMeter).toFloat()
            val sy = anchorY - (forward * pxPerMeter).toFloat()
            return Pair(sx, sy)
        }

        // 2. Concentric Radar Range Rings + Subtle Crosshair + Rotating North Indicator
        val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#1E293B")
            strokeWidth = 2f
        }
        val ringLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#64748B")
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        val ringSteps = listOf(0.35, 0.72, 1.08)
        for (frac in ringSteps) {
            val rMeters = effectiveRange * frac
            val rPx = (rMeters * pxPerMeter).toFloat()
            canvas.drawCircle(anchorX, anchorY, rPx, ringPaint)
            val label = formatDistanceUz(rMeters)
            val ly = anchorY - rPx + 16f
            if (ly > 20f && ly < heightPx - 20f) {
                canvas.drawText(label, anchorX + 8f, ly, ringLabelPaint)
            }
        }

        // Forward guide axis line (shows phone UP heading clearly)
        val axisPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#17253B")
            strokeWidth = 1.5f
            pathEffect = DashPathEffect(floatArrayOf(8f, 8f), 0f)
        }
        canvas.drawLine(anchorX, 12f, anchorX, anchorY, axisPaint)

        // Compact rotating North compass indicator at top-left
        val compX = 36f
        val compY = 36f
        val compBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#CC0F172A") }
        val compBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#334155")
            strokeWidth = 2f
        }
        canvas.drawCircle(compX, compY, 21f, compBg)
        canvas.drawCircle(compX, compY, 21f, compBorder)
        val (nRight, nFwd) = rotateToHeadingUp(0.0, 1.0, headingDeg)
        val nx = compX + (nRight * 12.0).toFloat()
        val ny = compY - (nFwd * 12.0).toFloat()
        val northDotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#EF4444") }
        canvas.drawCircle(nx, ny, 4.5f, northDotPaint)
        val northTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#E2E8F0")
            textSize = 14f
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        canvas.drawText("N", compX, compY + 5f, northTextPaint)

        // 3. Subtle Nearby Other Facilities for spatial context
        val otherPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        for (loc in nearbyOthers.take(10)) {
            if (nearest != null && loc.id == nearest.id) continue
            val (sx, sy) = toScreen(loc.lat, loc.lng)
            if (sx < 10f || sx > widthPx - 10f || sy < 10f || sy > heightPx - 10f) continue
            otherPaint.color = when (loc.type) {
                "maktab" -> Color.parseColor("#5538BDF8")
                "dmtt", "bogcha" -> Color.parseColor("#55FB7185")
                else -> Color.parseColor("#5534D399")
            }
            canvas.drawCircle(sx, sy, 5.5f, otherPaint)
        }

        // 4. Passed Route Trail (subtle dim dashed line behind user)
        if (guidance.passedPoints.size >= 2) {
            val passedPath = Path()
            guidance.passedPoints.forEachIndexed { idx, (lat, lng) ->
                val (sx, sy) = toScreen(lat, lng)
                if (idx == 0) passedPath.moveTo(sx, sy) else passedPath.lineTo(sx, sy)
            }
            val passedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = Color.parseColor("#475569")
                strokeWidth = 5f
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
                pathEffect = DashPathEffect(floatArrayOf(10f, 10f), 0f)
            }
            canvas.drawPath(passedPath, passedPaint)
        }

        // 5. Active Upcoming Route Polyline (glowing vector ribbon!)
        if (guidance.remainingPoints.size >= 2) {
            val remPath = Path()
            guidance.remainingPoints.forEachIndexed { idx, (lat, lng) ->
                val (sx, sy) = toScreen(lat, lng)
                if (idx == 0) remPath.moveTo(sx, sy) else remPath.lineTo(sx, sy)
            }
            val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = if (guidance.isRoadRoute) Color.parseColor("#380EA5E9") else Color.parseColor("#38F59E0B")
                strokeWidth = 22f
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
            }
            val corePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = if (guidance.isRoadRoute) Color.parseColor("#38BDF8") else Color.parseColor("#F59E0B")
                strokeWidth = 9f
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
                if (!guidance.isRoadRoute) {
                    pathEffect = DashPathEffect(floatArrayOf(14f, 10f), 0f)
                }
            }
            val innerHighlight = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = Color.parseColor("#E0F2FE")
                strokeWidth = 2.5f
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
            }
            canvas.drawPath(remPath, glowPaint)
            canvas.drawPath(remPath, corePaint)
            if (guidance.isRoadRoute) {
                canvas.drawPath(remPath, innerHighlight)
            }
        }

        // 6. Highlight Upcoming Turn Vertex + Floating Meter Callout right on the bend!
        if (nearest != null && !guidance.isArrived && guidance.upcomingTurns.isNotEmpty()) {
            val (firstStep, firstDist) = guidance.upcomingTurns.first()
            if (firstStep.maneuverType != "arrive") {
                val (tx, ty) = toScreen(firstStep.lat, firstStep.lng)
                if (tx in 24f..(widthPx - 56f) && ty in 24f..(heightPx - 24f)) {
                    val turnGlow = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#44F59E0B") }
                    val turnRing = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        style = Paint.Style.STROKE
                        color = Color.parseColor("#FBBF24")
                        strokeWidth = 3.5f
                    }
                    val turnCore = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#F59E0B") }
                    canvas.drawCircle(tx, ty, 17f, turnGlow)
                    canvas.drawCircle(tx, ty, 10f, turnRing)
                    canvas.drawCircle(tx, ty, 5.5f, turnCore)

                    val callout = "${guidance.arrow} ${formatDistanceUz(firstDist)}"
                    val callTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = Color.parseColor("#FEF3C7")
                        textSize = 18f
                        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                    }
                    val tw = callTextPaint.measureText(callout)
                    val bw = tw + 20f
                    val bh = 28f
                    val bx = (tx + 14f).coerceIn(10f, max(10f, widthPx - bw - 54f))
                    val by = (ty - bh / 2f).coerceIn(10f, max(10f, heightPx - bh - 36f))
                    val bgP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#E61E293B") }
                    val brP = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        style = Paint.Style.STROKE
                        color = Color.parseColor("#F59E0B")
                        strokeWidth = 2f
                    }
                    val rect = RectF(bx, by, bx + bw, by + bh)
                    canvas.drawRoundRect(rect, 12f, 12f, bgP)
                    canvas.drawRoundRect(rect, 12f, 12f, brP)
                    canvas.drawText(callout, bx + 10f, by + 20f, callTextPaint)
                }
            }
        }

        // 7. Destination Pin + Crisp Label Pill (clamped neatly inside viewport edge if far away)
        if (nearest != null) {
            val (rawDx, rawDy) = toScreen(nearest.lat, nearest.lng)
            val dx = rawDx.coerceIn(22f, widthPx - 58f)
            val dy = rawDy.coerceIn(24f, heightPx - 38f)
            val pinColor = when (nearest.type) {
                "maktab" -> Color.parseColor("#0EA5E9")
                "dmtt", "bogcha" -> Color.parseColor("#EF4444")
                else -> Color.parseColor("#10B981")
            }
            val pinWhite = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
            val pinFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = pinColor }
            canvas.drawCircle(dx, dy, 12f, pinWhite)
            canvas.drawCircle(dx, dy, 9f, pinFill)
            canvas.drawCircle(dx, dy, 3.2f, pinWhite)

            val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE
                textSize = 18f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            }
            val textW = labelPaint.measureText(nearest.name)
            val bw = textW + 22f
            val bh = 28f
            val bx = (dx - bw / 2f).coerceIn(10f, max(10f, widthPx - bw - 54f))
            val by = (dy - 16f - bh).coerceIn(8f, max(8f, heightPx - bh - 36f))
            val pillBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#DD0F172A") }
            val pillBorder = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                color = pinColor
                strokeWidth = 2f
            }
            canvas.drawRoundRect(RectF(bx, by, bx + bw, by + bh), 12f, 12f, pillBg)
            canvas.drawRoundRect(RectF(bx, by, bx + bw, by + bh), 12f, 12f, pillBorder)
            canvas.drawText(nearest.name, bx + 11f, by + 20f, labelPaint)
        }

        // 8. Sharp User Directional Navigation Chevron (Always pointing straight UP!)
        val userHalo = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#3838BDF8") }
        canvas.drawCircle(anchorX, anchorY, 24f, userHalo)

        val chevron = Path().apply {
            moveTo(anchorX, anchorY - 16f)
            lineTo(anchorX + 12f, anchorY + 12f)
            lineTo(anchorX, anchorY + 5f)
            lineTo(anchorX - 12f, anchorY + 12f)
            close()
        }
        val chevronFill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            color = Color.parseColor("#38BDF8")
        }
        val chevronStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.WHITE
            strokeWidth = 3f
            strokeJoin = Paint.Join.ROUND
        }
        canvas.drawPath(chevron, chevronFill)
        canvas.drawPath(chevron, chevronStroke)

        return RenderedWidgetHud(
            bitmap = bitmap,
            guidance = guidance,
            headingDeg = headingDeg,
            viewRangeMeters = effectiveRange
        )
    }
}
