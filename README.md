# gone-to-plaid

[![CI](https://github.com/joelbenway/gone-to-plaid/actions/workflows/ci.yaml/badge.svg)](https://github.com/joelbenway/gone-to-plaid/actions/workflows/ci.yaml)
[![npm version](https://img.shields.io/npm/v/gone-to-plaid.svg)](https://www.npmjs.com/package/gone-to-plaid)
[![OCI Container](https://img.shields.io/badge/OCI-ghcr.io-238636?logo=docker&logoColor=white)](https://github.com/joelbenway/gone-to-plaid/pkgs/container/gone-to-plaid)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Nix Flake](https://img.shields.io/badge/Nix-Flake-5277C3.svg?logo=nixos&logoColor=white)](flake.nix)

> *"They've gone to plaid!"* — *Spaceballs* (1987)

A ludicrous-speed, resilient synchronization daemon and management dashboard bridging **Plaid** banking feeds with self-hosted **Actual Budget** instances.

Specifically engineered to operate permanently within Plaid's complimentary **Trial tier** while preventing accidental consumption of non-refundable connection quotas.

---

## The Problem: Plaid's Free Trial Quota Trap

Plaid's free developer Trial tier provides access to live US and Canadian production bank connections with zero monthly platform fees. However, it enforces an **absolute lifetime ceiling of 10 Production Items**.

Crucially, Plaid's billing engine treats this quota as an **irreversible counter**:
- Calling `/item/remove` unlinks an institution, but **does not decrement** the usage counter.
- If an institution's session expires and a user runs standard Plaid Link to reconnect, Plaid creates a *second* item, burning an additional slot for the same bank.
- Deleting an institution to "reset" it burns that allocation slot permanently.

Without protective middleware, self-hosters routinely exhaust their lifetime quota through casual re-authentication or configuration drops.

---

## The Solution: Plaid Free Trial Defense Engine

`gone-to-plaid` acts as a protective shield between your banking accounts, Plaid, and Actual Budget:

| Failure Mode | Standard Behavior (Slot Loss) | `gone-to-plaid` Safeguard |
| :--- | :--- | :--- |
| **Credential Expiry / MFA** | Standard Link flow generates a duplicate Item and burns another slot. | Launches Plaid Link strictly in **Update Mode** (`access_token` passed to `/link/token/create`), refreshing credentials in place with **zero slot usage**. |
| **Accidental Item Deletion** | Deleting an Item to "reset" it permanently burns that allocation slot. | Hard-blocks destructive deletion without a typed administrative confirmation warning (`IRREVERSIBLE QUOTA LOSS`). |
| **Duplicate Institution Link** | User links an institution that is already connected, consuming another slot. | Pre-flight validation checks incoming `institution_id` against active local items and rejects duplicates prior to token exchange. |
| **Quota Blindness** | Unmonitored connections approach the 10-Item limit without warning. | Displays a real-time `N / 10` lifetime allocation meter in the web dashboard and automatically locks out enrollment at 10 items. |
| **Dev & Script Testing** | Testing against live banking credentials consumes production slots. | Environment toggle (`PLAID_ENV=sandbox`) forces mock institution credentials (`user_good` / `pass_good`) with unlimited slots. |

---

## Architectural Strategy

Following an architectural review of Actual Budget:
- Upstream Actual Budget's plugin system is actively being developed (e.g. PR stack [#8546](https://github.com/actualbudget/actual/pull/8546)) and is not yet merged into stable releases.
- Native Plaid support in Actual core has historically stalled due to liability concerns and Bring-Your-Own-Key (BYOK) UX hurdles.
- **`gone-to-plaid` is deployed as a decoupled sidecar daemon** communicating via `@actual-app/api`.
- The codebase is strictly partitioned: `src/core/` houses the headless sync engine and quota defense rules. When Actual Budget's upstream plugin stack stabilizes, the core logic can be packaged directly as an official `@actual-app/bank-sync-plaid` plugin.

```
+-----------------------------------------------------------------------------------+
| gone-to-plaid Daemon                                                              |
|                                                                                   |
|  +--------------------+        +---------------------+      +------------------+  |
|  | Web Admin UI       | <----> | Native HTTP Server  | <--> | SQLite Store     |  |
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

---

## Features

- **Exact Accounting Parity:**
  - Plaid reports debits/outflows as positive floats (`12.50`) and credits as negative floats (`-1200.00`).
  - Actual Budget requires integer cents where outflows are negative (`-1250`) and inflows are positive (`120000`).
  - Transformation formula: $\operatorname{round}(-\text{plaid\_amount} \times 100)$ with negative-zero normalization.
- **Pending vs. Posted Lifecycle Management:**
  - Tracks Plaid transaction mappings in SQLite (`plaid_tx_id -> actual_tx_id`).
  - When Plaid emits a removal for a pending authorization that has settled or dropped, the engine resolves the internal `actual_tx_id` and invokes `api.deleteTransaction()` on Actual Budget to eliminate ghost duplicates.
- **End-to-End Encryption (E2EE) Support:**
  - Supports encrypted Actual Budget files via `ACTUAL_ENCRYPTION_PASSWORD`.
- **Payee Hygiene:**
  - Prefers enriched `merchant_name`, with fallback to raw transaction strings.
- **Scheduled & Webhook-Driven Sync:**
  - Automated ledger sync on a periodic schedule (internal timer or systemd timer).
  - Optional webhook listener (`/api/plaid/webhook`) for instant sync upon `SYNC_UPDATES_AVAILABLE`.

---

## Deployment & Quick Start

### 1. Docker & Docker Compose (Recommended for Actual Budget Self-Hosters)

Deploy `gone-to-plaid` as an automated sidecar next to your `actual-server`:

```yaml
# docker-compose.yml
services:
  actual-server:
    image: docker.io/actualbudget/actual-server:latest
    container_name: actual-server
    restart: unless-stopped
    ports:
      - "5006:5006"
    volumes:
      - ./actual-data:/data

  gone-to-plaid:
    image: ghcr.io/joelbenway/gone-to-plaid:latest
    container_name: gone-to-plaid
    restart: unless-stopped
    ports:
      - "8085:8085"
    volumes:
      - ./plaid-data:/data
    environment:
      - PLAID_CLIENT_ID=your_plaid_client_id
      - PLAID_SECRET=your_plaid_secret
      - PLAID_ENV=sandbox # 'sandbox' for testing, 'production' for live bank accounts
      - ACTUAL_SERVER_URL=http://actual-server:5006
      - ACTUAL_PASSWORD=your_actual_server_password
      - ACTUAL_SYNC_ID=your_budget_sync_id
      - PORT=8085
      - DATA_DIR=/data
      - SYNC_INTERVAL_MINUTES=240
    depends_on:
      - actual-server
```

Or run standalone with Docker:
```bash
docker run -d \
  --name gone-to-plaid \
  -p 8085:8085 \
  -v $(pwd)/data:/data \
  --env-file .env \
  ghcr.io/joelbenway/gone-to-plaid:latest
```

### 2. Run via `npx` (Zero-Install CLI)
```bash
npx gone-to-plaid --port 8085 --data-dir ./data
```

### 3. Run via Nix
```bash
# Run directly from GitHub
nix run github:joelbenway/gone-to-plaid -- --port 8085 --data-dir ./data

# Or build the OCI container image purely via Nix
nix build github:joelbenway/gone-to-plaid#dockerImage
docker load < result
```

### 4. Local Development Clone
```bash
git clone https://github.com/joelbenway/gone-to-plaid.git
cd gone-to-plaid
npm install
npm run dev
```

### Configure Environment (`.env`)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

```ini
# Plaid Credentials
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
PLAID_ENV=sandbox

# Actual Budget Connection
ACTUAL_SERVER_URL=http://localhost:5006
ACTUAL_PASSWORD=your_actual_server_password
ACTUAL_SYNC_ID=your_budget_sync_id
# Optional: If your budget file uses E2EE
# ACTUAL_ENCRYPTION_PASSWORD=your_e2ee_password

# Daemon Configuration
PORT=8085
DATA_DIR=./data
SYNC_INTERVAL_MINUTES=240
```

Open [http://localhost:8085](http://localhost:8085) in your browser.

---

## NixOS Deployment (`nixcfg`)

`gone-to-plaid` is packaged as a standard Nix Flake with a declarative NixOS service module.

### 1. Add Flake Input
In your `flake.nix`:
```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    gone-to-plaid.url = "github:joelbenway/gone-to-plaid";
  };

  outputs = { self, nixpkgs, gone-to-plaid, ... }: {
    nixosConfigurations.my-server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        gone-to-plaid.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

### 2. Configure Service
In your `configuration.nix`:
```nix
{ config, pkgs, ... }:

{
  services.gone-to-plaid = {
    enable = true;
    port = 8085;
    syncInterval = "4h";
    environmentFile = config.sops.secrets.plaid_env.path; # or agenix
  };
}
```

The NixOS module automatically provisions:
- `gone-to-plaid.service`: Sandboxed systemd service running under dedicated user `plaid-sync`.
- `gone-to-plaid-trigger.timer`: Systemd timer triggering scheduled background ledger updates.
- Hardened sandbox with `ProtectSystem = "strict"`, `ProtectHome = true`, and `PrivateTmp = true`.

---

## Testing Strategy

The repository includes a comprehensive 4-tier test suite:

```bash
# 1. Run Unit & Mock Integration Tests (fast, ~1-2 seconds)
npm test

# 2. Run Typechecker
npm run lint

# 3. Run Declarative NixOS VM Test
nix flake check
```

- **Unit Suite (`tests/index.test.ts`):** Verifies currency sign and cent transformations, negative-zero normalization, payee formatting, SQLite persistence, and defense quota rules.
- **Integration Suite (`tests/integration.test.ts`):** Tests the live HTTP API server with mocked Plaid and Actual Budget APIs, verifying enrollment, update mode Link tokens, duplicate bank blocking, account mappings, and pending transaction resolution.
- **NixOS VM Test (`nix/test.nix`):** Spawns an isolated QEMU virtual machine, verifies systemd unit startup, timer scheduling, port binding, and API status responses.

---

## Production Banking Workflow

1. **Sandbox Validation:** Set `PLAID_ENV=sandbox`. Open the dashboard, click **Connect New Institution**, and use `user_good` / `pass_good` to test mapping accounts and importing transactions.
2. **Production Onboarding:** Switch `PLAID_ENV=production`. In the dashboard, click **Connect New Institution**, select your financial institution (e.g. Veridian Credit Union), and complete MFA.
3. **Account Topology Mapping:** In the dashboard table, map each discovered Plaid account to its corresponding Actual Budget account and enable the sync toggle.
4. **Maintenance & Repair:** If an institution resets active sessions or updates security challenges, the dashboard highlights the connection with a pulsing **Login Required** badge. Clicking **Repair Connection** opens Plaid Link strictly in **Update Mode**, refreshing credentials on the existing token with **zero quota consumption**.

---

## API Endpoints

- `GET /api/status`: Current trial quota status, connected items, and Actual server health.
- `POST /api/plaid/link-token`: Creates Link token with automatic Update Mode detection.
- `POST /api/plaid/exchange-token`: Exchanges public token with quota assertion.
- `GET /api/mappings` / `POST /api/mappings`: Manage account mapping pairs.
- `POST /api/sync`: Trigger manual sync for all accounts.
- `POST /api/sync/:itemId`: Trigger manual sync for a specific institution.
- `DELETE /api/items/:itemId`: Safe destructive unlink with typed confirmation phrase.
- `POST /api/plaid/webhook`: Webhook ingestion for `SYNC_UPDATES_AVAILABLE`.
- `GET /api/history`: Recent sync logs.

---

## Automated Releases & npm Publishing

`gone-to-plaid` is continuously delivered to the [npm registry](https://www.npmjs.com/package/gone-to-plaid) via GitHub Actions CI with full [build provenance](https://docs.npmjs.com/generating-provenance-statements) using **npm Trusted Publishing** (OIDC tokenless authentication). No long-lived secret tokens (`NPM_TOKEN`) are required.

### 1. Configure Trusted Publisher on npmjs.com (One-Time Setup)

1. Log in to [npmjs.com](https://www.npmjs.com/) and navigate to your package settings: [npmjs.com/package/gone-to-plaid/access](https://www.npmjs.com/package/gone-to-plaid/access) (or **Settings** tab).
2. Scroll to **Trusted Publishers** and click **Add trusted publisher** -> select **GitHub Actions**.
3. Configure the fields:
   - **GitHub Owner / Organization:** `joelbenway`
   - **Repository:** `gone-to-plaid`
   - **Workflow filename:** `ci.yaml`
   - **Environment:** *(leave blank)*
4. Click **Save**.

### 2. Publishing New Releases

Whenever you are ready to ship an update:
1. Bump the version in `package.json`:
   ```bash
   npm version patch # or minor, major
   ```
2. Push commit and tags to `master`:
   ```bash
   git push origin master --tags
   ```
3. GitHub Actions automatically executes the unit & integration test suite, verifies the NixOS module in a declarative VM, mints an ephemeral OIDC token via GitHub Actions (`id-token: write`), and publishes the new release directly to npm with cryptographic provenance.

---

## License

MIT License. Copyright (c) 2026 Joel Benway. See [LICENSE](LICENSE) for details.
