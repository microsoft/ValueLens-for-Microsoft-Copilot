//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
    SCENARIO_BANDS,
    parseMinutes,
    sameTaskTime,
    taskTimeKey,
    validateTaskTime,
    type ModelTaskTime,
    type ScenarioBand,
    type TaskTime,
} from "@/queries/assumptions";
import type { SavedTaskTime, TaskTimeChange } from "@/services/task-times.service";

/** What is typed in a task's three boxes. */
export type DraftTime = Record<ScenarioBand, string>;

/** Typed times not saved yet, by {@link taskTimeKey}. */
export type Drafts = Readonly<Record<string, DraftTime>>;

export interface TaskTimeRow extends ModelTaskTime {
    key: string;
    /** This task's times as saved in the app, when they replace the research. */
    saved?: SavedTaskTime;
    /** The times every page uses now: the saved ones, or the research. */
    current: TaskTime;
    /** What is typed, when anything has been. */
    draft?: DraftTime;
    /** Why the typed times can't be used. */
    error?: string;
    /** The times the row shows: what is typed when it can be used, otherwise what is in use. */
    shown: TaskTime;
    /** Typed and not saved yet: a usable change, or times that can't be used. */
    pending: boolean;
    /** The row shows times other than the research. */
    custom: boolean;
    /** Hours per minute of this task's time across the activity, when any is recorded. */
    hoursPerMinute?: number;
}

/** Minutes as they sit in a box: to a tenth, without trailing zeros. */
export function formatMinutes(value: number): string {
    return String(Math.round(value * 10) / 10);
}

export function toDraft(time: TaskTime): DraftTime {
    return { low: formatMinutes(time.low), typical: formatMinutes(time.typical), high: formatMinutes(time.high) };
}

function parseDraft(draft: DraftTime): { time?: TaskTime; error?: string } {
    const parsed: Partial<Record<ScenarioBand, number>> = {};
    for (const band of SCENARIO_BANDS) parsed[band] = parseMinutes(draft[band]);
    const error = validateTaskTime(parsed);
    return error ? { error } : { time: parsed as TaskTime };
}

/**
 * Each task the model times, with what is saved and typed for it laid over
 * the research. Saved times for tasks the model no longer has are left out.
 */
export function buildRows(
    tasks: readonly ModelTaskTime[],
    saved: readonly SavedTaskTime[],
    drafts: Drafts,
    hoursPerMinute: ReadonlyMap<string, number> | undefined,
): TaskTimeRow[] {
    const savedByKey = new Map(saved.map((time) => [taskTimeKey(time.task), time]));
    return tasks.map((task) => {
        const key = taskTimeKey(task.task);
        const own = savedByKey.get(key);
        const current: TaskTime = own ? { low: own.low, typical: own.typical, high: own.high } : task.research;
        const draft = drafts[key];
        const parsed = draft ? parseDraft(draft) : {};
        const shown = parsed.time ?? current;
        return {
            ...task,
            key,
            saved: own,
            current,
            draft,
            error: parsed.error,
            shown,
            pending: draft !== undefined && (parsed.error !== undefined || !sameTaskTime(shown, current)),
            custom: !sameTaskTime(shown, task.research),
            hoursPerMinute: hoursPerMinute?.get(key),
        };
    });
}

/**
 * The changes to save: each task whose typed times differ from those in use,
 * as null where they are the research again, so its saved row is removed.
 */
export function pendingChanges(rows: readonly TaskTimeRow[]): TaskTimeChange[] {
    return rows
        .filter((row) => row.pending && !row.error)
        .map((row) => ({ task: row.task, time: sameTaskTime(row.shown, row.research) ? null : row.shown }));
}

/** Hours at Typical effort across the activity, with the research times and with the times shown. */
export function typicalHours(rows: readonly TaskTimeRow[]): { research?: number; shown?: number } {
    let research = 0;
    let shown = 0;
    let any = false;
    for (const row of rows) {
        if (row.hoursPerMinute === undefined) continue;
        any = true;
        research += row.hoursPerMinute * row.research.typical;
        shown += row.hoursPerMinute * row.shown.typical;
    }
    return any ? { research, shown } : {};
}

/**
 * Busiest first, by the hours each task gives at the times in use, so rows
 * hold still while times are typed; tasks with no activity follow by category.
 */
export function sortRows(rows: readonly TaskTimeRow[]): TaskTimeRow[] {
    const hours = (row: TaskTimeRow) =>
        row.hoursPerMinute === undefined ? undefined : row.hoursPerMinute * row.current.typical;
    return [...rows].sort((a, b) => {
        const ha = hours(a);
        const hb = hours(b);
        if (ha !== undefined && hb !== undefined && ha !== hb) return hb - ha;
        if (ha !== undefined && hb === undefined) return -1;
        if (ha === undefined && hb !== undefined) return 1;
        return a.category.localeCompare(b.category) || a.task.localeCompare(b.task);
    });
}

export interface RowFilter {
    category?: string;
    search?: string;
    /** Only rows on times other than the research, or with a change typed. */
    customOnly?: boolean;
}

export function filterRows(rows: readonly TaskTimeRow[], { category, search, customOnly }: RowFilter): TaskTimeRow[] {
    const needle = search?.trim().toLowerCase();
    return rows.filter(
        (row) =>
            (!category || row.category === category) &&
            (!customOnly || row.custom || row.pending) &&
            (!needle || row.task.toLowerCase().includes(needle) || row.category.toLowerCase().includes(needle)),
    );
}

/** The most recent save, for the "last changed" line. */
export function lastChange(saved: readonly SavedTaskTime[]): SavedTaskTime | undefined {
    let latest: SavedTaskTime | undefined;
    for (const time of saved) {
        if (time.updatedAt && (!latest?.updatedAt || time.updatedAt > latest.updatedAt)) latest = time;
    }
    return latest;
}

/** What one unit of a task is, in the words the page uses. */
export function grainLabel(grain: string): string {
    return grain.toLowerCase().includes("resource") ? "per file or page read" : "per prompt";
}
