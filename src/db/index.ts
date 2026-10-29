// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import path from 'node:path';
import Database from 'better-sqlite3';

export interface PlaidItem {
  item_id: string;
  access_token: string;
  institution_id: string;
  institution_name: string;
  status: 'healthy' | 'login_required' | 'error';
  error_code: string | null;
  created_at: string;
}

export interface AccountMapping {
  plaid_account_id: string;
  item_id: string;
  actual_account_id: string;
  account_name: string;
  account_mask: string | null;
  account_type: string;
  sync_enabled: number;
}

export interface PlaidTransactionRecord {
  plaid_tx_id: string;
  item_id: string;
  actual_account_id: string;
  actual_tx_id: string;
  is_pending: number;
  created_at?: string;
}

export interface SyncState {
  item_id: string;
  cursor: string | null;
  last_sync_time: string | null;
}

export interface SyncHistoryEntry {
  id?: number;
  item_id: string;
  timestamp?: string;
  status: 'success' | 'partial' | 'error';
  added_count: number;
  modified_count: number;
  removed_count: number;
  error_message?: string | null;
}

export class DatabaseStore {
  public db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'data.sqlite');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plaid_items (
        item_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        institution_id TEXT NOT NULL,
        institution_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'healthy',
        error_code TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS account_mappings (
        plaid_account_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        actual_account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        account_mask TEXT,
        account_type TEXT NOT NULL,
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
        status TEXT NOT NULL,
        added_count INTEGER DEFAULT 0,
        modified_count INTEGER DEFAULT 0,
        removed_count INTEGER DEFAULT 0,
        error_message TEXT
      );
    `);
  }

  // --- Plaid Items ---
  public getItemCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM plaid_items').get() as { count: number };
    return row.count;
  }

  public getItems(): PlaidItem[] {
    return this.db.prepare('SELECT * FROM plaid_items ORDER BY created_at ASC').all() as PlaidItem[];
  }

  public getItem(itemId: string): PlaidItem | undefined {
    return this.db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId) as PlaidItem | undefined;
  }

  public getItemByInstitution(institutionId: string): PlaidItem | undefined {
    return this.db.prepare('SELECT * FROM plaid_items WHERE institution_id = ?').get(institutionId) as PlaidItem | undefined;
  }

  public insertItem(item: {
    item_id: string;
    access_token: string;
    institution_id: string;
    institution_name: string;
  }) {
    this.db.prepare(`
      INSERT INTO plaid_items (item_id, access_token, institution_id, institution_name, status)
      VALUES (?, ?, ?, ?, 'healthy')
    `).run(item.item_id, item.access_token, item.institution_id, item.institution_name);
  }

  public updateItemStatus(itemId: string, status: 'healthy' | 'login_required' | 'error', errorCode: string | null = null) {
    this.db.prepare(`
      UPDATE plaid_items SET status = ?, error_code = ? WHERE item_id = ?
    `).run(status, errorCode, itemId);
  }

  public deleteItem(itemId: string) {
    this.db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(itemId);
  }

  // --- Account Mappings ---
  public getMappings(itemId?: string): AccountMapping[] {
    if (itemId) {
      return this.db.prepare('SELECT * FROM account_mappings WHERE item_id = ?').all(itemId) as AccountMapping[];
    }
    return this.db.prepare('SELECT * FROM account_mappings').all() as AccountMapping[];
  }

  public upsertMapping(mapping: AccountMapping) {
    this.db.prepare(`
      INSERT INTO account_mappings (plaid_account_id, item_id, actual_account_id, account_name, account_mask, account_type, sync_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plaid_account_id) DO UPDATE SET
        actual_account_id = excluded.actual_account_id,
        account_name = excluded.account_name,
        account_mask = excluded.account_mask,
        account_type = excluded.account_type,
        sync_enabled = excluded.sync_enabled
    `).run(
      mapping.plaid_account_id,
      mapping.item_id,
      mapping.actual_account_id,
      mapping.account_name,
      mapping.account_mask,
      mapping.account_type,
      mapping.sync_enabled
    );
  }

  // --- Plaid Transactions Mapping ---
  public getActualTxId(plaidTxId: string): string | undefined {
    const row = this.db.prepare('SELECT actual_tx_id FROM plaid_transactions WHERE plaid_tx_id = ?').get(plaidTxId) as { actual_tx_id: string } | undefined;
    return row?.actual_tx_id;
  }

  public upsertTransactionRecord(record: PlaidTransactionRecord) {
    this.db.prepare(`
      INSERT INTO plaid_transactions (plaid_tx_id, item_id, actual_account_id, actual_tx_id, is_pending)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plaid_tx_id) DO UPDATE SET
        is_pending = excluded.is_pending,
        actual_tx_id = excluded.actual_tx_id
    `).run(record.plaid_tx_id, record.item_id, record.actual_account_id, record.actual_tx_id, record.is_pending);
  }

  public deleteTransactionRecord(plaidTxId: string) {
    this.db.prepare('DELETE FROM plaid_transactions WHERE plaid_tx_id = ?').run(plaidTxId);
  }

  // --- Sync State & History ---
  public getSyncState(itemId: string): SyncState | undefined {
    return this.db.prepare('SELECT * FROM sync_state WHERE item_id = ?').get(itemId) as SyncState | undefined;
  }

  public updateSyncState(itemId: string, cursor: string) {
    this.db.prepare(`
      INSERT INTO sync_state (item_id, cursor, last_sync_time)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id) DO UPDATE SET
        cursor = excluded.cursor,
        last_sync_time = CURRENT_TIMESTAMP
    `).run(itemId, cursor);
  }

  public addSyncHistory(entry: SyncHistoryEntry) {
    this.db.prepare(`
      INSERT INTO sync_history (item_id, status, added_count, modified_count, removed_count, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.item_id,
      entry.status,
      entry.added_count,
      entry.modified_count,
      entry.removed_count,
      entry.error_message || null
    );
  }

  public getSyncHistory(limit: number = 50): (SyncHistoryEntry & { institution_name?: string })[] {
    return this.db.prepare(`
      SELECT h.*, i.institution_name
      FROM sync_history h
      LEFT JOIN plaid_items i ON h.item_id = i.item_id
      ORDER BY h.timestamp DESC
      LIMIT ?
    `).all(limit) as (SyncHistoryEntry & { institution_name?: string })[];
  }
}
