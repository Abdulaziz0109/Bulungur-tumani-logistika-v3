package uz.bulungur.mmtb

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Instant native floating interactive map popup opened by tapping the widget's mini-map.
 * Supports smooth 2-finger pinch-to-zoom, 1-finger drag/pan in any direction, marker tapping,
 * category switching (Barchasi / Maktab / Bog'cha), and real-time GPS route auto-tracking.
 */
class FloatingMapActivity : AppCompatActivity() {

    private lateinit var tvTitle: TextView
    private lateinit var tvSubtitle: TextView
    private lateinit var pillAll: TextView
    private lateinit var pillMaktab: TextView
    private lateinit var pillDmtt: TextView
    private lateinit var mapView: InteractiveMapView

    private val bgExecutor = Executors.newFixedThreadPool(3)
    private var locationManager: LocationManager? = null

    private var activeFilter: String = "all"
    private var snapshot: WidgetSnapshot = WidgetSnapshot(
        locations = emptyList(),
        totalMaktab = 0,
        totalDmtt = 0,
        hasGps = false,
        refLat = 39.7647,
        refLng = 67.2714
    )
    private var activeTarget: MmtbLocation? = null
    private var activeRoute: RoutePathResult? = null
    private var userManuallySelectedTarget = false

    private val liveListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            WidgetDataFetcher.saveLastKnownFix(
                applicationContext,
                location.latitude,
                location.longitude,
                location.time
            )
            refreshSnapshotAndRoute(recenter = false)
        }

        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_floating_map)

        tvTitle = findViewById(R.id.tv_fmap_title)
        tvSubtitle = findViewById(R.id.tv_fmap_subtitle)
        pillAll = findViewById(R.id.fmap_pill_all)
        pillMaktab = findViewById(R.id.fmap_pill_maktab)
        pillDmtt = findViewById(R.id.fmap_pill_dmtt)

        findViewById<View>(R.id.floating_map_backdrop).setOnClickListener {
            finish()
            overridePendingTransition(0, 0)
        }
        findViewById<View>(R.id.btn_fmap_close).setOnClickListener {
            finish()
            overridePendingTransition(0, 0)
        }

        mapView = InteractiveMapView(this) { tappedLocation ->
            userManuallySelectedTarget = true
            activeTarget = tappedLocation
            updateHeaderText()
            loadRouteForActiveTarget(recenter = false)
        }
        findViewById<FrameLayout>(R.id.fmap_canvas_holder).addView(
            mapView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        pillAll.setOnClickListener { switchFilter("all") }
        pillMaktab.setOnClickListener { switchFilter("maktab") }
        pillDmtt.setOnClickListener { switchFilter("dmtt") }

        findViewById<View>(R.id.btn_fmap_recenter).setOnClickListener {
            userManuallySelectedTarget = false
            pickNearestAndRecenter()
        }
        findViewById<View>(R.id.btn_fmap_yandex).setOnClickListener {
            val target = activeTarget ?: return@setOnClickListener
            launchUrl(
                WidgetDataFetcher.buildYandexUrl(
                    target,
                    snapshot.hasGps,
                    snapshot.refLat,
                    snapshot.refLng
                )
            )
        }
        findViewById<View>(R.id.btn_fmap_google).setOnClickListener {
            val target = activeTarget ?: return@setOnClickListener
            launchUrl(WidgetDataFetcher.buildGoogleUrl(target))
        }

        activeFilter = WidgetDataFetcher.getSavedFilter(this)
        updateFilterPills()
        refreshSnapshotAndRoute(recenter = true)
        startForegroundGps()
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            locationManager?.removeUpdates(liveListener)
        } catch (_: Exception) {
            // Ignore
        }
        bgExecutor.shutdownNow()
    }

    @SuppressLint("MissingPermission")
    private fun startForegroundGps() {
        if (!WidgetDataFetcher.hasLocationPermission(this)) return
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        locationManager = lm
        val provider = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)
        ) {
            LocationManager.FUSED_PROVIDER
        } else if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            LocationManager.GPS_PROVIDER
        } else {
            LocationManager.NETWORK_PROVIDER
        }
        try {
            lm.requestLocationUpdates(provider, 5_000L, 10f, liveListener, Looper.getMainLooper())
        } catch (_: Exception) {
            // Ignore
        }
    }

    private fun switchFilter(filter: String) {
        activeFilter = filter
        userManuallySelectedTarget = false
        WidgetDataFetcher.setSavedFilter(this, filter)
        updateFilterPills()
        pickNearestAndRecenter()

        // Keep widget filter in sync
        val intent = Intent(this, MmtbWidgetProvider::class.java).apply {
            action = MmtbWidgetProvider.ACTION_SET_FILTER
            putExtra(MmtbWidgetProvider.EXTRA_FILTER, filter)
        }
        sendBroadcast(intent)
    }

    private fun updateFilterPills() {
        pillAll.setBackgroundResource(
            if (activeFilter == "all") R.drawable.widget_pill_active else R.drawable.widget_pill_bg
        )
        pillMaktab.setBackgroundResource(
            if (activeFilter == "maktab") R.drawable.widget_pill_active else R.drawable.widget_pill_bg
        )
        pillDmtt.setBackgroundResource(
            if (activeFilter == "dmtt") R.drawable.widget_pill_active else R.drawable.widget_pill_bg
        )
    }

    private fun filteredLocations(): List<MmtbLocation> {
        return snapshot.locations.filter { loc ->
            when (activeFilter) {
                "maktab" -> loc.type == "maktab"
                "dmtt" -> loc.type == "dmtt" || loc.type == "bogcha"
                else -> true
            }
        }
    }

    private fun refreshSnapshotAndRoute(recenter: Boolean) {
        snapshot = WidgetDataFetcher.loadCachedSnapshotFast(this)
        val filtered = filteredLocations()
        if (!userManuallySelectedTarget || activeTarget == null) {
            activeTarget = filtered.firstOrNull()
        } else {
            val currentId = activeTarget?.id
            activeTarget = snapshot.locations.firstOrNull { it.id == currentId } ?: filtered.firstOrNull()
        }
        mapView.setData(snapshot, filtered, activeTarget, activeRoute)
        updateHeaderText()
        loadRouteForActiveTarget(recenter = recenter)
    }

    private fun pickNearestAndRecenter() {
        val filtered = filteredLocations()
        activeTarget = filtered.firstOrNull()
        mapView.setData(snapshot, filtered, activeTarget, activeRoute)
        updateHeaderText()
        loadRouteForActiveTarget(recenter = true)
    }

    private fun updateHeaderText() {
        val target = activeTarget
        if (target != null) {
            val roadKm = activeRoute?.takeIf { it.isRoadRoute && it.distanceMeters > 0 }?.let {
                it.distanceMeters / 1000.0
            } ?: target.distKm
            val etaMin = activeRoute?.takeIf { it.isRoadRoute && it.durationSeconds > 0 }?.let {
                max(1, (it.durationSeconds / 60.0).toInt())
            }
            tvTitle.text = target.name
            tvSubtitle.text = if (etaMin != null) {
                String.format(Locale.US, "%.1f km · ~%d daq · Surish va zoom faol", roadKm, etaMin)
            } else {
                String.format(Locale.US, "%.1f km · Surish va zoom faol", roadKm)
            }
        } else {
            tvTitle.text = "Bulung'ur MMTB"
            tvSubtitle.text = "Barmoq bilan suring yoki kattalashtiring"
        }
    }

    private fun loadRouteForActiveTarget(recenter: Boolean) {
        val target = activeTarget ?: return
        val originLat = snapshot.refLat
        val originLng = snapshot.refLng
        bgExecutor.execute {
            val route = WidgetMapRenderer.fetchRoadRoute(
                fromLat = originLat,
                fromLng = originLng,
                destLat = target.lat,
                destLng = target.lng,
                destId = target.id,
                allowNetwork = true
            )
            if (!isFinishing && !isDestroyed) {
                runOnUiThread {
                    activeRoute = route
                    mapView.setData(snapshot, filteredLocations(), activeTarget, route)
                    if (recenter) {
                        mapView.frameRoute(
                            route.points + Pair(originLat, originLng) + Pair(target.lat, target.lng)
                        )
                    }
                    updateHeaderText()
                }
            }
        }
    }

    private fun launchUrl(url: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(this, "Navigator ilovasi topilmadi", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * Native touch-interactive map view with 2-finger pinch-zoom, 1-finger panning,
     * double-tap zoom, and marker tap selection using the shared disk tile cache.
     */
    private inner class InteractiveMapView(
        context: Context,
        private val onMarkerTapped: (MmtbLocation) -> Unit
    ) : View(context) {

        private var centerLat = 39.7647
        private var centerLng = 67.2714
        private var zoom = 14.0

        private var snap: WidgetSnapshot? = null
        private var markers: List<MmtbLocation> = emptyList()
        private var target: MmtbLocation? = null
        private var route: RoutePathResult? = null
        private var pendingFramePoints: List<Pair<Double, Double>>? = null

        private val memTiles = ConcurrentHashMap<String, Bitmap>()
        private val loadingTiles = ConcurrentHashMap.newKeySet<String>()

        private val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG)
        private val gridPaint = Paint().apply {
            color = Color.parseColor("#CBD5E1")
            strokeWidth = 1f
        }
        private val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.WHITE
            strokeWidth = 12f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val routePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#0284C7")
            strokeWidth = 7f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val markerFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        private val markerStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.WHITE
            strokeWidth = 3f
        }
        private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 24f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        private val pillBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#DD0F172A")
        }

        private val scaleDetector = ScaleGestureDetector(
            context,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    val delta = kotlin.math.ln(detector.scaleFactor.toDouble()) / kotlin.math.ln(2.0)
                    zoom = (zoom + delta).coerceIn(10.0, 17.8)
                    invalidate()
                    return true
                }
            }
        )

        private val gestureDetector = GestureDetector(
            context,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onDown(e: MotionEvent): Boolean = true

                override fun onScroll(
                    e1: MotionEvent?,
                    e2: MotionEvent,
                    distanceX: Float,
                    distanceY: Float
                ): Boolean {
                    val cWorld = WidgetMapRenderer.latLngToWorldPixel(centerLat, centerLng, zoom)
                    val next = WidgetMapRenderer.worldPixelToLatLng(
                        cWorld.first + distanceX,
                        cWorld.second + distanceY,
                        zoom
                    )
                    centerLat = next.first.coerceIn(-85.0, 85.0)
                    centerLng = next.second.coerceIn(-180.0, 180.0)
                    invalidate()
                    return true
                }

                override fun onDoubleTap(e: MotionEvent): Boolean {
                    zoom = (zoom + 1.0).coerceAtMost(17.5)
                    invalidate()
                    return true
                }

                override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                    val hit = findMarkerAt(e.x, e.y)
                    if (hit != null) {
                        onMarkerTapped(hit)
                        return true
                    }
                    return false
                }
            }
        )

        fun setData(
            snapshot: WidgetSnapshot,
            visibleMarkers: List<MmtbLocation>,
            activeTarget: MmtbLocation?,
            routeResult: RoutePathResult?
        ) {
            this.snap = snapshot
            this.markers = visibleMarkers
            this.target = activeTarget
            this.route = routeResult
            invalidate()
        }

        fun frameRoute(points: List<Pair<Double, Double>>) {
            if (points.isEmpty()) return
            if (width <= 0 || height <= 0) {
                pendingFramePoints = points
                return
            }
            var minLat = Double.MAX_VALUE
            var maxLat = -Double.MAX_VALUE
            var minLng = Double.MAX_VALUE
            var maxLng = -Double.MAX_VALUE
            for ((lat, lng) in points) {
                minLat = min(minLat, lat)
                maxLat = max(maxLat, lat)
                minLng = min(minLng, lng)
                maxLng = max(maxLng, lng)
            }
            centerLat = (minLat + maxLat) / 2.0
            centerLng = (minLng + maxLng) / 2.0
            zoom = WidgetMapRenderer.computeAutoZoom(points, width, height).toDouble()
            invalidate()
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            super.onSizeChanged(w, h, oldw, oldh)
            pendingFramePoints?.let { pts ->
                pendingFramePoints = null
                frameRoute(pts)
            }
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            val scaled = scaleDetector.onTouchEvent(event)
            val gestured = gestureDetector.onTouchEvent(event)
            return scaled || gestured || super.onTouchEvent(event)
        }

        private fun findMarkerAt(tapX: Float, tapY: Float): MmtbLocation? {
            if (width <= 0 || height <= 0) return null
            val cWorld = WidgetMapRenderer.latLngToWorldPixel(centerLat, centerLng, zoom)
            val ox = cWorld.first - width / 2.0
            val oy = cWorld.second - height / 2.0
            var best: MmtbLocation? = null
            var bestDist = 54f
            for (loc in markers) {
                val wp = WidgetMapRenderer.latLngToWorldPixel(loc.lat, loc.lng, zoom)
                val sx = (wp.first - ox).toFloat()
                val sy = (wp.second - oy).toFloat()
                val d = hypot(sx - tapX, sy - tapY)
                if (d < bestDist) {
                    bestDist = d
                    best = loc
                }
            }
            return best
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            canvas.drawColor(Color.parseColor("#E2E8F0"))

            val tileZoom = floor(zoom).toInt().coerceIn(10, 17)
            val scaleFactor = Math.pow(2.0, zoom - tileZoom).toFloat()
            val scaledTilePx = 256.0 * scaleFactor

            val centerWorld = WidgetMapRenderer.latLngToWorldPixel(centerLat, centerLng, zoom)
            val originWorldX = centerWorld.first - width / 2.0
            val originWorldY = centerWorld.second - height / 2.0

            val startTileX = floor(originWorldX / scaledTilePx).toInt()
            val endTileX = floor((originWorldX + width) / scaledTilePx).toInt()
            val startTileY = floor(originWorldY / scaledTilePx).toInt()
            val endTileY = floor((originWorldY + height) / scaledTilePx).toInt()

            val maxTile = 1 shl tileZoom
            val dstRect = RectF()
            for (tx in startTileX..endTileX) {
                for (ty in startTileY..endTileY) {
                    if (ty < 0 || ty >= maxTile) continue
                    val wrappedX = ((tx % maxTile) + maxTile) % maxTile
                    val key = "$tileZoom/$wrappedX/$ty"
                    val left = (tx * scaledTilePx - originWorldX).toFloat()
                    val top = (ty * scaledTilePx - originWorldY).toFloat()
                    dstRect.set(left, top, left + scaledTilePx.toFloat() + 1f, top + scaledTilePx.toFloat() + 1f)

                    val bmp = memTiles[key]
                    if (bmp != null && !bmp.isRecycled) {
                        canvas.drawBitmap(bmp, null, dstRect, tilePaint)
                    } else {
                        canvas.drawRect(dstRect, gridPaint)
                        if (loadingTiles.add(key)) {
                            bgExecutor.execute {
                                val loaded = WidgetMapRenderer.loadTileBitmap(
                                    context.applicationContext,
                                    tileZoom,
                                    wrappedX,
                                    ty,
                                    allowNetwork = true
                                )
                                loadingTiles.remove(key)
                                if (loaded != null) {
                                    if (memTiles.size > 80) memTiles.clear()
                                    memTiles[key] = loaded
                                    postInvalidate()
                                }
                            }
                        }
                    }
                }
            }

            fun toScreen(lat: Double, lng: Double): Pair<Float, Float> {
                val wp = WidgetMapRenderer.latLngToWorldPixel(lat, lng, zoom)
                return Pair((wp.first - originWorldX).toFloat(), (wp.second - originWorldY).toFloat())
            }

            // Draw road route
            val r = route
            if (r != null && r.points.size >= 2) {
                val path = Path()
                r.points.forEachIndexed { idx, (lat, lng) ->
                    val (sx, sy) = toScreen(lat, lng)
                    if (idx == 0) path.moveTo(sx, sy) else path.lineTo(sx, sy)
                }
                routePaint.color = if (r.isRoadRoute) Color.parseColor("#0284C7") else Color.parseColor("#F59E0B")
                routePaint.pathEffect = if (r.isRoadRoute) null else DashPathEffect(floatArrayOf(14f, 10f), 0f)
                canvas.drawPath(path, haloPaint)
                canvas.drawPath(path, routePaint)
            }

            // Draw all visible markers
            val activeId = target?.id
            for (loc in markers) {
                if (loc.id == activeId) continue
                val (sx, sy) = toScreen(loc.lat, loc.lng)
                if (sx < -20f || sx > width + 20f || sy < -20f || sy > height + 20f) continue
                markerFill.color = when (loc.type) {
                    "maktab" -> Color.parseColor("#0EA5E9")
                    "dmtt", "bogcha" -> Color.parseColor("#FB7185")
                    else -> Color.parseColor("#10B981")
                }
                canvas.drawCircle(sx, sy, 9f, markerFill)
                canvas.drawCircle(sx, sy, 9f, markerStroke)
            }

            // Draw User GPS dot
            snap?.let { s ->
                val (ux, uy) = toScreen(s.refLat, s.refLng)
                markerFill.color = Color.parseColor("#442563EB")
                canvas.drawCircle(ux, uy, 22f, markerFill)
                markerFill.color = Color.WHITE
                canvas.drawCircle(ux, uy, 12f, markerFill)
                markerFill.color = Color.parseColor("#2563EB")
                canvas.drawCircle(ux, uy, 8.5f, markerFill)
            }

            // Draw Active Target pin + label
            target?.let { dest ->
                val (dx, dy) = toScreen(dest.lat, dest.lng)
                val pinColor = when (dest.type) {
                    "maktab" -> Color.parseColor("#0EA5E9")
                    "dmtt", "bogcha" -> Color.parseColor("#EF4444")
                    else -> Color.parseColor("#10B981")
                }
                markerFill.color = Color.WHITE
                canvas.drawCircle(dx, dy, 16f, markerFill)
                markerFill.color = pinColor
                canvas.drawCircle(dx, dy, 12f, markerFill)
                markerFill.color = Color.WHITE
                canvas.drawCircle(dx, dy, 4.5f, markerFill)

                val textW = labelPaint.measureText(dest.name)
                val padX = 16f
                val boxW = textW + padX * 2
                val boxH = 38f
                val left = (dx - boxW / 2f).coerceIn(10f, max(10f, width - boxW - 10f))
                val top = (dy - 22f - boxH).coerceIn(10f, max(10f, height - boxH - 10f))
                canvas.drawRoundRect(RectF(left, top, left + boxW, top + boxH), 16f, 16f, pillBgPaint)
                canvas.drawText(dest.name, left + padX, top + 26f, labelPaint)
            }
        }
    }
}
