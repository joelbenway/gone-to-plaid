#!/usr/bin/env node
// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import { loadConfig } from './config.js';
import { DatabaseStore } from './db/index.js';
import { PlaidService } from './core/plaid.js';
import { ActualService } from './core/actual.js';
import { SyncEngine } from './core/syncer.js';
import { DefenseEngine } from './core/defense.js';
import { ApiServer } from './server/server.js';

async function main() {
  const config = loadConfig();

  console.log('========================================================');
  console.log(' gone-to-plaid-sync (Resilient Plaid -> Actual Bridge)  ');
  console.log('========================================================');
  console.log(`Port:             ${config.port}`);
  console.log(`Data Directory:   ${config.dataDir}`);
  console.log(`Plaid Env:        ${config.plaidEnv}`);
  console.log(`Actual Server:    ${config.actualServerUrl || '(not configured)'}`);
  console.log(`Actual Sync ID:   ${config.actualSyncId || '(not configured)'}`);
  console.log(`Sync Interval:    ${config.syncIntervalMinutes}m`);

  const db = new DatabaseStore(config.dataDir);
  const plaid = new PlaidService(config);
  const actual = new ActualService(config);
  const syncEngine = new SyncEngine(db, plaid, actual);
  const defense = new DefenseEngine(db, config.plaidEnv);

  const server = new ApiServer(config, db, plaid, actual, syncEngine, defense);
  await server.listen();

  // Print initial quota meter
  const quota = defense.getQuotaStatus();
  console.log(
    `[Trial Defense] Quota Usage: ${quota.used} / ${quota.max} items used (${quota.remaining} remaining)`
  );
  if (quota.isLocked) {
    console.warn(
      `[Trial Defense] WARNING: Maximum trial item limit reached. Enrollment of new institutions is locked.`
    );
  }

  // Periodic background sync timer (if enabled)
  let syncTimer: NodeJS.Timeout | null = null;
  if (config.syncIntervalMinutes > 0) {
    const intervalMs = config.syncIntervalMinutes * 60 * 1000;
    console.log(`[Daemon] Scheduled sync timer active: running every ${config.syncIntervalMinutes} minutes.`);

    syncTimer = setInterval(async () => {
      console.log('[Daemon] Executing scheduled ledger synchronization pass...');
      try {
        const results = await syncEngine.syncAll();
        for (const res of results) {
          console.log(
            `[Daemon Sync] ${res.institutionName}: status=${res.status}, +${res.addedCount} added, ~${res.modifiedCount} modified, -${res.removedCount} removed`
          );
        }
      } catch (e) {
        console.error('[Daemon Sync] Error during scheduled sync pass:', e);
      }
    }, intervalMs);
  }

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`\n[gone-to-plaid-sync] Received ${signal}. Shutting down cleanly...`);
    if (syncTimer) clearInterval(syncTimer);
    try {
      await server.close();
      await actual.shutdown();
      db.db.close();
      console.log('[gone-to-plaid-sync] Shutdown complete. Goodbye.');
      process.exit(0);
    } catch (err) {
      console.error('[gone-to-plaid-sync] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[gone-to-plaid-sync] Fatal startup error:', err);
  process.exit(1);
});
