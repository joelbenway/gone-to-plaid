// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  LinkTokenCreateRequest,
  AccountBase,
  Transaction,
  RemovedTransaction,
} from 'plaid';
import { AppConfig } from '../config.js';

export interface PlaidSyncResult {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  nextCursor: string;
  hasMore: boolean;
}

export class PlaidService {
  private client: PlaidApi;

  constructor(private config: AppConfig) {
    const basePath =
      PlaidEnvironments[config.plaidEnv] || PlaidEnvironments.sandbox;

    const configuration = new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.plaidClientId,
          'PLAID-SECRET': config.plaidSecret,
        },
      },
    });

    this.client = new PlaidApi(configuration);
  }

  /**
   * Generates a Link Token.
   * If existingAccessToken is provided, it operates strictly in Update Mode.
   */
  public async createLinkToken(existingAccessToken?: string): Promise<string> {
    const isUpdateMode = Boolean(existingAccessToken);

    const request: any = {
      user: { client_user_id: 'actual-budget-owner' },
      client_name: 'gone-to-plaid',
      language: 'en',
    };

    if (isUpdateMode) {
      // In update mode, pass access_token. products and country_codes must NOT be passed.
      request.access_token = existingAccessToken;
    } else {
      request.country_codes = [CountryCode.Us, CountryCode.Ca];
      request.products = [Products.Transactions];
      if (this.config.plaidRedirectUri) {
        request.redirect_uri = this.config.plaidRedirectUri;
      }
    }

    const response = await this.client.linkTokenCreate(request);
    return response.data.link_token;
  }

  /**
   * Exchanges a Link public token for a permanent access token and item ID.
   */
  public async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const response = await this.client.itemPublicTokenExchange({
      public_token: publicToken,
    });
    return {
      accessToken: response.data.access_token,
      itemId: response.data.item_id,
    };
  }

  /**
   * Retrieves Plaid item metadata and status.
   */
  public async getItem(accessToken: string) {
    const response = await this.client.itemGet({ access_token: accessToken });
    return response.data;
  }

  /**
   * Retrieves institution details by ID.
   */
  public async getInstitutionName(institutionId: string): Promise<string> {
    try {
      const response = await this.client.institutionsGetById({
        institution_id: institutionId,
        country_codes: [CountryCode.Us, CountryCode.Ca],
      });
      return response.data.institution.name;
    } catch {
      return institutionId;
    }
  }

  /**
   * Retrieves accounts for an Item.
   */
  public async getAccounts(accessToken: string): Promise<AccountBase[]> {
    const response = await this.client.accountsGet({
      access_token: accessToken,
    });
    return response.data.accounts;
  }

  /**
   * Fetches incremental delta from /transactions/sync
   */
  public async syncTransactions(accessToken: string, cursor?: string): Promise<PlaidSyncResult> {
    const response = await this.client.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      options: {
        include_personal_finance_category: false,
      },
    });

    return {
      added: response.data.added,
      modified: response.data.modified,
      removed: response.data.removed,
      nextCursor: response.data.next_cursor,
      hasMore: response.data.has_more,
    };
  }

  /**
   * Explicitly removes an item via Plaid API.
   * WARNING: Burns a lifetime trial quota slot in Plaid!
   */
  public async removeItem(accessToken: string): Promise<void> {
    await this.client.itemRemove({ access_token: accessToken });
  }
}
