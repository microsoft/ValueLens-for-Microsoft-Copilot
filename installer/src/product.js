// @ts-check
/**
 * What this installer is called, and the names it gives everything it sets up, in one place.
 *
 * The AI in One and Consumption Central installers follow the same pattern, so no two installers
 * share a command, an install record, a release tag or a folder. Nor do they share with the
 * Analytics Hub installer, which owns `valuelens-install`, `valuelens-install.json` and the
 * AnalyticsHub_* items in Fabric.
 *
 * The web page, install.ps1, Launcher.cs and app.manifest can't import this module, so they keep
 * copies of the names they need. test/product.test.js checks that the copies match.
 */

/**
 * @template {object} T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  for (const v of Object.values(/** @type {Record<string, unknown>} */ (o))) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const PRODUCT = deepFreeze({
  /** Saved in the install record as `product`. A record without it, or with another, is refused. */
  id: 'valuelens',
  name: 'ValueLens',
  repo: 'microsoft/ValueLens-for-Microsoft-Copilot',
  /** The npm package and the command it installs. */
  command: 'valuelens-installer',
  recordFile: 'valuelens-setup.json',
  /** The installer's releases are tagged `valuelens-installer-v<version>`. The repo's other releases aren't. */
  tagPrefix: 'valuelens-installer-v',
  exe: 'ValueLensInstaller.exe',
  zip: 'ValueLensInstaller.zip',
  /**
   * The folder under %LOCALAPPDATA% that holds the unpacked installer, the command install.ps1
   * leaves behind, and the scheduled PAX refresh's scripts and files.
   */
  home: 'ValueLens',
  shim: 'valuelens.cmd',
  /** The folder under Documents that holds the install record. */
  workFolder: 'ValueLens',
  /**
   * Azure Cloud Shell: the installer goes under ~/.valuelens, the command it leaves behind is
   * ~/.valuelens/valuelens, and the install record goes under ~/valuelens.
   */
  cloudShell: { home: '.valuelens', shim: 'valuelens', work: 'valuelens' },
  env: {
    /** Set by the exe, which runs the installer with the Node.js it carries. */
    exe: 'VALUELENS_EXE',
    /** Set by install.ps1 and its command: `pwsh` on Windows, `cloudshell` in Azure Cloud Shell. */
    launcher: 'VALUELENS_LAUNCHER',
    /** `1` treats this shell as Azure Cloud Shell, `0` as not. */
    cloudShell: 'VALUELENS_CLOUD_SHELL',
    /** `1` makes install.ps1 run the installer with the Node.js installed on the PC. */
    installedNode: 'VALUELENS_USE_INSTALLED_NODE',
    /** install.ps1's -ZipPath and -Proxy, for `irm | iex`. */
    zip: 'VALUELENS_ZIP',
    proxy: 'VALUELENS_PROXY',
    /** `1` skips the check for a newer installer. */
    noUpdateCheck: 'VALUELENS_NO_UPDATE_CHECK',
  },
  userAgent: 'ValueLensInstaller',
  docs: 'https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/blob/main/docs/INSTALL.md',
  /** What item descriptions, app notes and client secret labels call the installer. */
  installer: 'ValueLens installer',
  /** Written beside the notebook lines the installer fills in. */
  marker: 'Set by the ValueLens installer',
  /** What the installer writes for an admin when the person setting up can't register apps. */
  adminPack: 'valuelens-admin-pack.md',
  viewerGroup: 'ValueLens Viewers',
  viewerGroupNickname: 'valuelens-viewers',
  /** The local folder uploads are staged in, under the system temp folder. */
  stagingPrefix: 'valuelens-uploads-',
  fabric: {
    /** The app registration the Fabric route signs in to Microsoft Graph and Purview with. */
    app: 'ValueLens (Fabric)',
    workspace: 'ValueLens',
    /** Fabric allows no spaces or hyphens in Lakehouse names. */
    lakehouse: 'ValueLens',
    pipeline: 'ValueLens_Pipeline',
    model: 'ValueLens Model',
    report: 'ValueLens',
    /** The installer's own notebooks are called ValueLens_<name>. The Copilot_* loads keep their names. */
    notebookPrefix: 'ValueLens_',
    /** The model's connection to the Lakehouse's SQL endpoint, followed by the workspace ID's first 8 characters. */
    sqlConnection: 'ValueLens SQL',
  },
  pax: {
    /** The app registration the scheduled PAX refresh signs in with. */
    app: 'ValueLens (PAX)',
    task: 'ValueLens - PAX refresh',
    /** The PAX refresh's scripts and files go in this folder under `home`. */
    folder: 'pax',
    /** Windows Credential Manager target for the PAX app's secret, followed by the tenant ID. */
    credentialPrefix: 'PAX-ValueLens-',
    /** The Power BI workspace the SharePoint report is published to. */
    workspace: 'ValueLens',
    /**
     * The model and report share a name, because Power BI Desktop names both after the .pbix
     * file. A Desktop publish then lands on the same names as the API's.
     */
    model: 'ValueLens',
    report: 'ValueLens',
    /**
     * The files the refresh keeps in the SharePoint folder, which the report reads. The same
     * names as a manual setup with 4. SharePoint/scripts.
     */
    files: {
      interactions: 'copilot_interactions_rollup.csv',
      users: 'copilot_users_rollup.csv',
      agents365: 'agents_365.csv',
    },
    /**
     * The SharePoint template's parameters. Each file parameter takes the file's full address in
     * the folder, and an optional one left blank loads an empty table.
     */
    parameters: {
      interactions: 'Copilot Interactions File',
      users: 'Org Data File',
      site: 'SharePoint Site URL',
      agents365: 'Agent 365',
      feedback: 'Feedback File',
    },
  },
  flows: {
    feedback: 'ValueLens - Product feedback',
    agentInventory: 'ValueLens - Agent inventory',
    platformConnection: 'ValueLens - Power Platform API',
    oneLakeConnection: 'ValueLens - OneLake',
    feedbackFile: 'valuelens-feedback-flow.json',
    agentInventoryFile: 'valuelens-agent-inventory-flow.json',
  },
});
