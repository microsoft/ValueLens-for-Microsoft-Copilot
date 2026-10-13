"""Audit log ingestion logic shared with Copilot_Audit_Log_Direct_Ingester.ipynb.

The pure-Python helpers (window keys, canonical record keys) are copied from the
notebook's cell 6 and are checked against it by tests/test_valuelens_core_audit.py.
`flatten()` is the DuckDB port of the notebook's cells 14-18 (parse AuditData,
fan out prompt x resource, derive Agent_TitleID / Agent_EntraId) and is verified
row for row against Spark goldens.
"""
from __future__ import annotations

import hashlib
import json
import random
import threading
import time
from datetime import datetime, timedelta, timezone

WINDOW_KEY_VERSION = 2
KEY_COLUMNS = ['Id', 'Source_RecordKey', 'Source_MessageKey', 'Source_ResourceKey']
STAGE_COLUMNS = ['RecordId', 'CreationDate', 'RecordType', 'Operation',
                 'AuditData', 'SourceRecordKey', 'AssociatedAdminUnits', 'AssociatedAdminUnitsNames']
PARSED_COLUMNS = [
    'Id', 'RecordId', 'Source_RecordKey', 'Source_MessageKey', 'Source_ResourceKey',
    'CreationDate', 'AgentId', 'AgentName',
    'AppIdentity_AppId', 'AppIdentity_DisplayName', 'AppIdentity_PublisherId',
    'ApplicationName', 'ClientRegion',
    'Audit_UserId', 'Audit_UserId_Normalized', 'Workload',
    'AppHost', 'ThreadId', 'SensitivityLabelId',
    'Context_Type',
    'AISystemPlugin_Id', 'AISystemPlugin_Name',
    'ModelTransparencyDetails_ModelName',
    'AccessedResource_Type', 'AccessedResource_Action', 'AccessedResource_SiteUrl',
    'AccessedResource_SensitivityLabelId',
    'Message_Id', 'Message_isPrompt', 'Message_Ordinal', 'Resource_Ordinal', 'Resource_Count',
    'InteractionDate', 'WeekStart', 'MonthStart', 'Agent_TitleID', 'Agent_EntraId',
]
_SYNTHETIC_AUDIT_FIELDS = frozenset({'_StableKey', '_StableOrdinal'})


# ------------------------------------------------------------------ notebook cell 6 (verbatim)
def _as_utc_datetime(value):
    if value in (None, ''):
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _norm_text(value) -> str:
    if value is None:
        return ''
    return ' '.join(str(value).strip().split())


def _coerce_json_value(value):
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return value


def _has_meaningful_value(value) -> bool:
    if isinstance(value, dict):
        return any(_has_meaningful_value(v) for k, v in value.items() if k not in _SYNTHETIC_AUDIT_FIELDS)
    if isinstance(value, list):
        return any(_has_meaningful_value(v) for v in value)
    if value is None:
        return False
    if isinstance(value, str):
        return _norm_text(value) != ''
    return True


