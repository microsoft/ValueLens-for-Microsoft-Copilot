// @ts-check
/**
 * Reads and writes small files, and makes folders, in a Lakehouse through the OneLake (ADLS Gen2) endpoint.
 * `dataLakeApi` does the same in an Azure storage account's container.
 */
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
     * Returns the file's text, or null when the file isn't there.
     * @param {string} workspaceId
     * @param {string} lakehouseId
     * @param {string} path  Relative to the Lakehouse root.
     */
    async readText(workspaceId, lakehouseId, path) {
      try {
        return asText(await http.get(url(workspaceId, lakehouseId, path), { headers }));
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },

    /**
     * Whether a file or folder is there.
     * @param {string} workspaceId
     * @param {string} lakehouseId
     * @param {string} path  Relative to the Lakehouse root.
     */
    async exists(workspaceId, lakehouseId, path) {
      try {
        await http.request('HEAD', url(workspaceId, lakehouseId, path), { headers });
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false;
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
      await writeChunks(http, url(workspaceId, lakehouseId, path), data);
    },
  };
}

/** @typedef {ReturnType<typeof oneLakeApi>} OneLakeApi */

const HEADERS = { 'x-ms-version': '2023-11-03' };

/** The HTTP client parses a body that looks like JSON; a file's text is wanted as it is. @param {unknown} data */
const asText = (data) => (data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data));

/**
 * Creates or replaces a file, appending in chunks, then flushes it.
 * @param {import('../http.js').HttpClient} http
 * @param {string} target
 * @param {Uint8Array} data
 */
async function writeChunks(http, target, data) {
  await http.put(target, undefined, { query: { resource: 'file' }, headers: HEADERS });
  const CHUNK = 32 * 1024 * 1024;
  for (let position = 0; position < data.length; position += CHUNK) {
    const part = data.subarray(position, Math.min(position + CHUNK, data.length));
    await http.patch(target, part, { query: { action: 'append', position }, headers: { ...HEADERS, 'Content-Type': 'application/octet-stream' } });
  }
  await http.patch(target, undefined, { query: { action: 'flush', position: data.length }, headers: HEADERS });
}

/** An Azure storage account's Data Lake endpoint. @param {string} account */
export const dataLakeUrl = (account) => `https://${account}.dfs.core.windows.net`;

/**
 * Small files in an Azure storage account (hierarchical namespace), e.g. the jobs' landing container.
 * @param {import('../http.js').HttpClient} http  A client whose base URL is `dataLakeUrl(account)`.
 */
export function dataLakeApi(http) {
  const url = (/** @type {string} */ container, /** @type {string} */ path) => `/${container}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    /**
     * Returns the file's text, or null when the file isn't there.
     * @param {string} container
     * @param {string} path  Relative to the container, e.g. access/access_scope.csv.
     */
    async readText(container, path) {
      try {
        return asText(await http.get(url(container, path), { headers: HEADERS }));
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
    /**
     * Writes a file, replacing any file at that path. Missing folders are created.
     * @param {string} container
     * @param {string} path
     * @param {Uint8Array} data
     */
    writeFile: (container, path, data) => writeChunks(http, url(container, path), data),
  };
}

/** @typedef {ReturnType<typeof dataLakeApi>} DataLakeApi */
