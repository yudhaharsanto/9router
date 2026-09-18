import {
  BulkImportManager,
  buildLookupResponse,
  createFreshContext,
  parseBulkAccounts,
  BULK_IMPORT_DEFAULT_CONCURRENCY,
  BULK_IMPORT_MAX_CONCURRENCY,
  BULK_IMPORT_MIN_CONCURRENCY,
} from "./bulkImportManager.js";
import { runGoogleAccountAutomation } from "./googleAutomation.js";
import { CODEBUDDY_INTL_CONFIG } from "../constants/oauth.js";

const PROVIDER_ID = "codebuddy-intl";
const LABEL = "CodeBuddy Intl";
const POLL_TIMEOUT_MS = 3 * 60_000;
const POLL_INTERVAL_MS = 2_000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestStateViaProxy(config, proxyUrl) {
  let dispatcher;
  if (proxyUrl) {
    try {
      const { ProxyAgent } = await import("undici");
      dispatcher = new ProxyAgent(proxyUrl);
    } catch {
      dispatcher = undefined;
    }
  }
  const response = await fetch(
    `${config.stateUrl}?platform=${config.platform}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
      ...(dispatcher ? { dispatcher } : {}),
    },
  );
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  const data = await response.json();
  if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
    throw new Error(data.msg || "missing state/authUrl");
  }
  return { state: data.data.state, authUrl: data.data.authUrl };
}

async function defaultSaveConnection({ tokens, email }) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const connection = await createProviderConnection({
    provider: PROVIDER_ID,
    authType: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    email,
    displayName: email.split("@")[0],
    providerSpecificData: { authMethod: "device", loginEmail: email, automation: "gsuite-bulk" },
    expiresAt: tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : null,
    testStatus: "active",
  });
  return { connection };
}

export class CodeBuddyIntlBulkImportManager extends BulkImportManager {
  constructor({
    saveConnection = defaultSaveConnection,
    storageName = "codebuddy-intl-bulk-import",
  } = {}) {
    super({ storageName });
    this.saveConnection = saveConnection;
  }

  async startJob({ accounts, concurrency, engine, proxyUrl, proxyPoolIds }) {
    return super.startJob({
      accounts,
      concurrency,
      engine: "camoufox",
      proxyUrl,
      proxyPoolIds,
    });
  }

  async pollForToken(state, job) {
    const startTime = Date.now();
    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      if (job.cancelRequested) throw new Error("Job cancelled during token polling");
      try {
        const response = await fetch(
          `${CODEBUDDY_INTL_CONFIG.tokenUrl}?state=${encodeURIComponent(state)}`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              "User-Agent": CODEBUDDY_INTL_CONFIG.userAgent,
              "X-Requested-With": "XMLHttpRequest",
              "X-Domain": "www.codebuddy.ai",
              "X-No-Authorization": "true",
              "X-No-User-Id": "true",
              "X-No-Enterprise-Id": "true",
              "X-No-Department-Info": "true",
              "X-Product": "SaaS",
            },
          },
        );
        const data = await response.json().catch(() => null);
        if (data?.code === 0 && data?.data?.accessToken) {
          return {
            tokenData: {
              accessToken: data.data.accessToken,
              refreshToken: data.data.refreshToken || "",
              expiresIn: data.data.expiresIn,
            },
          };
        }
      } catch (error) {
        if (error.message && !error.message.includes("timeout")) throw error;
      }
      await wait(POLL_INTERVAL_MS);
    }
    throw new Error("CodeBuddy Intl token poll timed out");
  }

  async processAccount(job, account, workerId) {
    if (job.cancelRequested) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    const log = (step, message) => {
      console.log(`[codebuddy-intl-bulk] ${account.email} ${step}: ${message}`);
      this.setAccountStep(account, step, message);
      void this.persistJobSnapshot(job, { forcePreview: true });
    };

    // 1. minta state + authUrl via proxy akun (IP sama dgn browser)
    let state;
    let authUrl;
    try {
      log("requesting_device_state", "Requesting CodeBuddy Intl login state");
      ({ state, authUrl } = await requestStateViaProxy(
        CODEBUDDY_INTL_CONFIG,
        account.resolvedProxyUrl || undefined,
      ));
      log("device_state_received", "Login state received, launching Camoufox");
    } catch (error) {
      this.finalizeAccount(account, "failed", {
        error: error.message,
        step: "request_device_state_failed",
        message: `State request failed: ${error.message}`,
      });
      account.password = undefined;
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    // 2. launch Camoufox dgn proxy akun
    const { launchBulkImportBrowser } = await import("./bulkImportBrowserEngine.js");
    let browser;
    let context;
    let page;
    try {
      log("launching_browser", `Launching Camoufox (proxy: ${account.resolvedProxyUrl ? "yes" : "none"})`);
      browser = await launchBulkImportBrowser({
        engine: "camoufox",
        proxyUrl: account.resolvedProxyUrl || undefined,
      });
      const fresh = await createFreshContext(browser);
      context = fresh.context;
      page = fresh.page;
    } catch (launchError) {
      this.finalizeAccount(account, "failed", {
        error: `Browser launch failed: ${launchError.message}`,
        step: "browser_launch_failed",
        message: `Browser launch failed: ${launchError.message}`,
      });
      account.password = undefined;
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }
    account.runtimeSession = { context, page, browser };

    // 3. poll token paralel + automation Google login
    // LANGKAH LOGIN (tercermin di log akun):
    //  opening_codebuddy_login -> buka authUrl -> klik Google ->
    //  entering_email -> submitting_email -> entering_password ->
    //  submitting_password -> approving_consent ->
    //  authorizing_codebuddy_cli_state (/console/auth/login?platform+state) ->
    //  submitting_codebuddy_region (Singapore via API, fallback klik) ->
    //  codebuddy_token_received -> saving_connection
    const pollPromise = this.pollForToken(state, job);
    pollPromise.catch(() => {});

    try {
      log("opening_codebuddy_login", `Worker ${workerId} opening CodeBuddy Intl login`);
      const automationResult = await runGoogleAccountAutomation({
        page,
        authUrl,
        email: account.email,
        password: account.password,
        successPromise: pollPromise,
        shortTimeoutMs: POLL_TIMEOUT_MS,
        serviceLabel: LABEL,
        openingStep: "opening_codebuddy_login",
        openingMessage: "Opening CodeBuddy Intl device login page",
        successStep: "codebuddy_token_received",
        successMessage: "CodeBuddy Intl token received",
        onStep: (step, message) => log(step, message),
      });

      if (automationResult.status === "success") {
        const tokenData = automationResult.tokenData || automationResult;
        log("saving_connection", "Saving CodeBuddy Intl connection");
        const { connection } = await this.saveConnection({
          tokens: tokenData,
          email: account.email,
        });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy Intl connection saved successfully",
        });
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await browser.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      if (automationResult.status === "needs_manual") {
        account.manualSession = { context, page, browser, opened: false, openedAt: null };
        this.finalizeAccount(account, "needs_manual", {
          error: automationResult.error,
          step: "awaiting_manual",
          message: automationResult.error,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        await this.runManualFollowup(job, account, pollPromise);
        return;
      }

      const terminalStatus = automationResult.status?.startsWith("failed")
        ? automationResult.status
        : "failed";
      this.finalizeAccount(account, terminalStatus, {
        error: automationResult.error || "CodeBuddy Intl automation failed.",
        step: terminalStatus,
        message: automationResult.error || "CodeBuddy Intl automation failed.",
      });
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await browser.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      this.finalizeAccount(account, "failed", {
        error: error.message || "Unexpected failure.",
        step: "failed",
        message: error.message || "Unexpected failure.",
      });
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await browser.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      account.password = undefined;
    }
  }

  async runManualFollowup(job, account, pollPromise) {
    const followupPromise = (async () => {
      try {
        const result = await pollPromise;
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual completion",
          });
          await this.persistJobSnapshot(job, { forcePreview: true });
          return;
        }
        const tokenData = result.tokenData || result;
        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy Intl connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const { connection } = await this.saveConnection({
          tokens: tokenData,
          email: account.email,
        });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "CodeBuddy Intl connection saved successfully",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
      } catch (error) {
        this.finalizeAccount(account, job.cancelRequested ? "cancelled" : "failed", {
          error: error.message || "Manual assist flow failed.",
          step: job.cancelRequested ? "cancelled" : "failed",
          message: error.message || "Manual assist flow failed.",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
      } finally {
        const ms = account.manualSession;
        if (ms?.context) await ms.context.close().catch(() => null);
        if (ms?.headedBrowser) await ms.headedBrowser.close().catch(() => null);
        if (ms?.browser && ms.browser !== ms?.headedBrowser) {
          await ms.browser.close().catch(() => null);
        }
        account.manualSession = null;
        account.runtimeSession = null;
        job.manualFollowups.delete(followupPromise);
        await this.persistJobSnapshot(job, { forcePreview: true });
      }
    })();
    job.manualFollowups.add(followupPromise);
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

export {
  buildLookupResponse,
  parseBulkAccounts,
  BULK_IMPORT_DEFAULT_CONCURRENCY as CODEBUDDY_INTL_BULK_IMPORT_DEFAULT_CONCURRENCY,
  BULK_IMPORT_MAX_CONCURRENCY as CODEBUDDY_INTL_BULK_IMPORT_MAX_CONCURRENCY,
  BULK_IMPORT_MIN_CONCURRENCY as CODEBUDDY_INTL_BULK_IMPORT_MIN_CONCURRENCY,
};
