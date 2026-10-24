//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { FabricClient, type FabricClientConfig } from "@microsoft/fabric-app-data";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { useMemo, type ComponentType, type ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ErrorFallback } from "@/ErrorFallback";
import { FilterContext } from "@/hooks/filter.context";
import { ThemeContext } from "@/hooks/theme.context";
import { evaluateBody } from "@/lib/dax-filters";
import { defaultFilters, type FilterKey } from "@/lib/filters";
import { HttpFabricProxy } from "@/lib/http-fabric-proxy";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute, ORG_TABLE, withOrgAttribute } from "@/lib/org-attribute";
import { QueryScheduler, scheduledProxy } from "@/lib/query-scheduler";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import {
    activationByOrg,
    activationSummary,
    TREND_HEATMAP_ORGANIZATION_FIELD,
    trendHeatmap,
    trendHeatmapHeadline,
} from "@/queries/adoption";
import { ActivationStage } from "./activation-stage";
import { TrendHeatmapStage } from "./trend-heatmap-stage";

const state = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@/lib/fabric-client", async (original) => ({
    ...(await original<typeof import("@/lib/fabric-client")>()),
    getFabricClient: () => state.client,
}));

/** The chart writes out the table it was given, so a test can read what it would draw. */
vi.mock("@/components/vega-visual", () => ({
    VegaVisual: ({ data }: { data: DataTable }) => <pre data-testid="chart">{JSON.stringify(data)}</pre>,
}));

const MODELS = {
    vl: { workspaceId: "ws", itemId: "vl" },
    cc: { workspaceId: "ws", itemId: "cc" },
};

const JSON_HEADERS = { "content-type": "application/json" };

/** The heading of the root's error screen, which takes the place of the whole app. */
const CRASHED = "Something went wrong";

const ORGANIZATION = DEFAULT_ORG_ATTRIBUTE;
const OFFICE = "officeLocation";
const CITY = "City";

/** What each org column holds, as the model answers for it. */
const VALUES: Record<string, string[]> = {
    [ORGANIZATION]: ["Finance", "Legal"],
    [OFFICE]: ["Office 1", "Office 2"],
    [CITY]: ["City 1", "City 2"],
};

/** The label each column's values are shown under. */
const LABELS: Record<string, string> = {
    [ORGANIZATION]: "Organization",
    [OFFICE]: "Office location",
    [CITY]: "City",
};

interface Query {
    query: string;
    columnMetadata: ColumnMetadataMap;
}

/** Each stage that ranks its chart by the Group by, the query it asks for an org column, and the field it ranks by. */
const STAGES: { name: string; Stage: ComponentType; ranked: (column: string) => Query; field: string; others: Query[] }[] = [
    {
        name: "Adoption: Trend heatmap",
        Stage: TrendHeatmapStage,
        ranked: (column) => withOrgAttribute(trendHeatmap(), describeOrgAttribute(column)),
        field: TREND_HEATMAP_ORGANIZATION_FIELD,
        others: [trendHeatmapHeadline()],
    },
    {
        name: "Adoption: Activation",
        Stage: ActivationStage,
        ranked: (column) => withOrgAttribute(activationByOrg(), describeOrgAttribute(column)),
        field: activationByOrg().organization,
        others: [activationSummary()],
    },
];

/** One row per value of the org column, and per week where the query has weeks; every other column is a count. */
function rowsFor({ columnMetadata }: Query, column: string): Record<string, unknown>[] {
    const keys = Object.keys(columnMetadata);
    const org = `${ORG_TABLE}[${column}]`;
    if (!keys.includes(org)) throw new Error(`The query has no ${org} column.`);
    const week = keys.find((key) => key.endsWith("[WeekStart]"));
    const weeks = week ? ["2026-09-07T00:00:00", "2026-09-14T00:00:00"] : [undefined];
    return VALUES[column].flatMap((value, rank) =>
        weeks.map((start) => Object.fromEntries(keys.map((key) => [key, key === org ? value : key === week ? start : 10 - rank]))),
    );
}

/** A one-row answer: a sentence for a headline, otherwise a count. */
function rowOf({ columnMetadata }: Query): Record<string, unknown>[] {
    return [Object.fromEntries(Object.keys(columnMetadata).map((key) => [key, key.endsWith("Headline]") ? "Use is steady" : 1]))];
}

type Rows = Record<string, unknown>[] | "error";
type Asked = string | ((query: string) => boolean);

