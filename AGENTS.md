# Project Overview

`gone-to-plaid` is a lightweight, self-hosted synchronization daemon and management dashboard
bridging Plaid banking feeds with self-hosted Actual Budget instances. Engineered specifically
for personal finance self-hosters operating under Plaid's free Developer Trial tier, it enforces
a robust Free Trial Defense Engine that prevents accidental consumption of the irreversible
10-item production quota by enforcing update-mode credentials, blocking duplicate institution
enrollments, and locking destructive deletions behind a typed confirmation phrase. It transforms
Plaid debit/credit floats into integer cents with negative-zero normalization, reconciles pending
versus posted transaction lifecycles, and ships with zero-dependency packaging across npm, Docker
(GHCR), and NixOS Flakes.

## Repository Structure

* `src/`: Core TypeScript source code containing sync logic, quota defenses, SQLite storage,
  native HTTP server, and management dashboard UI.
* `tests/`: Test suite consisting of unit tests (`index.test.ts`) and end-to-end HTTP integration
  tests (`integration.test.ts`) using mocked Plaid and Actual APIs.
* `nix/`: Declarative NixOS module (`module.nix`) and interactive QEMU virtual machine test
  (`test.nix`) for flake consumers.
* `.github/`: GitHub Actions continuous integration workflow definitions (`workflows/ci.yaml`).
* `dist/`: Build output directory containing bundled JavaScript, declarations, and static UI assets
  (ignored by git).

## Build & Development Commands

### Installation & Setup

```bash
# Install npm dependencies
npm ci

# Create initial environment file
cp .env.example .env
```

### Build & Type-Check

```bash
# Type-check TypeScript codebase without emitting files
npm run lint

# Compile TypeScript and copy static UI assets into dist/
npm run build
```

### Testing

```bash
# Run complete unit and integration test suite
npm test

# Run declarative NixOS VM test locally
nix flake check
```

### Local Development & Debugging

```bash
# Run daemon locally with live tsx execution and reload
npm run dev

# Run compiled daemon locally with custom parameters
node dist/index.js --port 8085 --data-dir ./data

# Run with custom environment configuration
node --env-file=.env dist/index.js
```

### Packaging & Deployment

```bash
# Build standalone OCI container image locally with Docker/Podman
docker build -t gone-to-plaid:latest .

# Build OCI container archive using Nix
nix build .#dockerImage
docker load < result

# Run containerized sidecar with Docker Compose
docker compose up -d

# Publish package release to npm (automated in CI via Trusted Publishing)
npm version patch
git push origin master --tags
```

## Code Style & Conventions

### Formatting & Syntax

1. Use standard TypeScript with `"type": "module"` (ESM imports with explicit file extensions where
   appropriate).
2. Avoid external web framework bloat; use Node.js standard library `http` server and native fetch.
3. Keep frontend lightweight: vanilla JavaScript (ES modules), CSS custom properties, and semantic
   HTML without heavy UI framework build chains.
4. Normalize financial arithmetic using `Math.round(-plaidAmount * 100)` with negative-zero
   sanitization (`result === 0 ? 0 : result`).

### Naming Patterns

* File names: Lowercase kebab-case (e.g., `defense.ts`, `syncer.ts`, `transform.ts`).
* Classes: PascalCase (e.g., `DefenseEngine`, `SyncEngine`, `ApiServer`, `SqliteStore`).
* Interfaces and types: PascalCase (e.g., `PlaidItemRecord`, `AccountMappingRecord`).
* Constants: UPPER_SNAKE_CASE (e.g., `MAX_TRIAL_ITEMS`, `UNLINK_CONFIRM_PHRASE`).
* Database columns: snake_case (e.g., `item_id`, `actual_account_id`, `plaid_tx_id`).

### Copyright & Licensing Headers

Every source file must include the standard project license header:

```typescript
// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT
```

### Commit Message Template

Use Conventional Commits format with lowercase type prefixes:

```text
<type>(<scope>): <short description>

[optional body describing technical rationale and architectural context]
```

Standard types:
* `feat`: New user-facing feature or API capability.
* `fix`: Bug fix in sync engine, quota defense, or UI.
* `refactor`: Internal code reorganization without behavior change.
* `ci`: Modifications to GitHub Actions workflows or release scripts.
* `nix`: Changes to `flake.nix` or `nix/module.nix`.
* `docs`: Documentation and README updates.

## Architecture Notes

