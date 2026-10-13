"""Org-scoped access: the `access_scope` rows an admin manages (pure Python).

The installer writes them as `access_scope.csv`; AnalyticsHub_Access_Scope.ipynb (Fabric) and the Azure
jobs load it with `parse_scope_csv`, which the notebook mirrors (tests check they agree).

    UserPrincipalName  lower-case; '*' is the default for anyone without rows of their own
    ScopeType          'all' | 'hierarchy' (ScopeValue = the root person's UPN) | 'org' (ScopeValue = an org value)
    CanDelegate        'true' | 'false'
    GrantedVia         'seed' | 'installer' (from the CSV) or 'share' (granted in the app, never in the CSV)
    Status             'active' | 'pending_group'
"""
from __future__ import annotations

import csv
import io

SCOPE_TABLE = 'access_scope'
PEOPLE_TABLE = 'access_people'
SCOPE_COLUMNS = ['UserPrincipalName', 'ScopeType', 'ScopeValue', 'CanDelegate', 'GrantedBy', 'GrantedVia',
                 'Status', 'Note', 'CreatedAt']
PEOPLE_COLUMNS = ['PersonId', 'OrgPath']
SCOPE_TYPES = ('all', 'hierarchy', 'org')
STATUSES = ('active', 'pending_group')
MANAGED_VIA = ('seed', 'installer')


def parse_scope_csv(text):
    """CSV text -> validated, de-duplicated rows (dicts keyed by SCOPE_COLUMNS). Raises ValueError on a bad row."""
    reader = csv.DictReader(io.StringIO((text or '').lstrip('\ufeff')))
    header = [h.strip() for h in (reader.fieldnames or [])]
    missing = [c for c in ('UserPrincipalName', 'ScopeType') if c not in header]
    if missing:
        raise ValueError(f'access_scope.csv is missing column(s): {", ".join(missing)}')
    out, seen = [], set()
    for line, raw in enumerate(reader, start=2):
        row = {(k or '').strip(): (v or '').strip() for k, v in raw.items()}
        upn = row.get('UserPrincipalName', '').lower()
        kind = row.get('ScopeType', '').lower()
        if not upn and not kind:
            continue
        if not upn or (upn != '*' and '@' not in upn):
            raise ValueError(f'access_scope.csv line {line}: UserPrincipalName must be a UPN or *.')
        if kind not in SCOPE_TYPES:
            raise ValueError(f'access_scope.csv line {line}: ScopeType must be one of {", ".join(SCOPE_TYPES)}.')
        value = row.get('ScopeValue', '')
        if kind == 'all':
            value = ''
        elif kind == 'hierarchy':
            value = value.lower()
            if '@' not in value:
                raise ValueError(f'access_scope.csv line {line}: a hierarchy scope needs the root person\'s UPN.')
        elif not value:
            raise ValueError(f'access_scope.csv line {line}: an org scope needs a value.')
        via = row.get('GrantedVia', '').lower() or 'installer'
        if via not in MANAGED_VIA:
            raise ValueError(f'access_scope.csv line {line}: GrantedVia must be seed or installer.')
        status = row.get('Status', '').lower() or 'active'
        if status not in STATUSES:
            raise ValueError(f'access_scope.csv line {line}: Status must be active or pending_group.')
        key = (upn, kind, value)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            'UserPrincipalName': upn,
            'ScopeType': kind,
            'ScopeValue': value,
            'CanDelegate': 'true' if row.get('CanDelegate', '').lower() in ('true', '1', 'yes') else 'false',
            'GrantedBy': row.get('GrantedBy', '').lower(),
            'GrantedVia': via,
            'Status': status,
            'Note': row.get('Note', ''),
            'CreatedAt': row.get('CreatedAt', ''),
        })
    return out
