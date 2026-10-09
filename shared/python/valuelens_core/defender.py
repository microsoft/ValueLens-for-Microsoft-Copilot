"""Defender (shadow AI and agent risk): shared by Copilot_Defender_Ingester.ipynb and the Azure jobs.

Reads Microsoft Defender through app-only Microsoft Graph:

* advanced hunting (`POST /v1.0/security/runHuntingQuery`, ThreatHunting.Read.All) for AI tools that
  ran on, or were reached from, onboarded devices (DeviceProcessEvents, DeviceNetworkEvents), AI tools
  installed on them (DeviceTvmSoftwareInventory), and agent configuration (AgentsInfo, or the older
  AIAgentsInfo);
* Cloud Discovery (`GET /beta/security/dataDiscovery/cloudAppDiscovery`, CloudApp-Discovery.Read.All)
  for generative AI apps seen in the tenant's discovery streams.

Each probe runs on its own and fails soft: a 403, an unlicensed tenant, a missing table or an empty
answer becomes a `defender_status` row and the run carries on. Device names and user names never leave
Defender: the queries return distinct counts only.

The notebook embeds this module's code unchanged (a test checks it), so it uses the standard library only.
"""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import date, datetime, timedelta, timezone

HUNTING_URL = 'https://graph.microsoft.com/v1.0/security/runHuntingQuery'
CLOUD_DISCOVERY_URL = 'https://graph.microsoft.com/beta/security/dataDiscovery/cloudAppDiscovery'
# Cloud Discovery returns these categories only when asked for evolvable enum members.
CLOUD_DISCOVERY_HEADERS = {'Prefer': 'include-unknown-enum-members'}
AI_CATEGORIES = ('generativeAi', 'aiModelProvider', 'mcpServer', 'clientAiApp')
CLOUD_DISCOVERY_PERIOD = 'P30D'
MAX_PAGES = 50

# Advanced hunting keeps 30 days. The oldest of those days is cut part way through, so a first
# load reads the 29 complete days before it; later loads re-read the last loaded day for late events.
LOOKBACK_DAYS = 30
FIRST_LOAD_DAYS = 29
WINDOWS = (('7d', 7), ('30d', LOOKBACK_DAYS))
LAYERS = ('Ran', 'Network')
ANY_LAYER = 'Any'
# Local system, local service and network service: not a person.
SERVICE_SIDS = ('S-1-5-18', 'S-1-5-19', 'S-1-5-20')

POSTURES = ('Sanctioned', 'Not reviewed', 'Unsanctioned')
DEFAULT_POSTURE = 'Not reviewed'

TABLES = {
    'watchlist': 'defender_ai_watchlist',
    'daily': 'defender_shadow_ai_daily',
    'totals': 'defender_shadow_ai_totals_daily',
    'installed': 'defender_ai_installed',
    'cloud': 'defender_cloud_discovery_ai',
    'agents': 'defender_ai_agents',
    'status': 'defender_status',
}

