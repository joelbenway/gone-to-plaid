<!--
  Copyright (c) Joel Benway
  SPDX-License-Identifier: MIT
-->

# Technical Specification: `gone-to-plaid-sync`

`gone-to-plaid-sync` is a lightweight, self-hosted synchronization daemon and management interface designed to bridge Plaid's developer tier with a self-hosted Actual Budget instance. It is specifically engineered to operate permanently within Plaid's complimentary Trial tier while preventing accidental consumption of non-refundable connection quotas.

---

## 1. Architectural Strategy & System Flow

### Deployment Model: Standalone Sidecar with "Plugin-Ready" Core
Following architectural evaluation of Actual Budget's current state:
* Actual Budget's official plugin system is still in active RFC/PR review (e.g. PR stack #8546) and not yet merged into stable releases.
* Merging native Plaid directly into upstream Actual core has historically faced liability and Bring-Your-Own-Key (BYOK) UX hurdles.
* **Architecture:** `gone-to-plaid-sync` is deployed as a decoupled **sidecar daemon** running alongside Actual Budget. The codebase is strictly partitioned into:
  * `src/core/`: Headless sync engine, Plaid adapter, Actual Budget bridge, and quota defense engine.
  * `src/server/` & `src/ui/`: Lightweight HTTP daemon, SQLite state, webhook listener, and setup dashboard.
* **Upstream Compatibility:** When Actual Budget's plugin infrastructure stabilizes upstream, `src/core/` can be wrapped into an official `@actual-app/bank-sync-plaid` plugin with minimal refactoring.

```
+-----------------------------------------------------------------------------------+
| gone-to-plaid-sync Daemon                                                         |
|                                                                                   |
|  +--------------------+        +---------------------+      +------------------+  |
|  | Web Admin UI       | <----> | Fastify/HTTP Server | <--> | SQLite Store     |  |
|  | (Quota Meter,      |        | - Link Handshake    |      | - Items & Tokens |  |
|  |  Topology Mapping, |        | - Sync Endpoints    |      | - Account Maps   |  |
|  |  Repair Flow)      |        | - Webhook Receiver  |      | - Cursors & TxID |  |
|  +--------------------+        +----------+----------+      +------------------+  |
|                                           |                                       |
|                                +----------v----------+                            |
|                                | Sync Engine (Core)  |                            |
|                                | - Delta Fetcher     |                            |
|                                | - Sign & Cent Scale |                            |
|                                | - Pending Resolver  |                            |
|                                +----+-----------+----+                            |
+-------------------------------------|-----------|---------------------------------+
                                      |           |
                              Plaid API           Actual Budget Server / API
                    (/transactions/sync)          (@actual-app/api)
```

### Ingestion and Synchronization Flow

