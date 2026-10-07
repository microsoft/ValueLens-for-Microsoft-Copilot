import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamsPackage } from '../../teams/build-package.mjs';

function readZip(buffer) {
  const entries = new Map(); let offset = 0;
  while (offset < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18); const nameLength = buffer.readUInt16LE(offset + 26); const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'); const dataStart = offset + 30 + nameLength + extraLength;
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize)); offset = dataStart + compressedSize;
  }
  return entries;
}
function pngDimensions(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('Teams package contains manifest and PNG icons', async () => {
  const zip = await buildTeamsPackage({ clientId: '11111111-1111-4111-8111-111111111111', fqdn: 'analytics.example.com', version: '1.2.3' });
  const entries = readZip(zip); assert.deepEqual([...entries.keys()], ['manifest.json', 'color.png', 'outline.png']);
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.equal(manifest.manifestVersion, '1.17'); assert.equal(manifest.id, '11111111-1111-4111-8111-111111111111'); assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.staticTabs[0].contentUrl, 'https://analytics.example.com/?host=teams'); assert.equal(manifest.configurableTabs[0].configurationUrl, 'https://analytics.example.com/?host=teams&config=1');
  assert.deepEqual(manifest.validDomains, ['analytics.example.com']); assert.deepEqual(manifest.webApplicationInfo, { id: '11111111-1111-4111-8111-111111111111', resource: 'api://analytics.example.com/11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(pngDimensions(entries.get('color.png')), { width: 192, height: 192 }); assert.deepEqual(pngDimensions(entries.get('outline.png')), { width: 32, height: 32 });
});
