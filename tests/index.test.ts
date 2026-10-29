// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plaidToActualAmount, formatPayee } from '../src/core/transform.js';
import { DefenseEngine, MAX_TRIAL_ITEMS, CONFIRM_PHRASE } from '../src/core/defense.js';
import { DatabaseStore } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

console.log('--- Running gone-to-plaid Test Suite ---');

// 1. Data Transformation Tests
console.log('Testing data transformations...');
assert.equal(plaidToActualAmount(12.50), -1250, 'Plaid $12.50 expense should convert to -1250 cents');
assert.equal(plaidToActualAmount(-1200.00), 120000, 'Plaid -$1200.00 income should convert to +120000 cents');
assert.equal(plaidToActualAmount(0.01), -1, 'Plaid $0.01 should convert to -1 cent');
assert.equal(plaidToActualAmount(0), 0, 'Plaid $0 should convert to 0');
assert.equal(plaidToActualAmount(NaN), 0, 'NaN should return 0');

assert.equal(formatPayee('Target', 'TARGET STORE #1234'), 'Target', 'Should prefer merchant_name');
assert.equal(formatPayee(null, 'TARGET STORE #1234'), 'TARGET STORE #1234', 'Should fallback to name');
assert.equal(formatPayee('', 'Raw Payee'), 'Raw Payee', 'Should fallback when merchant_name is empty string');
assert.equal(formatPayee(null, null), 'Unknown Payee', 'Should default when both are missing');
console.log('✓ Data transformation tests passed.');

// 2. Database & State Persistence Tests
console.log('Testing SQLite database persistence...');
const testDir = path.join(process.cwd(), '.tmp-test-db');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const db = new DatabaseStore(testDir);
assert.equal(db.getItemCount(), 0, 'Initial database should have 0 items');

db.insertItem({
  item_id: 'item_test_1',
  access_token: 'access-sandbox-123',
  institution_id: 'ins_109508',
  institution_name: 'Veridian Credit Union',
});

assert.equal(db.getItemCount(), 1, 'Should have 1 item after insertion');
const item = db.getItem('item_test_1');
assert.ok(item, 'Item should be retrievable');
assert.equal(item?.institution_name, 'Veridian Credit Union');
assert.equal(item?.status, 'healthy');

// Test transaction mapping
db.upsertTransactionRecord({
  plaid_tx_id: 'plaid_tx_001',
  item_id: 'item_test_1',
  actual_account_id: 'actual_acc_abc',
  actual_tx_id: 'actual_uuid_xyz',
  is_pending: 1,
});

assert.equal(db.getActualTxId('plaid_tx_001'), 'actual_uuid_xyz', 'Should map plaid tx to actual tx UUID');
db.deleteTransactionRecord('plaid_tx_001');
assert.equal(db.getActualTxId('plaid_tx_001'), undefined, 'Transaction record should be deleted');

console.log('✓ Database persistence tests passed.');

// 3. Trial Defense Engine Tests
console.log('Testing Trial Defense Engine...');
const defenseProd = new DefenseEngine(db, 'production');
const defenseSandbox = new DefenseEngine(db, 'sandbox');

const status = defenseProd.getQuotaStatus();
assert.equal(status.used, 1);
assert.equal(status.max, MAX_TRIAL_ITEMS);
assert.equal(status.remaining, 9);
assert.equal(status.isLocked, false);

// Duplicate institution check
assert.throws(
  () => defenseProd.assertNotDuplicateInstitution('ins_109508'),
  /already connected/,
  'Should reject duplicate connection to Veridian Credit Union'
);

assert.doesNotThrow(
  () => defenseProd.assertNotDuplicateInstitution('ins_999999'),
  'Should permit connection to a new institution ID'
);

// Quota exhaustion check
for (let i = 2; i <= 10; i++) {
  db.insertItem({
    item_id: `item_test_${i}`,
    access_token: `token_${i}`,
    institution_id: `ins_${i}`,
    institution_name: `Bank ${i}`,
  });
}

assert.equal(db.getItemCount(), 10, 'Should now have 10 items');
const lockedStatus = defenseProd.getQuotaStatus();
assert.equal(lockedStatus.isLocked, true, 'Production quota should be locked at 10 items');

assert.throws(
  () => defenseProd.assertCanCreateNewItem(),
  /Lifetime quota exhausted/,
  'Should block enrollment when quota is exhausted'
);

// In sandbox, limit is relaxed
assert.doesNotThrow(
  () => defenseSandbox.assertCanCreateNewItem(),
  'Sandbox should not lock out new connections at 10 items'
);

// Destructive unlink phrase verification
assert.equal(defenseProd.verifyDestructiveUnlink('IRREVERSIBLE QUOTA LOSS', 'Veridian Credit Union'), true);
assert.equal(defenseProd.verifyDestructiveUnlink('veridian credit union', 'Veridian Credit Union'), true);
assert.equal(defenseProd.verifyDestructiveUnlink('yes', 'Veridian Credit Union'), false);
assert.equal(defenseProd.verifyDestructiveUnlink('', 'Veridian Credit Union'), false);

console.log('✓ Trial Defense Engine tests passed.');

// Cleanup
db.db.close();
fs.rmSync(testDir, { recursive: true, force: true });


// 4. Config Secret Resolution Tests
console.log('Testing config secret resolution based on PLAID_ENV...');
process.env.PLAID_SANDBOX_SECRET = 'sandbox-secret-123';
process.env.PLAID_PRODUCTION_SECRET = 'prod-secret-456';

process.env.PLAID_ENV = 'sandbox';
delete process.env.PLAID_SECRET;
let cfg = loadConfig();
assert.equal(cfg.plaidSecret, 'sandbox-secret-123', 'Should select sandbox secret when PLAID_ENV=sandbox');

process.env.PLAID_ENV = 'production';
cfg = loadConfig();
assert.equal(cfg.plaidSecret, 'prod-secret-456', 'Should select production secret when PLAID_ENV=production');

process.env.PLAID_SECRET = 'fallback-secret';
delete process.env.PLAID_PRODUCTION_SECRET;
cfg = loadConfig();
assert.equal(cfg.plaidSecret, 'fallback-secret', 'Should fallback to PLAID_SECRET');
console.log('✓ Config secret resolution tests passed.');

console.log('============================================');
console.log('ALL TESTS PASSED SUCCESSFULLY!');
console.log('============================================');
