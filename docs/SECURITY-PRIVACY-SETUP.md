# Administrator security and privacy setup

**Start here:** in either installer's `access` menu, select **Security and privacy
setup guide**. Reading the guide changes nothing. Row-level security (RLS, not
"role-level security") and user-ID pseudonymization are separate decisions.
RLS is opt-in; existing installs retain their setting. **No shipped ValueLens
route currently supports end-to-end user-ID pseudonymization. There is no hashing
switch to turn on.** Existing identity data is not changed by this update.

## Choose the correct boundary

| Active path | Ingestion / identity today | Applicable access setup | Pseudonymization readiness |
|---|---|---|---|
| The app (`app/`), including managed or Fabric-hosted CSV app | Browser loads processed files; audit `Audit_UserId` joins org `PersonId` and licence UPNs | Hosting/app sharing controls who opens it, not which rows of a supplied file they can read. No backend row authorization or semantic-model RLS in this CSV app | No server-side key store, canonical crosswalk or protected principal map. Do not put an HMAC key in browser code |
| Fabric + model-backed Fabric App (`fabric-app/` or `2. Fabric/Fabric App/`) | Notebooks write Lakehouse tables; current model and manager chains use normalized raw UPNs | Installer-managed model can prepare opt-in org scopes. App queries rely on semantic-model permissions/RLS; app filters are not authorization | Key Vault can hold secrets, but collectors, history, joins, model and access map have not been migrated together |
| Azure | Jobs publish to SQL; model-backed app uses authenticated, allow-listed OBO Power BI queries; person joins and scopes still use UPNs | Backend validates identity and app access; model RLS separately limits rows. Existing older installer supports org-scope preparation on public-network, capacity-backed installs only; private-network and Pro-only setup remain blocked | Managed identity/secret infrastructure exists; canonical identity and protected PersonKey map are not wired through ingestion/model/delegation |
| SharePoint / PAX | PAX rollup and processed CSVs in a SharePoint folder, read by report or CSV app | Site/folder, file and model sharing are separate. No installer-managed scoped RLS for this route. Anyone able to read a whole file can read all its rows | Credential Manager protects the collection credential, not an implemented identity key pipeline. No coordinated crosswalk/map or history rebuild |

Archived Power Automate + Dataverse and Local CSV templates are excluded. Existing local CSV
files still require OS/file access controls; they have no installer-managed scoped RLS.
Optional sources (feedback,
Defender, agent owners/transcripts, M365 activity, consumption exports and org
adapters) need their own identity review, not just the three core feeds.
Concealed/masked upstream report identifiers cannot be assumed joinable or
reverse-resolved. A support-bundle hash or a field named `user_id_hash` is not a
product privacy setting.

## Set up the existing model's org-scoped RLS

Use this only for an installer-managed model-backed path above. It is not a
promise of RLS on manual PBIT/CSV installs or a migration to PersonKey.

1. As a workspace administrator, inventory every model the app/report queries.
   Check org coverage, department/country values and manager chains. Decide who
   may see each org, tenant-wide tables and people without org records. Keep
   ordinary readers off workspace Admin, Member and Contributor roles: they
   bypass RLS. Avoid workspace Viewer too where it exposes underlying Lakehouse
   data; use item/model sharing. Restrict direct SQL, OneLake, SharePoint and
   blob/file access separately.
2. Open the appropriate installer's `access` command and choose **Turn on
   org-scoped access**. Review the walkthrough before confirming a model
   redeploy. It seeds an `all` scope for current viewers and the installing
   administrator to preserve their prior visibility; **turning it on does not
   automatically restrict those existing viewers**. Review and remove/replace
   those seeds before treating anyone as restricted.
3. Give named readers **Below a person** or **One department/country** scopes.
   Multiple scopes are a union. A missing personal scope falls back to `*`;
   with no active default they see no rows. Do not add a default `all` scope
   for a restricted audience. Confirm manager coverage before hierarchy scopes.
   **Apply now** loads access tables and requests refresh; it does not assign roles.
4. **Administrator portal step, for each semantic model:** in Power BI Service,
   open the workspace, select **...** beside the semantic model, then
   **Security**. Select **Scoped viewers**, enter the actual viewer security
   group, select **Add**, then **Save**. Share the report/app and grant the
   necessary model permissions separately; Build alone is not RLS membership.
5. Assign **Everyone** only to explicitly approved all-data readers, in that same
   portal. Never put a restricted reader/group in Everyone: Power BI unions role
   permissions, so Everyone overrides a narrower scope. Do not broadly assign
   the viewer group to Everyone. Audit nested/group memberships too. Removing
   an `all` scope in CSV/app does **not** revoke an Everyone role assignment;
   remove that membership in the portal before verifying restrictions.
   The scoped role's dynamic `all` rule can still exclude activity without an
   org/relationship match. Check unmatched rows explicitly; use Everyone only
   when that approved reader should also see those otherwise unjoined rows.
6. After **every model redeploy**, an administrator must review and restore role
   memberships in the portal; definition updates can drop them. Installer success
   means access tables were loaded, not that portal roles were assigned or viewer
   access was verified. The Access Scope notebook no longer accepts legacy role
   files or membership mode. Update the installer and notebook together; old
   membership callers fail explicitly rather than silently granting access.
