import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export async function buildTeamsPackage({ clientId, fqdn, appIdUri, version = '0.1.0' }) {
  validateInputs({ clientId, fqdn, appIdUri, version });
  const resource = appIdUri || `api://${fqdn}/${clientId}`;
  const template = await fs.readFile(path.join(__dirname, 'manifest.template.json'), 'utf8');
  const manifest = template.replaceAll('{{appId}}', clientId).replaceAll('{{clientId}}', clientId).replaceAll('{{fqdn}}', fqdn).replaceAll('{{appIdUri}}', resource).replaceAll('{{version}}', version);
  return writeStoredZip([
    { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') },
    { name: 'color.png', data: await fs.readFile(path.join(__dirname, 'color.png')) },
    { name: 'outline.png', data: await fs.readFile(path.join(__dirname, 'outline.png')) }
  ]);
}

function validateInputs({ clientId, fqdn, appIdUri, version }) {
  if (!GUID_RE.test(clientId || '')) throw new Error('--client-id must be a GUID');
  if (!HOST_RE.test(fqdn || '') || String(fqdn).includes('://') || String(fqdn).includes('/')) throw new Error('--fqdn must be a hostname without scheme or path');
  if (appIdUri && !String(appIdUri).startsWith('api://')) throw new Error('--app-id-uri must start with api://');
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('--version must be x.y.z');
}

function writeStoredZip(files) {
  const localParts = []; const centralParts = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'); const data = Buffer.from(file.data); const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset; const central = Buffer.concat(centralParts); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let i = 0; i < 256; i += 1) { let c = i; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[i] = c >>> 0; } return table; })();
function parseArgs(argv) { const args = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`); args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]; } return args; }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out || 'AnalyticsHub-Teams.zip';
  const buffer = await buildTeamsPackage({ clientId: args.clientId, fqdn: args.fqdn, appIdUri: args.appIdUri, version: args.version || '0.1.0' });
  await fs.writeFile(out, buffer);
  console.log(`Wrote ${out}`);
}