# (name, type) per table. Types: string, long, date, timestamp.
COLUMNS = {
    'watchlist': [('Tool', 'string'), ('Category', 'string'), ('Vendor', 'string'), ('Posture', 'string'),
                  ('ProcessNames', 'string'), ('Domains', 'string'), ('InstallPrefixes', 'string')],
    'daily': [('Day', 'date'), ('Window', 'string'), ('Layer', 'string'), ('Tool', 'string'),
              ('Devices', 'long'), ('Users', 'long'), ('Events', 'long'), ('LoadedAt', 'timestamp')],
    'totals': [('Day', 'date'), ('Window', 'string'), ('Layer', 'string'),
               ('Devices', 'long'), ('Users', 'long'), ('Events', 'long'), ('LoadedAt', 'timestamp')],
    'installed': [('SnapshotDate', 'date'), ('Tool', 'string'), ('Devices', 'long'), ('SoftwareNames', 'string'),
                  ('LoadedAt', 'timestamp')],
    'cloud': [('SnapshotDate', 'date'), ('StreamId', 'string'), ('StreamName', 'string'), ('AppId', 'string'),
              ('AppName', 'string'), ('Category', 'string'), ('RiskScore', 'long'), ('Users', 'long'),
              ('Devices', 'long'), ('IpAddresses', 'long'), ('Transactions', 'long'), ('UploadBytes', 'long'),
              ('DownloadBytes', 'long'), ('LastSeen', 'timestamp'), ('Tags', 'string'), ('Posture', 'string'),
              ('WatchlistTool', 'string'), ('LoadedAt', 'timestamp')],
    'agents': [('SnapshotDate', 'date'), ('AgentId', 'string'), ('AgentName', 'string'), ('Platform', 'string'),
               ('SourceTable', 'string'), ('EntraAgentId', 'string'), ('BotId', 'string'), ('AppId', 'string'),
               ('AuthenticationType', 'string'), ('SignInRequired', 'string'), ('UsesWebKnowledge', 'string'),
               ('PublishedStatus', 'string'), ('LifecycleStatus', 'string'), ('Availability', 'string'),
               ('LoadedAt', 'timestamp')],
    'status': [('RunAt', 'timestamp'), ('Probe', 'string'), ('Status', 'string'), ('Source', 'string'),
               ('Rows', 'long'), ('Message', 'string')],
}

PROBES = ('device_activity', 'installed', 'agents', 'cloud_discovery')
STATUSES = ('ok', 'empty', 'forbidden', 'unlicensed', 'error')

# The starting watchlist. Admins edit the copy in Files/defender/ai_watchlist.csv (Fabric) or
# landing/defender/ai_watchlist.csv (Azure); only an admin-set "Unsanctioned" counts as unsanctioned.
WATCHLIST_HEADER = ['Tool', 'Category', 'Vendor', 'Posture', 'ProcessNames', 'Domains', 'InstallPrefixes']
WATCHLIST_SEED = [
    ['Microsoft 365 Copilot', 'Assistant', 'Microsoft', 'Sanctioned', 'm365copilot.exe',
     'm365.cloud.microsoft;copilot.cloud.microsoft', 'microsoft_365_copilot;microsoft 365 copilot'],
    ['GitHub Copilot', 'Coding assistant', 'GitHub', 'Sanctioned', 'copilot-language-server.exe',
     'githubcopilot.com;copilot-proxy.githubusercontent.com', 'github_copilot;github copilot'],
    ['ChatGPT', 'Assistant', 'OpenAI', DEFAULT_POSTURE, 'chatgpt.exe', 'chatgpt.com;chat.openai.com;api.openai.com',
     'chatgpt'],
    ['Claude', 'Assistant', 'Anthropic', DEFAULT_POSTURE, 'claude.exe', 'claude.ai;api.anthropic.com', 'claude'],
    ['Gemini', 'Assistant', 'Google', DEFAULT_POSTURE, '', 'gemini.google.com;generativelanguage.googleapis.com',
     'gemini'],
    ['Perplexity', 'Assistant', 'Perplexity', DEFAULT_POSTURE, 'perplexity.exe', 'perplexity.ai', 'perplexity'],
    ['DeepSeek', 'Assistant', 'DeepSeek', DEFAULT_POSTURE, '', 'deepseek.com', 'deepseek'],
    ['Grok', 'Assistant', 'xAI', DEFAULT_POSTURE, '', 'grok.com;api.x.ai', 'grok'],
    ['Mistral Le Chat', 'Assistant', 'Mistral AI', DEFAULT_POSTURE, '', 'chat.mistral.ai;api.mistral.ai', ''],
    ['Cursor', 'Coding assistant', 'Anysphere', DEFAULT_POSTURE, 'cursor.exe', 'cursor.sh;cursor.com', 'cursor'],
    ['Windsurf', 'Coding assistant', 'Windsurf', DEFAULT_POSTURE, 'windsurf.exe', 'windsurf.com;codeium.com',
     'windsurf;codeium'],
    ['Ollama', 'Local model runner', 'Ollama', DEFAULT_POSTURE, 'ollama.exe;ollama app.exe', 'ollama.com', 'ollama'],
    ['LM Studio', 'Local model runner', 'LM Studio', DEFAULT_POSTURE, 'lm studio.exe', 'lmstudio.ai',
     'lm_studio;lm studio'],
]


