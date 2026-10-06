"""M365 activity: port of Copilot_M365_Activity_Ingester.ipynb (pure Python).

Six Graph per-day user-detail reports are folded into one row per person per day for
`m365_activity_daily`. Column names, types and the day-selection rule match the notebook.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timedelta

TABLE = 'm365_activity_daily'
REREAD_DAYS = 4
REPORTS = {
    'teams':      'getTeamsUserActivityUserDetail',
    'email':      'getEmailActivityUserDetail',
    'sharepoint': 'getSharePointActivityUserDetail',
    'onedrive':   'getOneDriveActivityUserDetail',
    'vivaengage': 'getYammerActivityUserDetail',
    'apps':       'getM365AppUserDetail',
}

COUNTS = [
    ('TeamsChatMessages',               'teams',      ['Team Chat Message Count']),
    ('TeamsPrivateChatMessages',        'teams',      ['Private Chat Message Count']),
    ('TeamsCalls',                      'teams',      ['Call Count']),
    ('TeamsMeetings',                   'teams',      ['Meeting Count']),
    ('TeamsMeetingsOrganized',          'teams',      ['Meetings Organized Count']),
    ('TeamsMeetingsAttended',           'teams',      ['Meetings Attended Count']),
    ('TeamsPostMessages',               'teams',      ['Post Messages']),
    ('TeamsReplyMessages',              'teams',      ['Reply Messages']),
    ('TeamsAudioSeconds',               'teams',      ['Audio Duration In Seconds', 'Audio Duration']),
    ('TeamsVideoSeconds',               'teams',      ['Video Duration In Seconds', 'Video Duration']),
    ('TeamsScreenShareSeconds',         'teams',      ['Screen Share Duration In Seconds', 'Screen Share Duration']),
    ('EmailSent',                       'email',      ['Send Count']),
    ('EmailReceived',                   'email',      ['Receive Count']),
    ('EmailRead',                       'email',      ['Read Count']),
    ('EmailMeetingsCreated',            'email',      ['Meeting Created Count']),
    ('EmailMeetingsInteracted',         'email',      ['Meeting Interacted Count']),
    ('SharePointFilesViewedOrEdited',   'sharepoint', ['Viewed Or Edited File Count']),
    ('SharePointFilesSynced',           'sharepoint', ['Synced File Count']),
    ('SharePointFilesSharedInternally', 'sharepoint', ['Shared Internally File Count']),
    ('SharePointFilesSharedExternally', 'sharepoint', ['Shared Externally File Count']),
    ('SharePointPagesVisited',          'sharepoint', ['Visited Page Count']),
    ('OneDriveFilesViewedOrEdited',     'onedrive',   ['Viewed Or Edited File Count']),
    ('OneDriveFilesSynced',             'onedrive',   ['Synced File Count']),
    ('OneDriveFilesSharedInternally',   'onedrive',   ['Shared Internally File Count']),
    ('OneDriveFilesSharedExternally',   'onedrive',   ['Shared Externally File Count']),
    ('VivaEngagePosts',                 'vivaengage', ['Posted Count']),
    ('VivaEngageReads',                 'vivaengage', ['Read Count']),
    ('VivaEngageLikes',                 'vivaengage', ['Liked Count']),
]
FLAGS = [
    ('AppOutlook',      'apps', ['Outlook']),
    ('AppWord',         'apps', ['Word']),
    ('AppExcel',        'apps', ['Excel']),
    ('AppPowerPoint',   'apps', ['PowerPoint']),
    ('AppOneNote',      'apps', ['OneNote']),
    ('AppTeams',        'apps', ['Teams']),
    ('PlatformWindows', 'apps', ['Windows']),
    ('PlatformMac',     'apps', ['Mac']),
    ('PlatformMobile',  'apps', ['Mobile']),
    ('PlatformWeb',     'apps', ['Web']),
]
ACTIVE = {
    'TeamsActive':      ['TeamsChatMessages', 'TeamsPrivateChatMessages', 'TeamsCalls', 'TeamsMeetings',
                         'TeamsMeetingsOrganized', 'TeamsMeetingsAttended', 'TeamsPostMessages', 'TeamsReplyMessages'],
    'EmailActive':      ['EmailSent', 'EmailRead', 'EmailMeetingsCreated', 'EmailMeetingsInteracted'],
    'SharePointActive': [c for c, r, _ in COUNTS if r == 'sharepoint'],
    'OneDriveActive':   [c for c, r, _ in COUNTS if r == 'onedrive'],
    'VivaEngageActive': [c for c, r, _ in COUNTS if r == 'vivaengage'],
    'AppsActive':       ['AppWord', 'AppExcel', 'AppPowerPoint', 'AppOneNote'],
}
VALUE_COLUMNS = [c for c, _, _ in COUNTS] + [c for c, _, _ in FLAGS]

# (name, DuckDB type, nullable) - the notebook's Spark SCHEMA.
SCHEMA = (
    [('ActivityDate', 'DATE', False), ('WeekStart', 'DATE', False), ('UPN', 'VARCHAR', False),
     ('UPN_Normalized', 'VARCHAR', False), ('ReportRefreshDate', 'DATE', True)]
    + [(c, 'BIGINT', False) for c, _, _ in COUNTS]
    + [(c, 'INTEGER', False) for c, _, _ in FLAGS]
    + [(c, 'INTEGER', False) for c in ACTIVE]
    + [('WorkloadsActive', 'INTEGER', False), ('LoadedAtUtc', 'TIMESTAMP', False)]
)
COLUMNS = [name for name, _, _ in SCHEMA]

_ISO_DURATION = re.compile(r'^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$')


class ReportUnavailable(Exception):
    """Microsoft has no report for this day."""


def parse_csv(content: bytes):
    return list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))


def _number(value):
    text = (value or '').strip()
    if not text:
        return 0
    try:
        return int(float(text))
    except ValueError:
        m = _ISO_DURATION.match(text.upper())
        if not m:
            return 0
        d, h, mi, s = (float(g or 0) for g in m.groups())
        return int(d * 86400 + h * 3600 + mi * 60 + s)


def _flag(value):
    return 1 if (value or '').strip().lower() in ('yes', 'true', '1') else 0


def _date(value):
    try:
        return datetime.strptime((value or '').strip()[:10], '%Y-%m-%d').date()
    except ValueError:
        return None


def _pick(record, names):
    for name in names:
        if name.lower() in record:
            return record[name.lower()]
    return ''


BY_REPORT = {
    key: ([(c, n) for c, r, n in COUNTS if r == key], [(c, n) for c, r, n in FLAGS if r == key])
    for key in REPORTS
}


def add_report(people, key, records):
    counts, flags = BY_REPORT[key]
    for raw in records:
        record = {(k or '').strip().lower(): v for k, v in raw.items()}
        upn = (record.get('user principal name') or '').strip()
        if not upn:
            continue
        person = people.setdefault(upn.lower(), {'UPN': upn, 'ReportRefreshDate': None})
        refreshed = _date(record.get('report refresh date'))
        if refreshed and (person['ReportRefreshDate'] is None or refreshed > person['ReportRefreshDate']):
            person['ReportRefreshDate'] = refreshed
        for column, names in counts:
            person[column] = person.get(column, 0) + _number(_pick(record, names))
        for column, names in flags:
            person[column] = max(person.get(column, 0), _flag(_pick(record, names)))


def days_to_load(today, loaded, concealed_days, reread_days, window_days=28):
    recent = today - timedelta(days=reread_days)
    window = [today - timedelta(days=n) for n in range(window_days, 0, -1)]
    return [day for day in window if day not in loaded or day >= recent or day in concealed_days]


def build_rows(day, people, loaded_at):
    week_start = day - timedelta(days=day.weekday())
    rows = []
    for key, person in people.items():
        values = [person.get(c, 0) for c in VALUE_COLUMNS]
        if not any(values):
            continue
        active = [1 if any(person.get(c, 0) for c in cols) else 0 for cols in ACTIVE.values()]
        rows.append(tuple([day, week_start, person['UPN'], key, person['ReportRefreshDate']]
                          + values + active + [sum(active), loaded_at]))
    return rows
