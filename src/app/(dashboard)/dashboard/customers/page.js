"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import { CardSkeleton } from "@/shared/components/Loading";

// Compact per-row action dropdown — keeps table rows clean when a row has
// several actions. Items: { label, onClick, danger? }.
function ActionsMenu({ items }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block text-left">
      <button
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="rounded-md border border-border px-2.5 py-1 text-xs text-text-main hover:bg-bg-subtle/40"
      >
        Actions ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              // preventDefault on mousedown keeps focus on the trigger, so the
              // trigger's blur-close can't race/kill the item's click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.preventDefault(); setOpen(false); it.onClick(); }}
              className={`block w-full px-3 py-2 text-left text-xs hover:bg-bg-subtle/60 ${it.danger ? "text-red-600" : "text-text-main"}`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Money is stored as integer micro-USD (µ$) — same convention as the portal.
function fmtMoney(micros) {
  const v = (Number(micros) || 0) / 1_000_000;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

// Rates are USD per 1M tokens.
const fmtRate = (v) => `$${(Number(v) || 0).toFixed(2)}`;

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
  const [settings, setSettings] = useState({ discountRate: 0.5, minMarginPct: 0, marginBehavior: "skip", idrPerUsd: "", takoUsername: "", takoMerchantKey: "", takoCallbackSecret: "", takoCallbackConfigured: false, takoMerchantConfigured: false });
  const [settingsSaved, setSettingsSaved] = useState(false);
  // Read-only view of what customers are billed: official catalog price × (1 − discountRate).
  const [pricing, setPricing] = useState(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  // Public model ↔ combo mapping (spec §3.6)
  const [publicModels, setPublicModels] = useState(null);
  const [comboOptions, setComboOptions] = useState([]);
  const [newPub, setNewPub] = useState({ publicName: "", comboId: "", pricing: { input: "", output: "", cachedPct: "" } });
  const [editingPub, setEditingPub] = useState(null);
  const [pubBusy, setPubBusy] = useState(false);
  // Token packages (katalog + assign)
  const [packages, setPackages] = useState(null);
  const [newPkg, setNewPkg] = useState({ name: "", tokens: "", priceIdr: "", models: [], comboId: "", durationDays: "" });
  const [pkgBusy, setPkgBusy] = useState(false);
  const [pkgMsg, setPkgMsg] = useState(null);
  const [assignModal, setAssignModal] = useState(null); // { packageId, packageName, customerId }
  const [assignBusy, setAssignBusy] = useState(false);
  const [editingPkg, setEditingPkg] = useState(null); // { id, model, comboId }
  // Admin history: paid topups + customers holding package instances
  const [topupHistory, setTopupHistory] = useState(null);
  const [pkgHolders, setPkgHolders] = useState(null);

  const loadHistories = async () => {
    const [tRes, iRes] = await Promise.all([
      fetch("/api/admin/topups", { cache: "no-store" }),
      fetch("/api/admin/packages/instances", { cache: "no-store" }),
    ]);
    if (tRes.ok) setTopupHistory((await tRes.json()).items || []);
    if (iRes.ok) setPkgHolders((await iRes.json()).items || []);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cRes, sRes, pRes] = await Promise.all([
          fetch("/api/admin/customers", { cache: "no-store" }),
          fetch("/api/settings", { cache: "no-store" }),
          fetch("/api/pricing", { cache: "no-store" }),
        ]);
        const pmRes = await fetch("/api/admin/public-models", { cache: "no-store" });
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
              takoMerchantKey: "",
              takoCallbackSecret: "",
              takoMerchantConfigured: !!s.takoMerchantConfigured,
              takoCallbackConfigured: !!s.takoCallbackConfigured,
            });
          }
        }
        if (pRes.ok && !cancelled) setPricing(await pRes.json());
        if (pmRes.ok && !cancelled) {
          const pm = await pmRes.json();
          setPublicModels(pm.publicModels || []);
          setComboOptions(pm.combos || []);
        }
        const pkRes = await fetch("/api/admin/packages", { cache: "no-store" });
        if (pkRes.ok && !cancelled) setPackages((await pkRes.json()).packages || []);
        if (!cancelled) await loadHistories();
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

  const [balanceModal, setBalanceModal] = useState(null); // { id, name, amountUsd, reason }
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceMsg, setBalanceMsg] = useState(null);
  // Usage history modal (admin view of one customer's requests + charges)
  const [usageModal, setUsageModal] = useState(null); // { id, name }
  const [usageData, setUsageData] = useState(null);
  const [usageBusy, setUsageBusy] = useState(false);

  const openUsage = async (c) => {
    setUsageModal({ id: c.id, name: c.name || c.email || c.id });
    setUsageData(null);
    setUsageBusy(true);
    try {
      const res = await fetch(`/api/admin/customers/${c.id}/usage`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setUsageData(body);
    } catch (e) {
      setUsageData({ error: String(e?.message || e) });
    } finally {
      setUsageBusy(false);
    }
  };

  const loginAsCustomer = async (c) => {
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/admin/customers/${c.id}/impersonate`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      window.open("/usage-check", "customer-portal");
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  const submitBalance = async () => {
    if (!balanceModal) return;
    setBalanceBusy(true);
    setBalanceMsg(null);
    try {
      const res = await fetch(`/api/admin/customers/${balanceModal.id}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUsd: Number(balanceModal.amountUsd),
          reason: balanceModal.reason || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setBalanceMsg({ ok: true, text: `New balance: ${(body.balance.balanceMicros / 1e6).toFixed(2)}` });
      const cBody = await (await fetch("/api/admin/customers", { cache: "no-store" })).json();
      setCustomers(cBody.customers || []);
    } catch (e) {
      setBalanceMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setBalanceBusy(false);
    }
  };

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

  // Public model mapping CRUD (spec §3.6)
  const reloadPublicModels = async () => {
    const res = await fetch("/api/admin/public-models", { cache: "no-store" });
    if (res.ok) {
      const pm = await res.json();
      setPublicModels(pm.publicModels || []);
      setComboOptions(pm.combos || []);
    }
  };

  const savePublicModel = async (override = null) => {
    const form = override || newPub;
    setPubBusy(true);
    try {
      const pricing = {};
      for (const k of ["input", "output", "cachedPct"]) {
        if (form.pricing[k] !== "" && form.pricing[k] !== undefined) pricing[k] = Number(form.pricing[k]);
      }
      const res = await fetch("/api/admin/public-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicName: form.publicName.trim(),
          comboId: form.comboId,
          enabled: true,
          // Edit form carries the per-model discount; "" clears it (null).
          ...(form.discountRate !== undefined
            ? { discountRate: form.discountRate === "" ? null : Number(form.discountRate) }
            : {}),
          ...(Object.keys(pricing).length > 0 ? { pricing } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setNewPub({ publicName: "", comboId: "", pricing: { input: "", output: "", cachedPct: "" } });
      setEditingPub(null);
      await reloadPublicModels();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setPubBusy(false);
    }
  };

  const startEditPublicModel = (m) => {
    setEditingPub({
      publicName: m.publicName,
      comboId: m.comboId,
      pricing: {
        input: m.pricing?.input !== undefined && m.pricing?.input !== null ? String(m.pricing.input) : "",
        output: m.pricing?.output !== undefined && m.pricing?.output !== null ? String(m.pricing.output) : "",
        cachedPct: m.pricing?.cachedPct !== undefined && m.pricing?.cachedPct !== null ? String(m.pricing.cachedPct) : "",
      },
      discountRate: m.discountRate != null ? String(m.discountRate) : "",
    });
    setNewPub({ publicName: "", comboId: "", pricing: { input: "", output: "", cachedPct: "" } });
  };

  const togglePublicModel = async (m) => {
    setPubBusy(true);
    try {
      const res = await fetch("/api/admin/public-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicName: m.publicName, comboId: m.comboId, enabled: !m.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await reloadPublicModels();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setPubBusy(false);
    }
  };

  const deletePublicModel = async (m) => {
    setPubBusy(true);
    try {
      const res = await fetch(`/api/admin/public-models?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await reloadPublicModels();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setPubBusy(false);
    }
  };

  // Sell factor = 1 − discountRate, applied to official rates for the sell column.
  const sellFactor = 1 - (Number(settings.discountRate) || 0);

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
          ...(settings.takoMerchantKey.trim() ? { takoMerchantKey: settings.takoMerchantKey.trim() } : {}),
          ...(settings.takoCallbackSecret.trim() ? { takoCallbackSecret: settings.takoCallbackSecret.trim() } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  // ── Token packages ──
  const reloadPackages = async () => {
    const res = await fetch("/api/admin/packages", { cache: "no-store" });
    if (res.ok) setPackages((await res.json()).packages || []);
  };

  const createPkg = async () => {
    setPkgBusy(true);
    setPkgMsg(null);
    try {
      const models = newPkg.models.length ? newPkg.models : ["*"];
      const res = await fetch("/api/admin/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newPkg.name.trim(),
          tokens: Number(newPkg.tokens),
          priceIdr: Number(newPkg.priceIdr) || 0,
          models: models.length ? models : ["*"],
          comboId: newPkg.comboId || null,
          durationDays: Number(newPkg.durationDays) || 0,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setNewPkg({ name: "", tokens: "", priceIdr: "", models: [], comboId: "", durationDays: "" });
      setPkgMsg({ ok: true, text: "Package created" });
      await reloadPackages();
    } catch (e) {
      setPkgMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setPkgBusy(false);
    }
  };

  const togglePkgActive = async (p) => {
    setPkgBusy(true);
    try {
      await fetch(`/api/admin/packages/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !p.active }),
      });
      await reloadPackages();
    } finally {
      setPkgBusy(false);
    }
  };

  const deletePkg = async (p) => {
    if (!confirm(`Delete package "${p.name}"? Refused while customers still hold active or pending instances.`)) return;
    setPkgBusy(true);
    try {
      const res = await fetch(`/api/admin/packages/${p.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error || "Delete failed");
      }
      await reloadPackages();
    } finally {
      setPkgBusy(false);
    }
  };

  const submitAssign = async () => {
    setAssignBusy(true);
    try {
      const res = await fetch(`/api/admin/packages/${assignModal.packageId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: assignModal.customerId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setAssignModal(null);
      setPkgMsg({ ok: true, text: "Package assigned" });
    } catch (e) {
      setPkgMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setAssignBusy(false);
    }
  };

  const savePkgModel = async () => {
    setPkgBusy(true);
    try {
      const res = await fetch(`/api/admin/packages/${editingPkg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models: editingPkg.model.trim() ? [editingPkg.model.trim()] : ["*"],
          comboId: editingPkg.comboId || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setEditingPkg(null);
      await reloadPackages();
    } catch (e) {
      setPkgMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setPkgBusy(false);
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
                    <ActionsMenu
                      items={[
                        { label: "Usage", onClick: () => openUsage(c) },
                        { label: "Login as", onClick: () => loginAsCustomer(c) },
                        {
                          label: "Balance",
                          onClick: () => {
                            setBalanceMsg(null);
                            setBalanceModal({ id: c.id, name: c.name || c.email || c.id, amountUsd: "", reason: "" });
                          },
                        },
                        {
                          label: c.status === "active" ? "Disable" : "Enable",
                          danger: c.status === "active",
                          onClick: () => setStatus(c.id, c.status === "active" ? "disabled" : "active"),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Balance adjustment modal */}
      <Modal
        isOpen={!!balanceModal}
        onClose={() => { setBalanceModal(null); setBalanceMsg(null); }}
        title={`Adjust Balance — ${balanceModal?.name || ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setBalanceModal(null); setBalanceMsg(null); }}>Close</Button>
            <Button
              variant="primary"
              disabled={balanceBusy || !(Number(balanceModal?.amountUsd) !== 0 && Number.isFinite(Number(balanceModal?.amountUsd)))}
              onClick={submitBalance}
            >
              {balanceBusy ? "Applying…" : "Apply"}
            </Button>
          </>
        }
      >
        {balanceModal && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Amount USD (negative to debit)</span>
              <input
                type="number" step="0.01"
                value={balanceModal.amountUsd}
                onChange={(e) => setBalanceModal((b) => ({ ...b, amountUsd: e.target.value }))}
                className="rounded-md border border-border bg-bg-subtle px-3 py-2"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Reason (optional, recorded in ledger)</span>
              <input
                type="text"
                value={balanceModal.reason}
                onChange={(e) => setBalanceModal((b) => ({ ...b, reason: e.target.value }))}
                className="rounded-md border border-border bg-bg-subtle px-3 py-2"
              />
            </label>
            {balanceMsg && (
              <p className={`text-xs ${balanceMsg.ok ? "text-green-600" : "text-red-600"}`}>{balanceMsg.text}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Usage history modal — what this customer actually ran and was charged */}
      <Modal
        isOpen={!!usageModal}
        onClose={() => { setUsageModal(null); setUsageData(null); }}
        title={`Usage — ${usageModal?.name || ""}`}
        footer={
          <Button variant="ghost" onClick={() => { setUsageModal(null); setUsageData(null); }}>Close</Button>
        }
      >
        {usageBusy && <p className="text-sm text-text-muted">Loading…</p>}
        {!usageBusy && usageData?.error && <p className="text-sm text-red-600">{usageData.error}</p>}
        {!usageBusy && usageData && !usageData.error && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-text-muted">Key: <span className="font-mono text-text-main">{usageData.keyMask || "—"}</span></span>
              <span className="text-text-muted">Balance: <span className="text-text-main font-medium">{fmtMoney(usageData.balanceMicros)}</span></span>
              <span className="text-text-muted">Charged (all-time): <span className="text-text-main">{fmtMoney(usageData.totals?.chargedMicros)}</span></span>
            </div>
            {usageData.items?.length === 0 ? (
              <p className="text-sm text-text-muted">No requests recorded for this customer&rsquo;s active key.</p>
            ) : (
              <div className="max-h-80 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-bg-subtle text-left text-text-muted">
                    <tr>
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2 text-right">In</th>
                      <th className="px-3 py-2 text-right">Out</th>
                      <th className="px-3 py-2 text-right">Charged</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {usageData.items.map((r, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 text-text-muted whitespace-nowrap">{r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}</td>
                        <td className="px-3 py-2 font-mono">{r.model || "—"}</td>
                        <td className="px-3 py-2 text-right">{r.promptTokens}</td>
                        <td className="px-3 py-2 text-right">{r.completionTokens}</td>
                        <td className="px-3 py-2 text-right">{r.chargedMicros == null ? "—" : fmtMoney(r.chargedMicros)}</td>
                        <td className="px-3 py-2">{r.status || "ok"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-text-muted">Latest {usageData.items?.length ?? 0} requests matched to the customer&rsquo;s active key. Charged amounts come from the ledger (official estimate: {fmtMoney(usageData.totals?.officialMicros)}).</p>
          </div>
        )}
      </Modal>

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
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">
              Tako merchant key {settings.takoMerchantConfigured ? <span className="text-green-600">(configured)</span> : <span className="text-amber-600">(not set — manual top-up only)</span>}
            </span>
            <input
              type="password" autoComplete="new-password" placeholder={settings.takoMerchantConfigured ? "•••••••• (saved)" : ""}
              value={settings.takoMerchantKey}
              onChange={(e) => setSettings((s) => ({ ...s, takoMerchantKey: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">
              Tako callback secret {settings.takoCallbackConfigured ? <span className="text-green-600">(configured)</span> : <span className="text-amber-600">(not set — webhook unsigned)</span>}
            </span>
            <input
              type="password" autoComplete="new-password" placeholder={settings.takoCallbackConfigured ? "•••••••• (saved)" : ""}
              value={settings.takoCallbackSecret}
              onChange={(e) => setSettings((s) => ({ ...s, takoCallbackSecret: e.target.value }))}
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
        <div className="p-4 border-b border-border bg-bg-subtle/50">
          <h3 className="font-semibold">Token Packages</h3>
          <p className="text-xs text-text-muted">
            Quota-based packages. Usage against a covered model consumes package tokens instead of balance; other models bill balance as usual.
          </p>
        </div>
        <div className="p-4 flex flex-col sm:flex-row flex-wrap gap-2 border-b border-border">
          <input
            type="text" placeholder="Package name (e.g. Paket Mini 50M)"
            value={newPkg.name}
            onChange={(e) => setNewPkg((s) => ({ ...s, name: e.target.value }))}
            className="flex-1 min-w-40 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <input
            type="number" step="1" min="1" placeholder="Tokens (e.g. 50000000)"
            value={newPkg.tokens}
            onChange={(e) => setNewPkg((s) => ({ ...s, tokens: e.target.value }))}
            className="w-44 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <input
            type="number" step="1" min="0" placeholder="Price IDR (0 = assign only)"
            value={newPkg.priceIdr}
            onChange={(e) => setNewPkg((s) => ({ ...s, priceIdr: e.target.value }))}
            className="w-44 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Public model name (e.g. glm-5.3-flash)"
            value={newPkg.models[0] || ""}
            onChange={(e) => setNewPkg((s) => ({ ...s, models: e.target.value.trim() ? [e.target.value.trim()] : [] }))}
            className="flex-1 min-w-44 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <select
            value={newPkg.comboId}
            onChange={(e) => setNewPkg((s) => ({ ...s, comboId: e.target.value }))}
            className="flex-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          >
            <option value="">Select combo…</option>
            {comboOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input
            type="number" step="1" min="0" placeholder="Duration days (0 = forever)"
            value={newPkg.durationDays}
            onChange={(e) => setNewPkg((s) => ({ ...s, durationDays: e.target.value }))}
            className="w-40 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <button
            onClick={createPkg}
            disabled={pkgBusy || !newPkg.name.trim() || !Number(newPkg.tokens)}
            className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            Create
          </button>
        </div>
        {pkgMsg && (
          <div className={`px-4 py-2 text-xs ${pkgMsg.ok ? "text-green-600" : "text-red-500"}`}>{pkgMsg.text}</div>
        )}
        {packages && packages.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase text-text-muted bg-bg-subtle/50">
                <tr>
                  <th className="px-6 py-3">Name</th>
                  <th className="px-6 py-3 text-right">Tokens</th>
                  <th className="px-6 py-3 text-right">Price IDR</th>
                  <th className="px-6 py-3">Models</th>
                  <th className="px-6 py-3 text-right">Duration</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-6 py-3">{p.name}</td>
                    <td className="px-6 py-3 text-right">{p.tokens.toLocaleString()}</td>
                    <td className="px-6 py-3 text-right">Rp{p.priceIdr.toLocaleString()}</td>
                    <td className="px-6 py-3 text-xs text-text-muted">
                      {(() => {
                        let models = p.models;
                        try { models = JSON.parse(p.models); } catch { /* keep raw */ }
                        const combo = p.comboId ? comboOptions.find((c) => c.id === p.comboId) : null;
                        return (
                          <div>
                            <div>{(Array.isArray(models) ? models : [models]).join(", ") || "*"}</div>
                            {combo && <div className="text-text-muted/70">via {combo.name}</div>}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-6 py-3 text-right">{p.durationDays ? `${p.durationDays}d` : "∞"}</td>
                    <td className="px-6 py-3">
                      <Badge variant={p.active ? "success" : "default"}>{p.active ? "active" : "inactive"}</Badge>
                    </td>
                    <td className="px-6 py-3">
                      <ActionsMenu
                        items={[
                          {
                            label: "Assign to customer",
                            onClick: () => setAssignModal({ packageId: p.id, packageName: p.name, customerId: "" }),
                          },
                          {
                            label: "Edit model",
                            onClick: () => {
                              let m = p.models;
                              try { m = JSON.parse(p.models); } catch { /* keep raw */ }
                              setEditingPkg({
                                id: p.id,
                                model: (Array.isArray(m) ? m[0] : m) || "",
                                comboId: p.comboId || "",
                              });
                            },
                          },
                          { label: p.active ? "Deactivate" : "Activate", onClick: () => togglePkgActive(p) },
                          { label: "Delete", onClick: () => deletePkg(p), danger: true },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border bg-bg-subtle/50">
          <div>
            <h3 className="font-semibold">Public Models (Combo Mapping)</h3>
            <p className="text-xs text-text-muted">
              Customers call these names; each maps to a combo. Combo IDs and provider names never reach customers.
            </p>
          </div>
        </div>
        <div className="p-4 flex flex-col sm:flex-row gap-2 border-b border-border">
          <input
            type="text"
            placeholder="Public model name (e.g. glm-5.3-flash)"
            value={newPub.publicName}
            onChange={(e) => setNewPub((s) => ({ ...s, publicName: e.target.value }))}
            className="flex-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <select
            value={newPub.comboId}
            onChange={(e) => setNewPub((s) => ({ ...s, comboId: e.target.value }))}
            className="flex-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          >
            <option value="">Select combo…</option>
            {comboOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input
            type="number" step="0.01" min="0" placeholder="Official $/1M input"
            value={newPub.pricing.input}
            onChange={(e) => setNewPub((s) => ({ ...s, pricing: { ...s.pricing, input: e.target.value } }))}
            className="w-36 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <input
            type="number" step="0.01" min="0" placeholder="Official $/1M output"
            value={newPub.pricing.output}
            onChange={(e) => setNewPub((s) => ({ ...s, pricing: { ...s.pricing, output: e.target.value } }))}
            className="w-36 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <input
            type="number" step="1" min="0" max="100" placeholder="Cached % of input (opt.)"
            value={newPub.pricing.cachedPct}
            onChange={(e) => setNewPub((s) => ({ ...s, pricing: { ...s.pricing, cachedPct: e.target.value } }))}
            className="w-36 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
          />
          <button
            onClick={() => savePublicModel()}
            disabled={pubBusy || !newPub.publicName.trim() || !newPub.comboId}
            className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            Add / Update
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
              <tr>
                <th className="px-6 py-3">Public Name</th>
                <th className="px-6 py-3">Combo</th>
                <th className="px-6 py-3">Price $/1M in / out (official → customer)</th>
                <th className="px-6 py-3">Discount</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!publicModels || publicModels.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-text-muted">
                    No public models yet. Create combos on the Combo page first.
                  </td>
                </tr>
              ) : (
                publicModels.map((m) => (
                  <tr key={m.id} className="hover:bg-bg-subtle/20 transition-colors">
                    <td className="px-6 py-3 font-mono text-xs">{m.publicName}</td>
                    <td className="px-6 py-3">{m.comboName}</td>
                    <td className="px-6 py-3 font-mono text-xs">
                      {m.pricing ? (
                        <span>
                          {fmtRate(m.pricing.input)} / {fmtRate(m.pricing.output)}
                          <span className="text-text-muted"> → {fmtRate((m.pricing.input ?? 0) * sellFactor)} / {fmtRate((m.pricing.output ?? 0) * sellFactor)}</span>
                          {m.pricing.cachedPct !== undefined && <span className="text-text-muted"> · cached {m.pricing.cachedPct}%</span>}
                        </span>
                      ) : m.autoPricing && m.autoPricing.length > 0 ? (
                        <span className="text-text-muted">
                          {m.autoPricing.map((a, i) => (
                            <span key={a.model}>
                              {i > 0 && "; "}
                              {a.model}: {fmtRate(a.sellInput)} / {fmtRate(a.sellOutput)}
                            </span>
                          ))}
                          <span className="block text-[10px]">auto: official × (1 − discount)</span>
                        </span>
                      ) : (
                        <span className="text-text-muted">member price</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-xs">
                      {m.discountRate != null ? (
                        <span className="font-medium">{Math.round(m.discountRate * 100)}%</span>
                      ) : (
                        <span className="text-text-muted">global</span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <Badge variant={m.enabled ? "success" : "error"}>{m.enabled ? "enabled" : "disabled"}</Badge>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <ActionsMenu
                        items={[
                          { label: "Edit price", onClick: () => startEditPublicModel(m) },
                          { label: m.enabled ? "Disable" : "Enable", onClick: () => togglePublicModel(m) },
                          { label: "Delete", onClick: () => deletePublicModel(m), danger: true },
                        ]}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {editingPub && (
          <div className="p-4 border-t border-border bg-bg-subtle/30">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
              <span className="text-sm font-medium font-mono">{editingPub.publicName}</span>
              <input
                type="number" step="0.01" min="0" placeholder="Official $/1M input"
                value={editingPub.pricing.input}
                onChange={(e) => setEditingPub((s) => ({ ...s, pricing: { ...s.pricing, input: e.target.value } }))}
                className="w-36 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
              />
              <input
                type="number" step="0.01" min="0" placeholder="Official $/1M output"
                value={editingPub.pricing.output}
                onChange={(e) => setEditingPub((s) => ({ ...s, pricing: { ...s.pricing, output: e.target.value } }))}
                className="w-36 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
              />
              <input
                type="number" step="1" min="0" max="100" placeholder="Cached % of input (opt.)"
                value={editingPub.pricing.cachedPct}
                onChange={(e) => setEditingPub((s) => ({ ...s, pricing: { ...s.pricing, cachedPct: e.target.value } }))}
                className="w-36 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
              />
              <input
                type="number" step="0.05" min="0" max="0.95" placeholder="Discount 0–1 (blank = global)"
                value={editingPub.discountRate}
                onChange={(e) => setEditingPub((s) => ({ ...s, discountRate: e.target.value }))}
                className="w-44 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
              />
              <button
                onClick={() => savePublicModel(editingPub)}
                disabled={pubBusy}
                className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => setEditingPub(null)}
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-bg-subtle"
              >
                Cancel
              </button>
            </div>
            <p className="text-xs text-text-muted mt-2">
              Discount kosong → pakai diskon global. Harga & discount kosong → harga member (official × (1 − discount)).
            </p>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border bg-bg-subtle/50">
          <div>
            <h3 className="font-semibold">Customer Sell Pricing</h3>
            <p className="text-xs text-text-muted">
              What customers are billed: official price × (1 − discount). Edit official rates via{" "}
              <a href="/dashboard/settings/pricing" className="text-primary hover:underline">Model Pricing</a>.
            </p>
          </div>
          <button
            onClick={() => setPricingOpen((v) => !v)}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg-subtle"
          >
            {pricingOpen ? "Hide" : "Show"}
          </button>
        </div>
        {pricingOpen && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
                <tr>
                  <th className="px-6 py-3">Model</th>
                  <th className="px-6 py-3 text-right">Official $/1M</th>
                  <th className="px-6 py-3 text-right">Customer $/1M (−{Math.round((1 - sellFactor) * 100)}%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!pricing || Object.keys(pricing).length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-8 text-center text-text-muted">
                      No pricing data.
                    </td>
                  </tr>
                ) : (
                  Object.entries(pricing).flatMap(([provider, models]) =>
                    Object.entries(models || {}).filter(([, p]) => p && typeof p === "object").map(([model, p]) => (
                      <tr key={`${provider}/${model}`} className="hover:bg-bg-subtle/20 transition-colors">
                        <td className="px-6 py-2.5">
                          <div className="font-medium">{model}</div>
                          <div className="text-xs text-text-muted">{provider}</div>
                        </td>
                        <td className="px-6 py-2.5 text-right font-mono text-xs text-text-muted">
                          in {fmtRate(p.input)} · out {fmtRate(p.output)} · cached {fmtRate(p.cached ?? p.input)}
                        </td>
                        <td className="px-6 py-2.5 text-right font-mono text-xs">
                          in {fmtRate((p.input ?? 0) * sellFactor)} · out {fmtRate((p.output ?? 0) * sellFactor)} · cached {fmtRate((p.cached ?? p.input ?? 0) * sellFactor)}
                        </td>
                      </tr>
                    ))
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Paid topup history — revenue view, pending/failed excluded */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border bg-bg-subtle/50">
          <h3 className="font-semibold">Top-up History (paid)</h3>
          <button onClick={loadHistories} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg-subtle">Refresh</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
              <tr>
                <th className="px-6 py-3">Time</th>
                <th className="px-6 py-3">Customer</th>
                <th className="px-6 py-3 text-right">Amount (IDR)</th>
                <th className="px-6 py-3 text-right">Credited</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!topupHistory ? (
                <tr><td colSpan={4} className="px-6 py-6 text-center text-text-muted">Loading…</td></tr>
              ) : topupHistory.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-6 text-center text-text-muted">No paid top-ups yet.</td></tr>
              ) : topupHistory.map((t) => (
                <tr key={t.topupId} className="hover:bg-bg-subtle/20">
                  <td className="px-6 py-3 text-text-muted whitespace-nowrap">{t.paidAt ? new Date(t.paidAt).toLocaleString() : "—"}</td>
                  <td className="px-6 py-3">{t.customerLabel || t.customerId}</td>
                  <td className="px-6 py-3 text-right tabular-nums">{Number(t.amountIdr).toLocaleString("id-ID")}</td>
                  <td className="px-6 py-3 text-right tabular-nums">{t.creditedMicros == null ? "—" : fmtMoney(t.creditedMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Package holders — every customer instance across statuses */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border bg-bg-subtle/50">
          <h3 className="font-semibold">Package Holders</h3>
          <button onClick={loadHistories} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-bg-subtle">Refresh</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
              <tr>
                <th className="px-6 py-3">Customer</th>
                <th className="px-6 py-3">Package</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3 text-right">Used / Granted</th>
                <th className="px-6 py-3 text-right">Remaining</th>
                <th className="px-6 py-3">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!pkgHolders ? (
                <tr><td colSpan={6} className="px-6 py-6 text-center text-text-muted">Loading…</td></tr>
              ) : pkgHolders.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-6 text-center text-text-muted">No package instances yet.</td></tr>
              ) : pkgHolders.map((i) => {
                const pct = i.tokensGranted > 0 ? Math.round((i.tokensRemaining / i.tokensGranted) * 100) : 0;
                return (
                  <tr key={i.id} className="hover:bg-bg-subtle/20">
                    <td className="px-6 py-3">
                      <div>{i.customerLabel || i.customerId}</div>
                      {i.customerLabel && i.customerEmail && i.customerLabel !== i.customerEmail && (
                        <div className="text-[11px] text-text-muted">{i.customerEmail}</div>
                      )}
                    </td>
                    <td className="px-6 py-3">{i.packageName || i.packageId}</td>
                    <td className="px-6 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        i.status === "active" ? "bg-green-500/10 text-green-600"
                        : i.status === "pending" ? "bg-yellow-500/10 text-yellow-600"
                        : "bg-bg-subtle text-text-muted"}`}>
                        {i.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums">{i.tokensUsed.toLocaleString()} / {i.tokensGranted.toLocaleString()}</td>
                    <td className="px-6 py-3 text-right tabular-nums">{i.tokensRemaining.toLocaleString()} ({pct}%)</td>
                    <td className="px-6 py-3 text-text-muted whitespace-nowrap">{i.expiresAt ? new Date(i.expiresAt).toLocaleDateString() : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

      {/* Package assign modal */}
      <Modal
        isOpen={!!assignModal}
        onClose={() => setAssignModal(null)}
        title={`Assign Package — ${assignModal?.packageName || ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAssignModal(null)}>Cancel</Button>
            <Button
              onClick={submitAssign}
              disabled={assignBusy || !assignModal?.customerId}
            >
              Assign
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Customer</span>
            <select
              value={assignModal?.customerId || ""}
              onChange={(e) => setAssignModal((s) => ({ ...s, customerId: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2"
            >
              <option value="">Select customer…</option>
              {(customers || []).filter((c) => c.status === "active").map((c) => (
                <option key={c.id} value={c.id}>{c.name || c.email || c.id}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-text-muted">
            The instance activates immediately with the catalog&apos;s token grant and duration.
          </p>
        </div>
      </Modal>

      {/* Package model edit modal */}
      <Modal
        isOpen={!!editingPkg}
        onClose={() => setEditingPkg(null)}
        title="Edit Package Model"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingPkg(null)}>Cancel</Button>
            <Button onClick={savePkgModel} disabled={pkgBusy}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Public model name</span>
            <input
              type="text"
              placeholder='Public model name (e.g. glm-5.3-flash) — empty = all models'
              value={editingPkg?.model || ""}
              onChange={(e) => setEditingPkg((s) => ({ ...s, model: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Combo</span>
            <select
              value={editingPkg?.comboId || ""}
              onChange={(e) => setEditingPkg((s) => ({ ...s, comboId: e.target.value }))}
              className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm"
            >
              <option value="">Select combo…</option>
              {comboOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-text-muted">
            Billing scope follows the model name here; already-sold instances keep running on their own grant.
          </p>
        </div>
      </Modal>
    </div>
  );
}