# ---------------------------------------------------------------- watchlist

def _terms(value) -> list[str]:
    out = []
    for term in re.split(r'[;,\n]', str(value or '')):
        term = term.strip().lower()
        if term and term not in out:
            out.append(term)
    return out


def normalise_posture(value) -> str:
    text = str(value or '').strip().lower()
    for posture in POSTURES:
        if text == posture.lower():
            return posture
    return DEFAULT_POSTURE


def parse_watchlist(text: str) -> list[dict]:
    """Watchlist CSV to rows. Unknown postures read as "Not reviewed"; a tool listed twice keeps its first row."""
    reader = csv.DictReader(io.StringIO((text or '').lstrip('\ufeff')))
    if not reader.fieldnames:
        return []
    fields = {f.strip().lower(): f for f in reader.fieldnames if f}
    if 'tool' not in fields:
        raise ValueError('The AI watchlist needs a "Tool" column.')
    rows, seen = [], set()
    for rec in reader:
        def get(name):
            key = fields.get(name.lower())
            return (rec.get(key) or '').strip() if key else ''
        tool = get('Tool')
        if not tool or tool.lower() in seen:
            continue
        seen.add(tool.lower())
        rows.append({
            'Tool': tool,
            'Category': get('Category'),
            'Vendor': get('Vendor'),
            'Posture': normalise_posture(get('Posture')),
            'ProcessNames': _terms(get('ProcessNames')),
            'Domains': _terms(get('Domains')),
            'InstallPrefixes': _terms(get('InstallPrefixes')),
        })
    return rows


