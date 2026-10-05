"use client";

// Customer portal — session-gated via crx_session (Google OAuth, phase 2).
// Guest view: sign-in with Google. Active view: tabbed portal (balance,
// API key, usage, ledger, pricing). QRIS top-up opens in a modal dialog.
// The old password-based lookup (POST /api/public/key-usage) is retired.
import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, SegmentedControl } from "@/shared/components";
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

// Reverse index: provider alias/uiAlias → provider id (for /providers/{id}.png icons).
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

const PORTAL_TABS = [
  { id: "api", label: "API key", icon: "vpn_key" },
  { id: "usage", label: "Usage", icon: "monitoring" },
  { id: "topup", label: "Top up", icon: "account_balance_wallet" },
];

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
          setBanner({ kind: "success", text: "Account created! Copy your API key now. It is shown only once." });
        }
      } catch {
        setStatus("guest");
      }
    })();
  }, []);

  // Re-pull balance/me after a top-up is credited server-side.
  const refreshMe = useCallback(async () => {
    try {
      const r = await fetch("/api/customer/me", { headers: { "Cache-Control": "no-store" } });
      if (r.ok) setMe(await r.json());
    } catch {}
  }, []);

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center p-4">
        <span className="material-symbols-outlined animate-spin text-text-muted text-2xl">
          progress_activity
        </span>
      </div>
    );
  }

  if (status === "guest") {
    return (
      <Shell>
        {banner && <Banner banner={banner} />}
        <GuestView />
      </Shell>
    );
  }

  if (status === "disabled") {
    return (
      <Shell>
        <Card className="text-center py-10">
          <h1 className="text-xl font-bold text-primary mb-1">Account disabled</h1>
          <p className="text-sm text-text-muted">
            This account has been disabled by the administrator.
          </p>
          <Button variant="ghost" size="sm" className="mt-4" onClick={logout}>
            Sign out
          </Button>
        </Card>
      </Shell>
    );
  }

  // active
  return (
    <PortalView
      me={me}
      banner={banner}
      revealedKey={revealedKey}
      onRegenerated={(key) => setRevealedKey(key)}
      onLogout={() => {
        setMe(null);
        setRevealedKey(null);
        setStatus("guest");
      }}
      origin={origin}
      onRefresh={refreshMe}
    />
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-bg flex flex-col items-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function Banner({ banner }) {
  return (
    <div
      className={`mb-5 rounded-[10px] border px-4 py-3 text-sm ${
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

/* ── Active portal: topbar (brand + balance + account) and nav tabs ── */

function PortalView({ me, banner, revealedKey, onRegenerated, onLogout, onRefresh, origin }) {
  const [tab, setTab] = useState("api");
  const [plaintext, setPlaintext] = useState(revealedKey || null);
  const contentRef = useRef(null);

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

  const micros = Number(me.balance?.balanceMicros) || 0;

  const pickTab = (id) => {
    setTab(id);
    // Keep the tab bar in view when switching from a tall section.
    if (contentRef.current) contentRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-bg">
      {/* Topbar: brand, live balance, account */}
      <header className="sticky top-0 z-30 bg-surface/85 backdrop-blur border-b border-border-subtle">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="shrink-0 w-7 h-7 rounded-lg bg-brand-500 text-white flex items-center justify-center">
              <span className="material-symbols-outlined text-[18px]">token</span>
            </div>
            <span className="text-sm font-semibold text-text-main">9Router</span>
            <span className="hidden sm:inline text-xs text-text-muted ml-1">API Portal</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tabular-nums text-primary" title="Current balance">
              {fmtMoney(micros)}
            </span>
            <Button variant="ghost" size="sm" icon="logout" onClick={onLogout} title="Sign out">
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
        {/* Nav tabs */}
        <nav className="max-w-3xl mx-auto px-4 flex gap-1 overflow-x-auto" aria-label="Portal sections">
          {PORTAL_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pickTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                tab === t.id
                  ? "border-brand-500 text-text-main"
                  : "border-transparent text-text-muted hover:text-text-main"
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main ref={contentRef} className="max-w-3xl mx-auto px-4 py-6 scroll-mt-24">
        {banner && <Banner banner={banner} />}

        {tab === "api" && (
          <div className="flex flex-col gap-4">
            <ApiKeyCard
              mask={me.key?.mask}
              plaintext={plaintext}
              onRegenerate={onRegenerate}
              origin={origin}
            />
            <PublicModelsCard />
          </div>
        )}
        {tab === "usage" && (
          <div className="flex flex-col gap-4">
            <UsageCard />
            <LedgerCard />
          </div>
        )}
        {tab === "topup" && (
          <div className="flex flex-col gap-4">
            <BalanceCard balance={me.balance} />
            <TopUpCard refreshBalance={onRefresh} />
          </div>
        )}
      </main>
    </div>
  );
}

// ── Published model prices: official → customer price (after discount) → cache % ──
const PRICE_SORTS = {
  name: (m) => m.name,
  official: (m) => (m.official ? m.official.input + m.official.output : -1),
  price: (m) => m.sell.input + m.sell.output,
  price_idr: (m) => m.sell.input + m.sell.output,
  cache: (m) => (m.sell.cachedPct != null ? m.sell.cachedPct : -1),
};

function PublicModelsCard() {
  const [items, setItems] = useState(null);
  const [idrPerUsd, setIdrPerUsd] = useState(null);
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState("asc");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/customer/pricing")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return;
        setItems(d.items || []);
        setIdrPerUsd(Number(d.idrPerUsd) > 0 ? Number(d.idrPerUsd) : null);
      })
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
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-primary">Model pricing</h3>
        <span className="text-[11px] text-text-muted">USD per 1M token, click a column to sort</span>
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
                  ["price_idr", "IDR", "pr-3 text-right"],
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
                  <td className="py-2 pr-3 text-right tabular-nums text-text-muted">
                    {idrPerUsd
                      ? `Rp ${fmtIdr(m.sell.input * idrPerUsd)} / Rp ${fmtIdr(m.sell.output * idrPerUsd)}`
                      : "—"}
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
        &ldquo;Price&rdquo; is the final price after the discount, used for billing. &ldquo;IDR&rdquo; converts it at
        the current top-up rate{idrPerUsd ? ` (Rp ${Math.round(idrPerUsd).toLocaleString("id-ID")} / USD)` : ""}.
        &ldquo;Cache&rdquo; is the input price when the prompt is cached, as a percentage of the input price.
      </p>
    </Card>
  );
}

// USD/1M → short display (max 4 decimals, trailing zeros trimmed).
function fmtRate(n) {
  return String(parseFloat((Number(n) || 0).toFixed(4)));
}

// IDR/1M → compact display, rounded to a sensible digit count.
function fmtIdr(n) {
  const v = Number(n) || 0;
  const digits = v >= 100_000 ? 0 : v >= 1_000 ? 1 : 2;
  return v.toLocaleString("id-ID", { maximumFractionDigits: digits });
}

// ── Top up balance via Tako ──
const TOPUP_AMOUNTS_IDR = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];

const TOPUP_STATUS_LABEL = {
  pending: "Awaiting payment",
  paid: "Paid",
  failed: "Failed",
  expired: "Expired",
};

function TopUpCard({ refreshBalance }) {
  const [amount, setAmount] = useState(TOPUP_AMOUNTS_IDR[2]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Pending payment { id, paymentUrl, amountIdr }. Tako's API exposes no QR
  // payload or QR image — their QRIS renders only on the tako.id/pay page,
  // which can't be iframed (X-Frame-Options: SAMEORIGIN) — so the Tako page
  // opens in a popup window and this card polls the row until credited.
  const [payment, setPayment] = useState(null);
  const [paid, setPaid] = useState(false);
  const [history, setHistory] = useState(null);
  const popupRef = useRef(null);

  const openPopup = (url) => {
    const win = window.open(url || "", "qris-payment", "popup=yes,width=480,height=780");
    popupRef.current = win;
    if (win && !url) {
      win.document.body.innerHTML =
        '<p style="font-family:system-ui,sans-serif;padding:24px;color:#555">Opening QRIS payment…</p>';
    }
    return win;
  };

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
    setPaid(false);
    // Open synchronously inside the click gesture so popup blockers allow it.
    const win = openPopup();
    try {
      const res = await fetch("/api/customer/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountIdr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        win?.close();
        setError(data.error || `Failed (${res.status})`);
      } else if (data.manual) {
        // No online payment configured server-side; the request is recorded
        // pending and the customer contacts the admin to settle it.
        win?.close();
        setNotice(data.message || "Top-up recorded. Contact the admin to settle it.");
        setAmount(amountIdr);
        loadHistory();
      } else {
        const t = data.topup || {};
        setPayment({ id: t.id ?? null, paymentUrl: t.paymentUrl || null, amountIdr });
        setAmount(amountIdr);
        if (win && t.paymentUrl) win.location.replace(t.paymentUrl);
        else win?.close();
        loadHistory();
      }
    } catch (err) {
      win?.close();
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // Poll while a payment is pending: the Tako webhook (or reconciliation)
  // credits the balance server-side, we just reflect it here.
  useEffect(() => {
    if (!payment?.id || paid) return;
    let cancelled = false;
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/customer/topups?limit=10", { headers: { "Cache-Control": "no-store" } });
        const d = r.ok ? await r.json() : {};
        const row = (d.items || []).find((t) => t.id === payment.id);
        if (!cancelled && row?.status === "paid") {
          setPaid(true);
          popupRef.current?.close();
          loadHistory();
          refreshBalance?.();
        }
      } catch {}
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [payment, paid, loadHistory, refreshBalance]);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary">Top up</h3>
        <span className="text-[11px] text-text-muted">QRIS</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {TOPUP_AMOUNTS_IDR.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => pickPreset(a)}
            aria-pressed={custom === "" && amount === a}
            className={`px-3 py-1.5 rounded-[10px] text-xs border transition-colors ${
              custom === "" && amount === a
                ? "border-brand-500 bg-brand-500/10 text-primary font-semibold"
                : "border-border-subtle text-text-muted hover:text-text-main"
            }`}
          >
            Rp {a.toLocaleString("id-ID")}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-[11px] text-text-muted">
        Custom amount (IDR, min 10,000)
        <input
          type="number"
          min={10_000}
          step={1000}
          value={custom}
          placeholder="e.g. 150000"
          onChange={(e) => setCustom(e.target.value)}
          className="w-44 px-3 py-1.5 rounded-[10px] border border-border-subtle bg-surface-2 text-xs text-text-main focus:outline-none focus:border-brand-500"
        />
      </label>

      <Button onClick={startTopup} disabled={busy} size="sm" className="self-start">
        {busy ? "Processing…" : "Create QRIS payment"}
      </Button>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {notice && <p className="text-xs text-text-muted">{notice}</p>}
      {paid && (
        <p className="text-xs text-success flex items-center gap-1">
          <span className="material-symbols-outlined text-[15px]">check_circle</span>
          Payment received. Balance updated.
        </p>
      )}
      {payment && !paid && (
        <div className="rounded-[10px] border border-border-subtle bg-surface-2 p-3 flex flex-col gap-2">
          <span className="text-xs font-medium">
            Waiting for payment · Rp {(payment.amountIdr || 0).toLocaleString("id-ID")}
          </span>
          <span className="text-[11px] text-text-muted">
            Scan the QRIS in the payment window. This page updates automatically once paid.
          </span>
          {payment.paymentUrl && (
            <Button variant="outline" size="sm" className="self-start" icon="qr_code_2" onClick={() => openPopup(payment.paymentUrl)}>
              Open QRIS window
            </Button>
          )}
        </div>
      )}

      {Array.isArray(history) && history.length > 0 && (
        <div className="pt-3 border-t border-border-subtle">
          <div className="text-[11px] font-medium text-text-muted mb-1.5">Recent top-ups</div>
          <ul className="space-y-1.5 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
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

function BalanceCard({ balance }) {
  const micros = Number(balance?.balanceMicros) || 0;
  const reserved = Number(balance?.reservedMicros) || 0;
  const low = micros < 100_000; // < $0.10
  return (
    <Card className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text-muted">Balance</span>
      <span className={`text-3xl font-bold tabular-nums ${low ? "text-red-500" : "text-primary"}`}>
        {fmtMoney(micros)}
      </span>
      <span className="text-[11px] text-text-muted">
        {reserved > 0 ? `${fmtMoney(reserved)} held for in-flight requests. ` : ""}Deducted per request.
      </span>
    </Card>
  );
}

function ApiKeyCard({ mask, plaintext, onRegenerate, origin }) {
  const [show, setShow] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const [revealError, setRevealError] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);
  const v1Url = origin ? `${origin}/v1` : "/v1";
  const docModel = "cc/";

  // Re-reveal: the key is stored encrypted server-side, so the customer can
  // view/copy it again without regenerating. 409 (legacy key) → hint regenerate.
  const revealKey = async () => {
    setRevealBusy(true);
    setRevealError("");
    try {
      const res = await fetch("/api/customer/keys/reveal", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.key) {
        setRevealed(body.key);
        setShow(true);
      } else {
        setRevealError(
          res.status === 409
            ? "This key can't be shown again. Regenerate to get a new one."
            : body.error || `Failed (${res.status})`,
        );
      }
    } catch (err) {
      setRevealError(String(err?.message || err));
    } finally {
      setRevealBusy(false);
    }
  };

  const shownKey = plaintext || (show ? revealed : null);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary">API key</h3>
        <Button variant="ghost" size="sm" icon="autorenew" onClick={onRegenerate}>
          Regenerate
        </Button>
      </div>

      {shownKey ? (
        <div className="flex items-center gap-2 bg-surface-2 rounded-[10px] px-3 py-2">
          <code className="text-xs flex-1 truncate font-mono">{shownKey}</code>
          <CopyBtn value={shownKey} title="Copy API key" />
          <Button
            variant="ghost"
            size="sm"
            icon={show ? "visibility_off" : "visibility"}
            onClick={() => setShow((v) => !v)}
          >
            {show ? "Hide" : "Show"}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-surface-2 rounded-[10px] px-3 py-2">
          <code className="text-xs flex-1 truncate font-mono">{mask || "—"}</code>
          <Button variant="ghost" size="sm" icon="visibility" onClick={revealKey} disabled={revealBusy}>
            {revealBusy ? "…" : "Show key"}
          </Button>
        </div>
      )}
      {revealError && <p className="text-[11px] text-red-500">{revealError}</p>}
      {plaintext ? (
        <p className="text-[11px] text-warning flex items-start gap-1">
          <span className="material-symbols-outlined text-[14px] mt-px">warning</span>
          Shown only this once. Store it now. Regenerating revokes the current key immediately.
        </p>
      ) : (
        <p className="text-[11px] text-text-muted">
          The key stays available here. Show or copy it anytime. Regenerate issues a
          new key (the current one stops working immediately).
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
  -H "Authorization: Bearer ${shownKey || "YOUR_API_KEY"}" \\
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
  const [totals, setTotals] = useState({ officialMicros: 0, chargedMicros: 0, savedMicros: 0 });

  const load = useCallback((p) => {
    fetch(`/api/customer/usage?period=${encodeURIComponent(p)}`, {
      headers: { "Cache-Control": "no-store" },
    })
      .then((r) => (r.ok ? r.json() : { items: [], totals: { officialMicros: 0, chargedMicros: 0, savedMicros: 0 } }))
      .then((d) => {
        setItems(d.items || []);
        setTotals(d.totals || { officialMicros: 0, chargedMicros: 0, savedMicros: 0 });
      })
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  const totalIn = (items || []).reduce((s, r) => s + (Number(r.promptTokens) || 0), 0);
  const totalOut = (items || []).reduce((s, r) => s + (Number(r.completionTokens) || 0), 0);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-primary">Usage</h3>
        <SegmentedControl
          options={USAGE_PERIODS}
          value={period}
          onChange={setPeriod}
          size="sm"
        />
      </div>

      {items === null ? (
        <div className="h-20 rounded-[10px] bg-surface-2 animate-pulse" />
      ) : items.length === 0 ? (
        <div className="h-20 rounded-[10px] border border-dashed border-border-subtle flex items-center justify-center text-[11px] text-text-muted">
          No usage in this period.
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-bold tabular-nums text-primary">
              {fmtMoney(totals.chargedMicros || 0)}
            </span>
            <span className="text-xs text-text-muted">
              billed
              {totals.savedMicros > 0 && (
                <>, saved {fmtMoney(totals.savedMicros)} vs official {fmtMoney(totals.officialMicros || 0)}</>
              )}
            </span>
            <span className="ml-auto text-xs text-text-muted tabular-nums">
              {fmtCompact(totalIn)} in / {fmtCompact(totalOut)} out
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-[10px] border border-border-subtle divide-y divide-border-subtle/60 custom-scrollbar">
            {items.map((r, i) => (
              <UsageRow key={i} r={r} />
            ))}
          </div>
          <p className="text-[11px] text-text-muted">
            {items.length} request{items.length === 1 ? "" : "s"} in this period. Older rows show the estimated catalog price.
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
            <div className="text-text-muted">Billed</div>
            <div className="text-text-main tabular-nums">
              {r.chargedMicros != null
                ? fmtMoney(r.chargedMicros)
                : fmtMoney(Math.round((Number(r.cost) || 0) * 1_000_000))}
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
  const [tab, setTab] = useState("all");

  useEffect(() => {
    fetch("/api/customer/ledger?limit=50", { headers: { "Cache-Control": "no-store" } })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);

  // Tabs collapse the noise: customers read top-ups and usage; reserve
  // hold/release pairs are internal plumbing of a single request.
  const TABS = [
    { id: "all", label: "All" },
    { id: "topup_credit", label: "Top-ups" },
    { id: "usage_debit", label: "Usage" },
    { id: "adjustment", label: "Adjustments" },
  ];
  const filtered = (items || []).filter((e) => (tab === "all" ? true : e.type === tab));

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-primary">Ledger</h3>
        <div className="flex gap-1 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
              className={`text-[11px] px-2.5 py-1 rounded-[10px] border transition-colors ${
                tab === t.id
                  ? "bg-brand-500/10 border-brand-500/40 text-text-main font-medium"
                  : "border-border-subtle text-text-muted hover:text-text-main"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {items === null ? (
        <div className="h-20 rounded-[10px] bg-surface-2 animate-pulse" />
      ) : filtered.length === 0 ? (
        <div className="h-20 rounded-[10px] border border-dashed border-border-subtle flex items-center justify-center text-[11px] text-text-muted">
          No transactions here.
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-[10px] border border-border-subtle divide-y divide-border-subtle/60 custom-scrollbar">
          {filtered.map((e, i) => {
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
      <div className="relative bg-bg border border-border-subtle rounded-[10px]">
        <pre className="text-[11px] leading-relaxed p-3 pr-9 overflow-x-auto custom-scrollbar">
          <code>{code}</code>
        </pre>
        <div className="absolute top-1.5 right-1.5">
          <CopyBtn value={code} title="Copy" />
        </div>
      </div>
    </div>
  );
}