```text
+---------------------------------------------------------------------------------+
|                              gone-to-plaid Daemon                               |
|                                                                                 |
|  +--------------------+      +-----------------------+     +-----------------+  |
|  | Web Admin UI (SPA) | <--> | Native HTTP Server    | <-> | SQLite Database |  |
|  | - Quota Gauge      |      | - Token Exchange / Link|     | - WAL Mode      |  |
|  | - Account Mappings |      | - Webhook Ingestion   |     | - Plaid Tokens  |  |
|  | - Repair Flows     |      | - Status & History    |     | - Tx Mappings   |  |
|  +--------------------+      +-----------+-----------+     +-----------------+  |
|                                          |                                      |
|                               +----------v-----------+                          |
|                               | Sync & Defense Core  |                          |
|                               | - Update-Mode Guard  |                          |
|                               | - Pending Resolver   |                          |
|                               | - Inflow / Outflow   |                          |
|                               +----+------------+----+                          |
+------------------------------------|------------|-------------------------------+
                                     |            |
                                 Plaid API    Actual Budget
```

### Component Breakdown & Data Flow

1. **Storage (`src/db/index.ts`):** SQLite database operating in WAL mode. Stores Plaid Items,
   access tokens, account mappings, sync cursors, and the `plaid_transactions` lookup table.
2. **Trial Defense Engine (`src/core/defense.ts`):** Validates item limits (hard ceiling of 10 items
   in production), forces Link tokens into update mode when an Item ID exists, blocks duplicate
   enrollment of connected institutions, and enforces typed administrative phrase confirmation
   (`IRREVERSIBLE QUOTA LOSS`) before unlinking items.
3. **Sync Engine (`src/core/syncer.ts`):** Polls Plaid's `/transactions/sync` endpoint using
   persistent cursors. Ingests added and modified transactions, formats merchant payees, converts
   currency floats to integer cents, and tracks transaction IDs in SQLite.
4. **Pending Lifecycle Resolution (`src/core/syncer.ts` & `src/core/transform.ts`):** Resolves
   Plaid transaction deletions. When Plaid removes a pending authorization upon settlement, the
   engine retrieves the internal Actual transaction UUID from SQLite and invokes
   `actualApi.deleteTransaction()` to prevent ghost records.
5. **API & UI Server (`src/server/server.ts` & `src/ui/`):** Native HTTP server exposing REST
   endpoints (`/api/status`, `/api/mappings`, `/api/sync`, `/api/plaid/*`) and serving the vanilla
   dark-mode dashboard SPA.
6. **Actual Budget Client (`src/core/actual.ts`):** Encapsulates `@actual-app/api`, handles server
   session handshakes, budget file imports by `sync_id`, and optional end-to-end decryption
   using `ACTUAL_ENCRYPTION_PASSWORD`.

## Testing Strategy

### Unit Testing (`tests/index.test.ts`)
* Focuses on pure data transformation functions, SQLite CRUD methods, and defense engine checks.
* Validates currency conversion sign flipping, cent scaling, negative-zero normalization, and
  merchant fallback string generation.
* Run locally via `npm test` or `npx tsx tests/index.test.ts`.

### Integration Testing (`tests/integration.test.ts`)
* Boots the live HTTP daemon on an ephemeral port (`8099`) against in-memory/scratch SQLite databases.
* Uses mocked Plaid client and mocked `@actual-app/api` wrappers to simulate the full lifecycle:
  Link token issuance, token exchange, duplicate bank rejection, update mode enforcement, account
  mapping persistence, pending transaction ingestion, settled deletion, and webhook triggers.
* Run locally via `npm test` or `npx tsx tests/integration.test.ts`.

### Declarative NixOS VM Testing (`nix/test.nix`)
* Uses `pkgs.testers.runNixOSTest` to spin up a sandboxed QEMU virtual machine.
* Verifies systemd unit startup (`gone-to-plaid.service`), systemd periodic timer scheduling
  (`gone-to-plaid-trigger.timer`), unprivileged user isolation (`plaid-sync`), and HTTP status
  endpoint responses.
* Run locally via `nix flake check` or `nix build .#checks.x86_64-linux.nixosTest`.

### CI Automation (`.github/workflows/ci.yaml`)
* Runs on all pushes and pull requests targeting branch `master`.
* Job `test`: Runs Node.js 22 lint, build, unit tests, and integration tests.
* Job `nix`: Installs Nix and executes `nix flake check --fallback` and `nix build --fallback`.
* Job `docker`: Builds and pushes multi-arch (`linux/amd64`, `linux/arm64`) OCI container images
  to `ghcr.io/joelbenway/gone-to-plaid:latest` and tagged versions upon push to `master`.