def watchlist_csv(rows=None) -> str:
    """The seed (or any parsed rows) as CSV."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator='\n')
    writer.writerow(WATCHLIST_HEADER)
    if rows is None:
        writer.writerows(WATCHLIST_SEED)
    else:
        for r in rows:
            writer.writerow([r['Tool'], r['Category'], r['Vendor'], r['Posture'], ';'.join(r['ProcessNames']),
                             ';'.join(r['Domains']), ';'.join(r['InstallPrefixes'])])
    return buf.getvalue()


def default_watchlist() -> list[dict]:
    return parse_watchlist(watchlist_csv())


def watchlist_rows(watchlist) -> list[tuple]:
    return [(w['Tool'], w['Category'], w['Vendor'], w['Posture'], ';'.join(w['ProcessNames']),
             ';'.join(w['Domains']), ';'.join(w['InstallPrefixes'])) for w in watchlist]


def term_map(watchlist, field: str) -> list[tuple[str, str]]:
    """(term, tool) pairs, longest term first so the most specific match wins."""
    pairs, seen = [], set()
    for w in watchlist:
        for term in w[field]:
            if term not in seen:
                seen.add(term)
                pairs.append((term, w['Tool']))
    return sorted(pairs, key=lambda p: (-len(p[0]), p[0]))


def match_domain(host: str, watchlist) -> str:
    """The watched tool a host belongs to (exact host or a subdomain of a watched domain), or ''."""
    host = str(host or '').strip().lower().rstrip('.')
    for term, tool in term_map(watchlist, 'Domains'):
        if host == term or host.endswith('.' + term):
            return tool
    return ''


# ---------------------------------------------------------------- KQL

def kql_string(value) -> str:
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'


def _kql_list(values) -> str:
    return 'dynamic([' + ', '.join(kql_string(v) for v in values) + '])'


def _kql_date(day: date) -> str:
    return f'datetime({day.isoformat()})'


def _case(column: str, pairs, match: str) -> str:
    if not pairs:
        return '""'
    tests = []
    for term, tool in pairs:
        t = kql_string(term)
        if match == 'domain':
            cond = f'{column} == {t} or {column} endswith {kql_string("." + term)}'
        elif match == 'prefix':
            cond = f'{column} startswith {t}'
        else:
            cond = f'{column} == {t}'
        tests.append(f'{cond}, {kql_string(tool)}')
    return 'case(' + ', '.join(tests) + ', "")'


_EMPTY_ACTIVITY = 'datatable(Day:datetime, DeviceId:string, User:string, Tool:string, Events:long)[]'


def activity_kql(watchlist, end: date, load_start: date) -> str:
    """One query for both device layers: daily rows from `load_start`, 7- and 30-day window rows as of the
    day before `end`, per tool and in total. Totals (Tool == "") count only tools that aren't sanctioned."""
    processes = term_map(watchlist, 'ProcessNames')
    domains = term_map(watchlist, 'Domains')
    shadow = [w['Tool'] for w in watchlist if w['Posture'] != 'Sanctioned']
    service = _kql_list(SERVICE_SIDS)
    ran = _EMPTY_ACTIVITY
    if processes:
        ran = '\n'.join([
            'DeviceProcessEvents',
            '    | where Timestamp >= Since and Timestamp < End',
            f'    | where FileName in~ ({_kql_list(t for t, _ in processes)})',
            '    | extend Term = tolower(FileName)',
            f'    | extend Tool = {_case("Term", processes, "exact")}',
            '    | where isnotempty(Tool)',
            '    | extend User = tostring(coalesce(AccountObjectId, AccountSid))',
            '    | summarize Events = count() by Day = startofday(Timestamp), DeviceId, User, Tool',
        ])
    network = _EMPTY_ACTIVITY
    if domains:
        network = '\n'.join([
            'DeviceNetworkEvents',
            '    | where Timestamp >= Since and Timestamp < End',
            f'    | where RemoteUrl has_any ({_kql_list(t for t, _ in domains)})',
            '    | extend Host = tolower(tostring(split(replace_regex(RemoteUrl, @"^[a-zA-Z]+://", ""), "/")[0]))',
            '    | extend Host = trim_end(@"\\.", tostring(split(Host, ":")[0]))',
            f'    | extend Tool = {_case("Host", domains, "domain")}',
            '    | where isnotempty(Tool)',
            '    | extend User = tostring(coalesce(InitiatingProcessAccountObjectId, InitiatingProcessAccountSid))',
            '    | summarize Events = count() by Day = startofday(Timestamp), DeviceId, User, Tool',
        ])
    stats = 'Devices = dcount(DeviceId, 4), Users = dcountif(User, isnotempty(User), 4), Events = sum(Events)'
    branches = []
    for source, tool in (('Both', 'Tool'), ('Shadow', '')):
        by_tool = ', Tool' if tool else ''
        set_tool = '' if tool else ', Tool = ""'
        branches.append(f'({source} | where Day >= Load | summarize {stats} by Day, Layer{by_tool}'
                        f' | extend Window = "1d"{set_tool})')
        for name, days in WINDOWS:
            branches.append(f'({source} | where Day >= End - {days}d | summarize {stats} by Layer{by_tool}'
                            f' | extend Day = End - 1d, Window = "{name}"{set_tool})')
    return '\n'.join([
        f'let End = {_kql_date(end)};',
        f'let Since = End - {LOOKBACK_DAYS}d;',
        f'let Load = {_kql_date(load_start)};',
        f'let Ran = {ran};',
        f'let Network = {network};',
        'let Both = materialize(union (Ran | extend Layer = "Ran"), (Network | extend Layer = "Network")',
        f'    | extend User = iff(User in ({service}), "", User));',
        f'let Shadow = materialize(Both | where Tool in ({_kql_list(shadow)})'
        f' | union (Both | where Tool in ({_kql_list(shadow)}) | extend Layer = "{ANY_LAYER}"));',
        'union',
        ',\n'.join('    ' + b for b in branches),
        '| project Day, Window, Layer, Tool, Devices, Users, Events',
    ])


