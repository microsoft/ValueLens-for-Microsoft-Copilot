//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { data?: unknown; error?: Error };

const mocked = vi.hoisted(() => ({
    calls: [] as string[],
    modules: {} as Record<string, boolean | undefined>,
    semanticModels: {} as Record<string, { workspaceId: string; itemId: string } | undefined>,
    answer: (() => ({})) as (query: string) => Answer,
}));

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ modules: mocked.modules, semanticModels: mocked.semanticModels }),
}));

vi.mock("./use-semantic-model-query", () => ({
    useSemanticModelQuery: ({ query }: { query: string }) => {
        mocked.calls.push(query);
        return query ? mocked.answer(query) : { data: undefined, error: undefined };
    },
}));

import {
    mergedSourceProbe,
    OPTIONAL_SOURCES,
    readSourceState,
    SOURCE_PROBES,
    type OptionalSource,
    type SourceAvailability,
} from "@/lib/optional-sources";
import { BUSY_MESSAGE } from "@/lib/query-scheduler";
import { toSummaryRow } from "@/lib/summary-row";
import { useSourceProbes } from "./use-source-probes";

/** What the engine says when the source's table or measure isn't in the model. */
const MISSING: Record<OptionalSource, string> = {
    m365Activity: "Query (2, 25) Cannot find table 'M365 Activity'.",
    productFeedback: "Query (3, 28) Cannot find table 'ProductFeedback'.",
    agentRegistry: "Query (4, 26) Failed to resolve name 'Agent Registry Records'. It is not a valid table, variable, or function name.",
    defender: "Query (5, 21) Cannot find table 'Defender Status'.",
    resourceGraph: "Query (6, 26) Cannot find table 'Foundry Resources'.",
};

/** A model's count per source: a number, BLANK (`null`), or `"missing"` when the model doesn't have it. */
type Model = Record<OptionalSource, number | null | "missing">;

const success = (columns: string[], row: unknown[]): Answer => ({
    data: { status: "success", table: { columns: columns.map((name) => ({ name })), rows: [row] } },
});
const failure = (message: string): Answer => ({ data: { status: "error", error: { message } }, error: new Error(message) });

/** Answers the separate probes and the merged probe as a model with these counts would. */
function answers(model: Model): (query: string) => Answer {
    return (query) => {
        const own = OPTIONAL_SOURCES.find((source) => SOURCE_PROBES[source] === query);
        if (own) return model[own] === "missing" ? failure(MISSING[own]) : success(["[Rows]"], [model[own]]);
        const asked = [...query.matchAll(/^ {4}"(\w+)", /gm)].map((match) => match[1] as OptionalSource);
        expect(query).toBe(mergedSourceProbe(asked));
        const missing = asked.find((source) => model[source] === "missing");
        if (missing) return failure(MISSING[missing]);
        return success(asked.map((source) => `[${source}]`), asked.map((source) => model[source]));
    };
}

/** What the five separate probes gave each source before they were merged. */
function separately(model: Model, modules: Record<string, boolean | undefined>): SourceAvailability {
    const module: Record<OptionalSource, string> = {
        m365Activity: "m365Activity",
        productFeedback: "productFeedback",
        agentRegistry: "agent365",
        defender: "defender",
        resourceGraph: "resourceGraph",
    };
    const ask = answers(model);
    const state = (source: OptionalSource) => {
        if (modules[module[source]] === false) return "notConfigured" as const;
        const { data } = ask(SOURCE_PROBES[source]) as { data: { status: string; table?: never; error?: { message: string } } };
        return readSourceState({
            row: data.status === "success" ? toSummaryRow(data.table!) : undefined,
            loaded: data.status === "success",
            error: data.status === "error" ? data.error!.message : undefined,
        });
    };
    return Object.fromEntries(OPTIONAL_SOURCES.map((source) => [source, state(source)])) as unknown as SourceAvailability;
}

const EVERY_MODULE = { m365Activity: true, agent365: true, productFeedback: true, consumption: true, defender: true, resourceGraph: true };
const FULL: Model = { m365Activity: 120, productFeedback: 4, agentRegistry: 9, defender: 15, resourceGraph: 3 };

/** The queries asked on the latest render, which is the last five or six asked. */
function lastAsked(): string[] {
    return mocked.calls.slice(-6).filter(Boolean);
}

