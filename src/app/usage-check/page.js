"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input } from "@/shared/components";

function fmt(n) {
  return (Number(n) || 0).toLocaleString();
}

const WINDOW_LABEL = {
  total: "Total (lifetime)",
  daily: "Daily",
  monthly: "Monthly",
};

const PERIODS = [
  { value: "", label: "As configured" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

const SORTS = [
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
  { value: "name", label: "Name" },
];

export default function UsageCheckPage() {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [lastName, setLastName] = useState("");

  // Filters
  const [period, setPeriod] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [sortBy, setSortBy] = useState("tokens");

  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("token") || "";
      setToken(t);
    } catch {}
  }, []);

  const runLookup = async (q, p) => {
    if (!q) return;
    setLoading(true);
    setError("");
    try {
      const url = `/api/public/key-usage?name=${encodeURIComponent(q)}&token=${encodeURIComponent(token)}${p ? `&period=${p}` : ""}`;
      const res = await fetch(url);
      const json = await res.json();
      if (res.ok) {
        setData(json);
        setLastName(q);
      } else {
        setError(json.error || "Lookup failed");
        setData(null);
      }
    } catch {
      setError("An error occurred. Please try again.");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e) => {
    e?.preventDefault();
    const q = name.trim();
    if (!q) return;
    runLookup(q, period);
  };

  // Refetch when period changes after an initial search.
  const onPeriodChange = (p) => {
    setPeriod(p);
    if (lastName) runLookup(lastName, p);
  };

  const sortModels = (models) => {
    const filtered = (models || []).filter((m) => {
      const q = modelFilter.toLowerCase();
      return !q || m.model.toLowerCase().includes(q) || (m.provider || "").toLowerCase().includes(q);
    });
    const sorted = [...filtered];
    if (sortBy === "tokens") sorted.sort((a, b) => b.totalTokens - a.totalTokens);
    else if (sortBy === "requests") sorted.sort((a, b) => b.requests - a.requests);
    else sorted.sort((a, b) => a.model.localeCompare(b.model));
    return sorted;
  };

  return (
    <div className="min-h-screen flex items-start justify-center bg-bg p-4 relative overflow-hidden">
      <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-2xl mt-12">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary mb-2">Token Usage</h1>
          <p className="text-text-muted">Enter an API key name to see its token usage.</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input
                placeholder="e.g. yudha"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="flex-1"
              />
              <Button type="submit" variant="primary" loading={loading} disabled={!name.trim()}>
                Check
              </Button>
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </form>
        </Card>

        {data && (
          <>
            {/* Filter bar */}
            {data.count > 0 && (
              <div className="mt-5 flex flex-col sm:flex-row sm:items-end gap-3">
                <div className="flex flex-col gap-1.5 flex-1">
                  <label className="text-xs font-medium text-text-muted">Period</label>
                  <div className="flex flex-wrap gap-1.5">
                    {PERIODS.map((p) => (
                      <button
                        key={p.value}
                        onClick={() => onPeriodChange(p.value)}
                        className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                          period === p.value
                            ? "bg-brand-500 text-white border-brand-500"
                            : "border-border text-text-muted hover:text-text-main"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {data.count > 0 && (
              <div className="mt-3 flex flex-col sm:flex-row gap-3">
                <Input
                  placeholder="Filter models..."
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  icon="filter_list"
                  className="flex-1"
                />
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-text-muted">Sort:</span>
                  {SORTS.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setSortBy(s.value)}
                      className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                        sortBy === s.value
                          ? "bg-surface-2 text-text-main border-border"
                          : "border-transparent text-text-muted hover:text-text-main"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex flex-col gap-3">
              {data.count === 0 ? (
                <Card>
                  <p className="text-sm text-text-muted text-center">
                    No API key found with the name &quot;{data.name}&quot;.
                  </p>
                </Card>
              ) : (
                data.results.map((r, i) => {
                  const models = sortModels(r.models);
                  const breakdownTotal = period && period !== "" ? r.usedPeriod : r.usedWindow;
                  const rangeLabel = r.period
                    ? PERIODS.find((p) => p.value === r.period)?.label || r.period
                    : WINDOW_LABEL[r.limitWindow] || r.limitWindow;
                  return (
                    <Card key={i}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{r.name}</span>
                          {!r.isActive && (
                            <span className="text-xs text-orange-500 border border-orange-500/40 rounded px-1.5 py-0.5">
                              Paused
                            </span>
                          )}
                        </div>
                        {r.tokenLimit > 0 && r.exceeded && (
                          <span className="text-xs text-red-500 font-medium">Limit reached</span>
                        )}
                      </div>

                      {/* Summary stats */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                        <Stat label={`Used (${rangeLabel})`} value={fmt(breakdownTotal)} />
                        <Stat
                          label="Limit"
                          value={r.tokenLimit > 0 ? fmt(r.tokenLimit) : "—"}
                          danger={r.tokenLimit > 0 && r.exceeded}
                        />
                        <Stat
                          label="Remaining"
                          value={r.tokenLimit > 0 ? fmt(r.remaining) : "—"}
                        />
                        <Stat label="All-time" value={fmt(r.usedTotal)} />
                      </div>

                      {r.tokenLimit > 0 && (
                        <div className="h-2 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden mb-4">
                          <div
                            className={`h-full rounded-full ${r.exceeded ? "bg-red-500" : "bg-brand-500"}`}
                            style={{ width: `${Math.min(100, (r.usedWindow / r.tokenLimit) * 100)}%` }}
                          />
                        </div>
                      )}

                      {/* Per-model breakdown */}
                      <div className="border-t border-black/[0.06] dark:border-white/[0.06] pt-3">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-medium text-text-muted">
                            Models used ({rangeLabel})
                          </p>
                          <p className="text-xs text-text-muted">{models.length} model(s)</p>
                        </div>
                        {models.length === 0 ? (
                          <p className="text-xs text-text-muted py-2">
                            {modelFilter ? "No models match the filter." : "No usage recorded in this range."}
                          </p>
                        ) : (
                          <div className="max-h-80 overflow-y-auto rounded-lg border border-border-subtle">
                            <table className="w-full border-collapse text-xs">
                              <thead className="sticky top-0 bg-surface-2 z-10">
                                <tr className="border-b border-border-subtle text-text-muted">
                                  <th className="py-2 px-3 text-left font-semibold">Model</th>
                                  <th className="py-2 px-2 text-right font-semibold">In</th>
                                  <th className="py-2 px-2 text-right font-semibold">Out</th>
                                  <th className="py-2 px-2 text-right font-semibold">Total</th>
                                  <th className="py-2 px-2 text-right font-semibold">Req</th>
                                  <th className="py-2 px-3 text-right font-semibold w-24">Share</th>
                                </tr>
                              </thead>
                              <tbody>
                                {models.map((m, j) => {
                                  const pct = breakdownTotal > 0 ? (m.totalTokens / breakdownTotal) * 100 : 0;
                                  return (
                                    <tr
                                      key={j}
                                      className="border-b border-border-subtle/60 last:border-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    >
                                      <td className="py-2 px-3">
                                        <div className="font-medium truncate max-w-[200px]">{m.model}</div>
                                        {m.provider && (
                                          <div className="text-[11px] text-text-muted truncate">{m.provider}</div>
                                        )}
                                      </td>
                                      <td className="py-2 px-2 text-right text-text-muted tabular-nums">{fmt(m.promptTokens)}</td>
                                      <td className="py-2 px-2 text-right text-text-muted tabular-nums">{fmt(m.completionTokens)}</td>
                                      <td className="py-2 px-2 text-right font-medium tabular-nums">{fmt(m.totalTokens)}</td>
                                      <td className="py-2 px-2 text-right text-text-muted tabular-nums">{fmt(m.requests)}</td>
                                      <td className="py-2 px-3">
                                        <div className="flex items-center gap-1.5 justify-end">
                                          <div className="h-1.5 w-12 rounded-full bg-black/[0.06] dark:bg-white/[0.06] overflow-hidden">
                                            <div className="h-full rounded-full bg-brand-500/70" style={{ width: `${Math.min(100, pct)}%` }} />
                                          </div>
                                          <span className="text-[11px] text-text-muted tabular-nums w-9 text-right">
                                            {pct.toFixed(0)}%
                                          </span>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, danger }) {
  return (
    <div className="bg-surface-2 rounded-[10px] px-3 py-2">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={`text-sm font-semibold ${danger ? "text-red-500" : ""}`}>{value}</p>
    </div>
  );
}
