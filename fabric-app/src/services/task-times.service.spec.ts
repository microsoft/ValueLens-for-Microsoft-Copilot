//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDab } from "@/test/fake-dab";
import { loadTaskTimes, saveTaskTimes, taskTimeId } from "./task-times.service";

let dab: FakeDab;

vi.mock("@/lib/rayfin-client", () => ({
    getRayfinClient: () => ({ data: dab.data }),
}));

beforeEach(() => {
    dab = new FakeDab();
});

describe("taskTimeId", () => {
    it("gives a task the same row whoever saves it, whatever the case", async () => {
        const id = await taskTimeId("Email Drafting");
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(await taskTimeId(" email drafting")).toBe(id);
        expect(await taskTimeId("Email Summarising")).not.toBe(id);
    });
});

describe("loadTaskTimes", () => {
    it("reads each saved task's times and who saved them", async () => {
        dab.seed("TaskTime", {
            id: await taskTimeId("Email Drafting"),
            task: "Email Drafting",
            minLow: 4,
            minTypical: 12,
            minHigh: 20,
            updatedBy: "a@contoso.com",
            updatedAt: "2026-10-01T09:00:00.000Z",
        });
        await expect(loadTaskTimes()).resolves.toEqual([
            { task: "Email Drafting", low: 4, typical: 12, high: 20, updatedBy: "a@contoso.com", updatedAt: new Date("2026-10-01T09:00:00.000Z") },
        ]);
    });

    it("keeps the newest times when a task somehow has two rows, and skips broken rows", async () => {
        dab.seed(
            "TaskTime",
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
    it("writes each task's new times to its own row", async () => {
        const upsert = vi.spyOn(dab.data.TaskTime, "upsert");
        await saveTaskTimes([{ task: "Email Drafting", time: { low: 4, typical: 12, high: 20 } }], "a@contoso.com");
        const [where, create, update] = upsert.mock.calls[0] as unknown as [{ id: string }, Record<string, unknown>, Record<string, unknown>];
        expect(where.id).toBe(await taskTimeId("Email Drafting"));
        expect(create).toMatchObject({ id: where.id, task: "Email Drafting", minLow: 4, minTypical: 12, minHigh: 20 });
        expect(update).toMatchObject({ minLow: 4, minTypical: 12, minHigh: 20, updatedBy: "a@contoso.com" });
        expect(update.updatedAt).toBeInstanceOf(Date);
        expect(dab.rows("TaskTime")).toEqual([
            expect.objectContaining({ id: where.id, task: "Email Drafting", minLow: 4, minTypical: 12, minHigh: 20, updatedBy: "a@contoso.com" }),
        ]);
    });

    it("returns the times it saved, so they apply straight away", async () => {
        const saved = await saveTaskTimes([{ task: "Email Drafting", time: { low: 4, typical: 12, high: 20 } }], "a@contoso.com");
        expect(saved).toEqual([
            expect.objectContaining({ task: "Email Drafting", low: 4, typical: 12, high: 20, updatedBy: "a@contoso.com" }),
        ]);
        expect(saved[0].updatedAt).toBeInstanceOf(Date);
    });

    it("saves over a task's existing row", async () => {
        const id = await taskTimeId("Email Drafting");
        dab.seed("TaskTime", { id, task: "Email Drafting", minLow: 1, minTypical: 2, minHigh: 3 });
        const saved = await saveTaskTimes([{ task: "email drafting", time: { low: 4, typical: 12, high: 20 } }], undefined);
        expect(dab.rows("TaskTime")).toEqual([expect.objectContaining({ id, minLow: 4, minTypical: 12, minHigh: 20 })]);
        expect(saved).toEqual([expect.objectContaining({ low: 4, typical: 12, high: 20 })]);
    });

    it("removes a task's row to put the research back", async () => {
        const id = await taskTimeId("General Chat");
        dab.seed("TaskTime", { id, task: "General Chat", minLow: 1, minTypical: 2, minHigh: 3 });
        const upsert = vi.spyOn(dab.data.TaskTime, "upsert");
        const remove = vi.spyOn(dab.data.TaskTime, "delete");
        await expect(saveTaskTimes([{ task: "General Chat", time: null }], undefined)).resolves.toEqual([]);
        expect(remove).toHaveBeenCalledWith({ id });
        expect(upsert).not.toHaveBeenCalled();
        expect(dab.rows("TaskTime")).toEqual([]);
    });

    it("doesn't fail when the row is already gone", async () => {
        await expect(saveTaskTimes([{ task: "General Chat", time: null }], undefined)).resolves.toEqual([]);
    });

    it("reports a failed write after trying the rest", async () => {
        const upsert = vi.spyOn(dab.data.TaskTime, "upsert").mockRejectedValueOnce(new Error("Forbidden"));
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
        expect(dab.rows("TaskTime")).toHaveLength(1);
    });

    it("reads every saved time back afterwards", async () => {
        dab.seed("TaskTime", { task: "Teams Messaging", minLow: 1, minTypical: 2, minHigh: 3 });
        const saved = await saveTaskTimes([], undefined);
        expect(saved.map((time) => time.task)).toEqual(["Teams Messaging"]);
    });
});