def _canonical_json_text(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def _stable_message_base_key(message) -> str:
    message = dict(message or {})
    msg_id = _norm_text(message.get('Id'))
    if msg_id:
        return f'mid:{msg_id}'
    payload = {k: v for k, v in message.items() if k not in _SYNTHETIC_AUDIT_FIELDS and k != 'Id'}
    return 'msgf:' + hashlib.sha256(_canonical_json_text(payload).encode('utf-8')).hexdigest()


def _stable_resource_base_key(resource) -> str:
    resource = dict(resource or {})
    payload = {k: v for k, v in resource.items() if k not in _SYNTHETIC_AUDIT_FIELDS}
    if not _has_meaningful_value(payload):
        return 'resource:none'
    return 'resource:' + hashlib.sha256(_canonical_json_text(payload).encode('utf-8')).hexdigest()


def _stable_sequence(items, base_key_builder, path) -> list:
    prepared = []
    for item in items or []:
        canonical_item = _canonicalize_json(item, path)
        if not isinstance(canonical_item, dict):
            canonical_item = {'Value': canonical_item}
        canonical_text = _canonical_json_text(canonical_item)
        base_key = base_key_builder(canonical_item)
        prepared.append((base_key, canonical_text, canonical_item))
    prepared.sort(key=lambda entry: (entry[0], entry[1]))
    totals = {}
    for base_key, _canonical_text, _item in prepared:
        totals[base_key] = totals.get(base_key, 0) + 1
    seen = {}
    stable = []
    for ordinal, (base_key, _canonical_text, canonical_item) in enumerate(prepared):
        seen[base_key] = seen.get(base_key, 0) + 1
        stable_key = base_key if totals[base_key] == 1 else f'{base_key}#{seen[base_key]}'
        enriched = dict(canonical_item)
        enriched['_StableKey'] = stable_key
        enriched['_StableOrdinal'] = ordinal
        stable.append(enriched)
    return stable


def _canonicalize_json(value, path=()):
    value = _coerce_json_value(value) if not path else value
    if isinstance(value, dict):
        return {
            str(key): _canonicalize_json(val, path + (str(key),))
            for key, val in sorted(value.items(), key=lambda item: str(item[0]))
            if key not in _SYNTHETIC_AUDIT_FIELDS
        }
    if isinstance(value, list):
        if path == ('CopilotEventData', 'Messages'):
            return _stable_sequence(value, _stable_message_base_key, path)
        if path == ('CopilotEventData', 'AccessedResources'):
            return _stable_sequence(value, _stable_resource_base_key, path)
        return [_canonicalize_json(item, path) for item in value]
    return value


def canonicalize_audit_payload(audit_data):
    value = _coerce_json_value(audit_data)
    if value is None:
        return None
    return _canonicalize_json(value)


def determine_incremental_start(end_dt, high_water_mark, lookback_days: int):
    lookback_days = max(int(lookback_days), 0)
    lookback_floor = end_dt - timedelta(days=lookback_days)
    hw = _as_utc_datetime(high_water_mark)
    if hw is None:
        return lookback_floor
    return min(hw, lookback_floor)


def build_source_record_key(
    record_id,
    creation_date=None,
    operation=None,
    audit_data=None,
    record_type=None,
    associated_admin_units=None,
    associated_admin_units_names=None,
) -> str:
    rid = _norm_text(record_id)
    if rid:
        return f"rid:{rid}"
    payload = {
        'CreationDate': _norm_text(creation_date),
        'Operation': _norm_text(operation),
        'RecordType': _norm_text(record_type),
        'AuditData': canonicalize_audit_payload(audit_data),
        'AssociatedAdminUnits': _canonicalize_json(associated_admin_units or []),
        'AssociatedAdminUnitsNames': _canonicalize_json(associated_admin_units_names or []),
    }
    return 'synthetic:' + hashlib.sha256(_canonical_json_text(payload).encode('utf-8')).hexdigest()


def canonicalize_audit_record(record) -> dict:
    record = record or {}
    audit_payload = canonicalize_audit_payload(record.get('auditData'))
    return {
        'RecordId': record.get('id'),
        'CreationDate': record.get('createdDateTime'),
        'RecordType': record.get('auditLogRecordType'),
        'Operation': record.get('operation'),
        'AuditData': _canonical_json_text(audit_payload) if audit_payload is not None else None,
        'SourceRecordKey': build_source_record_key(
            record.get('id'),
            record.get('createdDateTime'),
            record.get('operation'),
            audit_payload,
            record_type=record.get('auditLogRecordType'),
            associated_admin_units=record.get('associatedAdminUnits', []),
            associated_admin_units_names=record.get('associatedAdminUnitsNames', []),
        ),
        'AssociatedAdminUnits': _canonical_json_text(_canonicalize_json(record.get('associatedAdminUnits', []))),
        'AssociatedAdminUnitsNames': _canonical_json_text(_canonicalize_json(record.get('associatedAdminUnitsNames', []))),
    }


def stable_window_key(win_start, win_end) -> str:
    ws = _as_utc_datetime(win_start)
    we = _as_utc_datetime(win_end)
    return f"v{WINDOW_KEY_VERSION}_{ws:%Y%m%d%H%M}_{we:%Y%m%d%H%M}"


# ------------------------------------------------------------------ notebook cell 6 (window loop)
def build_windows(start_date, end_date, chunk_hours: int):
    """Same window grid as the notebook: anchored to a multiple of chunk_hours."""
    anchor_hour = start_date.hour - (start_date.hour % chunk_hours)
    cur = start_date.replace(hour=anchor_hour, minute=0, second=0, microsecond=0)
    windows = []
    while cur < end_date:
        nxt = min(cur + timedelta(hours=chunk_hours), end_date)
        windows.append((cur, nxt))
        cur = nxt
    return windows


# ------------------------------------------------------------------ notebook cell 6: failed-window recovery (verbatim)
def split_window(win_start, win_end, min_hours):
    """Halves of a window for another try at a smaller size; [] when a half would be under min_hours."""
    ws = _as_utc_datetime(win_start)
    we = _as_utc_datetime(win_end)
    half_minutes = int((we - ws).total_seconds() // 60) // 2
    if half_minutes <= 0 or half_minutes < float(min_hours) * 60:
        return []
    mid = win_start + timedelta(minutes=half_minutes)
    return [(win_start, mid), (mid, win_end)]


def expand_split_windows(manifest, win_start, win_end, min_hours, include_parents=False):
    """The windows to query for one grid window: its halves (recursively) if an earlier run split it."""
    entry = (manifest or {}).get(stable_window_key(win_start, win_end))
    halves = []
    if isinstance(entry, dict) and entry.get('status') == 'split':
        halves = split_window(win_start, win_end, min_hours)
    if not halves:
        return [(win_start, win_end)]
    out = [(win_start, win_end)] if include_parents else []
    for ws, we in halves:
        out.extend(expand_split_windows(manifest, ws, we, min_hours, include_parents))
    return out


def retry_delay(attempt, base_seconds, max_seconds, rand=random.random):
    """Exponential backoff with jitter: base, 2x base, 4x base ... capped at max_seconds, times 50-100%."""
    raw = min(float(max_seconds), float(base_seconds) * (2 ** max(int(attempt) - 1, 0)))
    return max(0.0, raw * (0.5 + 0.5 * rand()))


class AdaptiveLimiter:
    """Caps concurrent audit queries. Failures and throttling lower the cap for the rest of the run.

    A burst of failures with one cause (several windows failing in the same second) counts once:
    the cap moves at most once per cooldown_seconds.
    """

    def __init__(self, limit, minimum=1, cooldown_seconds=60, clock=time.monotonic):
        self.minimum = max(1, int(minimum))
        self.limit = max(self.minimum, int(limit))
        self.active = 0
        self.history = []
        self._cooldown = float(cooldown_seconds)
        self._clock = clock
        self._last_shrink = None
        self._cond = threading.Condition()

    def __enter__(self):
        with self._cond:
            while self.active >= self.limit:
                self._cond.wait()
            self.active += 1
        return self

    def __exit__(self, *exc):
        with self._cond:
            self.active -= 1
            self._cond.notify_all()
        return False

    def shrink(self, reason, halve=False):
        with self._cond:
            now = self._clock()
            if self._last_shrink is not None and now - self._last_shrink < self._cooldown:
                return False
            new = max(self.minimum, self.limit // 2 if halve else self.limit - 1)
            if new >= self.limit:
                return False
            self.history.append((self.limit, new, reason))
            self.limit, self._last_shrink = new, now
            return True


def _manifest_range(entry):
    if not isinstance(entry, dict):
        return None
    try:
        ws = _as_utc_datetime(entry.get('window_start'))
        we = _as_utc_datetime(entry.get('window_end'))
    except (TypeError, ValueError):
        return None
    return (ws, we) if ws and we and ws < we else None


def uncovered_failed_ranges(manifest, not_before, before):
    """Time ranges in [not_before, before) of unfinished windows that no succeeded window covers."""
    lo = _as_utc_datetime(not_before)
    hi = _as_utc_datetime(before)
    entries = [e for e in (manifest or {}).values() if isinstance(e, dict)]
    covered = sorted(r for r in (_manifest_range(e) for e in entries if e.get('status') == 'succeeded') if r)
    gaps = []
    for entry in entries:
        if entry.get('status') in ('succeeded', 'split'):
            continue
        rng = _manifest_range(entry)
        if not rng:
            continue
        pieces = [(max(rng[0], lo), min(rng[1], hi))]
        for cs, ce in covered:
            pieces = [p for s, e in pieces for p in ((s, min(e, cs)), (max(s, ce), e)) if p[0] < p[1]]
        gaps.extend(pieces)
    merged = []
    for s, e in sorted(gaps):
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


# ------------------------------------------------------------------ cells 14-18 (DuckDB)
_GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'


def _scalar(path: str, src: str = 'j') -> str:
    # Spark's from_json renders a scalar into a StringType field as its text; objects and
    # arrays as JSON text. json_extract_string matches both.
    return f"json_extract_string({src}, '{path}')"


def is_cowork_autonomous(audit_data: dict) -> bool:
    """True for M365 Copilot Cowork scheduled/autonomous audit records."""
    audit_data = audit_data or {}
    ced = audit_data.get('CopilotEventData') or {}
    app_host = str(ced.get('AppHost') or '').strip().lower()
    app_identity = str(audit_data.get('AppIdentity') or '').strip().lower()
    return app_host == 'cowork' or app_identity.startswith('copilot.m365copilot.cowork')


def flatten(con, staged_src: str):
    """Parse staged audit records into the Copilot_Interactions_Parsed shape.

    `staged_src` is any DuckDB relation expression with the STAGE_COLUMNS (as written by
    canonicalize_audit_record). Returns a DuckDB relation with PARSED_COLUMNS.
    """
    con.execute("SET TimeZone = 'UTC'")
    base = f"""
    WITH raw AS (
        SELECT RecordId, Operation, AuditData, SourceRecordKey,
               TRY(json(AuditData)) AS j
        FROM {staged_src}
        WHERE AuditData IS NOT NULL AND length(AuditData) > 10
    ), parsed AS (
        SELECT * FROM raw WHERE j IS NOT NULL AND json_type(j) = 'OBJECT'
    ), base AS (
        SELECT
            RecordId, Operation, SourceRecordKey AS _SourceRecordKey,
            TRY_CAST({_scalar('$.CreationTime')} AS TIMESTAMP) AS CreationDate,
            {_scalar('$.AgentId')} AS AgentId,
            {_scalar('$.AgentName')} AS AgentName,
            {_scalar('$.AppIdentity.AppId')} AS AppIdentity_AppId,
            {_scalar('$.AppIdentity.DisplayName')} AS AppIdentity_DisplayName,
            {_scalar('$.AppIdentity.PublisherId')} AS AppIdentity_PublisherId,
            {_scalar('$.AppIdentity')} AS AppIdentity_Text,
            {_scalar('$.AgentPlatform')} AS AgentPlatform,
            {_scalar('$.ApplicationName')} AS ApplicationName,
            {_scalar('$.ClientRegion')} AS ClientRegion,
            {_scalar('$.UserId')} AS Audit_UserId,
            lower(trim({_scalar('$.UserId')})) AS Audit_UserId_Normalized,
            {_scalar('$.Workload')} AS Workload,
            {_scalar('$.CopilotEventData.AppHost')} AS AppHost,
            {_scalar('$.CopilotEventData.ThreadId')} AS ThreadId,
            {_scalar('$.CopilotEventData.SensitivityLabelId')} AS SensitivityLabelId,
            {_scalar('$.CopilotEventData.Contexts[0].Type')} AS Context_Type,
            {_scalar('$.CopilotEventData.AISystemPlugin[0].Id')} AS AISystemPlugin_Id,
            {_scalar('$.CopilotEventData.AISystemPlugin[0].Name')} AS AISystemPlugin_Name,
            {_scalar('$.CopilotEventData.ModelTransparencyDetails[0].ModelName')}
                AS ModelTransparencyDetails_ModelName,
            CASE WHEN json_type(j, '$.CopilotEventData.AccessedResources') = 'ARRAY'
                 THEN CAST(json_extract(j, '$.CopilotEventData.AccessedResources') AS JSON[]) END AS Resources,
            CASE WHEN json_type(j, '$.CopilotEventData.Messages') = 'ARRAY'
                 THEN CAST(json_extract(j, '$.CopilotEventData.Messages') AS JSON[]) END AS Messages
        FROM parsed
    )
    SELECT * FROM base
    """
    con.execute(f"CREATE OR REPLACE TEMP TABLE __vl_audit_base AS {base}")
    ambiguous = con.execute("""
        SELECT 1 FROM __vl_audit_base
        WHERE length(trim(coalesce(CAST(RecordId AS VARCHAR), ''))) = 0
          AND length(trim(coalesce(CAST(_SourceRecordKey AS VARCHAR), ''))) > 0
        GROUP BY _SourceRecordKey HAVING count(*) > 1 LIMIT 1""").fetchall()
    if ambiguous:
        raise RuntimeError(
            "Missing RecordId produced ambiguous synthetic SourceRecordKey values; refusing unsafe dedup.")

    con.execute(f"""
    CREATE OR REPLACE TEMP TABLE __vl_audit_flat AS
    WITH keyed AS (
        SELECT *,
            CASE WHEN length(trim(coalesce(_SourceRecordKey, ''))) > 0 THEN trim(_SourceRecordKey)
                 WHEN length(trim(coalesce(RecordId, ''))) > 0 THEN 'rid:' || trim(RecordId)
            END AS Source_RecordKey,
            len(CASE WHEN Messages IS NULL THEN []::JSON[] ELSE list_filter(
                Messages, m -> lower(json_extract_string(m, '$.isPrompt')) = 'true') END) > 0 AS Has_Prompt,
            regexp_replace(lower(coalesce(AgentPlatform, '')), '\\s', '', 'g') = 'copilotstudio'
                AS Is_Copilot_Studio_Runtime,
            lower(trim(coalesce(AppHost, ''))) = 'cowork'
                OR starts_with(lower(trim(coalesce(AppIdentity_Text, ''))), 'copilot.m365copilot.cowork')
                AS Is_Cowork_Autonomous,
            -- Spark size(NULL) is -1 (legacy sizeOfNull), so coalesce(size, 1) keeps -1.
            CASE WHEN Resources IS NULL THEN -1 ELSE len(Resources) END AS Resource_Count
        FROM __vl_audit_base
    ), task_keyed AS (
        SELECT *,
            (NOT Has_Prompt) AND (Is_Copilot_Studio_Runtime OR Is_Cowork_Autonomous)
                AS Task_Row_Placeholder
        FROM keyed
    ), msgs AS (
        SELECT k.*, m.ord - 1 AS Message_ArrayOrdinal, m.msg
        FROM task_keyed k,
        LATERAL (
            SELECT unnest(
                    CASE WHEN k.Task_Row_Placeholder THEN
                              ['{{"Id":"message:none","isPrompt":false,"_StableKey":"message:none","_StableOrdinal":0}}'::JSON]
                         WHEN len(k.Messages) > 0 THEN k.Messages
                         ELSE [NULL::JSON] END) AS msg,
                   generate_subscripts(
                    CASE WHEN k.Task_Row_Placeholder THEN
                              ['{{"Id":"message:none","isPrompt":false,"_StableKey":"message:none","_StableOrdinal":0}}'::JSON]
                         WHEN len(k.Messages) > 0 THEN k.Messages
                         ELSE [NULL::JSON] END, 1) AS ord
        ) m
        WHERE lower({_scalar('$.isPrompt', 'm.msg')}) = 'true' OR k.Task_Row_Placeholder
    ), res AS (
        SELECT g.*, r.ord - 1 AS Resource_ArrayOrdinal, r.res
        FROM msgs g,
        LATERAL (SELECT unnest(CASE WHEN g.Task_Row_Placeholder THEN ['{{"_StableKey":"resource:none","_StableOrdinal":0}}'::JSON]
                                    WHEN len(g.Resources) > 0 THEN g.Resources
                                    ELSE ['{{"_StableKey":"resource:none","_StableOrdinal":0}}'::JSON] END) AS res,
                        generate_subscripts(CASE WHEN g.Task_Row_Placeholder THEN ['{{}}'::JSON]
                                                 WHEN len(g.Resources) > 0 THEN g.Resources
                                                 ELSE ['{{}}'::JSON] END, 1) AS ord) r
    )
    SELECT *,
        trim({_scalar('$._StableKey', 'msg')}) AS Source_MessageKey,
        trim({_scalar('$._StableKey', 'res')}) AS Source_ResourceKey,
        coalesce(TRY_CAST({_scalar('$._StableOrdinal', 'msg')} AS BIGINT), Message_ArrayOrdinal) AS Message_Ordinal,
        coalesce(TRY_CAST({_scalar('$._StableOrdinal', 'res')} AS BIGINT), Resource_ArrayOrdinal, 0) AS Resource_Ordinal
    FROM res
    """)
    missing = con.execute("""
        SELECT 1 FROM __vl_audit_flat
        WHERE length(trim(coalesce(Source_RecordKey, ''))) = 0
           OR length(trim(coalesce(Source_MessageKey, ''))) = 0
           OR length(trim(coalesce(Source_ResourceKey, ''))) = 0 LIMIT 1""").fetchall()
    if missing:
        raise RuntimeError(
            "Canonical audit identity fields are missing from staged data; "
            "rerun ingestion with the canonical stage helpers.")

    return con.sql(f"""
    WITH ided AS (
        SELECT
            sha256(concat_ws('||', Source_RecordKey, Source_MessageKey, Source_ResourceKey)) AS Id,
            RecordId, Source_RecordKey, Source_MessageKey, Source_ResourceKey,
            CreationDate, AgentId, AgentName,
            AppIdentity_AppId, AppIdentity_DisplayName, AppIdentity_PublisherId,
            ApplicationName, ClientRegion,
            Audit_UserId, Audit_UserId_Normalized, Workload,
            AppHost, ThreadId, SensitivityLabelId,
            Context_Type, AISystemPlugin_Id, AISystemPlugin_Name,
            ModelTransparencyDetails_ModelName,
            {_scalar('$.Type', 'res')} AS AccessedResource_Type,
            {_scalar('$.Action', 'res')} AS AccessedResource_Action,
            {_scalar('$.SiteUrl', 'res')} AS AccessedResource_SiteUrl,
            {_scalar('$.SensitivityLabelId', 'res')} AS AccessedResource_SensitivityLabelId,
            {_scalar('$.Id', 'msg')} AS Message_Id,
            {_scalar('$.isPrompt', 'msg')} AS Message_isPrompt,
            CAST(Message_Ordinal AS BIGINT) AS Message_Ordinal,
            CAST(Resource_Ordinal AS BIGINT) AS Resource_Ordinal,
            CAST(coalesce(Resource_Count, 1) AS BIGINT) AS Resource_Count,
            CAST(CreationDate AS DATE) AS InteractionDate,
            CAST(date_trunc('week', CreationDate) AS DATE) AS WeekStart,
            CAST(date_trunc('month', CreationDate) AS DATE) AS MonthStart
        FROM __vl_audit_flat
        QUALIFY row_number() OVER (PARTITION BY Id ORDER BY Message_Ordinal, Resource_Ordinal) = 1
    ), titled AS (
        SELECT *,
            CASE
              WHEN AgentId IS NULL THEN NULL
              WHEN AgentId LIKE '%CopilotStudio.Declarative.%' THEN
                   string_split(string_split(AgentId, 'CopilotStudio.Declarative.')[2], '.')[1]
              WHEN starts_with(AgentId, 'P_') OR starts_with(AgentId, 'T_') THEN
                   string_split(AgentId, '.')[1]
              ELSE NULL
            END AS Agent_TitleID
        FROM ided
    )
    SELECT *,
        CASE
          WHEN Agent_TitleID IS NOT NULL THEN NULL
          WHEN AgentId IS NULL THEN NULL
          ELSE nullif(regexp_extract(AgentId, '{_GUID}', 0), '')
        END AS Agent_EntraId
    FROM titled
    """)
