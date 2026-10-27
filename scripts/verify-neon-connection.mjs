import fs from 'fs';
import pg from 'pg';

const { Pool } = pg;

/**
 * PayGuard Neon Postgres Connection Verifier (pg driver)
 * 
 * Safely parses DATABASE_URL from .env without exposing credentials.
 * Connects via standard PostgreSQL wire protocol using pg.Pool.
 * Executes:
 *   SELECT 1 AS connected, current_database() AS database_name
 * 
 * Prints ONLY:
 * - NEON_CONNECTION: PASS or FAIL
 * - Database Name (on success)
 * - Sanitized error code (on failure)
 */

async function main() {
  if (!fs.existsSync('.env')) {
    console.log('NEON_CONNECTION: FAIL');
    console.log('Sanitized Error: ENV_FILE_MISSING');
    process.exit(1);
  }

  const envContent = fs.readFileSync('.env', 'utf8');
  const dbLine = envContent.split(/\r?\n/).find(line => line.startsWith('DATABASE_URL='));

  if (!dbLine) {
    console.log('NEON_CONNECTION: FAIL');
    console.log('Sanitized Error: DATABASE_URL_NOT_CONFIGURED');
    process.exit(1);
  }

  let rawUrl = dbLine.slice('DATABASE_URL='.length).trim();
  if ((rawUrl.startsWith('"') && rawUrl.endsWith('"')) || (rawUrl.startsWith("'") && rawUrl.endsWith("'"))) {
    rawUrl = rawUrl.slice(1, -1).trim();
  }

  const pool = new Pool({
    connectionString: rawUrl,
    connectionTimeoutMillis: 5000,
    ssl: {
      rejectUnauthorized: true
    }
  });

  try {
    const res = await pool.query('SELECT 1 AS connected, current_database() AS database_name;');
    const row = res.rows?.[0] || {};
    const dbName = row.database_name || 'unknown';

    console.log('NEON_CONNECTION: PASS');
    console.log(`Database Name: ${dbName}`);
  } catch (err) {
    console.log('NEON_CONNECTION: FAIL');
    const sanitizedCode = err.code || err.name || 'UNKNOWN_ERROR';
    console.log(`Sanitized Error: ${sanitizedCode}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
