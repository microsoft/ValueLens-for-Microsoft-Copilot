"""Consumption Central's percentile cohorts give the same buckets after the refresh-cost rewrite.

The old DAX ranked every row against the whole table for every row (RANKX), so refresh grew with
the square of the users. The reference for the old columns is DuckDB's RANK(), which, like RANKX
ascending with the default Skip ties, is 1 + the number of smaller values. The new columns are
replayed step by step in Python with DAX's blank and DIVIDE rules (and, for UsageCohortRank, the
steps of CoworkBilling's query), over generated values with ties, blanks, zeros, negatives and
fractions, and table sizes from 0 up. Every active Consumption Central variant (Fabric, Viva
Direct, Local CSV) ships the same DAX and query steps, so each is checked. The archived Power
Automate + Dataverse variant is frozen, so it isn't.
"""
import bisect
import importlib.util
import json
import math
import random
import re
import unittest
import zipfile
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "Update-Model-Refresh-Fixes.py"


def load_script():
    spec = importlib.util.spec_from_file_location("update_model_refresh_fixes", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FIXES = load_script()
TEMPLATES = [ROOT / relative for relative, _, _, dax in FIXES.TARGETS if dax == "consumption"]
DUCKDB = duckdb.connect()
CUTS = [float(cut) for _, cut in FIXES.COHORT_CUTS]
COHORT_LABELS = [label.strip('"') for label in FIXES.COHORT_LABELS]
INTENSITY_LABELS = [label.strip('"') for label in FIXES.INTENSITY_LABELS]


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def code(dax):
    return "\n".join(line for line in dax.split("\n") if not line.lstrip().startswith("//"))


def read_part(path, name):
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read(name).decode("utf-16-le").lstrip("\ufeff"))


def model(path):
    return read_part(path, "DataModelSchema")["model"]


def number(value):
    """DAX compares a blank number as 0."""
    return 0 if value is None else value


def divide(numerator, denominator):
    return None if denominator == 0 else numerator / denominator


