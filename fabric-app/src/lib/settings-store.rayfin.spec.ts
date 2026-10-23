//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSettingsStore } from "@/lib/settings-store";
import { FakeDab } from "@/test/fake-dab";

let dab: FakeDab;

vi.mock("@/lib/runtime-config", () => ({
    runtimeConfig: () => ({ host: "fabric" }),
}));

vi.mock("@/lib/rayfin-client", () => ({
    getRayfinClient: () => ({ data: dab.data }),
}));

beforeEach(() => {
    dab = new FakeDab();
});

describe("RayfinSettingsStore report packs", () => {
    const weekly = "00000000-0000-0000-0000-0000000000a1";
    const board = "00000000-0000-0000-0000-0000000000a2";

    it("lists the saved packs by name, skipping any with no stage left to show", async () => {
        dab.seed(
            "ReportPack",
            {
                id: weekly,
                name: "Weekly",
                description: "For Monday's meeting",
                stages: '["budget-runway","gone"]',
                updatedBy: "a@contoso.com",
                updatedAt: "2026-10-01T09:00:00.000Z",
            },
            { id: board, name: "Board", stages: '["cost-vs-value"]' },
            { name: "Broken", stages: "[]" },
        );
        await expect(getSettingsStore().loadReportPacks()).resolves.toEqual([
            { id: board, name: "Board", stages: ["cost-vs-value"] },
            {
                id: weekly,
                name: "Weekly",
                description: "For Monday's meeting",
                stages: ["budget-runway"],
                updatedBy: "a@contoso.com",
                updatedAt: "2026-10-01T09:00:00.000Z",
            },
        ]);
    });

    it("still lists a saved pack after a reload", async () => {
        const saved = await getSettingsStore().saveReportPack(
            { id: weekly, name: " Weekly ", description: "For Monday's meeting", stages: ["budget-runway", "budget-runway"] },
            "a@contoso.com",
        );
        expect(saved).toMatchObject({ id: weekly, name: "Weekly", description: "For Monday's meeting", stages: ["budget-runway"], updatedBy: "a@contoso.com" });
        await expect(getSettingsStore().loadReportPacks()).resolves.toEqual([saved]);
    });

    it("saves changes over the pack's row", async () => {
        dab.seed("ReportPack", { id: weekly, name: "Weekly", description: "For Monday's meeting", stages: '["budget-runway"]' });
        await getSettingsStore().saveReportPack({ id: weekly, name: "Weekly finance", stages: ["budget-runway", "cost-vs-value"] }, undefined);
        await expect(getSettingsStore().loadReportPacks()).resolves.toEqual([
            expect.objectContaining({ id: weekly, name: "Weekly finance", description: undefined, stages: ["budget-runway", "cost-vs-value"] }),
        ]);
        expect(dab.rows("ReportPack")).toHaveLength(1);
    });

    it("deletes a pack, and doesn't fail when it's already gone", async () => {
        dab.seed("ReportPack", { id: weekly, name: "Weekly", stages: '["budget-runway"]' });
        await getSettingsStore().deleteReportPack(weekly);
        expect(dab.rows("ReportPack")).toEqual([]);
        await expect(getSettingsStore().deleteReportPack(weekly)).resolves.toBeUndefined();
    });
});
