// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 5;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      // Token limit per key. 0 / NULL = unlimited.
      tokenLimit: "INTEGER DEFAULT 0",
      // Window the limit applies over: "total" | "daily" | "monthly".
      limitWindow: "TEXT DEFAULT 'monthly'",
      // Requests-per-minute limit for this key. 0 / NULL = unlimited.
      rpmLimit: "INTEGER DEFAULT 0",
      // Manual reset marker: usage before this timestamp is not counted toward the limit.
      limitResetAt: "TEXT",
      // JSON array of allowed model values for this key. NULL/empty = all allowed.
      allowedModels: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
      keyHash: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_keyhash_ts ON usageHistory(keyHash, timestamp DESC)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },

  // ── Customer billing (phase 1) ─────────────────────────────────────────
  // Money is integer micro-USD (µ$ = USD × 1e6). IDR is integer rupiah.
  // FX rate is integer milli-IDR-per-USD (rate × 1000).
  customers: {
    columns: {
      id: "TEXT PRIMARY KEY",
      googleSub: "TEXT UNIQUE NOT NULL",
      email: "TEXT",
      name: "TEXT",
      // "active" | "disabled"
      status: "TEXT NOT NULL DEFAULT 'active'",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_cust_email ON customers(email)"],
  },
  customerKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      customerId: "TEXT NOT NULL",
      // HMAC-SHA256(API_KEY_SECRET, plaintext). Plaintext never stored.
      keyHash: "TEXT UNIQUE NOT NULL",
      // Display form: "sk-cust-…last4". Never the plaintext.
      keyMask: "TEXT NOT NULL",
      // AES-256-GCM ciphertext of the plaintext key (iv:tag:hex), keyed off
      // JWT_SECRET — lets the customer re-reveal without regenerating.
      // NULL for keys created before this column existed.
      keyEnc: "TEXT",
      // RFC3339 timestamp when revoked; NULL = active.
      revokedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ck_customer ON customerKeys(customerId)",
      "CREATE INDEX IF NOT EXISTS idx_ck_active ON customerKeys(customerId, revokedAt)",
    ],
  },
  customerBalances: {
    columns: {
      customerId: "TEXT PRIMARY KEY",
      // Total owned µ$ (credits − debits). May go negative only via settle overdraft.
      balanceMicros: "INTEGER NOT NULL DEFAULT 0",
      // µ$ currently held by in-flight requests.
      reservedMicros: "INTEGER NOT NULL DEFAULT 0",
      updatedAt: "TEXT NOT NULL",
    },
  },
  ledger: {
    columns: {
      id: "TEXT PRIMARY KEY",
      customerId: "TEXT NOT NULL",
      // topup_credit | usage_debit | reserve_hold | reserve_release | adjustment
      type: "TEXT NOT NULL",
      // Signed effect on balanceMicros (reserves are 0 — they move reservedMicros only).
      amountMicros: "INTEGER NOT NULL",
      // Snapshot of balanceMicros after this entry (reserve rows: unchanged balance).
      balanceAfterMicros: "INTEGER NOT NULL",
      refType: "TEXT",
      refId: "TEXT",
      meta: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ref ON ledger(refType, refId, type)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger(customerId, createdAt)",
    ],
  },
  topups: {
    columns: {
      id: "TEXT PRIMARY KEY",
      customerId: "TEXT NOT NULL",
      // Tako transaction id; NULL until callback/paymentUrl known. UNIQUE = idempotency anchor.
      takoTxnId: "TEXT UNIQUE",
      amountIdr: "INTEGER NOT NULL",
      // FX rate snapshot at creation: milli-IDR per USD (rate × 1000).
      rateMilli: "INTEGER NOT NULL",
      creditedMicros: "INTEGER",
      // pending | paid | failed
      status: "TEXT NOT NULL DEFAULT 'pending'",
      paymentUrl: "TEXT",
      paidAt: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_topup_customer ON topups(customerId, createdAt)",
      "CREATE INDEX IF NOT EXISTS idx_topup_status ON topups(status)",
    ],
  },
  webhookEvents: {
    columns: {
      id: "TEXT PRIMARY KEY",
      // "tako" for now.
      source: "TEXT NOT NULL",
      // Provider transaction/event id. Duplicate delivery → INSERT ignored.
      externalId: "TEXT NOT NULL",
      payload: "TEXT NOT NULL",
      // unprocessed | processed | failed
      status: "TEXT NOT NULL DEFAULT 'unprocessed'",
      processError: "TEXT",
      processedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_we_source_ext ON webhookEvents(source, externalId)",
      "CREATE INDEX IF NOT EXISTS idx_we_status ON webhookEvents(status)",
    ],
  },
  pricingVersions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      modelId: "TEXT NOT NULL",
      // Official per-1M-token prices in µ$.
      officialInputMicros: "INTEGER NOT NULL",
      officialOutputMicros: "INTEGER NOT NULL",
      // Discount in basis points (5000 = 50%).
      discountBps: "INTEGER NOT NULL DEFAULT 5000",
      // Derived: round(official × (10000 − discountBps) / 10000).
      sellInputMicros: "INTEGER NOT NULL",
      sellOutputMicros: "INTEGER NOT NULL",
      // ISO date from which this version is active.
      effectiveFrom: "TEXT NOT NULL",
      source: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pv_model ON pricingVersions(modelId, effectiveFrom)",
    ],
  },
  publicModels: {
    columns: {
      id: "TEXT PRIMARY KEY",
      publicName: "TEXT UNIQUE NOT NULL",
      comboId: "TEXT NOT NULL",
      enabled: "INTEGER NOT NULL DEFAULT 1",
      discountRate: "REAL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
  },
  tokenPackages: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      // Token quota granted on activation.
      tokens: "INTEGER NOT NULL",
      // IDR price for QRIS purchase; 0 = assign-only (admin grants free).
      priceIdr: "INTEGER NOT NULL DEFAULT 0",
      // JSON array of public model names this package covers; ["*"] = all.
      models: "TEXT NOT NULL DEFAULT '[\"*\"]'",
      // Variant group: variants of one package (same name, different tokens/
      // price/duration) share a group label; NULL = standalone package.
      group: "TEXT",
      // Combo the package's public model resolves through (display/bookkeeping
      // only — billing scope is the public model name itself).
      comboId: "TEXT",
      // Days of validity counted from activation; 0 = no expiry.
      durationDays: "INTEGER NOT NULL DEFAULT 0",
      // Catalog flag: inactive packages cannot be newly purchased/assigned;
      // already-active customer instances keep running.
      active: "INTEGER NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
  },
  customerPackages: {
    columns: {
      id: "TEXT PRIMARY KEY",
      customerId: "TEXT NOT NULL",
      packageId: "TEXT NOT NULL",
      // Topup row that paid for this instance (QRIS purchases); NULL for
      // admin-assigned. Unique → one pending instance per topup.
      topupId: "TEXT UNIQUE",
      // Snapshot of catalog tokens, written at activation.
      tokensGranted: "INTEGER NOT NULL DEFAULT 0",
      tokensUsed: "INTEGER NOT NULL DEFAULT 0",
      // pending | active | expired | revoked
      status: "TEXT NOT NULL DEFAULT 'pending'",
      activatedAt: "TEXT",
      // activatedAt + durationDays; NULL = no expiry.
      expiresAt: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_cp_customer ON customerPackages(customerId, status)",
      "CREATE INDEX IF NOT EXISTS idx_cp_package ON customerPackages(packageId)",
      "CREATE INDEX IF NOT EXISTS idx_cp_topup ON customerPackages(topupId)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  // Quote column names — "group" is a SQLite reserved keyword and any future
  // reserved-word column would otherwise produce a syntax error at CREATE time.
  const cols = Object.entries(def.columns).map(([k, v]) => `"${k}" ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