def build_samples():
    rng = random.Random(20240611)
    fixed = [
        [], [None], [0], [7], [-3], [None, None], [0, 0], [1, 1], [1, 2], [2, 1], [None, 0, -1],
        [5] * 100, list(range(1, 101)), list(range(100, 0, -1)), [0.1, 0.2, 0.30000000000000004, 0.3],
        [1e-12, 0, -1e-12, 1e15], [float(i % 3) for i in range(57)],
    ]
    for n in range(1, 41):
        fixed.append([rng.choice([None, 0, 1, 2, 2, 3]) for _ in range(n)])
    generated = []
    for _ in range(300):
        n = rng.choice([rng.randint(1, 30), rng.randint(31, 400), rng.randint(401, 2500)])
        pool = [None, 0, -5] + [rng.randint(1, max(2, n // 4)) for _ in range(8)] + [round(rng.random() * 50, 2)]
        style = rng.random()
        if style < 0.3:
            values = [rng.choice(pool) for _ in range(n)]
        elif style < 0.6:
            values = [rng.randint(-2, 3 * n) for _ in range(n)]
        else:
            values = [rng.choice([None, 0, rng.random() * 1000, rng.randint(1, 20)]) for _ in range(n)]
        generated.append(values)
    return fixed + generated


SAMPLES = build_samples()


def samples():
    return SAMPLES


def load(con, values):
    con.execute("CREATE OR REPLACE TABLE t AS SELECT unnest(range(len($v)))::INTEGER AS id, unnest($v) AS v",
                {"v": [None if v is None else float(v) for v in values]})


def old_cohort_ranks(values):
    """Old UsageCohortRank: SWITCH on DIVIDE( RANKX( ALL(table), v,, ASC ), COUNTROWS ) per row."""
    if not values:
        return []
    load(DUCKDB, values)
    rows = DUCKDB.execute("""
        SELECT id,
               CASE WHEN p <= 0.50::DOUBLE THEN 1 WHEN p <= 0.75::DOUBLE THEN 2
                    WHEN p <= 0.90::DOUBLE THEN 3 WHEN p <= 0.95::DOUBLE THEN 4
                    WHEN p <= 0.99::DOUBLE THEN 5 ELSE 6 END
        FROM (SELECT id, (RANK() OVER (ORDER BY COALESCE(v, 0)))::DOUBLE / (COUNT(*) OVER ())::DOUBLE AS p FROM t)
        ORDER BY id
    """).fetchall()
    return [bucket for _, bucket in rows]


def query_cut_rank(k, count):
    """CutValue's Rank: the largest of Near - 2 .. Near + 2 in 1..count with rank / count <= k."""
    near = math.floor(k * count)
    fits = [r for r in range(near - 2, near + 3) if 1 <= r <= count and r / count <= k]
    return max(fits) if fits else None


def new_cohort_ranks(values):
    """New UsageCohortRank, replaying CoworkBilling's query: sort once, read five cuts, compare."""
    ordered = sorted(number(v) for v in values)
    count = len(ordered)
    cuts = []
    for k in CUTS:
        rank = query_cut_rank(k, count)
        cuts.append(None if rank is None else ordered[rank - 1])
    result = []
    for value in values:
        used = number(value)
        hits = [cut is not None and used <= cut for cut in cuts]
        result.append(hits.index(True) + 1 if True in hits else 6)
    return result


def old_intensity(used):
    """Old Group By rows: [@Used] <= 0, else DIVIDE( RANKX( ByUser, [@Used],, ASC ), COUNTROWS ) <= k."""
    if not used:
        return []
    load(DUCKDB, used)
    rows = DUCKDB.execute("""
        SELECT id, v, (RANK() OVER (ORDER BY v))::DOUBLE / (COUNT(*) OVER ())::DOUBLE FROM t ORDER BY id
    """).fetchall()
    labels = []
    for _, value, p in rows:
        if value <= 0:
            labels.append("0. Not used")
        else:
            labels.append(next((label for cut, label in zip(CUTS, INTENSITY_LABELS) if p <= cut), INTENSITY_LABELS[-1]))
    return labels


def topn_ascending(count, values):
    """TOPN( count, table, value, ASC ): the first count rows in ascending order plus any ties at the edge."""
    if count <= 0 or not values:
        return []
    ordered = sorted(values)
    edge = ordered[min(count, len(ordered)) - 1]
    return [v for v in values if v <= edge]


def new_intensity(used):
    """New Group By rows, replaying the shipped VARs: N, Steps, M<k> and T<k>, then the SWITCH."""
    n = len(used) or None
    steps = range(1, max(number(n), 1) + 1)
    cuts = []
    for cut in CUTS:
        fits = [i for i in steps if number(divide(i, number(n))) <= cut]
        m = max(fits) if fits else 0
        top = topn_ascending(m, used)
        cuts.append(max(top) if m >= 1 and top else None)
    labels = []
    for value in used:
        if value <= 0:
            labels.append("0. Not used")
        else:
            labels.append(next((label for t, label in zip(cuts, INTENSITY_LABELS) if value <= number(t)),
                               INTENSITY_LABELS[-1]))
    return labels


class CohortEquivalence(unittest.TestCase):
    def test_usage_cohort_rank_matches_rankx(self):
        for values in samples():
            self.assertEqual(new_cohort_ranks(values), old_cohort_ranks(values), values[:20])

    def test_usage_cohort_label_follows_the_rank(self):
        # The old column ran the same ranking with labels in place of 1..6.
        for values in samples():
            old = [COHORT_LABELS[b - 1] for b in old_cohort_ranks(values)]
            new = [COHORT_LABELS[b - 1] for b in new_cohort_ranks(values)]
            self.assertEqual(new, old, values[:20])

    def test_group_by_intensity_matches_rankx(self):
        for values in samples():
            # @Used is CALCULATE( SUM(...) ) + 0, so it is never blank.
            used = [float(number(v)) for v in values]
            self.assertEqual(new_intensity(used), old_intensity(used), used[:20])

    def test_query_window_finds_the_largest_rank_under_each_cut(self):
        # The query looks only near floor(k * N); that window must hold the true largest m.
        sizes = [*range(0, 5001), 9999, 10000, 20000, 59999, 60000, 60001, 99999, 250000, 1000003]
        for n in sizes:
            for k in CUTS:
                m = math.floor(k * n)
                while m + 1 <= n and (m + 1) / n <= k:
                    m += 1
                while m >= 1 and m / n > k:
                    m -= 1
                self.assertEqual(query_cut_rank(k, n), m if m >= 1 else None, (n, k))

    def test_query_ranks_match_the_per_row_count(self):
        # The form shipped before the query: 1 + COUNTROWS( FILTER( ALL(table), [v] < v ) ).
        for values in samples():
            keys = sorted(number(v) for v in values)
            counted = []
            for value in values:
                p = number(divide(1 + bisect.bisect_left(keys, number(value)), len(values)))
                counted.append(next((i for i, cut in enumerate(CUTS, start=1) if p <= cut), 6))
            self.assertEqual(new_cohort_ranks(values), counted, values[:20])

    def test_rank_share_is_monotone_at_every_size(self):
        # rank <= m stands in for DIVIDE( rank, N ) <= k only if the shares never dip back under k.
        for n in [*range(1, 401), 1000, 4999, 20000, 59999, 60000, 60001, 250000]:
            for cut in CUTS:
                fits = [i / n <= cut for i in range(1, n + 1)]
                m = sum(fits)
                self.assertEqual(fits, [True] * m + [False] * (n - m), (n, cut))

    def test_every_branch_is_reached(self):
        seen_rank, seen_label = set(), set()
        for values in samples():
            seen_rank.update(new_cohort_ranks(values))
            seen_label.update(new_intensity([float(number(v)) for v in values]))
        self.assertEqual(seen_rank, set(range(1, 7)))
        self.assertEqual(seen_label, {"0. Not used", *INTENSITY_LABELS})


class ShippedCohortDax(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = {path.name: model(path) for path in TEMPLATES}
        cls.pending = {path.name: read_part(path, "UnappliedChanges") for path in TEMPLATES}

    def variants(self):
        for name, found in self.models.items():
            with self.subTest(template=name):
                self.model = found
                self.unapplied = self.pending[name]
                yield name

    def column(self, table_name, column_name):
        table = next(t for t in self.model["tables"] if t["name"] == table_name)
        return joined(next(c for c in table["columns"] if c["name"] == column_name)["expression"])

    def group_by(self):
        table = next(t for t in self.model["tables"] if t["name"] == "Group By")
        return joined(table["partitions"][0]["source"]["expression"])

    def test_every_variant_is_checked(self):
        self.assertEqual(len(TEMPLATES), 3)

    def test_columns_ship_the_new_expressions(self):
        for _ in self.variants():
            self.check_columns()

    def test_no_calculated_column_needs_a_context_transition_it_did_not_have(self):
        for _ in self.variants():
            self.check_no_new_context_transition()

    def test_usage_cohort_rank_is_loaded_by_the_query(self):
        self.assertIn("{0.50, 0.75, 0.90, 0.95, 0.99}", FIXES.COHORT_QUERY_STEPS)
        for _ in self.variants():
            self.check_cohort_rank_query()

    def test_group_by_ranks_each_product_once(self):
        for _ in self.variants():
            self.check_group_by()

    def test_no_calculated_column_ranks_a_whole_table_per_row(self):
        for _ in self.variants():
            self.check_no_whole_table_rank()

    def check_columns(self):
        for (table_name, column_name), (old, new) in FIXES.CONSUMPTION_COLUMNS.items():
            self.assertEqual(self.column(table_name, column_name), new, column_name)
            self.assertNotEqual(old, new)
        self.assertTrue(self.column("CoworkBilling", "UsageCohort").startswith("SWITCH('CoworkBilling'[UsageCohortRank],"))
        self.assertNotIn("CALCULATE", self.column("CreditsWeekly", "Weeks Ago"))

    def check_no_new_context_transition(self):
        # A second CALCULATE in CoworkBilling next to Weeks Active risks a circular dependency.
        for name in ("UsageCohort", "Weeks Over Limit"):
            self.assertNotIn("CALCULATE", self.column("CoworkBilling", name), name)

    def check_cohort_rank_query(self):
        table = next(t for t in self.model["tables"] if t["name"] == "CoworkBilling")
        column = next(c for c in table["columns"] if c["name"] == "UsageCohortRank")
        self.assertEqual(column, {
            "name": "UsageCohortRank", "dataType": "int64", "isHidden": True, "sourceColumn": "UsageCohortRank",
            "lineageTag": "7b0e3f86-4d29-4c51-9f3a-8e2c6b9d4e73", "summarizeBy": "none",
        })
        sort_by = next(c for c in table["columns"] if c["name"] == "UsageCohort")
        self.assertEqual(sort_by.get("sortByColumn"), "UsageCohortRank")
        partition = joined(table["partitions"][0]["source"]["expression"])
        pending = next(q for q in self.unapplied["queries"] if q["name"] == "CoworkBilling")
        for text in (partition, joined(pending["text"])):
            self.assertIn(FIXES.COHORT_QUERY_STEPS, text)
            self.assertTrue(text.endswith("\nin\n\tAddedCohortRank"))
        self.assertEqual(json.loads(pending["lastLoadedAsTableFormulaText"])["RootFormulaText"], partition)

    def check_group_by(self):
        text = self.group_by()
        self.assertNotIn("[@P]", text)
        for product in ("Studio", "GitHub"):
            self.assertNotIn("RANKX", code(text))
            for name, cut in FIXES.COHORT_CUTS:
                self.assertIn(f"VAR {product}M{name} = MAXX( FILTER( {product}Steps, DIVIDE( [Value], {product}N ) <= {cut} ), [Value] ) + 0", text)
                self.assertIn(f"VAR {product}T{name} = IF( {product}M{name} >= 1, MAXX( TOPN( {product}M{name}, {product}ByUser, [@Used], ASC ), [@Used] ) )", text)
            for (name, _), label in zip(FIXES.COHORT_CUTS, INTENSITY_LABELS):
                self.assertIn(f'[@Used] <= {product}T{name}, "{label}",', text)
        for label in INTENSITY_LABELS:
            self.assertEqual(text.count(f'"{label}"'), 2, label)

    def check_no_whole_table_rank(self):
        whole_table = re.compile(r"RANKX\s*\(\s*ALL\s*\(\s*'[^']+'\s*\)", re.IGNORECASE)
        for table in self.model["tables"]:
            for column in table.get("columns", []):
                if column.get("type") == "calculated":
                    text = code(joined(column["expression"]))
                    self.assertIsNone(whole_table.search(text), (table["name"], column["name"]))
                    self.assertNotIn("EARLIER", text.upper(), (table["name"], column["name"]))


if __name__ == "__main__":
    unittest.main()
