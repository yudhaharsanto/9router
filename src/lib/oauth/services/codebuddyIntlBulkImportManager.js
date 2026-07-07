import {
  BulkImportManager,
  buildLookupResponse,
  parseBulkAccounts,
} from "./bulkImportManager.js";

const CODEBUDDY_PROVIDER_ID = "codebuddy";
const CODEBUDDY_LABEL = "CodeBuddy";
const CODEBUDDY_TIMEOUT_MS = 5 * 60_000;

/**
 * Default connection saver for CodeBuddy. Stores the API key as the
 * access token — the only credential CodeBuddy automation produces.
 */
async function defaultSaveCodeBuddyConnection({
  apiKey,
  email,
  sessionCookies,
}) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const connection = await createProviderConnection({
    provider: CODEBUDDY_PROVIDER_ID,
    authType: "apikey",
    apiKey,
    name: email,
    email,
    providerSpecificData: {
      sourceId: "codebuddy",
      automation: "google-login-bulk",
      sessionCookies: sessionCookies || null,
    },
    expiresAt: null,
    testStatus: "active",
  });
  return { connection };
}

/**
 * CodeBuddy International bulk import manager.
 *
 * Flow per account:
 *   1. Navigate to codebuddy.ai login page, click Google sign-in
 *   2. Google login (email → password → consent)
 *   3. Wait for redirect back to codebuddy.ai
 *   4. Navigate to /profile/keys
 *   5. POST /console/api/client/v1/api-keys to create API key
 *   6. Extract key from response
 *   7. Save connection with API key
 */
export class CodeBuddyIntlBulkImportManager extends BulkImportManager {
  constructor({
    saveConnection = defaultSaveCodeBuddyConnection,
    storageName = "codebuddy-intl-bulk-import",
  } = {}) {
    super({ storageName });
    this.saveConnection = saveConnection;
  }

  /**
   * Capture screenshots from ALL running workers (not just the first one).
   * Returns an array so the UI can render a grid of live previews.
   * Falls back to a single preview when only one worker is active.
   */
  async capturePreview(job) {
    const PREVIEW_TIMEOUT = 2500;
    const runningAccounts = job.accounts.filter(
      (a) => a.runtimeSession?.page && a.status === "running",
    );

    if (runningAccounts.length === 0) {
      // Fall back to manual sessions or any runtime session (base behaviour)
      const fallback =
        job.accounts.find(
          (a) => a.manualSession?.page && a.status === "needs_manual",
        ) ||
        job.accounts.find((a) => a.runtimeSession?.page) ||
        null;
      if (!fallback) return null;
      runningAccounts.push(fallback);
    }

    const previews = [];
    for (const account of runningAccounts) {
      const page = account.runtimeSession?.page || account.manualSession?.page;
      if (!page) continue;

      const meta = {
        email: account.email,
        workerId: account.workerId || null,
        status: account.status,
        step: account.currentStep || null,
        updatedAt: account.updatedAt || new Date().toISOString(),
      };

      const prevPreview = Array.isArray(job.lastPreview)
        ? job.lastPreview.find((p) => p.workerId === account.workerId)
        : null;
      const previousImage = prevPreview?.imageData || null;

      let screenshot = null;
      try {
        screenshot = await Promise.race([
          page.screenshot({
            type: "jpeg",
            quality: 45,
            fullPage: false,
            animations: "disabled",
            caret: "hide",
            timeout: PREVIEW_TIMEOUT,
          }),
          new Promise((r) => setTimeout(() => r(null), PREVIEW_TIMEOUT)),
        ]);
      } catch {
        // screenshot failed — use previous image
      }

      previews.push({
        ...meta,
        imageData: screenshot
          ? `data:image/jpeg;base64,${screenshot.toString("base64")}`
          : previousImage,
      });
    }

    // Return single object when only 1 preview (backward compat), array when multiple
    return previews.length === 1 ? previews[0] : previews;
  }

  async startJob({
    accounts,
    concurrency,
    engine: _ignoredEngine,
    proxyUrl,
    proxyPoolIds,
  }) {
    return super.startJob({
      accounts,
      concurrency: concurrency || 1,
      engine: "camoufox",
      proxyUrl,
      proxyPoolIds,
    });
  }

