//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { getRayfinClient } from "@/lib/rayfin-client";
import { taskTimeKey, type TaskTime, type TaskTimeOverride } from "@/queries/assumptions";

/** How long to wait for the app's database before valuing work at the model's task times. */
const LOAD_TIMEOUT_MS = 8000;

/** The most task rows read back; the model times well under a hundred tasks. */
const MAX_ROWS = 1000;

export interface SavedTaskTime extends TaskTimeOverride {
    updatedBy?: string;
    updatedAt?: Date;
}

/** A change to one task: its new times, or null to go back to the model's. */
export interface TaskTimeChange {
    task: string;
    time: TaskTime | null;
}

function toNumber(value: unknown): number {
    if (value === null || value === undefined || value === "") return Number.NaN;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : Number.NaN;
}

function fromRow(row: Record<string, unknown>): SavedTaskTime | undefined {
    const task = typeof row.task === "string" ? row.task : "";
    const low = toNumber(row.minLow);
    const typical = toNumber(row.minTypical);
    const high = toNumber(row.minHigh);
    if (!task || ![low, typical, high].every(Number.isFinite)) return undefined;
    const updatedAt = row.updatedAt ? new Date(row.updatedAt as string | Date) : undefined;
    return {
        task,
        low,
        typical,
        high,
        updatedBy: typeof row.updatedBy === "string" && row.updatedBy ? row.updatedBy : undefined,
        updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined,
    };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The app's database didn't answer in time.")), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/**
 * The row id a task is saved under, worked out from its name so the same task
 * always lands in the same row, whoever saves it.
 */
export async function taskTimeId(task: string): Promise<string> {
    const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`valuelens:task-time:${taskTimeKey(task)}`)),
    ).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every task time saved in the app, newest first when a task somehow has two. */
export async function loadTaskTimes(): Promise<SavedTaskTime[]> {
    const rows = await withTimeout(getRayfinClient().data.TaskTime.first(MAX_ROWS).execute(), LOAD_TIMEOUT_MS);
    const byTask = new Map<string, SavedTaskTime>();
    for (const row of rows) {
        const saved = fromRow(row as unknown as Record<string, unknown>);
        if (!saved) continue;
        const key = taskTimeKey(saved.task);
        const existing = byTask.get(key);
        if (!existing || (saved.updatedAt?.getTime() ?? 0) > (existing.updatedAt?.getTime() ?? 0)) byTask.set(key, saved);
    }
    return [...byTask.values()];
}

async function apply(change: TaskTimeChange, updatedBy: string | undefined): Promise<void> {
    const id = await taskTimeId(change.task);
    const rows = getRayfinClient().data.TaskTime;
    if (change.time === null) {
        try {
            await rows.delete({ id });
        } catch (error) {
            // Someone else may have put this task back already.
            if (await rows.findById(id)) throw error;
        }
        return;
    }
    const values = {
        task: change.task,
        minLow: change.time.low,
        minTypical: change.time.typical,
        minHigh: change.time.high,
        updatedBy: updatedBy ?? null,
        updatedAt: new Date(),
    };
    await rows.upsert(
        { id },
        { id, ...values } as unknown as Parameters<typeof rows.upsert>[1],
        values as unknown as Parameters<typeof rows.upsert>[2],
    );
}

/**
 * Saves each task's new times for everyone, or deletes its row so the
 * model's apply again, then reads every saved time back so changes someone
 * else saved since the page loaded show too. Tasks not in `changes` are left
 * as they are.
 */
export async function saveTaskTimes(
    changes: readonly TaskTimeChange[],
    updatedBy: string | undefined,
): Promise<SavedTaskTime[]> {
    const results = await Promise.allSettled(changes.map((change) => apply(change, updatedBy)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    return loadTaskTimes();
}
