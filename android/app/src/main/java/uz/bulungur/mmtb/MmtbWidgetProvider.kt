package uz.bulungur.mmtb

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.RemoteViews
import java.util.Locale
import java.util.concurrent.Executors

class MmtbWidgetProvider : AppWidgetProvider() {

    companion object {
        const val ACTION_REFRESH = "uz.bulungur.mmtb.ACTION_REFRESH"
        const val ACTION_SET_FILTER = "uz.bulungur.mmtb.ACTION_SET_FILTER"
        const val EXTRA_FILTER = "extra_filter"

        private val executor = Executors.newSingleThreadExecutor()
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        val pendingResult = goAsync()
        executor.execute {
            try {
                updateAllWidgets(context, appWidgetManager, appWidgetIds, forceNetwork = true)
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
                updateAllWidgets(context, appWidgetManager, intArrayOf(appWidgetId), forceNetwork = false)
            } finally {
                pendingResult.finish()
            }
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        val action = intent.action ?: return
        if (action == ACTION_REFRESH || action == ACTION_SET_FILTER) {
            val forceNetwork = action == ACTION_REFRESH
            if (action == ACTION_SET_FILTER) {
                val filter = intent.getStringExtra(EXTRA_FILTER) ?: "all"
                WidgetDataFetcher.setSavedFilter(context, filter)
            }
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val ids = appWidgetManager.getAppWidgetIds(
                ComponentName(context, MmtbWidgetProvider::class.java)
            )
            if (ids.isNotEmpty()) {
                val pendingResult = goAsync()
                executor.execute {
                    try {
                        updateAllWidgets(context, appWidgetManager, ids, forceNetwork = forceNetwork)
                    } finally {
                        pendingResult.finish()
                    }
                }
            }
        }
    }

    private fun updateAllWidgets(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
        forceNetwork: Boolean
    ) {
        val snapshot = WidgetDataFetcher.loadSnapshot(context, forceNetwork)
        val activeFilter = WidgetDataFetcher.getSavedFilter(context)

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