def installed_kql(watchlist) -> str | None:
    prefixes = term_map(watchlist, 'InstallPrefixes')
    if not prefixes:
        return None
    where = ' or '.join(f'Name startswith {kql_string(t)}' for t, _ in prefixes)
    return '\n'.join([
        'DeviceTvmSoftwareInventory',
        '| extend Name = tolower(SoftwareName)',
        f'| where {where}',
        f'| extend Tool = {_case("Name", prefixes, "prefix")}',
        '| where isnotempty(Tool)',
        '| summarize Devices = dcount(DeviceId, 4), SoftwareNames = make_set(SoftwareName, 10) by Tool',
        '| project Tool, Devices, SoftwareNames = strcat_array(SoftwareNames, "; ")',
    ])


AGENTS_KQL = '\n'.join([
    'AgentsInfo',
    '| summarize arg_max(Timestamp, *) by AgentId',
    '| project AgentId, AgentName, Platform, EntraAgentId, SourceAgentId, PublishedStatus, LifecycleStatus,',
    '    Availability, ToolsAuthenticationType, DeclaredDataSources, RawAgentInfo',
])
LEGACY_AGENTS_KQL = '\n'.join([
    'AIAgentsInfo',
    '| summarize arg_max(Timestamp, *) by AIAgentId',
    '| project AgentId = tostring(AIAgentId), AgentName = AIAgentName, Platform, EntraAgentId = EntraObjectId,',
    '    SourceAgentId = tostring(AIAgentId), AppId = AgentAppId, PublishedStatus = AgentStatus,',
    '    LifecycleStatus = iff(IsBlocked == true, "Blocked", ""), Availability = AccessControlPolicy,',
    '    UserAuthenticationType, KnowledgeDetails',
])


# ---------------------------------------------------------------- days

def load_start(today: date, last_loaded: date | None) -> date:
    """First day to (re)load: complete UTC days only, 29 back on a first run, else the last loaded day again."""
    newest = today - timedelta(days=1)
    oldest = today - timedelta(days=FIRST_LOAD_DAYS)
    if last_loaded is None:
        return oldest
    return min(max(last_loaded - timedelta(days=1), oldest), newest)


