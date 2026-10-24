// @ts-check
/**
 * Reads entries from a zip file, and writes a copy with some entries replaced: enough for a
 * Power BI template (.pbit). Handles stored and deflated entries; no ZIP64, encryption or
 * multi-disk archives.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** General purpose flag bit 3: the sizes and CRC follow the data instead of being in the header. */
const DATA_DESCRIPTOR = 0x0008;

/**
 * @typedef {{ name: string, method: number, compressedSize: number, size: number, offset: number, crc: number }} ZipEntry
 * @typedef {{ entry: ZipEntry, at: number, length: number }} DirectoryRecord  A central directory record, where it starts and how long it is.
 */

/**
 * The end of central directory record's offset, and the central directory's records in order.
 * @param {Buffer} buf
 * @returns {{ eocd: number, records: DirectoryRecord[] }}
 */
function readDirectory(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  /** @type {DirectoryRecord[]} */
  const records = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new Error('The zip file\'s directory is damaged.');
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    const length = 46 + nameLength + extraLength + commentLength;
    records.push({ entry: { name, method, compressedSize, size, offset, crc }, at, length });
    at += length;
  }
  return { eocd, records };
}

/**
 * @param {Buffer} buf
 * @returns {Map<string, ZipEntry>}
 */
export function listZip(buf) {
  return new Map(readDirectory(buf).records.map(({ entry }) => [entry.name, entry]));
}

/**
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer}
 */
export function readZipEntry(buf, name) {
  const entry = listZip(buf).get(name);
  if (!entry) throw new Error(`The file has no ${name}.`);
  return entryData(buf, entry);
}

/**
 * Every file whose name starts with `prefix`, in the zip's order. Folder entries are left out.
 * @param {Buffer} buf
 * @param {string} prefix
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(buf, prefix) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  for (const entry of listZip(buf).values()) {
    if (entry.name.startsWith(prefix) && !entry.name.endsWith('/')) out.set(entry.name, entryData(buf, entry));
  }
  return out;
}

/**
 * The entry's bytes as stored in the zip, still compressed.
 * @param {Buffer} buf
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
function rawData(buf, entry) {
  const { name } = entry;
  if (entry.offset + 30 > buf.length || buf.readUInt32LE(entry.offset) !== LOCAL) throw new Error(`The zip entry ${name} is damaged.`);
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
  if (start + entry.compressedSize > buf.length) throw new Error(`The zip entry ${name} is damaged.`);
  return buf.subarray(start, start + entry.compressedSize);
}

/**
 * @param {Buffer} buf
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
function entryData(buf, entry) {
  const raw = rawData(buf, entry);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`${entry.name} uses zip compression method ${entry.method}, which isn't supported.`);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * The zip CRC-32 of some bytes. Node's zlib.crc32 needs a newer Node than the installer supports.
 * @param {Buffer} buf
 * @returns {number}
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A copy of the zip with some entries' contents replaced. Every entry keeps its place, name,
 * date and attributes; the others keep their compressed bytes, and the replaced ones are deflated.
 * The copy has no data descriptors, and keeps the zip's comment.
 * @param {Buffer} buf
 * @param {Map<string, Buffer>} replace  New contents by entry name. Each must already be in the zip.
 * @returns {Buffer}
 */
export function replaceZipEntries(buf, replace) {
  const { eocd, records } = readDirectory(buf);
  const names = new Set(records.map((r) => r.entry.name));
  for (const name of replace.keys()) if (!names.has(name)) throw new Error(`The file has no ${name}.`);
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const { entry, at, length } of records) {
    const local = entry.offset;
    const next = replace.get(entry.name);
    const data = next ? deflateRawSync(next) : rawData(buf, entry);
    const method = next ? 8 : entry.method;
    const crc = next ? crc32(next) : entry.crc;
    const size = next ? next.length : entry.size;
    const flags = buf.readUInt16LE(at + 8) & ~DATA_DESCRIPTOR;
    const needs = Math.max(buf.readUInt16LE(at + 6), method === 8 ? 20 : 10);
    const nameAndExtra = buf.subarray(local + 30, local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(needs, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    buf.copy(header, 10, at + 12, at + 16);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(size, 22);
    buf.copy(header, 26, local + 26, local + 30);
    const record = Buffer.from(buf.subarray(at, at + length));
    record.writeUInt16LE(needs, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt32LE(offset, 42);
    parts.push(header, nameAndExtra, data);
    central.push(record);
    offset += header.length + nameAndExtra.length + data.length;
  }
  const directorySize = central.reduce((n, b) => n + b.length, 0);
  if (offset + directorySize > 0xffffffff) throw new Error('The file is too big for a zip without ZIP64.');
  const comment = buf.subarray(eocd + 22, eocd + 22 + buf.readUInt16LE(eocd + 20));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, ...central, end, comment]);
}
