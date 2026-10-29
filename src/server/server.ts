// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConfig } from '../config.js';
import { DatabaseStore, AccountMapping } from '../db/index.js';
import { PlaidService } from '../core/plaid.js';
import { ActualService } from '../core/actual.js';
import { SyncEngine } from '../core/syncer.js';
import { DefenseEngine } from '../core/defense.js';

export class ApiServer {
  private server: http.Server;
  private uiDir: string;

  constructor(
    private config: AppConfig,
    private db: DatabaseStore,
    private plaid: PlaidService,
    private actual: ActualService,
    private syncEngine: SyncEngine,
    private defense: DefenseEngine
  ) {
    // Resolve UI directory relative to module location
    const currentFile = fileURLToPath(import.meta.url);
    const distDir = path.dirname(path.dirname(currentFile));
    const potentialUiDirs = [
      path.join(distDir, 'ui'),
      path.join(process.cwd(), 'dist', 'ui'),
      path.join(process.cwd(), 'src', 'ui'),
    ];

    this.uiDir = potentialUiDirs.find((dir) => fs.existsSync(dir)) || path.join(distDir, 'ui');
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  public listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, '0.0.0.0', () => {
        console.log(`[gone-to-plaid] Listening on http://0.0.0.0:${this.config.port}`);
        console.log(`[gone-to-plaid] UI Directory: ${this.uiDir}`);
        console.log(`[gone-to-plaid] Plaid Environment: ${this.config.plaidEnv}`);
        resolve();
      });
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async parseJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          // 2MB ceiling limit
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, data: any) {
    const json = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(json);
  }

  private sendError(res: ServerResponse, statusCode: number, message: string, details?: any) {
    this.sendJson(res, statusCode, { error: message, details });
  }

  private serveStaticFile(res: ServerResponse, filePath: string, contentType: string) {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=60',
    });
    res.end(content);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    try {
      // Static UI routes
      if (method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') {
          return this.serveStaticFile(res, path.join(this.uiDir, 'index.html'), 'text/html; charset=utf-8');
        }
        if (pathname === '/style.css') {
          return this.serveStaticFile(res, path.join(this.uiDir, 'style.css'), 'text/css; charset=utf-8');
        }
        if (pathname === '/app.js') {
          return this.serveStaticFile(res, path.join(this.uiDir, 'app.js'), 'application/javascript; charset=utf-8');
        }
      }

      // API Routes
      if (pathname.startsWith('/api/')) {
        // GET /api/status
        if (pathname === '/api/status' && method === 'GET') {
          const quota = this.defense.getQuotaStatus();
          const items = this.db.getItems().map((item) => {
            const syncState = this.db.getSyncState(item.item_id);
            const mappings = this.db.getMappings(item.item_id);
            return {
              ...item,
              access_token: undefined, // Never expose access tokens in API responses!
              last_sync_time: syncState?.last_sync_time || null,
              mappings_count: mappings.length,
              enabled_mappings_count: mappings.filter((m) => m.sync_enabled === 1).length,
            };
          });

          const actualHealth = await this.actual.checkHealth();

          return this.sendJson(res, 200, {
            quota,
            items,
            actual: {
              configured: Boolean(this.config.actualServerUrl && this.config.actualSyncId),
              connected: actualHealth.ok,
              error: actualHealth.error,
              serverUrl: this.config.actualServerUrl,
            },
            server: {
              port: this.config.port,
              syncIntervalMinutes: this.config.syncIntervalMinutes,
              environment: this.config.plaidEnv,
            },
          });
        }

        // POST /api/plaid/link-token
        if (pathname === '/api/plaid/link-token' && method === 'POST') {
          const body = await this.parseJsonBody(req);
          const itemId = body?.itemId;

          if (itemId) {
            // Update Mode strictly requested for existing item
            const item = this.db.getItem(itemId);
            if (!item) {
              return this.sendError(res, 404, `Item ${itemId} not found`);
            }
            const linkToken = await this.plaid.createLinkToken(item.access_token);
            return this.sendJson(res, 200, { linkToken, isUpdateMode: true, itemId });
          } else {
            // Initial Enrollment Mode: Assert defense rules
            this.defense.assertCanCreateNewItem();
            const linkToken = await this.plaid.createLinkToken();
            return this.sendJson(res, 200, { linkToken, isUpdateMode: false });
          }
        }

        // POST /api/plaid/exchange-token
        if (pathname === '/api/plaid/exchange-token' && method === 'POST') {
          const body = await this.parseJsonBody(req);
          const { publicToken, institutionId, institutionName } = body || {};

          if (!publicToken || !institutionId) {
            return this.sendError(res, 400, 'publicToken and institutionId are required');
          }

          // Pre-flight defense validations
          this.defense.assertCanCreateNewItem();
          this.defense.assertNotDuplicateInstitution(institutionId);

          // Exchange token with Plaid
          const { accessToken, itemId } = await this.plaid.exchangePublicToken(publicToken);

          const finalInstitutionName =
            institutionName || (await this.plaid.getInstitutionName(institutionId));

          this.db.insertItem({
            item_id: itemId,
            access_token: accessToken,
            institution_id: institutionId,
            institution_name: finalInstitutionName,
          });

          // Fetch Plaid accounts to pre-populate mapping records
          const accounts = await this.plaid.getAccounts(accessToken);
          for (const acc of accounts) {
            this.db.upsertMapping({
              plaid_account_id: acc.account_id,
              item_id: itemId,
              actual_account_id: '',
              account_name: acc.name,
              account_mask: acc.mask || null,
              account_type: acc.type,
              sync_enabled: 0,
            });
          }

          return this.sendJson(res, 200, {
            success: true,
            item: {
              item_id: itemId,
              institution_id: institutionId,
              institution_name: finalInstitutionName,
            },
            accountsCount: accounts.length,
          });
        }

        // GET /api/plaid/accounts/:itemId
        const matchPlaidAcc = pathname.match(/^\/api\/plaid\/accounts\/([a-zA-Z0-9_\-]+)$/);
        if (matchPlaidAcc && method === 'GET') {
          const itemId = matchPlaidAcc[1];
          const item = this.db.getItem(itemId);
          if (!item) return this.sendError(res, 404, 'Item not found');

          const accounts = await this.plaid.getAccounts(item.access_token);
          return this.sendJson(res, 200, { accounts });
        }

        // GET /api/actual/accounts
        if (pathname === '/api/actual/accounts' && method === 'GET') {
          const accounts = await this.actual.getAccounts();
          return this.sendJson(res, 200, { accounts });
        }

        // GET /api/mappings
        if (pathname === '/api/mappings' && method === 'GET') {
          const mappings = this.db.getMappings();
          return this.sendJson(res, 200, { mappings });
        }

        // POST /api/mappings
        if (pathname === '/api/mappings' && method === 'POST') {
          const body = await this.parseJsonBody(req);
          const mappingsList = Array.isArray(body?.mappings) ? body.mappings : [body];

          for (const m of mappingsList) {
            if (m.plaid_account_id && m.item_id) {
              this.db.upsertMapping({
                plaid_account_id: m.plaid_account_id,
                item_id: m.item_id,
                actual_account_id: m.actual_account_id || '',
                account_name: m.account_name || 'Account',
                account_mask: m.account_mask || null,
                account_type: m.account_type || 'depository',
                sync_enabled: m.sync_enabled ? 1 : 0,
              });
            }
          }

          return this.sendJson(res, 200, { success: true });
        }

        // POST /api/sync
        if (pathname === '/api/sync' && method === 'POST') {
          const results = await this.syncEngine.syncAll();
          return this.sendJson(res, 200, { success: true, results });
        }

        // POST /api/sync/:itemId
        const matchSyncItem = pathname.match(/^\/api\/sync\/([a-zA-Z0-9_\-]+)$/);
        if (matchSyncItem && method === 'POST') {
          const itemId = matchSyncItem[1];
          const result = await this.syncEngine.syncItem(itemId);
          return this.sendJson(res, 200, { success: true, result });
        }

        // DELETE /api/items/:itemId (Destructive Unlink Defense)
        const matchDeleteItem = pathname.match(/^\/api\/items\/([a-zA-Z0-9_\-]+)$/);
        if (matchDeleteItem && method === 'DELETE') {
          const itemId = matchDeleteItem[1];
          const item = this.db.getItem(itemId);
          if (!item) return this.sendError(res, 404, 'Item not found');

          const body = await this.parseJsonBody(req);
          const confirmation = body?.confirmation || '';

          if (!this.defense.verifyDestructiveUnlink(confirmation, item.institution_name)) {
            return this.sendError(
              res,
              400,
              `Destructive action prevented. Unlinking an Item permanently burns a lifetime trial slot. ` +
              `To proceed, you must type "${item.institution_name}" or "IRREVERSIBLE QUOTA LOSS" into the confirmation field.`
            );
          }

          try {
            await this.plaid.removeItem(item.access_token);
          } catch (plaidErr) {
            console.warn(`[ApiServer] Warning during Plaid item removal:`, plaidErr);
          }

          this.db.deleteItem(itemId);
          return this.sendJson(res, 200, { success: true, deletedItemId: itemId });
        }

        // POST /api/plaid/webhook
        if (pathname === '/api/plaid/webhook' && method === 'POST') {
          const body = await this.parseJsonBody(req);
          const { webhook_type, webhook_code, item_id } = body || {};

          console.log(`[Plaid Webhook] Received ${webhook_type}:${webhook_code} for item ${item_id}`);

          if (webhook_type === 'TRANSACTIONS' && webhook_code === 'SYNC_UPDATES_AVAILABLE' && item_id) {
            // Trigger background sync without blocking webhook response
            setImmediate(async () => {
              try {
                await this.syncEngine.syncItem(item_id);
              } catch (e) {
                console.error(`[Webhook Sync] Background sync failed for ${item_id}:`, e);
              }
            });
          }

          return this.sendJson(res, 200, { received: true });
        }

        // GET /api/history
        if (pathname === '/api/history' && method === 'GET') {
          const history = this.db.getSyncHistory(50);
          return this.sendJson(res, 200, { history });
        }
      }

      // Fallback 404
      return this.sendError(res, 404, `Endpoint ${method} ${pathname} not found`);
    } catch (err: any) {
      console.error(`[ApiServer] Error handling ${method} ${pathname}:`, err);
      return this.sendError(res, 500, err?.message || 'Internal Server Error');
    }
  }
}
