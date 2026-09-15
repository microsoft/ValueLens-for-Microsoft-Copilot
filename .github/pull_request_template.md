## Summary

Describe what changed and why. Link the related issue, if any.

## Scope

Deployment paths affected (Local CSV / SharePoint / Fabric / Power Automate + Dataverse):

Source contracts, optional inputs or refresh behaviour changed:

## Validation

- [ ] Ran `python -B -m pytest tests -q` and recorded results below.
- [ ] If canonical Fabric notebooks changed, ran `scripts/sync-shared.ps1` and its `-Check` mode.
- [ ] Updated directly related documentation and checked changed links.
- [ ] No credentials, tenant exports, prompts or private solution packages are included.
- [ ] If `.pbit` files changed, documented the rebuild method and Desktop refresh / visual checks.

Results, skipped checks and limitations:

## Compatibility

Describe migration steps, binary-template changes and anything deliberately left unchanged.
