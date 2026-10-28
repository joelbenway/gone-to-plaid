import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

// Automatically load .env if present
dotenv.config();

export interface AppConfig {
  port: number;
  dataDir: string;
  actualDataDir: string;
  plaidClientId: string;
  plaidSecret: string;
  plaidEnv: 'sandbox' | 'production' | 'development';
  plaidRedirectUri?: string;
  actualServerUrl?: string;
  actualPassword?: string;
  actualSyncId?: string;
  actualEncryptionPassword?: string;
  syncIntervalMinutes: number;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): { port?: number; dataDir?: string } {
  const result: { port?: number; dataDir?: string } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      result.port = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--port=')) {
      result.port = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      result.dataDir = argv[++i];
    } else if (arg.startsWith('--data-dir=')) {
      result.dataDir = arg.split('=')[1];
    }
  }

  return result;
}

export function loadConfig(): AppConfig {
  const cliArgs = parseArgs();

  const dataDir = path.resolve(
    cliArgs.dataDir || process.env.DATA_DIR || './data'
  );

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const actualDataDir = process.env.ACTUAL_DATA_DIR
    ? path.resolve(process.env.ACTUAL_DATA_DIR)
    : path.join(dataDir, 'actual-api-cache');

  if (!fs.existsSync(actualDataDir)) {
    fs.mkdirSync(actualDataDir, { recursive: true });
  }

  const port = cliArgs.port || parseInt(process.env.PORT || '8085', 10);
  const syncIntervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES || '240', 10);

  const plaidEnv = (process.env.PLAID_ENV || 'sandbox') as 'sandbox' | 'production' | 'development';

  return {
    port,
    dataDir,
    actualDataDir,
    plaidClientId: process.env.PLAID_CLIENT_ID || '',
    plaidSecret: process.env.PLAID_SECRET || '',
    plaidEnv,
    plaidRedirectUri: process.env.PLAID_REDIRECT_URI || undefined,
    actualServerUrl: process.env.ACTUAL_SERVER_URL,
    actualPassword: process.env.ACTUAL_PASSWORD,
    actualSyncId: process.env.ACTUAL_SYNC_ID,
    actualEncryptionPassword: process.env.ACTUAL_ENCRYPTION_PASSWORD || undefined,
    syncIntervalMinutes,
  };
}
