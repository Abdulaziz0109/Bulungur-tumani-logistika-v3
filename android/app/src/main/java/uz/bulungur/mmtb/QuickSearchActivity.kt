package uz.bulungur.mmtb

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Instant, zero-WebView native floating search overlay launched directly from the home screen widget.
 * Loads all 109+ Bulung'ur schools, kindergartens & organizations in <5ms from local cache/seed
 * so users can type and jump straight into Yandex or Google Maps without opening the full web app.
 */
class QuickSearchActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_NAV_URL = "extra_nav_url"
        const val EXTRA_HUD_TARGET_ID = "extra_hud_target_id"
    }

    private lateinit var etSearch: EditText
    private lateinit var btnClear: TextView
    private lateinit var tvSubtitle: TextView
    private lateinit var tvEmpty: TextView
    private lateinit var listView: ListView
    private lateinit var pillAll: TextView
    private lateinit var pillMaktab: TextView
    private lateinit var pillDmtt: TextView
    private lateinit var pillTashkilot: TextView

    private var snapshot: WidgetSnapshot = WidgetSnapshot(
        locations = emptyList(),
        totalMaktab = 0,
        totalDmtt = 0,
        hasGps = false,
        refLat = 39.7647,
        refLng = 67.2714
    )
    private var activeFilter: String = "all"
    private var filteredItems: List<MmtbLocation> = emptyList()
    private lateinit var adapter: QuickSearchAdapter

    private val bgExecutor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (handleDirectNavIntent(intent)) {
            return
        }

        setContentView(R.layout.activity_quick_search)

        etSearch = findViewById(R.id.et_quick_search)
        btnClear = findViewById(R.id.btn_quick_clear)
        tvSubtitle = findViewById(R.id.tv_quick_subtitle)
        tvEmpty = findViewById(R.id.tv_quick_empty)
        listView = findViewById(R.id.lv_quick_results)
        pillAll = findViewById(R.id.pill_all)
        pillMaktab = findViewById(R.id.pill_maktab)
        pillDmtt = findViewById(R.id.pill_dmtt)
        pillTashkilot = findViewById(R.id.pill_tashkilot)

        // Tap outside floating card -> close cleanly back to home screen
        findViewById<View>(R.id.quick_search_backdrop).setOnClickListener {
            finish()
            overridePendingTransition(0, 0)
        }
        findViewById<View>(R.id.btn_quick_close).setOnClickListener {
            finish()
            overridePendingTransition(0, 0)
        }
        findViewById<View>(R.id.btn_quick_open_map).setOnClickListener {
            val mapIntent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(MainActivity.EXTRA_START_PATH, "/")
            }
            startActivity(mapIntent)
            finish()
        }

        adapter = QuickSearchAdapter()
        listView.adapter = adapter

        // Instant <5ms local load (SharedPreferences cache or bundled 109-facility seed)
        activeFilter = WidgetDataFetcher.getSavedFilter(this)
        snapshot = WidgetDataFetcher.loadCachedSnapshotFast(this)
        updateFilterPills()
        applyFilterAndSearch()

        // Silently sync fresh Firestore data in background without blocking typing
        bgExecutor.execute {
            val fresh = WidgetDataFetcher.loadSnapshot(applicationContext, forceNetwork = false)
            if (!isFinishing && !isDestroyed && fresh.locations.isNotEmpty()) {
                runOnUiThread {
                    snapshot = fresh
                    applyFilterAndSearch()
                }
            }
        }

        pillAll.setOnClickListener { setFilter("all") }
        pillMaktab.setOnClickListener { setFilter("maktab") }
        pillDmtt.setOnClickListener { setFilter("dmtt") }
        pillTashkilot.setOnClickListener { setFilter("tashkilot") }

        btnClear.setOnClickListener {
            etSearch.setText("")
            etSearch.requestFocus()
        }

        etSearch.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                btnClear.visibility = if (s.isNullOrEmpty()) View.GONE else View.VISIBLE
                applyFilterAndSearch()
            }
        })

        etSearch.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                val first = filteredItems.firstOrNull()
                if (first != null) {
                    openYandex(first)
                }
                true
            } else {
                false
            }
        }

        // Open keyboard automatically right after layout
        etSearch.requestFocus()
        etSearch.postDelayed({
            val imm = getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager
            imm?.showSoftInput(etSearch, InputMethodManager.SHOW_IMPLICIT)
        }, 60)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDirectNavIntent(intent)
    }

    private fun handleDirectNavIntent(intent: Intent?): Boolean {
        val hudTargetId = intent?.getStringExtra(EXTRA_HUD_TARGET_ID)
        if (!hudTargetId.isNullOrBlank()) {
            val hudIntent = Intent(this, FloatingMapActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION
                putExtra(FloatingMapActivity.EXTRA_TARGET_ID, hudTargetId)
            }
            startActivity(hudIntent)
            finish()
            overridePendingTransition(0, 0)
            return true
        }
        val navUrl = intent?.getStringExtra(EXTRA_NAV_URL)
        if (!navUrl.isNullOrBlank()) {
            launchExternalUrl(navUrl)
            overridePendingTransition(0, 0)
            return true
        }
        return false
    }

    override fun onDestroy() {
        super.onDestroy()
        bgExecutor.shutdownNow()
    }

    private fun setFilter(filter: String) {
        activeFilter = filter
        updateFilterPills()
        applyFilterAndSearch()
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
        pillTashkilot.setBackgroundResource(
            if (activeFilter == "tashkilot") R.drawable.widget_pill_active else R.drawable.widget_pill_bg
        )
    }

    private fun normalize(text: String): String {
        return text
            .lowercase(Locale.ROOT)
            .replace("'", "")
            .replace("’", "")
            .replace("‘", "")
            .replace("`", "")
            .replace("ʻ", "")
            .replace("ʼ", "")
            .replace("-", " ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    private fun applyFilterAndSearch() {
        val rawQuery = etSearch.text?.toString() ?: ""
        val normQuery = normalize(rawQuery)

        val byCategory = snapshot.locations.filter { loc ->
            when (activeFilter) {
                "maktab" -> loc.type == "maktab"
                "dmtt" -> loc.type == "dmtt" || loc.type == "bogcha"
                "tashkilot" -> loc.type != "maktab" && loc.type != "dmtt" && loc.type != "bogcha"
                else -> true
            }
        }

        filteredItems = if (normQuery.isEmpty()) {
            byCategory
        } else {
            val tokens = normQuery.split(" ").filter { it.isNotEmpty() }
            val scored = byCategory.mapNotNull { loc ->
                val normName = normalize(loc.name)
                val normMahalla = normalize(loc.mahalla)
                val typeAlias = when (loc.type) {
                    "maktab" -> "maktab school"
                    "dmtt", "bogcha" -> "bogcha dmtt mtt maktabgacha"
                    else -> "tashkilot idora"
                }
                val searchable = "$normName $normMahalla $typeAlias"

                val allMatch = tokens.all { token ->
                    if (token == "dmtt" || token == "mtt" || token == "bogcha") {
                        loc.type == "dmtt" || loc.type == "bogcha" || normName.contains(token)
                    } else if (token == "maktab") {
                        loc.type == "maktab" || normName.contains(token)
                    } else {
                        searchable.contains(token)
                    }
                }
                if (!allMatch) return@mapNotNull null

                // Priority score: exact leading number match first (e.g. "51" -> "51-maktab" before "151")
                val leadingNum = Regex("^(\\d+)").find(normName)?.groupValues?.get(1)
                val queryNum = tokens.firstOrNull { it.all { ch -> ch.isDigit() } }
                val score = when {
                    normName == normQuery -> 0
                    queryNum != null && leadingNum == queryNum -> 1
                    normName.startsWith(normQuery) -> 2
                    tokens.all { normName.contains(it) } -> 3
                    else -> 4
                }
                Pair(score, loc)
            }
            scored
                .sortedWith(compareBy<Pair<Int, MmtbLocation>> { it.first }.thenBy { it.second.distKm })
                .map { it.second }
        }

        val gpsText = if (snapshot.hasGps) "GPS bo'yicha" else "Bulung'ur markazi"
        tvSubtitle.text = if (normQuery.isEmpty()) {
            "${filteredItems.size} ta obyekt · $gpsText"
        } else {
            "${filteredItems.size} ta natija topildi"
        }

        tvEmpty.visibility = if (filteredItems.isEmpty()) View.VISIBLE else View.GONE
        listView.visibility = if (filteredItems.isEmpty()) View.GONE else View.VISIBLE
        adapter.notifyDataSetChanged()
    }

    private fun openYandex(loc: MmtbLocation) {
        val url = WidgetDataFetcher.buildYandexUrl(
            loc,
            snapshot.hasGps,
            snapshot.refLat,
            snapshot.refLng
        )
        launchExternalUrl(url)
    }

    private fun openGoogle(loc: MmtbLocation) {
        val url = WidgetDataFetcher.buildGoogleUrl(loc)
        launchExternalUrl(url)
    }

    private fun launchExternalUrl(url: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            finish()
        } catch (_: Exception) {
            Toast.makeText(this, "Navigator ilovasi topilmadi", Toast.LENGTH_SHORT).show()
        }
    }

    private inner class QuickSearchAdapter : BaseAdapter() {
        override fun getCount(): Int = filteredItems.size
        override fun getItem(position: Int): MmtbLocation = filteredItems[position]
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val view = convertView ?: LayoutInflater.from(this@QuickSearchActivity)
                .inflate(R.layout.item_quick_search, parent, false)

            val loc = getItem(position)
            val tvName = view.findViewById<TextView>(R.id.tv_item_name)
            val tvMeta = view.findViewById<TextView>(R.id.tv_item_meta)
            val infoArea = view.findViewById<View>(R.id.item_info_area)
            val btnYandex = view.findViewById<View>(R.id.btn_item_yandex)
            val btnGoogle = view.findViewById<View>(R.id.btn_item_google)

            tvName.text = loc.name
            val typeLabel = when (loc.type) {
                "maktab" -> "Maktab"
                "dmtt", "bogcha" -> "Bog'cha"
                else -> "Tashkilot"
            }
            val distStr = String.format(Locale.US, "%.1f km", loc.distKm)
            tvMeta.text = if (loc.mahalla.isNotBlank()) {
                "$typeLabel · $distStr · ${loc.mahalla}"
            } else {
                "$typeLabel · $distStr"
            }

            infoArea.setOnClickListener { openYandex(loc) }
            btnYandex.setOnClickListener { openYandex(loc) }
            btnGoogle.setOnClickListener { openGoogle(loc) }

            return view
        }
    }
}