* Job `publish`: Publishes release packages to the public npm registry via tokenless OIDC Trusted
  Publishing when `package.json` version is incremented.

## Security & Compliance

### Secrets Handling
* Never hardcode API credentials, bank tokens, or passwords in source code.
* Runtime configuration must be injected strictly via environment variables or an environment file
  specified by `EnvironmentFile` (NixOS) or `--env-file` (Docker/CLI).
* In NixOS deployments, secrets should be managed using encrypted secret managers such as `agenix`
  or `sops-nix`.
* SQLite database stores Plaid access tokens locally; database files must reside on protected,
  unprivileged volumes with restricted filesystem permissions (e.g., `0600` or `0700` under user
  `plaid-sync`).

### Supply Chain & Integrity
* Published npm packages enforce cryptographic build provenance using GitHub Actions OIDC tokens
  (`--provenance`).
* Flake inputs lock Nixpkgs versions using `flake.lock`.
* Container images publish multi-arch manifests directly to GitHub Container Registry.

### License Notes
* Licensed under the MIT License (`LICENSE`).
* Copyright (c) 2026 Joel Benway.

## Agent Guardrails

Automated agents modifying this repository must adhere to the following rules:

1. **Defense Engine Inviolability:** Never alter, bypass, or weaken the 10-item limit assertion,
   the duplicate institution check, or the update-mode Link enforcement in `src/core/defense.ts`.
   These protections prevent irreversible financial and account quota loss for users.
2. **Pending Transaction Cleanup:** Do not modify the pending-to-settled deletion mapping logic
   in `src/core/syncer.ts` without running the full integration test suite; breaking this leaves
   permanent ghost duplicate transactions in users' Actual Budget ledgers.
3. **Single Version Source of Truth:** Never hardcode the version string in `flake.nix`.
   `flake.nix` dynamically parses `package.json` via `builtins.fromJSON (builtins.readFile ./package.json)`.
   Always increment versions using `npm version <patch|minor|major>`.
4. **Lockfile & Hash Synchronization:** If dependencies in `package.json` are modified, you must
   run `npm install --package-lock-only` and update `npmDepsHash` in `flake.nix` with the new hash
   computed by Nix.
5. **No Heavy Frontend Frameworks:** Keep `src/ui/` vanilla. Do not introduce React, Vue, Webpack,
   or heavy bundle dependencies into the UI layer.

## Extensibility Hooks

### Environment Configuration Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP server listening port | `8085` |
| `DATA_DIR` | Directory for SQLite database and storage | `./data` |
| `PLAID_CLIENT_ID` | Plaid API Client ID | *(required)* |
| `PLAID_SECRET` | Plaid API Secret key | *(required)* |
| `PLAID_ENV` | Plaid environment (`sandbox` or `production`) | `sandbox` |
| `PLAID_REDIRECT_URI` | Optional OAuth redirect URI for web re-auth | *(optional)* |
| `ACTUAL_SERVER_URL` | URL to self-hosted Actual Budget server | `http://localhost:5006` |
| `ACTUAL_PASSWORD` | Actual Budget server authentication password | *(required)* |
| `ACTUAL_SYNC_ID` | Actual Budget cloud sync ID for target budget | *(required)* |
| `ACTUAL_ENCRYPTION_PASSWORD` | Password for End-to-End Encrypted (E2EE) budget files | *(optional)* |
| `SYNC_INTERVAL_MINUTES` | Frequency of background polling (0 = disabled) | `240` |

### Architecture Plugin Extensibility

* Core sync engine (`src/core/`) is designed as a headless, framework-agnostic module.
* When upstream Actual Budget finalizes its official plugin API (tracking PR #8546), `src/core/`
  can be adapted directly into an official `@actual-app/bank-sync-plaid` plugin.

## Further Reading

* [README.md](README.md): User guide, quick-start, Docker Compose setups, and NixOS instructions.
* [LICENSE](LICENSE): MIT License terms.
* [Plaid API Transactions Sync Documentation](https://plaid.com/docs/api/products/transactions/#transactionssync)
* [Actual Budget API Documentation](https://actualbudget.org/docs/api/)
* [Actual Budget Plugin System Draft (PR #8546)](https://github.com/actualbudget/actual/pull/8546)
