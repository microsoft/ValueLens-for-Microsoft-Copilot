// @ts-check
/**
 * What a published AnalyticsHubInstaller.exe has to pass: its Authenticode signature, the
 * SHA-256 file next to it and the release notes. Shared by finish-exe.js, the installer-exe
 * workflow and the ESRP signing pipeline, so each checks the same way. Those run it without
 * `npm ci`, so it imports nothing outside Node.js and src/launch.js.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EXE_NAME } from '../src/launch.js';

export const PUBLISHER = 'Microsoft Corporation';

/** Where the install steps live, relative to the repo's main branch. */
export const INSTALL_DOCS = 'tree/main/fabric#install';
export const WITHOUT_EXE_DOCS = 'blob/main/installer/README.md#without-the-exe';

/** @param {string} file */
export const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The line in AnalyticsHubInstaller.exe.sha256, in the format `sha256sum -c` reads.
 * @param {string} hash
 * @param {string} [name]
 */
export const sha256Line = (hash, name = EXE_NAME) => `${hash.toLowerCase()}  ${name}\n`;

/**
 * The hash in a .sha256 file, or undefined if it holds none.
 * @param {string} text
 */
export function parseSha256(text) {
  const m = /^\s*([0-9a-f]{64})\b/i.exec(text);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * @typedef {{ status: string, signer?: string | null, timestamper?: string | null }} Signature
 *   What PowerShell's Get-AuthenticodeSignature reports: Status, and the subjects of the signer
 *   and timestamp certificates.
 */

/**
 * The common name in a certificate subject such as `CN=Microsoft Corporation, O=..., C=US`.
 * @param {string | null | undefined} subject
 */
export function commonName(subject) {
  const m = /(?:^|,\s*)CN=("([^"]*)"|[^,]*)/i.exec(subject ?? '');
  return m ? (m[2] ?? m[1]).trim() : undefined;
}

/**
 * Whether a signature is good enough to publish: valid, from the publisher and timestamped, so it
 * stays valid after the certificate expires.
 * @param {Signature} sig
 * @param {{ publisher?: string }} [o]
 * @returns {{ signed: boolean, ok: boolean, problems: string[] }}
 */
export function checkSignature(sig, { publisher = PUBLISHER } = {}) {
  const signed = Boolean(sig.signer) && sig.status !== 'NotSigned';
  if (!signed) return { signed: false, ok: false, problems: ['it isn\'t signed'] };
  const problems = [];
  if (sig.status !== 'Valid') problems.push(`its signature is ${sig.status}, not Valid`);
  const signer = commonName(sig.signer);
  if (signer !== publisher) problems.push(`it's signed by ${signer ?? sig.signer}, not ${publisher}`);
  if (!sig.timestamper) problems.push('its signature has no timestamp');
  return { signed: true, ok: !problems.length, problems };
}

/**
 * The release notes for an installer release.
 * @param {{ repo: string, sha256: string, signed: boolean, publisher?: string }} o
 */
export function releaseNotes({ repo, sha256, signed, publisher = PUBLISHER }) {
  const base = `https://github.com/${repo}`;
  const lines = [
    `Download **${EXE_NAME}** and open it. Steps: ${base}/${INSTALL_DOCS}`,
    '',
    '### Check the download',
    '',
    `SHA-256: \`${sha256.toLowerCase()}\``,
    '',
    'In PowerShell, in the folder you downloaded it to, run:',
    '',
    '```powershell',
    `(Get-FileHash .\\${EXE_NAME} -Algorithm SHA256).Hash`,
    '```',
    '',
    `It should match the hash above, which is also in \`${EXE_NAME}.sha256\`. PowerShell prints it in capitals; that doesn't matter.`,
    '',
  ];
  if (signed) {
    lines.push(
      `The exe is signed by ${publisher}. To check, right-click it and choose **Properties**, then **Digital Signatures**.`,
      '',
    );
  } else {
    lines.push(
      '### If Edge or Windows warns you',
      '',
      'This build isn\'t code-signed yet, so Edge and Windows SmartScreen don\'t recognise it. Check the hash first, then:',
      '',
      '- If Edge says it **isn\'t commonly downloaded**, choose **…** next to the file, then **Keep**, **Show more** and **Keep anyway**.',
      '- If Windows says it **protected your PC**, choose **More info**, then **Run anyway**.',
      '',
      `If your organisation blocks the download, run the installer with Node.js instead: ${base}/${WITHOUT_EXE_DOCS}`,
      '',
    );
  }
  return lines.join('\n');
}
