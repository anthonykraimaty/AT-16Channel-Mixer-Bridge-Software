package app.mixerbridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.Process;
import android.util.Log;

import java.io.File;
import java.net.Inet4Address;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Keeps the bridge running while the app is out of sight. Android ends apps
 * it cannot see; with that the mixer would lose its connection and fall back
 * to its physical faders. A foreground service, shown by a notification that
 * stays, is what Android leaves alone.
 */
public class BridgeService extends Service {
    static final String ACTION_STOP = "app.mixerbridge.STOP";
    private static final String TAG = "MixerBridge";
    private static final String CHANNEL = "bridge";
    private static final int NOTIFICATION = 1;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private String address = "";

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);

        show();
        keepAwake();
        watchAddress();
        NodeRunner.start(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stop();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        release();
        super.onDestroy();
    }

    private void show() {
        Notification notification = build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION, notification);
        }
    }

    private Notification build() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, BridgeService.class).setAction(ACTION_STOP), flags);
        String text = address.isEmpty()
                ? getString(R.string.notification_no_network)
                : getString(R.string.notification_address, address, NodeRunner.PORT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(new Notification.Action.Builder(null, getString(R.string.action_stop), stop).build())
                .build();
    }

    /** The processor and the Wi-Fi must not doze off while the bridge is on. */
    private void keepAwake() {
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MixerBridge:bridge");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();

        WifiManager wifi = getApplicationContext().getSystemService(WifiManager.class);
        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wifi.createWifiLock(mode, "MixerBridge:wifi");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
    }

    /**
     * Finds the address other devices reach this one at, for the notification
     * and for the links the interface hands out. Node itself is not allowed
     * to look it up on Android.
     */
    private void watchAddress() {
        connectivity = getSystemService(ConnectivityManager.class);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
                update(properties);
            }

            @Override
            public void onLost(Network network) {
                setAddress("");
            }
        };
        NetworkRequest request = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
                .build();
        connectivity.registerNetworkCallback(request, networkCallback);
        Network active = connectivity.getActiveNetwork();
        if (active != null) update(connectivity.getLinkProperties(active));
    }

    private void update(LinkProperties properties) {
        if (properties == null) return;
        for (LinkAddress link : properties.getLinkAddresses()) {
            if (link.getAddress() instanceof Inet4Address && !link.getAddress().isLoopbackAddress()) {
                setAddress(link.getAddress().getHostAddress());
                return;
            }
        }
    }

    private synchronized void setAddress(String value) {
        if (value == null || value.equals(address)) return;
        address = value;
        try {
            File data = NodeRunner.dataDir(this);
            //noinspection ResultOfMethodCallIgnored
            data.mkdirs();
            Files.write(new File(data, "address.txt").toPath(), value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "could not note the address", e);
        }
        getSystemService(NotificationManager.class).notify(NOTIFICATION, build());
    }

    private void release() {
        if (networkCallback != null) {
            try {
                connectivity.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // was never registered
            }
            networkCallback = null;
        }
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    /** Node cannot be stopped from inside; ending the bridge means ending the app. */
    private void stop() {
        release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        sendBroadcast(new Intent(MainActivity.ACTION_CLOSE).setPackage(getPackageName()));
        new Thread(() -> {
            try {
                Thread.sleep(400);
            } catch (InterruptedException ignored) {
                // going away anyway
            }
            Process.killProcess(Process.myPid());
        }).start();
    }

    static void start(Context context) {
        context.startForegroundService(new Intent(context, BridgeService.class));
    }
}
