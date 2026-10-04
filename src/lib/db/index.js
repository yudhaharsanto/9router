// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  getApiKeyUsedTokens, getApiKeyLimitStatus, resetApiKeyLimit, getUsageByKeyName, getApiKeyAllowedModels, getApiKeyRpmLimit,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
  getPublicPricing, updatePublicPricing, deletePublicPricing,
} from "./repos/pricingRepo.js";

// Customer billing (phase 1)
export {
  getOrCreateCustomer, getCustomerById, setCustomerStatus,
} from "./repos/customersRepo.js";
export {
  createCustomerKey, validateCustomerKey, revokeCustomerKey, getActiveKeyForCustomer,
} from "./repos/customerKeysRepo.js";
export {
  getBalance, creditCustomer, holdReserve, settleUsage, adjustBalance, getLedger, MICROS_PER_USD,
} from "./repos/ledgerRepo.js";
export {
  createTopup, setTopupPayment, getTopupById, getTopupByTakoTxnId,
  listTopups, markTopupPaid, applyTopupCredit, computeCreditedMicros,
} from "./repos/topupsRepo.js";
export {
  recordWebhookEvent, markWebhookProcessed, getUnprocessedWebhookEvents,
} from "./repos/webhookEventsRepo.js";
export {
  upsertPricingVersion, getActivePricing, listPricingVersions, computeChargeMicros,
} from "./repos/pricingVersionsRepo.js";
export {
  upsertPublicModel, getPublicModelByName, listPublicModels, deletePublicModel,
} from "./repos/publicModelsRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  getApiKeyDailyChart,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
    customers: db.all(`SELECT * FROM customers`),
    customerKeys: db.all(`SELECT * FROM customerKeys`),
    customerBalances: db.all(`SELECT * FROM customerBalances`),
    ledger: db.all(`SELECT * FROM ledger`),
    topups: db.all(`SELECT * FROM topups`),
    webhookEvents: db.all(`SELECT * FROM webhookEvents`),
    pricingVersions: db.all(`SELECT * FROM pricingVersions`),
    publicModels: db.all(`SELECT * FROM publicModels`),
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);
    db.run(`DELETE FROM customers`);
    db.run(`DELETE FROM customerKeys`);
    db.run(`DELETE FROM customerBalances`);
    db.run(`DELETE FROM ledger`);
    db.run(`DELETE FROM topups`);
    db.run(`DELETE FROM webhookEvents`);
    db.run(`DELETE FROM pricingVersions`);
    db.run(`DELETE FROM publicModels`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const c of payload.customers || []) {
      db.run(
        `INSERT OR REPLACE INTO customers(id, googleSub, email, name, status, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.googleSub, c.email || null, c.name || null, c.status || "active", c.createdAt, c.updatedAt || c.createdAt]
      );
    }
    for (const k of payload.customerKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO customerKeys(id, customerId, keyHash, keyMask, revokedAt, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [k.id, k.customerId, k.keyHash, k.keyMask, k.revokedAt || null, k.createdAt]
      );
    }
    for (const b of payload.customerBalances || []) {
      db.run(
        `INSERT OR REPLACE INTO customerBalances(customerId, balanceMicros, reservedMicros, updatedAt) VALUES(?, ?, ?, ?)`,
        [b.customerId, b.balanceMicros || 0, b.reservedMicros || 0, b.updatedAt || new Date().toISOString()]
      );
    }
    for (const l of payload.ledger || []) {
      db.run(
        `INSERT OR REPLACE INTO ledger(id, customerId, type, amountMicros, balanceAfterMicros, refType, refId, meta, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [l.id, l.customerId, l.type, l.amountMicros, l.balanceAfterMicros, l.refType || null, l.refId || null, l.meta || null, l.createdAt]
      );
    }
    for (const t of payload.topups || []) {
      db.run(
        `INSERT OR REPLACE INTO topups(id, customerId, takoTxnId, amountIdr, rateMilli, creditedMicros, status, paymentUrl, paidAt, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.id, t.customerId, t.takoTxnId || null, t.amountIdr, t.rateMilli, t.creditedMicros == null ? null : t.creditedMicros, t.status || "pending", t.paymentUrl || null, t.paidAt || null, t.createdAt, t.updatedAt || t.createdAt]
      );
    }
    for (const w of payload.webhookEvents || []) {
      db.run(
        `INSERT OR REPLACE INTO webhookEvents(id, source, externalId, payload, status, processError, processedAt, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [w.id, w.source, w.externalId, w.payload, w.status || "unprocessed", w.processError || null, w.processedAt || null, w.createdAt]
      );
    }
    for (const p of payload.pricingVersions || []) {
      db.run(
        `INSERT OR REPLACE INTO pricingVersions(id, modelId, officialInputMicros, officialOutputMicros, discountBps, sellInputMicros, sellOutputMicros, effectiveFrom, source, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.modelId, p.officialInputMicros, p.officialOutputMicros, p.discountBps, p.sellInputMicros, p.sellOutputMicros, p.effectiveFrom, p.source || null, p.createdAt]
      );
    }
    for (const m of payload.publicModels || []) {
      db.run(
        `INSERT OR REPLACE INTO publicModels(id, publicName, comboId, enabled, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [m.id, m.publicName, m.comboId, m.enabled === false ? 0 : 1, m.createdAt, m.updatedAt || m.createdAt]
      );
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
