// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import * as actualApi from '@actual-app/api';
import { AppConfig } from '../config.js';

export interface ActualAccount {
  id: string;
  name: string;
  offbudget?: boolean;
  closed?: boolean;
  type?: string;
}

export interface ActualImportTransaction {
  account: string;
  date: string;
  amount: number; // in integer cents
  payee_name?: string;
  imported_id?: string;
  cleared?: boolean;
  notes?: string;
}

export interface ActualImportResult {
  added: string[];
  updated: string[];
  errors?: any[];
}

export class ActualService {
  private isConnected = false;
  private currentSyncId: string | null = null;

  constructor(private config: AppConfig) {}

  /**
   * Initializes session with Actual Budget server and downloads the budget file.
   * Handles E2EE encryption if ACTUAL_ENCRYPTION_PASSWORD is provided.
   */
  public async connect(): Promise<void> {
    if (!this.config.actualServerUrl || !this.config.actualPassword || !this.config.actualSyncId) {
      throw new Error(
        'Actual Budget configuration incomplete. Please provide ACTUAL_SERVER_URL, ACTUAL_PASSWORD, and ACTUAL_SYNC_ID.'
      );
    }

    if (this.isConnected && this.currentSyncId === this.config.actualSyncId) {
      return;
    }

    await actualApi.init({
      dataDir: this.config.actualDataDir,
      serverURL: this.config.actualServerUrl,
      password: this.config.actualPassword,
    });

    const downloadOpts = this.config.actualEncryptionPassword
      ? { password: this.config.actualEncryptionPassword }
      : undefined;

    await actualApi.downloadBudget(this.config.actualSyncId, downloadOpts);

    this.isConnected = true;
    this.currentSyncId = this.config.actualSyncId;
  }

  /**
   * Retrieves active accounts from the currently loaded budget.
   */
  public async getAccounts(): Promise<ActualAccount[]> {
    await this.connect();
    const accounts = (await actualApi.getAccounts()) as ActualAccount[];
    return accounts.filter((a) => !a.closed);
  }

  /**
   * Imports transaction records into Actual Budget.
   * Actual automatically uses imported_id for deduplication.
   */
  public async importTransactions(
    accountId: string,
    transactions: ActualImportTransaction[]
  ): Promise<ActualImportResult> {
    await this.connect();
    const result = (await actualApi.importTransactions(accountId, transactions)) as any;

    return {
      added: Array.isArray(result?.added) ? result.added : [],
      updated: Array.isArray(result?.updated) ? result.updated : [],
      errors: result?.errors,
    };
  }

  /**
   * Deletes a transaction in Actual by its internal Actual UUID.
   */
  public async deleteTransaction(actualTxId: string): Promise<void> {
    await this.connect();
    await actualApi.deleteTransaction(actualTxId);
  }

  /**
   * Checks health of Actual server connection.
   */
  public async checkHealth(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.connect();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Graceful shutdown of Actual API client.
   */
  public async shutdown(): Promise<void> {
    if (this.isConnected) {
      try {
        await actualApi.shutdown();
      } finally {
        this.isConnected = false;
        this.currentSyncId = null;
      }
    }
  }
}
