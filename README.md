# `gone-to-plaid-sync`

A lightweight, resilient synchronization daemon and management dashboard bridging **Plaid** with self-hosted **Actual Budget** instances.

Specifically engineered to operate permanently within Plaid's complimentary **Trial tier** while preventing accidental consumption of non-refundable connection quotas.

---

## Features

- **Plaid Free Trial Defense Engine:**
  - **Lifetime Quota Meter:** Real-time visual tracking of `N / 10` lifetime production items.
  - **Strict Update Mode:** Enforces `existingAccessToken` during credential refresh and MFA updates, avoiding duplicate item creation and slot burning.
  - **Duplicate Prevention:** Pre-flight validation blocks adding institutions that are already connected.
  - **Destructive Deletion Lockout:** Protects against accidental deletion of items with a typed confirmation safeguard (`IRREVERSIBLE QUOTA LOSS`).
  - **Sandbox / Production Isolation:** Mock institution credentials (`user_good` / `pass_good`) with unlimited sandbox slots.
- **Precision Ledger Synchronization:**
  - **Exact Accounting Parity:** Inverts Plaid debit/credit signs and converts amounts to Actual's integer cents formula: $\operatorname{round}(-\text{amount} \times 100)$.
  - **Pending Authorization Lifecycle:** Tracks Plaid transaction mappings to automatically remove pending authorizations via `api.deleteTransaction()` when posted items settle.
  - **Payee Hygiene:** Intelligent payee normalization using `merchant_name` with fallback to raw transaction strings.
- **Self-Hosting & Nix First:**
  - Declarative **NixOS Module** with systemd timers and sandboxing.
  - Seamless integration with `sops-nix` or `agenix` for secret management.
  - Works with end-to-end encrypted (E2EE) Actual Budget files.
  - Optional webhook listener (`/api/plaid/webhook`) for instant synchronization upon `SYNC_UPDATES_AVAILABLE`.

---

## Architectural Strategy

Following an evaluation of Actual Budget's current ecosystem:
- Upstream Actual Budget's plugin system is actively being developed (e.g. PR stack [#8546](https://github.com/actualbudget/actual/pull/8546)) and is not yet merged into stable releases.
- Native Plaid support upstream has historically faced Bring-Your-Own-Key (BYOK) UX hurdles and liability constraints.
- `gone-to-plaid-sync` is deployed as a **decoupled sidecar daemon** communicating via `@actual-app/api`.
- The codebase is structured cleanly: `src/core/` houses the pure sync and defense logic, ensuring it can easily be adapted into an official Actual plugin once upstream plugin infrastructure stabilizes.

---

## Quick Start (Local Development)

### Prerequisites
- Node.js 22+ or 24+
- An Actual Budget server running (or local budget file)
- Plaid Developer Account (Client ID and Secret)

### 1. Clone & Install
```bash
git clone https://github.com/your-username/gone-to-plaid-sync.git
cd gone-to-plaid-sync
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in your keys:
```bash
cp .env.example .env
```

```ini
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
PLAID_ENV=sandbox

ACTUAL_SERVER_URL=http://localhost:5006
ACTUAL_PASSWORD=your_actual_password
ACTUAL_SYNC_ID=your_sync_id
# Optional: If your budget is encrypted
# ACTUAL_ENCRYPTION_PASSWORD=your_e2ee_password

PORT=8085
DATA_DIR=./data
SYNC_INTERVAL_MINUTES=240
```

### 3. Run Development Server
```bash
npm run dev
```
Open `http://localhost:8085` in your browser.

### 4. Run Test Suite
```bash
npm test
```

---

## NixOS Deployment (`nixcfg`)

Add `gone-to-plaid-sync` to your system configuration flake:

### `flake.nix`
```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    gone-to-plaid-sync.url = "github:your-username/gone-to-plaid-sync";
  };

  outputs = { self, nixpkgs, gone-to-plaid-sync, ... }: {
    nixosConfigurations.my-server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        gone-to-plaid-sync.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

### `configuration.nix`
```nix
{ config, pkgs, ... }:

{
  services.gone-to-plaid-sync = {
    enable = true;
    port = 8085;
    syncInterval = "4h";
    environmentFile = config.sops.secrets.plaid_sync_env.path; # or agenix
  };
}
```

The NixOS module automatically provisions:
1. `gone-to-plaid-sync.service`: Hardened systemd daemon running the web dashboard and webhook listener.
2. `gone-to-plaid-sync-trigger.timer`: Periodic timer triggering automated ledger sync passes.
3. Isolated system user and dedicated state directory (`/var/lib/gone-to-plaid-sync`).

---

## Plaid Free Trial Onboarding & Maintenance

1. **Sandbox Testing:** Start with `PLAID_ENV=sandbox`. In the dashboard, click **Connect New Institution** and log in with Plaid test credentials (`user_good` / `pass_good`). Test account mapping and transaction import into a test budget.
2. **Production Onboarding:** Switch `PLAID_ENV=production`. Click **Connect New Institution**, search for your bank (e.g. Veridian Credit Union), and complete authentication.
3. **Account Topology Mapping:** Map each discovered Plaid account to its corresponding Actual Budget account in the dashboard matrix.
4. **Connection Maintenance & Repair:** When your institution resets MFA or sessions, the dashboard marks the institution as `Login Required`. Clicking **Repair Connection** launches Plaid Link strictly in **Update Mode**, refreshing credentials without consuming another slot.

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

## License

MIT © Joel
