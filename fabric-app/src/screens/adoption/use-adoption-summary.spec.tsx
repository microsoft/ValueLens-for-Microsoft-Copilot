//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CachedQueryResult } from "@microsoft/fabric-app-data";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { PrefetchContext } from "@/hooks/prefetch.context";
import { TaskTimesContext, type TaskTimesContextValue } from "@/hooks/task-times.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { defaultFilters, FILTER_COLUMNS, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import {
    columns,
    frame,
    isSpuw,
    lf,
    WHOLE_ADOPTION_SUMMARY as WHOLE,
    withoutSpuw,
} from "@/queries/adoption/adoption-summary-whole.fixture";
import { connection as valueLens } from "@/queries/shared";
import type { SavedTaskTime } from "@/services/task-times.service";
import { useAdoptionSummary } from "./use-adoption-summary";

interface Answer {
    data?: CachedQueryResult;
    isLoading?: boolean;
    error?: Error;
}

/** What the model is asked, and what each part answers: the core, the SPUW part, or the whole query as rc.1 asked it. */
const model = vi.hoisted(() => ({
    sent: [] as string[],
    answers: {} as Record<string, Answer | undefined>,
    refetched: [] as string[],
    partOf(query: string): string {
        if (!query) return "none";
        const rates = query.includes('"Overall SPUW"');
        const users = query.includes('"Overall Users"');
        return rates && users ? "whole" : rates ? "spuw" : users ? "core" : "other";
    },
}));

vi.mock("@/hooks/use-semantic-model-query", () => ({
    useSemanticModelQuery: ({ query }: { query: string }) => {
        const part = model.partOf(query);
        model.sent.push(query);
        const answer = model.answers[part] ?? {};
        return {
            data: answer.data,
            isLoading: answer.isLoading ?? false,
            error: answer.error,
            refetch: () => {
                model.refetched.push(part);
                return Promise.resolve();
            },
        };
    },
    useSpeculativeQuery: () => undefined,
}));

const IGNORED: readonly FilterKey[] = ["licence", "audience"];
const STATE: FilterState = {
    ...defaultFilters,
    dateRange: { preset: "custom", from: "2026-01-01", to: "2026-03-31" },
    licence: "licensed",
    audience: "copilot",
    agentNames: ["Helper"],
};
const APPLICABLE: readonly FilterKey[] = ["dateRange", "licence", "audience", "agentNames"];
const SAVED: readonly SavedTaskTime[] = [{ task: "Email Drafting", low: 6, typical: 16, high: 24 }];

const times: { status: TaskTimesContextValue["status"]; saved: readonly SavedTaskTime[] } = { status: "ready", saved: [] };

function Wrapper({ children }: { children: ReactNode }) {
    return (
        <PrefetchContext.Provider value={false}>
            <TaskTimesContext.Provider value={{ status: times.status, saved: times.saved, save: () => Promise.resolve() }}>
                <FilterContext.Provider
                    value={{
                        filters: STATE,
                        setFilters: () => undefined,
                        options: undefined,
                        optionsError: undefined,
                        applicable: APPLICABLE,
                        orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                        orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                        orgValues: undefined,
                        consumptionOrgAttributes: undefined,
                    }}
                >
                    {children}
                </FilterContext.Provider>
            </TaskTimesContext.Provider>
        </PrefetchContext.Provider>
    );
}

/** The whole query's fifteen columns, named as the model answers them. */
const NAMES = columns(WHOLE).map((column) => `[${/^"([^"]+)"/.exec(column)?.[1]}]`);
const CORE_NAMES = NAMES.filter((name) => !name.endsWith(" SPUW]"));
const SPUW_NAMES = NAMES.filter((name) => name.endsWith(" SPUW]"));

let requests = 0;

/** An answer of one row, each column a different figure for the given round. */
function answer(names: readonly string[], round: number): CachedQueryResult {
    return {
        status: "success",
        table: {
            columns: names.map((name) => ({ name, dataType: "Double" })),
            rows: [names.map((_name, index) => round * 100 + index)],
        },
        requestId: `request-${++requests}`,
        fromCache: false,
    };
}

function failure(message: string): CachedQueryResult {
    return { status: "error", error: { category: "query", message }, requestId: `request-${++requests}`, fromCache: false };
}

/** The pair of figures one round's answers make. */
function figures(round: number): Record<string, unknown> {
    return Object.fromEntries([
        ...CORE_NAMES.map((name, index) => [name, round * 100 + index]),
        ...SPUW_NAMES.map((name, index) => [name, round * 100 + index]),
    ]);
}

const latest = (part: string) => model.sent.filter((query) => model.partOf(query) === part).at(-1);
/** The query from its EVALUATE on, without the definitions the task times add ahead of it. */
const statement = (query: string) => lf(query).slice(lf(query).search(/^EVALUATE\b/m));

function open() {
    return renderHook(() => useAdoptionSummary(IGNORED), { wrapper: Wrapper });
}

