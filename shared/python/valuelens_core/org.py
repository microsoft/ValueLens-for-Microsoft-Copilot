"""Org-data snapshot: port of Copilot_Org_Data_Direct_Ingester.ipynb (pure Python).

Input is the list of Graph `/users` objects (with `manager` expanded); output is the
`copilot_org_data` table as (columns, rows). Every column is a string, as in the notebook.
"""
from __future__ import annotations

import re

TABLE = 'copilot_org_data'
USERS_URL = ('https://graph.microsoft.com/v1.0/users?$select=userPrincipalName,displayName,department,'
             'jobTitle,companyName,officeLocation,city,country,accountEnabled'
             '&$expand=manager($select=userPrincipalName)&$top=999')
MAX_ORG_LEVELS = 14
BASE_COLUMNS = ['PersonId', 'displayName', 'Organization', 'JobTitle', 'companyName', 'officeLocation',
                'city', 'country', 'accountEnabled', 'managerUPN']
HIER_FIXED = ['OrgLevel', 'HierarchyPath', 'TopOfChain_Name', 'IsManager', 'DirectReports']
HIER_LEVELS = [f'Level{i}_Name' for i in range(MAX_ORG_LEVELS + 1)]
HIER_COLUMNS = HIER_FIXED + HIER_LEVELS
COLUMNS = BASE_COLUMNS + HIER_COLUMNS + ['PersonId_Normalized', 'TotalEmployees']
_INVALID = re.compile(r'[ ,;{}()\n\t=]')


def _validate_users_page(data, page_number):
    if not isinstance(data, dict):
        raise ValueError(f'Graph /users page {page_number} did not return an object.')
    if 'value' not in data:
        raise ValueError(f"Graph /users page {page_number} is missing required 'value'; refusing to overwrite org data.")
    value = data['value']
    if not isinstance(value, list):
        raise ValueError(f"Graph /users page {page_number} returned a non-list 'value'; refusing to overwrite org data.")
    next_link = data.get('@odata.nextLink')
    if next_link is not None and (not isinstance(next_link, str) or not next_link.strip()):
        raise ValueError(f"Graph /users page {page_number} returned an invalid '@odata.nextLink'.")
    for item_number, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f'Graph /users page {page_number} item {item_number} is not an object.')
    return value, next_link


validate_users_page = _validate_users_page


def _normalise_identity(value):
    return (value or '').strip().lower()


def _canonical_org_row(user):
    if not isinstance(user, dict):
        raise ValueError('Org data item is not an object.')
    norm = _normalise_identity(user.get('userPrincipalName'))
    if not norm:
        raise ValueError('Org data row is missing userPrincipalName; refusing to write an anonymous identity.')
    manager = user.get('manager')
    manager_upn = ''
    if manager not in (None, ''):
        if not isinstance(manager, dict):
            raise ValueError(f'Org data row {norm!r} has a non-object manager payload.')
        manager_upn = manager.get('userPrincipalName', '') or ''
    return {
        'PersonId':         user.get('userPrincipalName'),
        'displayName':      user.get('displayName'),
        'Organization':     user.get('department'),
        'JobTitle':         user.get('jobTitle'),
        'companyName':      user.get('companyName'),
        'officeLocation':   user.get('officeLocation'),
        'city':             user.get('city'),
        'country':          user.get('country'),
        'accountEnabled':   str(user.get('accountEnabled', '')),
        'managerUPN':       manager_upn,
    }


def _dedupe_org_rows(rows):
    seen = {}
    deduped = []
    for row in rows:
        norm = _normalise_identity(row.get('PersonId'))
        comparable = {key: '' if value is None else str(value).strip() for key, value in row.items()}
        prior = seen.get(norm)
        if prior is None:
            seen[norm] = comparable
            deduped.append(row)
            continue
        if comparable != prior:
            raise ValueError(f'Conflicting org rows detected for {norm!r}; refusing to overwrite a good snapshot.')
    return deduped


def build_hierarchy(rows, max_levels=MAX_ORG_LEVELS):
    """Flatten each person's managerUPN chain into Level0..N + org metadata."""
    def _n(v):
        return (v or '').strip().lower()

    name_of, mgr_of = {}, {}
    for row in rows:
        user = _n(row.get('PersonId'))
        if not user:
            continue
        name_of[user] = (row.get('displayName') or row.get('PersonId') or '').strip()
        mgr_of[user] = _n(row.get('managerUPN'))

    direct = {user: 0 for user in name_of}
    for user, manager in mgr_of.items():
        if manager and manager in direct:
            direct[manager] += 1

    out = {}
    for user in name_of:
        chain, seen_chain, cur = [], set(), user
        while cur and cur in name_of:
            if cur in seen_chain:
                raise ValueError(f'Cycle detected in manager hierarchy at {cur!r}.')
            seen_chain.add(cur)
            chain.append(cur)
            cur = mgr_of.get(cur, '')
        chain = list(reversed(chain))
        rec = {column: '' for column in HIER_COLUMNS}
        for idx in range(max_levels + 1):
            rec[f'Level{idx}_Name'] = name_of.get(chain[idx], '') if idx < len(chain) else ''
        rec['OrgLevel'] = str(len(chain) - 1)
        rec['HierarchyPath'] = ' > '.join(name_of.get(node, node) for node in chain)
        rec['TopOfChain_Name'] = name_of.get(chain[0], '') if chain else ''
        rec['IsManager'] = 'TRUE' if direct.get(user, 0) > 0 else 'FALSE'
        rec['DirectReports'] = str(direct.get(user, 0))
        out[user] = rec
    return out


def build_snapshot(users, *, table_exists=False, allow_empty=False):
    """Graph users -> (columns, rows) for `copilot_org_data`."""
    rows = _dedupe_org_rows([_canonical_org_row(user) for user in users])
    hier = build_hierarchy(rows, MAX_ORG_LEVELS)
    blank = {column: '' for column in HIER_COLUMNS}
    for row in rows:
        row.update(hier.get((row.get('PersonId') or '').strip().lower(), blank))
    total = len(rows)
    if total == 0:
        if table_exists:
            raise ValueError(f'Fetched 0 org rows; refusing to replace existing {TABLE}.')
        if not allow_empty:
            raise ValueError(f'Fetched 0 org rows and {TABLE} does not exist yet. '
                             'Set ALLOW_EMPTY_SNAPSHOT only for an intentional empty first install.')
    out = []
    for row in rows:
        pid = row.get('PersonId')
        out.append([row.get(c) for c in BASE_COLUMNS + HIER_COLUMNS]
                   + [None if pid is None else str(pid).strip().lower(), str(total)])
    return [_INVALID.sub('_', c) for c in COLUMNS], out
