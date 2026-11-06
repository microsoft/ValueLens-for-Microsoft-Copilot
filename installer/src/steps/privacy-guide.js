// @ts-check
/** Administrator checklist; displaying it never changes permissions or identity data. */
export function showPrivacyGuide(/** @type {import('../install.js').Ctx} */ ctx) {
  const { ui, config } = ctx;
  ui.heading('Security and privacy setup');
  ui.info('1. Choose the data boundary. The CSV app reads the whole supplied file; app filters are not access controls. Share only files the recipient may read.');
  ui.info('2. For the installer-managed Fabric semantic model, use Org-scoped access to prepare scopes and roles. Review seeded all scopes before restricting viewers; visibility still requires portal membership and verification.');
  ui.info('3. In the Power BI portal, open the workspace > semantic model > ... > Security. An administrator adds the viewer group to Scoped viewers and saves. Never add scoped viewers to Everyone: Power BI unions roles.');
  ui.info('4. Assign Everyone only to explicitly approved all-data readers. Review its members after every all-scope change. A CSV scope change cannot revoke an Everyone role membership; remove it in the portal too.');
  ui.info('5. After every model redeploy, an administrator must review and restore role membership in the portal. The installer does not assign Power BI roles.');
  ui.info('6. Keep ordinary readers off workspace Admin, Member and Contributor roles (they bypass RLS), and off direct Lakehouse/SQL/storage access. Build permission and sharing the app do not assign an RLS role.');
  ui.info('7. Use Security > Test as role, then sign in as real non-workspace viewers: one allowed org, another org, and a user with no scope. Check detail, totals, exports and every connected model. An admin query is not proof of RLS.');
  ui.note(`Current model RLS setting: ${config.access?.rls?.enabled ? 'on; portal membership and viewer verification still required' : 'off (default)'}. SharePoint/PAX and Local CSV have no installer-managed scoped RLS.`);
  ui.warn('User-ID pseudonymization is not available end to end on any shipped ValueLens route. No hashing switch is exposed; existing identifiers are unchanged.');
  ui.info('Do not hash Audit_UserId, PersonId or UPN_Normalized independently. A future opt-in requires one canonical PersonKey pipeline, a protected authenticated-principal map, a coordinated model transition and full historical reprocessing. Pseudonymization is not anonymity.');
  ui.info('Setup, route limitations and cutover checklist: https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/blob/main/docs/SECURITY-PRIVACY-SETUP.md');
}