describe("useAdoptionSummary", () => {
    beforeEach(() => {
        model.sent.length = 0;
        model.refetched.length = 0;
        model.answers = {};
        times.status = "ready";
        times.saved = [];
    });

    it("asks both parts under the filters the whole query took, with the task times only where they change a figure", () => {
        times.saved = SAVED;
        open();
        const [core, spuw] = [latest("core"), latest("spuw")];
        renderHook(() => useFilteredQuery({ connection: valueLens, query: WHOLE }, { ignore: IGNORED }), { wrapper: Wrapper });
        const whole = latest("whole");
        renderHook(() => useFilteredQuery({ connection: valueLens, query: WHOLE }), { wrapper: Wrapper });
        const unignored = latest("whole");
        if (!core || !spuw || !whole || !unignored) throw new Error("A part was never asked.");

        expect(whole).toMatch(/^DEFINE\n/);
        expect(whole).toContain('"Email Drafting", SWITCH(');
        expect(lf(core)).toBe(withoutSpuw(whole));

        expect(lf(spuw)).toBe(statement(spuw));
        expect(frame(lf(spuw))).toEqual(frame(statement(whole)));
        expect(columns(spuw)).toEqual(columns(WHOLE).filter(isSpuw));
        expect(statement(spuw)).toContain(FILTER_COLUMNS.date);
        expect(statement(spuw)).toContain(FILTER_COLUMNS.agentName);

        for (const column of [FILTER_COLUMNS.licence, FILTER_COLUMNS.audience]) {
            expect(statement(unignored)).toContain(column);
            expect(statement(whole)).not.toContain(column);
            expect(statement(spuw)).not.toContain(column);
        }
    });

    it("shows nothing until both parts answer, then the whole query's fifteen figures", () => {
        model.answers = { core: { isLoading: true }, spuw: { isLoading: true } };
        const { result, rerender } = open();
        expect(result.current).toMatchObject({ row: undefined, loaded: false, error: undefined });

        model.answers.spuw = { data: answer(SPUW_NAMES, 1) };
        rerender();
        expect(result.current).toMatchObject({ row: undefined, loaded: false, error: undefined });

        model.answers.core = { data: answer(CORE_NAMES, 1) };
        rerender();
        expect(result.current.loaded).toBe(true);
        expect(result.current.row).toEqual(figures(1));
        expect(Object.keys(result.current.row ?? {}).sort()).toEqual([...NAMES].sort());
    });

    it.each(["core", "spuw"])(
        "keeps the pair it shows while both parts ask again, when the %s part answers first",
        (first) => {
            const second = first === "core" ? "spuw" : "core";
            const names = { core: CORE_NAMES, spuw: SPUW_NAMES } as Record<string, readonly string[]>;
            const before = { core: answer(CORE_NAMES, 1), spuw: answer(SPUW_NAMES, 1) } as Record<string, CachedQueryResult>;
            model.answers = { core: { data: before.core }, spuw: { data: before.spuw } };
            const { result, rerender } = open();
            expect(result.current.row).toEqual(figures(1));

            model.answers = { core: { data: before.core, isLoading: true }, spuw: { data: before.spuw, isLoading: true } };
            rerender();
            expect(result.current.row).toEqual(figures(1));

            model.answers[first] = { data: answer(names[first], 2) };
            rerender();
            expect(result.current.row).toEqual(figures(1));
            expect(result.current.loaded).toBe(true);

            model.answers[second] = { data: answer(names[second], 2) };
            rerender();
            expect(result.current.row).toEqual(figures(2));
        },
    );

    it("says which part failed, and tries again only that part", () => {
        const failed = (message: string): Answer => ({ data: failure(message), error: new Error(message) });
        const cases: [Answer, Answer, string | undefined, string[]][] = [
            [failed("The core failed."), { data: answer(SPUW_NAMES, 1) }, "The core failed.", ["core"]],
            [{ data: answer(CORE_NAMES, 1) }, failed("The rates failed."), "The rates failed.", ["spuw"]],
            [failed("The core failed."), failed("The rates failed."), "The core failed.", ["core", "spuw"]],
            [{ data: answer(CORE_NAMES, 1) }, { data: answer(SPUW_NAMES, 1) }, undefined, ["core", "spuw"]],
        ];
        for (const [core, spuw, error, retried] of cases) {
            model.answers = { core, spuw };
            model.refetched.length = 0;
            const { result } = open();
            expect(result.current.error).toBe(error);
            expect(result.current.loaded).toBe(error === undefined);
            act(() => result.current.refetch());
            expect(model.refetched).toEqual(retried);
        }
    });

    it("keeps the pair from before while a part's ask has thrown, as the one query kept its answer", () => {
        const before = { core: answer(CORE_NAMES, 1), spuw: answer(SPUW_NAMES, 1) };
        model.answers = { core: { data: before.core }, spuw: { data: before.spuw } };
        const { result, rerender } = open();

        model.answers = { core: { data: before.core, error: new Error("The network went away.") }, spuw: { data: answer(SPUW_NAMES, 2) } };
        rerender();
        expect(result.current).toMatchObject({ row: figures(1), loaded: true, error: undefined });

        model.answers.core = { data: answer(CORE_NAMES, 2) };
        rerender();
        expect(result.current.row).toEqual(figures(2));
    });

    it("asks the SPUW part while the task times load, and the core once they're known", () => {
        times.status = "loading";
        const { result, rerender } = open();
        const early = latest("spuw");
        expect(early).toBeDefined();
        expect(latest("core")).toBeUndefined();
        expect(result.current.loaded).toBe(false);

        times.status = "ready";
        times.saved = SAVED;
        rerender();
        expect(latest("core")).toMatch(/^DEFINE\n/);
        expect(latest("spuw")).toBe(early);
    });
});
