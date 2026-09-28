//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
    cohortTaskField,
    ORGANIZATION_COLUMN,
    surfaceUsage,
    taskBreakdown,
    taskDimensions,
    USER_COLUMN,
    userLeaderboard,
    workCohorts,
    workSummary,
    type WorkCohort,
} from "./index";
import { liveColumns } from "./live-columns.fixture";

const modules = [
    { name: "workSummary", factory: () => workSummary(), columns: liveColumns.workSummary },
    { name: "taskBreakdown", factory: () => taskBreakdown(), columns: liveColumns.taskBreakdown },
    {
        name: "surfaceUsage",
        factory: () => surfaceUsage({ lens: "surface" }),
        columns: liveColumns.surfaceUsage,
    },
    { name: "userLeaderboard", factory: () => userLeaderboard(), columns: liveColumns.userLeaderboard },
];

/** Characters `ColumnDef.name` strips from the original DAX column name. */
function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

/** Every `field` reference anywhere in a Vega-Lite spec. */
function collectFields(node: unknown, found: Set<string> = new Set()): Set<string> {
    if (Array.isArray(node)) {
        node.forEach((item) => collectFields(item, found));
    } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            if (key === "field" && typeof value === "string") {
                found.add(value);
            } else if (key === "fold" && Array.isArray(value)) {
                value.forEach((item) => typeof item === "string" && found.add(item));
            } else {
                collectFields(value, found);
            }
        }
    }
    return found;
}

