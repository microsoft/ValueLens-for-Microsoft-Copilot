//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, renderHook } from "@testing-library/react";
import { useContext, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilterContext, useOrgAttribute } from "@/hooks/filter.context";
import { PrefetchContext } from "@/hooks/prefetch.context";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { consumptionOrgAttributeOptions, filterOptions, orgAttributeOptions, orgValueOptions } from "@/queries/filters";
import { FilterProvider } from "./filter-provider";

type Answer =
    | { status: "success"; table: { columns: { name: string }[]; rows: unknown[][] } }
    | { status: "error"; error: { message: string } };

const mocks = vi.hoisted(() => ({
    asks: [] as { query: string; background?: boolean }[],
    /** What each render asks ahead of the menu, `""` for nothing. */
    speculated: [] as string[],
    answers: new Map<string, Answer>(),
    model: { workspaceId: "6f1c2b9a-0d4e-4f7a-9b3c-2e5d8a1f0c47", itemId: "a3e7d2c1-5b8f-4c6a-9e0d-7f2b4c1a8e39" },
}));

vi.mock("@/hooks/use-semantic-model-query", () => ({
    useSemanticModelQuery: ({ query, background }: { query: string; background?: boolean }) => {
        if (query) mocks.asks.push({ query, background });
        const data = query ? mocks.answers.get(query) : undefined;
        const error = data?.status === "error" ? new Error(data.error.message) : undefined;
        return { data, isLoading: Boolean(query) && data === undefined, error, refetch: () => {} };
    },
    useSpeculativeQuery: ({ query }: { query: string }) => {
        mocks.speculated.push(query);
    },
}));

vi.mock("@/lib/runtime-config", async (original) => ({
    ...(await original<typeof import("@/lib/runtime-config")>()),
    runtimeConfig: () => ({ host: "fabric", rayfin: {}, semanticModels: { vl: mocks.model, cc: mocks.model } }),
}));

const OPTIONS = filterOptions().query;
const ORG_COLUMNS = orgAttributeOptions().query;
const ORG_VALUES = orgValueOptions(describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE)).query;
const DEPARTMENT_VALUES = orgValueOptions(describeOrgAttribute("Department")).query;
const CONSUMPTION_ORG_ATTRIBUTES = consumptionOrgAttributeOptions().query;

function table(columns: Record<string, unknown[]>): Answer {
    const names = Object.keys(columns);
    const length = Math.max(...names.map((name) => columns[name].length));
    return {
        status: "success",
        table: {
            columns: names.map((name) => ({ name })),
            rows: Array.from({ length }, (_, row) => names.map((name) => columns[name][row])),
        },
    };
}

/** The org columns' statistics, with `Organization` worth grouping by only if it has more than one value. */
function orgColumns(organizations: number): Answer {
    return table({
        "[Column]": [DEFAULT_ORG_ATTRIBUTE, "Department"],
        "[Cardinality]": [organizations, 12],
        "[Max Length]": [8, 20],
        "[People]": [100, 100],
    });
}

const values = (...names: string[]) => table({ "[Value]": names });

function Breakdown({ byOrg }: { byOrg?: boolean }) {
    useOrgAttribute(byOrg);
    return null;
}

const asked = (query: string) => mocks.asks.some((ask) => ask.query === query);
/** Whether the latest render asks for the org columns in the background lane. */
const orgColumnsInBackground = () => mocks.asks.filter((ask) => ask.query === ORG_COLUMNS).at(-1)?.background;
/** What the latest render asks ahead of the menu. */
const speculating = () => mocks.speculated.at(-1);

/** Renders the provider around `extra`, with its context as `context.current`. */
function renderProvider(extra: ReactNode = null) {
    const { result, rerender } = renderHook(() => useContext(FilterContext), {
        wrapper: ({ children }: { children: ReactNode }) => (
            <FilterProvider applicable={["dateRange", "organizations"]}>
                {children}
                {extra}
            </FilterProvider>
        ),
    });
    return { context: result, rerender };
}

beforeEach(() => {
    mocks.asks.length = 0;
    mocks.speculated.length = 0;
    mocks.answers.clear();
});

