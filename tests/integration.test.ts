// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../src/db/index.js';
import { DefenseEngine } from '../src/core/defense.js';
import { SyncEngine } from '../src/core/syncer.js';
import { ApiServer } from '../src/server/server.js';
import { AppConfig } from '../src/config.js';

console.log('--- Running gone-to-plaid Integration Test Suite ---');

const testDir = path.join(process.cwd(), '.tmp-integration-test');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const testConfig: AppConfig = {
  port: 8099,
  dataDir: testDir,
  actualDataDir: path.join(testDir, 'actual-cache'),
  plaidClientId: 'mock_client_id',
  plaidSecret: 'mock_secret',
  plaidEnv: 'sandbox',
  syncIntervalMinutes: 0,
  actualServerUrl: 'http://localhost:5006',
  actualPassword: 'mock_password',
  actualSyncId: 'mock_sync_id',
};

// 1. Setup Mocked Plaid & Actual Services
const db = new DatabaseStore(testDir);
const defense = new DefenseEngine(db, 'production'); // test under strict production quota

// Track mock interactions
const actualCalls = {
  imported: [] as any[],
  deleted: [] as string[],
};

const mockActual: any = {
  connect: async () => {},
  checkHealth: async () => ({ ok: true }),
  getAccounts: async () => [
    { id: 'act_checking', name: 'Primary Checking', offbudget: false },
    { id: 'act_credit', name: 'Rewards Credit Card', offbudget: false },
  ],
  importTransactions: async (accountId: string, txs: any[]) => {
    actualCalls.imported.push({ accountId, txs });
    // Return generated internal Actual UUIDs
    return {
      added: txs.map((t, idx) => `actual_uuid_${t.imported_id || idx}`),
      updated: [],
    };
  },
  deleteTransaction: async (actualTxId: string) => {
    actualCalls.deleted.push(actualTxId);
  },
  shutdown: async () => {},
};

let mockPlaidSyncResponse: any = {
  added: [],
  modified: [],
  removed: [],
  nextCursor: 'cursor_v1',
  hasMore: false,
};

const mockPlaid: any = {
  createLinkToken: async (existingAccessToken?: string) => {
    return existingAccessToken ? 'mock_link_token_update_mode' : 'mock_link_token_new';
  },
  exchangePublicToken: async (publicToken: string) => {
    return { accessToken: 'access_mock_sec_123', itemId: 'item_mock_veridian' };
  },
  getInstitutionName: async () => 'Veridian Credit Union',
  getAccounts: async () => [
    { account_id: 'plaid_acc_chk', name: 'Veridian Checking', mask: '1234', type: 'depository' },
    { account_id: 'plaid_acc_cc', name: 'Veridian Visa', mask: '5678', type: 'credit' },
  ],
  syncTransactions: async (accessToken: string, cursor?: string) => {
    return mockPlaidSyncResponse;
  },
  removeItem: async () => {},
};

const syncEngine = new SyncEngine(db, mockPlaid, mockActual);
const server = new ApiServer(testConfig, db, mockPlaid, mockActual, syncEngine, defense);