  async processAccount(job, account, _workerId) {
    console.log(`[codebuddy-bulk] processAccount START for ${account.email}`);
    if (job.cancelRequested) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    // Short-circuit: skip if connection already exists
    try {
      const { getProviderConnections } =
        await import("../../../models/index.js");
      const existing = await getProviderConnections({
        provider: CODEBUDDY_PROVIDER_ID,
        isActive: true,
      });
      const target = String(account.email || "").toLowerCase();
      const match = existing.find(
        (c) => String(c.email || c.name || "").toLowerCase() === target,
      );
      if (match) {
        this.setAccountStep(
          account,
          "connection_exists",
          "Connection already exists — skipping login",
        );
        this.finalizeAccount(account, "success", {
          connectionId: match.id,
          step: "connection_exists",
          message: "Already exists — skipped bulk login",
        });
        account.password = undefined;
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }
    } catch (error) {
      console.warn(
        `[codebuddy-bulk] duplicate-check failed for ${account.email}: ${error.message}`,
      );
    }

    // Retry loop: proxy residential kadang refuse (403/connection refused)
    // atau timeout awal. Retry sampai MAX_RETRIES dengan backoff sebelum
    // menyerah. ponytail: skipped: retry per-step, tambah kalau butuh resume
    // di tengah flow.
    const MAX_RETRIES = 3;
    let result = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (job.cancelRequested) break;
      result = await this._runCodeBuddyLoginAttempt(job, account, {
        attempt,
        maxAttempts: MAX_RETRIES,
      });
      if (result?.status !== "retryable") break;
      if (attempt < MAX_RETRIES) {
        const delayMs = 2000 * attempt; // 2s, 4s
        this.setAccountStep(
          account,
          "retrying",
          `Proxy error, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await this.persistJobSnapshot(job, { forcePreview: true });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Retries exhausted for a retryable error → finalize as failed here.
    if (result?.status === "retryable") {
      this.finalizeAccount(account, "failed", {
        error: result.error || "Proxy error after retries",
        step: "failed",
        message: result.error || "Proxy error after retries",
      });
    }

    account.password = undefined;
    await this.persistJobSnapshot(job, { forcePreview: true });
    return result;
  }

  /**
   * Classify an error as retryable (proxy-related transient failure) or not.
   * Retryable errors trigger a fresh browser + backoff.
   */
  _isRetryableProxyError(error) {
    if (!error) return false;
    const msg = String(error.message || error).toLowerCase();
    return (
      msg.includes("proxy server is refusing") ||
      msg.includes("proxy_connection_refused") ||
      msg.includes("ns_error_proxy") ||
      msg.includes("ns_error_connection_refused") ||
      msg.includes("ns_error_net_timeout") ||
      msg.includes("ns_error_unknown_proxy_host") ||
      msg.includes("403 forbidden") ||
      msg.includes("tunnel connection failed") ||
      msg.includes("proxy authentication required") ||
      msg.includes("net::err_tunnel_connection_failed") ||
      msg.includes("net::err_proxy_connection_failed") ||
      msg.includes("err_proxy") ||
      msg.includes("socket hang up") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset")
    );
  }

  async _runCodeBuddyLoginAttempt(job, account, retryCtx = {}) {
    const { attempt = 1, maxAttempts = 1 } = retryCtx;
    console.log(
      `[codebuddy-bulk] _runCodeBuddyLoginAttempt START for ${account.email} (attempt ${attempt}/${maxAttempts})`,
    );
    const { createFreshContext } = await import("./bulkImportManager.js");
    const { runGoogleAccountAutomation } =
      await import("./kiroGoogleAutomation.js");

    // Helper: check cancel and throw to short-circuit the flow.
    // The catch block below detects cancelRequested and finalises accordingly.
    const _checkCancel = () => {
      if (job.cancelRequested) throw new Error("__CANCEL__");
    };

    this.setAccountStep(
      account,
      "launching_browser",
      "Launching camoufox for CodeBuddy",
    );
    await this.persistJobSnapshot(job, { forcePreview: true });
    _checkCancel();

    const { launchBulkImportBrowser } =
      await import("./bulkImportBrowserEngine.js");
    console.log(`[codebuddy-bulk] launching browser for ${account.email}...`);
    const browser = await launchBulkImportBrowser({
      engine: "camoufox",
      headless: true,
      proxyUrl: account.resolvedProxyUrl || null,
    });
    _checkCancel();

    let outcome = { status: "failed" };
    try {
      const { context, page } = await createFreshContext(browser);
      account.runtimeSession = { context, page, browser };

      // Step 1: Navigate to CodeBuddy login page and click Google sign-in
      this.setAccountStep(
        account,
        "opening_login",
        "Opening CodeBuddy login page",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      // The /login?redirect_uri=... page is a React SPA that does NOT render
      // #social-google directly. That button lives on the Keycloak auth page
      // (/auth/realms/copilot/protocol/openid-connect/auth). The SPA normally
      // navigates there via a JS helper; we short-circuit and hit Keycloak
      // straight away. ponytail: skipped: SPA-driven flow, add when Keycloak
      // path changes.
      const keycloakUrl =
        "https://www.codebuddy.ai/auth/realms/copilot/protocol/openid-connect/auth" +
        "?client_id=console&response_type=code" +
        "&redirect_uri=" +
        encodeURIComponent("https://www.codebuddy.ai/home");
      await page.goto(keycloakUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      _checkCancel();

      // Deteksi Camoufox/Firefox neterror page (proxy refused / DNS fail /
      // connection reset). Halaman ini bertitle di dokumen dan URL diawali
      // "about:neterror". Kalau ketemu → throw supaya masuk jalur retry.
      const currentUrl0 = page.url();
      if (
        currentUrl0.startsWith("about:neterror") ||
        currentUrl0.includes("neterror")
      ) {
        const bodyText = await page
          .evaluate(() => document.body?.textContent?.slice(0, 500) || "")
          .catch(() => "");
        throw new Error(
          `Proxy/network error: ${bodyText.replace(/\s+/g, " ").slice(0, 200)}`,
        );
      }
      // Fallback: dokumen HTML mungkin tampilkan "proxy server is refusing"
      // meski URL sudah rewrite. Cek body text.
      const bodyProbe = await page
        .evaluate(() => document.body?.textContent?.slice(0, 500) || "")
        .catch(() => "");
      if (
        /proxy server is refusing|the proxy server is|unable to connect|403 forbidden/i.test(
          bodyProbe,
        )
      ) {
        throw new Error(
          `Proxy server is refusing connections (attempt ${attempt}/${maxAttempts})`,
        );
      }

      this.setAccountStep(
        account,
        "waiting_login_form",
        "Waiting for login form to render",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });

      const googleSelectors = [
        "#social-google",
        "#kc-social-google",
        "#kc-social-providers a[href*='google']",
        "#social-providers a[href*='google']",
        "a[href*='broker/google']",
      ];

      const findGoogleHrefInFrame = async (frameOrPage) => {
        for (const sel of googleSelectors) {
          try {
            const el = await frameOrPage.$(sel);
            if (el) {
              const href = await el.evaluate((node) => node.href);
              // Keycloak broker link is same-origin; it 302s to Google after
              // click. Accept any href that looks like the Google broker.
              if (href && /broker\/google\/login/.test(href)) return href;
            }
          } catch {
            // try next
          }
        }
        return null;
      };

      let googleHref = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        _checkCancel();

        googleHref = await findGoogleHrefInFrame(page);
        if (googleHref) break;

        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          googleHref = await findGoogleHrefInFrame(frame);
          if (googleHref) break;
        }
        if (googleHref) break;

        if (attempt === 3 || attempt === 10) {
          const frames = page.frames();
          const frameUrls = frames.map((f) => f.url().slice(0, 100));
          console.log(
            `[codebuddy-bulk] ${account.email} [${attempt}] url=${page.url().slice(0, 80)} frames=${frames.length} urls=${JSON.stringify(frameUrls)}`,
          );
        }

        await page.waitForTimeout(1500);
      }

      if (!googleHref) {
        const currentUrl = page.url();
        throw new Error(
          `Google sign-in button not found. Current URL: ${currentUrl.slice(0, 120)}`,
        );
      }

      // Follow the Keycloak broker link. Keycloak will 302 to Google's OAuth
      // page.
      await page.goto(googleHref, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      _checkCancel();

      // Wait until we actually land on accounts.google.com (Keycloak may show
      // an interstitial before redirecting).
      for (let i = 0; i < 20; i++) {
        _checkCancel();
        if (page.url().includes("accounts.google.com")) break;
        await page.waitForTimeout(500);
      }

      // Verify we're on Google login page
      if (!page.url().includes("accounts.google.com")) {
        throw new Error("Did not reach Google OAuth page");
      }

      // Step 2: Run Google account automation
      this.setAccountStep(
        account,
        "google_login",
        "Running Google login automation",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      // Detect success when redirected back to codebuddy.ai.
      // The interval also watches for cancel — if the job is cancelled
      // we close the browser so runGoogleAccountAutomation exits promptly.
      let resolveSuccess;
      const successPromise = new Promise((resolve) => {
        resolveSuccess = resolve;
      });
      successPromise.catch(() => {});

      let cbHits = 0;
      const urlPollInterval = setInterval(() => {
        try {
          if (job.cancelRequested) {
            void browser.close().catch(() => null);
            clearInterval(urlPollInterval);
            return;
          }
          const url = page.url();
          if (
            url.includes("www.codebuddy.ai") &&
            !url.includes("accounts.google.com")
          ) {
            cbHits++;
            if (cbHits >= 2) {
              resolveSuccess({ redirected: true });
              clearInterval(urlPollInterval);
            }
          } else {
            cbHits = 0;
          }
        } catch {}
      }, 300);

      await runGoogleAccountAutomation({
        page,
        authUrl: page.url(),
        email: account.email,
        password: account.password,
        successPromise,
        shortTimeoutMs: CODEBUDDY_TIMEOUT_MS,
        serviceLabel: CODEBUDDY_LABEL,
        openingStep: "google_login",
        openingMessage: "Running Google login automation",
        successStep: "codebuddy_home",
        successMessage: "CodeBuddy home reached",
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: true });
        },
      });

      clearInterval(urlPollInterval);
      _checkCancel();

      // Verify we're back on codebuddy.ai
      const currentUrl = page.url();
      if (!currentUrl.includes("www.codebuddy.ai")) {
        const shortUrl =
          currentUrl.length > 80 ? currentUrl.slice(0, 80) + "..." : currentUrl;
        const isGoogleStuck = currentUrl.includes("accounts.google.com");
        throw new Error(
          isGoogleStuck
            ? `Google OAuth stuck (likely proxy/anti-bot). URL: ${shortUrl}`
            : `Did not redirect to CodeBuddy. URL: ${shortUrl}`,
        );
      }

      // Wait for session to fully initialize
      await page.waitForTimeout(3000);
      _checkCancel();

      // Step 3: Navigate to profile/keys page
      this.setAccountStep(account, "opening_keys", "Opening API keys page");
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      await page.goto("https://www.codebuddy.ai/profile/keys", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      _checkCancel();
      await page.waitForTimeout(2000);
      _checkCancel();

      // Capture session cookies
      const cookies = await context.cookies();
      const cbCookies = cookies
        .filter((c) => c.domain?.includes("codebuddy"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      // Step 4: Create API key via POST.
      // Key name must be unique — CodeBuddy rejects duplicate names.
      // Use a per-account suffix derived from email to avoid collisions.
      // The page.evaluate runs in browser context; if the SPA navigates
      // mid-request (e.g. on error), the context is destroyed. Retry once
      // by re-navigating to /profile/keys.
      this.setAccountStep(account, "creating_key", "Creating API key");
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      const rand = () => Math.random().toString(36).slice(2, 10);
      const baseKeyName = `9r-${rand()}`;

      let createResult = null;
      let currentKeyName = baseKeyName;
      for (let keyAttempt = 0; keyAttempt < 4; keyAttempt++) {
        _checkCancel();
        try {
          createResult = await page.evaluate(async (name) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            try {
              // APISIX gateway requires Origin + Referer for auth.
              // Pull cookies from document.cookie so session is attached.
              const resp = await fetch(
                "https://www.codebuddy.ai/console/api/client/v1/api-keys",
                {
                  method: "POST",
                  headers: {
                    Accept: "application/json, text/plain, */*",
                    "Content-Type": "application/json",
                    Origin: "https://www.codebuddy.ai",
                    Referer: "https://www.codebuddy.ai/profile/keys",
                  },
                  credentials: "include",
                  signal: controller.signal,
                  body: JSON.stringify({
                    name,
                    expire_in_days: 365,
                    user_enterprise_id: "personal-edition-user-id",
                  }),
                },
              );
              const text = await resp.text();
              return { status: resp.status, text };
            } finally {
              clearTimeout(timer);
            }
          }, currentKeyName);
          _checkCancel();

          // 12502 = name collision. Check raw text (JSON parse may fail
          // if SPA injects HTML instead of JSON into the response).
          if (createResult.status === 400 || createResult.status === 409) {
            const raw = createResult.text || "";
            if (/12502|name\s*exists/i.test(raw)) {
              console.warn(
                `[codebuddy-bulk] ${account.email} key "${currentKeyName}" exists, retry random...`,
              );
              currentKeyName = `9r-${rand()}`;
              await page
                .goto("https://www.codebuddy.ai/profile/keys", {
                  waitUntil: "domcontentloaded",
                  timeout: 30_000,
                })
                .catch(() => {});
              await page.waitForTimeout(2000);
              continue;
            }
          }
          // 401 = APISIX gateway auth failure. Session may have expired
          // or headers missing. Re-navigate to refresh cookies, then retry.
          if (createResult.status === 401) {
            console.warn(
              `[codebuddy-bulk] ${account.email} 401 from APISIX, re-navigating to refresh session...`,
            );
            await page
              .goto("https://www.codebuddy.ai/profile/keys", {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
              })
              .catch(() => {});
            await page.waitForTimeout(2000);
            continue;
          }
          break;
        } catch (evalError) {
          const msg = String(evalError.message || "");
          if (
            keyAttempt < 2 &&
            /execution context was destroyed|navigation|networkerror/i.test(msg)
          ) {
            console.warn(
              `[codebuddy-bulk] ${account.email} evaluate crashed (${msg.slice(0, 80)}), re-navigating...`,
            );
            await page
              .goto("https://www.codebuddy.ai/profile/keys", {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
              })
              .catch(() => {});
            await page.waitForTimeout(2000);
            continue;
          }
          throw evalError;
        }
      }

      if (!createResult) {
        throw new Error("Failed to create API key — evaluate context lost");
      }

      if (createResult.status !== 200 && createResult.status !== 201) {
        throw new Error(
          `Create key failed: ${createResult.status} ${createResult.text}`,
        );
      }

      let apiKey = null;
      try {
        const keyData = JSON.parse(createResult.text);
        apiKey =
          keyData?.data?.key ||
          keyData?.data?.api_key ||
          keyData?.key ||
          keyData?.api_key ||
          null;
      } catch {
        const match = createResult.text.match(/sk-[a-zA-Z0-9]+/);
        apiKey = match ? match[0] : null;
      }

      if (!apiKey) {
        throw new Error(
          `Could not extract API key from response: ${createResult.text.slice(0, 200)}`,
        );
      }

      console.log(
        `[codebuddy-bulk] ${account.email} key created: ${apiKey.slice(0, 12)}...`,
      );

      // Step 5: Save connection
      this.setAccountStep(account, "saving_connection", "Saving connection");
      await this.persistJobSnapshot(job, { forcePreview: true });

      const { connection } = await this.saveConnection({
        apiKey,
        email: account.email,
        sessionCookies: cbCookies,
      });

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: "CodeBuddy API key saved successfully",
      });
      outcome = { status: "success" };
    } catch (error) {
      console.error(
        `[codebuddy-bulk] ERROR for ${account.email}:`,
        error.message,
        error.stack,
      );
      const isCancel = job.cancelRequested || error.message === "__CANCEL__";
      const isRetryable =
        !isCancel &&
        attempt < maxAttempts &&
        this._isRetryableProxyError(error);

      if (isRetryable) {
        // Jangan finalize — biarkan processAccount coba lagi dengan browser
        // fresh. Update step untuk visibility.
        this.setAccountStep(
          account,
          "proxy_error",
          `Proxy error: ${error.message?.slice(0, 100) || "refused"} (attempt ${attempt}/${maxAttempts})`,
        );
        outcome = { status: "retryable", error: error.message };
      } else {
        this.finalizeAccount(account, isCancel ? "cancelled" : "failed", {
          error: isCancel
            ? "Job cancelled"
            : error.message === "__CANCEL__"
              ? undefined
              : error.message || "CodeBuddy automation failed.",
          step: isCancel ? "cancelled" : "failed",
          message: isCancel
            ? "Job cancelled while processing this account"
            : error.message === "__CANCEL__"
              ? undefined
              : error.message || "CodeBuddy automation failed.",
        });
        outcome = { status: isCancel ? "cancelled" : "failed" };
      }
    } finally {
      account.runtimeSession = null;
      await browser.close().catch(() => null);
    }
    return outcome;
  }
}

function getSingletonStore() {
  if (!globalThis.__codebuddyIntlBulkImportSingleton) {
    globalThis.__codebuddyIntlBulkImportSingleton = {
      manager: new CodeBuddyIntlBulkImportManager(),
    };
  }
  return globalThis.__codebuddyIntlBulkImportSingleton;
}

export function getCodeBuddyIntlBulkImportManager() {
  return getSingletonStore().manager;
}

export { parseBulkAccounts, buildLookupResponse };
