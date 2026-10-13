//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_UNKNOWN, type SourceAvailability } from "@/lib/optional-sources";
import type { RuntimeConfig } from "@/lib/runtime-config";
import {
    auditLogFreshness,
    consumptionFreshness,
    evaluatorFreshness,
    m365ActivityFreshness,
} from "@/queries/freshness";
import { SourceAvailabilityContext } from "./source-availability.context";
import { clearSourceFreshness, useSourceFreshness } from "./use-source-freshness";

const { useSemanticModelQuery, config } = vi.hoisted(() => ({
    useSemanticModelQuery: vi.fn(),
    config: { current: {} as Partial<RuntimeConfig> },
}));
vi.mock("./use-semantic-model-query", () => ({ useSemanticModelQuery }));
vi.mock("@/lib/runtime-config", () => ({ runtimeConfig: () => config.current }));

const GUID = "00000000-0000-0000-0000-000000000001";
const model = { workspaceId: GUID, itemId: GUID };

type Answer = { status: "success"; rows: unknown[][]; columns: string[] } | { status: "error" };
let answers: Record<string, Answer>;

function respond({ query }: { connection: string; query: string }) {
    const answer = query ? answers[query] : undefined;
    const data =
        answer?.status === "success"
            ? { status: "success", table: { columns: answer.columns.map((name) => ({ name })), rows: answer.rows } }
            : answer?.status === "error"
              ? { status: "error", error: { message: "Boom" } }
              : undefined;
    return { data, isLoading: false, error: answer?.status === "error" ? new Error("Boom") : undefined, refetch: vi.fn() };
}

function wrapper(availability: SourceAvailability) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <SourceAvailabilityContext.Provider value={availability}>{children}</SourceAvailabilityContext.Provider>;
    };
}

function lastDate(date: string | null): Answer {
    return { status: "success", columns: ["[Last Date]"], rows: [[date]] };
}

function ranQueries(): string[] {
    return useSemanticModelQuery.mock.calls.map(([options]) => options.query).filter(Boolean);
}

beforeEach(() => {
    clearSourceFreshness();
    answers = {};
    config.current = { semanticModels: { vl: model, cc: model, ae: model } };
    useSemanticModelQuery.mockImplementation(respond);
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("useSourceFreshness", () => {
    it("reads the audit log's last date, unfiltered", () => {
        answers[auditLogFreshness().query] = lastDate("2026-10-07T00:00:00");
        const { result } = renderHook(() => useSourceFreshness(["auditLog"]), { wrapper: wrapper(ALL_UNKNOWN) });
        expect(result.current.auditLog).toBe("2026-10-07T00:00:00");
        expect(ranQueries()).toEqual([auditLogFreshness().query]);
        expect(useSemanticModelQuery).toHaveBeenCalledWith({ connection: "vl", query: auditLogFreshness().query });
    });

    it("reads all three Consumption Central sources in one query", () => {
        answers[consumptionFreshness().query] = {
            status: "success",
            columns: ["[Cowork Last Date]", "[Studio Last Date]", "[Azure Last Date]"],
            rows: [["2026-09-28T00:00:00", "2026-10-06T00:00:00", null]],
        };
        const { result } = renderHook(() => useSourceFreshness(["cowork", "copilotStudio", "azure"]), { wrapper: wrapper(ALL_UNKNOWN) });
        expect(result.current).toMatchObject({ cowork: "2026-09-28T00:00:00", copilotStudio: "2026-10-06T00:00:00", azure: undefined });
        expect(ranQueries()).toEqual([consumptionFreshness().query]);
    });

    it("asks nothing of a model this install hasn't connected", () => {
        config.current = { semanticModels: { vl: model } };
        const { result } = renderHook(() => useSourceFreshness(["cowork", "agentEvaluation"]), { wrapper: wrapper(ALL_UNKNOWN) });
        expect(ranQueries()).toEqual([]);
        expect(result.current.cowork).toBeUndefined();
        expect(result.current.agentEvaluation).toBeUndefined();
    });

    it("asks nothing of a source that has no data or was left out", () => {
        const absent = { ...ALL_UNKNOWN, m365Activity: "absent" } as const;
        renderHook(() => useSourceFreshness(["m365Activity"]), { wrapper: wrapper(absent) });
        config.current = { ...config.current, modules: { m365Activity: true, agent365: true, productFeedback: false, consumption: true, agentEvaluator: true } };
        renderHook(() => useSourceFreshness(["productFeedback"]), { wrapper: wrapper(ALL_UNKNOWN) });
        expect(ranQueries()).toEqual([]);
    });

    it("hides a failed query rather than reporting it", () => {
        answers[evaluatorFreshness().query] = { status: "error" };
        const { result } = renderHook(() => useSourceFreshness(["agentEvaluation"]), { wrapper: wrapper(ALL_UNKNOWN) });
        expect(result.current.agentEvaluation).toBeUndefined();
    });

    it("reads each source once a session", () => {
        answers[m365ActivityFreshness().query] = lastDate("2026-10-05T00:00:00");
        const first = renderHook(() => useSourceFreshness(["m365Activity"]), { wrapper: wrapper(ALL_UNKNOWN) });
        expect(first.result.current.m365Activity).toBe("2026-10-05T00:00:00");
        first.unmount();
        useSemanticModelQuery.mockClear();

        const second = renderHook(() => useSourceFreshness(["m365Activity"]), { wrapper: wrapper(ALL_UNKNOWN) });
        expect(second.result.current.m365Activity).toBe("2026-10-05T00:00:00");
        expect(ranQueries()).toEqual([]);
    });
});