def utc_today(now: datetime | None = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date()


# ---------------------------------------------------------------- answers

def classify(status_code: int, body) -> tuple[str, str]:
    """A failed Graph answer to (status, message). Best effort: unlicensed tenants answer in several ways."""
    message = _error_message(body)
    low = message.lower()
    if status_code in (401, 403):
        if any(k in low for k in ('licens', 'not onboarded', 'not provisioned', 'subscription')):
            return 'unlicensed', message or f'HTTP {status_code}'
        return 'forbidden', message or f'HTTP {status_code}'
    if status_code in (400, 404):
        if any(k in low for k in ('failed to resolve', 'could not be resolved', 'unknown table', 'not found',
                                  'licens', 'not onboarded', 'not provisioned', 'not enabled')):
            return 'unlicensed', message or f'HTTP {status_code}'
    return 'error', message or f'HTTP {status_code}'


def _error_message(body) -> str:
    if isinstance(body, dict):
        err = body.get('error')
        if isinstance(err, dict):
            text = str(err.get('message') or err.get('code') or '')
            inner = err.get('innerError') or err.get('innererror')
            if not text and isinstance(inner, dict):
                text = str(inner.get('message') or '')
            return text[:500]
        if isinstance(err, str):
            return err[:500]
        return str(body.get('message') or '')[:500]
    return str(body or '')[:500]


def hunting_results(body) -> list[dict]:
    if not isinstance(body, dict):
        return []
    rows = body.get('results', body.get('Results'))
    return rows if isinstance(rows, list) else []


def _int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return 0


def _day(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or '')[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _timestamp(value) -> datetime | None:
    if not value:
        return None
    text = str(value).replace('Z', '+00:00')
    m = re.match(r'^(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$', text)
    if m:
        text = m.group(1) + (m.group(2) or '')[:7] + m.group(3)
    try:
        ts = datetime.fromisoformat(text)
    except ValueError:
        return None
    if ts.tzinfo is not None:
        ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
    return ts


def activity_rows(results, end: date, start: date, loaded_at: datetime) -> tuple[list[tuple], list[tuple]]:
    """Hunting rows to (per-tool rows, totals rows). Every day and window gets a totals row, zero when quiet."""
    daily, totals = [], {}
    for r in results:
        day = _day(r.get('Day'))
        if day is None:
            continue
        window, layer, tool = str(r.get('Window') or ''), str(r.get('Layer') or ''), str(r.get('Tool') or '')
        counts = (_int(r.get('Devices')), _int(r.get('Users')), _int(r.get('Events')))
        if tool:
            daily.append((day, window, layer, tool, *counts, loaded_at))
        else:
            totals[(day, window, layer)] = counts
    days = [start + timedelta(days=i) for i in range((end - start).days)]
    keys = [(d, '1d') for d in days] + [(end - timedelta(days=1), name) for name, _ in WINDOWS]
    total_rows = []
    for day, window in keys:
        for layer in (*LAYERS, ANY_LAYER):
            total_rows.append((day, window, layer, *totals.get((day, window, layer), (0, 0, 0)), loaded_at))
    daily.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
    return daily, total_rows


def installed_rows(results, snapshot: date, loaded_at: datetime) -> list[tuple]:
    rows = [(snapshot, str(r.get('Tool') or ''), _int(r.get('Devices')), str(r.get('SoftwareNames') or ''),
             loaded_at) for r in results if r.get('Tool')]
    return sorted(rows, key=lambda r: r[1])


# Sign-in: the agent's user authentication setting, as Copilot Studio names it.
NO_SIGN_IN = ('none', 'noauthentication', 'no authentication', 'noauth', 'anonymous')
SIGN_IN = ('microsoft', 'integrated', 'entra', 'entraid', 'aad', 'azureactivedirectory', 'custom', 'manual',
           'oauth', 'oauth2', 'authenticatewithmicrosoft', 'authenticatemanually')
_AUTH_KEYS = ('userauthenticationtype', 'userauthentication', 'authenticationmode', 'authenticationtype',
              'authmode', 'authtype')
_WEB_MARKERS = ('publicwebsite', 'public website', 'websearch', 'web search', 'bingsearch', 'bing search',
                'publicsite', 'searchtheweb', 'webbrowsing')


def _parse_dynamic(value):
    if isinstance(value, str) and value[:1] in ('{', '['):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def find_key(value, keys, depth=0):
    """The first scalar under any of `keys` (case-insensitive) in nested JSON, or None."""
    value = _parse_dynamic(value)
    if depth > 8:
        return None
    if isinstance(value, dict):
        for k, v in value.items():
            if str(k).lower().replace('_', '') in keys and not isinstance(v, (dict, list)) and v not in (None, ''):
                return v
        for v in value.values():
            found = find_key(v, keys, depth + 1)
            if found is not None:
                return found
    elif isinstance(value, list):
        for v in value:
            found = find_key(v, keys, depth + 1)
            if found is not None:
                return found
    return None


def sign_in_required(auth_type) -> str:
    text = re.sub(r'[\s_\-]', '', str(auth_type or '').lower())
    if not text:
        return 'Unknown'
    if text in {re.sub(r'[\s_\-]', '', v) for v in NO_SIGN_IN}:
        return 'No'
    if text in {re.sub(r'[\s_\-]', '', v) for v in SIGN_IN}:
        return 'Yes'
    return 'Unknown'


def uses_web_knowledge(*values) -> str:
    seen = False
    for value in values:
        if value in (None, '', [], {}):
            continue
        seen = True
        text = json.dumps(_parse_dynamic(value)).lower() if not isinstance(value, str) else value.lower()
        if any(m in text for m in _WEB_MARKERS):
            return 'Yes'
    return 'No' if seen else 'Unknown'


def agent_rows(results, source_table: str, snapshot: date, loaded_at: datetime) -> list[tuple]:
    """Agent configuration, without owners, users or instructions."""
    out, seen = [], set()
    for r in results:
        agent_id = str(r.get('AgentId') or '')
        if not agent_id or agent_id in seen:
            continue
        seen.add(agent_id)
        auth = r.get('UserAuthenticationType')
        if auth in (None, ''):
            auth = find_key(r.get('ToolsAuthenticationType'), _AUTH_KEYS)
        if auth in (None, ''):
            auth = find_key(r.get('RawAgentInfo'), _AUTH_KEYS)
        app_id = r.get('AppId') or find_key(r.get('RawAgentInfo'), ('appid', 'agentappid', 'botappid')) or ''
        knowledge = (r.get('KnowledgeDetails'), r.get('DeclaredDataSources'))
        out.append((snapshot, agent_id, str(r.get('AgentName') or ''), str(r.get('Platform') or ''), source_table,
                    str(r.get('EntraAgentId') or '').lower(), str(r.get('SourceAgentId') or '').lower(),
                    str(app_id).lower(), str(auth or ''), sign_in_required(auth), uses_web_knowledge(*knowledge),
                    str(r.get('PublishedStatus') or ''), str(r.get('LifecycleStatus') or ''),
                    str(r.get('Availability') or ''), loaded_at))
    return sorted(out, key=lambda r: (r[2].lower(), r[1]))


def cloud_posture(tags) -> str:
    names = {str(t).strip().lower() for t in (tags or [])}
    for posture in ('Unsanctioned', 'Sanctioned', 'Monitored'):
        if posture.lower() in names:
            return posture
    return ''


def cloud_rows(stream: dict, apps, watchlist, snapshot: date, loaded_at: datetime) -> list[tuple]:
    out = []
    for a in apps:
        if str(a.get('category') or '') not in AI_CATEGORIES:
            continue
        domains = a.get('domains') or []
        tool = ''
        for d in domains:
            tool = match_domain(d, watchlist)
            if tool:
                break
        if not tool:
            name = str(a.get('displayName') or '').lower()
            tool = next((w['Tool'] for w in watchlist if w['Tool'].lower() == name), '')
        tags = a.get('tags') or []
        out.append((snapshot, str(stream.get('id') or ''), str(stream.get('displayName') or ''), str(a.get('id') or ''),
                    str(a.get('displayName') or ''), str(a.get('category') or ''), _int(a.get('riskScore')),
                    _int(a.get('userCount')), _int(a.get('deviceCount')), _int(a.get('ipAddressCount')),
                    _int(a.get('transactionCount')), _int(a.get('uploadNetworkTrafficInBytes')),
                    _int(a.get('downloadNetworkTrafficInBytes')), _timestamp(a.get('lastSeenDateTime')),
                    '; '.join(str(t) for t in tags), cloud_posture(tags), tool, loaded_at))
    return out


def status_row(run_at: datetime, probe: str, status: str, source: str, rows: int, message: str) -> tuple:
    return (run_at, probe, status, source, int(rows), str(message or '')[:1000])


# ---------------------------------------------------------------- run

def _call(fn, *args):
    """Calls a transport and turns an exception into an error answer."""
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 - every failure becomes a status row
        return None, {'error': {'message': f'{type(exc).__name__}: {exc}'}}


def _hunt(hunt, kql):
    code, body = _call(hunt, kql)
    if code == 200:
        return 'ok', hunting_results(body), ''
    if code is None:
        return 'error', [], _error_message(body)
    status, message = classify(code, body)
    return status, [], message


def run(hunt, get, watchlist, today: date, last_loaded: date | None, now: datetime | None = None,
        probes=PROBES) -> dict:
    """Runs every probe. `hunt(kql)` and `get(url)` return (status_code, json_body).

    Returns the rows for each table key in TABLES, plus `load_start` and `end` for the daily tables.
    Never raises for a Defender failure: each one is a `status` row.
    """
    run_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(tzinfo=None, microsecond=0)
    out = {key: [] for key in TABLES}
    out['watchlist'] = watchlist_rows(watchlist)
    start = load_start(today, last_loaded)
    out.update(load_start=start, end=today, loaded={})

    def record(probe, status, source, rows, message=''):
        if status == 'ok' and not rows:
            status = 'empty'
        out['status'].append(status_row(run_at, probe, status, source, rows, message))
        out['loaded'][probe] = status in ('ok', 'empty')

    if 'device_activity' in probes:
        status, results, message = _hunt(hunt, activity_kql(watchlist, today, start))
        if status == 'ok':
            out['daily'], out['totals'] = activity_rows(results, today, start, run_at)
        record('device_activity', status, 'DeviceProcessEvents, DeviceNetworkEvents', len(out['daily']), message)

    if 'installed' in probes:
        kql = installed_kql(watchlist)
        if kql is None:
            record('installed', 'empty', 'DeviceTvmSoftwareInventory', 0, 'No install prefixes in the watchlist.')
        else:
            status, results, message = _hunt(hunt, kql)
            if status == 'ok':
                out['installed'] = installed_rows(results, today, run_at)
            record('installed', status, 'DeviceTvmSoftwareInventory', len(out['installed']), message)

    if 'agents' in probes:
        status, results, message = _hunt(hunt, AGENTS_KQL)
        source = 'AgentsInfo'
        if status in ('unlicensed', 'error'):
            legacy = _hunt(hunt, LEGACY_AGENTS_KQL)
            if legacy[0] == 'ok':
                status, results, message = legacy
                source = 'AIAgentsInfo'
        if status == 'ok':
            out['agents'] = agent_rows(results, source, today, run_at)
        record('agents', status, source, len(out['agents']), message)

    if 'cloud_discovery' in probes:
        status, message = cloud_discovery(get, watchlist, today, run_at, out['cloud'])
        record('cloud_discovery', status, 'Cloud Discovery', len(out['cloud']), message)
    return out


def _pages(get, url):
    """Yields each page's `value`; raises RuntimeError with (status, message) on a failed page."""
    seen = set()
    for _ in range(MAX_PAGES):
        if not url or url in seen:
            return
        seen.add(url)
        code, body = _call(get, url)
        if code != 200:
            status, message = ('error', _error_message(body)) if code is None else classify(code, body)
            raise _ProbeFailed(status, message)
        yield (body or {}).get('value') or []
        url = (body or {}).get('@odata.nextLink')


class _ProbeFailed(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def cloud_discovery(get, watchlist, snapshot: date, loaded_at: datetime, sink: list) -> tuple[str, str]:
    """Adds AI apps from every uploaded Cloud Discovery stream to `sink`. Returns (status, message)."""
    try:
        streams = [s for page in _pages(get, f'{CLOUD_DISCOVERY_URL}/uploadedStreams') for s in page]
        if not streams:
            return 'empty', 'No Cloud Discovery streams.'
        failures = []
        for stream in streams:
            sid = str(stream.get('id') or '')
            url = (f"{CLOUD_DISCOVERY_URL}/uploadedStreams/{sid}/"
                   f"aggregatedAppsDetails(period=duration'{CLOUD_DISCOVERY_PERIOD}')")
            try:
                for page in _pages(get, url):
                    sink.extend(cloud_rows(stream, page, watchlist, snapshot, loaded_at))
            except _ProbeFailed as exc:
                failures.append(f'{stream.get("displayName") or sid}: {exc.message}')
        if failures and len(failures) == len(streams):
            return 'error', '; '.join(failures)[:1000]
        return 'ok', '; '.join(failures)[:1000]
    except _ProbeFailed as exc:
        return exc.status, exc.message
