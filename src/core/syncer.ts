import { DatabaseStore, PlaidItem } from '../db/index.js';
import { PlaidService } from './plaid.js';
import { ActualService, ActualImportTransaction } from './actual.js';
import { plaidToActualAmount, formatPayee } from './transform.js';

export interface SyncStats {
  itemId: string;
  institutionName: string;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  status: 'success' | 'partial' | 'error';
  errorMessage?: string;
}

export class SyncEngine {
  constructor(
    private db: DatabaseStore,
    private plaid: PlaidService,
    private actual: ActualService
  ) {}

  /**
   * Synchronizes all active items that have enabled account mappings.
   */
  public async syncAll(): Promise<SyncStats[]> {
    const items = this.db.getItems();
    const results: SyncStats[] = [];

    for (const item of items) {
      if (item.status === 'login_required') {
        results.push({
          itemId: item.item_id,
          institutionName: item.institution_name,
          addedCount: 0,
          modifiedCount: 0,
          removedCount: 0,
          status: 'error',
          errorMessage: 'Login required. Please repair credentials in dashboard.',
        });
        continue;
      }

      try {
        const stats = await this.syncItem(item.item_id);
        results.push(stats);
      } catch (err: any) {
        results.push({
          itemId: item.item_id,
          institutionName: item.institution_name,
          addedCount: 0,
          modifiedCount: 0,
          removedCount: 0,
          status: 'error',
          errorMessage: err?.message || String(err),
        });
      }
    }

    return results;
  }

  /**
   * Synchronizes an individual Plaid Item through the /transactions/sync pagination loop.
   */
  public async syncItem(itemId: string): Promise<SyncStats> {
    const item = this.db.getItem(itemId);
    if (!item) {
      throw new Error(`Plaid Item "${itemId}" not found in local database.`);
    }

    const state = this.db.getSyncState(itemId);
    const mappings = this.db.getMappings(itemId).filter((m) => m.sync_enabled === 1);
    const mappingMap = new Map(mappings.map((m) => [m.plaid_account_id, m.actual_account_id]));

    if (mappings.length === 0) {
      const stats: SyncStats = {
        itemId,
        institutionName: item.institution_name,
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        status: 'success',
      };
      return stats;
    }

    let cursor = state?.cursor || undefined;
    let hasMore = true;
    let totalAdded = 0;
    let totalModified = 0;
    let totalRemoved = 0;

    try {
      while (hasMore) {
        const res = await this.plaid.syncTransactions(item.access_token, cursor);
        const { added, modified, removed, nextCursor, hasMore: more } = res;

        // 1. Group additions and modifications by mapped Actual account
        const toImport: Record<string, { tx: ActualImportTransaction; plaidTxId: string; isPending: boolean }[]> = {};

        for (const tx of [...added, ...modified]) {
          const actualAccountId = mappingMap.get(tx.account_id);
          if (!actualAccountId) continue;

          if (!toImport[actualAccountId]) {
            toImport[actualAccountId] = [];
          }

          const actualTx: ActualImportTransaction = {
            account: actualAccountId,
            date: tx.date,
            amount: plaidToActualAmount(tx.amount),
            payee_name: formatPayee(tx.merchant_name, tx.name),
            imported_id: tx.transaction_id,
            cleared: !tx.pending,
            notes: tx.pending ? 'Pending Authorization (Plaid)' : undefined,
          };

          toImport[actualAccountId].push({
            tx: actualTx,
            plaidTxId: tx.transaction_id,
            isPending: Boolean(tx.pending),
          });
        }

        // 2. Import into Actual Budget and record transaction IDs
        for (const [actualAccId, records] of Object.entries(toImport)) {
          if (records.length === 0) continue;

          const importPayload = records.map((r) => r.tx);
          const importResult = await this.actual.importTransactions(actualAccId, importPayload);

          // Map Plaid transaction ID to Actual ID for pending lifecycle resolution
          for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            const actualTxId =
              importResult.added[i] ||
              importResult.updated[i] ||
              rec.tx.imported_id ||
              rec.plaidTxId;

            this.db.upsertTransactionRecord({
              plaid_tx_id: rec.plaidTxId,
              item_id: itemId,
              actual_account_id: actualAccId,
              actual_tx_id: actualTxId,
              is_pending: rec.isPending ? 1 : 0,
            });
          }
        }

        // 3. Process Removals (Pending transactions that cleared or dropped)
        for (const rm of removed) {
          if (!rm.transaction_id) continue;

          const actualTxId = this.db.getActualTxId(rm.transaction_id);
          if (actualTxId) {
            try {
              await this.actual.deleteTransaction(actualTxId);
            } catch (delErr) {
              console.warn(
                `[SyncEngine] Warning: Could not delete pending transaction ${actualTxId} in Actual:`,
                delErr
              );
            }
            this.db.deleteTransactionRecord(rm.transaction_id);
            totalRemoved++;
          }
        }

        totalAdded += added.length;
        totalModified += modified.length;
        cursor = nextCursor;
        hasMore = more;

        // Persist pagination cursor after each successful batch
        this.db.updateSyncState(itemId, cursor);
      }

      // Mark healthy if previous status was error
      if (item.status !== 'healthy') {
        this.db.updateItemStatus(itemId, 'healthy', null);
      }

      const stats: SyncStats = {
        itemId,
        institutionName: item.institution_name,
        addedCount: totalAdded,
        modifiedCount: totalModified,
        removedCount: totalRemoved,
        status: 'success',
      };

      this.db.addSyncHistory({
        item_id: itemId,
        status: 'success',
        added_count: totalAdded,
        modified_count: totalModified,
        removed_count: totalRemoved,
      });

      return stats;
    } catch (err: any) {
      const errorData = err?.response?.data;
      const errorCode = errorData?.error_code || err?.code || 'SYNC_ERROR';
      const errorMessage = errorData?.error_message || err?.message || String(err);

      // Handle Plaid MFA / login required error codes
      if (
        errorCode === 'ITEM_LOGIN_REQUIRED' ||
        errorCode === 'PENDING_EXPIRATION' ||
        errorCode === 'INVALID_CREDENTIALS'
      ) {
        this.db.updateItemStatus(itemId, 'login_required', errorCode);
      } else {
        this.db.updateItemStatus(itemId, 'error', errorCode);
      }

      this.db.addSyncHistory({
        item_id: itemId,
        status: 'error',
        added_count: totalAdded,
        modified_count: totalModified,
        removed_count: totalRemoved,
        error_message: errorMessage,
      });

      throw err;
    }
  }
}
