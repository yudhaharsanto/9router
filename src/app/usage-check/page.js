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
} from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";

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
  usage_debit: "Usage",
  usage_settle: "Usage",
  reserve_hold: "Reserve",
  reserve_release: "Release",
  adjustment: "Adjustment",
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
          <TopUpCard />
        </div>
      </div>

      <PublicModelsCard />

      <LedgerCard />
    </div>
  );
}

// ── Published model prices: official → customer price (after discount) → cache % ──
const PRICE_SORTS = {
  name: (m) => m.name,
  official: (m) => (m.official ? m.official.input + m.official.output : -1),
  price: (m) => m.sell.input + m.sell.output,
  cache: (m) => (m.sell.cachedPct != null ? m.sell.cachedPct : -1),
};

function PublicModelsCard() {
  const [items, setItems] = useState(null);
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState("asc");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/customer/pricing")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => !cancelled && setItems(d.items || []))
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sorted = (() => {
    if (!items) return null;
    const get = PRICE_SORTS[sortKey] || PRICE_SORTS.name;
    const arr = [...items].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb));
      }
      return va - vb;
    });
    if (sortDir === "desc") arr.reverse();
    return arr;
  })();

  const arrow = (key) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-primary">Model Pricing</h3>
        <span className="text-[11px] text-text-muted">USD per 1M token · click a column to sort</span>
      </div>
      {sorted === null ? (
        <div className="text-xs text-text-muted py-4 text-center">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="text-xs text-text-muted py-4 text-center">
          No published models yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-text-muted border-b border-border-subtle">
                {[
                  ["name", "Model", ""],
                  ["official", "Official", "pr-3 text-right"],
                  ["price", "Price", "pr-3 text-right"],
                  ["cache", "Cache", "text-right"],
                ].map(([key, label, extra]) => (
                  <th key={key} className={`py-2 font-medium cursor-pointer select-none hover:text-text-main ${extra || ""}`} onClick={() => toggleSort(key)}>
                    {label}
                    {arrow(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle/50">
              {sorted.map((m) => (
                <tr key={m.name} className="hover:bg-surface-2/50 transition-colors">
                  <td className="py-2 pr-3">
                    <CopyBtn value={m.name} title="Copy model name" />
                    <code className="ml-1.5 font-mono text-text-main">{m.name}</code>
                  </td>
                  <td className="py-2 pr-3 text-right text-text-muted tabular-nums">
                    {m.official
                      ? `$${fmtRate(m.official.input)} / $${fmtRate(m.official.output)}`
                      : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right font-semibold text-primary tabular-nums">
                    ${fmtRate(m.sell.input)} / ${fmtRate(m.sell.output)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-text-muted">
                    {m.sell.cachedPct != null ? `${m.sell.cachedPct}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-text-muted mt-3">
        &ldquo;Price&rdquo; = The final price after the discount, used for billing. <br /> &ldquo;Cache&ldquo; = input price
        when the prompt is cached, as a percentage of the input price.
      </p>
    </Card>
  );
}

// USD/1M → tampilan pendek (max 4 desimal, trailing zero dipangkas).
function fmtRate(n) {
  return String(parseFloat((Number(n) || 0).toFixed(4)));
}

// ── Top up balance via Tako ──
const TOPUP_AMOUNTS_IDR = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];

const TOPUP_STATUS_LABEL = {
  pending: "Awaiting payment",
  paid: "Paid",
  failed: "Failed",
  expired: "Expired",
};

function TopUpCard() {
  const [amount, setAmount] = useState(TOPUP_AMOUNTS_IDR[2]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [paymentUrl, setPaymentUrl] = useState(null);
  const [history, setHistory] = useState(null);

  // Preset click clears the free-form field; typing in it clears the preset.
  const pickPreset = (a) => {
    setAmount(a);
    setCustom("");
  };
  const effectiveAmount = () => {
    const n = Number(custom);
    return custom !== "" && Number.isInteger(n) ? n : amount;
  };

  const loadHistory = useCallback(() => {
    fetch("/api/customer/topups?limit=10")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setHistory(d.items || []))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const startTopup = async () => {
    const amountIdr = effectiveAmount();
    if (!Number.isInteger(amountIdr) || amountIdr < 10_000) {
      setError("Minimum amount is Rp 10,000.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setPaymentUrl(null);
    try {
      const res = await fetch("/api/customer/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountIdr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed (${res.status})`);
      } else if (data.manual) {
        // No online payment configured server-side; the request is recorded
        // pending and the customer contacts the admin to settle it.
        setNotice(data.message || "Top-up recorded — contact the admin.");
        setAmount(amountIdr);
        loadHistory();
      } else {
        setPaymentUrl(data.topup?.paymentUrl || null);
        loadHistory();
        if (!data.topup?.paymentUrl) {
          setNotice("Top-up created. Awaiting payment confirmation.");
        }
      }
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 px-4 py-4">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-2">Top Up Balance</h3>
        <div>
          <div className="flex flex-wrap gap-2">
            {TOPUP_AMOUNTS_IDR.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => pickPreset(a)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                  custom === "" && amount === a
                    ? "border-brand-500 bg-brand-500/10 text-primary font-semibold"
                    : "border-border-subtle text-text-muted hover:text-text-main"
                }`}
              >
                Rp {a.toLocaleString("id-ID")}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 mt-2 text-[11px] text-text-muted">
            Or enter a custom amount:
            <input
              type="number"
              min={10_000}
              step={1000}
              value={custom}
              placeholder="mis. 150000"
              onChange={(e) => setCustom(e.target.value)}
              className="w-32 px-2 py-1 rounded-lg border border-border-subtle bg-surface-2 text-xs text-text-main focus:outline-none focus:border-brand-500"
            />
            IDR
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button onClick={startTopup} disabled={busy} size="sm">
          {busy ? "Processing…" : "Create Payment"}
        </Button>
        {paymentUrl && (
          <a
            href={paymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-brand-500 underline font-medium"
          >
            Buka halaman pembayaran →
          </a>
        )}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {notice && <p className="text-xs text-text-muted">{notice}</p>}
      {Array.isArray(history) && history.length > 0 && (
        <div className="pt-2 border-t border-border-subtle">
          <div className="text-[11px] font-medium text-text-muted mb-1.5">Top-up history</div>
          <ul className="space-y-1 max-h-30 overflow-y-auto pr-1">
            {history.map((t) => (
              <li key={t.id} className="flex items-center justify-between text-xs">
                <span className="text-text-main tabular-nums">
                  Rp {Number(t.amountIdr).toLocaleString("id-ID")}
                </span>
                <span className="text-text-muted tabular-nums">
                  +{fmtMoney(t.creditedMicros)} · {TOPUP_STATUS_LABEL[t.status] || t.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
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
          <div className="text-right">
            <div className="text-text-muted">Biaya</div>
            <div className="text-text-main tabular-nums">{fmtMoney(r.cost)}</div>
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