async function run() {
  await server.listen();
  const baseUrl = `http://127.0.0.1:${testConfig.port}`;

  try {
    // Test 1: GET /api/status (initial empty state)
    console.log('Testing GET /api/status...');
    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.quota.used, 0);
    assert.equal(statusData.quota.max, 10);
    assert.equal(statusData.items.length, 0);
    assert.equal(statusData.actual.connected, true);
    console.log('✓ Status endpoint returns initial empty quota.');

    // Test 2: POST /api/plaid/link-token (new enrollment)
    console.log('Testing Link token generation in standard mode...');
    const linkRes = await fetch(`${baseUrl}/api/plaid/link-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(linkRes.status, 200);
    const linkData = await linkRes.json();
    assert.equal(linkData.linkToken, 'mock_link_token_new');
    assert.equal(linkData.isUpdateMode, false);
    console.log('✓ Standard enrollment Link token generated.');

    // Test 3: POST /api/plaid/exchange-token
    console.log('Testing Token Exchange and Account Discovery...');
    const exRes = await fetch(`${baseUrl}/api/plaid/exchange-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicToken: 'public_sandbox_test',
        institutionId: 'ins_109508',
        institutionName: 'Veridian Credit Union',
      }),
    });
    assert.equal(exRes.status, 200);
    const exData = await exRes.json();
    assert.equal(exData.item.institution_name, 'Veridian Credit Union');
    assert.equal(exData.accountsCount, 2);

    const itemsAfter = db.getItems();
    assert.equal(itemsAfter.length, 1);
    assert.equal(itemsAfter[0].institution_id, 'ins_109508');

    // Test 4: Assert Duplicate Institution Blocking (Trial Defense)
    console.log('Testing Duplicate Institution Defense...');
    const dupRes = await fetch(`${baseUrl}/api/plaid/exchange-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicToken: 'public_sandbox_test_2',
        institutionId: 'ins_109508',
      }),
    });
    assert.equal(dupRes.status, 500);
    const dupData = await dupRes.json();
    assert.match(dupData.error, /already connected/);
    console.log('✓ Duplicate institution connection correctly rejected.');

    // Test 5: Update Mode Link Token for Existing Item
    console.log('Testing Update Mode Link Token for repair flow...');
    const updateLinkRes = await fetch(`${baseUrl}/api/plaid/link-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item_mock_veridian' }),
    });
    assert.equal(updateLinkRes.status, 200);
    const updateLinkData = await updateLinkRes.json();
    assert.equal(updateLinkData.linkToken, 'mock_link_token_update_mode');
    assert.equal(updateLinkData.isUpdateMode, true);
    console.log('✓ Update mode strictly enforced when itemId is provided.');

    // Test 6: Configure Account Mappings
    console.log('Testing Account Mapping Configuration...');
    const mapRes = await fetch(`${baseUrl}/api/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mappings: [
          {
            plaid_account_id: 'plaid_acc_chk',
            item_id: 'item_mock_veridian',
            actual_account_id: 'act_checking',
            account_name: 'Veridian Checking',
            account_mask: '1234',
            account_type: 'depository',
            sync_enabled: 1,
          },
        ],
      }),
    });
    assert.equal(mapRes.status, 200);
    const storedMappings = db.getMappings('item_mock_veridian');
    assert.equal(storedMappings.find((m) => m.plaid_account_id === 'plaid_acc_chk')?.actual_account_id, 'act_checking');
    console.log('✓ Account mapping successfully stored in SQLite.');

    // Test 7: Synchronize Pending Transaction Ingestion
    console.log('Testing Sync: Ingestion of Pending Transaction...');
    mockPlaidSyncResponse = {
      added: [
        {
          account_id: 'plaid_acc_chk',
          transaction_id: 'plaid_tx_pending_1',
          date: '2026-10-28',
          amount: 45.25, // Plaid debit (expense)
          merchant_name: 'Hy-Vee Grocery',
          name: 'HY-VEE #4321',
          pending: true,
        },
      ],
      modified: [],
      removed: [],
      nextCursor: 'cursor_v2',
      hasMore: false,
    };

    const syncRes1 = await fetch(`${baseUrl}/api/sync`, { method: 'POST' });
    assert.equal(syncRes1.status, 200);
    const syncData1 = await syncRes1.json();
    assert.equal(syncData1.results[0].addedCount, 1);

    // Verify imported payload into Actual
    assert.equal(actualCalls.imported.length, 1);
    const importedTx = actualCalls.imported[0].txs[0];
    assert.equal(importedTx.amount, -4525, 'Outflow should be -4525 integer cents');
    assert.equal(importedTx.cleared, false, 'Pending transaction should have cleared: false');
    assert.equal(importedTx.imported_id, 'plaid_tx_pending_1');

    // Verify transaction mapping table in SQLite
    const mappedActualId = db.getActualTxId('plaid_tx_pending_1');
    assert.equal(mappedActualId, 'actual_uuid_plaid_tx_pending_1');
    console.log('✓ Pending transaction imported to Actual and mapped in SQLite.');

    // Test 8: Synchronize Pending Resolution (Removal of pending, Addition of settled)
    console.log('Testing Sync: Pending Transaction Resolution & Deletion...');
    actualCalls.imported = [];
    mockPlaidSyncResponse = {
      added: [
        {
          account_id: 'plaid_acc_chk',
          transaction_id: 'plaid_tx_settled_1',
          date: '2026-10-29',
          amount: 45.25,
          merchant_name: 'Hy-Vee Grocery',
          name: 'HY-VEE #4321',
          pending: false,
        },
      ],
      modified: [],
      removed: [
        {
          transaction_id: 'plaid_tx_pending_1',
        },
      ],
      nextCursor: 'cursor_v3',
      hasMore: false,
    };

    const syncRes2 = await fetch(`${baseUrl}/api/sync`, { method: 'POST' });
    assert.equal(syncRes2.status, 200);

    // Verify deleteTransaction was called on Actual with the mapped internal UUID
    assert.equal(actualCalls.deleted.length, 1);
    assert.equal(actualCalls.deleted[0], 'actual_uuid_plaid_tx_pending_1');

    // Verify pending record was purged from SQLite mapping
    assert.equal(db.getActualTxId('plaid_tx_pending_1'), undefined);

    // Verify settled transaction was imported with cleared: true
    assert.equal(actualCalls.imported.length, 1);
    const settledTx = actualCalls.imported[0].txs[0];
    assert.equal(settledTx.cleared, true);
    assert.equal(settledTx.imported_id, 'plaid_tx_settled_1');
    console.log('✓ Pending authorization deleted in Actual; settled transaction cleanly ingested.');

    // Test 9: Webhook Sync Trigger
    console.log('Testing Plaid Webhook Reception...');
    const hookRes = await fetch(`${baseUrl}/api/plaid/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhook_type: 'TRANSACTIONS',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        item_id: 'item_mock_veridian',
      }),
    });
    assert.equal(hookRes.status, 200);
    const hookData = await hookRes.json();
    assert.equal(hookData.received, true);
    console.log('✓ Webhook successfully acknowledged.');

    // Test 10: Destructive Unlink Safeguard
    console.log('Testing Destructive Unlink Confirmation Safeguard...');
    // Attempt without confirmation phrase
    const badUnlinkRes = await fetch(`${baseUrl}/api/items/item_mock_veridian`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'please delete' }),
    });
    assert.equal(badUnlinkRes.status, 400);
    assert.match((await badUnlinkRes.json()).error, /Destructive action prevented/);

    // Valid confirmation phrase
    const goodUnlinkRes = await fetch(`${baseUrl}/api/items/item_mock_veridian`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'IRREVERSIBLE QUOTA LOSS' }),
    });
    assert.equal(goodUnlinkRes.status, 200);
    assert.equal(db.getItemCount(), 0);
    console.log('✓ Unlink defense locked out casual delete, confirmed with exact phrase.');

    console.log('============================================');
    console.log('ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
    console.log('============================================');
  } finally {
    await server.close();
    db.db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((e) => {
  console.error('Integration test failed:', e);
  process.exit(1);
});
