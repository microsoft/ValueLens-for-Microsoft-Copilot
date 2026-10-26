//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/lib/runtime-config";
import { loadStatus } from "@/queries/freshness";
import { clearLoadStatus, useLoadStatus } from "./use-load-status";

const { useSemanticModelQuery, config } = vi.hoisted(() => ({
    useSemanticModelQuery: vi.fn(),
    config: { current: {} as Partial<RuntimeConfig> },
}));
vi.mock("./use-semantic-model-query", () => ({ useSemanticModelQuery }));
vi.mock("@/lib/runtime-config", () => ({ runtimeConfig: () => config.current }));

const GUID = "00000000-0000-0000-0000-000000000001";
const model = { workspaceId: GUID, itemId: GUID };

const ROWS = {
    status: "success",
    table: {
        columns: [{ name: "[Activity]" }, { name: "[Source]" }, { name: "[Status]" }, { name: "[Reason]" }],
        rows: [["Run_M365_Activity_Ingester", "Microsoft 365 activity", "Warning", "It ran, but found nothing to load in Sales."]],
    },
};

function ranQueries(): string[] {
    return useSemanticModelQuery.mock.calls.map(([options]) => options.query).filter(Boolean);
}

beforeEach(() => {
    clearLoadStatus();
    config.current = { semanticModels: { vl: model } };
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("useLoadStatus", () => {
    it("reads the latest run's load outcomes from the ValueLens model, unfiltered, in the background lane", () => {
        useSemanticModelQuery.mockReturnValue({ data: ROWS, isLoading: false, error: undefined, refetch: vi.fn() });
        const { result } = renderHook(() => useLoadStatus(true));
        expect(useSemanticModelQuery).toHaveBeenCalledWith({ connection: "vl", query: loadStatus().query, background: true });
        expect(result.current).toEqual([
            {
                activity: "Run_M365_Activity_Ingester",
                source: "Microsoft 365 activity",
                status: "Warning",
                reason: "It ran, but found nothing to load in Sales.",
            },
        ]);
    });

    it("reads a model without the table, or a failed query, as no answer", () => {
        useSemanticModelQuery.mockReturnValue({
            data: { status: "error", error: { message: "Cannot find table 'Load Log'." } },
            isLoading: false,
            error: undefined,
            refetch: vi.fn(),
        });
        const { result } = renderHook(() => useLoadStatus(true));
        expect(result.current).toBeUndefined();
    });

    it("asks nothing when not wanted, or when the ValueLens model isn't connected", () => {
        useSemanticModelQuery.mockReturnValue({ data: undefined, isLoading: false, error: undefined, refetch: vi.fn() });
        renderHook(() => useLoadStatus(false));
        config.current = { semanticModels: {} };
        renderHook(() => useLoadStatus(true));
        expect(ranQueries()).toEqual([]);
    });
});
