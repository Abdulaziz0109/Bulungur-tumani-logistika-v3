package uz.bulungur.mmtb

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
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
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Ultra-fast 60 FPS Pure Vector Heading-Up Turn-by-Turn Floating HUD.
 * Zero map tile downloads: opens instantaneously, rotates smoothly with phone compass & GPS bearing,
 * shows exact meters to the next turn, and displays a bottom total-distance progress line.
 */
class FloatingMapActivity : AppCompatActivity(), SensorEventListener {

    companion object {
        const val EXTRA_TARGET_ID = "extra_target_id"
    }

    private lateinit var tvTitle: TextView
    private lateinit var tvSubtitle: TextView
    private lateinit var btnRotate: TextView
    private lateinit var pillAll: TextView
    private lateinit var pillMaktab: TextView
    private lateinit var pillDmtt: TextView

    private lateinit var tvTurnArrow: TextView
    private lateinit var tvTurnDist: TextView
    private lateinit var tvTurnText: TextView
    private lateinit var tvTurnNext: TextView

    private lateinit var tvTotalLeft: TextView
    private lateinit var tvTotalRight: TextView
    private lateinit var pbRouteProgress: ProgressBar

    private lateinit var hudView: InteractiveVectorHudView

    private val bgExecutor = Executors.newSingleThreadExecutor()
    private var locationManager: LocationManager? = null
    private var sensorManager: SensorManager? = null
    private var rotationSensor: Sensor? = null

    private var activeFilter: String = "all"
    private var headingUpEnabled: Boolean = true
    private var lastGpsBearingDeg: Double? = null
    private var lastGpsSpeedMps: Float = 0f
    private var lastGpsTimeMs: Long = 0L
    private var smoothedCompassDeg: Double? = null

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
    private var activeGuidance: TurnGuidance? = null
    private var userManuallySelectedTarget = false

    private val rotationMatrix = FloatArray(9)
    private val orientationAngles = FloatArray(3)

