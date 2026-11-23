package uz.bulungur.mmtb

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

/**
 * Lightweight Foreground Location Service toggled directly from the Home Screen Widget ("Jonli").
 * Continuously tracks the user's movement (every 10s / 30m) and pushes live updates to the widget's
 * auto-zooming route map while driving. Includes a 1-tap Stop button in the quiet notification.
 */
class LiveLocationService : Service() {

    companion object {
        const val ACTION_START = "uz.bulungur.mmtb.LIVE_GPS_START"
        const val ACTION_STOP = "uz.bulungur.mmtb.LIVE_GPS_STOP"
        private const val CHANNEL_ID = "mmtb_live_gps_channel"
        private const val NOTIF_ID = 2026
    }

    private var locationManager: LocationManager? = null
    private var isListening = false

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            WidgetDataFetcher.saveLastKnownFix(
                context = applicationContext,
                lat = location.latitude,
                lng = location.longitude,
                timestampMs = location.time,
                bearingDeg = if (location.hasBearing()) location.bearing else null,
                speedMps = if (location.hasSpeed()) location.speed else null
            )
            val intent = Intent(applicationContext, MmtbWidgetProvider::class.java).apply {
                action = MmtbWidgetProvider.ACTION_PASSIVE_LOCATION
                putExtra(LocationManager.KEY_LOCATION_CHANGED, location)
            }
            applicationContext.sendBroadcast(intent)
        }

        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            WidgetDataFetcher.setLiveGpsEnabled(applicationContext, false)
            stopSelfCleanly()
            notifyWidgetStateChanged()
            return START_NOT_STICKY
        }

        if (!WidgetDataFetcher.hasLocationPermission(applicationContext)) {
            WidgetDataFetcher.setLiveGpsEnabled(applicationContext, false)
            stopSelf()
            return START_NOT_STICKY
        }

        createNotificationChannel()
        val notification = buildNotification()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIF_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                )
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (_: Exception) {
            WidgetDataFetcher.setLiveGpsEnabled(applicationContext, false)
            stopSelf()
            return START_NOT_STICKY
        }

        WidgetDataFetcher.setLiveGpsEnabled(applicationContext, true)
        startLocationUpdates()
        return START_STICKY
    }

    @SuppressLint("MissingPermission")
    private fun startLocationUpdates() {
        if (isListening) return
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        locationManager = lm

        val providers = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            providers.add(LocationManager.FUSED_PROVIDER)
        }
        providers.add(LocationManager.GPS_PROVIDER)
        providers.add(LocationManager.NETWORK_PROVIDER)

        var attachedAny = false
        for (provider in providers) {
            try {
                if (lm.isProviderEnabled(provider)) {
                    lm.requestLocationUpdates(
                        provider,
                        4_000L, // every 4 seconds while moving (pure vector HUD = <8ms, 0 tile data)
                        10f,    // >= 10 meters movement for live turn-by-turn meter countdown
                        locationListener,
                        Looper.getMainLooper()
                    )
                    attachedAny = true
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                        provider == LocationManager.FUSED_PROVIDER
                    ) {
                        break // FUSED already combines GPS + Network efficiently
                    }
                }
            } catch (_: Exception) {
                // Try next provider
            }
        }
        isListening = attachedAny
    }

    private fun stopSelfCleanly() {
        try {
            locationManager?.removeUpdates(locationListener)
        } catch (_: Exception) {
            // Ignore
        }
        isListening = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun notifyWidgetStateChanged() {
        val intent = Intent(applicationContext, MmtbWidgetProvider::class.java).apply {
            action = MmtbWidgetProvider.ACTION_REFRESH
        }
        applicationContext.sendBroadcast(intent)
    }

    override fun onDestroy() {
        try {
            locationManager?.removeUpdates(locationListener)
        } catch (_: Exception) {
            // Ignore
        }
        isListening = false
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Jonli GPS vidjet xaritasi",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Vidjetdagi xarita va eng yaqin marshrutni uzluksiz yangilab turadi"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openMapIntent = Intent(this, FloatingMapActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION
        }
        val openPending = PendingIntent.getActivity(
            this,
            501,
            openMapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, LiveLocationService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            502,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Bulung'ur MMTB · Jonli GPS faol")
            .setContentText("Vidjet xaritasi va marshrut avto yangilanmoqda")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openPending)
            .addAction(0, "To'xtatish", stopPending)
            .build()
    }
}
