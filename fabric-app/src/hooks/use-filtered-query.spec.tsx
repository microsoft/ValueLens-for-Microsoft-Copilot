//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONSUMPTION_COWORK, REGISTRY } from "@/lib/filter-profiles";
import { defaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import type { SavedTaskTime } from "@/lib/settings-store";
import { connection as valueLens } from "@/queries/shared";
import { FilterContext } from "./filter.context";
import { PrefetchContext } from "./prefetch.context";
import { TaskTimesContext, type TaskTimesContextValue } from "./task-times.context";
import { useFilteredQuery, type FilteredQueryConfig } from "./use-filtered-query";

const queries = vi.hoisted(() => [] as string[]);
const speculated = vi.hoisted(() => [] as string[]);

vi.mock("./use-semantic-model-query", () => ({
    useSemanticModelQuery: ({ query }: { query: string }) => {
        queries.push(query);
        return { data: undefined, isLoading: false, refetch: () => undefined };
    },
    useSpeculativeQuery: ({ query }: { query: string }) => {
        speculated.push(query);
    },
}));

const STATE: FilterState = {
    ...defaultFilters,
    dateRange: { preset: "custom", from: "2026-01-01", to: "2026-03-31" },
    organizations: ["Sales"],
    agentNames: ["Helper"],
};

function wrapper(applicable: readonly FilterKey[], consumptionOrgAttributes?: readonly string[]) {
    return ({ children }: { children: ReactNode }) => (
        <FilterContext.Provider
            value={{
                filters: STATE,
                setFilters: () => undefined,
                options: undefined,
                optionsError: undefined,
                applicable,
                orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                orgValues: undefined,
                consumptionOrgAttributes,
            }}
        >
            {children}
        </FilterContext.Provider>
    );
}

const COWORK = { connection: "cc", query: "EVALUATE 'Cowork'", filters: CONSUMPTION_COWORK };
const lastQuery = () => queries[queries.length - 1];

describe("useFilteredQuery", () => {
    beforeEach(() => {
        queries.length = 0;
    });

    it("applies what the query's profile can take and returns the rest with reasons", () => {
        const { result } = renderHook(() => useFilteredQuery(COWORK), {
            wrapper: wrapper(["dateRange", "organizations", "agentNames"]),
        });

        expect(lastQuery()).toContain("CALCULATETABLE(");
        expect(lastQuery()).toContain("'Org'[UserPrincipalName]");
        expect(result.current.notFilteredBy.map((item) => item.key)).toEqual(["dateRange", "agentNames"]);
        expect(result.current.notFilteredBy.every((item) => item.reason.endsWith("."))).toBe(true);
    });

    it("leaves out filters the destination doesn't offer, and those the caller ignores", () => {
        const { result } = renderHook(() => useFilteredQuery(COWORK, { ignore: ["organizations"] }), {
            wrapper: wrapper(["dateRange", "organizations"]),
        });

        expect(lastQuery()).toBe("EVALUATE 'Cowork'");
        expect(result.current.notFilteredBy.map((item) => item.key)).toEqual(["dateRange"]);
    });

    it("says so when Consumption Central lacks the org attribute in use", () => {
        const { result } = renderHook(() => useFilteredQuery(COWORK), {
            wrapper: wrapper(["organizations"], ["Department"]),
        });

        expect(lastQuery()).toBe("EVALUATE 'Cowork'");
        expect(result.current.notFilteredBy).toEqual([
            { key: "organizations", reason: expect.stringContaining("Consumption Central has no") },
        ]);
    });

    it("keeps the caller's own filters alongside the profile's", () => {
        const registry = { connection: "vl", query: "EVALUATE 'Agents 365'", filters: REGISTRY };
        renderHook(() => useFilteredQuery(registry, { extra: ["'Agents 365'[Status] = \"Live\""] }), {
            wrapper: wrapper(["agentNames"]),
        });

        expect(lastQuery()).toContain("'Agents 365'[Agent name]");
        expect(lastQuery()).toContain("'Agents 365'[Status] = \"Live\"");
    });
});

describe("useFilteredQuery, while the saved task times load", () => {
    const HOURS = { connection: valueLens, query: 'EVALUATE ROW("Hours", [Expert Equivalent Hours])' };
    const SAVED: readonly SavedTaskTime[] = [{ task: "Summarise a meeting", low: 5, typical: 10, high: 20 }];
    const lastSpeculated = () => speculated[speculated.length - 1];

    function open(config: FilteredQueryConfig, status: TaskTimesContextValue["status"], saved: readonly SavedTaskTime[] = [], prefetch = false) {
        const Filters = wrapper(["organizations"]);
        return renderHook(() => useFilteredQuery(config), {
            wrapper: ({ children }: { children: ReactNode }) => (
                <PrefetchContext.Provider value={prefetch}>
                    <TaskTimesContext.Provider value={{ status, saved, save: () => Promise.resolve() }}>
                        <Filters>{children}</Filters>
                    </TaskTimesContext.Provider>
                </PrefetchContext.Provider>
            ),
        });
    }

    beforeEach(() => {
        queries.length = 0;
        speculated.length = 0;
    });

    it("asks a query that may speculate at the model's own minutes, filtered just as the card asks it once none turn out saved", () => {
        const { result } = open({ ...HOURS, speculate: true }, "loading");
        expect(lastQuery()).toBe("");
        expect(result.current.isLoading).toBe(true);
        const early = lastSpeculated();
        expect(early).toContain("CALCULATETABLE(");
        expect(early).toContain("[Expert Equivalent Hours]");

        open({ ...HOURS, speculate: true }, "ready");
        expect(lastQuery()).toBe(early);
        expect(lastSpeculated()).toBe("");

        open({ ...HOURS, speculate: true }, "unavailable");
        expect(lastQuery()).toBe(early);
    });

    it("leaves the card to ask again at the times saved, which the early query wasn't", () => {
        open({ ...HOURS, speculate: true }, "loading");
        const early = lastSpeculated();

        open({ ...HOURS, speculate: true }, "ready", SAVED);
        expect(lastQuery()).not.toBe(early);
        expect(lastQuery()).toContain('"Summarise a meeting"');
        expect(lastSpeculated()).toBe("");
    });

    it("doesn't speculate unless asked to, while a page is fetched ahead, or for a query the task times don't change", () => {
        open(HOURS, "loading");
        open({ ...HOURS, speculate: true }, "loading", [], true);
        open({ connection: valueLens, query: "EVALUATE 'Agents 365'", speculate: true }, "loading");
        open({ ...COWORK, speculate: true }, "loading");

        expect(speculated.length).toBeGreaterThan(0);
        expect(speculated.every((query) => query === "")).toBe(true);
    });
});