    private val liveListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val bearing = if (location.hasBearing()) location.bearing else null
            val speed = if (location.hasSpeed()) location.speed else 0f
            WidgetDataFetcher.saveLastKnownFix(
                context = applicationContext,
                lat = location.latitude,
                lng = location.longitude,
                timestampMs = location.time,
                bearingDeg = bearing,
                speedMps = speed
            )
            lastGpsSpeedMps = speed
            lastGpsTimeMs = System.currentTimeMillis()
            if (bearing != null && speed >= 1.2f) {
                lastGpsBearingDeg = ((bearing.toDouble() % 360.0) + 360.0) % 360.0
            }
            refreshSnapshotAndRoute(resetPan = false)
        }

        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_floating_map)

        tvTitle = findViewById(R.id.tv_fmap_title)
        tvSubtitle = findViewById(R.id.tv_fmap_subtitle)
        btnRotate = findViewById(R.id.btn_fmap_rotate)
        pillAll = findViewById(R.id.fmap_pill_all)
        pillMaktab = findViewById(R.id.fmap_pill_maktab)
        pillDmtt = findViewById(R.id.fmap_pill_dmtt)

        tvTurnArrow = findViewById(R.id.tv_fmap_turn_arrow)
        tvTurnDist = findViewById(R.id.tv_fmap_turn_dist)
        tvTurnText = findViewById(R.id.tv_fmap_turn_text)
        tvTurnNext = findViewById(R.id.tv_fmap_turn_next)

        tvTotalLeft = findViewById(R.id.tv_fmap_total_left)
        tvTotalRight = findViewById(R.id.tv_fmap_total_right)
        pbRouteProgress = findViewById(R.id.pb_fmap_route_progress)

        findViewById<View>(R.id.floating_map_backdrop).setOnClickListener {
            finish()
            overridePendingTransition(0, 0)
        }
        findViewById<View>(R.id.btn_fmap_close).setOnClickListener {
            finish()
            overridePendingTransition(0, 0)
        }

        hudView = InteractiveVectorHudView(this) { tappedLocation ->
            userManuallySelectedTarget = true
            activeTarget = tappedLocation
            activeRoute = null
            recomputeGuidanceLocally()
            updateUiText()
            loadRouteForActiveTarget(resetPan = true)
        }
        findViewById<FrameLayout>(R.id.fmap_canvas_holder).addView(
            hudView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        btnRotate.setOnClickListener {
            headingUpEnabled = !headingUpEnabled
            updateRotateButton()
            pushHeadingToHud()
        }

        pillAll.setOnClickListener { switchFilter("all") }
        pillMaktab.setOnClickListener { switchFilter("maktab") }
        pillDmtt.setOnClickListener { switchFilter("dmtt") }

        findViewById<View>(R.id.btn_fmap_recenter).setOnClickListener {
            userManuallySelectedTarget = false
            headingUpEnabled = true
            updateRotateButton()
            hudView.resetCamera()
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
        val requestedTargetId = intent?.getStringExtra(EXTRA_TARGET_ID)
        snapshot = WidgetDataFetcher.loadCachedSnapshotFast(this)
        if (!requestedTargetId.isNullOrBlank()) {
            val found = snapshot.locations.firstOrNull { it.id == requestedTargetId }
            if (found != null) {
                userManuallySelectedTarget = true
                activeTarget = found
            }
        }

        updateFilterPills()
        updateRotateButton()
        refreshSnapshotAndRoute(resetPan = true)
        startForegroundGps()
        initCompassSensor()
    }

    override fun onResume() {
        super.onResume()
        rotationSensor?.let { sensor ->
            sensorManager?.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI)
        }
    }

    override fun onPause() {
        super.onPause()
        sensorManager?.unregisterListener(this)
    }

    override fun onDestroy() {
        super.onDestroy()
        sensorManager?.unregisterListener(this)
        try {
            locationManager?.removeUpdates(liveListener)
        } catch (_: Exception) {
            // Ignore
        }
        bgExecutor.shutdownNow()
    }

    private fun initCompassSensor() {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        rotationSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
        SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
        SensorManager.getOrientation(rotationMatrix, orientationAngles)
        val rawDeg = ((Math.toDegrees(orientationAngles[0].toDouble()) % 360.0) + 360.0) % 360.0
        val prev = smoothedCompassDeg
        smoothedCompassDeg = if (prev == null) {
            rawDeg
        } else {
            lerpAngleDeg(prev, rawDeg, 0.16)
        }
        if (headingUpEnabled) {
            pushHeadingToHud()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun lerpAngleDeg(from: Double, to: Double, factor: Double): Double {
        var delta = ((to - from + 540.0) % 360.0) - 180.0
        if (abs(delta) < 0.8) return from
        delta *= factor
        return ((from + delta) % 360.0 + 360.0) % 360.0
    }

    private fun resolveActiveHeadingDeg(): Double {
        if (!headingUpEnabled) return 0.0
        val now = System.currentTimeMillis()
        // When driving/moving fast (> 1.4 m/s), GPS bearing is rock-solid and immune to car metal interference
        val gpsHeading = lastGpsBearingDeg
        if (gpsHeading != null && lastGpsSpeedMps >= 1.4f && (now - lastGpsTimeMs) < 15_000L) {
            return gpsHeading
        }
        // When walking or holding phone, hardware compass smoothly rotates the schematic to match where phone points!
        smoothedCompassDeg?.let { return it }
        // Fallback: orient road straight ahead to top of screen
        return activeGuidance?.roadHeadingDeg ?: 0.0
    }

    private fun pushHeadingToHud() {
        hudView.setHeading(resolveActiveHeadingDeg())
    }

    private fun updateRotateButton() {
        if (headingUpEnabled) {
            btnRotate.text = "🧭 Aylanish"
            btnRotate.setBackgroundResource(R.drawable.widget_pill_active)
        } else {
            btnRotate.text = "⬆ Shimol"
            btnRotate.setBackgroundResource(R.drawable.widget_pill_bg)
        }
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
            lm.requestLocationUpdates(provider, 2_000L, 4f, liveListener, Looper.getMainLooper())
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

    private fun refreshSnapshotAndRoute(resetPan: Boolean) {
        snapshot = WidgetDataFetcher.loadCachedSnapshotFast(this)
        val filtered = filteredLocations()
        if (!userManuallySelectedTarget || activeTarget == null) {
            activeTarget = filtered.firstOrNull()
        } else {
            val currentId = activeTarget?.id
            activeTarget = snapshot.locations.firstOrNull { it.id == currentId } ?: filtered.firstOrNull()
        }
        recomputeGuidanceLocally()
        if (resetPan) hudView.resetCamera()
        hudView.setData(snapshot, filtered, activeTarget, activeGuidance)
        pushHeadingToHud()
        updateUiText()
        loadRouteForActiveTarget(resetPan = resetPan)
    }

    private fun pickNearestAndRecenter() {
        val filtered = filteredLocations()
        activeTarget = filtered.firstOrNull()
        activeRoute = null
        recomputeGuidanceLocally()
        hudView.resetCamera()
        hudView.setData(snapshot, filtered, activeTarget, activeGuidance)
        pushHeadingToHud()
        updateUiText()
        loadRouteForActiveTarget(resetPan = true)
    }

    private fun recomputeGuidanceLocally() {
        val target = activeTarget
        if (target == null) {
            activeGuidance = null
            return
        }
        val existingRoute = activeRoute?.takeIf { it.destId == target.id }
        val routeToUse = existingRoute ?: RoutePathResult(
            destId = target.id,
            points = listOf(Pair(snapshot.refLat, snapshot.refLng), Pair(target.lat, target.lng)),
            cumDistMeters = doubleArrayOf(0.0, target.distKm * 1000.0),
            steps = listOf(
                RouteStep(
                    maneuverType = "arrive",
                    modifier = "straight",
                    lat = target.lat,
                    lng = target.lng,
                    alongMeters = target.distKm * 1000.0,
                    segmentDistMeters = 0.0,
                    streetName = ""
                )
            ),
            totalDistanceMeters = target.distKm * 1000.0,
            totalDurationSeconds = (target.distKm * 1000.0) / 9.0,
            isRoadRoute = false
        )
        activeGuidance = WidgetMapRenderer.computeLiveGuidance(
            route = routeToUse,
            userLat = snapshot.refLat,
            userLng = snapshot.refLng,
            destLat = target.lat,
            destLng = target.lng,
            destName = target.name
        )
    }

    private fun updateUiText() {
        val target = activeTarget
        val g = activeGuidance
        if (target != null && g != null) {
            tvTitle.text = target.name
            tvSubtitle.text = if (headingUpEnabled) {
                "Yo'nalish bo'yicha aylanadi · Chimchilab kattalashtiring"
            } else {
                "Shimol yuqorida · Barmoq bilan suring"
            }

            // Prominent Turn-by-Turn Card
            tvTurnArrow.text = g.arrow
            tvTurnDist.text = if (g.isArrived) "Yetdingiz" else WidgetMapRenderer.formatDistanceUz(g.distanceToTurnMeters)
            tvTurnText.text = g.fullInstructionUz
            tvTurnNext.text = when {
                g.isArrived -> target.mahalla.ifBlank { "Manzil yonidasiz" }
                !g.nextTurnPreview.isNullOrBlank() -> g.nextTurnPreview
                g.streetName.isNotBlank() -> g.streetName
                else -> "Keyingi burilishgacha to'g'riga yuring"
            }

            // Bottom Total Distance Progress Line (Expanded Widget Only)
            val totalStr = WidgetMapRenderer.formatDistanceUz(g.totalDistanceMeters)
            val remStr = WidgetMapRenderer.formatDistanceUz(g.remainingTotalMeters)
            val etaMin = max(1, (g.remainingDurationSeconds / 60.0).roundToInt())
            tvTotalLeft.text = if (g.isRoadRoute) {
                "Jami: $totalStr · ~$etaMin daq"
            } else {
                "Jami: $totalStr"
            }
            tvTotalRight.text = "Qoldi: $remStr"
            pbRouteProgress.progress = (g.progressFraction * 1000f).roundToInt().coerceIn(0, 1000)
        } else {
            tvTitle.text = "Bulung'ur MMTB"
            tvSubtitle.text = "Muassasa tanlang"
            tvTurnArrow.text = "◎"
            tvTurnDist.text = "--"
            tvTurnText.text = "Yaqin muassasa topilmadi"
            tvTurnNext.text = ""
            tvTotalLeft.text = "Jami masofa: --"
            tvTotalRight.text = "Qoldi: --"
            pbRouteProgress.progress = 0
        }
    }

    private fun loadRouteForActiveTarget(resetPan: Boolean) {
        val target = activeTarget ?: return
        val originLat = snapshot.refLat
        val originLng = snapshot.refLng
        bgExecutor.execute {
            val route = WidgetMapRenderer.fetchRoadRouteWithSteps(
                fromLat = originLat,
                fromLng = originLng,
                destLat = target.lat,
                destLng = target.lng,
                destId = target.id,
                allowNetwork = true
            )
            if (!isFinishing && !isDestroyed) {
                runOnUiThread {
                    if (activeTarget?.id != target.id) return@runOnUiThread
                    activeRoute = route
                    activeGuidance = WidgetMapRenderer.computeLiveGuidance(
                        route = route,
                        userLat = snapshot.refLat,
                        userLng = snapshot.refLng,
                        destLat = target.lat,
                        destLng = target.lng,
                        destName = target.name
                    )
                    if (resetPan) hudView.autoFitScale(activeGuidance)
                    hudView.setData(snapshot, filteredLocations(), activeTarget, activeGuidance)
                    pushHeadingToHud()
                    updateUiText()
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
     * 60 FPS Pure Vector Heading-Up Interactive HUD Canvas.
     * Zero tile loading, instant pinch-to-zoom, smooth compass/GPS rotation, clickable nearby markers.
     */
    private inner class InteractiveVectorHudView(
        context: Context,
        private val onMarkerTapped: (MmtbLocation) -> Unit
    ) : View(context) {

        private var snap: WidgetSnapshot? = null
        private var markers: List<MmtbLocation> = emptyList()
        private var target: MmtbLocation? = null
        private var guidance: TurnGuidance? = null

        private var headingDeg: Double = 0.0
        private var viewRangeMeters: Double = 900.0
        private var userZoomedManually = false
        private var panOffsetRightPx: Float = 0f
        private var panOffsetDownPx: Float = 0f

        private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#1E293B")
            strokeWidth = 2f
        }
        private val axisPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#17253B")
            strokeWidth = 1.5f
            pathEffect = DashPathEffect(floatArrayOf(10f, 10f), 0f)
        }
        private val ringLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#64748B")
            textSize = 20f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        private val passedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#475569")
            strokeWidth = 6f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            pathEffect = DashPathEffect(floatArrayOf(12f, 12f), 0f)
        }
        private val routeGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#380EA5E9")
            strokeWidth = 28f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val routeCorePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#38BDF8")
            strokeWidth = 11f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val routeInnerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.parseColor("#E0F2FE")
            strokeWidth = 3f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Color.WHITE
            strokeWidth = 3f
        }
        private val turnCalloutText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#FEF3C7")
            textSize = 22f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        private val destLabelText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 22f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        private val pillBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#E60F172A")
        }
        private val northTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#E2E8F0")
            textSize = 18f
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }

        private val scaleDetector = ScaleGestureDetector(
            context,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    userZoomedManually = true
                    viewRangeMeters = (viewRangeMeters / detector.scaleFactor).coerceIn(120.0, 14_000.0)
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
                    panOffsetRightPx -= distanceX
                    panOffsetDownPx -= distanceY
                    invalidate()
                    return true
                }

                override fun onDoubleTap(e: MotionEvent): Boolean {
                    userZoomedManually = true
                    viewRangeMeters = (viewRangeMeters * 0.65).coerceAtLeast(120.0)
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

        fun resetCamera() {
            panOffsetRightPx = 0f
            panOffsetDownPx = 0f
            userZoomedManually = false
            autoFitScale(guidance)
            invalidate()
        }

        fun autoFitScale(g: TurnGuidance?) {
            if (userZoomedManually || g == null) return
            viewRangeMeters = when {
                g.remainingTotalMeters <= 250.0 -> 280.0
                g.distanceToTurnMeters <= 200.0 -> 360.0
                g.distanceToTurnMeters <= 500.0 -> g.distanceToTurnMeters * 1.65
                g.remainingTotalMeters <= 1600.0 -> g.remainingTotalMeters * 1.25
                else -> min(g.distanceToTurnMeters * 1.55, 2500.0).coerceAtLeast(700.0)
            }.coerceIn(160.0, 9000.0)
        }

        fun setHeading(deg: Double) {
            if (abs(headingDeg - deg) >= 0.4) {
                headingDeg = deg
                invalidate()
            }
        }

        fun setData(
            snapshot: WidgetSnapshot,
            visibleMarkers: List<MmtbLocation>,
            activeTarget: MmtbLocation?,
            turnGuidance: TurnGuidance?
        ) {
            this.snap = snapshot
            this.markers = visibleMarkers
            this.target = activeTarget
            this.guidance = turnGuidance
            if (!userZoomedManually) {
                autoFitScale(turnGuidance)
            }
            invalidate()
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            val s = scaleDetector.onTouchEvent(event)
            val g = gestureDetector.onTouchEvent(event)
            return s || g || super.onTouchEvent(event)
        }

        private fun anchorPoint(): Pair<Float, Float> {
            return Pair(width * 0.5f + panOffsetRightPx, height * 0.74f + panOffsetDownPx)
        }

        private fun pxPerMeter(): Double {
            val budget = max(120f, height * 0.60f)
            return budget / viewRangeMeters
        }

        private fun toScreen(lat: Double, lng: Double): Pair<Float, Float> {
            val s = snap ?: return Pair(width * 0.5f, height * 0.5f)
            val (east, north) = WidgetMapRenderer.latLngToLocalMeters(lat, lng, s.refLat, s.refLng)
            val (right, forward) = WidgetMapRenderer.rotateToHeadingUp(east, north, headingDeg)
            val (ax, ay) = anchorPoint()
            val ppm = pxPerMeter()
            return Pair(ax + (right * ppm).toFloat(), ay - (forward * ppm).toFloat())
        }

        private fun findMarkerAt(tapX: Float, tapY: Float): MmtbLocation? {
            if (width <= 0 || height <= 0 || snap == null) return null
            var best: MmtbLocation? = null
            var bestDist = 56f
            for (loc in markers) {
                val (sx, sy) = toScreen(loc.lat, loc.lng)
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
            canvas.drawColor(Color.parseColor("#0B1324"))
            if (width <= 0 || height <= 0) return

            val (ax, ay) = anchorPoint()
            val ppm = pxPerMeter()

            // 1. Concentric Distance Rings + Forward Axis Line
            for (frac in listOf(0.32, 0.65, 1.0, 1.4)) {
                val rMeters = viewRangeMeters * frac
                val rPx = (rMeters * ppm).toFloat()
                canvas.drawCircle(ax, ay, rPx, ringPaint)
                val ly = ay - rPx + 22f
                if (ly in 28f..(height - 24f)) {
                    canvas.drawText(WidgetMapRenderer.formatDistanceUz(rMeters), ax + 10f, ly, ringLabelPaint)
                }
            }
            canvas.drawLine(ax, 12f, ax, ay, axisPaint)

            // 2. Rotating North Compass Badge (top-left)
            val cx = 44f
            val cy = 44f
            fillPaint.color = Color.parseColor("#CC0F172A")
            canvas.drawCircle(cx, cy, 26f, fillPaint)
            strokePaint.color = Color.parseColor("#334155")
            strokePaint.strokeWidth = 2.5f
            canvas.drawCircle(cx, cy, 26f, strokePaint)
            val (nr, nf) = WidgetMapRenderer.rotateToHeadingUp(0.0, 1.0, headingDeg)
            fillPaint.color = Color.parseColor("#EF4444")
            canvas.drawCircle(cx + (nr * 15.0).toFloat(), cy - (nf * 15.0).toFloat(), 5.5f, fillPaint)
            canvas.drawText("N", cx, cy + 7f, northTextPaint)

            // 3. Nearby Facilities (tappable dots)
            val activeId = target?.id
            strokePaint.color = Color.WHITE
            strokePaint.strokeWidth = 2.5f
            for (loc in markers) {
                if (loc.id == activeId) continue
                val (sx, sy) = toScreen(loc.lat, loc.lng)
                if (sx < -16f || sx > width + 16f || sy < -16f || sy > height + 16f) continue
                fillPaint.color = when (loc.type) {
                    "maktab" -> Color.parseColor("#7738BDF8")
                    "dmtt", "bogcha" -> Color.parseColor("#77FB7185")
                    else -> Color.parseColor("#7734D399")
                }
                canvas.drawCircle(sx, sy, 8f, fillPaint)
                canvas.drawCircle(sx, sy, 8f, strokePaint)
            }

            // 4. Route Polyline (Passed + Active Glowing Upcoming)
            val g = guidance
            if (g != null) {
                if (g.passedPoints.size >= 2) {
                    val pPath = Path()
                    g.passedPoints.forEachIndexed { idx, (lat, lng) ->
                        val (sx, sy) = toScreen(lat, lng)
                        if (idx == 0) pPath.moveTo(sx, sy) else pPath.lineTo(sx, sy)
                    }
                    canvas.drawPath(pPath, passedPaint)
                }

                if (g.remainingPoints.size >= 2) {
                    val rPath = Path()
                    g.remainingPoints.forEachIndexed { idx, (lat, lng) ->
                        val (sx, sy) = toScreen(lat, lng)
                        if (idx == 0) rPath.moveTo(sx, sy) else rPath.lineTo(sx, sy)
                    }
                    routeGlowPaint.color = if (g.isRoadRoute) Color.parseColor("#380EA5E9") else Color.parseColor("#38F59E0B")
                    routeCorePaint.color = if (g.isRoadRoute) Color.parseColor("#38BDF8") else Color.parseColor("#F59E0B")
                    routeCorePaint.pathEffect = if (g.isRoadRoute) null else DashPathEffect(floatArrayOf(16f, 12f), 0f)
                    canvas.drawPath(rPath, routeGlowPaint)
                    canvas.drawPath(rPath, routeCorePaint)
                    if (g.isRoadRoute) {
                        canvas.drawPath(rPath, routeInnerPaint)
                    }
                }

                // 5. Upcoming Turn Callout Badges directly on the bends (first 2 turns!)
                for ((idx, pair) in g.upcomingTurns.take(2).withIndex()) {
                    val (step, distMeters) = pair
                    if (step.maneuverType == "arrive") continue
                    val (tx, ty) = toScreen(step.lat, step.lng)
                    if (tx !in 16f..(width - 16f) || ty !in 16f..(height - 16f)) continue

                    val isPrimary = idx == 0
                    val (arrowSym, _, _) = WidgetMapRenderer.maneuverVisual(step)
                    fillPaint.color = if (isPrimary) Color.parseColor("#44F59E0B") else Color.parseColor("#3338BDF8")
                    canvas.drawCircle(tx, ty, if (isPrimary) 20f else 13f, fillPaint)
                    fillPaint.color = if (isPrimary) Color.parseColor("#F59E0B") else Color.parseColor("#38BDF8")
                    canvas.drawCircle(tx, ty, if (isPrimary) 8f else 5.5f, fillPaint)

                    val badge = "$arrowSym ${WidgetMapRenderer.formatDistanceUz(distMeters)}"
                    val tw = turnCalloutText.measureText(badge)
                    val bw = tw + 24f
                    val bh = 34f
                    val bx = (tx + 16f).coerceIn(10f, max(10f, width - bw - 10f))
                    val by = (ty - bh / 2f).coerceIn(10f, max(10f, height - bh - 10f))
                    val rect = RectF(bx, by, bx + bw, by + bh)
                    canvas.drawRoundRect(rect, 14f, 14f, pillBgPaint)
                    strokePaint.color = if (isPrimary) Color.parseColor("#F59E0B") else Color.parseColor("#38BDF8")
                    strokePaint.strokeWidth = 2.5f
                    canvas.drawRoundRect(rect, 14f, 14f, strokePaint)
                    canvas.drawText(badge, bx + 12f, by + 24f, turnCalloutText)
                }
            }

            // 6. Active Destination Pin + Name Badge
            target?.let { dest ->
                val (rawDx, rawDy) = toScreen(dest.lat, dest.lng)
                val dx = rawDx.coerceIn(22f, width - 22f)
                val dy = rawDy.coerceIn(26f, height - 26f)
                val pinColor = when (dest.type) {
                    "maktab" -> Color.parseColor("#0EA5E9")
                    "dmtt", "bogcha" -> Color.parseColor("#EF4444")
                    else -> Color.parseColor("#10B981")
                }
                fillPaint.color = Color.WHITE
                canvas.drawCircle(dx, dy, 15f, fillPaint)
                fillPaint.color = pinColor
                canvas.drawCircle(dx, dy, 11.5f, fillPaint)
                fillPaint.color = Color.WHITE
                canvas.drawCircle(dx, dy, 4f, fillPaint)

                val tw = destLabelText.measureText(dest.name)
                val bw = tw + 26f
                val bh = 36f
                val bx = (dx - bw / 2f).coerceIn(10f, max(10f, width - bw - 10f))
                val by = (dy - 20f - bh).coerceIn(10f, max(10f, height - bh - 10f))
                val rect = RectF(bx, by, bx + bw, by + bh)
                canvas.drawRoundRect(rect, 15f, 15f, pillBgPaint)
                strokePaint.color = pinColor
                strokePaint.strokeWidth = 2.5f
                canvas.drawRoundRect(rect, 15f, 15f, strokePaint)
                canvas.drawText(dest.name, bx + 13f, by + 25f, destLabelText)
            }

            // 7. User Directional Chevron (Points straight UP when Heading-Up is active!)
            fillPaint.color = Color.parseColor("#3838BDF8")
            canvas.drawCircle(ax, ay, 30f, fillPaint)
            val chevron = Path().apply {
                moveTo(ax, ay - 20f)
                lineTo(ax + 15f, ay + 15f)
                lineTo(ax, ay + 6f)
                lineTo(ax - 15f, ay + 15f)
                close()
            }
            fillPaint.color = Color.parseColor("#38BDF8")
            canvas.drawPath(chevron, fillPaint)
            strokePaint.color = Color.WHITE
            strokePaint.strokeWidth = 3.5f
            canvas.drawPath(chevron, strokePaint)
        }
    }
}
