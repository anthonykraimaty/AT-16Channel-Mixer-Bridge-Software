package app.mixerbridge;

import android.content.Context;
import android.system.Os;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Runs the bridge, the same program that runs on a computer, inside the app.
 * Node can be started once per process and cannot be stopped again; ending it
 * means ending the process.
 */
final class NodeRunner {
    static final int PORT = 8600;
    private static final String TAG = "MixerBridge";
    private static boolean started;

    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    private NodeRunner() {
    }

    private static native int startNode(String[] arguments);

    static File dataDir(Context context) {
        return new File(context.getFilesDir(), "data");
    }

    static synchronized void start(Context context) {
        if (started) return;
        started = true;
        Context app = context.getApplicationContext();
        Thread thread = new Thread(() -> {
            try {
                File program = unpack(app);
                File data = dataDir(app);
                if (!data.isDirectory() && !data.mkdirs()) throw new IOException("cannot create " + data);
                Os.setenv("MIXER_DATA", data.getAbsolutePath(), true);
                Os.setenv("PORT", String.valueOf(PORT), true);
                Os.setenv("TMPDIR", app.getCacheDir().getAbsolutePath(), true);
                int code = startNode(new String[]{"node", new File(program, "server/index.js").getAbsolutePath()});
                Log.w(TAG, "the bridge ended with code " + code);
            } catch (Exception e) {
                Log.e(TAG, "the bridge could not be started", e);
            }
        }, "bridge");
        thread.start();
    }

    /** Unpacks the bridge when the app is new or has been updated. */
    private static File unpack(Context context) throws IOException {
        File target = new File(context.getFilesDir(), "bridge");
        File marker = new File(target, "bridge.version");
        String wanted = readAsset(context, "bridge.version");
        if (marker.isFile() && wanted.equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8))) return target;

        deleteAll(target);
        String root = target.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(context.getAssets().open("bridge.zip")))) {
            byte[] buffer = new byte[65536];
            for (ZipEntry entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                File out = new File(target, entry.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("bad entry " + entry.getName());
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream stream = new FileOutputStream(out)) {
                    for (int n = zip.read(buffer); n > 0; n = zip.read(buffer)) stream.write(buffer, 0, n);
                }
            }
        }
        Files.write(marker.toPath(), wanted.getBytes(StandardCharsets.UTF_8));
        return target;
    }

    private static String readAsset(Context context, String name) throws IOException {
        try (InputStream in = context.getAssets().open(name);
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line = reader.readLine();
            return line == null ? "" : line.trim();
        }
    }

    private static void deleteAll(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteAll(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
