// @ts-check
/** Reads and writes small files, and makes folders, in a Lakehouse through the OneLake (ADLS Gen2) endpoint. */
import { HttpError } from '../http.js';

export const ONELAKE_URL = 'https://onelake.dfs.fabric.microsoft.com';

/** @param {import('../http.js').HttpClient} http  A client whose base URL is ONELAKE_URL. */
export function oneLakeApi(http) {
  const headers = { 'x-ms-version': '2023-11-03' };
  const url = (/** @type {string} */ workspaceId, /** @type {string} */ lakehouseId, /** @type {string} */ path) =>
    `/${workspaceId}/${lakehouseId}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    /**
     * Returns the parsed JSON, or null when the file isn't there.
     * @param {string} workspaceId
     * @param {string} lakehouseId
     * @param {string} path  Relative to the Lakehouse root, e.g. Files/x.json.
     */
    async readJson(workspaceId, lakehouseId, path) {
      try {
        const data = await http.get(url(workspaceId, lakehouseId, path), { headers });
        return typeof data === 'string' ? JSON.parse(data) : data;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },

    /**
     * Creates a folder, and any missing parents. Returns false when it was already there.
     * @param {string} workspaceId
     * @param {string} lakehouseId
     * @param {string} path  Relative to the Lakehouse root, e.g. Files/landing/studio.
     */
    async createDirectory(workspaceId, lakehouseId, path) {
      try {
        // If-None-Match stops the call replacing a folder that already holds files.
        await http.put(url(workspaceId, lakehouseId, path), undefined, { query: { resource: 'directory' }, headers: { ...headers, 'If-None-Match': '*' } });
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) return false;
        throw err;
      }
    },

    /**
     * Writes a file, replacing any file already at that path.
     * @param {string} workspaceId
     * @param {string} lakehouseId
     * @param {string} path  Relative to the Lakehouse root, e.g. Files/analytics_hub_uploads/x.csv.
     * @param {Uint8Array} data
     */
    async writeFile(workspaceId, lakehouseId, path, data) {
      const target = url(workspaceId, lakehouseId, path);
      await http.put(target, undefined, { query: { resource: 'file' }, headers });
      const CHUNK = 32 * 1024 * 1024;
      for (let position = 0; position < data.length; position += CHUNK) {
        const part = data.subarray(position, Math.min(position + CHUNK, data.length));
        await http.patch(target, part, { query: { action: 'append', position }, headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
      }
      await http.patch(target, undefined, { query: { action: 'flush', position: data.length }, headers });
    },
  };
}

/** @typedef {ReturnType<typeof oneLakeApi>} OneLakeApi */
