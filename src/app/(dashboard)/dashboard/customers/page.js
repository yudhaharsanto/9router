"use client";

import { useEffect, useState } from "react";
import { CardSkeleton } from "@/shared/components/Loading";

// Money is stored as integer micro-USD (µ$) — same convention as the portal.
function fmtMoney(micros) {
  const v = (Number(micros) || 0) / 1_000_000;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `${sign}$${abs.toFixed(digits)}`;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/customers", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setCustomers(body.customers || []);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/customers", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setCustomers(body.customers || []);
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setStatus = async (id, status) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return <div className="p-6 text-sm text-red-500">Failed to load customers: {error}</div>;
  }
  if (!customers) {
    return <CardSkeleton />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 px-1 sm:px-0">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Customers</h1>
        <button
          onClick={load}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Balance</th>
              <th className="px-3 py-2 font-medium text-right">Reserved</th>
              <th className="px-3 py-2 font-medium text-right">Total Top-up</th>
              <th className="px-3 py-2 font-medium">API Key</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No customers yet.
                </td>
              </tr>
            )}
            {customers.map((c) => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{c.name || "—"}</div>
                  <div className="text-xs text-muted-foreground">{c.email || c.id}</div>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      c.status === "active"
                        ? "rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-600"
                        : "rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-600"
                    }
                  >
                    {c.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtMoney(c.balanceMicros)}</td>
                <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                  {fmtMoney(c.reservedMicros)}
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtMoney(c.totalTopupMicros)}</td>
                <td className="px-3 py-2 font-mono text-xs">{c.keyMask || "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—"}
                </td>
                <td className="px-3 py-2">
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
    </div>
  );
}
