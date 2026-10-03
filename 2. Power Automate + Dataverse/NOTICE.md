# NOTICE — third-party component boundary

This is model-authored boundary guidance for the public preview pathway. It is
not a third-party license text, and it does not replace any actual `LICENSE`,
`Licenses`, or embedded notices that ship with retained upstream assets.

## Reused concepts and contracts

- Dataverse landing table: **`poc_sharepointagents`**
- ValueLens raw/core companion tables:
  - **`poc_valuelensrawaudits`** for full original audit JSON retention
  - **`poc_valuelensinteractions`** and **`poc_valuelensusers`** for curated dashboard rows
- Power Automate solution names: **`CopilotInteractionLogging`** and **`SharePointAgentLogging`**
- Environment-variable family: **`poc_SP_*`**
- Exact SharePoint-agent identity approach:
  - inventory keyed by observed SharePoint `ListItemUniqueId`
  - interaction join via decoded `SPO_*` usage identity

## What is in this source tree

The additional pathway contains adapters and local build helpers:

- the patched `.pbit`
- the template build script
- the raw-payload bridge
- local flow-package adapter, schema deployment and opt-in import/refresh helpers
- Graph directory/licence exporter
- source mapping and setup docs

## What is intentionally not redistributed here

- external private collector source trees
- raw private flow source beyond locally referenced solution zips
- tenant secrets
- tenant data

To reuse a collector, supply an authorized **private local copy** to the package
adapter. The adapted ZIP retains upstream component identifiers where required
for compatibility, adds full-record retention, and is written outside the
repository with source/output hashes. Do **not** publish those assets onward
without separate authorization. Renaming a flow or table would not remove that
requirement.

Some upstream solution and schema identifiers are intentionally preserved solely
for compatibility, including `CopilotInteractionLogging`,
`SharePointAgentLogging`, `poc_sharepointagents`, and the `poc_SP_*`
environment-variable family.

## Functional boundary

This implementation adds a core Dataverse route only when full raw
CopilotInteraction payloads are retained. Summary-only lane C records alone are
rejected because they do not contain the original message evidence required by
the canonical ValueLens processor.

Those gaps are documented in:

- `README.md`
- `source-map.json`

Deployment and refresh helpers default to dry-run/local output; actual cloud
imports and publishing require explicit opt-in. The manual audit-capture helper
does query Graph when invoked (although Dataverse writing is separately opt-in).