/**
 * The app's client on Azure: the SDK's JSON protocol through the same-origin API, with `fetch`
 * answering each query as it was told to, or holding the answer back until it is released.
 * A query is named by its text, or by a test of its text, as for one the filter bar has wrapped.
 */
function azure() {
    const answers = new Map<Asked, Rows>();
    const held = new Map<Asked, { answered: Promise<void>; release: () => void }>();
    const sent: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
            const { query } = JSON.parse(String(init.body)) as { query: string };
            sent.push(query);
            await find(held, query)?.answered;
            const rows = find(answers, query);
            if (rows === undefined || rows === "error") {
                const error = { error: { code: "QueryFailed", message: "The query failed." } };
                return new Response(JSON.stringify(error), { status: 400, headers: JSON_HEADERS });
            }
            return new Response(JSON.stringify({ results: [{ tables: [{ rows }] }] }), { status: 200, headers: JSON_HEADERS });
        }),
    );
    state.client = new FabricClient({
        proxy: scheduledProxy(new HttpFabricProxy(async () => "token"), new QueryScheduler({ log: () => {} })),
        daxProtocol: "json",
        cache: { maxEntries: 1000 },
        semanticModels: MODELS,
    } as FabricClientConfig);
    return {
        sent,
        answer(query: Asked, rows: Rows) {
            answers.set(query, rows);
        },
        hold(query: Asked) {
            let release = () => {};
            const answered = new Promise<void>((resolve) => (release = resolve));
            held.set(query, { answered, release });
        },
        release(query: Asked) {
            held.get(query)?.release();
            held.delete(query);
        },
    };
}

/** What the fake model was told for `query`: by its text first, then by the first test it passes. */
function find<T>(told: Map<Asked, T>, query: string): T | undefined {
    if (told.has(query)) return told.get(query);
    for (const [asked, value] of told) if (typeof asked !== "string" && asked(query)) return value;
    return undefined;
}

/** `query` once the filter bar has wrapped it: another query that still holds its body. */
const filteredFrom = ({ query }: Query) => (asked: string) => asked !== query && asked.includes(evaluateBody(query));

function Themed({ children }: { children: ReactNode }) {
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ theme, isDark: false, toggleTheme: () => {} }}>{children}</ThemeContext.Provider>;
}

const APPLICABLE: FilterKey[] = ["organizations"];
const NO_ORGS: string[] = [];

