package uz.bulungur.mmtb

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.max

class MmtbWidgetProvider : AppWidgetProvider() {

    companion object {
        const val ACTION_REFRESH = "uz.bulungur.mmtb.ACTION_REFRESH"
        const val ACTION_SET_FILTER = "uz.bulungur.mmtb.ACTION_SET_FILTER"
        const val ACTION_AUTO_TICK = "uz.bulungur.mmtb.ACTION_AUTO_TICK"
        const val ACTION_PASSIVE_LOCATION = "uz.bulungur.mmtb.ACTION_PASSIVE_LOCATION"
        const val ACTION_TOGGLE_LIVE = "uz.bulungur.mmtb.ACTION_TOGGLE_LIVE"
        const val ACTION_ZOOM_IN = "uz.bulungur.mmtb.ACTION_ZOOM_IN"
        const val ACTION_ZOOM_OUT = "uz.bulungur.mmtb.ACTION_ZOOM_OUT"
        const val ACTION_ZOOM_AUTO = "uz.bulungur.mmtb.ACTION_ZOOM_AUTO"
        const val EXTRA_FILTER = "extra_filter"

        private const val REQUEST_CODE_AUTO_TICK = 401
        private const val REQUEST_CODE_PASSIVE_LOC = 402
        private const val HYBRID_HEIGHT_THRESHOLD_DP = 320

        private val executor = Executors.newSingleThreadExecutor()

        /**
         * Registers ultra-low-battery passive location + non-wakeup periodic checks.
         * Continuous high-frequency GPS runs ONLY when the user toggles "Jonli" ON.
         */
        @SuppressLint("MissingPermission")
        fun scheduleSmartAutoUpdates(context: Context) {
            val appCtx = context.applicationContext
            val appWidgetManager = AppWidgetManager.getInstance(appCtx)
            val ids = appWidgetManager.getAppWidgetIds(
                ComponentName(appCtx, MmtbWidgetProvider::class.java)
            )
            if (ids.isEmpty()) return

            // 1. Non-wakeup inexact periodic check (never wakes phone from sleep)
            try {
                val alarmManager = appCtx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
                val tickPending = buildAutoTickPendingIntent(appCtx)
                alarmManager?.setInexactRepeating(
                    AlarmManager.ELAPSED_REALTIME,
                    SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                    AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                    tickPending
                )
            } catch (_: Exception) {
                // Ignore OEM restrictions
            }

            // 2. Zero-drain passive location listener
            if (WidgetDataFetcher.hasLocationPermission(appCtx)) {
                try {
                    val lm = appCtx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                    val passivePending = buildPassiveLocationPendingIntent(appCtx)
                    lm?.removeUpdates(passivePending)
                    lm?.requestLocationUpdates(
                        LocationManager.PASSIVE_PROVIDER,
                        2 * 60 * 1000L,
                        150f,
                        passivePending
                    )
                } catch (_: SecurityException) {
                    // Ignore if background location not yet granted
                } catch (_: Exception) {
                    // Ignore OEM quirks
                }
            }
        }

        fun cancelSmartAutoUpdates(context: Context) {
            val appCtx = context.applicationContext
            try {
                val alarmManager = appCtx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
                alarmManager?.cancel(buildAutoTickPendingIntent(appCtx))
            } catch (_: Exception) {
                // Ignore
            }
            try {
                val lm = appCtx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                lm?.removeUpdates(buildPassiveLocationPendingIntent(appCtx))
            } catch (_: Exception) {
                // Ignore
            }
            try {
                appCtx.stopService(Intent(appCtx, LiveLocationService::class.java))
                WidgetDataFetcher.setLiveGpsEnabled(appCtx, false)
            } catch (_: Exception) {
                // Ignore
            }
        }

        private fun buildAutoTickPendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, MmtbWidgetProvider::class.java).apply {
                action = ACTION_AUTO_TICK
            }
            return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE_AUTO_TICK,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun buildPassiveLocationPendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, MmtbWidgetProvider::class.java).apply {
                action = ACTION_PASSIVE_LOCATION
            }
            val mutabilityFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_MUTABLE
            } else {
                0
            }
            return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE_PASSIVE_LOC,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag
            )
        }
    }

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        scheduleSmartAutoUpdates(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        cancelSmartAutoUpdates(context)
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        scheduleSmartAutoUpdates(context)
        val pendingResult = goAsync()
        executor.execute {
            try {
                updateAllWidgets(
                    context = context,
                    appWidgetManager = appWidgetManager,
                    appWidgetIds = appWidgetIds,
                    forceNetwork = false,
                    requestFreshGps = true,
                    skipIfStationary = false
                )
            } finally {
                pendingResult.finish()
            }
        }
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle?
    ) {
        super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
        val pendingResult = goAsync()
        executor.execute {
            try {
                updateAllWidgets(
                    context = context,
                    appWidgetManager = appWidgetManager,
                    appWidgetIds = intArrayOf(appWidgetId),
                    forceNetwork = false,
                    requestFreshGps = false,
                    skipIfStationary = false
                )
            } finally {
                pendingResult.finish()
            }
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        val action = intent.action ?: return
        val appWidgetManager = AppWidgetManager.getInstance(context)
        val ids = appWidgetManager.getAppWidgetIds(
            ComponentName(context, MmtbWidgetProvider::class.java)
        )
        if (ids.isEmpty()) return

        when (action) {
            ACTION_REFRESH, ACTION_SET_FILTER -> {
                val isManualRefresh = action == ACTION_REFRESH
                if (action == ACTION_SET_FILTER) {
                    val filter = intent.getStringExtra(EXTRA_FILTER) ?: "all"
                    WidgetDataFetcher.setSavedFilter(context, filter)
                    // Reset manual zoom back to Auto-Zoom when switching category
                    WidgetDataFetcher.setMapZoomOffset(context, 0)
                }
                scheduleSmartAutoUpdates(context)
                val pendingResult = goAsync()
                executor.execute {
                    try {
                        updateAllWidgets(
                            context = context,
                            appWidgetManager = appWidgetManager,
                            appWidgetIds = ids,
                            forceNetwork = isManualRefresh,
                            requestFreshGps = isManualRefresh,
                            skipIfStationary = false
                        )
                    } finally {
                        pendingResult.finish()
                    }
                }
            }

            ACTION_TOGGLE_LIVE -> {
                val currentlyOn = WidgetDataFetcher.isLiveGpsEnabled(context)
                if (currentlyOn) {
                    WidgetDataFetcher.setLiveGpsEnabled(context, false)
                    try {
                        context.stopService(Intent(context, LiveLocationService::class.java))
                    } catch (_: Exception) {
                        // Ignore
                    }
                } else {
                    if (!WidgetDataFetcher.hasLocationPermission(context)) {
                        // Ask permission via MainActivity
                        val permIntent = Intent(context, MainActivity::class.java).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                        }
                        context.startActivity(permIntent)
                    } else {
                        WidgetDataFetcher.setLiveGpsEnabled(context, true)
                        try {
                            val svcIntent = Intent(context, LiveLocationService::class.java).apply {
                                this.action = LiveLocationService.ACTION_START
                            }
                            ContextCompat.startForegroundService(context, svcIntent)
                        } catch (_: Exception) {
                            WidgetDataFetcher.setLiveGpsEnabled(context, false)
                        }
                    }
                }
                val pendingResult = goAsync()
                executor.execute {
                    try {
                        updateAllWidgets(
                            context = context,
                            appWidgetManager = appWidgetManager,
                            appWidgetIds = ids,
                            forceNetwork = false,
                            requestFreshGps = !currentlyOn,
                            skipIfStationary = false
                        )
                    } finally {
                        pendingResult.finish()
                    }
                }
            }

            ACTION_ZOOM_IN, ACTION_ZOOM_OUT, ACTION_ZOOM_AUTO -> {
                val cur = WidgetDataFetcher.getMapZoomOffset(context)
                val next = when (action) {
                    ACTION_ZOOM_IN -> (cur + 1).coerceAtMost(3)
                    ACTION_ZOOM_OUT -> (cur - 1).coerceAtLeast(-3)
                    else -> 0
                }
                WidgetDataFetcher.setMapZoomOffset(context, next)
                val pendingResult = goAsync()
                executor.execute {
                    try {
                        updateAllWidgets(
                            context = context,
                            appWidgetManager = appWidgetManager,
                            appWidgetIds = ids,
                            forceNetwork = false,
                            requestFreshGps = false,
                            skipIfStationary = false
                        )
                    } finally {
                        pendingResult.finish()
                    }
                }
            }

            ACTION_PASSIVE_LOCATION -> {
                val loc = extractLocationExtra(intent)
                if (loc != null) {
                    WidgetDataFetcher.saveLastKnownFix(context, loc.latitude, loc.longitude, loc.time)
                }
                val pendingResult = goAsync()
                executor.execute {
                    try {
                        updateAllWidgets(
                            context = context,
                            appWidgetManager = appWidgetManager,
                            appWidgetIds = ids,
                            forceNetwork = false,
                            requestFreshGps = false,
                            skipIfStationary = true
                        )
                    } finally {
                        pendingResult.finish()
                    }
                }
            }

            ACTION_AUTO_TICK -> {
                val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
                if (pm != null && !pm.isInteractive) {
                    return
                }
                val pendingResult = goAsync()
                executor.execute {
                    try {
                        updateAllWidgets(
                            context = context,
                            appWidgetManager = appWidgetManager,
                            appWidgetIds = ids,
                            forceNetwork = false,
                            requestFreshGps = true,
                            skipIfStationary = true
                        )
                    } finally {
                        pendingResult.finish()
                    }
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun extractLocationExtra(intent: Intent): Location? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(LocationManager.KEY_LOCATION_CHANGED, Location::class.java)
            } else {
                intent.getParcelableExtra(LocationManager.KEY_LOCATION_CHANGED)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun updateAllWidgets(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
        forceNetwork: Boolean,
        requestFreshGps: Boolean,
        skipIfStationary: Boolean
    ) {
        val activeFilter = WidgetDataFetcher.getSavedFilter(context)
        val liveOn = WidgetDataFetcher.isLiveGpsEnabled(context)
        val zoomOffset = WidgetDataFetcher.getMapZoomOffset(context)

        val snapshot = WidgetDataFetcher.loadSnapshot(
            context = context,
            forceNetwork = forceNetwork,
            requestFreshGps = requestFreshGps
        )

        val moveThreshold = if (liveOn) 30.0 else 150.0
        if (skipIfStationary && !WidgetDataFetcher.shouldRedrawForLocation(
                context = context,
                lat = snapshot.refLat,
                lng = snapshot.refLng,
                filter = activeFilter,
                minMeters = moveThreshold
            )
        ) {
            return
        }

        val filtered = snapshot.locations.filter { loc ->
            when (activeFilter) {
                "maktab" -> loc.type == "maktab"
                "dmtt" -> loc.type == "dmtt" || loc.type == "bogcha"
                else -> true
            }
        }
        val nearest = filtered.firstOrNull()

        // Render live auto-zoomed road map bitmap once and reuse across all widget instances
        val renderedMap = WidgetMapRenderer.renderWidgetMapBitmap(
            context = context,
            snapshot = snapshot,
            nearest = nearest,
            nearbyOthers = filtered,
            zoomOffset = zoomOffset,
            widthPx = 600,
            heightPx = 310
        )

        val roadKm = if (nearest != null && renderedMap.routeResult.isRoadRoute && renderedMap.routeResult.distanceMeters > 0) {
            renderedMap.routeResult.distanceMeters / 1000.0
        } else {
            nearest?.distKm ?: 0.0
        }
        val etaMin = if (nearest != null && renderedMap.routeResult.isRoadRoute && renderedMap.routeResult.durationSeconds > 0) {
            max(1, (renderedMap.routeResult.durationSeconds / 60.0).toInt())
        } else {
            null
        }

        for (appWidgetId in appWidgetIds) {
            val options = appWidgetManager.getAppWidgetOptions(appWidgetId)
            val minHeightDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 240)
            val isTallHybrid = minHeightDp >= HYBRID_HEIGHT_THRESHOLD_DP

            val layoutRes = if (isTallHybrid) {
                R.layout.widget_mmtb
            } else {
                R.layout.widget_mmtb_compact
            }
            val views = RemoteViews(context.packageName, layoutRes)

            // Live GPS toggle pill state
            views.setTextViewText(R.id.btn_toggle_live, if (liveOn) "● Jonli" else "○ Jonli")
            views.setInt(
                R.id.btn_toggle_live,
                "setBackgroundResource",
                if (liveOn) R.drawable.widget_live_on_bg else R.drawable.widget_pill_bg
            )
            views.setOnClickPendingIntent(
                R.id.btn_toggle_live,
                buildSimpleActionPendingIntent(context, ACTION_TOGGLE_LIVE, 110)
            )

            // Nearest facility hero row
            if (nearest != null) {
                views.setTextViewText(
                    R.id.tv_hero_dist,
                    String.format(Locale.US, "%.1f km", roadKm)
                )
                views.setTextViewText(R.id.tv_hero_name, nearest.name)
                val sub = buildString {
                    if (etaMin != null) append("~$etaMin daq · ")
                    append(if (snapshot.hasGps) "Jonli marshrut" else "Bulung'ur markazi")
                }
                views.setTextViewText(R.id.tv_subtitle, sub)

                val yandexUrl = WidgetDataFetcher.buildYandexUrl(
                    nearest,
                    snapshot.hasGps,
                    snapshot.refLat,
                    snapshot.refLng
                )
                val googleUrl = WidgetDataFetcher.buildGoogleUrl(nearest)
                views.setOnClickPendingIntent(
                    R.id.btn_hero_yandex,
                    buildDirectNavPendingIntent(context, yandexUrl, 120 + appWidgetId)
                )
                views.setOnClickPendingIntent(
                    R.id.btn_hero_google,
                    buildDirectNavPendingIntent(context, googleUrl, 220 + appWidgetId)
                )
            } else {
                views.setTextViewText(R.id.tv_hero_dist, "${snapshot.locations.size} ta")
                views.setTextViewText(R.id.tv_hero_name, "Bulung'ur MMTB")
                views.setTextViewText(R.id.tv_subtitle, "Ma'lumot yuklanmoqda")
            }

            // Active filter pill backgrounds & intents
            views.setInt(
                R.id.btn_filter_all,
                "setBackgroundResource",
                if (activeFilter == "all") R.drawable.widget_pill_active else R.drawable.widget_pill_bg
            )
            views.setInt(
                R.id.btn_filter_maktab,
                "setBackgroundResource",
                if (activeFilter == "maktab") R.drawable.widget_pill_active else R.drawable.widget_pill_bg
            )
            views.setInt(
                R.id.btn_filter_dmtt,
                "setBackgroundResource",
                if (activeFilter == "dmtt") R.drawable.widget_pill_active else R.drawable.widget_pill_bg
            )
            views.setOnClickPendingIntent(R.id.btn_filter_all, buildFilterPendingIntent(context, "all", 101))
            views.setOnClickPendingIntent(R.id.btn_filter_maktab, buildFilterPendingIntent(context, "maktab", 102))
            views.setOnClickPendingIntent(R.id.btn_filter_dmtt, buildFilterPendingIntent(context, "dmtt", 103))

            // Refresh, Full App, Quick Search
            views.setOnClickPendingIntent(
                R.id.btn_refresh,
                buildSimpleActionPendingIntent(context, ACTION_REFRESH, 104)
            )
            views.setOnClickPendingIntent(
                R.id.card_open_map,
                buildOpenAppPendingIntent(context, "/", 105)
            )
            views.setOnClickPendingIntent(
                R.id.btn_quick_search,
                buildQuickSearchPendingIntent(context, 106)
            )

            // Live auto-zoomed route map bitmap + tap to open interactive pinch/pan floating map
            views.setImageViewBitmap(R.id.iv_widget_map, renderedMap.bitmap)
            val zoomLabel = if (zoomOffset == 0) {
                "Avto z${renderedMap.effectiveZoom} · Surish uchun bosing"
            } else {
                "Masshtab z${renderedMap.effectiveZoom} · Surish uchun bosing"
            }
            views.setTextViewText(R.id.tv_map_badge, zoomLabel)
            views.setOnClickPendingIntent(
                R.id.iv_widget_map,
                buildFloatingMapPendingIntent(context, 107)
            )
            views.setOnClickPendingIntent(
                R.id.tv_map_badge,
                buildFloatingMapPendingIntent(context, 108)
            )

            // Map zoom + / - / Auto buttons
            views.setOnClickPendingIntent(
                R.id.btn_map_zoom_in,
                buildSimpleActionPendingIntent(context, ACTION_ZOOM_IN, 111)
            )
            views.setOnClickPendingIntent(
                R.id.btn_map_zoom_out,
                buildSimpleActionPendingIntent(context, ACTION_ZOOM_OUT, 112)
            )
            views.setOnClickPendingIntent(
                R.id.btn_map_zoom_auto,
                buildSimpleActionPendingIntent(context, ACTION_ZOOM_AUTO, 113)
            )

            // Tall Hybrid Mode: bind scrollable nearby list below the live map
            if (isTallHybrid) {
                val serviceIntent = Intent(context, MmtbWidgetService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                    data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
                }
                views.setRemoteAdapter(R.id.lv_widget_locations, serviceIntent)
                views.setEmptyView(R.id.lv_widget_locations, R.id.tv_widget_empty)
                views.setPendingIntentTemplate(
                    R.id.lv_widget_locations,
                    buildRowNavTemplatePendingIntent(context, appWidgetId)
                )
            }

            appWidgetManager.updateAppWidget(appWidgetId, views)
            if (isTallHybrid) {
                appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.lv_widget_locations)
            }
        }

        WidgetDataFetcher.recordRenderedState(context, snapshot.refLat, snapshot.refLng, activeFilter)
    }

    private fun buildSimpleActionPendingIntent(
        context: Context,
        actionName: String,
        requestCode: Int
    ): PendingIntent {
        val intent = Intent(context, MmtbWidgetProvider::class.java).apply {
            action = actionName
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildFilterPendingIntent(
        context: Context,
        filter: String,
        requestCode: Int
    ): PendingIntent {
        val intent = Intent(context, MmtbWidgetProvider::class.java).apply {
            action = ACTION_SET_FILTER
            putExtra(EXTRA_FILTER, filter)
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildQuickSearchPendingIntent(
        context: Context,
        requestCode: Int
    ): PendingIntent {
        val intent = Intent(context, QuickSearchActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildFloatingMapPendingIntent(
        context: Context,
        requestCode: Int
    ): PendingIntent {
        val intent = Intent(context, FloatingMapActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildDirectNavPendingIntent(
        context: Context,
        url: String,
        requestCode: Int
    ): PendingIntent {
        val intent = Intent(context, QuickSearchActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION
            putExtra(QuickSearchActivity.EXTRA_NAV_URL, url)
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildRowNavTemplatePendingIntent(
        context: Context,
        appWidgetId: Int
    ): PendingIntent {
        val intent = Intent(context, QuickSearchActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION
        }
        val mutabilityFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
        return PendingIntent.getActivity(
            context,
            300 + appWidgetId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag
        )
    }

    private fun buildOpenAppPendingIntent(
        context: Context,
        routePath: String,
        requestCode: Int
    ): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_START_PATH, routePath)
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
