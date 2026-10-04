"use client";

// Customer portal — session-gated via crx_session (Google OAuth, phase 2).
// Guest view: sign-in with Google. Active view: balance, API key (plaintext
// shown exactly once via the one-time reveal flow), usage history, ledger.
// The old password-based lookup (POST /api/public/key-usage) is retired.
import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Button,
  Input,
  SegmentedControl,
  CapacityBadges,
} from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

function fmt(n) {
  return (Number(n) || 0).toLocaleString();
}

const fmtCompact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
};

// Money is stored as integer micro-USD (µ$).
function fmtMoney(micros) {
  const v = (Number(micros) || 0) / 1_000_000;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

const USAGE_PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

const LEDGER_TYPE_LABEL = {
  topup_credit: "Top-up",
  usage_settle: "Usage",
  reserve_hold: "Reserve",
  admin_adjust: "Adjustment",
};

// Reverse index: provider alias/uiAlias → provider id (untuk ikon /providers/{id}.png).
const ALIAS_TO_ID = (() => {
  const map = {};
  for (const [id, p] of Object.entries(AI_PROVIDERS || {})) {
    map[id] = id;
    if (p.alias) map[p.alias] = id;
    if (p.uiAlias) map[p.uiAlias] = id;
  }
  return map;
})();

function providerIdFromModel(modelStr) {
  if (!modelStr) return "";
  const i = String(modelStr).indexOf("/");
  if (i < 0) return "";
  const prefix = String(modelStr).slice(0, i);
  return ALIAS_TO_ID[prefix] || prefix;
}

export default function UsageCheckPage() {
  // status: loading | guest | active | disabled
  const [status, setStatus] = useState("loading");
  const [me, setMe] = useState(null);
  const [banner, setBanner] = useState(null); // { kind: "info"|"error"|"success", text }
  const [revealedKey, setRevealedKey] = useState(null);
  // SSR-safe lazy init — origin is constant for the page's lifetime.
  const [origin] = useState(
    () => (typeof window !== "undefined" ? window.location.origin : ""),
  );

  useEffect(() => {
    (async () => {
      const origin = typeof window !== "undefined" ? window.location.origin : "";

      const params = new URLSearchParams(window.location.search);
      const error = params.get("error");
      const welcome = params.get("welcome");
      const reveal = params.get("reveal");
      // Strip OAuth params from the URL before doing anything else.
      if (error || welcome || reveal) {
        window.history.replaceState({}, "", "/usage-check");
      }
      if (error === "google_not_configured") {
        setBanner({ kind: "error", text: "Google sign-in is not configured yet. Ask the administrator." });
      }

      let url = "/api/customer/me";
      if (reveal) url += `?reveal=${encodeURIComponent(reveal)}`;
      try {
        const r = await fetch(url, { headers: { "Cache-Control": "no-store" } });
        if (r.status === 401) {
          setStatus("guest");
          if (welcome) {
            setBanner({ kind: "error", text: "Sign-in session expired before the key could be shown. Sign in again and regenerate the key." });
          }
          return;
        }
        if (r.status === 403) {
          setStatus("disabled");
          return;
        }
        if (!r.ok) {
          setStatus("guest");
          return;
        }
        const body = await r.json();
        setStatus("active");
        setMe(body);
        if (body.revealedKey) setRevealedKey(body.revealedKey);
        if (welcome && body.revealedKey) {
          setBanner({ kind: "success", text: "Account created! Copy your API key now — it is shown only once." });
        }
      } catch {
        setStatus("guest");
      }
    })();
  }, []);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-start justify-center bg-bg p-4 relative overflow-hidden">
        <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
        <div className="relative z-10 w-full max-w-md mx-auto mt-8 sm:mt-12">
          <Card className="flex items-center justify-center py-10">
            <span className="material-symbols-outlined animate-spin text-text-muted text-2xl">
              progress_activity
            </span>
          </Card>
        </div>
      </div>
    );
  }

  const inPortal = status === "active" || status === "disabled";

  return (
    <div className="min-h-screen flex items-start justify-center bg-bg p-4 relative overflow-hidden">
      <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div
        className={`relative z-10 w-full mt-8 sm:mt-12 ${inPortal ? "max-w-6xl" : "max-w-md mx-auto"}`}
      >
        {banner && (
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              banner.kind === "error"
                ? "border-red-500/40 bg-red-500/10 text-red-500"
                : banner.kind === "success"
                  ? "border-green-500/40 bg-green-500/10 text-success"
                  : "border-border bg-surface-2 text-text-main"
            }`}
            role="alert"
          >
            {banner.text}
          </div>
        )}

        {status === "guest" && <GuestView />}
        {status === "disabled" && (
          <Card className="text-center py-8">
            <h1 className="text-xl font-bold text-primary mb-1">Account disabled</h1>
            <p className="text-sm text-text-muted">
              This account has been disabled by the administrator.
            </p>
            <Button variant="ghost" size="sm" className="mt-4" onClick={logout}>
              Sign out
            </Button>
          </Card>
        )}
        {status === "active" && me && (
          <PortalView
            me={me}
            revealedKey={revealedKey}
            onRegenerated={(key) => setRevealedKey(key)}
            onLogout={() => {
              setMe(null);
              setRevealedKey(null);
              setStatus("guest");
            }}
            origin={origin}
          />
        )}
      </div>
    </div>
  );
}

function logout() {
  fetch("/api/customer/auth/logout", { method: "POST" })
    .catch(() => {})
    .finally(() => {
      window.location.href = "/usage-check";
    });
}

function GuestView() {
  return (
    <>
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-500/10 text-brand-500 mb-3">
          <span className="material-symbols-outlined text-3xl">token</span>
        </div>
        <h1 className="text-3xl font-bold text-primary mb-2">API Portal</h1>
        <p className="text-text-muted">
          Sign in with Google to view your balance, API key and usage.
        </p>
      </div>
      <Card>
        <a href="/api/customer/auth/google/start" className="block">
          <Button variant="primary" className="w-full" icon="login">
            Sign in with Google
          </Button>
        </a>
      </Card>
    </>
  );
}

function PortalView({ me, revealedKey, onRegenerated, onLogout, origin }) {
  const [plaintext, setPlaintext] = useState(revealedKey || null);

  const onRegenerate = useCallback(async () => {
    if (
      !window.confirm(
        "Regenerate the API key? The current key stops working immediately.",
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/customer/keys/regenerate", { method: "POST" });
      const body = await res.json();
      if (res.ok && body.key) {
        setPlaintext(body.key);
        onRegenerated(body.key);
      }
    } catch {}
  }, [onRegenerated]);

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 w-11 h-11 rounded-xl bg-brand-500/10 text-brand-500 flex items-center justify-center">
            <span className="material-symbols-outlined text-2xl">account_circle</span>
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-primary truncate">
              {me.customer?.name || me.customer?.email || "Account"}
            </h1>
            <p className="text-xs text-text-muted truncate">{me.customer?.email}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" icon="logout" onClick={logout}>
          Sign out
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className="flex flex-col gap-4">
          <BalanceCard balanceMicros={me.balance?.balanceMicros} />
          <ApiKeyCard
            mask={me.key?.mask}
            plaintext={plaintext}
            onRegenerate={onRegenerate}
            origin={origin}
          />
        </div>
        <div className="flex flex-col gap-4">
          <UsageCard mask={me.key?.mask} />
          <LedgerCard />
        </div>
      </div>

      <SmartCombosSection />
      {plaintext && <ModelsList apiKey={plaintext} origin={origin} />}
    </div>
  );
}

function BalanceCard({ balanceMicros }) {
  const micros = Number(balanceMicros) || 0;
  const low = micros < 100_000; // < $0.10
  return (
    <Card className="flex flex-col gap-1.5 px-4 py-4">
      <span className="text-text-muted text-[10px] uppercase font-semibold tracking-wider">
        Balance
      </span>
      <span className={`text-3xl font-bold tabular-nums ${low ? "text-red-500" : "text-primary"}`}>
        {fmtMoney(micros)}
      </span>
      <span className="text-[11px] text-text-muted">
        {fmt(micros)} µ$ · deducted per request once pricing is enabled
      </span>
    </Card>
  );
}

function ApiKeyCard({ mask, plaintext, onRegenerate, origin }) {
  const [show, setShow] = useState(false);
  const v1Url = origin ? `${origin}/v1` : "/v1";
  const docModel = "cc/";

  return (
    <Card className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center justify-between">
        <span className="text-text-muted text-[10px] uppercase font-semibold tracking-wider">
          API key
        </span>
        <Button variant="ghost" size="sm" icon="autorenew" onClick={onRegenerate}>
          Regenerate
        </Button>
      </div>

      {plaintext ? (
        <div className="flex items-center gap-2 bg-surface-2 rounded-[10px] px-3 py-2">
          <code className="text-xs flex-1 truncate font-mono">{plaintext}</code>
          <CopyBtn value={plaintext} title="Copy API key" />
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-surface-2 rounded-[10px] px-3 py-2">
          <code className="text-xs flex-1 truncate font-mono">{mask || "—"}</code>
          <CopyBtn value={mask || ""} title="Copy mask (not usable as a key)" />
        </div>
      )}
      {plaintext ? (
        <p className="text-[11px] text-warning flex items-start gap-1">
          <span className="material-symbols-outlined text-[14px] mt-px">warning</span>
          Shown only this once — store it now. Regenerating revokes the current key immediately.
        </p>
      ) : (
        <p className="text-[11px] text-text-muted">
          The full key is shown only when created. Use “Regenerate” to issue a new one
          (the current key stops working immediately).
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 bg-surface-2 rounded-[10px] px-3 py-2">
          <span className="text-[11px] text-text-muted w-16 shrink-0">Base URL</span>
          <code className="text-xs flex-1 truncate">{v1Url}</code>
          <CopyBtn value={v1Url} title="Copy URL" />
        </div>
        <CodeBlock
          label="Chat completion"
          code={`curl ${v1Url}/chat/completions \\
  -H "Authorization: Bearer ${plaintext || "YOUR_API_KEY"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${docModel}",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`}
        />
      </div>
    </Card>
  );
}

function UsageCard() {
  const [period, setPeriod] = useState("7d");
  const [items, setItems] = useState(null);

  const load = useCallback((p) => {
    fetch(`/api/customer/usage?period=${encodeURIComponent(p)}`, {
      headers: { "Cache-Control": "no-store" },
    })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  const totalCost = (items || []).reduce((s, r) => s + (Number(r.cost) || 0), 0);

  return (
    <Card className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-text-muted text-[10px] uppercase font-semibold tracking-wider">
          Usage
        </span>
        <SegmentedControl
          options={USAGE_PERIODS}
          value={period}
          onChange={setPeriod}
          size="sm"
        />
      </div>

      {items === null ? (
        <div className="h-20 rounded-lg bg-surface-2 animate-pulse" />
      ) : items.length === 0 ? (
        <div className="h-20 rounded-lg border border-dashed border-border-subtle flex items-center justify-center text-[11px] text-text-muted">
          No usage in this period.
        </div>
      ) : (
        <>
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle/60">
            {items.map((r, i) => (
              <UsageRow key={i} r={r} />
            ))}
          </div>
          <p className="text-[11px] text-text-muted">
            {items.length} request(s) · est. cost {fmtMoney(totalCost)}
          </p>
        </>
      )}
    </Card>
  );
}

function UsageRow({ r }) {
  const providerId = providerIdFromModel(r.model) || ALIAS_TO_ID[r.provider] || r.provider;
  const time = r.timestamp ? new Date(r.timestamp).toLocaleString() : "";
  return (
    <div className="px-3 py-2.5 hover:bg-surface-2/50 transition-colors">
      <div className="flex items-center gap-3">
        <ProviderIcon
          src={providerId ? `/providers/${providerId}.png` : undefined}
          alt={r.model || ""}
          size={22}
          className="rounded-md shrink-0 bg-surface-2"
          fallbackText={(r.model || "?").slice(0, 2).toUpperCase()}
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{r.model}</div>
          <div className="text-[11px] text-text-muted truncate">{time}</div>
        </div>
        <div className="flex items-center gap-3 text-[11px] shrink-0">
          <div className="text-right">
            <div className="text-text-muted">In / Out</div>
            <div className="text-text-main tabular-nums">
              {fmtCompact(r.promptTokens)} / {fmtCompact(r.completionTokens)}
            </div>
          </div>
          <div className={`text-right w-12 ${r.status && r.status !== "ok" ? "text-red-500" : ""}`}>
            <div className="text-text-muted">Status</div>
            <div className="text-text-main">{r.status || "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LedgerCard() {
  const [items, setItems] = useState(null);

  useEffect(() => {
    fetch("/api/customer/ledger?limit=50", { headers: { "Cache-Control": "no-store" } })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);

  return (
    <Card className="flex flex-col gap-3 px-4 py-4">
      <span className="text-text-muted text-[10px] uppercase font-semibold tracking-wider">
        Ledger
      </span>
      {items === null ? (
        <div className="h-20 rounded-lg bg-surface-2 animate-pulse" />
      ) : items.length === 0 ? (
        <div className="h-20 rounded-lg border border-dashed border-border-subtle flex items-center justify-center text-[11px] text-text-muted">
          No transactions yet.
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle/60">
          {items.map((e, i) => {
            const amt = Number(e.amountMicros) || 0;
            const pos = amt > 0;
            return (
              <div key={e.id || i} className="px-3 py-2 flex items-center gap-3">
                <span
                  className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${
                    pos ? "bg-green-500/10 text-success" : "bg-surface-2 text-text-muted"
                  }`}
                >
                  <span className="material-symbols-outlined text-[15px]">
                    {pos ? "add_circle" : "remove_circle"}
                  </span>
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium">
                    {LEDGER_TYPE_LABEL[e.type] || e.type}
                  </div>
                  <div className="text-[11px] text-text-muted truncate">
                    {e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-xs font-semibold tabular-nums ${pos ? "text-success" : "text-text-main"}`}>
                    {pos ? "+" : ""}
                    {fmtMoney(amt)}
                  </div>
                  {e.balanceAfterMicros != null && (
                    <div className="text-[10px] text-text-muted tabular-nums">
                      bal {fmtMoney(e.balanceAfterMicros)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}

function CopyBtn({ value, title = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <button
      onClick={copy}
      className="p-1 rounded text-text-muted hover:text-primary"
      title={title}
      type="button"
    >
      <span className="material-symbols-outlined text-[15px]">
        {copied ? "check" : "content_copy"}
      </span>
    </button>
  );
}

function CodeBlock({ code, label }) {
  return (
    <div className="relative">
      {label && <p className="text-[11px] text-text-muted mb-1">{label}</p>}
      <div className="relative bg-bg border border-border-subtle rounded-lg">
        <pre className="text-[11px] leading-relaxed p-3 pr-9 overflow-x-auto">
          <code>{code}</code>
        </pre>
        <div className="absolute top-1.5 right-1.5">
          <CopyBtn value={code} title="Copy" />
        </div>
      </div>
    </div>
  );
}

function SmartCombosSection() {
  const [combos, setCombos] = useState([]);
  const [aliases, setAliases] = useState({});
  const [expanded, setExpanded] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/public/combos")
      .then((r) => r.json())
      .then((d) => {
        setCombos(d.combos || []);
        setAliases(d.aliases || {});
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;
  if (!combos.length) return null;

  const bareId = (s) => {
    const str = String(s);
    const i = str.indexOf("/");
    return i >= 0 ? str.slice(i + 1) : str;
  };

  const aliasesByTarget = (() => {
    const map = {};
    for (const [aliasName, target] of Object.entries(aliases || {})) {
      const t = String(target);
      (map[t] ||= []).push(aliasName);
      const b = bareId(t);
      if (b !== t) (map[`bare:${b}`] ||= []).push(aliasName);
    }
    return map;
  })();

  const aliasesFor = (m) => {
    const set = new Set([
      ...(aliasesByTarget[m] || []),
      ...(aliasesByTarget[`bare:${bareId(m)}`] || []),
    ]);
    return [...set];
  };

  return (
    <Card className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        className="flex items-center justify-between w-full"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-brand-500/10 text-brand-500 flex items-center justify-center">
            <span className="material-symbols-outlined text-xl">hub</span>
          </div>
          <div className="text-left">
            <h3 className="text-sm font-semibold text-primary">Smart Combos</h3>
            <p className="text-[11px] text-text-muted">
              {combos.length} routing alias{combos.length !== 1 ? "es" : ""} —
              single name routes to multiple upstream models
            </p>
          </div>
        </div>
        <span className="material-symbols-outlined text-text-muted">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle text-text-muted">
                <th className="text-left py-2 px-2 font-medium">Combo Name</th>
                <th className="text-center py-2 px-2 font-medium">Members</th>
                <th className="text-left py-2 px-2 font-medium">
                  Routes To (in order)
                </th>
                <th className="text-center py-2 px-2 font-medium">Copy</th>
              </tr>
            </thead>
            <tbody>
              {combos.map((combo, idx) => {
                const models = combo.models || [];
                return (
                  <tr
                    key={combo.id || idx}
                    className="border-b border-border-subtle/50 hover:bg-surface-2/50 transition-colors"
                  >
                    <td className="py-2.5 px-2">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-brand-500 text-[18px]">
                          hub
                        </span>
                        <code className="font-mono text-xs font-medium">
                          {combo.name}
                        </code>
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-center">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-500/10 text-brand-500 text-[11px] font-medium">
                        {models.length}
                      </span>
                    </td>
                    <td className="py-2.5 px-2">
                      <div className="flex flex-wrap gap-1.5">
                        {models.map((m, mi) => {
                          const al = aliasesFor(m);
                          return (
                            <span
                              key={mi}
                              className="inline-flex items-center px-2 py-0.5 rounded bg-surface-2 text-text-main text-[11px] font-mono"
                              title={
                                al.length > 0 ? `Aliases: ${al.join(", ")}` : ""
                              }
                            >
                              {bareId(m)}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-center">
                      <CopyBtn value={combo.name} title="Copy combo name" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ModelsList({ apiKey, origin }) {
  const [models, setModels] = useState(null);
  const [combos, setCombos] = useState([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/public/combos")
      .then((r) => r.json())
      .then((d) => setCombos(d.combos || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${origin}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) {
          const comboSet = new Set(combos.map((c) => c.name));
          setModels(
            (json?.data || json?.models || [])
              .map((m) => m.id || m.name)
              .filter(Boolean)
              .filter((m) => {
                const bid = m.includes("/") ? m.split("/")[1] : m;
                return !comboSet.has(m) && !comboSet.has(bid);
              }),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, origin, combos]);

  const bareId = (s) => {
    const str = String(s);
    const i = str.indexOf("/");
    return i >= 0 ? str.slice(i + 1) : str;
  };

  const getCaps = (modelStr) => {
    const provider = modelStr.includes("/") ? modelStr.split("/")[0] : "";
    const model = modelStr.includes("/")
      ? modelStr.slice(modelStr.indexOf("/") + 1)
      : modelStr;
    return getCapabilitiesForModel(provider, model);
  };

  const filtered = (models || []).filter((m) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return m.toLowerCase().includes(q);
  });

  return (
    <Card padding="md">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-text-muted flex items-center gap-1">
          <span className="material-symbols-outlined text-[15px]">
            grid_view
          </span>
          Models ({models === null ? "…" : models.length})
        </span>
      </div>

      <Input
        placeholder="Filter models…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        icon="search"
        size="sm"
        className="mb-2"
      />

      {models === null ? (
        <div className="flex items-center justify-center py-4 text-text-muted text-xs">
          <span className="material-symbols-outlined animate-spin text-[16px] mr-1.5">
            progress_activity
          </span>
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-text-muted text-center py-4">
          No models match.
        </p>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border-subtle">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-surface-2 text-text-muted">
              <tr>
                <th className="text-left py-2 px-3 font-medium">Model</th>
                <th className="text-center py-2 px-2 font-medium">CAPS</th>
                <th className="text-center py-2 px-2 font-medium w-10">Copy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle/50">
              {filtered.map((m, i) => {
                const caps = getCaps(m);
                return (
                  <tr
                    key={i}
                    className="hover:bg-surface-2/50 transition-colors cursor-pointer"
                    onClick={() => {
                      copyText(m);
                    }}
                  >
                    <td className="py-1.5 px-3">
                      <div className="flex items-center gap-2">
                        <ProviderIcon
                          src={
                            providerIdFromModel(m)
                              ? `/providers/${providerIdFromModel(m)}.png`
                              : undefined
                          }
                          alt={m}
                          size={16}
                          className="rounded-md shrink-0 bg-surface-2"
                          fallbackText={(m || "?").slice(0, 2).toUpperCase()}
                        />
                        <code className="text-[11px] font-mono text-text-main truncate">
                          {m}
                        </code>
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <CapacityBadges caps={caps} size={14} />
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copyText(m);
                        }}
                        className="p-1 rounded text-text-muted hover:text-primary transition-colors"
                        type="button"
                      >
                        <span className="material-symbols-outlined text-[13px]">
                          content_copy
                        </span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-text-muted mt-1.5">
        {filtered.length} of {models?.length || 0} shown
      </p>
    </Card>
  );
}
