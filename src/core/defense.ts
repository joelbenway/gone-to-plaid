// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import { DatabaseStore } from '../db/index.js';

export const MAX_TRIAL_ITEMS = 10;
export const CONFIRM_PHRASE = 'IRREVERSIBLE QUOTA LOSS';

export interface QuotaStatus {
  used: number;
  max: number;
  remaining: number;
  percentage: number;
  isLocked: boolean;
  isWarning: boolean;
  environment: 'sandbox' | 'production' | 'development';
}

export class DefenseEngine {
  constructor(
    private db: DatabaseStore,
    private environment: 'sandbox' | 'production' | 'development'
  ) {}

  /**
   * Retrieves the current Plaid trial quota consumption status.
   */
  public getQuotaStatus(): QuotaStatus {
    const used = this.db.getItemCount();
    const isSandbox = this.environment === 'sandbox';

    // In sandbox, Plaid does not charge against production item limits
    const max = isSandbox ? 100 : MAX_TRIAL_ITEMS;
    const remaining = Math.max(0, max - used);
    const percentage = Math.min(100, Math.round((used / max) * 100));
    const isLocked = !isSandbox && used >= MAX_TRIAL_ITEMS;
    const isWarning = !isSandbox && used >= 8;

    return {
      used,
      max,
      remaining,
      percentage,
      isLocked,
      isWarning,
      environment: this.environment,
    };
  }

  /**
   * Pre-flight check before creating a new Plaid Link token in initial enrollment mode.
   * Hard-blocks token creation if the 10-item limit has already been reached in production.
   */
  public assertCanCreateNewItem(): void {
    const quota = this.getQuotaStatus();
    if (quota.isLocked) {
      throw new Error(
        `[Trial Defense Engine] Lifetime quota exhausted (${quota.used}/${quota.max} items). ` +
        `Plaid's free trial tier permits a maximum of 10 lifetime production items. ` +
        `New connections are locked to protect your account from billing escalation.`
      );
    }
  }

  /**
   * Pre-flight duplicate check:
   * Prevents linking an institution that is already actively tracked.
   */
  public assertNotDuplicateInstitution(institutionId: string): void {
    const existing = this.db.getItemByInstitution(institutionId);
    if (existing) {
      throw new Error(
        `[Trial Defense Engine] Institution "${existing.institution_name}" (ID: ${institutionId}) is already connected. ` +
        `Creating a second connection would consume another lifetime trial slot for the same bank. ` +
        `Use "Repair" or "Update Mode" to refresh credentials on the existing connection.`
      );
    }
  }

  /**
   * Strict verification for item deletion:
   * Calling /item/remove permanently burns the slot in Plaid's billing engine.
   * Requires exact typed phrase to execute.
   */
  public verifyDestructiveUnlink(confirmationInput: string, institutionName: string): boolean {
    const normalizedInput = (confirmationInput || '').trim().toUpperCase();
    const isPhraseMatch = normalizedInput === CONFIRM_PHRASE;
    const isNameMatch = normalizedInput === (institutionName || '').trim().toUpperCase();

    return isPhraseMatch || isNameMatch;
  }
}