describe("FilterProvider", () => {
    it("loads the filter options on screen, the org columns in the background, and nothing only a menu shows", () => {
        renderProvider();

        expect(mocks.asks.find((ask) => ask.query === OPTIONS)?.background).toBeFalsy();
        expect(orgColumnsInBackground()).toBe(true);
        expect(asked(ORG_VALUES)).toBe(false);
        expect(speculating()).toBe("");
        expect(asked(CONSUMPTION_ORG_ATTRIBUTES)).toBe(false);
    });

    it("loads the menus' choices, and the org columns on screen, once a filter menu opens", () => {
        const { context } = renderProvider();
        act(() => context.current.requestFilterChoices?.());

        expect(asked(CONSUMPTION_ORG_ATTRIBUTES)).toBe(true);
        expect(orgColumnsInBackground()).toBe(false);
        // The org columns are still loading, so the values of the column in use until they settle it are asked
        // beside them, and not offered yet.
        expect(speculating()).toBe(ORG_VALUES);
        expect(asked(ORG_VALUES)).toBe(false);
        expect(context.current.orgValues).toBeUndefined();
    });

    it("offers the values that loaded beside the org columns once those keep the column in use", () => {
        const { context, rerender } = renderProvider();
        act(() => context.current.requestFilterChoices?.());
        mocks.answers.set(ORG_VALUES, values("Org A", "Org B"));
        rerender();
        expect(context.current.orgValues).toBeUndefined();

        mocks.answers.set(ORG_COLUMNS, orgColumns(5));
        rerender();

        expect(context.current.orgAttribute.column).toBe(DEFAULT_ORG_ATTRIBUTE);
        // Asked as the query asked ahead was, so in the app it joins that query or reads its answer.
        expect(asked(ORG_VALUES)).toBe(true);
        expect(speculating()).toBe("");
        expect(context.current.orgValues).toEqual(["Org A", "Org B"]);
    });

    it("never offers one column's values under another's name when the org columns change the column", () => {
        const { context, rerender } = renderProvider();
        act(() => context.current.requestFilterChoices?.());
        mocks.answers.set(ORG_VALUES, values("Org A", "Org B"));
        rerender();

        // `Organization` has a single value here, so the breakdowns group by department instead.
        mocks.answers.set(ORG_COLUMNS, orgColumns(1));
        rerender();
        expect(context.current.orgAttribute.column).toBe("Department");
        expect(asked(DEPARTMENT_VALUES)).toBe(true);
        expect(asked(ORG_VALUES)).toBe(false);
        expect(speculating()).toBe("");
        expect(context.current.orgValues).toBeUndefined();

        mocks.answers.set(DEPARTMENT_VALUES, values("Finance", "Sales"));
        rerender();
        expect(context.current.orgValues).toEqual(["Finance", "Sales"]);
    });

    it("asks the org values at once when the org columns have already loaded, or failed to", () => {
        mocks.answers.set(ORG_COLUMNS, { status: "error", error: { message: "Couldn't read the org data." } });
        const { context } = renderProvider();
        act(() => context.current.requestFilterChoices?.());

        expect(context.current.orgAttribute.column).toBe(DEFAULT_ORG_ATTRIBUTE);
        expect(asked(ORG_VALUES)).toBe(true);
        expect(speculating()).toBe("");
    });

    it("loads Consumption Central's org attributes once an org filter is set, with no menu opened", () => {
        const { context } = renderProvider();
        act(() => context.current.setFilters((current) => ({ ...current, organizations: ["Finance"] })));

        expect(asked(CONSUMPTION_ORG_ATTRIBUTES)).toBe(true);
        expect(asked(ORG_VALUES)).toBe(false);
        expect(speculating()).toBe("");
        expect(orgColumnsInBackground()).toBe(true);
    });

    it("loads the org columns on screen once a breakdown by org mounts", () => {
        renderProvider(<Breakdown />);

        expect(orgColumnsInBackground()).toBe(false);
    });

    it("keeps the org columns in the background for a page that groups nothing by org, and for one fetched ahead", () => {
        renderProvider(
            <>
                <Breakdown byOrg={false} />
                <PrefetchContext.Provider value={true}>
                    <Breakdown />
                </PrefetchContext.Provider>
            </>,
        );

        expect(orgColumnsInBackground()).toBe(true);
    });
});