7. In **Security > Test as role**, check the intended role, then verify using real
   non-workspace viewer sign-ins: an allowed-org reader, a different-org reader,
   a no-scope reader and an approved all-data reader. Check person detail, totals,
   exports, optional tables and each connected model; repeat after revocation and
   refresh. Admin-run row counts, sidebar hiding, small-group suppression and a
   successful app login are not evidence of row isolation.

Azure's Share panel can delegate only within its existing allowed scope rules;
it is not a replacement for portal role membership. Fabric scope administration
remains in the installer. See [permissions](PERMISSIONS.md#org-scoped-access-row-level-security).
For manual SharePoint/Local CSV Power BI deployments, a model owner must design
and test roles before sharing; these templates do not gain the installer feature
just because they have the same columns.

## User-ID pseudonymization: target contract, not an available setting

Pseudonymization is **not anonymity**. Stable keys, detailed activity, small
groups, timestamps, free text and the mapping can still identify people.
Removing a name visual or hashing a UPN is insufficient.

The shared DataHub/new-report target is:

- Resolve every compatible source person to one tenant-scoped canonical identity,
  preferably an Entra object ID. Normalize and resolve UPN-only sources through
  the protected crosswalk first. Never independently hash a UPN and an object ID
  and expect them to join.
- Derive a stable `PersonKey` with tenant-scoped keyed HMAC-SHA-256, using one
  installation key consistently across related facts and the conformed Person
  dimension. Carry `KeyVersion` (or a version prefix such as `v1_<hex>`).
  Relationship keys must match exactly, with one-directional 1:* person-to-fact
  relationships. This is a target compatibility contract, not a ValueLens API.
- Keep a separately governed map with `TenantId`, `PrincipalUPN_Normalized`
  (authenticated Power BI principal), `PersonKey`, `KeyVersion`, `IsActive`.
  It is re-identifying personal data. Deny ordinary source access; keep it out of
  visuals and ordinary model access, restrict model queries to the caller, and
  fail closed when no active mapping exists. Merely marking a table hidden is
  not protection. Validate any chosen source/model protection explicitly.
- Keep keys in a platform secret store, available only to authorized processing
  identities; never ship keys to browsers, model definitions, CSVs, source code,
  logs, notebook content/output or client-returned configuration. The crosswalk
  and map need independent restricted access, retention and audit controls.
- Keep incompatible/ambiguous sources at a genuinely non-person org/date grain,
  or exclude them. Do not retain raw identities in a supposedly pseudonymous
  report or invent a join to concealed upstream values.

Legacy ValueLens instead joins `Audit_UserId` to `PersonId` and
`UPN_Normalized`; hierarchy authorization uses raw UPN paths and scope roots.
Neither the protected map nor PersonKey authorization is implemented. Do not
rename/hash those columns, enable an imagined environment variable, or graft the
new report onto these legacy feeds and claim protected identity joins.

### Safe future opt-in and cutover gate

Existing installs must default **off**. A switch may be introduced only when all
selected supported sources, incremental/history stores, models, app queries,
hierarchy scopes, delegation and protected mapping honor the same contract.

1. Inventory identity-bearing columns, optional feeds, raw landings, caches,
   exports, backups and free-text fields. Agree retention/redaction separately;
   pseudonymizing join keys does not sanitize those fields or existing copies.
2. Provision the restricted key/crosswalk/map, resolve aliases/renames to stable
   canonical identities, and define duplicate/missing/ambiguous mapping failures.
   Obtain administrator approval for the coordinated identity/model transition.
3. Pause scheduled loads and viewer sharing for a controlled maintenance window.
   Use isolated staging to **reprocess all retained history**, not just new rows,
   and rebuild every related fact/dimension, hierarchy and active principal map
   with one key version. Never append mixed raw and pseudonymous identity shapes.
4. Verify fabricated fixtures first: one person across sources/UPN rename,
   different people and tenants, null/unresolved IDs, key-version mismatch,
   duplicate keys and missing/inactive principal maps. Assert join coverage,
   unchanged intended aggregates and default-deny authorization; inspect visuals,
   query/export surfaces and cached data for raw identity leakage.
5. Transition ingestion, model relationships/RLS and apps as one release. An
   administrator assigns Power BI role members in the portal and repeats the
   real-viewer checks above before restoring sharing and scheduled loads.
6. Record the version and recovery procedure without recording keys. Rotation
   changes PersonKeys: rebuild/reprocess **all** related history and mapping,
   refresh models and invalidate old caches/exports under the retention policy.
   Rotating only future rows breaks continuity and authorization.

HMAC is not decryptable. Reversal requires a separately authorized retained
crosswalk or reprocessing original sources; neither can be reconstructed from
keys alone. Losing the key/mapping or deleting source history may make recovery
impossible. Roll back ingestion, model, map and data together from a governed
snapshot; never "reverse" by swapping a display column. Old exports/backups
remain governed personal data after rotation or rollback.
