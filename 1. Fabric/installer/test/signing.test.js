// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXE_NAME } from '../src/launch.js';
import { checkSignature, commonName, parseSha256, releaseNotes, sha256Line } from '../packaging/signing.js';

const HASH = '748ed2f139d14f8babdabea867a809c4fe6da12ef9da3d07ecd93dba616224db';
const MICROSOFT = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
const TIMESTAMPER = 'CN=Microsoft Public RSA Time Stamping Authority, O=Microsoft Corporation, C=US';

test('signing: the .sha256 line reads back, in the format sha256sum -c expects', () => {
  assert.equal(sha256Line(HASH.toUpperCase()), `${HASH}  ${EXE_NAME}\n`);
  assert.equal(parseSha256(sha256Line(HASH)), HASH);
  assert.equal(parseSha256(HASH.toUpperCase()), HASH);
  assert.equal(parseSha256(''), undefined);
  assert.equal(parseSha256('not a hash'), undefined);
});

test('signing: reads the common name from a certificate subject', () => {
  assert.equal(commonName(MICROSOFT), 'Microsoft Corporation');
  assert.equal(commonName('O=Contoso, CN="Contoso, Ltd", C=US'), 'Contoso, Ltd');
  assert.equal(commonName(null), undefined);
});

test('signing: a valid, timestamped Microsoft signature passes', () => {
  assert.deepEqual(checkSignature({ status: 'Valid', signer: MICROSOFT, timestamper: TIMESTAMPER }), { signed: true, ok: true, problems: [] });
});

test('signing: an unsigned exe is reported as unsigned, not as broken', () => {
  assert.deepEqual(checkSignature({ status: 'NotSigned', signer: null, timestamper: null }), { signed: false, ok: false, problems: ['it isn\'t signed'] });
});

test('signing: a broken, foreign or untimestamped signature fails', () => {
  const tampered = checkSignature({ status: 'HashMismatch', signer: MICROSOFT, timestamper: TIMESTAMPER });
  assert.equal(tampered.signed, true);
  assert.equal(tampered.ok, false);
  assert.match(tampered.problems.join(), /HashMismatch/);

  const foreign = checkSignature({ status: 'Valid', signer: 'CN=Contoso Ltd, O=Contoso Ltd', timestamper: TIMESTAMPER });
  assert.equal(foreign.ok, false);
  assert.match(foreign.problems.join(), /Contoso Ltd, not Microsoft Corporation/);
  assert.equal(checkSignature({ status: 'Valid', signer: 'CN=Contoso Ltd' }, { publisher: 'Contoso Ltd' }).ok, false);

  const noTimestamp = checkSignature({ status: 'Valid', signer: MICROSOFT, timestamper: null });
  assert.equal(noTimestamp.ok, false);
  assert.match(noTimestamp.problems.join(), /no timestamp/);
});

test('signing: unsigned release notes say how to get past the warnings and check the hash', () => {
  const notes = releaseNotes({ repo: 'octo/hub', sha256: HASH.toUpperCase(), signed: false });
  assert.match(notes, /https:\/\/github\.com\/octo\/hub\/tree\/main\/fabric#install/);
  assert.ok(notes.includes(`\`${HASH}\``));
  assert.ok(notes.includes(`Get-FileHash .\\${EXE_NAME} -Algorithm SHA256`));
  assert.match(notes, /\*\*Keep\*\*, \*\*Show more\*\* and \*\*Keep anyway\*\*/);
  assert.match(notes, /\*\*More info\*\*, then \*\*Run anyway\*\*/);
  assert.match(notes, /octo\/hub\/blob\/main\/installer\/README\.md#without-the-exe/);
  assert.doesNotMatch(notes, /Digital Signatures/);
});

test('signing: signed release notes point to the signature and drop the warning steps', () => {
  const notes = releaseNotes({ repo: 'octo/hub', sha256: HASH, signed: true });
  assert.match(notes, /signed by Microsoft Corporation/);
  assert.match(notes, /\*\*Digital Signatures\*\*/);
  assert.ok(notes.includes(HASH));
  assert.doesNotMatch(notes, /Keep anyway|Run anyway/);
});
