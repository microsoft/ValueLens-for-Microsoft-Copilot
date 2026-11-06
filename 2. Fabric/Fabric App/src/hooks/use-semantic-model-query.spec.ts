//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSemanticModelQuery, clearQueryCache } from "@/hooks/use-semantic-model-query";

// Mock the Fabric client module so tests run offline.
const mockClearCache = vi.fn();
const mockSemanticModelClearCache = vi.fn();
const mockQuery = vi.fn();

vi.mock("@/lib/fabric-client", () => ({
    QUERY_CACHE_MAX_AGE_MS: 60 * 60 * 1000,
    getFabricClient: () => ({
        clearCache: mockClearCache,
        semanticModel: () => ({
            query: mockQuery,
            clearCache: mockSemanticModelClearCache,
        }),
    }),
}));

describe("useSemanticModelQuery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts in the loading state", () => {
        mockQuery.mockReturnValue(new Promise(() => {})); // never resolves

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        expect(result.current.isLoading).toBe(true);
        expect(result.current.data).toBeUndefined();
        expect(result.current.error).toBeUndefined();
    });

    it("returns data on a successful query", async () => {
        const successResult = {
            status: "success" as const,
            table: { columns: [{ name: "Value" }], rows: [[1]] },
            fromCache: false,
            cachedAt: undefined,
        };
        mockQuery.mockResolvedValue(successResult);

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.data).toEqual(successResult);
        expect(result.current.error).toBeUndefined();
    });

    it("exposes an error when the query result has status 'error'", async () => {
        const errorResult = {
            status: "error" as const,
            error: { message: "401 Unauthorized" },
        };
        mockQuery.mockResolvedValue(errorResult);

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.error?.message).toBe("401 Unauthorized");
    });

    it("re-executes the query when refetch is called", async () => {
        const successResult = {
            status: "success" as const,
            table: { columns: [], rows: [] },
            fromCache: false,
            cachedAt: undefined,
        };
        mockQuery.mockResolvedValue(successResult);

        const { result } = renderHook(() =>
            useSemanticModelQuery({ connection: "model", query: "EVALUATE ROW()" }),
        );

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(mockQuery).toHaveBeenCalledTimes(1);

        await act(async () => {
            await result.current.refetch();
        });

        expect(mockQuery).toHaveBeenCalledTimes(2);
    });
});

describe("useSemanticModelQuery and the visit's cache", () => {
    const HOUR = 60 * 60 * 1000;
    const table = { columns: [{ name: "Value" }], rows: [[1]] };
    const fresh = { status: "success" as const, table, fromCache: false, cachedAt: undefined };
    const notLoaded = { status: "error" as const, error: { message: "Data not loaded yet" }, fromCache: false };

    function heldFor(ms: number) {
        return { status: "success" as const, table, fromCache: true, cachedAt: new Date(Date.now() - ms) };
    }

    async function mount() {
        const { result } = renderHook(() => useSemanticModelQuery({ connection: "model", query: "Q" }));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        return result;
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses a result the cache has held for under an hour", async () => {
        const kept = heldFor(HOUR - 60_000);
        mockQuery.mockResolvedValue(kept);

        const result = await mount();

        expect(mockQuery).toHaveBeenCalledOnce();
        expect(result.current.data).toEqual(kept);
    });

    it("asks the model again for a result held over an hour", async () => {
        mockQuery.mockResolvedValueOnce(heldFor(HOUR + 60_000)).mockResolvedValueOnce(fresh);

        const result = await mount();

        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery).toHaveBeenNthCalledWith(1, "Q", { bypassCache: undefined });
        expect(mockQuery).toHaveBeenNthCalledWith(2, "Q", { bypassCache: true });
        expect(result.current.data).toEqual(fresh);
    });

    it("asks the model again rather than show an error from the cache", async () => {
        mockQuery.mockResolvedValueOnce({ ...notLoaded, fromCache: true, cachedAt: new Date() }).mockResolvedValueOnce(fresh);

        const result = await mount();

        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery).toHaveBeenNthCalledWith(2, "Q", { bypassCache: true });
        expect(result.current.data).toEqual(fresh);
        expect(result.current.error).toBeUndefined();
    });

    it("shows an error the model has just returned without asking again", async () => {
        mockQuery.mockResolvedValue(notLoaded);

        const result = await mount();

        expect(mockQuery).toHaveBeenCalledOnce();
        expect(result.current.error?.message).toBe("Data not loaded yet");
    });

    it("asks the model on Try again, not the cache that kept the error", async () => {
        mockQuery
            .mockResolvedValueOnce(notLoaded)
            .mockResolvedValueOnce({ ...notLoaded, fromCache: true, cachedAt: new Date() })
            .mockResolvedValueOnce(fresh);

        const result = await mount();
        expect(result.current.error?.message).toBe("Data not loaded yet");

        await act(async () => {
            await result.current.refetch();
        });

        expect(mockQuery).toHaveBeenCalledTimes(3);
        expect(mockQuery).toHaveBeenNthCalledWith(3, "Q", { bypassCache: true });
        expect(result.current.data).toEqual(fresh);
        expect(result.current.error).toBeUndefined();
    });
});

describe("clearQueryCache", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("clears all caches when called without an argument", () => {
        clearQueryCache();
        expect(mockClearCache).toHaveBeenCalledOnce();
        expect(mockSemanticModelClearCache).not.toHaveBeenCalled();
    });

    it("clears only the specified model cache when called with a connection alias", () => {
        clearQueryCache("salesModel");
        expect(mockSemanticModelClearCache).toHaveBeenCalledOnce();
        expect(mockClearCache).not.toHaveBeenCalled();
    });
});
