package ai.deepseek.harness.client;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String PREFS = "deepseek_harness";
    private static final String SERVER_KEY = "server_url";

    private WebView webView;
    private boolean errorDialogVisible;

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(16), 0, dp(6), 0);
        toolbar.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText(R.string.toolbar_title);
        title.setTextColor(Color.rgb(24, 24, 27));
        title.setTextSize(17);
        title.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));

        Button serverButton = new Button(this);
        serverButton.setText(R.string.server);
        serverButton.setTextColor(Color.rgb(63, 63, 70));
        serverButton.setTextSize(13);
        serverButton.setAllCaps(false);
        serverButton.setBackgroundColor(Color.TRANSPARENT);
        serverButton.setOnClickListener(view -> showServerDialog(false));
        toolbar.addView(serverButton, new LinearLayout.LayoutParams(dp(72), dp(44)));
        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " DeepSeekHarnessAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new HarnessWebViewClient());
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        if (state != null) {
            webView.restoreState(state);
        } else {
            loadSavedServer();
        }
    }

    private String savedServer() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(SERVER_KEY, "");
    }

    private void loadSavedServer() {
        String saved = savedServer();
        if (saved.isEmpty()) {
            showServerDialog(false);
        } else {
            webView.loadUrl(normalizeServer(saved));
        }
    }

    private String normalizeServer(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        if (!value.toLowerCase(Locale.ROOT).startsWith("http://")
                && !value.toLowerCase(Locale.ROOT).startsWith("https://")) {
            value = "http://" + value;
        }
        return value;
    }

    private void showServerDialog(boolean connectionFailed) {
        if (errorDialogVisible || isFinishing()) return;
        errorDialogVisible = true;
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(savedServer());
        input.setSelectAllOnFocus(true);
        input.setHint(R.string.server_hint);
        int horizontal = dp(20);
        LinearLayout holder = new LinearLayout(this);
        holder.setPadding(horizontal, dp(8), horizontal, 0);
        holder.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(connectionFailed ? "连接失败，请检查电脑地址" : getString(R.string.server_address))
                .setView(holder)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.connect, null)
                .create();
        dialog.setOnDismissListener(ignored -> errorDialogVisible = false);
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String normalized = normalizeServer(input.getText().toString());
            Uri uri = Uri.parse(normalized);
            String token = uri.getQueryParameter("token");
            if (uri.getHost() == null || uri.getPort() <= 0 || token == null || token.length() < 24) {
                input.setError("请粘贴电脑客户端生成的完整连接地址");
                return;
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(SERVER_KEY, normalized).apply();
            dialog.dismiss();
            webView.loadUrl(normalized);
        }));
        dialog.show();
        input.requestFocus();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    private final class HarnessWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) return false;
            Toast.makeText(MainActivity.this, "不支持此链接", Toast.LENGTH_SHORT).show();
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) showServerDialog(true);
        }

    }
}
