package app.mixerbridge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.View;
import android.view.WindowManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Shows the interface the bridge serves, full screen. */
public class MainActivity extends Activity {
    static final String ACTION_CLOSE = "app.mixerbridge.CLOSE";
    private static final String HOME = "http://127.0.0.1:" + NodeRunner.PORT + "/";
    private static final int PICK_FILE = 10;
    private static final int ASK_NOTIFICATIONS = 11;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private TextView waiting;
    private ValueCallback<Uri[]> filePicker;
    private boolean loaded;

    private final BroadcastReceiver closer = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            finishAndRemoveTask();
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(13, 14, 16));
        getWindow().setNavigationBarColor(Color.rgb(13, 14, 16));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(13, 14, 16));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(13, 14, 16));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVisibility(View.INVISIBLE);
        waiting = new TextView(this);
        waiting.setText(R.string.starting);
        waiting.setTextColor(Color.rgb(141, 147, 155));
        waiting.setTextSize(16);
        waiting.setGravity(android.view.Gravity.CENTER);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(waiting, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Links that ask for a new window open in this one; Back returns.
        settings.setSupportMultipleWindows(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // nothing on the device opens this kind of link
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // The bridge was not up yet, or has gone: wait for it and load again.
                if (request.isForMainFrame()) waitForBridge();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePicker != null) filePicker.onReceiveValue(null);
                filePicker = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try {
                    startActivityForResult(pick, PICK_FILE);
                } catch (Exception e) {
                    filePicker = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> save(url, URLUtil.guessFileName(url, disposition, mime)));

        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(closer, new IntentFilter(ACTION_CLOSE), Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(closer, new IntentFilter(ACTION_CLOSE));
        }

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, ASK_NOTIFICATIONS);
        }
        BridgeService.start(this);
        waitForBridge();
    }

    /** Asks the bridge until it answers, then shows the interface. */
    private void waitForBridge() {
        loaded = false;
        web.setVisibility(View.INVISIBLE);
        waiting.setVisibility(View.VISIBLE);
        new Thread(() -> {
            for (int attempt = 0; attempt < 200 && !isFinishing() && !isDestroyed(); attempt++) {
                if (answers()) {
                    handler.post(() -> {
                        if (loaded || isDestroyed()) return;
                        loaded = true;
                        web.loadUrl(HOME);
                        web.setVisibility(View.VISIBLE);
                        waiting.setVisibility(View.GONE);
                    });
                    return;
                }
                try {
                    Thread.sleep(250);
                } catch (InterruptedException e) {
                    return;
                }
            }
            handler.post(() -> waiting.setText(R.string.not_starting));
        }, "wait-for-bridge").start();
    }

    private static boolean answers() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(HOME).openConnection();
            connection.setConnectTimeout(700);
            connection.setReadTimeout(1500);
            connection.setRequestMethod("HEAD");
            return connection.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Saves a file the interface offers, such as a configuration, to Downloads. */
    private void save(String address, String name) {
        new Thread(() -> {
            String message;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
                try (InputStream in = connection.getInputStream(); OutputStream out = openDownload(name)) {
                    byte[] buffer = new byte[65536];
                    for (int n = in.read(buffer); n > 0; n = in.read(buffer)) out.write(buffer, 0, n);
                } finally {
                    connection.disconnect();
                }
                message = getString(R.string.saved, name);
            } catch (Exception e) {
                message = getString(R.string.not_saved, name);
            }
            String text = message;
            handler.post(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
        }, "download").start();
    }

    private OutputStream openDownload(String name) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("no place to save");
            return getContentResolver().openOutputStream(uri);
        }
        File folder = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        return new FileOutputStream(new File(folder, name));
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILE || filePicker == null) return;
        Uri[] chosen = result == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null;
        filePicker.onReceiveValue(chosen);
        filePicker = null;
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The service may have been stopped from its notification.
        BridgeService.start(this);
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(closer);
        web.destroy();
        super.onDestroy();
    }
}