describe("work query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        const { columnMetadata } = factory();
        expect(Object.keys(columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        const { columnMetadata } = factory();
        for (const [original, def] of Object.entries(columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets the bound connection", ({ factory }) => {
        expect(factory().connection).toBe("vl");
    });

    it.each(modules)("$name ships a non-empty DAX query", ({ factory }) => {
        const raw = factory().query;
        // `trim()` treats U+FEFF as whitespace, so the BOM has to be checked on
        // the raw string — it survives Vite's ?raw import and would otherwise be
        // sent to the query service as part of the statement.
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
    });

    // Every measure below was confirmed to exist in the published model. The
    // report also binds to measures that do not exist there at all; naming one
    // of those in a query returns an error rather than a blank, so the list is
    // repeated here to make an accidental reintroduction fail the build.
    it("never names a measure the published model does not define", () => {
        const absent = [
            "Licensed Utilisation %",
            "NoOfActiveChatUsers (Licensed)",
            "NoOfActiveChatUsers (Unlicensed)",
            "Copilot AI Tasks Per User Per Week",
            "AI Tasks per Active User per Week",
            "UsersInteractingWithAgents",
            "Agent AI Tasks Per User Per Week",
        ];

        for (const { name, factory } of modules) {
            for (const measure of absent) {
                expect(factory().query, `${name} references [${measure}]`).not.toContain(`[${measure}]`);
            }
        }
    });
});

describe("work cohorts", () => {
    it("names a task column for every cohort the toggles offer", () => {
        const available = new Set(Object.values(surfaceUsage({ lens: "surface" }).columnMetadata).map((d) => d.name));
        for (const { id } of workCohorts) {
            expect(available, `cohort "${id}"`).toContain(cohortTaskField(id));
        }
    });

    it("binds the selected cohort's column to the value axis", () => {
        for (const { id } of workCohorts) {
            const serialized = JSON.stringify(surfaceUsage({ lens: "model", cohort: id }).vegaLiteSpec);
            expect(serialized).toContain(`"field":"${cohortTaskField(id)}"`);
        }
    });

    it("keeps the leaderboard's grid column ids in step with the query", () => {
        const { columnMetadata } = userLeaderboard();
        const available = new Set(Object.values(columnMetadata).map((def) => def.name));
        expect(available).toContain(ORGANIZATION_COLUMN);
        expect(available).toContain(USER_COLUMN);
    });

    it("keeps the leaderboard's task columns aligned with the cohorts", () => {
        const { columnMetadata } = userLeaderboard();
        const available = new Set(Object.values(columnMetadata).map((def) => def.name));
        for (const { id } of workCohorts) {
            expect(available, `cohort "${id}"`).toContain(cohortTaskField(id));
        }
    });
});

describe("work spec field references", () => {
    const specModules = [
        ...taskDimensions.map(({ id }) => ({
            name: `taskBreakdown (${id})`,
            factory: () => taskBreakdown({ dimension: id }),
        })),
        ...(["surface", "model"] as const).flatMap((lens) =>
            workCohorts.map(({ id }) => ({
                name: `surfaceUsage (${lens}, ${id})`,
                factory: () => surfaceUsage({ lens, cohort: id as WorkCohort }),
            })),
        ),
    ];

    it.each(specModules)("$name only references columns the query returns", ({ factory }) => {
        const { columnMetadata, vegaLiteSpec } = factory();
        const available = new Set(Object.values(columnMetadata).map((def) => def.name));

        for (const field of collectFields(vegaLiteSpec)) {
            expect(available, `unknown field "${field}"`).toContain(field);
        }
    });

    it.each(specModules)("$name leaves no unsubstituted placeholders", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/__[A-Z]+__/);
    });

    // DAX returns dates as ISO strings and Vega-Lite's `timeUnit` does not
    // parse them, collapsing every point onto one x position. No Work spec
    // plots a date today; this keeps it that way by accident-proofing.
    it.each(specModules)("$name never relies on timeUnit to parse dates", ({ factory }) => {
        expect(JSON.stringify(factory().vegaLiteSpec)).not.toMatch(/"timeUnit"/);
    });

    it("filters each lens to its own rows so the shared result never double-counts", () => {
        for (const { id } of taskDimensions) {
            const { vegaLiteSpec } = taskBreakdown({ dimension: id });
            const serialized = JSON.stringify(vegaLiteSpec);
            expect(serialized).toMatch(/"filter":"datum\.Dimension === '[^']+'"/);
        }

        for (const lens of ["surface", "model"] as const) {
            const serialized = JSON.stringify(surfaceUsage({ lens }).vegaLiteSpec);
            expect(serialized).toMatch(/"filter":"datum\.Lens === '[^']+'"/);
        }
    });

    it("plots a dimension value the query actually emits", () => {
        const { query } = taskBreakdown();
        for (const { id } of taskDimensions) {
            const spec = JSON.stringify(taskBreakdown({ dimension: id }).vegaLiteSpec);
            const [, value] = spec.match(/"filter":"datum\.Dimension === '([^']+)'"/) ?? [];
            expect(query, `dimension "${value}" is never produced`).toContain(`"Dimension", "${value}"`);
        }
    });

    it("does not let one variant's spec changes leak into the next", () => {
        surfaceUsage({ lens: "model", cohort: "agents" });
        const followUp = JSON.stringify(surfaceUsage({ lens: "surface" }).vegaLiteSpec);
        expect(followUp).toContain(`"filter":"datum.Lens === 'Surface'"`);
        expect(followUp).toContain(`"field":"All Tasks"`);
    });
});

describe("leaderboard rollup", () => {
    it("declares the rollup flag the query emits and keeps it out of the grid", () => {
        const { query, columnMetadata, rollupFlagColumns } = userLeaderboard();
        expect(rollupFlagColumns).toEqual(["[IsTotal]"]);
        expect(query).toContain(`"IsTotal"`);
        for (const flag of rollupFlagColumns) {
            expect(Object.keys(columnMetadata)).not.toContain(flag);
        }
    });

    // `toRollupDataTables` rejects rows where the flags disagree, which is what
    // a per-organization subtotal would produce. ROLLUPGROUP collapses both
    // grouping columns into one level so only detail rows and a single grand
    // total come back.
    it("groups both key columns into one rollup level", () => {
        expect(userLeaderboard().query).toMatch(/ROLLUPADDISSUBTOTAL\(\s*ROLLUPGROUP\(/);
    });
});