describe("useSourceProbes", () => {
    beforeEach(() => {
        mocked.calls = [];
        mocked.modules = { ...EVERY_MODULE };
        mocked.semanticModels = { vl: { workspaceId: "ws", itemId: "vl" } };
        mocked.answer = answers(FULL);
    });

    it("reads every source as not configured when the install has no ValueLens model", () => {
        mocked.semanticModels = { cc: { workspaceId: "ws", itemId: "cc" } };
        const { result } = renderHook(() => useSourceProbes());

        expect(Object.values(result.current)).toEqual(Array(5).fill("notConfigured"));
    });

    it("counts every source in one query", () => {
        const { result } = renderHook(() => useSourceProbes());

        expect(result.current).toEqual({
            m365Activity: "present",
            productFeedback: "present",
            agentRegistry: "present",
            defender: "present",
            resourceGraph: "present",
        });
        expect(lastAsked()).toEqual([mergedSourceProbe(OPTIONAL_SOURCES)]);
        expect(mergedSourceProbe(OPTIONAL_SOURCES)).toBe(
            `EVALUATE ROW(
    "m365Activity", COUNTROWS('M365 Activity'),
    "productFeedback", COUNTROWS('ProductFeedback'),
    "agentRegistry", [Agent Registry Records],
    "defender", COUNTROWS('Defender Status'),
    "resourceGraph", COUNTROWS('Agent Configuration') + COUNTROWS('Foundry Resources')
)`,
        );
    });

    // An install from before the Defender module says nothing about it, so it is probed and the data decides.
    it("marks modules the installer left off without probing them", () => {
        mocked.modules = { m365Activity: true, agent365: false, productFeedback: false, consumption: false };
        const { result } = renderHook(() => useSourceProbes());

        expect(result.current).toEqual({
            m365Activity: "present",
            productFeedback: "notConfigured",
            agentRegistry: "notConfigured",
            defender: "present",
            resourceGraph: "present",
        });
        expect(lastAsked()).toEqual([mergedSourceProbe(["m365Activity", "defender", "resourceGraph"])]);
    });

    it("leaves Resource Graph unprobed when the installer turned it off", () => {
        mocked.modules = { ...EVERY_MODULE, resourceGraph: false };
        const { result } = renderHook(() => useSourceProbes());

        expect(result.current.resourceGraph).toBe("notConfigured");
        expect(lastAsked()).toEqual([mergedSourceProbe(["m365Activity", "productFeedback", "agentRegistry", "defender"])]);
    });

    it("asks nothing when every module was left off", () => {
        mocked.modules = { m365Activity: false, agent365: false, productFeedback: false, defender: false, resourceGraph: false };
        const { result } = renderHook(() => useSourceProbes());

        expect(Object.values(result.current)).toEqual(Array(5).fill("notConfigured"));
        expect(lastAsked()).toEqual([]);
    });

    it("waits for the answer before hiding anything", () => {
        mocked.answer = () => ({});
        const { result } = renderHook(() => useSourceProbes());

        expect(Object.values(result.current)).toEqual(Array(5).fill("checking"));
    });

    // Each scenario is a model the separate probes met: the merged probe must leave every source as they did.
    it.each<[string, Model]>([
        ["every source has rows", FULL],
        ["some sources are empty or BLANK", { ...FULL, productFeedback: 0, defender: null, resourceGraph: 0 }],
        ["a model without the Defender table", { ...FULL, defender: "missing" }],
        ["a model without the registry measure", { ...FULL, agentRegistry: "missing", productFeedback: 0 }],
        ["a model without several sources", { ...FULL, m365Activity: "missing", resourceGraph: "missing", productFeedback: null }],
        ["a model without any of them", { m365Activity: "missing", productFeedback: "missing", agentRegistry: "missing", defender: "missing", resourceGraph: "missing" }],
    ])("gives each source the state its own probe gave: %s", (_name, model) => {
        mocked.answer = answers(model);
        for (const modules of [EVERY_MODULE, { ...EVERY_MODULE, agent365: false, resourceGraph: false }]) {
            mocked.modules = { ...modules };
            const { result, unmount } = renderHook(() => useSourceProbes());

            expect(result.current).toEqual(separately(model, modules));
            unmount();
        }
    });

    it("asks each source on its own once the merged probe names a missing table", () => {
        mocked.answer = answers({ ...FULL, defender: "missing" });
        const { result } = renderHook(() => useSourceProbes());

        expect(result.current.defender).toBe("absent");
        expect(result.current.m365Activity).toBe("present");
        expect(lastAsked()).toEqual([mergedSourceProbe(OPTIONAL_SOURCES), ...OPTIONAL_SOURCES.map((source) => SOURCE_PROBES[source])]);
    });

    // Any other failure might be one source's, so each is asked on its own and answers as before.
    it("asks each source on its own after any other failure", () => {
        const model = answers(FULL);
        mocked.answer = (query) => (query.startsWith("EVALUATE ROW(\n") ? failure("The request timed out.") : model(query));
        const { result } = renderHook(() => useSourceProbes());

        expect(Object.values(result.current)).toEqual(Array(5).fill("present"));
    });

    // Power BI asks the app to slow down, not to give up on any source: the card asks again by itself.
    it("hides nothing and asks nothing more while Power BI is busy", () => {
        mocked.answer = () => failure(BUSY_MESSAGE);
        const { result } = renderHook(() => useSourceProbes());

        expect(Object.values(result.current)).toEqual(Array(5).fill("unknown"));
        expect(lastAsked()).toEqual([mergedSourceProbe(OPTIONAL_SOURCES)]);
    });
});
