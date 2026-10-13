import { TableClient, odata } from '@azure/data-tables';
import { ManagedIdentityCredential } from '@azure/identity';

export const ALLOWED_ENTITIES = new Set(['CommercialTerms', 'TaskTime']);
const MAX_ROW_BYTES = 16 * 1024;

export function validateEntity(entity) { return ALLOWED_ENTITIES.has(entity); }
export function validateSettingsRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { const e = new Error('Settings row must be a JSON object'); e.statusCode = 400; throw e; }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_ROW_BYTES) { const e = new Error('Settings row must be no larger than 16 KB'); e.statusCode = 413; throw e; }
}

export class MemorySettingsStore {
  constructor() { this.rows = new Map(); }
  key(entity, id) { return `${entity}\u001f${id}`; }
  async list(entity) { return [...this.rows.entries()].filter(([key]) => key.startsWith(`${entity}\u001f`)).map(([, row]) => structuredClone(row)); }
  async upsert(entity, id, row) { this.rows.set(this.key(entity, id), structuredClone(row)); return structuredClone(row); }
  async delete(entity, id) { this.rows.delete(this.key(entity, id)); }
}

export class TableSettingsStore {
  constructor(config) {
    if (!config.storageAccount) throw new Error('VALUELENS_STORAGE_ACCOUNT is required for settings storage');
    const endpoint = `https://${config.storageAccount}.table.core.windows.net`;
    const credential = config.azureClientId ? new ManagedIdentityCredential(config.azureClientId) : new ManagedIdentityCredential();
    this.client = new TableClient(endpoint, 'appsettings', credential);
    this.ready = this.client.createTable().catch((error) => { if (error.statusCode !== 409) throw error; });
  }
  async list(entity) {
    await this.ready;
    const rows = [];
    for await (const record of this.client.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${entity}` } })) {
      if (typeof record.json === 'string') rows.push(JSON.parse(record.json));
    }
    return rows;
  }
  async upsert(entity, id, row) { await this.ready; await this.client.upsertEntity({ partitionKey: entity, rowKey: id, json: JSON.stringify(row) }, 'Replace'); return row; }
  async delete(entity, id) { await this.ready; try { await this.client.deleteEntity(entity, id); } catch (error) { if (error.statusCode !== 404) throw error; } }
}