* **Step 1: Credential Initialization:** The user configures Plaid client credentials (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`) and connects to the self-hosted Actual server using `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD` (or server token), `ACTUAL_SYNC_ID`, and optional `ACTUAL_ENCRYPTION_PASSWORD` for end-to-end encrypted budgets.
* **Step 2: Enrollment & Link Handshake:** The browser requests a `link_token` from the local backend, initializes Plaid Link in the client browser, and exchanges the resulting `public_token` for a persistent `access_token`.
* **Step 3: Account Topology Mapping:** The backend queries Plaid for available accounts and Actual for target budget accounts, storing 1:1 relational mappings in a local SQLite database.
* **Step 4: Scheduled Incremental Delta & Webhook Ingestion:** Every N hours (via internal timer or systemd timer) or immediately upon receiving a Plaid `SYNC_UPDATES_AVAILABLE` webhook at `/api/plaid/webhook`, the engine queries Plaid’s `/transactions/sync` endpoint using the last committed pagination cursor.
* **Step 5: Ledger Ingestion & Pending Lifecycle Resolution:**
  * **Additions/Modifications:** The engine normalizes amounts, cleans payees, and pushes transaction deltas to Actual via `@actual-app/api` using stable Plaid IDs as `imported_id`. It stores the mapping of `plaid_tx_id -> actual_tx_id` in SQLite.
  * **Removals (Settled / Dropped Pending Transactions):** When Plaid emits a removal for a pending authorization that has settled or dropped, the engine resolves the internal `actual_tx_id` and invokes `api.deleteTransaction(actual_tx_id)` to eliminate ghost transactions.
* **Step 6: Idempotent State Commit:** Only after Actual confirms successful import does the daemon write the new transaction cursor and balance states to the local database.

---

## 2. Plaid Free Trial Defense Engine

Plaid's free Trial tier provides production banking access with zero monthly platform fees, but it enforces an absolute ceiling of **10 lifetime Production Items**. Plaid's billing engine treats this quota as an irreversible counter: calling `/item/remove` unlinks an institution but **does not decrement** the usage counter.

To ensure the sync service never exhausts this limit through configuration mistakes or connection drops, `gone-to-plaid-sync` implements strict defense mechanisms.

| Failure Mode | Standard Behavior (Slot Loss) | `gone-to-plaid-sync` Safeguard |
| :--- | :--- | :--- |
| **Credential Expiry / MFA Prompts** | User re-authenticates via standard Link flow, creating a duplicate Item and burning another slot. | Launches Plaid Link strictly in **Update Mode** by passing the existing `access_token` to `/link/token/create`. Refreshes credentials in place with zero slot usage. |
| **Accidental Item Deletion** | Developer deletes an Item to "reset" it, permanently burning that allocation slot. | The UI hard-blocks destructive deletion without a typed administrative confirmation warning of irreversible quota consumption. |
| **Development & Script Testing** | Running integration tests against live banking credentials consumes production slots. | Environment toggle (`PLAID_ENV=sandbox`) forces mock institution credentials (`user_good` / `pass_good`) with unlimited slots. |
| **Duplicate Institution Link** | User links an institution that is already connected, consuming a second slot for the same bank. | Pre-flight validation checks incoming `institution_id` against active local items and rejects duplicates prior to token exchange. |
| **Quota Blindness** | Unmonitored connections approach the 10-Item limit without warning. | The UI and CLI prominently display a real-time `N / 10` lifetime allocation meter and lock out the Link button at 10 items. |

---

## 3. Synchronization Engine & Data Transformation

Actual Budget uses integer cents for currency representation and reverses standard banking sign conventions. The transformation pipeline ensures exact accounting parity.

### Transformation Rules

1. **Amount Representation:**
   * Plaid reports debits/outflows (money spent) as positive floats (e.g., `12.50`) and credits/deposits as negative floats (e.g., `-1200.00`).
   * Actual Budget requires integer cents where outflows are negative and inflows are positive.
   * Transformation formula:
     $$\text{actual\_amount} = \operatorname{round}(-\text{plaid\_amount} \times 100)$$
2. **Transaction Identity & Deduplication:**
   * Map Plaid's `transaction_id` directly to Actual's `imported_id`.
   * When replaying syncs or encountering network timeouts, Actual matches against `imported_id` and cleanly skips already-imported records.
3. **Pending vs. Posted Lifecycle & Removal Resolution:**
   * Plaid emits pending authorizations with `pending: true`.
   * When settled, Plaid emits a removal of the pending ID in `removed` and an addition of the settled transaction ID in `added`.
   * Because Actual's `api.deleteTransaction()` requires Actual's internal UUID rather than the external `imported_id`, the engine maintains a local mapping in `plaid_transactions`.
   * When an item in `removed` matches an existing transaction, the engine queries the mapping, calls `api.deleteTransaction(actual_tx_id)`, and purges the pending record from the local table.
4. **Payee Hygiene:**
   * Primary: `merchant_name` (clean, enriched string).
   * Fallback: `name` (raw transaction description).

---

## 4. Database Schema (SQLite)

The service requires persistent local state to store tokens, mapping pairs, sync cursors, and pending transaction identity cross-references.

```sql
CREATE TABLE IF NOT EXISTS plaid_items (
    item_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    institution_id TEXT NOT NULL,
    institution_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'healthy', -- 'healthy', 'login_required', 'error'
    error_code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_mappings (
    plaid_account_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    actual_account_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    account_mask TEXT,
    account_type TEXT NOT NULL, -- 'depository', 'credit', 'loan', etc.
    sync_enabled INTEGER DEFAULT 1,
    FOREIGN KEY(item_id) REFERENCES plaid_items(item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plaid_transactions (
    plaid_tx_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    actual_account_id TEXT NOT NULL,
    actual_tx_id TEXT NOT NULL,
    is_pending INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(item_id) REFERENCES plaid_items(item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plaid_transactions_item ON plaid_transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_account_mappings_item ON account_mappings(item_id);

CREATE TABLE IF NOT EXISTS sync_state (
    item_id TEXT PRIMARY KEY,
    cursor TEXT,
    last_sync_time DATETIME,
    FOREIGN KEY(item_id) REFERENCES plaid_items(item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL, -- 'success', 'partial', 'error'
    added_count INTEGER DEFAULT 0,
    modified_count INTEGER DEFAULT 0,
    removed_count INTEGER DEFAULT 0,
    error_message TEXT
);
```

---

## 5. Core Implementation Details

### Link Token Generation (Standard vs. Update Mode)

```typescript
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  })
);

export async function createLinkToken(existingAccessToken?: string): Promise<string> {
  const isUpdateMode = Boolean(existingAccessToken);

  const requestConfig: any = {
    user: { client_user_id: 'actual-budget-owner' },
    client_name: 'gone-to-plaid-sync',
    country_codes: [CountryCode.Us, CountryCode.Ca],
    language: 'en',
  };

  if (isUpdateMode) {
    // In update mode, products and country_codes must not be passed
    requestConfig.access_token = existingAccessToken;
    delete requestConfig.country_codes;
  } else {
    requestConfig.products = [Products.Transactions];
    if (process.env.PLAID_REDIRECT_URI) {
      requestConfig.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }
  }

  const response = await plaidClient.linkTokenCreate(requestConfig);
  return response.data.link_token;
}
```

### Actual Budget Client Session Management (with E2EE)

```typescript
import * as actualApi from '@actual-app/api';

let actualInitialized = false;

export async function initActualConnection() {
  if (actualInitialized) return;

  await actualApi.init({
    dataDir: process.env.ACTUAL_DATA_DIR || '/tmp/actual-api-data',
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });

  await actualApi.downloadBudget(process.env.ACTUAL_SYNC_ID!, {
    password: process.env.ACTUAL_ENCRYPTION_PASSWORD || undefined,
  });

  actualInitialized = true;
}
```

### Transaction Sync Routine

```typescript
export async function syncPlaidItem(itemId: string, db: any) {
  const item = db.prepare('SELECT access_token FROM plaid_items WHERE item_id = ?').get(itemId);
  if (!item) throw new Error(`Plaid Item ${itemId} not found`);

  const state = db.prepare('SELECT cursor FROM sync_state WHERE item_id = ?').get(itemId);
  const mappings = db.prepare('SELECT * FROM account_mappings WHERE item_id = ? AND sync_enabled = 1').all(itemId);
  const mappingMap = new Map(mappings.map((m: any) => [m.plaid_account_id, m.actual_account_id]));

  let cursor = state?.cursor || undefined;
  let hasMore = true;
  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;

  await initActualConnection();

  while (hasMore) {
    const res = await plaidClient.transactionsSync({
      access_token: item.access_token,
      cursor: cursor,
      options: { include_personal_finance_category: false }
    });

    const { added, modified, removed, next_cursor, has_more } = res.data;

    // 1. Group additions and modifications by Actual account
    const toImport: Record<string, any[]> = {};
    const plaidTxRecords: { plaid_tx_id: string; actual_account_id: string; is_pending: number }[] = [];

    for (const tx of [...added, ...modified]) {
      const actualAccountId = mappingMap.get(tx.account_id);
      if (!actualAccountId) continue;

      if (!toImport[actualAccountId]) toImport[actualAccountId] = [];

      toImport[actualAccountId].push({
        account: actualAccountId,
        date: tx.date,
        amount: Math.round(-tx.amount * 100), // Invert sign and convert to cents
        payee_name: tx.merchant_name || tx.name,
        imported_id: tx.transaction_id,
        cleared: !tx.pending,
      });

      plaidTxRecords.push({
        plaid_tx_id: tx.transaction_id,
        actual_account_id: actualAccountId,
        is_pending: tx.pending ? 1 : 0,
      });
    }

    // 2. Import into Actual Budget
    for (const [actualAccId, txList] of Object.entries(toImport)) {
      if (txList.length > 0) {
        const importedIds = await actualApi.importTransactions(actualAccId, txList);
        // Map Plaid tx IDs to Actual's internal IDs
        const insertTx = db.prepare(`
          INSERT INTO plaid_transactions (plaid_tx_id, item_id, actual_account_id, actual_tx_id, is_pending)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(plaid_tx_id) DO UPDATE SET is_pending = excluded.is_pending
        `);
        for (let i = 0; i < txList.length; i++) {
          const actualId = importedIds?.[i] || txList[i].imported_id;
          const rec = plaidTxRecords[i];
          insertTx.run(rec.plaid_tx_id, itemId, actualAccId, actualId, rec.is_pending);
        }
      }
    }

    // 3. Process Removals (e.g. pending authorization dropped or settled)
    for (const rm of removed) {
      if (rm.transaction_id) {
        const existing = db.prepare('SELECT actual_tx_id FROM plaid_transactions WHERE plaid_tx_id = ?').get(rm.transaction_id);
        if (existing?.actual_tx_id) {
          try {
            await actualApi.deleteTransaction(existing.actual_tx_id);
          } catch (e) {
            console.warn(`Failed to delete transaction ${existing.actual_tx_id}:`, e);
          }
          db.prepare('DELETE FROM plaid_transactions WHERE plaid_tx_id = ?').run(rm.transaction_id);
          totalRemoved++;
        }
      }
    }

    totalAdded += added.length;
    totalModified += modified.length;
    cursor = next_cursor;
    hasMore = has_more;

    // Persist cursor atomically after each page
    db.prepare(`
      INSERT INTO sync_state (item_id, cursor, last_sync_time) 
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id) DO UPDATE SET cursor = excluded.cursor, last_sync_time = CURRENT_TIMESTAMP
    `).run(itemId, cursor);
  }

  db.prepare(`
    INSERT INTO sync_history (item_id, status, added_count, modified_count, removed_count)
    VALUES (?, 'success', ?, ?, ?)
  `).run(itemId, totalAdded, totalModified, totalRemoved);
}
```

---

## 6. Nix Package & NixOS Module

The service is packaged as a standard Nix Flake containing the application package and a declarative NixOS module.

### Flake Definition (`flake.nix`)

```nix
{
  description = "gone-to-plaid-sync: Resilient Plaid-to-Actual Budget bridge";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "gone-to-plaid-sync";
          version = "1.0.0";
          src = ./.;

          npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

          buildPhase = ''
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/gone-to-plaid-sync
            cp -r dist node_modules package.json $out/lib/gone-to-plaid-sync/
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/gone-to-plaid-sync \
              --add-flags "$out/lib/gone-to-plaid-sync/dist/index.js"
          '';

          nativeBuildInputs = [ pkgs.makeWrapper ];
        };
      }
    ) // {
      nixosModules.default = import ./nix/module.nix self;
    };
}
```

### NixOS Service Module (`nix/module.nix`)

```nix
self: { config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.gone-to-plaid-sync;
in
{
  options.services.gone-to-plaid-sync = {
    enable = mkEnableOption "gone-to-plaid-sync daemon";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.system}.default;
      description = "The package providing gone-to-plaid-sync.";
    };

    port = mkOption {
      type = types.port;
      default = 8085;
      description = "Port on which the web setup and repair dashboard listens.";
    };

    dataDir = mkOption {
      type = types.path;
      default = "/var/lib/gone-to-plaid-sync";
      description = "Directory storing local SQLite database and sync state.";
    };

    syncInterval = mkOption {
      type = types.str;
      default = "4h";
      description = "Systemd calendar expression or interval for automatic ledger sync.";
    };

    environmentFile = mkOption {
      type = types.path;
      description = ''
        Path to an environment file containing secrets:
        - PLAID_CLIENT_ID
        - PLAID_SECRET
        - PLAID_ENV (sandbox or production)
        - ACTUAL_SERVER_URL
        - ACTUAL_PASSWORD (or login token)
        - ACTUAL_SYNC_ID
        - ACTUAL_ENCRYPTION_PASSWORD (optional, for E2EE budgets)
      '';
    };
  };

  config = mkIf cfg.enable {
    users.users.plaid-sync = {
      isSystemUser = true;
      group = "plaid-sync";
      home = cfg.dataDir;
      createHome = true;
    };
    users.groups.plaid-sync = {};

    systemd.services.gone-to-plaid-sync = {
      description = "Gone To Plaid Actual Sync Daemon";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/gone-to-plaid-sync --data-dir ${cfg.dataDir} --port ${toString cfg.port}";
        Restart = "on-failure";
        User = "plaid-sync";
        Group = "plaid-sync";
        WorkingDirectory = cfg.dataDir;
        EnvironmentFile = cfg.environmentFile;

        # Hardening
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        PrivateTmp = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
      };
    };

    systemd.timers.gone-to-plaid-sync-trigger = {
      description = "Periodic trigger for gone-to-plaid-sync";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5m";
        OnUnitActiveSec = cfg.syncInterval;
        Unit = "gone-to-plaid-sync-run.service";
      };
    };

    systemd.services.gone-to-plaid-sync-run = {
      description = "Run gone-to-plaid-sync background pass";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.curl}/bin/curl -s -X POST http://127.0.0.1:${toString cfg.port}/api/sync";
        User = "plaid-sync";
      };
    };
  };
}
```

---

## 7. Operational Workflow for Production Banking

1. **Host-Level Deployment:** Include the flake in your `flake.nix`, configure `services.gone-to-plaid-sync`, and point `environmentFile` to your secrets (stored via `sops-nix` or `agenix`).
2. **First Run (Sandbox Validation):** Set `PLAID_ENV=sandbox`. Open `http://localhost:8085`, test Link using `user_good` / `pass_good`, and verify that transactions map properly into Actual Budget test accounts.
3. **Production Onboarding:** Switch `PLAID_ENV=production`. In the dashboard, click **Connect Institution**, select your financial institution (e.g. Veridian Credit Union), and complete the OAuth/MFA flow. Map the discovered bank account to your production Actual Budget account.
4. **Maintenance & Repair:** If the institution resets active sessions or updates MFA requirements, the dashboard marks the Item as `login_required`. Clicking **Repair** immediately opens Plaid Link strictly in update mode (`access_token` passed to `/link/token/create`). Re-authenticating fixes the connection on the existing token and preserves your lifetime 10-Item quota.