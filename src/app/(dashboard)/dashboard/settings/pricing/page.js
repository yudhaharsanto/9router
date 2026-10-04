"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Card from "@/shared/components/Card";
import PricingModal from "@/shared/components/PricingModal";

// Rates are USD per 1M tokens.
const fmtRate = (v) => `$${(Number(v) || 0).toFixed(2)}`;

export default function PricingSettingsPage() {
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [currentPricing, setCurrentPricing] = useState(null);
  const [loading, setLoading] = useState(true);
  // Canonical catalog (read-only) — the full billing basis behind the 2-provider edit view.
  const [defaults, setDefaults] = useState(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [pricingRes, defaultsRes] = await Promise.all([
          fetch("/api/pricing"),
          fetch("/api/pricing/defaults"),
        ]);
        if (pricingRes.ok && !cancelled) setCurrentPricing(await pricingRes.json());
        if (defaultsRes.ok && !cancelled) setDefaults(await defaultsRes.json());
      } catch (error) {
        console.error("Failed to load pricing:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePricingUpdated = () => {
    loadPricing();
  };

  // Count total models with pricing
  const getModelCount = () => {
    if (!currentPricing) return 0;
    let count = 0;
    for (const provider in currentPricing) {
      count += Object.keys(currentPricing[provider]).length;
    }
    return count;
  };

  // Get providers list
  const getProviders = () => {
    if (!currentPricing) return [];
    return Object.keys(currentPricing).sort();
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Pricing Settings</h1>
          <p className="text-text-muted mt-1">
            Configure pricing rates for cost tracking and calculations
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors"
        >
          Edit Pricing
        </button>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Total Models
          </div>
          <div className="text-2xl font-bold mt-1">
            {loading ? "..." : getModelCount()}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Providers
          </div>
          <div className="text-2xl font-bold mt-1">
            {loading ? "..." : getProviders().length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Status
          </div>
          <div className="text-2xl font-bold mt-1 text-success">
            {loading ? "..." : "Active"}
          </div>
        </Card>
      </div>

      {/* Info Section */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">How Pricing Works</h2>
        <div className="space-y-3 text-sm text-text-muted">
          <p>
            <strong>Cost Calculation:</strong> Costs are calculated based on token usage and pricing rates.
            Each request&apos;s cost is determined by: (input_tokens × input_rate) + (output_tokens × output_rate) + (cached_tokens × cached_rate)
          </p>
          <p>
            <strong>Pricing Format:</strong> All rates are in <strong>dollars per million tokens</strong> ($/1M tokens).
            Example: An input rate of 2.50 means $2.50 per 1,000,000 input tokens.
          </p>
          <p>
            <strong>Token Types:</strong>
          </p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li><strong>Input:</strong> Standard prompt tokens</li>
            <li><strong>Output:</strong> Completion/response tokens</li>
            <li><strong>Cached:</strong> Cached input tokens (typically 50% of input rate)</li>
            <li><strong>Reasoning:</strong> Special reasoning/thinking tokens (fallback to output rate)</li>
            <li><strong>Cache Creation:</strong> Tokens used to create cache entries (fallback to input rate)</li>
          </ul>
          <p>
            <strong>Custom Pricing:</strong> You can override default pricing for specific models.
            Reset to defaults anytime to restore standard rates.
          </p>
        </div>
      </Card>

      {/* Canonical Catalog (read-only) — full billing basis */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold">Official Price Catalog</h2>
            <p className="text-sm text-text-muted mt-1">
              Canonical rates used for cost tracking and customer billing. Read-only — provider overrides below adjust specific rates.
            </p>
          </div>
          <button
            onClick={() => setDefaultsOpen((v) => !v)}
            className="text-primary hover:underline text-sm"
          >
            {defaultsOpen ? "Hide" : "Show Catalog"}
          </button>
        </div>

        {loading ? (
          <div className="text-center py-4 text-text-muted">Loading pricing data...</div>
        ) : defaults ? (
          <>
            <div className="text-sm text-text-muted mb-3">
              {Object.keys(defaults.canonical || {}).length} canonical models ·{" "}
              {Object.keys(defaults.provider || {}).length} provider overrides ·{" "}
              {(defaults.patterns || []).length} pattern rules
            </div>
            {defaultsOpen && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
                    <tr>
                      <th className="px-4 py-2">Model</th>
                      <th className="px-4 py-2 text-right">Input</th>
                      <th className="px-4 py-2 text-right">Output</th>
                      <th className="px-4 py-2 text-right">Cached</th>
                      <th className="px-4 py-2 text-right">Reasoning</th>
                      <th className="px-4 py-2 text-right">Cache Creation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {Object.entries(defaults.canonical || {}).map(([model, p]) => (
                      <tr key={model} className="hover:bg-bg-subtle/20 transition-colors">
                        <td className="px-4 py-2 font-mono text-xs">{model}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(p.input)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(p.output)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(p.cached)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(p.reasoning)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(p.cache_creation)}</td>
                      </tr>
                    ))}
                    {(defaults.patterns || []).map(({ pattern, pricing }) => (
                      <tr key={`pattern:${pattern}`} className="hover:bg-bg-subtle/20 transition-colors">
                        <td className="px-4 py-2 font-mono text-xs">{pattern} <span className="text-text-muted">(pattern)</span></td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(pricing.input)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(pricing.output)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(pricing.cached)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(pricing.reasoning)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{fmtRate(pricing.cache_creation)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="text-text-muted">No pricing data available</div>
        )}
      </Card>

      {/* Provider-specific overrides (editable via modal) */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold">Provider Overrides</h2>
            <p className="text-sm text-text-muted mt-1">
              Rates that differ from the canonical catalog, per provider. Edit via Pricing Configuration.
            </p>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="text-primary hover:underline text-sm"
          >
            Edit
          </button>
        </div>

        {loading ? (
          <div className="text-center py-4 text-text-muted">Loading pricing data...</div>
        ) : currentPricing ? (
          <div className="space-y-3">
            {Object.keys(currentPricing).map(provider => (
              <div key={provider} className="text-sm">
                <span className="font-semibold">{provider.toUpperCase()}:</span>{" "}
                <span className="text-text-muted">
                  {Object.keys(currentPricing[provider]).length} models
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-text-muted">No pricing data available</div>
        )}
      </Card>

      {/* Pricing Modal */}
      {showModal && (
        <PricingModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onSave={handlePricingUpdated}
        />
      )}
    </div>
  );
}