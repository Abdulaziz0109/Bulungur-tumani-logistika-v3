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
import java.util.Locale
import java.util.concurrent.Executors

class MmtbWidgetProvider : AppWidgetProvider() {

    companion object {
        const val ACTION_REFRESH = "uz.bulungur.mmtb.ACTION_REFRESH"
        const val ACTION_SET_FILTER = "uz.bulungur.mmtb.ACTION_SET_FILTER"
        const val ACTION_AUTO_TICK = "uz.bulungur.mmtb.ACTION_AUTO_TICK"
        const val ACTION_PASSIVE_LOCATION = "uz.bulungur.mmtb.ACTION_PASSIVE_LOCATION"
        const val EXTRA_FILTER = "extra_filter"

        private const val REQUEST_CODE_AUTO_TICK = 401
        private const val REQUEST_CODE_PASSIVE_LOC = 402

        private val executor = Executors.newSingleThreadExecutor()

        /**
         * Registers two ultra-low-battery auto-update hooks:
         * 1. PASSIVE_PROVIDER location listener (0% extra GPS drain — piggybacks on system/Yandex/Google fixes, >=200m & >=2min)
         * 2. Non-wakeup ELAPSED_REALTIME inexact alarm (~15 min, NEVER wakes a sleeping phone, skips when screen is off)
         */
        @SuppressLint("MissingPermission")
        fun scheduleSmartAutoUpdates(context: Context) {
            val appCtx = context.applicationContext
            val appWidgetManager = AppWidgetManager.getInstance(appCtx)
            val ids = appWidgetManager.getAppWidgetIds(
                ComponentName(appCtx, MmtbWidgetProvider::class.java)
            )
            if (ids.isEmpty()) return

            // 1. Non-wakeup inexact periodic check (never wakes phone from Doze/sleep)
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
                // Ignore if alarm scheduling is restricted by OEM battery saver
            }

            // 2. Zero-drain passive location listener (piggybacks on existing location updates)
            if (WidgetDataFetcher.hasLocationPermission(appCtx)) {
                try {
                    val lm = appCtx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                    val passivePending = buildPassiveLocationPendingIntent(appCtx)
                    lm?.removeUpdates(passivePending)
                    lm?.requestLocationUpdates(
                        LocationManager.PASSIVE_PROVIDER,
                        2 * 60 * 1000L, // at most every 2 minutes
                        200f,           // only when moved >= 200 meters
                        passivePending
                    )
                } catch (_: SecurityException) {
                    // Safely ignore if background location is not yet granted
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
            // Explicit Intent + FLAG_MUTABLE so Android fills KEY_LOCATION_CHANGED safely on Android 14
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

            ACTION_PASSIVE_LOCATION -> {
                val loc = extractLocationExtra(intent)
                if (loc != null) {
                    WidgetDataFetcher.saveLastKnownFix(context, loc.latitude, loc.longitude, loc.time)
                }
                val pendingResult = goAsync()
                executor.execute {
                    try {
                        // Local-only update (<5ms, zero GPS/network cost), skips if moved < 150m
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
                // Never waste battery while screen is off / phone is in pocket
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
        val snapshot = WidgetDataFetcher.loadSnapshot(
            context = context,
            forceNetwork = forceNetwork,
            requestFreshGps = requestFreshGps
        )

        if (skipIfStationary && !WidgetDataFetcher.shouldRedrawForLocation(
                context = context,
                lat = snapshot.refLat,
                lng = snapshot.refLng,
                filter = activeFilter
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

        for (appWidgetId in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.widget_mmtb)

            // Header subtitle & hero nearest metric
            val gpsLabel = if (snapshot.hasGps) {
                "Joylashuvingiz bo'yicha eng yaqinlar"
            } else {
                "Bulung'ur markazi bo'yicha"
            }
            views.setTextViewText(R.id.tv_subtitle, gpsLabel)
            views.setTextViewText(
                R.id.tv_counts,
                "${snapshot.totalMaktab} maktab · ${snapshot.totalDmtt} bog'cha"
            )

            val nearest = filtered.firstOrNull()
            if (nearest != null) {
                views.setTextViewText(
                    R.id.tv_hero_dist,
                    String.format(Locale.US, "%.1f km", nearest.distKm)
                )
                views.setTextViewText(R.id.tv_hero_name, nearest.name)
            } else {
                views.setTextViewText(R.id.tv_hero_dist, "${snapshot.locations.size} ta")
                views.setTextViewText(R.id.tv_hero_name, "Bulung'ur MMTB")
            }

            // Active filter pill backgrounds
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

            // Filter click intents
            views.setOnClickPendingIntent(
                R.id.btn_filter_all,
                buildFilterPendingIntent(context, "all", 101)
            )
            views.setOnClickPendingIntent(
                R.id.btn_filter_maktab,
                buildFilterPendingIntent(context, "maktab", 102)
            )
            views.setOnClickPendingIntent(
                R.id.btn_filter_dmtt,
                buildFilterPendingIntent(context, "dmtt", 103)
            )

            // Refresh icon click
            val refreshIntent = Intent(context, MmtbWidgetProvider::class.java).apply {
                action = ACTION_REFRESH
            }
            val refreshPending = PendingIntent.getBroadcast(
                context,
                104,
                refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.btn_refresh, refreshPending)

            // Open Full Map card
            views.setOnClickPendingIntent(
                R.id.card_open_map,
                buildOpenAppPendingIntent(context, "/", 105)
            )

            // Quick Search bar -> opens instant native floating search overlay (0ms, no WebView)
            views.setOnClickPendingIntent(
                R.id.btn_quick_search,
                buildQuickSearchPendingIntent(context, 106)
            )

            // Bind scrollable & vertically expandable ListView adapter
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

            appWidgetManager.updateAppWidget(appWidgetId, views)
            appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.lv_widget_locations)
        }

        WidgetDataFetcher.recordRenderedState(context, snapshot.refLat, snapshot.refLng, activeFilter)
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

    private fun buildRowNavTemplatePendingIntent(
        context: Context,
        appWidgetId: Int
    ): PendingIntent {
        // Explicit Intent + FLAG_MUTABLE satisfies Android 14 (targetSdk 34) PendingIntentTemplate rules
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

