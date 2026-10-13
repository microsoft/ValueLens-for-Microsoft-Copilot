//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTaskTimes, saveTaskTimes, taskTimeId } from "./task-times.service";

const rows: Record<string, unknown>[] = [];
const upsert = vi.fn();
const remove = vi.fn();
const findById = vi.fn();

vi.mock("@/lib/rayfin-client", () => ({
    getRayfinClient: () => ({
        data: {
            TaskTime: {
                first: () => ({ execute: () => Promise.resolve(rows) }),
                upsert,
                delete: remove,
                findById,
            },
        },
    }),
}));

describe("taskTimeId", () => {
    it("gives a task the same row whoever saves it, whatever the case", async () => {
        const id = await taskTimeId("Email Drafting");
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(await taskTimeId(" email drafting")).toBe(id);
        expect(await taskTimeId("Email Summarising")).not.toBe(id);
    });
});

describe("loadTaskTimes", () => {
    beforeEach(() => {
        rows.length = 0;
    });

    it("keeps the newest times when a task somehow has two rows, and skips broken rows", async () => {
        rows.push(
            { task: "Email Drafting", minLow: 1, minTypical: 2, minHigh: 3, updatedAt: "2026-01-01T00:00:00Z" },
            { task: "email drafting", minLow: 4, minTypical: "5", minHigh: 6, updatedAt: "2026-02-01T00:00:00Z", updatedBy: "a@contoso.com" },
            { task: "General Chat", minLow: null, minTypical: 2, minHigh: 3 },
            { task: "", minLow: 1, minTypical: 2, minHigh: 3 },
        );
        const saved = await loadTaskTimes();
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ task: "email drafting", low: 4, typical: 5, high: 6, updatedBy: "a@contoso.com" });
        expect(saved[0].updatedAt).toBeInstanceOf(Date);
    });
});

describe("saveTaskTimes", () => {
    beforeEach(() => {
        rows.length = 0;
        upsert.mockReset().mockResolvedValue({});
        remove.mockReset().mockResolvedValue(undefined);
        findById.mockReset().mockResolvedValue(null);
    });

    it("writes each task's new times to its own row", async () => {
        await saveTaskTimes([{ task: "Email Drafting", time: { low: 4, typical: 12, high: 20 } }], "a@contoso.com");
        const [where, create, update] = upsert.mock.calls[0] as [{ id: string }, Record<string, unknown>, Record<string, unknown>];
        expect(where.id).toBe(await taskTimeId("Email Drafting"));
        expect(create).toMatchObject({ id: where.id, task: "Email Drafting", minLow: 4, minTypical: 12, minHigh: 20 });
        expect(update).toMatchObject({ minLow: 4, minTypical: 12, minHigh: 20, updatedBy: "a@contoso.com" });
        expect(update.updatedAt).toBeInstanceOf(Date);
    });

    it("removes a task's row to put the research back", async () => {
        await saveTaskTimes([{ task: "General Chat", time: null }], undefined);
        expect(remove).toHaveBeenCalledWith({ id: await taskTimeId("General Chat") });
        expect(upsert).not.toHaveBeenCalled();
    });

    it("doesn't fail when the row is already gone", async () => {
        remove.mockRejectedValue(new Error("Not found"));
        await expect(saveTaskTimes([{ task: "General Chat", time: null }], undefined)).resolves.toEqual([]);
    });

    it("reports a failed write after trying the rest", async () => {
        upsert.mockRejectedValueOnce(new Error("Forbidden")).mockResolvedValue({});
        await expect(
            saveTaskTimes(
                [
                    { task: "Email Drafting", time: { low: 4, typical: 12, high: 20 } },
                    { task: "General Chat", time: { low: 1, typical: 2, high: 3 } },
                ],
                undefined,
            ),
        ).rejects.toThrow("Forbidden");
        expect(upsert).toHaveBeenCalledTimes(2);
    });

    it("reads every saved time back afterwards", async () => {
        rows.push({ task: "Teams Messaging", minLow: 1, minTypical: 2, minHigh: 3 });
        const saved = await saveTaskTimes([], undefined);
        expect(saved.map((time) => time.task)).toEqual(["Teams Messaging"]);
    });
});
