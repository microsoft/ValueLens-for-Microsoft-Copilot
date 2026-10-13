//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { formatKpi } from "@/lib/format-kpi";
import { MIN_PEOPLE, shareText } from "@/lib/headline";

export const HABITS = ["Power", "Habitual", "Developing", "Beginner"] as const;
export type Habit = (typeof HABITS)[number];

/** Power and Habitual: active on 11 or more days in the month. */
export const HEAVY_HABITS: readonly Habit[] = ["Power", "Habitual"];

export interface HabitLicenceRow {
    habit: Habit;
    licensed: number;
    unlicensed: number;
}

export interface HabitLicenceMatrix {
    /** ISO date of the month's first day, when the model returned one. */
    month: string | undefined;
    rows: HabitLicenceRow[];
    licensed: number;
    unlicensed: number;
    heavyLicensed: number;
    heavyUnlicensed: number;
}

function count(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Reads the matrix query into the four habits in order, filling any the model left out with zeros. */
export function readHabitLicence(table: DataTable): HabitLicenceMatrix {
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [monthAt, habitAt, licensedAt, unlicensedAt] = [at("Month"), at("Cohort"), at("Licensed"), at("Unlicensed")];

    const byHabit = new Map<string, HabitLicenceRow>();
    let month: string | undefined;
    for (const row of table.rows) {
        const habit = String(row[habitAt] ?? "");
        if (!(HABITS as readonly string[]).includes(habit)) continue;
        byHabit.set(habit, {
            habit: habit as Habit,
            licensed: count(row[licensedAt]),
            unlicensed: count(row[unlicensedAt]),
        });
        const value = monthAt >= 0 ? row[monthAt] : undefined;
        if (!month && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) month = value.slice(0, 10);
    }

    const rows = HABITS.map((habit) => byHabit.get(habit) ?? { habit, licensed: 0, unlicensed: 0 });
    const heavy = rows.filter((row) => HEAVY_HABITS.includes(row.habit));
    const sum = (list: HabitLicenceRow[], key: "licensed" | "unlicensed") => list.reduce((total, row) => total + row[key], 0);
    return {
        month,
        rows,
        licensed: sum(rows, "licensed"),
        unlicensed: sum(rows, "unlicensed"),
        heavyLicensed: sum(heavy, "licensed"),
        heavyUnlicensed: sum(heavy, "unlicensed"),
    };
}

/** "March 2025" from an ISO date, in UTC so the month never slips. */
export function monthLabel(iso: string | undefined): string {
    if (!iso) return "the last full month";
    const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return "the last full month";
    return date.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

function people(n: number): string {
    return `${formatKpi(n, "whole")} ${n === 1 ? "person" : "people"}`;
}

/**
 * One sentence on how many heavy users had no licence. Says what was
 * counted and nothing about why; stays quiet on shares when the group is
 * too small to make one mean anything.
 */
export function habitLicenceHeadline(matrix: HabitLicenceMatrix): string | undefined {
    const total = matrix.licensed + matrix.unlicensed;
    if (total === 0) return undefined;
    const when = monthLabel(matrix.month);
    // With no licensed activity at all, the roster almost certainly didn't match the people using Copilot.
    if (matrix.licensed === 0) {
        return "No activity matched a licence, so this can't yet tell licensed and unlicensed users apart.";
    }
    if (total < MIN_PEOPLE) return `Too few people were active in ${when} to compare.`;

    const heavy = matrix.heavyLicensed + matrix.heavyUnlicensed;
    if (heavy === 0) return `Nobody was active on 11 or more days in ${when}.`;
    if (matrix.heavyUnlicensed === 0) return `Everyone active on 11 or more days in ${when} had a licence.`;

    const lead = `${people(matrix.heavyUnlicensed)} without a licence ${matrix.heavyUnlicensed === 1 ? "was" : "were"} active on 11 or more days in ${when}`;
    return heavy >= MIN_PEOPLE ? `${lead}, ${shareText(matrix.heavyUnlicensed, heavy)} of everyone that active.` : `${lead}.`;
}
