/**
 * Browser engine launcher for bulk-import automation.
 *
 * Only Camoufox (stealth Firefox) is supported — Google blocks Chromium
 * headless as "not secure". Camoufox handles anti-detection natively.
 */
export const DEFAULT_BULK_IMPORT_ENGINE = "camoufox";

export function normalizeBulkImportEngine(value) {
  if (typeof value !== "string") return DEFAULT_BULK_IMPORT_ENGINE;
  const lower = value.trim().toLowerCase();
  return lower === "camoufox" ? lower : DEFAULT_BULK_IMPORT_ENGINE;
}

async function launchCamoufox({ proxyUrl, headless = true } = {}) {
  let camoufox;
  try {
    camoufox = await import("camoufox-js");
  } catch (firstErr) {
    const err = new Error(
      `Camoufox not installed. Run "npm install camoufox-js && npx camoufox-js fetch" then retry. Cause: ${firstErr.message}`,
    );
    err.code = "CAMOUFOX_PACKAGE_MISSING";
    throw err;
  }

  if (!camoufox?.launchOptions) {
    const err = new Error(
      `camoufox-js loaded but does not expose launchOptions(); reinstall the package.`,
    );
    err.code = "CAMOUFOX_API_MISMATCH";
    throw err;
  }

  let firefox;
  try {
    const pwCore = await import("playwright-core");
    firefox = pwCore.firefox;
  } catch {
    try {
      const pw = await import("playwright");
      firefox = pw.firefox;
    } catch (err) {
      const friendly = new Error(
        `Playwright is required to drive Camoufox. Run "npm install playwright".`,
      );
      friendly.code = "PLAYWRIGHT_PACKAGE_MISSING";
      friendly.cause = err;
      throw friendly;
    }
  }

  const camoufoxOptions = await camoufox.launchOptions({
    headless: headless !== false,
    locale: "en-US",
  });
  const launchOptions = { ...camoufoxOptions };
  // Strip viewport-related keys (Camoufox rejects viewport.isMobile).
  delete launchOptions.viewport;
  delete launchOptions.deviceScaleFactor;
  delete launchOptions.isMobile;
  delete launchOptions.hasTouch;

  // Disable uBlock Origin addon — it blocks SPA scripts on sites like codebuddy.cn
  if (launchOptions.env?.CAMOU_CONFIG_1) {
    try {
      const config = JSON.parse(launchOptions.env.CAMOU_CONFIG_1);
      config.addons = [];
      // Clear any proxy from Camoufox env config to avoid conflicts
      if (config.proxy) delete config.proxy;
      launchOptions.env.CAMOU_CONFIG_1 = JSON.stringify(config);
    } catch {}
  }

  // Also strip any existing proxy from Camoufox launchOptions
  delete launchOptions.proxy;

  if (launchOptions.contextOptions) {
    delete launchOptions.contextOptions.viewport;
    delete launchOptions.contextOptions.deviceScaleFactor;
    delete launchOptions.contextOptions.isMobile;
    delete launchOptions.contextOptions.hasTouch;
  }

  // Proxy tuning. Residential proxies umumnya HTTP/1.1 saja — kalau Firefox
  // pakai HTTP/2/3 lewat CONNECT tunnel, banyak proxy stall karena tak bisa
  // multiplex atau tak support ALPN passthrough. Paksa HTTP/1.1 dan turunkan
  // parallel connection biar proxy tak thrash. Keep-alive panjang supaya
  // TLS handshake ke origin tak diulang tiap request.
  // ponytail: skipped: per-host tuning, tambah kalau proxy spesifik dukung H2.
  launchOptions.firefoxUserPrefs = {
    ...(launchOptions.firefoxUserPrefs || {}),
    // Disable HTTP/2 + HTTP/3 — sebagian besar residential proxy hanya
    // tunnel TCP + tak advertise ALPN dengan benar, bikin request stuck.
    "network.http.http2.enabled": false,
    "network.http.http2.enabled.deps": false,
    "network.http.http3.enable": false,
    "network.http.http3.enabled": false,
    "network.http.spdy.enabled": false,
    "network.http.spdy.enabled.http2": false,
    // Keep-alive lama supaya reuse socket ke origin lewat proxy.
    "network.http.keep-alive.timeout": 600,
    "network.http.keep-alive": true,
    // Turunkan concurrency — proxy residential biasanya throttle di >6
    // koneksi paralel per host.
    "network.http.max-persistent-connections-per-server": 6,
    "network.http.max-persistent-connections-per-proxy": 32,
    "network.http.max-connections": 256,
    "network.http.connection-timeout": 90,
    "network.http.response.timeout": 120,
    "network.http.connection-retry-timeout": 250,
    // Matikan speculative connect — bikin proxy dibanjiri handshake
    // yang tak kepakai + kena rate-limit.
    "network.http.speculative-parallel-limit": 0,
    "network.dns.disablePrefetch": true,
    "network.predictor.enabled": false,
    "network.predictor.enable-prefetch": false,
    "network.prefetch-next": false,
    // DNS lewat proxy (bukan lokal) supaya route konsisten.
    "network.proxy.socks_remote_dns": true,
    // Kurangi telemetri background yang buang bandwidth proxy.
    "toolkit.telemetry.enabled": false,
    "toolkit.telemetry.unified": false,
    "datareporting.healthreport.uploadEnabled": false,
    "app.normandy.enabled": false,
    "browser.discovery.enabled": false,
    "browser.newtabpage.activity-stream.feeds.telemetry": false,
    "browser.safebrowsing.downloads.enabled": false,
    "browser.safebrowsing.malware.enabled": false,
    "browser.safebrowsing.phishing.enabled": false,
    // Matikan captive portal check + Firefox background pings yang
    // buang round-trip lewat proxy.
    "network.captive-portal-service.enabled": false,
    "network.connectivity-service.enabled": false,
  };

  if (proxyUrl) {
    // Parse proxy URL — Playwright/Firefox needs username/password separately
    try {
      const parsed = new URL(proxyUrl);
      const proxyConfig = {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
        // Bypass localhost from proxy — otherwise redirects to
        // http://localhost:18432 (AutoClaw callback) go through remote proxy
        // which can't reach the loopback interface → "Unable to connect".
        bypass: "localhost,127.0.0.1,<-loopback>",
      };
      if (parsed.username)
        proxyConfig.username = decodeURIComponent(parsed.username);
      if (parsed.password)
        proxyConfig.password = decodeURIComponent(parsed.password);
      launchOptions.proxy = proxyConfig;
    } catch {
      launchOptions.proxy = {
        server: proxyUrl,
        bypass: "localhost,127.0.0.1,<-loopback>",
      };
    }
  }

  const browser = await firefox.launch(launchOptions);
  browser.__browserType = "firefox";
  return browser;
}

export async function launchBulkImportBrowser({
  engine = DEFAULT_BULK_IMPORT_ENGINE,
  proxyUrl,
  headless = true,
} = {}) {
  return launchCamoufox({ proxyUrl, headless });
}

export function makeBrowserLauncher({ engine, proxyUrl } = {}) {
  return () => launchBulkImportBrowser({ engine, proxyUrl });
}
