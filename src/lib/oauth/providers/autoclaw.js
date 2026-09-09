import crypto from "crypto";
import { AUTOCLOW_CONFIG } from "../constants/oauth.js";

// AutoClaw — Google OAuth via AutoClaw overseas endpoint (device_code-shaped).
const autoclaw = {
  config: AUTOCLOW_CONFIG,
  flowType: "device_code",
  // AutoClaw's Google OAuth flow is a 2-step intermediary: we ask AutoClaw's
  // API for a Google consent URL (with app-signing headers), the user logs in,
  // Google redirects to localhost:18432/auth/callback-google, and we exchange
  // the code via AutoClaw's google-oauth-login endpoint. Modelled as
  // device_code so requestDeviceCode (async) can call the API + start a
  // fixed-port proxy, and pollToken checks the proxy session.
  requestDeviceCode: async (config, _codeChallenge, options = {}) => {
    const { startAutoClawProxy, registerAutoClawSession } =
      await import("../utils/server.js");
    const authMethod = options.authMethod === "zai" ? "zai" : "google";
    const deviceId = crypto.randomUUID();

    // App-signing headers for AutoClaw userapi calls.
    const appId = config.appId;
    const appKey = config.appKey;
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = crypto
      .createHash("md5")
      .update(`${appId}&${ts}&${appKey}`)
      .digest("hex");
    const headers = {
      "X-Auth-Appid": appId,
      "X-Auth-TimeStamp": ts,
      "X-Auth-Sign": sign,
      "X-Product": "autoclaw",
      "X-Version": "1.18.1",
      "X-Tm": "mac",
      "X-Lang": "en",
      Accept: "*/*",
      "X-Trace-Id": crypto.randomUUID(),
      "Content-Type": "application/json",
    };

    // Start dynamic-port proxy first so the callback is listening before the
    // browser redirects. navigate_uri uses the actual bound port.
    const proxyResult = await startAutoClawProxy();
    if (!proxyResult.success) {
      throw new Error(`Failed to start callback proxy: ${proxyResult.reason}`);
    }
    const callbackOrigin = options.callbackOrigin;
    const callbackBase = callbackOrigin
      ? `${callbackOrigin}/api/oauth/autoclaw/callback/`
      : `http://localhost:${proxyResult.port}/auth/callback-`;
    const navigateUri = callbackOrigin
      ? `${callbackBase}${authMethod}`
      : authMethod === "zai"
        ? `${callbackBase}zai`
        : `${callbackBase}google`;

    const authorizeUrl =
      authMethod === "zai" ? config.zaiAuthorizeUrl : config.authorizeUrl;
    const response = await fetch(authorizeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source_id: config.sourceId,
        device_id: deviceId,
        navigate_uri: navigateUri,
        // Server rejects the OAuth URL request (631002) without a valid
        // Aliyun captcha verify param.
        ...(options.captchaParam
          ? { ali_captcha_verify_param: options.captchaParam }
          : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`AutoClaw OAuth URL request failed: ${response.status}`);
    }
    const resp = await response.json();
    if (resp.code != null && resp.code !== 0) {
      throw new Error(
        `AutoClaw OAuth URL error: code=${resp.code} msg=${resp.msg}`,
      );
    }
    const data = resp.data || {};
    if (!data.oauth_url || !data.state) {
      throw new Error("AutoClaw OAuth URL response missing oauth_url/state");
    }

    // Register session keyed by AutoClaw's state (= device_code for poll).
    registerAutoClawSession(data.state, deviceId, authMethod, navigateUri);

    return {
      device_code: data.state,
      user_code: data.state.slice(0, 8).toUpperCase(),
      verification_uri: data.oauth_url,
      verification_uri_complete: data.oauth_url,
      expires_in: 300,
      interval: 2,
    };
  },
  pollToken: async (config, deviceCode) => {
    const {
      getAutoClawSessionStatus,
      clearAutoClawSession,
      stopAutoClawProxy,
    } = await import("../utils/server.js");

    const session = getAutoClawSessionStatus(deviceCode);
    if (!session) {
      return { ok: false, data: { error: "authorization_pending" } };
    }
    if (session.status === "error") {
      clearAutoClawSession(deviceCode);
      stopAutoClawProxy();
      return { ok: false, data: { error: session.error || "access_denied" } };
    }
    if (session.status === "done") {
      // Already exchanged (shouldn't normally hit this path — tokens saved
      // by the route after the first success).
      return { ok: true, data: session.tokens };
    }
    if (session.status !== "exchanging") {
      return { ok: false, data: { error: "authorization_pending" } };
    }

    // Exchange the provider callback code for AutoClaw tokens.
    const appId = config.appId;
    const appKey = config.appKey;
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = crypto
      .createHash("md5")
      .update(`${appId}&${ts}&${appKey}`)
      .digest("hex");
    const headers = {
      "X-Auth-Appid": appId,
      "X-Auth-TimeStamp": ts,
      "X-Auth-Sign": sign,
      "X-Product": "autoclaw",
      "X-Version": "1.18.1",
      "X-Tm": "mac",
      "X-Lang": "en",
      Accept: "*/*",
      "X-Trace-Id": crypto.randomUUID(),
      "Content-Type": "application/json",
    };

    const tokenUrl =
      session.authMethod === "zai" ? config.zaiTokenUrl : config.tokenUrl;
    const exchangeNavigateUri =
      session.navigateUri ||
      (session.authMethod === "zai"
        ? `${config.redirectUri.replace("callback-google", "callback-zai")}`
        : config.redirectUri);
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source_id: config.sourceId,
        device_id: session.deviceId,
        code: session.code,
        state: deviceCode,
        navigate_uri: exchangeNavigateUri,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      session.status = "error";
      session.error = `AutoClaw token exchange failed: ${response.status} ${text}`;
      return { ok: false, data: { error: session.error } };
    }
    const resp = await response.json();
    if (resp.code != null && resp.code !== 0) {
      session.status = "error";
      session.error = `AutoClaw login error: code=${resp.code} msg=${resp.msg}`;
      return { ok: false, data: { error: session.error } };
    }
    const data = resp.data || {};
    let accessToken = data.access_token || "";
    let refreshToken = data.refresh_token || "";
    if (accessToken.startsWith("Bearer ")) accessToken = accessToken.slice(7);
    if (refreshToken.startsWith("Bearer "))
      refreshToken = refreshToken.slice(7);

    // The JWT payload's device_id is authoritative for refresh.
    let jwtDeviceId = session.deviceId;
    try {
      const payload = accessToken.split(".")[1];
      const json = JSON.parse(
        Buffer.from(
          payload + "=".repeat(-payload.length % 4),
          "base64url",
        ).toString("utf8"),
      );
      if (json.device_id) jwtDeviceId = json.device_id;
    } catch {}

    // Decode JWT exp for refresh-lead scheduling.
    let expiresIn = 86400;
    try {
      const payload = accessToken.split(".")[1];
      const json = JSON.parse(
        Buffer.from(
          payload + "=".repeat(-payload.length % 4),
          "base64url",
        ).toString("utf8"),
      );
      if (typeof json.exp === "number") {
        expiresIn = Math.max(1, json.exp - Math.floor(Date.now() / 1000));
      }
    } catch {}

    session.status = "done";
    session.tokens = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      _autoclawDeviceId: jwtDeviceId,
      _autoclawUserId: data.user_id,
      _autoclawUserName: data.user_name,
    };

    stopAutoClawProxy();
    return { ok: true, data: session.tokens };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    email: tokens._autoclawUserName
      ? `${tokens._autoclawUserName}`
      : tokens._autoclawUserId
        ? `autoclaw-${tokens._autoclawUserId}`
        : null,
    displayName: tokens._autoclawUserName || null,
    providerSpecificData: {
      sourceId: AUTOCLOW_CONFIG.sourceId,
      deviceId: tokens._autoclawDeviceId,
    },
  }),
};

export default autoclaw;