/** The filter bar, grouping by `column`, and filtered to `organizations` when there are any. */
function GroupBy({ column, organizations, children }: { column: string; organizations: string[]; children: ReactNode }) {
    const value = useMemo(
        () => ({
            filters: { ...defaultFilters, orgAttribute: column, organizations },
            setFilters: () => {},
            options: undefined,
            optionsError: undefined,
            applicable: APPLICABLE,
            orgAttribute: describeOrgAttribute(column),
            orgAttributes: [ORGANIZATION, OFFICE, CITY],
            orgValues: undefined,
        }),
        [column, organizations],
    );
    return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

/** One stage grouped by `column`, under the root's error boundary, so a stage that throws shows the error screen as the app does. */
function page(Stage: ComponentType, column: string, organizations = NO_ORGS) {
    return (
        <Themed>
            <ErrorBoundary FallbackComponent={ErrorFallback}>
                <GroupBy column={column} organizations={organizations}>
                    <Stage />
                </GroupBy>
            </ErrorBoundary>
        </Themed>
    );
}

/** The chart's org values, in the order drawn, and the label they're shown under; undefined while no chart is drawn. */
function drawn(field: string): { label: string | undefined; values: unknown[] } | undefined {
    const text = screen.queryByTestId("chart")?.textContent;
    if (!text) return undefined;
    const table = JSON.parse(text) as DataTable;
    const index = table.columns.findIndex((column) => column.name === field);
    if (index < 0) return { label: undefined, values: [] };
    return { label: table.columns[index].displayName, values: [...new Set(table.rows.map((row) => row[index]))] };
}

/** What the chart draws once grouped by `column`. */
const answerFor = (column: string) => ({ label: LABELS[column], values: VALUES[column] });

function expectNoCrash() {
    expect(screen.queryByText(CRASHED), document.body.textContent ?? "").toBeNull();
}

/** Lets an answer that is no longer wanted arrive and be ignored. */
async function settle() {
    for (let turn = 0; turn < 5; turn++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    warn = vi.spyOn(console, "warn");
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe.each(STAGES)("$name, when the Group by changes", ({ Stage, ranked, field, others }) => {
    /** The model answering every query the stage asks, for each org column. */
    function answering() {
        const model = azure();
        for (const other of others) model.answer(other.query, rowOf(other));
        for (const column of [ORGANIZATION, OFFICE, CITY]) model.answer(ranked(column).query, rowsFor(ranked(column), column));
        return model;
    }

    it("keeps each answer with its own labels until the next one comes, in every direction", async () => {
        const model = answering();
        const { rerender } = render(page(Stage, ORGANIZATION));
        await waitFor(() => expect(drawn(field)).toEqual(answerFor(ORGANIZATION)));

        // From Organization to another attribute: the organizations stay on screen, as organizations, while it loads.
        model.hold(ranked(OFFICE).query);
        rerender(page(Stage, OFFICE));
        expectNoCrash();
        expect(drawn(field)).toEqual(answerFor(ORGANIZATION));
        model.release(ranked(OFFICE).query);
        await waitFor(() => expect(drawn(field)).toEqual(answerFor(OFFICE)));

        // Between two other attributes.
        model.hold(ranked(CITY).query);
        rerender(page(Stage, CITY));
        expectNoCrash();
        expect(drawn(field)).toEqual(answerFor(OFFICE));
        model.release(ranked(CITY).query);
        await waitFor(() => expect(drawn(field)).toEqual(answerFor(CITY)));

        // Back to Organization, which the cache answers: the cities still show until it does.
        rerender(page(Stage, ORGANIZATION));
        expectNoCrash();
        expect(drawn(field)).toEqual(answerFor(CITY));
        await waitFor(() => expect(drawn(field)).toEqual(answerFor(ORGANIZATION)));

        expectNoCrash();
        expect(warn.mock.calls.flat().join("\n")).not.toMatch(/not found/);
    });

    it("shows the new attribute's answer after a change made while the first answer was loading", async () => {
        const model = answering();
        model.hold(ranked(ORGANIZATION).query);
        const { rerender } = render(page(Stage, ORGANIZATION));
        await waitFor(() => expect(model.sent).toContain(ranked(ORGANIZATION).query));
        expect(screen.getAllByRole("status").length).toBeGreaterThan(0);

        rerender(page(Stage, OFFICE));
        expectNoCrash();
        await waitFor(() => expect(drawn(field)).toEqual(answerFor(OFFICE)));

        // The organizations' answer, arriving late, is no longer the stage's to show.
        model.release(ranked(ORGANIZATION).query);
        await settle();
        expectNoCrash();
        expect(drawn(field)).toEqual(answerFor(OFFICE));
    });

    it("shows the new attribute's answer after a change made while showing an error", async () => {
        const model = answering();
        model.answer(ranked(ORGANIZATION).query, "error");
        const { rerender } = render(page(Stage, ORGANIZATION));
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

        rerender(page(Stage, OFFICE));
        expectNoCrash();
        await waitFor(() => expect(drawn(field)).toEqual(answerFor(OFFICE)));
        expect(screen.queryAllByRole("alert")).toEqual([]);
    });

    it("keeps the last answer on screen while a changed filter loads, as before", async () => {
        const model = answering();
        const { rerender } = render(page(Stage, ORGANIZATION));
        await waitFor(() => expect(drawn(field)).toEqual(answerFor(ORGANIZATION)));

        const byOrg = ranked(ORGANIZATION);
        const finance = filteredFrom(byOrg);
        const financeRows = rowsFor(byOrg, ORGANIZATION).filter((row) => row[`${ORG_TABLE}[${ORGANIZATION}]`] === "Finance");
        for (const other of others) model.answer(filteredFrom(other), rowOf(other));
        model.answer(finance, financeRows);
        model.hold(finance);

        rerender(page(Stage, ORGANIZATION, ["Finance"]));
        expectNoCrash();
        expect(drawn(field)).toEqual(answerFor(ORGANIZATION));
        await waitFor(() => expect(model.sent.some(finance)).toBe(true));
        await settle();
        expect(drawn(field)).toEqual(answerFor(ORGANIZATION));

        model.release(finance);
        await waitFor(() => expect(drawn(field)).toEqual({ label: LABELS[ORGANIZATION], values: ["Finance"] }));
        expectNoCrash();
    });
});
