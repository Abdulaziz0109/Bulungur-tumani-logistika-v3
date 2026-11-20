package uz.bulungur.mmtb

import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import java.util.Locale

class MmtbWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
        return MmtbWidgetViewsFactory(applicationContext)
    }
}

class MmtbWidgetViewsFactory(
    private val context: Context
) : RemoteViewsService.RemoteViewsFactory {

    private var items: List<MmtbLocation> = emptyList()
    private var hasGps: Boolean = false
    private var refLat: Double = 39.7647
    private var refLng: Double = 67.2714

    override fun onCreate() {
        loadData()
    }

    override fun onDataSetChanged() {
        loadData()
    }

    private fun loadData() {
        val snapshot = WidgetDataFetcher.loadCachedSnapshotFast(context)
        val activeFilter = WidgetDataFetcher.getSavedFilter(context)
        hasGps = snapshot.hasGps
        refLat = snapshot.refLat
        refLng = snapshot.refLng
        items = snapshot.locations.filter { loc ->
            when (activeFilter) {
                "maktab" -> loc.type == "maktab"
                "dmtt" -> loc.type == "dmtt" || loc.type == "bogcha"
                else -> true
            }
        }
    }

    override fun onDestroy() {
        items = emptyList()
    }

    override fun getCount(): Int = items.size

    override fun getViewAt(position: Int): RemoteViews {
        val rv = RemoteViews(context.packageName, R.layout.widget_location_item)
        val loc = items.getOrNull(position) ?: return rv

        rv.setTextViewText(R.id.tv_widget_item_name, loc.name)
        rv.setTextViewText(
            R.id.tv_widget_item_dist,
            String.format(Locale.US, "%.1f km", loc.distKm)
        )

        val yandexUrl = WidgetDataFetcher.buildYandexUrl(loc, hasGps, refLat, refLng)
        val googleUrl = WidgetDataFetcher.buildGoogleUrl(loc)

        val yandexFillIn = Intent().apply {
            putExtra(QuickSearchActivity.EXTRA_NAV_URL, yandexUrl)
        }
        val googleFillIn = Intent().apply {
            putExtra(QuickSearchActivity.EXTRA_NAV_URL, googleUrl)
        }

        rv.setOnClickFillInIntent(R.id.tv_widget_item_name, yandexFillIn)
        rv.setOnClickFillInIntent(R.id.btn_widget_item_yandex, yandexFillIn)
        rv.setOnClickFillInIntent(R.id.btn_widget_item_google, googleFillIn)

        return rv
    }

    override fun getLoadingView(): RemoteViews? = null

    override fun getViewTypeCount(): Int = 1

    override fun getItemId(position: Int): Long {
        return items.getOrNull(position)?.id?.hashCode()?.toLong() ?: position.toLong()
    }

    override fun hasStableIds(): Boolean = true
}
