import fs from 'fs';
import path from 'path';
import pg from 'pg';

const { Pool } = pg;

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

export async function runMigrations({ schema = 'public', databaseUrl = null } = {}) {
  const connStr = databaseUrl || resolveDatabaseUrl();
  if (!connStr) {
    throw new Error('DATABASE_URL is not configured in environment or .env');
  }

  const isSslDisabled = connStr.includes('sslmode=disable');
  const pool = new Pool({
    connectionString: connStr,
    connectionTimeoutMillis: 8000,
    ssl: isSslDisabled ? false : { rejectUnauthorized: true }
  });

  const client = await pool.connect();
  try {
    // Explicitly set search_path to target schema
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);
    await client.query(`SET search_path TO "${schema}";`);

    // Ensure migration table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS payguard_schema_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Discover migration files
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const appliedRes = await client.query('SELECT version FROM payguard_schema_migrations;');
    const appliedVersions = new Set(appliedRes.rows.map(r => Number(r.version)));

    let appliedCount = 0;
    for (const file of files) {
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) continue;

      const version = parseInt(match[1], 10);
      const name = match[2];

      if (appliedVersions.has(version)) {
        continue;
      }

      const sqlContent = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN;');
      try {
        await client.query(sqlContent);
        await client.query(
          'INSERT INTO payguard_schema_migrations (version, name) VALUES ($1, $2);',
          [version, name]
        );
        await client.query('COMMIT;');
        appliedCount++;
        console.log(`[PayGuard Migrations] Applied migration ${file} into schema "${schema}"`);
      } catch (err) {
        await client.query('ROLLBACK;');
        throw new Error(`Failed to apply migration ${file}: ${err.message}`);
      }
    }

    if (appliedCount === 0) {
      console.log(`[PayGuard Migrations] Schema "${schema}" is up to date (0 pending migrations).`);
    }

    return { success: true, appliedCount, schema };
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  const schemaArgIdx = process.argv.indexOf('--schema');
  const schema = (schemaArgIdx !== -1 && process.argv[schemaArgIdx + 1])
    ? process.argv[schemaArgIdx + 1]
    : (process.env.PAYGUARD_PG_SCHEMA || 'public');

  runMigrations({ schema })
    .then(res => {
      console.log(`[PayGuard Migrations] Successfully completed. Applied: ${res.appliedCount}`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`[PayGuard Migrations] Migration failed: ${err.message}`);
      process.exit(1);
    });
}
