import { ManagedIdentityCredential } from '@azure/identity';
import { httpError } from './access.js';

/**
 * Org-scoped access rows (dbo.access_scope, migration V005) and the manager chains the jobs build
 * (dbo.access_people). The web app writes only rows with GrantedVia 'share'; the jobs' access step
 * replaces the installer's rows from its CSV and leaves these alone.
 *
 * A row: { UserPrincipalName, ScopeType, ScopeValue, CanDelegate, GrantedBy, GrantedVia, Status, Note, CreatedAt }.
 * A key: { UserPrincipalName, ScopeType, ScopeValue }, which is unique.
 */
const COLUMNS = 'UserPrincipalName, ScopeType, ScopeValue, CanDelegate, GrantedBy, GrantedVia, Status, Note, CreatedAt';
const KEY_WHERE = 'UserPrincipalName = @upn AND ScopeType = @type AND ScopeValue = @value';
// Serverless databases wake from auto-pause on the first connection and refuse logins until then.
const RESUMING = /40613|40197|40501|not currently available|ETIMEOUT|timeout/i;
const CONNECT_ATTEMPTS = 4;

export class SqlScopeStore {
  constructor({ server, database, clientId, sqlModule, credential, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.server = server; this.database = database; this.sleep = sleep;
    this.credential = credential || new ManagedIdentityCredential(clientId);
    this.sqlModule = sqlModule; this.pool = null;
  }

  async connect() {
    if (this.pool) return this.pool;
    const sql = this.sqlModule || (this.sqlModule = (await import('mssql')).default);
    for (let attempt = 1; ; attempt++) {
      const pool = new sql.ConnectionPool({
        server: this.server, database: this.database, port: 1433,
        options: { encrypt: true, trustServerCertificate: false },
        authentication: { type: 'token-credential', options: { credential: this.credential } },
        connectionTimeout: 60_000, requestTimeout: 30_000, pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 }
      });
      try {
        await pool.connect();
        pool.on('error', () => { if (this.pool === pool) this.pool = null; });
        this.pool = pool;
        return pool;
      } catch (error) {
        if (attempt >= CONNECT_ATTEMPTS || !RESUMING.test(String(error?.message || error))) throw unavailable(error);
        await this.sleep(10_000 * attempt);
      }
    }
  }

  async query(text, params = {}) {
    const pool = await this.connect();
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) request.input(name, value);
    try {
      return (await request.query(text)).recordset || [];
    } catch (error) {
      if (error?.number === 208) throw httpError(503, 'AccessTablesMissing', 'The org-scoped access tables aren\'t in the database yet. They\'re created the next time the jobs run.');
      if (error?.number === 2627 || error?.number === 2601) throw httpError(409, 'ScopeExists', 'They already have this scope.');
      throw error;
    }
  }

  async list() {
    return (await this.query(`SELECT ${COLUMNS} FROM dbo.access_scope`)).map(normalise);
  }

  async get(key) {
    const rows = await this.query(`SELECT ${COLUMNS} FROM dbo.access_scope WHERE ${KEY_WHERE}`, keyParams(key));
    return rows[0] ? normalise(rows[0]) : null;
  }

  async insert(row) {
    await this.query(
      `INSERT INTO dbo.access_scope (${COLUMNS}) VALUES (@upn, @type, @value, @canDelegate, @grantedBy, @grantedVia, @status, @note, @createdAt)`,
      { ...keyParams(row), canDelegate: row.CanDelegate ? 1 : 0, grantedBy: row.GrantedBy || null, grantedVia: row.GrantedVia, status: row.Status, note: row.Note || null, createdAt: new Date(`${row.CreatedAt}Z`) }
    );
  }

  async setStatus(key, status) {
    await this.query(`UPDATE dbo.access_scope SET Status = @status WHERE ${KEY_WHERE}`, { ...keyParams(key), status });
  }

  async delete(key) {
    await this.query(`DELETE FROM dbo.access_scope WHERE ${KEY_WHERE}`, keyParams(key));
  }

  /** The person's manager chain, top first, as lower-case UPNs; null when the org data doesn't have them. */
  async orgPath(upn) {
    const rows = await this.query('SELECT TOP 1 OrgPath FROM dbo.access_people WHERE LOWER(PersonId) = @upn', { upn });
    return rows[0]?.OrgPath ? String(rows[0].OrgPath).toLowerCase() : null;
  }
}

/** For tests and local runs. */
export class MemoryScopeStore {
  constructor({ rows = [], paths = {} } = {}) { this.rows = rows.map(normalise); this.paths = paths; }
  async list() { return this.rows.map((r) => ({ ...r })); }
  async get(key) { const r = this.rows.find((x) => sameKey(x, key)); return r ? { ...r } : null; }
  async insert(row) {
    if (this.rows.some((x) => sameKey(x, row))) throw httpError(409, 'ScopeExists', 'They already have this scope.');
    this.rows.push(normalise(row));
  }
  async setStatus(key, status) { for (const r of this.rows) if (sameKey(r, key)) r.Status = status; }
  async delete(key) { this.rows = this.rows.filter((r) => !sameKey(r, key)); }
  async orgPath(upn) { return this.paths[upn] ? String(this.paths[upn]).toLowerCase() : null; }
}

/** The store for this install: Azure SQL when the web app is told where it is. */
export function createScopeStore(config) {
  if (!config.sqlServer || !config.sqlDatabase) return null;
  return new SqlScopeStore({ server: config.sqlServer, database: config.sqlDatabase, clientId: config.azureClientId || undefined });
}

function normalise(r) {
  const when = r.CreatedAt instanceof Date ? r.CreatedAt.toISOString() : String(r.CreatedAt || '');
  return {
    UserPrincipalName: String(r.UserPrincipalName || '').toLowerCase(),
    ScopeType: String(r.ScopeType || '').toLowerCase(),
    ScopeValue: String(r.ScopeValue ?? ''),
    CanDelegate: r.CanDelegate === true || r.CanDelegate === 1 || r.CanDelegate === '1' || r.CanDelegate === 'true',
    GrantedBy: String(r.GrantedBy || '').toLowerCase(),
    GrantedVia: String(r.GrantedVia || 'installer').toLowerCase(),
    Status: String(r.Status || 'active').toLowerCase(),
    Note: String(r.Note || ''),
    CreatedAt: when.slice(0, 19)
  };
}

const keyParams = (k) => ({ upn: k.UserPrincipalName, type: k.ScopeType, value: k.ScopeValue });
const sameKey = (a, b) => a.UserPrincipalName === b.UserPrincipalName && a.ScopeType === b.ScopeType && a.ScopeValue === b.ScopeValue;

function unavailable(error) {
  console.warn(`SQL connection failed: ${error?.message || error}`);
  return httpError(503, 'DatabaseUnavailable', 'Couldn\'t reach the Analytics Hub database. Try again in a minute.');
}
