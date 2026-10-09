//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ host: "azure" }),
}));

vi.mock("@/services/rayfin-auth.service", () => ({
    getAccessToken: () => Promise.resolve("api-token"),
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe("HttpSettingsStore", () => {
    it("loads and saves commercial terms through the settings API", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "00000000-0000-0000-0000-000000000001", creditRate: 0.02 }])))
            .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "00000000-0000-0000-0000-000000000001", creditRate: 0.02 }])))
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: "00000000-0000-0000-0000-000000000001", creditRate: 0.03, updatedBy: "admin" })));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore, COMMERCIAL_TERMS_ID } = await import("@/lib/settings-store");

        await expect(getSettingsStore().loadCommercialTerms()).resolves.toMatchObject({ creditRate: 0.02 });
        await expect(getSettingsStore().saveCommercialTerms({ creditRate: 0.03 }, "ignored")).resolves.toMatchObject({ creditRate: 0.03, updatedBy: "admin" });

        expect(fetchMock).toHaveBeenLastCalledWith(`/api/settings/CommercialTerms/${COMMERCIAL_TERMS_ID}`, expect.objectContaining({
            method: "PUT",
            headers: expect.objectContaining({ authorization: "Bearer api-token" }),
        }));
    });

    it("round-trips monthly budgets alongside the rates", async () => {
        const row = { id: "00000000-0000-0000-0000-000000000001", creditRate: 0.02, budgetCowork: "5000", budgetStudio: 2500.5, budgetAzure: null };
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify([row])))
            .mockResolvedValueOnce(new Response(JSON.stringify([row])))
            .mockImplementationOnce((_url: string, init: RequestInit) => Promise.resolve(new Response(init.body as string)));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore } = await import("@/lib/settings-store");

        await expect(getSettingsStore().loadCommercialTerms()).resolves.toMatchObject({
            creditRate: 0.02,
            budgetCowork: 5000,
            budgetStudio: 2500.5,
            budgetAzure: undefined,
        });
        const saved = await getSettingsStore().saveCommercialTerms({ budgetAzure: 750, budgetStudio: undefined }, "a@example.com");
        expect(saved).toMatchObject({ creditRate: 0.02, budgetCowork: 5000, budgetAzure: 750, budgetStudio: undefined });

        const body = JSON.parse(fetchMock.mock.calls[2][1].body as string);
        expect(body).toMatchObject({ creditRate: 0.02, budgetCowork: 5000, budgetAzure: 750 });
        expect(body.budgetStudio ?? null).toBeNull();
    });

    it("upserts and deletes task times through the settings API", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ task: "Email Drafting", minLow: 1, minTypical: 2, minHigh: 3 })))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(new Response(JSON.stringify([{ task: "Email Drafting", minLow: 1, minTypical: 2, minHigh: 3 }])));
        vi.stubGlobal("fetch", fetchMock);
        const { getSettingsStore } = await import("@/lib/settings-store");

        const saved = await getSettingsStore().saveTaskTimes([
            { task: "Email Drafting", time: { low: 1, typical: 2, high: 3 } },
            { task: "General Chat", time: null },
        ], "ignored");

        expect(saved).toEqual([{ task: "Email Drafting", low: 1, typical: 2, high: 3, updatedAt: undefined, updatedBy: undefined }]);
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/settings/TaskTime/"), expect.objectContaining({ method: "PUT" }));
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/settings/TaskTime/"), expect.objectContaining({ method: "DELETE" }));
    });

    it("surfaces admin-only writes as a friendly message", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
        const { getSettingsStore } = await import("@/lib/settings-store");

        await expect(getSettingsStore().saveCommercialTerms({ creditRate: 0.04 }, undefined))
            .rejects.toThrow("Only Analytics Hub admins can change this");
    });
});