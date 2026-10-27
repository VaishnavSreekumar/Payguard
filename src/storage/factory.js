import fs from 'fs';
import path from 'path';
import { MemoryStorageAdapter } from './memory_adapter.js';
import { PostgresStorageAdapter } from './postgres_adapter.js';

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    let raw = process.env.DATABASE_URL.trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1).trim();
    }
    return raw;
  }

  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const dbLine = envContent.split(/\r?\n/).find(line => line.startsWith('DATABASE_URL='));
    if (dbLine) {
      let raw = dbLine.slice('DATABASE_URL='.length).trim();
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        raw = raw.slice(1, -1).trim();
      }
      return raw;
    }
  }

  return null;
}

/**
 * Creates the appropriate StorageAdapter based on environment configuration.
 * 
 * Strict Production Safety:
 * - If NODE_ENV === 'production', DATABASE_URL MUST be present.
 * - PayGuard strictly fails closed and refuses to start in ephemeral memory mode in production.
 * - In non-production, defaults to MemoryStorageAdapter for deterministic offline unit testing.
 */
export function createStorageAdapter({
  databaseUrl,
  schema = process.env.PAYGUARD_PG_SCHEMA || 'public',
  forceMemory = false,
  poolConfig = {}
} = {}) {
  const isProduction = process.env.NODE_ENV === 'production';
  const resolvedUrl = databaseUrl !== undefined ? databaseUrl : resolveDatabaseUrl();

  if (isProduction && !resolvedUrl && !forceMemory) {
    throw new Error('CRITICAL: DATABASE_URL is missing in production environment. PayGuard refuses to run in ephemeral memory mode.');
  }

  if (forceMemory || !resolvedUrl) {
    return new MemoryStorageAdapter();
  }

  return new PostgresStorageAdapter({
    connectionString: resolvedUrl,
    schema,
    poolConfig
  });
}
