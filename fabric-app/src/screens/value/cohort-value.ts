//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { readConcentration, type Concentration } from "@/lib/concentration";
import { MIN_PEOPLE } from "@/lib/headline";
import { monthLabel } from "@/screens/readiness/habit-licence";

/** The habits from lightest to heaviest use, as the ladder reads. */
export const LADDER = ["Beginner", "Developing", "Habitual", "Power"] as const;
export type LadderHabit = (typeof LADDER)[number];

export const HABIT_RULES: Record<LadderHabit, string> = {
    Beginner: "1 to 5 active days",
    Developing: "6 to 10 active days",
    Habitual: "11 to 15 active days",
    Power: "16 or more active days",
};

/** How each habit reads as the subject of a sentence. */
const GROUP: Record<LadderHabit, string> = {
    Beginner: "Beginners",
    Developing: "Developing users",
    Habitual: "Habitual users",
    Power: "Power users",
};

export const HABIT_COLUMN = "Habit";
export const PER_PERSON_COLUMN = "Hours Per Person";
export const PEOPLE_COLUMN = "People";
export const RULE_COLUMN = "Active Days";

export interface CohortValue {
    habit: LadderHabit;
    people: number;
    hours: number;
    /** Hours per person, left out when the habit holds fewer than {@link MIN_PEOPLE} people. */
    perPerson: number | undefined;
}

export interface ValueByHabit {
    /** ISO date of the month's first day, when the model returned one. */
    month: string | undefined;
    /** Every habit, Beginner first, including those nobody fell into. */
    cohorts: CohortValue[];
    /** How much of the month's hours the busiest people account for. */
    concentration: Concentration | undefined;
}

function hours(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function whole(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Reads the habit rows into the four habits, Beginner first, and the cut rows into the concentration. */
export function readValueByHabit(table: DataTable): ValueByHabit {
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    const [monthAt, habitAt, peopleAt, hoursAt] = [at("Month"), at("Cohort"), at("People"), at("Hours")];

    const totals = new Map<string, { people: number; hours: number }>();
    let month: string | undefined;
    for (const row of table.rows) {
        const habit = String(row[habitAt] ?? "");
        if (!(LADDER as readonly string[]).includes(habit)) continue;
        const total = totals.get(habit) ?? { people: 0, hours: 0 };
        totals.set(habit, { people: total.people + whole(row[peopleAt]), hours: total.hours + hours(row[hoursAt]) });
        const date = monthAt >= 0 ? row[monthAt] : undefined;
        if (!month && typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date)) month = date.slice(0, 10);
    }

    const cohorts = LADDER.map((habit) => {
        const { people, hours: sum } = totals.get(habit) ?? { people: 0, hours: 0 };
        return { habit, people, hours: sum, perPerson: people >= MIN_PEOPLE ? sum / people : undefined };
    });
    return { month, cohorts, concentration: readConcentration(table) };
}

/** An incomplete aggregate must not look like a month with no activity. */
export function valueByHabitIncomplete(table: DataTable | undefined): boolean {
    if (!table || table.rows.length === 0) return false;
    const at = (name: string) => table.columns.findIndex((column) => column.name === name);
    if (["Month", "Cohort", "People", "Hours", "Count", "Cumulative", "Total"].some((name) => at(name) < 0)) return true;
    const seen = new Set<string>();
    let month: string | undefined;
    for (const row of table.rows) {
        if (row[at("Cohort")] == null) continue;
        const habit = String(row[at("Cohort")]);
        const people = row[at("People")];
        const sum = row[at("Hours")];
        const date = row[at("Month")];
        if (!(LADDER as readonly string[]).includes(habit) || seen.has(habit) ||
            typeof people !== "number" || !Number.isSafeInteger(people) || people <= 0 ||
            (sum != null && (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0)) ||
            typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(date) ||
            (month !== undefined && date.slice(0, 10) !== month)) return true;
        seen.add(habit);
        month = date.slice(0, 10);
    }
    if (seen.size === 0) return true;
    const value = readValueByHabit(table);
    if (value.concentration) {
        const sum = value.cohorts.reduce((total, cohort) => total + cohort.hours, 0);
        const people = value.cohorts.reduce((total, cohort) => total + cohort.people, 0);
        return Math.abs(sum - value.concentration.total) > Math.abs(sum) * 1e-9 || value.concentration.people > people;
    }
    return false;
}

const oneDecimal = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * One sentence comparing the heaviest habit with the lightest, such as
 * "Power users logged 6.2 expert hours each in March 2025, against 0.8 for
 * Beginners." It compares Power with Beginner when both hold enough people,
 * and otherwise the heaviest and lightest habits that do.
 */
export function cohortValueHeadline(value: ValueByHabit): string | undefined {
    const shown = value.cohorts.filter((cohort) => cohort.perPerson !== undefined);
    if (shown.length < 2) return undefined;
    const low = shown[0];
    const high = shown[shown.length - 1];
    const each = (cohort: CohortValue) => oneDecimal.format(cohort.perPerson!);
    return `${GROUP[high.habit]} logged ${each(high)} expert hours each in ${monthLabel(value.month)}, against ${each(low)} for ${GROUP[low.habit]}.`;
}

/** The habits too small to show, by name. */
export function hiddenHabits(value: ValueByHabit): LadderHabit[] {
    return value.cohorts.filter((cohort) => cohort.people > 0 && cohort.perPerson === undefined).map((cohort) => cohort.habit);
}

/** The ladder's rows: each habit with enough people, Beginner first. */
export function ladderTable(value: ValueByHabit | undefined): DataTable {
    const columns = [
        { name: HABIT_COLUMN, displayName: "Habit" },
        { name: RULE_COLUMN, displayName: "Active days" },
        { name: PEOPLE_COLUMN, displayName: "People", format: "#,0" },
        { name: PER_PERSON_COLUMN, displayName: "Expert hours per person", format: "#,0.0" },
    ];
    const rows = (value?.cohorts ?? [])
        .filter((cohort) => cohort.perPerson !== undefined)
        .map((cohort) => [cohort.habit, HABIT_RULES[cohort.habit], cohort.people, cohort.perPerson]);
    return { columns, rows } as unknown as DataTable;
}

/** Expert-equivalent hours per person, one bar per habit from Beginner down to Power. */
export function ladderSpec(): VisualizationSpec {
    const tooltip = [
        { field: HABIT_COLUMN, type: "nominal", title: "Habit" },
        { field: RULE_COLUMN, type: "nominal", title: "Active days" },
        { field: PEOPLE_COLUMN, type: "quantitative", title: "People", format: ",.0f" },
        { field: PER_PERSON_COLUMN, type: "quantitative", title: "Expert hours per person", format: ",.1f" },
    ];
    return {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        width: "container",
        height: "container",
        encoding: {
            y: { field: HABIT_COLUMN, type: "nominal", title: null, sort: [...LADDER] },
            x: { field: PER_PERSON_COLUMN, type: "quantitative", title: "Expert hours per person" },
            tooltip,
        },
        layer: [
            { mark: { type: "bar", cornerRadiusEnd: 2 } },
            {
                mark: { type: "text", align: "left", dx: 4 },
                encoding: { text: { field: PER_PERSON_COLUMN, type: "quantitative", format: ",.1f" } },
            },
        ],
    } as unknown as VisualizationSpec;
}
