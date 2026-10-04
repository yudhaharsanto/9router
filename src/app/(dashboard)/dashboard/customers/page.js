"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import { CardSkeleton } from "@/shared/components/Loading";

// Money is stored as integer micro-USD (µ$) — same convention as the portal.
function fmtMoney(micros) {
  const v = (Number(micros) || 0) / 1_000_000;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

const COLUMNS = [
  { field: "name", label: "Customer" },
  { field: "status", label: "Status" },
  { field: "balanceMicros", label: "Balance", align: "right" },
  { field: "reservedMicros", label: "Reserved", align: "right" },
  { field: "totalTopupMicros", label: "Total Top-up", align: "right" },
  { field: "keyMask", label: "API Key" },
  { field: "createdAt", label: "Created" },
  { field: "actions", label: "Actions" },
];

function SortIcon({ field, currentSort, currentOrder }) {
  if (currentSort !== field) return <span className="ml-1 opacity-20">↕</span>;
  return <span className="ml-1">{currentOrder === "asc" ? "↑" : "↓"}</span>;
}

function cellValue(c, field) {
  switch (field) {
    case "name":
      return (
        <div>
          <div className="font-medium text-text-primary">{c.name || "—"}</div>
          <div className="text-xs text-text-muted">{c.email || c.id}</div>
        </div>
      );
    case "status":
      return (
        <Badge variant={c.status === "active" ? "success" : "error"}>{c.status}</Badge>
      );
    case "balanceMicros":
    case "reservedMicros":
    case "totalTopupMicros":
      return <span className={field === "balanceMicros" ? "font-medium" : "text-text-muted"}>{fmtMoney(c[field])}</span>;
    case "keyMask":
      return <span className="font-mono text-xs">{c.keyMask || "—"}</span>;
    case "createdAt":
      return <span className="text-text-muted">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—"}</span>;
    default:
      return null;
  }
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState("desc");

  // Admin billing tools (phase 7)
  const [reconResult, setReconResult] = useState(null);
  const [reconBusy, setReconBusy] = useState(false);
  const [settings, setSettings] = useState({ discountRate: 0.5, minMarginPct: 0, marginBehavior: "skip", idrPerUsd: "", takoUsername: "" });
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cRes, sRes] = await Promise.all([
          fetch("/api/admin/customers", { cache: "no-store" }),
          fetch("/api/settings", { cache: "no-store" }),
        ]);
        if (!cRes.ok) throw new Error(`customers: HTTP ${cRes.status}`);
        const body = await cRes.json();
        if (!cancelled) setCustomers(body.customers || []);
        if (sRes.ok) {
          const s = await sRes.json();
          if (!cancelled) {
            setSettings({
              discountRate: s.discountRate ?? 0.5,
              minMarginPct: s.minMarginPct ?? 0,
              marginBehavior: s.marginBehavior || "skip",
              idrPerUsd: s.idrPerUsd || "",
              takoUsername: s.takoUsername || "",
            });
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSort = (field) => {
    if (sortBy === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("desc");
    }
  };

  const sorted = !customers
    ? []
    : [...customers].sort((a, b) => {
        const va = a[sortBy];
        const vb = b[sortBy];
        const cmp = typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va ?? "").localeCompare(String(vb ?? ""));
        return sortOrder === "asc" ? cmp : -cmp;
      });

  const setStatus = async (id, status) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await (await fetch("/api/admin/customers", { cache: "no-store" })).json();
      setCustomers(body.customers || []);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  const runReconciliation = async () => {
    setReconBusy(true);
    setReconResult(null);
    try {
      const res = await fetch("/api/admin/reconciliation/tako", { cache: "no-store" });
      const body = await res.json();
      setReconResult(res.ok ? body : { error: body.error || `HTTP ${res.status}` });
    } catch (e) {
      setReconResult({ error: String(e?.message || e) });
    } finally {
      setReconBusy(false);
    }
  };

  const saveSettings = async () => {
    setSettingsSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discountRate: Number(settings.discountRate),
          minMarginPct: Number(settings.minMarginPct),
          marginBehavior: settings.marginBehavior,
          idrPerUsd: settings.idrPerUsd,
          takoUsername: settings.takoUsername,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  if (error && !customers) {
    return <div className="p-6 text-sm text-red-500">Failed to load customers: {error}</div>;
  }
  if (!customers) {
    return <CardSkeleton />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border bg-bg-subtle/50">
          <h3 className="font-semibold">Customers</h3>
          <button
            onClick={async () => {
              const body = await (await fetch("/api/admin/customers", { cache: "no-store" })).json();
              setCustomers(body.customers || []);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg-subtle"
          >
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.field}
                    className={`px-6 py-3 cursor-pointer hover:bg-bg-subtle/50 ${col.align === "right" ? "text-right" : ""}`}
                    onClick={() => toggleSort(col.field)}
                  >
                    {col.label} <SortIcon field={col.field} currentSort={sortBy} currentOrder={sortOrder} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-6 py-8 text-center text-text-muted">
                    No customers yet.
                  </td>
                </tr>
              )}
              {sorted.map((c) => (
                <tr key={c.id} className="hover:bg-bg-subtle/20 transition-colors">
                  <td className="px-6 py-3">{cellValue(c, "name")}</td>
                  <td className="px-6 py-3">{cellValue(c, "status")}</td>
                  <td className="px-6 py-3 text-right">{cellValue(c, "balanceMicros")}</td>
                  <td className="px-6 py-3 text-right text-text-muted">{cellValue(c, "reservedMicros")}</td>
                  <td className="px-6 py-3 text-right">{cellValue(c, "totalTopupMicros")}</td>
                  <td className="px-6 py-3">{cellValue(c, "keyMask")}</td>
                  <td className="px-6 py-3">{cellValue(c, "createdAt")}</td>
                  <td className="px-6 py-3">
                    {c.status === "active" ? (
                      <button
                        disabled={busyId === c.id}
                        onClick={() => setStatus(c.id, "disabled")}
                        className="rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        disabled={busyId === c.id}
                        onClick={() => setStatus(c.id, "active")}
                        className="rounded-md border border-green-500/40 px-2 py-1 text-xs text-green-600 hover:bg-green-500/10 disabled:opacity-50"
                      >
                        Enable
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-border bg-bg-subtle/50">
          <h3 className="font-semibold">Billing Settings</h3>
        </div>
        <div className="p-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Discount rate (0–1)</span>
            <input
              type="number" min="0" max="0.99" step="0.05"
              value={settings.discountRate}
              onChange={(e) => setSettings((s) => ({ ...s, discountRate: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Min margin pct (0–1)</span>
            <input
              type="number" min="0" max="1" step="0.05"
              value={settings.minMarginPct}
              onChange={(e) => setSettings((s) => ({ ...s, minMarginPct: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Margin behavior</span>
            <select
              value={settings.marginBehavior}
              onChange={(e) => setSettings((s) => ({ ...s, marginBehavior: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2"
            >
              <option value="skip">Skip (warn only)</option>
              <option value="block">Block (503)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">IDR per USD (daily FX)</span>
            <input
              type="text" inputMode="numeric"
              value={settings.idrPerUsd}
              onChange={(e) => setSettings((s) => ({ ...s, idrPerUsd: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Tako username</span>
            <input
              type="text"
              value={settings.takoUsername}
              onChange={(e) => setSettings((s) => ({ ...s, takoUsername: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2"
            />
          </label>
        </div>
        <div className="flex items-center gap-3 px-4 pb-4">
          <button
            onClick={saveSettings}
            className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90"
          >
            Save Settings
          </button>
          {settingsSaved && <span className="text-sm text-green-600">Saved</span>}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border bg-bg-subtle/50">
          <h3 className="font-semibold">Tako Reconciliation</h3>
          <button
            onClick={runReconciliation}
            disabled={reconBusy}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg-subtle disabled:opacity-50"
          >
            {reconBusy ? "Running…" : "Run Reconciliation"}
          </button>
        </div>
        <div className="p-4 text-sm">
          {reconResult ? (
            reconResult.error ? (
              <span className="text-red-500">Error: {reconResult.error}</span>
            ) : (
              <div className="text-text-muted">
                Checked {reconResult.checked} pending topup(s) · credited {reconResult.credited}.
              </div>
            )
          ) : (
            <span className="text-text-muted">
              Sweeps stuck pending Tako topups (older than 5 minutes) against the Tako API and credits paid ones.
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
