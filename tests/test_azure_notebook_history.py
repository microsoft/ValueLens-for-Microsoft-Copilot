"""Offline tests that the Fabric notebook Ingest_Azure_AI keeps the rows older than its window.

They exec the notebook's own helpers and write statements against a small in-memory stand-in for
Spark and Delta, so they need only the standard library. The reload columns must match the Azure
route's job (`valuelens_jobs.collect.azure_ai.RELOAD`), which the Local CSV script also follows.
"""
from __future__ import annotations

import ast
import json
import re
from datetime import date, timedelta
from types import SimpleNamespace

import pytest

import notebook_source
from valuelens_jobs.collect import azure_ai as jobs_azure_ai

NOTEBOOK = "credit-consumption/Ingest_Azure_AI.ipynb"
CODE = ["".join(cell["source"])
        for cell in json.loads((notebook_source.NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8"))["cells"]
        if cell["cell_type"] == "code"]
TREES = [ast.parse(text) for text in CODE]
WRITE_ORDER = ["LAKEHOUSE_SPEND", "LAKEHOUSE_TOKENS", "LAKEHOUSE_PAYG", "LAKEHOUSE_HEALTH",
               "LAKEHOUSE_SOLUTION", "LAKEHOUSE_RECON"]
KEEP = {"HEALTH_HEADERS", "RECON_HEADERS", "PAYG_POOL", "PROVISIONED_POOL", "RECON_TOLERANCES",
        "RETAIL_BATCH", "detail_warnings", "SPEND_SCHEMA", "TOKENS_SCHEMA", "PAYG_SCHEMA",
        "HEALTH_SCHEMA", "SOLUTION_SCHEMA", "RECON_SCHEMA", *WRITE_ORDER}
BASE = notebook_source.namespace(NOTEBOOK, KEEP)
TABLE = {name: BASE[name] for name in WRITE_ORDER}
SPEND, TOKENS, PAYG, HEALTH, SOLUTION, RECON = (TABLE[name] for name in WRITE_ORDER)
TYPES = {"date": date, "string": str, "double": float}
MISSING = object()


def top_level(names):
    """The top-level definition or assignment of each name, which must be defined once."""
    found = {}
    for tree in TREES:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                defined = {node.name}
            elif isinstance(node, ast.Assign):
                defined = {target.id for target in node.targets if isinstance(target, ast.Name)}
            else:
                continue
            for name in defined & names:
                found.setdefault(name, []).append(node)
    wrong = sorted(name for name in names if len(found.get(name, [])) != 1)
    assert not wrong, f"Notebook definitions changed; update the tests: {wrong}"
    return {name: nodes[0] for name, nodes in found.items()}


# Top-level statements that a simulated run executes as written in the notebook.
STEPS = top_level({"start", "spend_frame", "tokens_frame", "payg_frame", "health", "detail_warnings"})


def write_sites():
    """Every (frame, table, column, cut) entry of a write_windows call outside a def, in notebook order."""
    sites = []
    for index, tree in enumerate(TREES):
        for statement in tree.body:
            if isinstance(statement, ast.FunctionDef):
                continue
            for call in ast.walk(statement):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                        and call.func.id == "write_windows"):
                    continue
                assert len(call.args) == 1 and not call.keywords and isinstance(call.args[0], ast.List)
                for entry in call.args[0].elts:
                    frame, table, column, cut = entry.elts
                    sites.append(SimpleNamespace(table=table.id, column=ast.literal_eval(column), frame=frame,
                                                 cut=cut, statement=statement, cell=index))
    return sites


def covered_column(site):
    """None for a daily table cut at the window's start; for a monthly table, the column that says
    how far into its month a stored row was read."""
    if isinstance(site.cut, ast.Name):
        assert site.cut.id == "start"
        return None
    assert isinstance(site.cut, ast.Call) and ast.unparse(site.cut.func) == "monthly_cut"
    table, column, covered, start = site.cut.args
    assert (table.id, ast.literal_eval(column), ast.unparse(start)) == (site.table, site.column, "start")
    return ast.literal_eval(covered)


SITES = write_sites()
MONTHLY = [site for site in SITES if covered_column(site)]
DAILY_COLUMNS = [(TABLE[site.table], site.column) for site in SITES if not covered_column(site)]


def run(statements, namespace):
    exec(compile(ast.Module(body=list(statements), type_ignores=[]), NOTEBOOK, "exec"), namespace)


def evaluate(node, namespace):
    return eval(compile(ast.Expression(body=node), NOTEBOOK, "eval"), namespace)


def parse_schema(schema):
    return [tuple(field.split()) for field in schema.split(",")]


def schema_of(frame):
    """{column: type} for the schema a frame passed to write_windows was created with."""
    if isinstance(frame, ast.Name):
        frame = STEPS[frame.id].value
    assert ast.unparse(frame.func) == "spark.createDataFrame"
    name = next(keyword.value.id for keyword in frame.keywords if keyword.arg == "schema")
    return dict(parse_schema(BASE[name]))


def lookup(row, column, default=MISSING):
    """A row's value for a column, matched case-insensitively as Spark does by default."""
    for key, item in row.items():
        if key.lower() == column.lower():
            return item
    if default is MISSING:
        raise KeyError(f"no column {column}")
    return default


WINDOW = re.compile(r"`(\w+)` >= DATE '(\d{4}-\d{2}-\d{2})' OR `\1` IS NULL")
MONTH = re.compile(r"`(\w+)` >= DATE '(\d{4}-\d{2}-\d{2})' AND `\1` <= DATE '(\d{4}-\d{2}-\d{2})'")


def condition(predicate, dtypes):
    """A row test for the predicates the notebook writes, with SQL's handling of NULL."""
    negated = re.fullmatch(r"NOT \((.*)\)", predicate)
    text = negated.group(1) if negated else predicate
    window, month = WINDOW.fullmatch(text), MONTH.fullmatch(text)
    if not (window or month) or (negated and not window):
        raise AssertionError(f"unexpected predicate: {predicate}")
    column = (window or month).group(1)
    assert {name.lower(): kind for name, kind in dtypes}.get(column.lower()) == "date", predicate
    if window:
        cut = date.fromisoformat(window.group(2))

        def test(row):
            item = lookup(row, column)
            return item is None or item >= cut
    else:
        low, high = date.fromisoformat(month.group(2)), date.fromisoformat(month.group(3))

        def test(row):
            item = lookup(row, column)
            return item is not None and low <= item <= high
    return (lambda row: not test(row)) if negated else test


class Frame:
    """An eager DataFrame. One made from an unreadable table fails when its rows are needed."""

    def __init__(self, spark, dtypes, rows, error=None):
        self.spark, self.dtypes, self.rows, self.error = spark, list(dtypes), rows, error

    def materialise(self):
        if self.error is not None:
            raise self.error
        return self.rows

    def filter(self, predicate):
        test = condition(predicate, self.dtypes)
        rows = [] if self.error is not None else [row for row in self.rows if test(row)]
        return Frame(self.spark, self.dtypes, rows, self.error)

    def select(self, *columns):
        names = {name.lower(): (name, kind) for name, kind in self.dtypes}
        dtypes = [names[column.lower()] for column in columns]
        rows = [] if self.error is not None else [
            {name: lookup(row, name) for name, _ in dtypes} for row in self.rows]
        return Frame(self.spark, dtypes, rows, self.error)

    def distinct(self):
        rows, seen = [], set()
        for row in [] if self.error is not None else self.rows:
            key = tuple(row.values())
            if key not in seen:
                seen.add(key)
                rows.append(row)
        return Frame(self.spark, self.dtypes, rows, self.error)

    def collect(self):
        return [tuple(row[name] for name, _ in self.dtypes) for row in self.materialise()]

    def count(self):
        return len(self.materialise())

    @property
    def write(self):
        return Writer(self)


class Writer:
    def __init__(self, frame):
        self.frame, self.settings = frame, {"format": None, "mode": None, "options": {}}

    def format(self, name):
        self.settings["format"] = name
        return self

    def mode(self, name):
        self.settings["mode"] = name
        return self

    def option(self, key, value):
        self.settings["options"][key] = value
        return self

    def saveAsTable(self, table):
        self.frame.spark.save(table, self.frame, **self.settings)


class Stored:
    def __init__(self, dtypes, rows):
        self.dtypes, self.rows = list(dtypes), rows


class FakeSpark:
    """Enough of Spark and Delta for the notebook's reads and writes, with replaceWhere's rules: the
    table must exist, every written row must match the predicate, and a changed column type fails."""

    def __init__(self):
        self.tables, self.log = {}, []
        self.unopenable, self.unreadable, self.fail_write = set(), set(), set()
        self.catalog = SimpleNamespace(tableExists=lambda name: name in self.tables)

    def createDataFrame(self, rows, schema):
        dtypes = parse_schema(schema)
        made = []
        for row in rows:
            assert isinstance(row, dict), row
            for name, kind in dtypes:
                item = row.get(name)
                # PySpark's own check: a double column takes a float, not an int or a bool.
                if item is not None and type(item) is not TYPES[kind]:
                    raise TypeError(f"field {name}: {kind} can not accept {item!r}")
            made.append({name: row.get(name) for name, _ in dtypes})
        return Frame(self, dtypes, made)

    def table(self, name):
        if name in self.unopenable:
            raise OSError(f"simulated failure opening {name}")
        stored = self.tables[name]
        error = OSError(f"simulated failure reading {name}") if name in self.unreadable else None
        return Frame(self, stored.dtypes, [dict(row) for row in stored.rows], error)

    def save(self, table, frame, format, mode, options):
        assert format == "delta"
        rows = [dict(row) for row in frame.materialise()]
        if mode is None:
            assert not options and table not in self.tables, (table, options)
            if table in self.fail_write:
                raise OSError(f"simulated failure writing {table}")
            self.tables[table] = Stored(frame.dtypes, rows)
            self.log.append(("create", table, len(rows)))
            return
        assert mode == "overwrite" and table in self.tables, (table, mode)
        assert options.keys() == {"replaceWhere", "mergeSchema"} and options["mergeSchema"] == "true", options
        predicate, stored = options["replaceWhere"], self.tables[table]
        kinds = {name.lower(): kind for name, kind in stored.dtypes}
        for name, kind in frame.dtypes:
            if kinds.get(name.lower(), kind) != kind:
                raise RuntimeError(f"Failed to merge fields '{name}': {kinds[name.lower()]} and {kind}")
        if not all(map(condition(predicate, frame.dtypes), rows)):
            raise RuntimeError(f"Written data does not conform to the replaceWhere predicate {predicate}")
        if table in self.fail_write:
            raise OSError(f"simulated failure writing {table}")
        replaced = condition(predicate, stored.dtypes)
        stored.dtypes += [(name, kind) for name, kind in frame.dtypes if name.lower() not in kinds]
        stored.rows = [{name: lookup(row, name, None) for name, _ in stored.dtypes}
                       for row in [row for row in stored.rows if not replaced(row)] + rows]
        self.log.append(("replace", table, predicate, len(rows)))


def notebook(spark, **values):
    """The notebook's definitions, with Spark, print and the given values replaced."""
    ns = notebook_source.namespace(NOTEBOOK, KEEP)
    printed = []
    ns.update(spark=spark, print=lambda *args, **kwargs: printed.append(" ".join(map(str, args))), **values)
    return ns, printed


# Unit tests of the helpers, on a one-column daily table.

DAY = date(2026, 6, 10)
DAILY = "UsageDate date, Cost double"


def day(offset):
    return DAY + timedelta(days=offset)


@pytest.fixture
def nb():
    spark = FakeSpark()
    ns, printed = notebook(spark)

    def frame(offsets, cost=1.0, schema=DAILY):
        return spark.createDataFrame([{"UsageDate": None if offset is None else day(offset), "Cost": cost}
                                      for offset in offsets], schema=schema)

    def rows(table):
        return sorted(((lookup(row, "UsageDate"), lookup(row, "Cost")) for row in spark.tables[table].rows),
                      key=lambda row: (row[0] is None, row[0] or DAY))

    return SimpleNamespace(spark=spark, ns=ns, printed=printed, write=ns["write_windows"], frame=frame,
                           rows=rows)


def test_window_predicate(nb):
    assert nb.ns["window_predicate"]("UsageDate", date(2026, 7, 1)) == (
        "`UsageDate` >= DATE '2026-07-01' OR `UsageDate` IS NULL")


def test_a_new_table_gets_the_window_and_the_undated_rows(nb):
    nb.write([(nb.frame([-1, 0, 1, None]), "t", "UsageDate", day(0))])
    assert nb.rows("t") == [(day(0), 1.0), (day(1), 1.0), (None, 1.0)]
    assert nb.spark.log == [("create", "t", 3)]
    assert nb.printed == ["wrote t: 3 rows (new table)"]


def test_a_write_keeps_older_rows_and_replaces_undated_ones(nb):
    nb.write([(nb.frame([-3, -2, -1, 0, None]), "t", "UsageDate", day(-3))])
    nb.printed.clear()
    nb.write([(nb.frame([-1, 0, 1], cost=2.0), "t", "UsageDate", day(0))])
    # The frame's row before the cut isn't written: the stored one stays.
    assert nb.rows("t") == [(day(-3), 1.0), (day(-2), 1.0), (day(-1), 1.0), (day(0), 2.0), (day(1), 2.0)]
    assert nb.spark.log[-1] == ("replace", "t", "`UsageDate` >= DATE '2026-06-10' OR `UsageDate` IS NULL", 2)
    assert nb.printed == ["wrote t: 2 rows from 2026-06-10 on; kept 3 older rows"]


def test_an_empty_frame_still_replaces_its_window(nb):
    nb.write([(nb.frame([-1, 0, 1]), "t", "UsageDate", day(-1))])
    nb.write([(nb.frame([]), "t", "UsageDate", day(0))])
    assert nb.rows("t") == [(day(-1), 1.0)]
    assert nb.printed[-1] == "wrote t: 0 rows from 2026-06-10 on; kept 1 older rows"


def test_a_changed_column_type_stops_every_write(nb):
    nb.write([(nb.frame([0]), "a", "UsageDate", day(0)), (nb.frame([0]), "b", "UsageDate", day(0))])
    nb.spark.tables["b"].dtypes = [("UsageDate", "date"), ("Cost", "string")]
    nb.spark.log.clear()
    with pytest.raises(RuntimeError) as raised:
        nb.write([(nb.frame([1], cost=2.0), "a", "UsageDate", day(1)),
                  (nb.frame([1], cost=2.0), "b", "UsageDate", day(1))])
    assert str(raised.value) == (
        "b.Cost is string in the Lakehouse but double here, so nothing was written. To start over, drop b "
        "and run the notebook again; its older rows are lost.")
    assert nb.spark.log == []
    assert nb.rows("a") == [(day(0), 1.0)]


def test_columns_match_case_insensitively_and_new_ones_are_added(nb):
    nb.spark.tables["t"] = Stored([("usagedate", "date"), ("cost", "double")],
                                  [{"usagedate": day(-1), "cost": 1.0}, {"usagedate": day(0), "cost": 1.0}])
    nb.write([(nb.frame([0], cost=2.0, schema=DAILY + ", Currency string"), "t", "UsageDate", day(0))])
    stored = nb.spark.tables["t"]
    assert stored.dtypes == [("usagedate", "date"), ("cost", "double"), ("Currency", "string")]
    assert stored.rows == [{"usagedate": day(-1), "cost": 1.0, "Currency": None},
                           {"usagedate": day(0), "cost": 2.0, "Currency": None}]


@pytest.mark.parametrize("failure", ["unopenable", "unreadable"])
def test_an_unreadable_stored_table_stops_every_write(nb, failure):
    nb.write([(nb.frame([0]), "a", "UsageDate", day(0)), (nb.frame([0]), "b", "UsageDate", day(0))])
    getattr(nb.spark, failure).add("b")
    nb.spark.log.clear()
    with pytest.raises(OSError):
        nb.write([(nb.frame([1], cost=2.0), "a", "UsageDate", day(1)),
                  (nb.frame([1], cost=2.0), "b", "UsageDate", day(1))])
    assert nb.spark.log == []
    assert nb.rows("a") == [(day(0), 1.0)]


def test_a_failed_write_leaves_its_table_and_the_ones_after_it(nb):
    tables = ["a", "b", "c"]
    nb.write([(nb.frame([0]), table, "UsageDate", day(0)) for table in tables])
    nb.spark.fail_write.add("b")
    with pytest.raises(OSError):
        nb.write([(nb.frame([0, 1], cost=2.0), table, "UsageDate", day(0)) for table in tables])
    # Each table is one Delta write, but the tables together are not one transaction.
    assert nb.rows("a") == [(day(0), 2.0), (day(1), 2.0)]
    assert nb.rows("b") == nb.rows("c") == [(day(0), 1.0)]


JUNE_12, JUNE_END = date(2026, 6, 12), date(2026, 6, 30)


@pytest.mark.parametrize("site", MONTHLY, ids=lambda site: site.table)
@pytest.mark.parametrize("start, stored, expected", [
    (JUNE_12, None, date(2026, 6, 1)),  # no table yet
    (JUNE_12, [], date(2026, 6, 1)),
    (JUNE_12, [(JUNE_END, JUNE_END)], date(2026, 7, 1)),  # June was written after it ended: kept
    (JUNE_12, [(JUNE_END, date(2026, 6, 20))], date(2026, 6, 1)),  # June was read while it ran: replaced
    (date(2026, 6, 1), [(JUNE_END, JUNE_END)], date(2026, 6, 1)),  # the window covers all of June
    (JUNE_12, [(JUNE_END, JUNE_END), (JUNE_END, date(2026, 6, 20))], date(2026, 6, 1)),
    (JUNE_12, [(JUNE_END, JUNE_END), (JUNE_END, None)], date(2026, 6, 1)),
    (JUNE_12, [(date(2026, 5, 31), date(2026, 5, 20)), (date(2026, 7, 31), date(2026, 7, 2))],
     date(2026, 6, 1)),  # no June rows
    (date(2026, 12, 5), [(date(2026, 12, 31), date(2026, 12, 31))], date(2027, 1, 1)),
])
def test_the_monthly_cut_keeps_a_finished_first_month(site, start, stored, expected):
    spark = FakeSpark()
    ns, _ = notebook(spark, start=start)
    covered = covered_column(site)
    if stored is not None:
        dtypes = parse_schema(BASE[f"{site.table.split('_', 1)[1]}_SCHEMA"])
        # A health row is dated by its month's last day; a reconciliation row by its first day read.
        month = {"MetricDate": lambda end: end, "PeriodStart": lambda end: end.replace(day=1)}[site.column]
        spark.tables[TABLE[site.table]] = Stored(dtypes, [
            {**{name: None for name, _ in dtypes}, site.column: month(end), covered: last} for end, last in stored])
    assert evaluate(site.cut, ns) == expected
    assert spark.log == []


# The notebook's own write statements, run once per simulated day.

INVENTORY = [{"ResourceId": "rid", "DeploymentName": "chat", "Application": "", "ModelName": "model",
              "ModelVersion": "1", "SkuName": "GlobalStandard", "Region": "region", "PtuCapacity": None}]


def unexpected(*args, **kwargs):
    raise AssertionError("the simulated meter has no meter id, so no retail price is looked up")


class Simulation:
    """Runs the notebook's write statements once per simulated run, reading one unit a day."""

    def __init__(self):
        self.spark, self.notes = FakeSpark(), []
        self.ns, self.printed = notebook(
            self.spark, accounts=[{"id": "/subscriptions/sub/accounts/acct", "name": "acct"}],
            inventory=INVENTORY, SUBSCRIPTION_ID="sub", subscription_name="Subscription", res=[], tags={},
            service_filter={}, solution_filter={}, found=[], monitor_usage=lambda points, accounts: {},
            retail_prices=unexpected, retail_price_map=unexpected)
        sites = {site.table: site for site in SITES}
        self.steps = [STEPS["detail_warnings"], STEPS["spend_frame"], STEPS["tokens_frame"],
                      STEPS["payg_frame"], sites["LAKEHOUSE_SPEND"].statement, STEPS["health"],
                      sites["LAKEHOUSE_HEALTH"].statement, sites["LAKEHOUSE_SOLUTION"].statement,
                      sites["LAKEHOUSE_RECON"].statement]

    def run_on(self, end, days, sources_fail=False):
        self.ns.update(end=end, DAYS=days)
        run([STEPS["start"]], self.ns)
        start = self.ns["start"]
        window = [start + timedelta(days=offset) for offset in range((end - start).days)]
        costs = [{"UsageDate": int(f"{d:%Y%m%d}"), "Cost": 1.0, "Currency": "USD",
                  "ServiceName": "Foundry Models", "ResourceGuid": "meter", "UsageQuantity": 1.0}
                 for d in window]

        def cost_detail(cost_type, grouping, cost_filter):
            if sources_fail:
                raise OSError("simulated Cost Management failure")
            return costs

        self.ns.update(
            recs=[{"UsageDate": d, "ServiceName": "Foundry Models", "Cost": 1.0, "Currency": "USD"}
                  for d in window],
            payg_recs=[{"UsageDate": d, "Cost": 1.0, "Currency": "USD"} for d in window],
            points=[{"Date": d, "Deployment": "chat", "Metric": "TotalTokens", "Value": 1.0} for d in window],
            health_acc={("rid", "chat", d): {"requests": 1.0, "name": "chat"} for d in window},
            inventory_failures=len(self.ns["accounts"]) if sources_fail else 0,
            cost_detail=cost_detail,
            solution_rows=lambda *args: [{"UsageDate": d, "ActualCost": 1.0, "Currency": "USD"}
                                         for d in window])
        try:
            run(self.steps, self.ns)
        finally:
            self.notes.extend(self.ns["detail_warnings"])

    def rows(self, table):
        return [dict(row) for row in self.spark.tables[table].rows]

    def snapshot(self):
        return {table: sorted(map(repr, stored.rows)) for table, stored in self.spark.tables.items()}

    def days(self, table, column):
        found = [row[column] for row in self.rows(table)]
        assert len(found) == len(set(found)), f"{table} has a day twice"
        return sorted(found)

    def health(self):
        """{MetricDate: (SnapshotDate, Requests)}, with one row per month."""
        rows = self.rows(HEALTH)
        assert len(rows) == len({row["MetricDate"] for row in rows})
        return {row["MetricDate"]: (row["SnapshotDate"], row["Requests"]) for row in rows}

    def recon(self):
        """{Period: (PeriodStart, PeriodEnd, AzureActual)}, with one estimate and one actual each."""
        rows = self.rows(RECON)
        periods = sorted({row["Period"] for row in rows})
        assert sorted((row["Period"], row["Representation"]) for row in rows) == [
            (period, kind) for period in periods for kind in ("AzureActual", "UsageEstimate")]
        return {row["Period"]: (row["PeriodStart"], row["PeriodEnd"], row["Amount"])
                for row in rows if row["Representation"] == "AzureActual"}


@pytest.fixture
def sim():
    return Simulation()


def test_daily_runs_keep_every_day_and_count_each_month_once(sim):
    end = date(2026, 4, 10)  # The first run reads from 10 January.
    while end <= date(2026, 7, 1):
        sim.run_on(end, 90)
        end += timedelta(days=1)
    assert sim.notes == []
    first = date(2026, 1, 10)
    every_day = [first + timedelta(days=offset) for offset in range(172)]
    assert every_day[-1] == date(2026, 6, 30)
    for table, column in DAILY_COLUMNS:
        assert sim.days(table, column) == every_day
    # January keeps the 22 days the first run read. Every later month was read in full once and then
    # kept, so no month gains rows twice or shrinks to a part of itself.
    months = {date(2026, 1, 31): 22.0, date(2026, 2, 28): 28.0, date(2026, 3, 31): 31.0,
              date(2026, 4, 30): 30.0, date(2026, 5, 31): 31.0, date(2026, 6, 30): 30.0}
    assert sim.health() == {month: (month, total) for month, total in months.items()}
    assert sim.recon() == {f"{month:%Y-%m}": (max(month.replace(day=1), first), month, total)
                           for month, total in months.items()}


def test_a_rerun_on_the_same_day_changes_nothing(sim):
    sim.run_on(date(2026, 7, 1), 90)
    before = sim.snapshot()
    sim.run_on(date(2026, 7, 1), 90)
    assert sim.snapshot() == before
    assert sim.notes == []


def test_lowering_days_keeps_the_rows_beyond_the_new_window(sim):
    sim.run_on(date(2026, 6, 30), 90)
    sim.run_on(date(2026, 7, 1), 90)
    before = {table: sim.rows(table) for table in sim.spark.tables}
    sim.run_on(date(2026, 7, 2), 5)  # Reads from 27 June.
    assert sim.notes == []
    start = date(2026, 6, 27)
    for table, column in DAILY_COLUMNS:
        kept = [row for row in before[table] if row[column] < start]
        assert len(kept) == (start - date(2026, 4, 1)).days
        assert [row for row in sim.rows(table) if row[column] < start] == kept
        assert sim.days(table, column)[-5:] == [start + timedelta(days=offset) for offset in range(5)]
    # June was read in full before, so its rows stay rather than shrinking to the days read now.
    assert ([row for row in sim.rows(HEALTH) if row["MetricDate"] < date(2026, 7, 1)]
            == [row for row in before[HEALTH] if row["MetricDate"] < date(2026, 7, 1)])
    assert ([row for row in sim.rows(RECON) if row["Period"] < "2026-07"]
            == [row for row in before[RECON] if row["Period"] < "2026-07"])
    assert sim.health()[date(2026, 6, 30)] == (date(2026, 6, 30), 30.0)
    assert sim.health()[date(2026, 7, 31)] == (date(2026, 7, 1), 1.0)
    assert sim.recon()["2026-07"] == (date(2026, 7, 1), date(2026, 7, 1), 1.0)


def test_a_short_window_replaces_the_running_month_rather_than_freezing_it(sim):
    sim.run_on(date(2026, 7, 1), 90)
    sim.run_on(date(2026, 7, 2), 5)
    sim.run_on(date(2026, 7, 3), 5)
    assert sim.health()[date(2026, 7, 31)] == (date(2026, 7, 2), 2.0)
    assert sim.recon()["2026-07"] == (date(2026, 7, 1), date(2026, 7, 2), 2.0)
    # The window now starts in July, whose stored rows were read while it ran, so this run's read
    # replaces them. A DAYS this short can't read a whole month.
    sim.run_on(date(2026, 7, 8), 5)
    assert sim.notes == []
    assert sim.health()[date(2026, 7, 31)] == (date(2026, 7, 7), 5.0)
    assert sim.recon()["2026-07"] == (date(2026, 7, 3), date(2026, 7, 7), 5.0)
    assert sim.recon()["2026-06"] == (date(2026, 6, 1), date(2026, 6, 30), 30.0)


def test_failed_sources_leave_their_tables_unchanged(sim):
    sim.run_on(date(2026, 7, 1), 90)
    before = {table: sim.rows(table) for table in (HEALTH, SOLUTION, RECON)}
    sim.run_on(date(2026, 7, 2), 90, sources_fail=True)
    for table, rows in before.items():
        assert sim.rows(table) == rows
    assert len(sim.notes) == 3
    for note in sim.notes:
        assert "left unchanged" in note


def test_a_changed_type_leaves_a_best_effort_table_unchanged(sim):
    sim.run_on(date(2026, 7, 1), 90)
    stored = sim.spark.tables[RECON]
    stored.dtypes = [(name, "string" if name == "Amount" else kind) for name, kind in stored.dtypes]
    before = sim.rows(RECON)
    sim.spark.log.clear()
    sim.run_on(date(2026, 7, 2), 90)
    assert sim.rows(RECON) == before
    assert RECON not in [entry[1] for entry in sim.spark.log]
    assert {entry[1] for entry in sim.spark.log} == {SPEND, TOKENS, PAYG, HEALTH, SOLUTION}
    [note] = sim.notes
    for text in (f"billing reconciliation failed; {RECON} left unchanged (RuntimeError: ",
                 f"{RECON}.Amount is string in the Lakehouse but double here, so nothing was written."):
        assert text in note


def test_a_changed_type_in_a_section_3_table_stops_the_run_before_writing(sim):
    sim.run_on(date(2026, 7, 1), 90)
    stored = sim.spark.tables[TOKENS]
    stored.dtypes = [(name, "string" if name == "Value" else kind) for name, kind in stored.dtypes]
    before = sim.snapshot()
    sim.spark.log.clear()
    with pytest.raises(RuntimeError, match=f"{TOKENS}.Value is string in the Lakehouse but double here"):
        sim.run_on(date(2026, 7, 2), 90)
    assert sim.spark.log == []
    assert sim.snapshot() == before


def test_an_unreadable_section_3_table_stops_the_run_before_writing(sim):
    sim.run_on(date(2026, 7, 1), 90)
    sim.spark.unreadable.add(PAYG)
    before = sim.snapshot()
    sim.spark.log.clear()
    with pytest.raises(OSError, match=f"simulated failure reading {PAYG}"):
        sim.run_on(date(2026, 7, 2), 90)
    assert sim.spark.log == []
    assert sim.snapshot() == before


@pytest.mark.parametrize("failure, table, prefix", [
    ("unreadable", HEALTH, f"deployment health failed; {HEALTH} left unchanged (OSError: "),
    ("fail_write", SOLUTION, f"solution spend failed; {SOLUTION} left unchanged (OSError: "),
    ("fail_write", RECON, f"billing reconciliation failed; {RECON} left unchanged (OSError: "),
])
def test_a_failed_best_effort_table_is_left_and_the_rest_are_written(sim, failure, table, prefix):
    sim.run_on(date(2026, 7, 1), 90)
    before = sim.rows(table)
    getattr(sim.spark, failure).add(table)
    sim.spark.log.clear()
    sim.run_on(date(2026, 7, 2), 90)
    assert sim.rows(table) == before
    assert {entry[1] for entry in sim.spark.log} == set(TABLE.values()) - {table}
    [note] = sim.notes
    assert note.startswith(prefix)


# The notebook's structure, which the simulations above rely on.

def test_tables_are_written_only_through_write_windows():
    [helper] = [node for tree in TREES for node in tree.body
                if isinstance(node, ast.FunctionDef) and node.name == "write_windows"]
    inside = {id(node) for node in ast.walk(helper)}
    for text, tree in zip(CODE, TREES):
        writes = [ast.unparse(node) for node in ast.walk(tree) if id(node) not in inside
                  and isinstance(node, ast.Attribute)
                  and node.attr in {"write", "writeTo", "saveAsTable", "save", "insertInto", "mode", "option"}]
        assert writes == []
        if helper not in tree.body:
            assert not re.search(r"overwrite|replacewhere|DeltaTable|\.delete\(", text, re.IGNORECASE)


def test_six_tables_are_written_in_order_by_the_job_reload_columns():
    assert [site.table for site in SITES] == WRITE_ORDER
    assert {TABLE[site.table]: (site.column, covered_column(site)) for site in SITES} == jobs_azure_ai.RELOAD
    for site in SITES:
        schema = schema_of(site.frame)
        assert schema[site.column] == "date"
        assert covered_column(site) is None or schema[covered_column(site)] == "date"


def test_the_helpers_are_one_import_free_cell_before_the_first_write():
    [index] = [i for i, tree in enumerate(TREES)
               if any(isinstance(node, ast.FunctionDef) and node.name == "write_windows" for node in tree.body)]
    body = TREES[index].body
    assert all(isinstance(node, ast.FunctionDef) for node in body)
    assert [node.name for node in body] == ["window_predicate", "monthly_cut", "write_windows"]
    assert "def health_rows(" not in CODE[index]
    assert index < min(site.cell for site in SITES)
    # monthly_cut uses the shared helpers in section 4, which run before its first call.
    [shared] = [i for i, text in enumerate(CODE) if "def monthly_replace_from(" in text]
    assert shared < min(site.cell for site in MONTHLY)
