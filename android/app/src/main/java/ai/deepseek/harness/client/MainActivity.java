package ai.deepseek.harness.client;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String PREFS = "deepseek_harness";
    private static final String SERVER_KEY = "server_url";
    private static final int FILE_CHOOSER_REQUEST = 3101;

    private WebView webView;
    private TextView connectionStatus;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> fileChooserCallback;
    private boolean connectionDialogVisible;

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(radiusDp));
        return background;
    }

    private Button toolbarButton(String label, int width) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.rgb(51, 65, 85));
        button.setTextSize(13);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(8), 0, dp(8), 0);
        button.setBackground(rounded(Color.rgb(241, 245, 249), 12));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(width), dp(38)));
        return button;
    }

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "ObsoleteSdkInt"})
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(248, 250, 252));
        getWindow().setNavigationBarColor(Color.rgb(248, 250, 252));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(248, 250, 252));
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
        }

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(16), dp(7), dp(10), dp(7));
        toolbar.setBackgroundColor(Color.rgb(248, 250, 252));
        toolbar.setElevation(dp(2));

        LinearLayout identity = new LinearLayout(this);
        identity.setOrientation(LinearLayout.VERTICAL);
        identity.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText(R.string.toolbar_title);
        title.setTextColor(Color.rgb(15, 23, 42));
        title.setTextSize(17);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        connectionStatus = new TextView(this);
        connectionStatus.setText(R.string.not_connected);
        connectionStatus.setTextColor(Color.rgb(100, 116, 139));
        connectionStatus.setTextSize(11);
        identity.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(24)));
        identity.addView(connectionStatus, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(18)));
        toolbar.addView(identity, new LinearLayout.LayoutParams(0, dp(46), 1));

        Button refreshButton = toolbarButton("↻", 42);
        refreshButton.setTextSize(20);
        refreshButton.setContentDescription(getString(R.string.retry));
        refreshButton.setOnClickListener(view -> {
            if (savedServer().isEmpty()) showServerDialog(false);
            else webView.reload();
        });
        toolbar.addView(refreshButton);

        Button serverButton = toolbarButton(getString(R.string.connection), 66);
        LinearLayout.LayoutParams serverParams = new LinearLayout.LayoutParams(dp(66), dp(38));
        serverParams.setMarginStart(dp(6));
        serverButton.setLayoutParams(serverParams);
        serverButton.setOnClickListener(view -> showServerDialog(false));
        toolbar.addView(serverButton);
        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " DeepSeekYuAndroid/1.1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebChromeClient(new HarnessChromeClient());
        webView.setWebViewClient(new HarnessWebViewClient());
        webView.setDownloadListener(this::downloadFile);
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        if (state != null) webView.restoreState(state);
        else loadSavedServer();
    }

    private void setConnectionState(String text, int color) {
        connectionStatus.setText(text);
        connectionStatus.setTextColor(color);
    }

    private String savedServer() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(SERVER_KEY, "");
    }

    private void loadSavedServer() {
        String saved = savedServer();
        if (saved.isEmpty()) showServerDialog(false);
        else webView.loadUrl(normalizeServer(saved));
    }

    private String normalizeServer(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        if (!value.toLowerCase(Locale.ROOT).startsWith("http://")
                && !value.toLowerCase(Locale.ROOT).startsWith("https://")) value = "http://" + value;
        return value;
    }

    private boolean isPrivateHost(String host) {
        if (host == null) return false;
        String value = host.toLowerCase(Locale.ROOT);
        if (value.equals("localhost") || value.equals("127.0.0.1") || value.equals("::1")) return true;
        if (value.startsWith("192.168.") || value.startsWith("10.")
                || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
        if (value.startsWith("172.")) {
            String[] parts = value.split("\\.");
            if (parts.length == 4) {
                try {
                    int second = Integer.parseInt(parts[1]);
                    return second >= 16 && second <= 31;
                } catch (NumberFormatException ignored) { }
            }
        }
        return false;
    }

    private boolean validServer(Uri uri) {
        String scheme = uri.getScheme();
        String token = uri.getQueryParameter("token");
        return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && isPrivateHost(uri.getHost()) && uri.getPort() > 0 && token != null && token.length() >= 24;
    }

    private void showServerDialog(boolean connectionFailed) {
        if (connectionDialogVisible || isFinishing()) return;
        connectionDialogVisible = true;

        LinearLayout holder = new LinearLayout(this);
        holder.setOrientation(LinearLayout.VERTICAL);
        holder.setPadding(dp(22), dp(4), dp(22), 0);
        TextView help = new TextView(this);
        help.setText(connectionFailed ? R.string.connection_help_failed : R.string.connection_help);
        help.setTextColor(Color.rgb(71, 85, 105));
        help.setTextSize(13);
        help.setLineSpacing(0, 1.15f);
        holder.addView(help, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(savedServer());
        input.setSelectAllOnFocus(true);
        input.setHint(R.string.server_hint);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        inputParams.topMargin = dp(12);
        holder.addView(input, inputParams);

        Button pasteButton = toolbarButton(getString(R.string.paste_address), 130);
        LinearLayout.LayoutParams pasteParams = new LinearLayout.LayoutParams(dp(130), dp(40));
        pasteParams.topMargin = dp(8);
        pasteButton.setLayoutParams(pasteParams);
        pasteButton.setOnClickListener(view -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) input.setText(clip.getItemAt(0).coerceToText(this));
        });
        holder.addView(pasteButton);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(connectionFailed ? R.string.connection_failed : R.string.server_address)
                .setView(holder)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.connect, null)
                .create();
        dialog.setOnDismissListener(ignored -> connectionDialogVisible = false);
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String normalized = normalizeServer(input.getText().toString());
            Uri uri = Uri.parse(normalized);
            if (!validServer(uri)) {
                input.setError(getString(R.string.invalid_server));
                return;
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(SERVER_KEY, normalized).apply();
            dialog.dismiss();
            setConnectionState(getString(R.string.connecting), Color.rgb(37, 99, 235));
            webView.loadUrl(normalized);
        }));
        dialog.show();
        input.requestFocus();
    }

    private boolean sameServer(Uri uri) {
        Uri saved = Uri.parse(normalizeServer(savedServer()));
        return uri != null && saved.getHost() != null && saved.getHost().equalsIgnoreCase(uri.getHost())
                && saved.getPort() == uri.getPort();
    }

    private void openExternal(Uri uri) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (Exception ignored) { Toast.makeText(this, R.string.unsupported_link, Toast.LENGTH_SHORT).show(); }
    }

    private void downloadFile(String url, String userAgent, String disposition, String mimeType, long length) {
        Uri uri = Uri.parse(url);
        if (!sameServer(uri) || "blob".equalsIgnoreCase(uri.getScheme())) {
            Toast.makeText(this, R.string.download_not_supported, Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            String filename = URLUtil.guessFileName(url, disposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setTitle(filename);
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                result = new Uri[clip.getItemCount()];
                for (int index = 0; index < clip.getItemCount(); index++) result[index] = clip.getItemAt(index).getUri();
            } else if (data.getData() != null) result = new Uri[]{data.getData()};
        }
        fileChooserCallback.onReceiveValue(result);
        fileChooserCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        webView.evaluateJavascript("(()=>{const open=document.body?.classList.contains('dsy-mobile-sidebar-open');window.__dshMobileShellClose?.();return Boolean(open)})()", value -> {
            if ("true".equals(value)) return;
            if (webView.canGoBack()) webView.goBack();
            else MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.removeAllViews();
            webView.destroy();
        }
        super.onDestroy();
    }

    private final class HarnessChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int progress) {
            progressBar.setProgress(progress);
            progressBar.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            String[] accepted = params.getAcceptTypes();
            String type = accepted.length > 0 && accepted[0] != null && !accepted[0].isEmpty() ? accepted[0] : "image/*";
            intent.setType(type);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try { startActivityForResult(intent, FILE_CHOOSER_REQUEST); }
            catch (Exception error) {
                fileChooserCallback = null;
                callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, R.string.file_picker_failed, Toast.LENGTH_SHORT).show();
                return false;
            }
            return true;
        }
    }

    private final class HarnessWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) && sameServer(uri)) return false;
            if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) openExternal(uri);
            else Toast.makeText(MainActivity.this, R.string.unsupported_link, Toast.LENGTH_SHORT).show();
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            setConnectionState(getString(R.string.connecting), Color.rgb(37, 99, 235));
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush();
            setConnectionState(getString(R.string.connected), Color.rgb(22, 163, 74));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                setConnectionState(getString(R.string.disconnected), Color.rgb(220, 38, 38));
                showServerDialog(true);
            }
        }
    }
}
