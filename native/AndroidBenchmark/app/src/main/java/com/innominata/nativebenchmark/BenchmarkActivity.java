package com.innominata.nativebenchmark;

import android.app.Activity;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Choreographer;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class BenchmarkActivity extends Activity
        implements SurfaceHolder.Callback, Choreographer.FrameCallback {
    static {
        System.loadLibrary("native-benchmark");
    }

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SurfaceView surfaceView;
    private Spinner planSpinner;
    private EditText instanceCountInput;
    private TextView statusView;
    private boolean previewActive;
    private int previewRequest;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        hideSystemUi();
        nativeInitialize(getAssets());
        setContentView(buildUi());
        loadBundledPlans();
    }

    private View buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(16, 20, 22));

        surfaceView = new SurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        surfaceView.setBackgroundColor(Color.rgb(8, 10, 11));
        root.addView(surfaceView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        LinearLayout controls = new LinearLayout(this);
        controls.setGravity(Gravity.CENTER_VERTICAL);
        controls.setPadding(dp(16), dp(10), dp(16), dp(10));

        planSpinner = new Spinner(this);
        controls.addView(planSpinner, new LinearLayout.LayoutParams(0, dp(48), 1f));

        Button validate = new Button(this);
        validate.setText("Validate plan");
        validate.setOnClickListener(ignored -> validateSelectedPlan());
        controls.addView(validate);

        Button probe = new Button(this);
        probe.setText("Probe Vulkan");
        probe.setOnClickListener(ignored -> probeVulkan());
        controls.addView(probe);

        Button inspect = new Button(this);
        inspect.setText("Inspect GLB");
        inspect.setOnClickListener(ignored -> inspectBundledAsset());
        controls.addView(inspect);
        root.addView(controls);

        LinearLayout previewControls = new LinearLayout(this);
        previewControls.setGravity(Gravity.CENTER_VERTICAL);
        previewControls.setPadding(dp(16), 0, dp(16), dp(8));

        TextView instanceLabel = new TextView(this);
        instanceLabel.setText("Preview instances");
        instanceLabel.setTextColor(Color.rgb(224, 230, 228));
        instanceLabel.setPadding(0, 0, dp(8), 0);
        previewControls.addView(instanceLabel);

        instanceCountInput = new EditText(this);
        instanceCountInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        instanceCountInput.setSingleLine(true);
        instanceCountInput.setText("1");
        instanceCountInput.setTextColor(Color.WHITE);
        instanceCountInput.setHintTextColor(Color.GRAY);
        previewControls.addView(
            instanceCountInput,
            new LinearLayout.LayoutParams(dp(88), dp(48))
        );

        Button preview = new Button(this);
        preview.setText("Preview selected");
        preview.setOnClickListener(ignored -> startSelectedPreview());
        previewControls.addView(preview);

        Button stop = new Button(this);
        stop.setText("Stop");
        stop.setOnClickListener(ignored -> stopPreview(true));
        previewControls.addView(stop);

        TextView warning = new TextView(this);
        warning.setText("Visual gate only. Collection disabled.");
        warning.setTextColor(Color.rgb(244, 188, 96));
        warning.setPadding(dp(12), 0, 0, 0);
        previewControls.addView(warning);
        root.addView(previewControls);

        statusView = new TextView(this);
        statusView.setTextColor(Color.rgb(224, 230, 228));
        statusView.setTextSize(13);
        statusView.setPadding(dp(16), 0, dp(16), dp(10));
        statusView.setText(
            "Preview build. Benchmark collection stays disabled until flat "
                + "and material rendering pass device visual validation."
        );
        root.addView(statusView);

        TextView build = new TextView(this);
        build.setTextColor(Color.rgb(150, 164, 160));
        build.setTextSize(11);
        build.setPadding(dp(16), 0, dp(16), dp(10));
        build.setText(
            "version=" + BuildConfig.VERSION_NAME
                + " commit=" + BuildConfig.APP_COMMIT
                + " worktree=" + BuildConfig.WORKTREE_STATE
                + " native=" + nativeCoreVersion()
        );
        root.addView(build);
        return root;
    }

    private void loadBundledPlans() {
        try {
            String[] plans = getAssets().list("benchmark/plans");
            if (plans == null || plans.length == 0) {
                setStatus("No bundled native plans found.");
                return;
            }
            Arrays.sort(plans);
            ArrayAdapter<String> adapter = new ArrayAdapter<>(
                this,
                android.R.layout.simple_spinner_dropdown_item,
                plans
            );
            planSpinner.setAdapter(adapter);
            setStatus(
                "Loaded " + plans.length
                    + " plans. Select a plan, set a preview instance count, "
                    + "then validate or preview it."
            );
        } catch (IOException error) {
            setStatus("Could not enumerate plans: " + error.getMessage());
        }
    }

    private void validateSelectedPlan() {
        Object selected = planSpinner.getSelectedItem();
        if (selected == null) {
            setStatus("Select a plan first.");
            return;
        }
        String assetPath = "benchmark/plans/" + selected;
        setStatus("Validating " + selected + "...");
        worker.execute(() -> {
            String result = nativeValidatePlan(getAssets(), assetPath);
            runOnUiThread(() -> setStatus(result));
        });
    }

    private void probeVulkan() {
        stopPreview(false);
        setStatus("Probing Vulkan instance, surface, queue, and swapchain support...");
        worker.execute(() -> {
            String result = saveVulkanProbe(nativeProbeVulkan());
            runOnUiThread(() -> setStatus(result));
        });
    }

    private void inspectBundledAsset() {
        setStatus("Parsing bundled GLB geometry and material metadata...");
        worker.execute(() -> {
            String result = nativeInspectAsset(getAssets(), "benchmark/model.glb");
            runOnUiThread(() -> setStatus(result));
        });
    }

    private void startSelectedPreview() {
        Object selected = planSpinner.getSelectedItem();
        if (selected == null) {
            setStatus("Select a plan first.");
            return;
        }

        final int instanceCount;
        try {
            instanceCount = Integer.parseInt(instanceCountInput.getText().toString());
            if (instanceCount < 1 || instanceCount > 4096) {
                throw new NumberFormatException();
            }
        } catch (NumberFormatException error) {
            setStatus("Preview instances must be an integer from 1 through 4096.");
            return;
        }

        stopPreview(false);
        final int request = ++previewRequest;
        final String planName = selected.toString();
        final String assetPath = "benchmark/plans/" + planName;
        setStatus(
            "Starting visual preview for " + planName
                + " at " + instanceCount + " instances..."
        );
        worker.execute(() -> {
            String result = nativeStartPreview(
                getAssets(),
                assetPath,
                instanceCount
            );
            runOnUiThread(() -> {
                if (request != previewRequest) {
                    nativeStopPreview();
                    return;
                }
                if (!result.startsWith("Preview ready")) {
                    previewActive = false;
                    setStatus(result);
                    return;
                }
                previewActive = true;
                setStatus(
                    result
                        + "\nConfirm geometry, texture/color, orientation, "
                        + "and flat/material separation. This is not a timed run."
                );
                Choreographer.getInstance().postFrameCallback(this);
            });
        });
    }

    private void stopPreview(boolean reportStatus) {
        ++previewRequest;
        previewActive = false;
        Choreographer.getInstance().removeFrameCallback(this);
        nativeStopPreview();
        if (reportStatus) {
            setStatus("Preview stopped. No benchmark data were recorded.");
        }
    }

    @Override
    public void doFrame(long frameTimeNanos) {
        if (!previewActive) return;
        if (!nativeRenderFrame(frameTimeNanos)) {
            previewActive = false;
            setStatus("Preview stopped: " + nativeRendererLastError());
            return;
        }
        Choreographer.getInstance().postFrameCallback(this);
    }

    private String saveVulkanProbe(String nativeJson) {
        try {
            JSONObject report = new JSONObject(nativeJson);
            report.put("device_manufacturer", Build.MANUFACTURER);
            report.put("device_model", Build.MODEL);
            report.put("device_code_name", Build.DEVICE);
            report.put("os_version", Build.VERSION.RELEASE);
            report.put("sdk_level", Build.VERSION.SDK_INT);
            report.put("build_fingerprint", Build.FINGERPRINT);
            report.put("app_version", BuildConfig.VERSION_NAME);
            report.put("app_commit", BuildConfig.APP_COMMIT);
            report.put("worktree_state", BuildConfig.WORKTREE_STATE);
            report.put("runtime_flavor", BuildConfig.RUNTIME_FLAVOR);
            report.put("captured_at", new SimpleDateFormat(
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
                Locale.US
            ).format(new Date()));

            File directory = new File(getExternalFilesDir(null), "capabilities");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IOException("could not create capability directory");
            }
            String timestamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
                .format(new Date());
            File output = new File(directory, "vulkan-capability__" + timestamp + ".json");
            try (FileWriter writer = new FileWriter(output, false)) {
                writer.write(report.toString(2));
                writer.write('\n');
            }
            if (report.optBoolean("ok")) {
                return "Vulkan probe passed"
                    + "\nGPU=" + report.optString("gpu_renderer")
                    + " API=" + report.optString("vulkan_api_version")
                    + "\nSaved " + output.getAbsolutePath();
            }
            return "Vulkan probe failed: " + report.optString("error")
                + "\nSaved " + output.getAbsolutePath();
        } catch (JSONException | IOException error) {
            return "Could not save Vulkan probe: " + error.getMessage()
                + "\nRaw response: " + nativeJson;
        }
    }

    private void setStatus(String message) {
        statusView.setText(message);
    }

    private void hideSystemUi() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        nativeSetSurface(holder.getSurface());
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        stopPreview(false);
        nativeSetSurface(holder.getSurface());
        nativeSetSurfaceSize(width, height);
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        stopPreview(false);
        nativeSetSurface(null);
    }

    @Override
    protected void onPause() {
        stopPreview(false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopPreview(false);
        nativeSetSurface(null);
        nativeShutdown();
        worker.shutdownNow();
        super.onDestroy();
    }

    private static native void nativeInitialize(AssetManager assets);
    private static native void nativeSetSurface(Surface surface);
    private static native void nativeSetSurfaceSize(int width, int height);
    private static native String nativeValidatePlan(AssetManager assets, String assetPath);
    private static native String nativeInspectAsset(AssetManager assets, String assetPath);
    private static native String nativeProbeVulkan();
    private static native String nativeStartPreview(
        AssetManager assets,
        String planAssetPath,
        int instanceCount
    );
    private static native boolean nativeRenderFrame(long frameTimeNanos);
    private static native String nativeRendererLastError();
    private static native void nativeStopPreview();
    private static native String nativeCoreVersion();
    private static native void nativeShutdown();
}
